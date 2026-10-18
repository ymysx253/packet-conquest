'use strict';
// 都道府県の全駅を拠点マスター(server/map/data/<都道府県 id>.json)に取り込む(設計書 3.4、2026-10-19 に都道府県を引数化)。
//
// 使い方:
//   node tools/import-stations.js <N02 駅 GeoJSON> <N03 その都道府県の行政区域 GeoJSON> <都道府県 id(tokyo / kanagawa / chiba …)>
// 先に tools/import-regions.js で地域マスターに都道府県と市区町村を入れておく(region は行政区域コードで引く)。
// 出どころ: 国土交通省「国土数値情報」鉄道データ(N02)・行政区域データ(N03)。
//   「国土数値情報(鉄道データ・行政区域データ)」(国土交通省)を加工して作成。
//
// やること:
//   1. 行政区域(区・市・町・村の多角形)で駅の位置を判定し、その都道府県内の駅だけ残す
//   2. 300 m 以内の同名駅(グループコード N02_005g)を 1 駅にまとめ、路線と事業者を集める
//   3. 路線数からレベルを決める(1 路線 Lv1 / 2〜3 路線 Lv2 / 4 路線以上 Lv3。主要ターミナルは手で 4〜5)
//   4. <都道府県 id>.json の既存の駅(genre: station)を置き換え、駅以外の名所は残す。無ければ新しく作る(見出しは tokyo.json から写す)
//   5. 取り込んだら tools/import-links.js を実行してつながり(adj)を作り直す
const fs = require('fs');
const path = require('path');

