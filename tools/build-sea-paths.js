'use strict';
// 海路を海の上に通す道すじ(2026-10-19 ユーザー決定)。画面が海路を陸の上ではなく海の上の曲線で描くために使う。
// 何度実行しても同じ結果になる。新しいデータは使わない(陸地は public/data/bounds/ の区・市の境界 = 国土数値情報 N03 を加工したもの)。
//
// 使い方:
//   node --max-old-space-size=4000 tools/build-sea-paths.js
// 書き出し: public/data/sea-paths.json { paths: { "<拠点 id A>|<拠点 id B>"(id の小さい順): [[緯度, 経度], …] } }
//
// しくみ:
//   1. 区・市の境界の面を、約 450 m のます目に塗って「陸か海か」の地図を作る
//   2. 港の位置から近い海のます目へ出て、陸を通らない最短の道を A* で探す(岸に沿いすぎないよう、岸の隣のます目は少し遠回り扱い)
//   2'. 岸の隣のます目は 4 倍遠回り扱い(画面の陸地は岸の隣のます目に少しかかるので、なるべく沖を通す。2026-10-21)
//   3. 道を間引く(間引いた線が陸をまたがないことを確かめながら)。画面はこの点を通るなめらかな曲線を描く
//   4. 画面が描く曲線(点と点の中ほどを通る 2 次曲線)を同じようにたどり、陸か岸の隣に乗る角には点を足す(2026-10-21 ユーザー指摘: 館山の先で陸を突っ切っていた)
//   海のます目でつながらない(湖の中の港など)航路は書かない。画面はそのときゆるい弧で描く
const fs = require('fs');
const path = require('path');
const { loadAll } = require('../server/map/load');

const ROOT = path.join(__dirname, '..');
const BOUNDS = path.join(ROOT, 'public/data/bounds');
const OUT = path.join(ROOT, 'public/data/sea-paths.json');
const ROUTE_DIR = path.join(ROOT, 'server/map/data/routes'); // 出典ごとの航路の記録(国のデータと、手で足したもの)
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- ます目(経度 0.005°・緯度 0.004° ≒ 450 m) ----------
const DLON = 0.005, DLAT = 0.004;
const all = loadAll();
const byId = new Map(all.NODES.map((n) => [n.id, n]));
const routes = fs.readdirSync(ROUTE_DIR).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(ROUTE_DIR, f), 'utf8')).routes).filter((r) => r.mode === 'sea' && byId.has(r.from) && byId.has(r.to));
const ends = routes.flatMap((r) => [byId.get(r.from), byId.get(r.to)]);
const LON0 = Math.min(...ends.map((n) => n.lon)) - 1.5, LON1 = Math.max(...ends.map((n) => n.lon)) + 1.5;
const LAT0 = Math.min(...ends.map((n) => n.lat)) - 1.5, LAT1 = Math.max(...ends.map((n) => n.lat)) + 1.5;
const W = Math.ceil((LON1 - LON0) / DLON), H = Math.ceil((LAT1 - LAT0) / DLAT);
const land = new Uint8Array(W * H);
const gx = (lon) => (lon - LON0) / DLON, gy = (lat) => (lat - LAT0) / DLAT;
console.log(`ます目 ${W} × ${H} = ${(W * H / 1e6).toFixed(1)} 百万`);

