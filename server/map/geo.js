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