const [, , stationFile, boundaryFile, prefId] = process.argv;
if (!stationFile || !boundaryFile || !prefId) {
  console.error('使い方: node tools/import-stations.js <N02_Station.geojson> <N03_PP.geojson> <都道府県 id>');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const REGION_FILE = path.join(DATA, 'regions.json');
const NODE_FILE = path.join(DATA, `${prefId}.json`);
const TEMPLATE_FILE = path.join(DATA, 'tokyo.json');

// 手で決めるレベル(主要ターミナルと象徴的な駅)。無い駅は路線数から決める。
// 都道府県ごとに分ける(同名の駅が別の県にあるため。例: 東京の高松駅と香川の高松駅。2026-10-19)
const TERMINALS_BY_PREF = {
  tokyo: { 大手町: 5, 東京: 4, 新宿: 4, 池袋: 4, 渋谷: 4, 品川: 4, 上野: 4, 霞ケ関: 4, 霞ヶ関: 4, 霞が関: 4,
    秋葉原: 3, 北千住: 3, 立川: 3, 八王子: 3, 町田: 3, 吉祥寺: 3, 新橋: 3, 有楽町: 3, 錦糸町: 3, 蒲田: 3, 中野: 3, 高田馬場: 3 },
  kanagawa: { 横浜: 4, 川崎: 3, 武蔵小杉: 3, 新横浜: 3, 藤沢: 3, 大船: 3, 小田原: 3, 海老名: 3 },
  chiba: { 千葉: 4, 船橋: 3, 西船橋: 3, 柏: 3, 松戸: 3, 津田沼: 3, 成田空港: 3 },
  saitama: { 大宮: 4, 浦和: 3, 川越: 3, 所沢: 3, 熊谷: 3 },
  ibaraki: { 水戸: 3, つくば: 3, 土浦: 3 }, tochigi: { 宇都宮: 3, 小山: 3 }, gunma: { 高崎: 3, 前橋: 3 },
  hokkaido: { 札幌: 4, さっぽろ: 3, 大通: 3, 新千歳空港: 3, 旭川: 3, 函館: 3, 新函館北斗: 3, 釧路: 3, 帯広: 3 },
  aomori: { 青森: 3, 新青森: 3, 八戸: 3 }, iwate: { 盛岡: 3 }, miyagi: { 仙台: 4 }, akita: { 秋田: 3 }, yamagata: { 山形: 3 }, fukushima: { 福島: 3, 郡山: 3 },
  niigata: { 新潟: 3 }, toyama: { 富山: 3 }, ishikawa: { 金沢: 3 }, fukui: { 福井: 3 }, yamanashi: { 甲府: 3 }, nagano: { 長野: 3, 松本: 3 },
  gifu: { 岐阜: 3 }, shizuoka: { 静岡: 3, 浜松: 3 }, aichi: { 名古屋: 4, 栄: 3, 金山: 3, 中部国際空港: 3, 豊橋: 3 },
  mie: { 津: 3, 四日市: 3 }, shiga: { 大津: 3, 草津: 3 }, kyoto: { 京都: 4, 烏丸: 3, 四条: 3, 河原町: 3 },
  osaka: { 大阪: 4, 梅田: 4, 大阪梅田: 4, 新大阪: 4, 難波: 3, なんば: 3, 天王寺: 3, 大阪阿部野橋: 3, 京橋: 3, 鶴橋: 3, 本町: 3, 淀屋橋: 3, 関西空港: 3 },
  hyogo: { 三ノ宮: 4, 神戸三宮: 4, 三宮: 3, 神戸: 3, 新神戸: 3, 姫路: 3, 尼崎: 3 }, nara: { 奈良: 3, 大和西大寺: 3 }, wakayama: { 和歌山: 3 },
  tottori: { 鳥取: 3 }, shimane: { 松江: 3 }, okayama: { 岡山: 3 }, hiroshima: { 広島: 3 }, yamaguchi: { 新山口: 3, 下関: 3 },
  tokushima: { 徳島: 3 }, kagawa: { 高松: 3 }, ehime: { 松山: 3 }, kochi: { 高知: 3 },
  fukuoka: { 博多: 4, 天神: 3, '西鉄福岡(天神)': 3, 小倉: 3, 福岡空港: 3 }, saga: { 佐賀: 3 }, nagasaki: { 長崎: 3 }, kumamoto: { 熊本: 3 },
  oita: { 大分: 3 }, miyazaki: { 宮崎: 3 }, kagoshima: { 鹿児島中央: 3 }, okinawa: { 那覇空港: 3, 県庁前: 3 },
};
const TERMINALS = TERMINALS_BY_PREF[prefId] || {};
// ゲーム内の役割を手で決める駅(既定は HUB)
const KIND_OVERRIDES_BY_PREF = {
  tokyo: { 大手町: 'IX', 霞ケ関: 'GOV', 霞ヶ関: 'GOV', 霞が関: 'GOV', 羽田空港第1ターミナル: 'GW' }, chiba: { 成田空港: 'GW' },
  hokkaido: { 新千歳空港: 'GW' }, aichi: { 中部国際空港: 'GW' }, osaka: { 関西空港: 'GW' }, fukuoka: { 福岡空港: 'GW' }, okinawa: { 那覇空港: 'GW' },
};
const KIND_OVERRIDES = KIND_OVERRIDES_BY_PREF[prefId] || {};
const TODAY = '2026-10-19';

// ---------- 地域マスター ----------
const R = JSON.parse(fs.readFileSync(REGION_FILE, 'utf8'));
const pref = R.regions.find((r) => r.id === prefId && r.kind === 'state');
if (!pref) { console.error(`地域マスターに都道府県 ${prefId} がありません(先に import-regions.js)`); process.exit(1); }
const prefCode = pref.code.slice(3); // JP-14 → 14
const regionByCode = new Map(R.regions.filter((r) => r.parent === prefId && r.code).map((r) => [r.code.slice(6), r])); // 14100 → 地域

// ---------- 多角形の内外判定 ----------
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(pt, poly) { if (!pointInRing(pt, poly[0])) return false; for (let k = 1; k < poly.length; k++) if (pointInRing(pt, poly[k])) return false; return true; }
function bboxOf(geom) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY, polys };
}

// ---------- 行政区域 ----------
const boundary = JSON.parse(fs.readFileSync(boundaryFile, 'utf8'));
const areas = boundary.features
  .filter((f) => f.properties.N03_001 === pref.name && f.properties.N03_004 && f.properties.N03_007)
  .map((f) => ({ code: f.properties.N03_007, ...bboxOf(f.geometry) }));
if (!areas.length) { console.error(`N03 に ${pref.name} の地物がありません`); process.exit(1); }
let bb = { minX: 180, minY: 90, maxX: -180, maxY: -90 };
for (const a of areas) { bb.minX = Math.min(bb.minX, a.minX); bb.minY = Math.min(bb.minY, a.minY); bb.maxX = Math.max(bb.maxX, a.maxX); bb.maxY = Math.max(bb.maxY, a.maxY); }
function areaOf(pt) {
  for (const a of areas) {
    if (pt[0] < a.minX || pt[0] > a.maxX || pt[1] < a.minY || pt[1] > a.maxY) continue;
    for (const poly of a.polys) if (pointInPolygon(pt, poly)) return a;
  }
  return null;
}

