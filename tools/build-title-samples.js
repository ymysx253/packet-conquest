'use strict';
// 称号のアイコンの見本に使う形を作る(2026-10-26 ユーザー依頼: とりあえず作って見せる。大きさはそろえる)。
// 地域・島は境界のシルエット、路線は同じ路線で隣り合う駅を結んだ線。1 × 1 の枠に収めて public/data/title-samples.json に書く。
// 見本のページは public/title-icons.html。ゲームにはまだ使わない(docs/TITLES.md)。
const fs = require('fs');
const path = require('path');
const all = require('../server/map/all.js');

const ROOT = path.join(__dirname, '..');
const bounds = (pref) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/bounds', `${pref}.json`), 'utf8')).regions;
const japan = bounds('japan');

// 緯度・経度 → 平面(経度は緯度 36 度の cos で縮める。北が上)
const K = Math.cos(36 * Math.PI / 180);
const proj = ([lon, lat]) => [lon * K, -lat];

function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const area = (p) => { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return Math.abs(s / 2); };

// 形の集まり(多角形・線・印)を 1 × 1 に収める。縦横の比は保つ
function fit({ polys = [], segs = [], marks = [] }) {
  const pts = [...polys.flat(), ...segs.flatMap((s) => [s[0], s[1]]), ...marks];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const s = Math.max(x1 - x0, y1 - y0) || 1, ox = (s - (x1 - x0)) / 2, oy = (s - (y1 - y0)) / 2;
  const n = ([x, y]) => [Math.round(((x - x0 + ox) / s) * 1000) / 1000, Math.round(((y - y0 + oy) / s) * 1000) / 1000];
  // アイコンは 100 px ほどなので、前の点から 1/200 未満の点は捨てる
  const thin = (p) => { const o = []; for (const q of p.map(n)) { const l = o[o.length - 1]; if (!l || Math.hypot(l[0] - q[0], l[1] - q[1]) >= 0.005) o.push(q); } return o; };
  return {
    polys: polys.map(thin).filter((p) => p.length >= 3 && area(p) > 2e-5),
    segs: segs.map((s) => [...n(s[0]), ...n(s[1])]),
    marks: marks.map(n),
  };
}

const regionPolys = (regions, ids) => ids.flatMap((id) => (regions[id] ? regions[id].polys : [])).map((p) => p.map(proj));
const prefIds = (pref) => Object.keys(japan).filter((id) => id.startsWith(`${pref}-`));
// 本土から遠い島(東京の伊豆・小笠原など)を外すときは、緯度・経度の枠で切る
const crop = (polys, [lat0, lat1, lon0, lon1]) => polys.filter((p) => p.every(([x, y]) => -y >= lat0 && -y <= lat1 && x / K >= lon0 && x / K <= lon1));
// 点を含む 1 つの島(多角形)
const islandAt = (pref, id, lat, lon) => { const pt = proj([lon, lat]); return bounds(pref)[id].polys.map((p) => p.map(proj)).filter((p) => inside(pt, p)); };

const N = all.NODES.filter((n) => n.status === 'public');
const byId = new Map(N.map((n) => [n.id, n]));
function lineSegs(test) {
  const segs = [];
  for (const n of N) {
    if (!(n.lines || []).some(test)) continue;
    for (const b of n.adj || []) {
      const m = byId.get(b);
      if (m && n.id < m.id && (m.lines || []).some((l) => test(l) && (n.lines || []).includes(l))) segs.push([proj([n.lon, n.lat]), proj([m.lon, m.lat])]);
    }
  }
  return segs;
}
const at = (id) => { const n = byId.get(id) || N.find((x) => x.name === id); return proj([n.lon, n.lat]); };

const KANTO = ['ibaraki', 'tochigi', 'gunma', 'saitama', 'chiba', 'tokyo', 'kanagawa'];
const out = {
  // 地域
  'pref-gifu': fit({ polys: regionPolys(japan, prefIds('gifu')) }),
  'pref-hokkaido': fit({ polys: regionPolys(japan, prefIds('hokkaido')) }),
  'city-gujo': fit({ polys: regionPolys(bounds('gifu'), ['gifu-21219']) }),
  'city-chiyoda': fit({ polys: regionPolys(bounds('tokyo'), ['tokyo-chiyoda']) }),
  'area-kanto': fit({ polys: crop(regionPolys(japan, KANTO.flatMap(prefIds)), [34.8, 37.2, 138.3, 141.0]) }),
  'japan': fit({ polys: crop(regionPolys(japan, Object.keys(japan)), [30, 46, 128, 146]) }),
  // 島
  'island-sado': fit({ polys: regionPolys(bounds('niigata'), ['niigata-15224']) }),
  'island-yaku': fit({ polys: islandAt('kagoshima', 'kagoshima-46505', 30.35, 130.53) }),
  'island-hateruma': fit({ polys: islandAt('okinawa', 'okinawa-47381', 24.058, 123.785), marks: [at('波照間空港')] }),
  // 端
  'tip-north': fit({ polys: regionPolys(bounds('hokkaido'), ['hokkaido-01214']).sort((a, b) => area(b) - area(a)).slice(0, 1), marks: [at('宗谷岬')] }),
  // 路線
  'line-yamanote': fit({ segs: lineSegs((l) => l === '東日本旅客鉄道 山手線') }),
  'line-tokaido-sk': fit({ segs: lineSegs((l) => l === '東海旅客鉄道 東海道新幹線') }),
  'line-soya': fit({ segs: lineSegs((l) => l === '北海道旅客鉄道 宗谷線') }),
  'company-jrh': fit({ segs: lineSegs((l) => l.startsWith('北海道旅客鉄道 ')) }),
  'shinkansen': fit({ segs: lineSegs((l) => /新幹線/.test(l)) }),
};
for (const [k, v] of Object.entries(out)) if (!v.polys.length && !v.segs.length) throw new Error(`形が空: ${k}`);
const file = path.join(ROOT, 'public/data/title-samples.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${file}: ${Object.keys(out).length} 件、${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
