'use strict';
// 東京都の全駅を拠点マスター(server/map/data/tokyo.json)に取り込む(設計書 8.17)。
//
// 使い方:
//   node tools/import-stations.js <N02 駅 GeoJSON> <N03 東京都 行政区域 GeoJSON>
// 出どころ: 国土交通省「国土数値情報」鉄道データ(N02)・行政区域データ(N03)。
//   「国土数値情報(鉄道データ・行政区域データ)」(国土交通省)を加工して作成。
//
// やること:
//   1. 行政区域(区・市・町・村の多角形)で駅の位置を判定し、東京都内の駅だけ残す
//   2. 300 m 以内の同名駅(グループコード N02_005g)を 1 駅にまとめ、路線と事業者を集める
//   3. 路線数からレベルを決める(1 路線 Lv1 / 2〜3 路線 Lv2 / 4 路線以上 Lv3。主要ターミナルは Lv4)
//   4. tokyo.json の既存の駅(genre: station)を置き換え、駅以外の名所は残す
//   5. 足りない区・市・町・村を regions.json に追加する
const fs = require('fs');
const path = require('path');

const [, , stationFile, boundaryFile] = process.argv;
if (!stationFile || !boundaryFile) {
  console.error('使い方: node tools/import-stations.js <N02_Station.geojson> <N03_13.geojson>');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const NODE_FILE = path.join(ROOT, 'server/map/data/tokyo.json');
const REGION_FILE = path.join(ROOT, 'server/map/data/regions.json');

// 手で決めるレベル(主要ターミナルと象徴的な駅)。無い駅は路線数から決める
const TERMINALS = {
  大手町: 5, 東京: 4, 新宿: 4, 池袋: 4, 渋谷: 4, 品川: 4, 上野: 4, 霞ケ関: 4, 霞ヶ関: 4, 霞が関: 4,
  秋葉原: 3, 北千住: 3, 立川: 3, 八王子: 3, 町田: 3, 吉祥寺: 3, 新橋: 3, 有楽町: 3, 錦糸町: 3, 蒲田: 3, 中野: 3, 高田馬場: 3,
};
// ゲーム内の役割を手で決める駅(既定は HUB)
const KIND_OVERRIDES = { 大手町: 'IX', 霞ケ関: 'GOV', 霞ヶ関: 'GOV', 霞が関: 'GOV' };
const TODAY = '2026-10-17';

// ---------- 多角形の内外判定 ----------
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(pt, poly) { // poly: [outer, hole, hole...]
  if (!pointInRing(pt, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (pointInRing(pt, poly[k])) return false;
  return true;
}
function bboxOf(geom) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY, polys };
}

// ---------- 行政区域 ----------
const boundary = JSON.parse(fs.readFileSync(boundaryFile, 'utf8'));
const areas = boundary.features
  .filter((f) => f.properties.N03_001 === '東京都' && f.properties.N03_004)
  .map((f) => ({ name: f.properties.N03_004, code: f.properties.N03_007, gun: f.properties.N03_003 || '', ...bboxOf(f.geometry) }));
function areaOf(pt) {
  for (const a of areas) {
    if (pt[0] < a.minX || pt[0] > a.maxX || pt[1] < a.minY || pt[1] > a.maxY) continue;
    for (const poly of a.polys) if (pointInPolygon(pt, poly)) return a;
  }
  return null;
}

// ---------- 駅 ----------
const stations = JSON.parse(fs.readFileSync(stationFile, 'utf8'));
const midpoint = (geom) => {
  const cs = geom.type === 'LineString' ? geom.coordinates : geom.coordinates.flat();
  const m = cs[Math.floor(cs.length / 2)];
  return [m[0], m[1]];
};
const groups = new Map();
for (const f of stations.features) {
  const p = f.properties;
  const pt = midpoint(f.geometry);
  if (pt[1] < 24 || pt[1] > 36.5 || pt[0] < 138.5 || pt[0] > 143) continue; // 粗い範囲で絞ってから多角形判定
  const area = areaOf(pt);
  if (!area) continue; // 都外
  const g = groups.get(p.N02_005g) || { code: p.N02_005g, name: null, pts: [], lines: new Set(), operators: new Set(), areas: new Map() };
  if (p.N02_005c === p.N02_005g || !g.name) g.name = p.N02_005;
  g.pts.push(pt);
  g.lines.add(`${p.N02_004} ${p.N02_003}`);
  g.operators.add(p.N02_004);
  g.areas.set(area.name, (g.areas.get(area.name) || 0) + 1);
  groups.set(p.N02_005g, g);
}

// 同名のグループ(例: JR と地下鉄で 300 m 以上離れた「東京」)は 1.2 km 以内なら 1 駅にまとめ、離れていれば事業者名で区別する
const byName = new Map();
for (const g of groups.values()) (byName.get(g.name) || byName.set(g.name, []).get(g.name)).push(g);
const distKm = (a, b) => { const R = 6371, toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const center = (g) => [g.pts.reduce((s, p) => s + p[0], 0) / g.pts.length, g.pts.reduce((s, p) => s + p[1], 0) / g.pts.length];
for (const [name, list] of byName) {
  if (list.length < 2) continue;
  list.sort((a, b) => b.lines.size - a.lines.size);
  const main = list[0];
  for (const g of list.slice(1)) {
    if (distKm(center(main), center(g)) <= 1.2) {
      main.pts.push(...g.pts); g.lines.forEach((l) => main.lines.add(l)); g.operators.forEach((o) => main.operators.add(o));
      for (const [k, v] of g.areas) main.areas.set(k, (main.areas.get(k) || 0) + v);
      groups.delete(g.code);
    } else {
      g.suffix = `(${[...g.operators][0]})`; // 離れた同名駅は事業者名で区別
    }
  }
}

// ---------- 地域マスターの補完 ----------
const R = JSON.parse(fs.readFileSync(REGION_FILE, 'utf8'));
const regionByName = new Map(R.regions.map((r) => [r.name, r.id]));
const usedNames = new Set([...groups.values()].flatMap((g) => [...g.areas.keys()]));
const localKindOf = (name) => (/区$/.test(name) ? '区' : /市$/.test(name) ? '市' : /町$/.test(name) ? '町' : /村$/.test(name) ? '村' : '');
const slug = (code, name) => `tokyo-${code}`; // 読みが要らないよう行政区域コードで id を作る(既存の区・市は名前で引く)
let addedRegions = 0;
for (const a of areas) {
  if (!usedNames.has(a.name) || regionByName.has(a.name)) continue;
  const id = slug(a.code, a.name);
  R.regions.push({ id, name: a.name, nameEn: null, kind: 'city', parent: 'tokyo', code: `JP-13-${a.code}`, status: 'public', localKind: localKindOf(a.name) });
  regionByName.set(a.name, id);
  addedRegions++;
}
// 既存の区・市にも行政区域コードを付ける
const codeByName = new Map(areas.map((a) => [a.name, a.code]));
for (const r of R.regions) if (r.parent === 'tokyo' && codeByName.has(r.name) && !r.code) r.code = `JP-13-${codeByName.get(r.name)}`;
R.updatedAt = TODAY;

// ---------- 拠点マスターの更新 ----------
const T = JSON.parse(fs.readFileSync(NODE_FILE, 'utf8'));
const keep = T.nodes.filter((n) => n.genre !== 'station');
const levelByName = Object.fromEntries(T.nodes.filter((n) => n.genre === 'station').map((n) => [n.name, n.level]));
const kindByName = Object.fromEntries(T.nodes.filter((n) => n.genre === 'station').map((n) => [n.name, n.kind]));
const imported = [];
for (const g of [...groups.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  const lat = g.pts.reduce((s, p) => s + p[1], 0) / g.pts.length;
  const lon = g.pts.reduce((s, p) => s + p[0], 0) / g.pts.length;
  const areaName = [...g.areas.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const lineCount = g.lines.size;
  const name = `${g.name}駅${g.suffix || ''}`;
  let level = lineCount >= 4 ? 3 : lineCount >= 2 ? 2 : 1;
  if (TERMINALS[g.name]) level = TERMINALS[g.name];
  else if (levelByName[name] && levelByName[name] > level) level = levelByName[name]; // 手で付けた高いレベルは尊重
  const kind = KIND_OVERRIDES[g.name] || kindByName[name] || 'HUB';
  imported.push({
    id: `st-${g.code}`, name, genre: 'station', kind, area: areaName, region: regionByName.get(areaName),
    lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), level, value: level,
    lines: [...g.lines].sort(),
  });
}
T.nodes = keep.concat(imported);
const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
T.nodes = T.nodes.map((n, i) => ({ n, i })).sort((a, b) => (order[a.n.region] - order[b.n.region]) || (a.i - b.i)).map((x) => x.n);
T.version = (T.version || 0) + 1;
T.updatedAt = TODAY;
T.sources = [
  '「国土数値情報(鉄道データ)」(国土交通省)(https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html)を加工して作成',
  '「国土数値情報(行政区域データ)」(国土交通省)(https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html)を加工して作成',
];

// ---------- 書き出し(1 行 1 件の書式) ----------
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(head, key, items, groupKey) {
  let out = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`);
  let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}
fs.writeFileSync(REGION_FILE, writeList({ version: R.version, updatedAt: R.updatedAt, note: R.note, kinds: R.kinds, leafKinds: R.leafKinds }, 'regions', R.regions, 'parent'));
fs.writeFileSync(NODE_FILE, writeList({ region: T.region, name: T.name, version: T.version, updatedAt: T.updatedAt, note: T.note, sources: T.sources, kinds: T.kinds, genres: T.genres, spawn: T.spawn }, 'nodes', T.nodes, 'area'));

const byLevel = {}; for (const n of imported) byLevel[n.level] = (byLevel[n.level] || 0) + 1;
console.log(`駅 ${imported.length} 件を取り込み(都外を除外)。名所 ${keep.length} 件は維持。合計 ${T.nodes.length}`);
console.log('レベル内訳', byLevel, '/ 地域を追加', addedRegions, '件 / 行政区域', areas.length, '件');