// ---------- 駅 ----------
const stations = JSON.parse(fs.readFileSync(stationFile, 'utf8'));
const midpoint = (geom) => { const cs = geom.type === 'LineString' ? geom.coordinates : geom.coordinates.flat(); const m = cs[Math.floor(cs.length / 2)]; return [m[0], m[1]]; };
const groups = new Map();
let unmappedCodes = new Set();
for (const f of stations.features) {
  const p = f.properties;
  const pt = midpoint(f.geometry);
  if (pt[0] < bb.minX || pt[0] > bb.maxX || pt[1] < bb.minY || pt[1] > bb.maxY) continue;
  const area = areaOf(pt);
  if (!area) continue;
  if (!regionByCode.has(area.code)) { unmappedCodes.add(area.code); continue; }
  const g = groups.get(p.N02_005g) || { code: p.N02_005g, name: null, pts: [], lines: new Set(), operators: new Set(), areas: new Map() };
  if (p.N02_005c === p.N02_005g || !g.name) g.name = p.N02_005;
  g.pts.push(pt);
  g.lines.add(`${p.N02_004} ${p.N02_003}`);
  g.operators.add(p.N02_004);
  g.areas.set(area.code, (g.areas.get(area.code) || 0) + 1);
  groups.set(p.N02_005g, g);
}

