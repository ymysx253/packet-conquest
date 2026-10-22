'use strict';
// 川を都道府県ごとのファイルにする(2026-10-22 ユーザー決定: 地図に川を足す。見た目だけで、拠点のつながりには使わない)。
// 元データ: 国土地理院 最適化ベクトルタイル(z11)。tools/fetch-gsi-rivers.js が取ったタイルを読む。
//   出典「国土地理院最適化ベクトルタイル」(国土地理院コンテンツ利用規約 = 公共データ利用規約 第 1.0 版)を加工して作成
//
// 使い方:
//   node tools/import-rivers.js <fetch-gsi-rivers.js の保存先フォルダ>
// 書き出し: public/data/rivers/<都道府県 id>.json と index.json(画面の背景 public/map-base.js が見えている県の分だけ読む)
//   { pref, updatedAt, lines: [[区分, [[経度, 緯度], …]], …], areas: [<GeoJSON MultiPolygon の coordinates>, …] }
//   区分: 1 = 細い川の中心線(地理院の 5301)、2 = 幅の広い川の中心線(532x。水面の上では見えない色で描く)
//   areas: 水面(WA)。幅の広い川(5201)・湖沼(5231 / 5233 / 5242)・堀や池(5203 など)。海(5101)は入れない(海は地図の下地の色)
// タイルの縁の重なり(バッファ)はタイルの範囲で切り落とし、同じ線が 2 回入らないようにする。
// どの県のファイルに入れるかは、地物の代表点がどの県の区・市の中か(public/data/bounds/<県>.json)で決める
const fs = require('fs');
const path = require('path');
const { decodeTile } = require('./mvt');

