'use strict';
// 市区町村の境界を画面用に軽くして、都道府県ごとのファイルに書き出す(地域の支配の色分けに使う。設計書 第 13 章・第 14.2 節)。
//
// 使い方:
//   node tools/import-boundaries.js <N03 の GeoJSON が入ったフォルダ>   # 全都道府県
//   node tools/import-boundaries.js <N03 の GeoJSON 1 ファイル>          # 1 都道府県だけ
// 出どころ: 国土交通省「国土数値情報」行政区域データ(N03)。「国土数値情報(行政区域データ)」(国土交通省)を加工して作成。
//
// 出力(public/data/bounds/):
//   <都道府県 id>.json  詳細(約 60 m に間引き)。拡大時(z0〜2)に見えている都道府県のぶんだけ画面が取りに行く
//   japan.json          粗い版(約 1 km に間引き、小さな島は落とす)。縮小時(z3〜4)に全国を一度に描く
//   index.json          都道府県 id → { name, file, bbox }
const fs = require('fs');
const path = require('path');

const [, , src] = process.argv;
if (!src) { console.error('使い方: node tools/import-boundaries.js <N03 の GeoJSON フォルダ か ファイル>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public/data/bounds');
const FINE = { tol: 0.0006, minArea: 1e-6 };   // 約 60 m / 約 0.01 km²
const COARSE = { tol: 0.01, minArea: 2e-4 };   // 約 1 km / 約 2 km²

const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/map/data/regions.json'), 'utf8'));
const prefByCode = new Map(R.regions.filter((r) => r.kind === 'state' && r.code && /^JP-\d\d$/.test(r.code)).map((r) => [r.code.slice(3), r]));
const cityByCode = new Map(R.regions.filter((r) => r.kind === 'city' && r.code && /^JP-\d\d-\d+$/.test(r.code)).map((r) => [r.code.slice(6), r]));

function simplify(points, tol) {
  if (points.length <= 4) return points;
  const sq = tol * tol;
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2; t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
const ringArea = (ring) => { let s = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]); return Math.abs(s / 2); };
const round = (c, d) => [Number(c[0].toFixed(d)), Number(c[1].toFixed(d))];

// ---------- 境目を両側で同じ形に間引く(2026-10-19) ----------
// 隣り合う市区町村の境界を別々に間引くと、境目に細いすき間ができ、海を水色にした画面で水色の筋に見えた(ユーザー指摘)。
// N03 の隣り合う面は境目の点を共有しているので、点が何個の輪に使われているかを数え、数が変わる点と 3 つ以上の輪が会う点を
// 動かさない点にする。その間の区間は、向きをそろえて(始点と終点の小さい方から)間引くので、両側でまったく同じ結果になる。
// 数は都道府県をまたいで数える(県境も同じ形になる)。点の数が多いので Map を分けて持つ(1 つの Map の上限は約 1,600 万件)
const SHARDS = 32;
const counts = Array.from({ length: SHARDS }, () => new Map());
const keyOf = (p) => p[0] + ',' + p[1];
const shardOf = (k) => { let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0; return counts[(h >>> 0) % SHARDS]; };
const countOf = (p) => { const k = keyOf(p); return shardOf(k).get(k) || 0; };
const openRing = (ring) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);
function countRing(ring) { for (const p of openRing(ring)) { const k = keyOf(p); const m = shardOf(k); m.set(k, (m.get(k) || 0) + 1); } }
function simplifyRun(run, tol) {
  if (keyOf(run[0]) > keyOf(run[run.length - 1])) return simplify(run.slice().reverse(), tol).reverse(); // 向きをそろえる(反対側の輪と同じ結果にする)
  return simplify(run, tol);
}
function simplifyTopo(ring, tol) {
  const pts = openRing(ring);
  const n = pts.length;
  if (n < 3) return [];
  const c = pts.map(countOf);
  const fixed = c.map((v, i) => v >= 3 || v !== c[(i - 1 + n) % n] || v !== c[(i + 1) % n]);
  const start = fixed.indexOf(true);
  if (start < 0) return simplify([...pts, pts[0]], tol); // 誰とも接していない輪(島など)
  const rot = [...pts.slice(start), ...pts.slice(0, start)], rf = [...fixed.slice(start), ...fixed.slice(0, start)];
  const out = [];
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && !rf[j]) j++;
    const run = j < n ? rot.slice(i, j + 1) : [...rot.slice(i), rot[0]];
    const sr = simplifyRun(run, tol);
    for (let k = 0; k < sr.length - 1; k++) out.push(sr[k]);
    i = j;
  }
  out.push(out[0]);
  return out;
}

