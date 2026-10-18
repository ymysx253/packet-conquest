'use strict';
// 区・市の境界を画面用に軽くして書き出す(地域の支配の色分けに使う。設計書 第 14.2 節)。
//
// 使い方:
//   node tools/import-boundaries.js <N03 東京都 行政区域 GeoJSON>
// 出どころ: 国土交通省「国土数値情報」行政区域データ(N03)。「国土数値情報(行政区域データ)」(国土交通省)を加工して作成。
//
// やること:
//   1. 行政区域コード(N03_007)で地域マスター(regions.json の code "JP-13-xxxxx")に結びつける
//   2. 同じ区・市の多角形をまとめ、頂点を間引く(Douglas-Peucker、約 60 m)。小さすぎる島は落とす
//   3. public/data/tokyo-regions.json に { regions: { <regionId>: { name, polys: [[[lon, lat], ...], ...] } } } で書く
const fs = require('fs');
const path = require('path');

const [, , boundaryFile] = process.argv;
if (!boundaryFile) { console.error('使い方: node tools/import-boundaries.js <N03_13.geojson>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public/data/tokyo-regions.json');
const TOLERANCE = 0.0006; // 度。約 60 m
const MIN_RING_AREA = 1e-6; // 度²。これより小さい輪は落とす(約 0.01 km²)

const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/map/data/regions.json'), 'utf8'));
const byCode = new Map(R.regions.filter((r) => r.code && r.code.startsWith('JP-13-')).map((r) => [r.code.slice(6), r]));

// Douglas-Peucker
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
const round = (c) => [Number(c[0].toFixed(5)), Number(c[1].toFixed(5))];

const data = JSON.parse(fs.readFileSync(boundaryFile, 'utf8'));
const out = {};
let skipped = 0, rings = 0;
for (const f of data.features) {
  const p = f.properties;
  if (p.N03_001 !== '東京都') continue;
  const region = byCode.get(p.N03_007);
  if (!region) { skipped++; continue; }
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const o = (out[region.id] ||= { name: region.name, polys: [] });
  for (const poly of polys) {
    const outer = poly[0];
    if (ringArea(outer) < MIN_RING_AREA) continue; // 小さな島
    const s = simplify(outer, TOLERANCE).map(round);
    if (s.length >= 4) { o.polys.push(s); rings++; }
  }
}
// 最低 1 つの輪は残す(全部小さい地域の保険)
for (const [id, o] of Object.entries(out)) if (!o.polys.length) { delete out[id]; skipped++; }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const doc = {
  source: '「国土数値情報(行政区域データ)」(国土交通省)(https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html)を加工して作成',
  updatedAt: '2026-10-18', tolerance: TOLERANCE, regions: out,
};
fs.writeFileSync(OUT, JSON.stringify(doc));
const size = fs.statSync(OUT).size;
console.log(`地域 ${Object.keys(out).length} 件、輪 ${rings} 本、頂点 ${Object.values(out).reduce((s, o) => s + o.polys.reduce((a, r) => a + r.length, 0), 0)} 点、${(size / 1024).toFixed(0)} KB。結びつかなかった地物 ${skipped} 件`);
