'use strict';
// 緯度・経度を扱う共通処理。距離、投影、リンクの自動生成、タイル(画面の範囲だけ読み込む単位)、架空ネットワークの割り当て。

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

// 正距円筒図法。中心の緯度で横方向を補正し、余白を残して width x height に収める(テストと一覧用)
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

// 全拠点を対象に、各拠点を近い順に k 個とつなぎ、分断があれば最短の橋を足す(小さな地図・検証用。件数の 2 乗)
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

// 指定した地点に近い拠点を k 個返す
function nearest(nodes, lat, lon, k = 2) {
  return nodes.map((n) => ({ node: n, d: distanceKm({ lat, lon }, n) }))
    .sort((a, b) => a.d - b.d).slice(0, k).map((x) => x.node);
}

// ---------- タイル(設計書 第 13 章): 画面の範囲だけ読み込む単位。拡大率に応じて 5 段の粗さ ----------
// z0 = 緯度 0.025° × 経度 0.03°(約 2.8 km)。z が 1 上がるごとに 4 倍(z4 は 6.4° × 7.68°)
const TILE_LAT = 0.025;
const TILE_LON = 0.03;
const ZOOMS = [0, 1, 2, 3, 4];
// 段ごとに表示・読み込みする最小レベル(DESIGN.md 第 13 章の表)
// 縮小の段ごとに出す拠点のレベルの下限(2026-10-19 に新しい物差しへ。docs/LEVEL-PLAN.md): 段 1 は乗り換え駅・港・有名な名所、段 2 は空港・主要駅、段 3 は各県一の空港・城・庁舎、段 4 は庁舎と国の象徴
const MIN_LEVEL_BY_Z = { 0: 1, 1: 30, 2: 100, 3: 400, 4: 400 }; // 日本全体が見える段(3・4)は都道府県庁舎・都庁・国会議事堂と国際線の拠点の空港だけ(2026-10-19 ユーザー指摘。3 は 250 から上げた)
const tileSize = (z) => ({ lat: TILE_LAT * 4 ** z, lon: TILE_LON * 4 ** z });
const tileKey = (z, y, x) => `t${z}:${y}:${x}`;
const tileOf = (lat, lon, z = 0) => { const s = tileSize(z); return tileKey(z, Math.floor(lat / s.lat), Math.floor(lon / s.lon)); };
const parseTile = (t) => { const m = /^t(\d):(-?\d+):(-?\d+)$/.exec(String(t)); return m ? { z: Number(m[1]), y: Number(m[2]), x: Number(m[3]) } : null; };
// 周囲 r 周ぶんのタイル(自分を含む)
function tilesAround(t, r = 1) {
  const p = parseTile(t); if (!p) return [];
  const out = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push(tileKey(p.z, p.y + dy, p.x + dx));
  return out;
}
// 範囲に含まれるタイル(段 z)。多すぎるときは null
function tilesInBbox({ minLat, maxLat, minLon, maxLon }, z = 0, max = 80) {
  const s = tileSize(z);
  const y0 = Math.floor(minLat / s.lat), y1 = Math.floor(maxLat / s.lat);
  const x0 = Math.floor(minLon / s.lon), x1 = Math.floor(maxLon / s.lon);
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > max) return null;
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(tileKey(z, y, x));
  return out;
}
// 全段のタイル id(拠点ドキュメントの t0〜t4)
function tileFields(lat, lon) { const o = {}; for (const z of ZOOMS) o[`t${z}`] = tileOf(lat, lon, z); return o; }
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
  const n = hash32(String(id)) % 4096;
  const base = ((10 << 24) >>> 0) + n * 4096;
  return { base, span: 4094, subnet: `10.${(n >> 4) & 255}.${(n & 15) << 4}.0/20` };
}

module.exports = {
  distanceKm, project, buildLinks, nearest,
  TILE_LAT, TILE_LON, ZOOMS, MIN_LEVEL_BY_Z, tileSize, tileKey, tileOf, parseTile, tilesAround, tilesInBbox, tileFields, linksForTile,
  hash32, addrOf,
};