// ---------- 1. 陸を塗る(面ごとに偶奇の走査線) ----------
let polys = 0;
for (const f of fs.readdirSync(BOUNDS).filter((x) => x.endsWith('.json') && x !== 'japan.json')) {
  const B = JSON.parse(fs.readFileSync(path.join(BOUNDS, f), 'utf8'));
  for (const reg of Object.values(B.regions || {})) { // 目次のファイル(regions の無いもの)は飛ばす
    for (const ring0 of reg.polys) {
      const ring = ring0.map(([lon, lat]) => [gx(lon), gy(lat)]);
      let y0 = Infinity, y1 = -Infinity;
      for (const [, y] of ring) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const ya = Math.max(0, Math.ceil(y0 - 0.5)), yb = Math.min(H - 1, Math.floor(y1 - 0.5));
      if (ya > yb) continue;
      const rows = Array.from({ length: yb - ya + 1 }, () => []);
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi === yj) continue;
        const lo = Math.min(yi, yj), hi = Math.max(yi, yj);
        for (let y = Math.max(ya, Math.ceil(lo - 0.5)); y <= Math.min(yb, Math.floor(hi - 0.5)); y++) {
          const cy = y + 0.5;
          if (cy < lo || cy >= hi) continue;
          rows[y - ya].push(xi + ((cy - yi) / (yj - yi)) * (xj - xi));
        }
      }
      for (let k = 0; k < rows.length; k++) {
        const xs = rows[k].sort((a, b) => a - b), row = (ya + k) * W;
        for (let m = 0; m + 1 < xs.length; m += 2) {
          const a = Math.max(0, Math.ceil(xs[m] - 0.5)), b = Math.min(W - 1, Math.floor(xs[m + 1] - 0.5));
          for (let x = a; x <= b; x++) land[row + x] ^= 1; // 穴(湖など)は偶奇で抜ける
        }
      }
      polys++;
    }
  }
}
// 岸の隣(陸に接する海のます目)。少し遠回り扱いにして、岸すれすれを走らないようにする
const near = new Uint8Array(W * H);
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  const i = y * W + x;
  if (land[i]) continue;
  if (land[i - 1] || land[i + 1] || land[i - W] || land[i + W]) near[i] = 1;
}
console.log(`陸の面 ${polys} 個を塗った。陸のます目 ${land.reduce((s, v) => s + v, 0)}`);
// 海のまとまり(4 方向でつながる海のます目)。港の近くの小さな囲まれた水面(港の中の池など)から出発しないよう、大きなまとまりだけを使う
const comp = new Int32Array(W * H), compSize = [0];
{
  const q = new Int32Array(W * H);
  for (let i0 = 0; i0 < W * H; i0++) {
    if (land[i0] || comp[i0]) continue;
    const id = compSize.length; let qh = 0, qt = 0; q[qt++] = i0; comp[i0] = id;
    while (qh < qt) {
      const i = q[qh++], x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < W * H && !land[j] && !comp[j]) { comp[j] = id; q[qt++] = j; }
    }
    compSize.push(qt);
  }
}
const BIG_SEA = 5000; // これより小さい海のまとまり(約 1,000 km² 未満)は港の出発点にしない


// ---------- 2. A*(8 方向。距離は km) ----------
const KX = DLON * 111.32, KY = DLAT * 110.57; // 緯度 35° 前後の目安(経度方向は下で cos をかける)
const cosAt = (y) => Math.cos(((LAT0 + (y + 0.5) * DLAT) * Math.PI) / 180);
const g = new Float32Array(W * H), from = new Int32Array(W * H), stamp = new Int32Array(W * H), closed = new Int32Array(W * H);
// 最小ヒープ(値は f、中身はます目の番号)
let heapI = new Int32Array(1 << 20), heapF = new Float32Array(1 << 20), hn = 0;
const push = (i, f) => {
  if (hn >= heapI.length) { const a = new Int32Array(heapI.length * 2); a.set(heapI); heapI = a; const b = new Float32Array(heapF.length * 2); b.set(heapF); heapF = b; }
  let k = hn++;
  while (k > 0) { const p = (k - 1) >> 1; if (heapF[p] <= f) break; heapI[k] = heapI[p]; heapF[k] = heapF[p]; k = p; }
  heapI[k] = i; heapF[k] = f;
};
const pop = () => {
  const top = heapI[0], li = heapI[--hn], lf = heapF[hn];
  let k = 0;
  for (;;) { let c = 2 * k + 1; if (c >= hn) break; if (c + 1 < hn && heapF[c + 1] < heapF[c]) c++; if (heapF[c] >= lf) break; heapI[k] = heapI[c]; heapF[k] = heapF[c]; k = c; }
  heapI[k] = li; heapF[k] = lf;
  return top;
};
// 港の位置から近い、大きな海につながったます目(半径 40 ます ≒ 18 km まで)
function seaCellNear(n) {
  const cx = Math.floor(gx(n.lon)), cy = Math.floor(gy(n.lat));
  for (let r = 0; r <= 40; r++) {
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H || land[y * W + x] || compSize[comp[y * W + x]] < BIG_SEA) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = y * W + x; }
    }
    if (best >= 0) return best;
  }
  return -1;
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function astar(s, t, run) {
  const tx = t % W, ty = (t / W) | 0;
  const h = (i) => { const x = i % W, y = (i / W) | 0; const c = cosAt(y); return Math.hypot((x - tx) * KX * c, (y - ty) * KY); };
  hn = 0; stamp[s] = run; g[s] = 0; from[s] = -1; push(s, h(s));
  while (hn) {
    const i = pop();
    if (closed[i] === run) continue;
    closed[i] = run;
    if (i === t) break;
    const x = i % W, y = (i / W) | 0, c = cosAt(y);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (land[j] || closed[j] === run) continue;
      if (dx && dy && land[y * W + nx] && land[ny * W + x]) continue; // 角をすり抜けない
      const step = Math.hypot(dx * KX * c, dy * KY) * (near[j] ? 4 : 1);
      const ng = g[i] + step;
      if (stamp[j] !== run || ng < g[j]) { stamp[j] = run; g[j] = ng; from[j] = i; push(j, ng + h(j)); }
    }
  }
  if (closed[t] !== run) return null;
  const cells = [];
  for (let i = t; i !== -1; i = from[i]) cells.push(i);
  return cells.reverse();
}

