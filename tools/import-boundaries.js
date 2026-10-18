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
      const s = simplify(outer, tol).map((c) => round(c, digits));
      if (s.length >= 4) { o.polys.push(s); rings++; }
    }
  }
  for (const [id, o] of Object.entries(out)) if (!o.polys.length) delete out[id];
  return { out, rings };
}
const bboxOf = (out) => { let b = [180, 90, -180, -90]; for (const o of Object.values(out)) for (const r of o.polys) for (const [x, y] of r) { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; } return b; };

const files = fs.statSync(src).isDirectory() ? fs.readdirSync(src).filter((f) => /^N03-\d{8}_\d{2}\.geojson$/.test(f)).sort().map((f) => path.join(src, f)) : [src];
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