function build(features, { tol, minArea }, digits) {
  const out = {}; let rings = 0;
  for (const f of features) {
    const region = cityByCode.get(f.properties.N03_007);
    if (!region) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const o = (out[region.id] ||= { name: region.name, polys: [] });
    for (const poly of polys) {
      const outer = poly[0];
      if (ringArea(outer) < minArea) continue;
      const s = simplifyTopo(outer, tol).map((c) => round(c, digits));
      if (s.length >= 4) { o.polys.push(s); rings++; }
    }
  }
  for (const [id, o] of Object.entries(out)) if (!o.polys.length) delete out[id];
  return { out, rings };
}
const bboxOf = (out) => { let b = [180, 90, -180, -90]; for (const o of Object.values(out)) for (const r of o.polys) for (const [x, y] of r) { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; } return b; };

const findAll = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? findAll(path.join(dir, e.name)) : /^N03-\d{8}_\d{2}\.geojson$/.test(e.name) ? [path.join(dir, e.name)] : []));
// 都道府県ごとの下位フォルダも探す。同じファイル名が複数あれば 1 つだけ使う(同じ点を 2 回数えると境目の判定が狂う)
const files = fs.statSync(src).isDirectory() ? [...new Map(findAll(src).map((f) => [path.basename(f), f])).values()].sort() : [src];
// 1 回目: 全部の都道府県の点を数える(県境も両側で同じ形にするため。1 つのファイルだけ渡したときはその県の中だけ)
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of data.features) { if (!f.geometry) continue; const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates; for (const poly of polys) countRing(poly[0]); }
}
console.log(`点を数えた: ${counts.reduce((t, m) => t + m.size, 0)} 点(${files.length} ファイル)`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const indexFile = path.join(OUT_DIR, 'index.json');
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { source: '', updatedAt: '', prefs: {} };
const coarseFile = path.join(OUT_DIR, 'japan.json');
const coarse = fs.existsSync(coarseFile) ? JSON.parse(fs.readFileSync(coarseFile, 'utf8')) : { regions: {} };
let total = 0;
for (const file of files) {
  const pp = path.basename(file).slice(-10, -8);
  const pref = prefByCode.get(pp);
  if (!pref) { console.log(`skip ${path.basename(file)}: 地域マスターに都道府県 JP-${pp} が無い`); continue; }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const feats = data.features.filter((f) => f.properties.N03_001 === pref.name);
  const fine = build(feats, FINE, 5);
  const co = build(feats, COARSE, 4);
  const outFile = path.join(OUT_DIR, `${pref.id}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ pref: pref.id, name: pref.name, updatedAt: '2026-10-19', regions: fine.out }));
  for (const [id, o] of Object.entries(co.out)) coarse.regions[id] = { ...o, pref: pref.id };
  index.prefs[pref.id] = { name: pref.name, file: `${pref.id}.json`, bbox: bboxOf(fine.out), regions: Object.keys(fine.out).length };
  total++;
  console.log(`${pref.name}: 地域 ${Object.keys(fine.out).length} 件、詳細 ${fine.rings} 輪 ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB、粗い ${co.rings} 輪`);
}
index.source = '「国土数値情報(行政区域データ)」(国土交通省)(https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html)を加工して作成';
index.updatedAt = '2026-10-19';
fs.writeFileSync(indexFile, JSON.stringify(index));
coarse.source = index.source; coarse.updatedAt = index.updatedAt;
fs.writeFileSync(coarseFile, JSON.stringify(coarse));
console.log(`書き出し ${total} 都道府県。index.json、japan.json(粗い版 ${(fs.statSync(coarseFile).size / 1024).toFixed(0)} KB、地域 ${Object.keys(coarse.regions).length} 件)`);