// ---------- 3. 間引く(線分が陸をまたがないこと) ----------
const crossesLand = (a, b, okNear) => {
  const ax = a % W, ay = (a / W) | 0, bx = b % W, by = (b / W) | 0;
  const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
  for (let k = 1; k < n; k++) { const x = Math.round(ax + ((bx - ax) * k) / n), y = Math.round(ay + ((by - ay) * k) / n); const i = y * W + x; if (land[i] || (okNear && near[i] && !okNear.has(i))) return true; }
  return false;
};
function thin(cells) {
  const okNear = new Set(); // 道が通った岸の隣とそのすぐ隣は、まっすぐ結んでもよい
  for (const c of cells) if (near[c]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) okNear.add(c + dy * W + dx);
  const keep = [0];
  let i = 0;
  while (i < cells.length - 1) {
    // いまの点から、陸をまたがずに真っすぐ行ける最も遠い点まで飛ぶ
    let j = Math.min(cells.length - 1, i + 1);
    let lo = j, hi = cells.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (!crossesLand(cells[i], cells[m], okNear)) lo = m; else hi = m - 1; }
    j = Math.max(j, lo);
    keep.push(j); i = j;
  }
  return keep;
}
// ---------- 4. 画面が描く曲線が陸に乗らないか確かめる(2026-10-21 ユーザー指摘: 館山の先で航路が陸を突っ切っていた) ----------
// 画面(public/app.js の海路)は点と点の中ほどを通る 2 次曲線で描くので、岬の角では曲線が内側(陸側)に寄る。
// 同じ曲線をます目の上でたどり、陸に乗る曲がり角は、その前後に A* の道の点を足して角を小さくする(足せなくなるまで)
const PORT_ZONE = 3; // 港のまわり(約 1.4 km)は港そのものが陸のます目にあるので調べない
function curveHitsLand(P, A, B, okNear) {
  // P: ます目の座標 [x, y] の列(先頭が港 A、最後が港 B)。戻り値: 陸に乗った曲線の制御点の番号(1〜P.length-2)の集合
  const bad = new Set();
  const inPort = (x, y) => Math.hypot(x - A[0], y - A[1]) < PORT_ZONE || Math.hypot(x - B[0], y - B[1]) < PORT_ZONE;
  // 岸の隣のます目も陸として扱う(ます目は約 450 m で、岸の隣のます目には画面の陸地が少しかかっていることがある)。
  // ただし A* の道が通らざるを得なかった岸の隣(港の中・狭い海峡。okNear)とそのすぐ隣は通ってよい
  const isLand = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y); if (xi < 0 || yi < 0 || xi >= W || yi >= H) return false; const i = yi * W + xi; return land[i] === 1 || (near[i] === 1 && !okNear.has(i)); };
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  for (let i = 1; i < P.length - 1; i++) {
    const s0 = i === 1 ? P[0] : mid(P[i - 1], P[i]), c = P[i], e = mid(P[i], P[i + 1]);
    const n = Math.max(4, Math.ceil((Math.hypot(c[0] - s0[0], c[1] - s0[1]) + Math.hypot(e[0] - c[0], e[1] - c[1])) * 4));
    for (let k = 0; k <= n; k++) {
      const t = k / n, u = 1 - t;
      const x = u * u * s0[0] + 2 * u * t * c[0] + t * t * e[0], y = u * u * s0[1] + 2 * u * t * c[1] + t * t * e[1];
      if (!inPort(x, y) && isLand(x, y)) { bad.add(i); break; }
    }
  }
  return bad;
}
function smoothSafe(cells, keepIdx, A, B) {
  // keepIdx: cells の中の残す点の番号(小さい順)。曲線が陸に乗る角の前後に点を足す
  let idx = keepIdx.slice();
  const okNear = new Set();
  for (const c of cells) if (near[c]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) okNear.add(c + dy * W + dx);
  const cxy = (i) => [i % W + 0.5, ((i / W) | 0) + 0.5];
  for (let round = 0; round < 30; round++) {
    const P = [A, ...idx.map((i) => cxy(cells[i])), B];
    const bad = curveHitsLand(P, A, B, okNear);
    if (!bad.size) return { idx, ok: true };
    const add = new Set();
    for (const b of bad) {
      const k = b - 1; // idx の中の番号
      if (k > 0 && idx[k] - idx[k - 1] > 1) add.add((idx[k - 1] + idx[k]) >> 1);
      if (k < idx.length - 1 && idx[k + 1] - idx[k] > 1) add.add((idx[k] + idx[k + 1]) >> 1);
    }
    if (!add.size) return { idx, ok: true }; // 残りは A* の道のとなり合うます目どうし(ます目 1 つ未満のかすり。港の出口や狭い海峡)なので、これ以上は直さない
    idx = [...new Set([...idx, ...add])].sort((a, b) => a - b);
  }
  return { idx, ok: false };
}
const cellLL = (i) => { const x = i % W, y = (i / W) | 0; return [Number((LAT0 + (y + 0.5) * DLAT).toFixed(4)), Number((LON0 + (x + 0.5) * DLON).toFixed(4))]; };