const [, , SRC] = process.argv;
if (!SRC) { console.error('使い方: node tools/import-rivers.js <タイルの保存先フォルダ>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public/data/rivers');
const TODAY = new Date().toISOString().slice(0, 10);
const Z = 11, N = 2 ** Z;
const SEA = 5101;
const r5 = (v) => Math.round(v * 1e5) / 1e5; // 約 1 m
const TOL = 0.00015; // 線と水面の輪を約 15 m に間引く(そのままだと全国で 120 MB を超えた。10 m では 65 MB)
const MIN_AREA = 5e-7; // これより小さい水面(約 5,000 m²。小さな池など)は落とす

// ---------- タイルの範囲(経度・緯度) ----------
const lonOf = (x) => (x / N) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;
const tileBox = (x, y) => ({ w: lonOf(x), e: lonOf(x + 1), n: latOf(y), s: latOf(y + 1) });

// 線をタイルの範囲で切る(線分ごとに Liang-Barsky)。切れたところで別の線になる
function clipLine(pts, b) {
  const out = []; let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    let [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
    let ok = true;
    for (const [p, q] of [[-dx, x0 - b.w], [dx, b.e - x0], [-dy, y0 - b.s], [dy, b.n - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { cur = null; continue; }
    const a = [x0 + t0 * dx, y0 + t0 * dy], c = [x0 + t1 * dx, y0 + t1 * dy];
    if (!cur || cur[cur.length - 1][0] !== a[0] || cur[cur.length - 1][1] !== a[1]) { cur = [a]; out.push(cur); }
    cur.push(c);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length >= 2);
}
// 輪をタイルの範囲で切る(Sutherland-Hodgman。四角で切るので凹んだ形でも塗りは正しい)
function clipRing(ring, b) {
  let pts = ring.slice(0, -1);
  const edges = [[(p) => p[0] >= b.w, (p, q) => [b.w, p[1] + ((q[1] - p[1]) * (b.w - p[0])) / (q[0] - p[0])]],
    [(p) => p[0] <= b.e, (p, q) => [b.e, p[1] + ((q[1] - p[1]) * (b.e - p[0])) / (q[0] - p[0])]],
    [(p) => p[1] >= b.s, (p, q) => [p[0] + ((q[0] - p[0]) * (b.s - p[1])) / (q[1] - p[1]), b.s]],
    [(p) => p[1] <= b.n, (p, q) => [p[0] + ((q[0] - p[0]) * (b.n - p[1])) / (q[1] - p[1]), b.n]]];
  for (const [inside, cross] of edges) {
    if (!pts.length) break;
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (inside(q)) { if (!inside(p)) next.push(cross(p, q)); next.push(q); } else if (inside(p)) next.push(cross(p, q));
    }
    pts = next;
  }
  return pts.length >= 3 ? [...pts, pts[0]] : null;
}
// Douglas-Peucker(両端は残す)
function simplify(pts, tol) {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]; let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy); if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const signedArea = (r) => { let s = 0; for (let i = 0; i + 1 < r.length; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; };
const clean = (pts) => { const o = []; for (const p of pts) { const q = [r5(p[0]), r5(p[1])]; const l = o[o.length - 1]; if (!l || l[0] !== q[0] || l[1] !== q[1]) o.push(q); } return o; };

// ---------- 県の判定(区・市の 60 m 版の境界) ----------
const IDX = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/bounds/index.json'), 'utf8'));
const regions = []; // { pref, box, polys }
for (const [pref, v] of Object.entries(IDX.prefs)) {
  const B = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/bounds', v.file), 'utf8'));
  for (const g of Object.values(B.regions || {})) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const r of g.polys) for (const [lo, la] of r) { if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > n) n = la; }
    regions.push({ pref, box: [w, s, e, n], polys: g.polys });
  }
}
const inRing = ([x, y], r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
function prefAt(p) {
  let near = null, nd = Infinity;
  for (const g of regions) {
    const [w, s, e, n] = g.box;
    if (p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n) {
      let c = false; for (const r of g.polys) if (inRing(p, r)) c = !c; // 穴は偶奇で抜ける
      if (c) return g.pref;
    }
    const d = Math.hypot(Math.max(w - p[0], 0, p[0] - e), Math.max(s - p[1], 0, p[1] - n)); // 海の上(河口の先など)は近い区・市の県
    if (d < nd) { nd = d; near = g.pref; }
  }
  return near;
}

// ---------- タイルを読む ----------
const out = new Map(); // 県 → { lines, areas }
const bucket = (pref) => { if (!out.has(pref)) out.set(pref, { lines: [], areas: [] }); return out.get(pref); };
const dir = path.join(SRC, String(Z));
let tiles = 0, lineN = 0, areaN = 0;
for (const x of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, x))) {
  const buf = fs.readFileSync(path.join(dir, x, f));
  if (!buf.length) continue; // データの無いタイル
  const y = Number(f.replace('.pbf', '')), b = tileBox(Number(x), y);
  tiles++;
  for (const L of decodeTile(buf, Z, Number(x), y)) {
    if (L.name === 'RvrCL') for (const ft of L.features) {
      if (ft.type !== 2) continue;
      const c = String(ft.props.vt_code).startsWith('532') ? 2 : 1;
      for (const ring of ft.rings) for (const part of clipLine(ring, b)) {
        const pts = simplify(clean(part), TOL); if (pts.length < 2) continue;
        bucket(prefAt(pts[pts.length >> 1])).lines.push([c, pts]); lineN++;
      }
    }
    if (L.name === 'WA') for (const ft of L.features) {
      if (ft.type !== 3 || ft.props.vt_code === SEA) continue;
      // 外側の輪(緯度が上向きの座標で面積が負)ごとに面を作り、続く正の輪をその穴にする
      const polys = []; let cur = null;
      for (const ring of ft.rings) {
        const r = clipRing(ring, b); if (!r) continue;
        const pts = simplify(clean(r), TOL); if (pts.length < 4 || Math.abs(signedArea(pts)) < MIN_AREA) continue;
        if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) pts.push(pts[0]);
        if (signedArea(ring) < 0 || !cur) { cur = [pts.reverse()]; polys.push(cur); } else cur.push(pts.reverse()); // GeoJSON の向き(外側は反時計回り)にそろえる
      }
      if (!polys.length) continue;
      const ext = polys[0][0]; const mid = ext[ext.length >> 1];
      bucket(prefAt(mid)).areas.push(polys); areaN++;
    }
  }
}

// ---------- 書き出す ----------
fs.mkdirSync(OUT, { recursive: true });
const index = { source: '「国土地理院最適化ベクトルタイル」(国土地理院)(https://github.com/gsi-cyberjapan/optimal_bvmap)の川の中心線と水面を加工して作成', updatedAt: TODAY, prefs: {} };
let total = 0;
for (const [pref, d] of [...out.entries()].sort()) {
  const file = `${pref}.json`, body = JSON.stringify({ pref, updatedAt: TODAY, lines: d.lines, areas: d.areas });
  fs.writeFileSync(path.join(OUT, file), body);
  index.prefs[pref] = { file, lines: d.lines.length, areas: d.areas.length, bytes: Buffer.byteLength(body) };
  total += Buffer.byteLength(body);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
const big = Object.entries(index.prefs).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 3).map(([p, v]) => `${p} ${(v.bytes / 1e6).toFixed(1)} MB`);
console.log(`タイル ${tiles} 枚から 川の線 ${lineN} 本・水面 ${areaN} 個を ${out.size} 都道府県に書いた(合計 ${(total / 1e6).toFixed(1)} MB。大きい順 ${big.join(' / ')})`);
