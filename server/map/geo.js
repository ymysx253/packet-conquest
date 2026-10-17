'use strict';
// 緯度・経度を扱う共通処理。描画座標への変換と、距離にもとづくリンクの自動生成。
// 拠点マスターは緯度・経度だけを持ち、画面上の位置はここで計算する。

const EARTH_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

// 2点間の距離(km)。ハバーサインの公式
function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

// 正距円筒図法。中心の緯度で横方向を補正し、余白を残して width x height に収める。
// 戻り値は x, y を足した新しい配列(元の配列は変えない)
function project(nodes, { width, height, margin = 60 }) {
  if (!nodes.length) return [];
  const lats = nodes.map((n) => n.lat);
  const lons = nodes.map((n) => n.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kx = Math.cos(toRad((minLat + maxLat) / 2));
  const spanX = (maxLon - minLon) * kx || 1e-9;
  const spanY = (maxLat - minLat) || 1e-9;
  const scale = Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
  const ox = (width - spanX * scale) / 2;
  const oy = (height - spanY * scale) / 2;
  return nodes.map((n) => ({
    ...n,
    x: Math.round(ox + (n.lon - minLon) * kx * scale),
    y: Math.round(oy + (maxLat - n.lat) * scale),
  }));
}

// 各拠点を近い順に k 個とつなぐ。全体が1つにつながっていなければ、最短の橋を足す
function buildLinks(nodes, k = 3) {
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edges = new Set();
  for (const n of nodes) {
    nodes.filter((m) => m !== n)
      .map((m) => ({ id: m.id, d: distanceKm(n, m) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)
      .forEach((m) => edges.add(key(n.id, m.id)));
  }
  // 連結判定(Union-Find)
  const parent = Object.fromEntries(nodes.map((n) => [n.id, n.id]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (const e of edges) { const [a, b] = e.split('|'); union(a, b); }
  for (;;) {
    const roots = new Set(nodes.map((n) => find(n.id)));
    if (roots.size <= 1) break;
    let best = null;
    for (const a of nodes) for (const b of nodes) {
      if (find(a.id) === find(b.id)) continue;
      const d = distanceKm(a, b);
      if (!best || d < best.d) best = { a: a.id, b: b.id, d };
    }
    edges.add(key(best.a, best.b));
    union(best.a, best.b);
  }
  return [...edges].map((s) => { const [a, b] = s.split('|'); return { a, b }; });
}

// 指定した地点に近い拠点を k 個返す(プレイヤー専用ノードの接続先を決めるときに使う)
function nearest(nodes, lat, lon, k = 2) {
  return nodes.map((n) => ({ node: n, d: distanceKm({ lat, lon }, n) }))
    .sort((a, b) => a.d - b.d).slice(0, k).map((x) => x.node);
}

module.exports = { distanceKm, project, buildLinks, nearest };

// ---------- タイル(設計書 第 13 章): 緯度 0.025° × 経度 0.03° の格子。画面の範囲だけ読み込む単位 ----------
const TILE_LAT = 0.025;
const TILE_LON = 0.03;
const tileOf = (lat, lon) => `t:${Math.floor(lat / TILE_LAT)}:${Math.floor(lon / TILE_LON)}`;
const parseTile = (t) => { const [, y, x] = t.split(':'); return { y: Number(y), x: Number(x) }; };
const tileKey = (y, x) => `t:${y}:${x}`;
// 周囲 r 周ぶんのタイル(自分を含む)
function tilesAround(t, r = 1) {
  const { y, x } = parseTile(t);
  const out = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push(tileKey(y + dy, x + dx));
  return out;
}
// 範囲に含まれるタイル。多すぎる(縮小しすぎ)ときは null
function tilesInBbox({ minLat, maxLat, minLon, maxLon }, max = 80) {
  const y0 = Math.floor(minLat / TILE_LAT), y1 = Math.floor(maxLat / TILE_LAT);
  const x0 = Math.floor(minLon / TILE_LON), x1 = Math.floor(maxLon / TILE_LON);
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > max) return null;
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(tileKey(y, x));
  return out;
}
// タイル内の各拠点を、候補(そのタイル + 周囲)の中で近い k 個とつなぐ。総当たりをしない
function linksForTile(tileNodes, candidates, k = 3) {
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const seen = new Set(); const edges = [];
  for (const n of tileNodes) {
    candidates.filter((m) => m.id !== n.id)
      .map((m) => ({ id: m.id, d: distanceKm(n, m) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)
      .forEach((m) => { const kk = key(n.id, m.id); if (!seen.has(kk)) { seen.add(kk); edges.push({ a: n.id, b: m.id }); } });
  }
  return edges;
}

// ---------- 架空ネットワーク: 拠点 id から決定的に作る(上限なし。重複しても問題の内容には影響しない) ----------
function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
// 10.0.0.0/8 の中の /20(4096 通り)
function addrOf(id) {
  const n = hash32(id) % 4096;
  const base = ((10 << 24) >>> 0) + n * 4096;
  return { base, span: 4094, subnet: `10.${(n >> 4) & 255}.${(n & 15) << 4}.0/20` };
}

module.exports.TILE_LAT = TILE_LAT;
module.exports.TILE_LON = TILE_LON;
module.exports.tileOf = tileOf;
module.exports.parseTile = parseTile;
module.exports.tilesAround = tilesAround;
module.exports.tilesInBbox = tilesInBbox;
module.exports.linksForTile = linksForTile;
module.exports.hash32 = hash32;
module.exports.addrOf = addrOf;