const paths = {};
let ok = 0, fail = [], run = 0;
const landLeft = []; // 点を足しても曲線が陸に乗るもの(報告だけ)
const seen = new Set();
for (const r of routes) {
  const [a, b] = [r.from, r.to].sort();
  const key = `${a}|${b}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const A = byId.get(a), B = byId.get(b);
  const s = seaCellNear(A), t = seaCellNear(B);
  if (s < 0 || t < 0) { fail.push(`${A.name}–${B.name}(海のます目が近くに無い)`); continue; }
  const cells = astar(s, t, ++run);
  if (!cells) { fail.push(`${A.name}–${B.name}(海でつながらない)`); continue; }
  const sm = smoothSafe(cells, thin(cells), [gx(A.lon), gy(A.lat)], [gx(B.lon), gy(B.lat)]);
  if (!sm.ok) landLeft.push(`${A.name}–${B.name}`);
  const pts = sm.idx.map((i) => cellLL(cells[i]));
  paths[key] = [[A.lat, A.lon], ...pts, [B.lat, B.lon]];
  ok++;
}
const out = { schema: 'pc.seapaths/1', source: 'src-ksj-n03-2026', updatedAt: TODAY, note: '海路を海の上に描くための道すじ(tools/build-sea-paths.js)。区・市の境界から作った陸地を避けた点の列。キーは港の id(小さい順)', paths };
fs.writeFileSync(OUT, JSON.stringify(out));
const pts = Object.values(paths).reduce((s, p) => s + p.length, 0);
console.log(`海路の道すじ ${ok} 本(点 ${pts})を ${path.relative(ROOT, OUT)} に書いた(${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
if (landLeft.length) console.log(`曲線が陸に少し乗るもの ${landLeft.length} 本: ${landLeft.slice(0, 20).join(' / ')}`);
if (fail.length) console.log(`作れなかった ${fail.length} 本: ${fail.join(' / ')}`);