// 同名のグループは 1.2 km 以内なら 1 駅にまとめ、離れていれば事業者名で区別する
// 名前の扱い(2026-10-19): 路面電車の停留場には「富山駅」「岡山駅前」のように名前に「駅」を含むものがある。
//   まとめる鍵は末尾の「駅」を除いた名前(「富山駅」停留場と JR の「富山」を 1 つに)。表示名は「駅」を含んでいればそのまま、無ければ「駅」を足す
const baseName = (n) => n.replace(/駅$/, '');
const displayName = (n) => (/駅/.test(baseName(n)) ? baseName(n) : `${baseName(n)}駅`);
const byName = new Map();
for (const g of groups.values()) { const k = baseName(g.name); (byName.get(k) || byName.set(k, []).get(k)).push(g); }
const distKm = (a, b) => { const R = 6371, toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const center = (g) => [g.pts.reduce((s, p) => s + p[0], 0) / g.pts.length, g.pts.reduce((s, p) => s + p[1], 0) / g.pts.length];
for (const [, list] of byName) {
  if (list.length < 2) continue;
  list.sort((a, b) => b.lines.size - a.lines.size);
  const main = list[0];
  for (const g of list.slice(1)) {
    if (distKm(center(main), center(g)) <= 1.2) {
      main.pts.push(...g.pts); g.lines.forEach((l) => main.lines.add(l)); g.operators.forEach((o) => main.operators.add(o));
      for (const [k, v] of g.areas) main.areas.set(k, (main.areas.get(k) || 0) + v);
      groups.delete(g.code);
    } else {
      g.suffix = `(${[...g.operators][0]})`;
    }
  }
}

// 「◯◯駅前」「◯◯駅東口」など、駅のすぐ前の停留場(路面電車など)は、400 m 以内にあるその駅に統合する(2026-10-19)。
// 実際には同じ場所で、乗り継げる路線が駅に集まる方がゲームとしても自然
const STOP_AT_STATION = /^(.+)駅(前|東口|西口|南口|北口)$/;
let mergedStops = 0;
for (const g of [...groups.values()]) {
  if (!groups.has(g.code)) continue;
  const m = STOP_AT_STATION.exec(baseName(g.name)); if (!m) continue;
  const targets = (byName.get(m[1]) || []).filter((t) => t !== g && groups.has(t.code) && distKm(center(t), center(g)) <= 0.4);
  if (!targets.length) continue;
  targets.sort((x, y) => distKm(center(x), center(g)) - distKm(center(y), center(g)));
  const main = targets[0];
  main.pts.push(...g.pts); g.lines.forEach((l) => main.lines.add(l)); g.operators.forEach((o) => main.operators.add(o));
  for (const [k, v] of g.areas) main.areas.set(k, (main.areas.get(k) || 0) + v);
  groups.delete(g.code); mergedStops++;
}

// 名前が違っても 30 m 以内の駅は同じ駅(事業者ごとに表記が違うだけ。例: 新札幌と新さっぽろ、人吉と人吉温泉、佐貫と龍ケ崎市)。
// 路線の多い方の名前で 1 つにまとめる(2026-10-19)
const SAME_PLACE_KM = 0.03;
let mergedSamePlace = 0;
const gl = [...groups.values()];
for (let i = 0; i < gl.length; i++) {
  if (!groups.has(gl[i].code)) continue;
  for (let j = i + 1; j < gl.length; j++) {
    if (!groups.has(gl[j].code) || !groups.has(gl[i].code)) continue;
    if (distKm(center(gl[i]), center(gl[j])) > SAME_PLACE_KM) continue;
    const [main, g] = gl[i].lines.size >= gl[j].lines.size ? [gl[i], gl[j]] : [gl[j], gl[i]];
    main.pts.push(...g.pts); g.lines.forEach((l) => main.lines.add(l)); g.operators.forEach((o) => main.operators.add(o));
    for (const [k, v] of g.areas) main.areas.set(k, (main.areas.get(k) || 0) + v);
    groups.delete(g.code); mergedSamePlace++;
  }
}

// ---------- 県境の駅: 別の県のファイルにすでにある id は取り込まない(2 つの県に重複させない) ----------
const otherIds = new Set();
for (const reg of R.regions) {
  if (!reg.nodeFile || reg.nodeFile === prefId) continue;
  const file = path.join(DATA, `${reg.nodeFile}.json`);
  if (!fs.existsSync(file)) continue;
  for (const n of JSON.parse(fs.readFileSync(file, 'utf8')).nodes) otherIds.add(n.id);
}
let skippedBorder = 0;
for (const code of [...groups.keys()]) if (otherIds.has(`st-${code}`)) { groups.delete(code); skippedBorder++; }

// ---------- 拠点マスターの更新 ----------
const template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
let T;
if (fs.existsSync(NODE_FILE)) T = JSON.parse(fs.readFileSync(NODE_FILE, 'utf8'));
else T = { region: prefId, name: pref.name, version: 0, updatedAt: TODAY, note: `${pref.name}の拠点マスター。名前は正しい名所の名前(docs/PLACES.md)。粒度は駅ぐらい。Cosmos DB の nodes コンテナーと同じ項目。`, sources: template.sources, kinds: template.kinds, genres: template.genres };
const keep = T.nodes ? T.nodes.filter((n) => n.genre !== 'station') : [];
const levelByName = Object.fromEntries((T.nodes || []).filter((n) => n.genre === 'station').map((n) => [n.name, n.level]));
const kindByName = Object.fromEntries((T.nodes || []).filter((n) => n.genre === 'station').map((n) => [n.name, n.kind]));
const imported = [];
for (const g of [...groups.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  const lat = g.pts.reduce((s, p) => s + p[1], 0) / g.pts.length;
  const lon = g.pts.reduce((s, p) => s + p[0], 0) / g.pts.length;
  const areaCode = [...g.areas.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const region = regionByCode.get(areaCode);
  const lineCount = g.lines.size;
  const name = `${displayName(g.name)}${g.suffix || ''}`;
  let level = lineCount >= 4 ? 3 : lineCount >= 2 ? 2 : 1;
  if (TERMINALS[baseName(g.name)]) level = TERMINALS[baseName(g.name)];
  else if (levelByName[name] && levelByName[name] > level) level = levelByName[name];
  const kind = KIND_OVERRIDES[baseName(g.name)] || kindByName[name] || 'HUB';
  imported.push({ id: `st-${g.code}`, name, genre: 'station', kind, area: region.name, region: region.id, lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), level, value: level, lines: [...g.lines].sort() });
}
T.nodes = keep.concat(imported);
const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
T.nodes = T.nodes.map((n, i) => ({ n, i })).sort((a, b) => (order[a.n.region] - order[b.n.region]) || (a.i - b.i)).map((x) => x.n);
T.version = (T.version || 0) + 1;
T.updatedAt = TODAY;
T.sources = template.sources;
// 地域マスターに nodeFile を付ける
if (pref.nodeFile !== prefId) { pref.nodeFile = prefId; }

// ---------- 書き出し(1 行 1 件の書式) ----------
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(head, key, items, groupKey) {
  let out = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`);
  let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}
const { nodes: _n, ...head } = T;
fs.writeFileSync(NODE_FILE, writeList(head, 'nodes', T.nodes, 'area'));
fs.writeFileSync(REGION_FILE, writeList({ version: R.version, updatedAt: R.updatedAt, note: R.note, kinds: R.kinds, leafKinds: R.leafKinds }, 'regions', R.regions, 'parent'));

const byLevel = {}; for (const n of imported) byLevel[n.level] = (byLevel[n.level] || 0) + 1;
console.log(`${pref.name}: 駅 ${imported.length} 件を取り込み(県外を除外)。名所 ${keep.length} 件は維持。合計 ${T.nodes.length} → ${path.basename(NODE_FILE)}`);
console.log('レベル内訳', byLevel, '/ 行政区域', areas.length, '件', mergedStops ? `/ 駅前の停留場を駅に統合 ${mergedStops} 件` : '', mergedSamePlace ? `/ 30 m 以内の別名の駅を統合 ${mergedSamePlace} 件` : '', skippedBorder ? `/ 県境で別の県にある駅 ${skippedBorder} 件は除外` : '', unmappedCodes.size ? `/ 地域マスターに無いコード ${[...unmappedCodes].join(',')}` : '');
