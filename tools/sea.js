'use strict';
// 海の判定(2026-10-20 ユーザー決定: 海の上で町どうしがつながることはない)。tools/import-towns.js と tools/import-links.js が使う。
//   陸 = 区・市の境界(public/data/bounds。tools/import-boundaries.js が作り、画面が陸を塗るのと同じ形)。境界の辺はすべて隣の区・市と共有されるので、
//   1 つの区・市にしか出てこない辺が海岸(飛び地の外周は除く)。線が海岸をまたげば、海の上を通っている
const fs = require('fs');
const path = require('path');

function pointInRing([x, y], ring) { // ring は [経度, 緯度, …] の並び
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const segCross = (ax, ay, bx, by, cx, cy, dx, dy) => { // 線分 AB と CD が交わるか(端の接触は数えない)
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(ax, ay, bx, by, cx, cy), d2 = o(ax, ay, bx, by, dx, dy), d3 = o(cx, cy, dx, dy, ax, ay), d4 = o(cx, cy, dx, dy, bx, by);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

// 海の判定を作る。{ onLand(p), seaCross(a, b), coastEdges, enclaveEdges } を返す(p, a, b は { lat, lon })
function makeSea(ROOT) {
  const coastE = []; // [x1, y1, x2, y2, …]
  const landRings = []; // { pts, bb }
  const single = []; // 1 つの区・市にしか出てこない辺 [x1, y1, x2, y2]
  {
    const dir = path.join(ROOT, 'public/data/bounds');
    const cnt = new Map();
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/.test(f) || f === 'japan.json' || f === 'index.json') continue;
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const r of Object.values(j.regions || {})) for (const ring of r.polys) {
        const pts = new Float64Array(ring.length * 2); const bb = [180, 90, -180, -90];
        ring.forEach(([x, y], i) => { pts[2 * i] = x; pts[2 * i + 1] = y; if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; });
        landRings.push({ pts, bb });
        for (let i = 0; i + 1 < ring.length; i++) {
          const a = `${ring[i][0]},${ring[i][1]}`, b = `${ring[i + 1][0]},${ring[i + 1][1]}`;
          if (a === b) continue;
          const k = a < b ? `${a}|${b}` : `${b}|${a}`;
          cnt.set(k, (cnt.get(k) || 0) + 1);
        }
      }
    }
    for (const [k, c] of cnt) if (c === 1) { const [p, q] = k.split('|'); single.push([...p.split(',').map(Number), ...q.split(',').map(Number)]); }
    if (!landRings.length) { console.error('public/data/bounds に区・市の境界がありません(先に tools/import-boundaries.js)'); process.exit(1); }
  }
  const LAND_G = 0.1;
  const landGrid = new Map();
  landRings.forEach((r, i) => { for (let gy = Math.floor(r.bb[1] / LAND_G); gy <= Math.floor(r.bb[3] / LAND_G); gy++) for (let gx = Math.floor(r.bb[0] / LAND_G); gx <= Math.floor(r.bb[2] / LAND_G); gx++) { const k = gy * 100000 + gx; let arr = landGrid.get(k); if (!arr) landGrid.set(k, (arr = [])); arr.push(i); } });
  const landAt = (x, y) => (landGrid.get(Math.floor(y / LAND_G) * 100000 + Math.floor(x / LAND_G)) || []).some((i) => { const r = landRings[i]; return x >= r.bb[0] && x <= r.bb[2] && y >= r.bb[1] && y <= r.bb[3] && pointInRing([x, y], r.pts); });
  const landCache = new Map();
  function onLand(p) { // 点が陸(どこかの区・市の中)にあるか
    const key = `${p.lon},${p.lat}`;
    if (!landCache.has(key)) landCache.set(key, landAt(p.lon, p.lat));
    return landCache.get(key);
  }
  // 共有されない辺のうち、両側とも陸のものは海岸ではない(境界ファイルは外周だけなので、飛び地の外周が共有されない辺として残る。佐久市の中の佐久穂町など)
  let enclaveEdges = 0;
  for (const [x1, y1, x2, y2] of single) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, l = Math.hypot(x2 - x1, y2 - y1) || 1, nx = (-(y2 - y1) / l) * 0.0002, ny = ((x2 - x1) / l) * 0.0002;
    if (landAt(mx + nx, my + ny) && landAt(mx - nx, my - ny)) { enclaveEdges++; continue; }
    coastE.push(x1, y1, x2, y2);
  }
  const COAST_G = 0.02;
  const coastGrid = new Map();
  for (let e = 0; e < coastE.length / 4; e++) {
    const x1 = coastE[4 * e], y1 = coastE[4 * e + 1], x2 = coastE[4 * e + 2], y2 = coastE[4 * e + 3];
    for (let gy = Math.floor(Math.min(y1, y2) / COAST_G); gy <= Math.floor(Math.max(y1, y2) / COAST_G); gy++) for (let gx = Math.floor(Math.min(x1, x2) / COAST_G); gx <= Math.floor(Math.max(x1, x2) / COAST_G); gx++) {
      const k = gy * 100000 + gx; let arr = coastGrid.get(k); if (!arr) coastGrid.set(k, (arr = [])); arr.push(e);
    }
  }
  // 陸の外にある端(海の上の港など)から PIER_DEG(約 1 km)以内のまたぎは数えない(港の中は防波堤や埠頭で海岸が入り組み、何度もまたぐ)
  const PIER_DEG = 0.01;
  function seaCross(a, b) { // a から b への線が海の上を通るか
    const offA = !onLand(a), offB = !onLand(b);
    const nearOff = (x, y) => (offA && Math.hypot(x - a.lon, y - a.lat) < PIER_DEG) || (offB && Math.hypot(x - b.lon, y - b.lat) < PIER_DEG);
    const seen = new Set(), hitE = new Set();
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.lon - a.lon), Math.abs(b.lat - a.lat)) / (COAST_G / 2)));
    for (let s = 0; s <= steps; s++) {
      const x = a.lon + ((b.lon - a.lon) * s) / steps, y = a.lat + ((b.lat - a.lat) * s) / steps;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = (Math.floor(y / COAST_G) + dy) * 100000 + Math.floor(x / COAST_G) + dx;
        if (seen.has(k)) continue; seen.add(k);
        for (const e of coastGrid.get(k) || []) {
          if (hitE.has(e) || !segCross(a.lon, a.lat, b.lon, b.lat, coastE[4 * e], coastE[4 * e + 1], coastE[4 * e + 2], coastE[4 * e + 3])) continue;
          hitE.add(e);
          // またいだ点(線分 AB と海岸の辺の交点)
          const x1 = coastE[4 * e], y1 = coastE[4 * e + 1], x2 = coastE[4 * e + 2], y2 = coastE[4 * e + 3];
          const rx = b.lon - a.lon, ry = b.lat - a.lat, sx = x2 - x1, sy = y2 - y1, den = rx * sy - ry * sx;
          const t = den ? ((x1 - a.lon) * sy - (y1 - a.lat) * sx) / den : 0;
          if (nearOff(a.lon + rx * t, a.lat + ry * t)) continue;
          return true; // 端から離れたところで海岸をまたいだ = 海の上を通る
        }
      }
    }
    return false; // 陸の外の端の近くだけでまたいだ線は、海の上を通らない
  }
  return { onLand, seaCross, coastEdges: coastE.length / 4, enclaveEdges };
}

module.exports = { makeSea, pointInRing, segCross };
