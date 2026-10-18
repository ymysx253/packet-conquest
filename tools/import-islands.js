'use strict';
// 占領できる拠点が無い離島に、空港と港を拠点として足す(2026-10-19)。
//
// 使い方:
//   node tools/import-islands.js <N03 の GeoJSON が入ったフォルダ> [作業フォルダ]
// 出どころ: 島の形は「国土数値情報(行政区域データ)」(国土交通省)、空港と港は Wikidata(CC0)。
// 何度実行しても同じ結果になる(前回この道具で入れた拠点 = id が isl- で始まるものを入れ直す)。
// 入れたら tools/import-links.js でつながりを作り直す(島には駅が無いので、分断の橋渡しで最も近い拠点とつながる)。
//
// 手順:
//   1. 境界の多角形を「陸続きのまとまり」に分ける(範囲の隙間が約 300 m 以内の輪をつなぐ)。
//      各都道府県で最大のまとまり(本土側)以外で、面積 1.5 km² 以上のものを島とみなす
//   2. ハックできる拠点が 1 つも無い島を選ぶ
//   3. Wikidata の空港と港(港湾・フェリー港・旅客ターミナル・漁港・海港)を島に当てる。港の座標は海上にあることが多いので、
//      島の陸地(頂点)から 1.5 km 以内なら、その島のものとみなす
//   4. 島ごとに空港 1 件と港 2 件まで(知名度の高い順)を、ハック可の拠点(genre airport / port、役割 GW)として入れる
//   5. 空港も港も見つからない島は、島そのもの(Wikidata の島の項目。例: 母島、御蔵島)を自然の名所(genre nature、役割 GW)として入れる。
//      港の公開データ(国土数値情報 C02・C09・N09)は使用許諾が「非商用」なので使わない。港の名前を推測で作ることもしない(PLACES.md 第 4 章)
const fs = require('fs');
const path = require('path');
const https = require('https');
const { gatewayLevel, HUB_AIRPORTS } = require('./gateway');

const [, , n03Dir, workDir = path.join(require('os').tmpdir(), 'pc-landmarks')] = process.argv;
if (!n03Dir) { console.error('使い方: node tools/import-islands.js <N03 フォルダ> [作業フォルダ]'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const UA = 'PacketConquest/0.1 (landmark candidate collection; https://github.com/ymysx253/packet-conquest)';
const TODAY = '2026-10-19';
const GAP = 0.003;          // 度(約 300 m)。これより離れた輪は別の島
const MIN_AREA_KM2 = 1.5;   // これより小さい島は対象外(無人の小島が多い)
const NEAR_KM = 1.5;        // 港・空港が島の陸地からこの距離以内なら、その島のもの
// 北方領土(色丹・国後〈泊〉・留夜別・留別・紗那・蘂取の 6 村と、根室市に属する歯舞群島)は扱わない(実際に行けない地域で、運用の主体も違うため)。
// 立ち入りが制限された島(硫黄島・南鳥島・沖ノ鳥島)も扱わない
const NORTHERN = new Set(['01695', '01696', '01697', '01698', '01699', '01700']);
const isNorthern = (code, lon) => NORTHERN.has(code) || (code === '01223' && lon > 145.85);
// 硫黄島、南鳥島、沖ノ鳥島、尖閣諸島(領有をめぐる争いがある地域は扱わない) [南, 北, 西, 東]
const RESTRICTED = [[24.72, 24.82, 141.26, 141.37], [24.27, 24.31, 153.96, 154.0], [20.4, 20.45, 136.04, 136.1], [25.6, 26.1, 123.3, 124.7]];
const EXCLUDE_ISLAND = /馬毛島|南硫黄島/; // 自衛隊の基地の建設地、上陸が法律で禁じられた原生自然環境保全地域
const isRestricted = (g) => RESTRICTED.some(([s, n, w, e]) => g.bb[1] <= n && g.bb[3] >= s && g.bb[0] <= e && g.bb[2] >= w);
fs.mkdirSync(workDir, { recursive: true });

// ---------- Wikidata(空港と港) ----------
function sparql(query) {
  return new Promise((resolve, reject) => {
    const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: 120000 }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(body).results.bindings); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CLASSES = [
  { genre: 'airport', cls: 'Q1248784' },
  { genre: 'port', cls: 'Q44782' }, { genre: 'port', cls: 'Q1478783' }, { genre: 'port', cls: 'Q4303352' },
  { genre: 'port', cls: 'Q1420027' }, { genre: 'port', cls: 'Q15310171' },
];
const ISLAND_CLASS = 'Q23442'; // 島
const EXCLUDE_TYPES = new Set(['Q695850', 'Q245016', 'Q18691599']); // 軍用飛行場、軍事基地、軍事施設
const EXCLUDE_NAME = /基地|駐屯地|航空隊|分屯/;
async function fetchAll() {
  const out = new Map();
  for (const { genre, cls } of CLASSES) {
    const cache = path.join(workDir, `island-${cls}.json`);
    let rows;
    if (fs.existsSync(cache)) rows = JSON.parse(fs.readFileSync(cache, 'utf8'));
    else {
      const q = `SELECT ?item ?ja (SAMPLE(?c) AS ?coord) (MAX(?s) AS ?sl) (GROUP_CONCAT(DISTINCT STRAFTER(STR(?t), "entity/"); separator="|") AS ?types) WHERE {
  ?item wdt:P31 wd:${cls}; wdt:P17 wd:Q17; wdt:P625 ?c; wikibase:sitelinks ?s.
  FILTER NOT EXISTS { ?item wdt:P576 [] } FILTER NOT EXISTS { ?item wdt:P3999 [] }
  ?item rdfs:label ?ja. FILTER(LANG(?ja) = "ja")
  ?item wdt:P31 ?t.
} GROUP BY ?item ?ja`;
      const b = await sparql(q);
      rows = b.map((r) => { const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.coord.value); return { qid: r.item.value.split('/').pop(), name: r.ja.value, lon: Number(m[1]), lat: Number(m[2]), sitelinks: Number(r.sl.value), types: r.types.value.split('|') }; });
      fs.writeFileSync(cache, JSON.stringify(rows));
      await wait(1500);
    }
    console.log(`Wikidata ${genre} ${cls}: ${rows.length} 件`);
    for (const r of rows) {
      if (r.types.some((t) => EXCLUDE_TYPES.has(t)) || EXCLUDE_NAME.test(r.name)) continue;
      if (!out.has(r.qid)) out.set(r.qid, { ...r, genre });
    }
  }
  return [...out.values()];
}
async function fetchIslands() {
  const cache = path.join(workDir, `island-items-deep-${ISLAND_CLASS}.json`);
  const shallow = path.join(workDir, `island-items-${ISLAND_CLASS}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  // 「火山島」など下位の分類の島も取る(御蔵島、口永良部島など)。時間切れなら直接の分類だけ
  const q = `SELECT ?item ?ja (SAMPLE(?c) AS ?coord) (MAX(?s) AS ?sl) WHERE {
  ?item wdt:P17 wd:Q17; wdt:P31/wdt:P279* wd:${ISLAND_CLASS}; wdt:P625 ?c; wikibase:sitelinks ?s.
  FILTER(?s >= 2)
  ?item rdfs:label ?ja. FILTER(LANG(?ja) = "ja")
} GROUP BY ?item ?ja`;
  let b;
  try { b = await sparql(q); } catch (e) {
    console.log(`  島の項目: 下位の分類込みで失敗(${e.message.slice(0, 40)})。直接の分類の保存済みの結果を使います`);
    if (fs.existsSync(shallow)) return JSON.parse(fs.readFileSync(shallow, 'utf8'));
    throw e;
  }
  const rows = b.map((x) => { const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(x.coord.value); return m && { qid: x.item.value.split('/').pop(), name: x.ja.value, lon: Number(m[1]), lat: Number(m[2]), sitelinks: Number(x.sl.value), genre: 'nature' }; }).filter(Boolean);
  fs.writeFileSync(cache, JSON.stringify(rows));
  return rows;
}

// ---------- 図形 ----------
const KM_PER_DEG = 111.32;
function ringArea(ring) { // km²(経度方向は緯度で縮める)
  let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  const lat = ring[0][1] * Math.PI / 180;
  return Math.abs(a / 2) * KM_PER_DEG * KM_PER_DEG * Math.cos(lat);
}
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const distKm = (a, b) => { const toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

// ---------- 地域と拠点 ----------
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const prefByCode = new Map(R.regions.filter((r) => r.kind === 'state').map((r) => [r.code.slice(3), r]));
const regionByCode = new Map(R.regions.filter((r) => r.code && /^JP-\d\d-\d+$/.test(r.code)).map((r) => [r.code.slice(6), r]));
const files = new Map();
for (const r of R.regions.filter((x) => x.nodeFile)) { const file = path.join(DATA, `${r.nodeFile}.json`); files.set(r.id, { file, T: JSON.parse(fs.readFileSync(file, 'utf8')) }); }
for (const { T } of files.values()) T.nodes = T.nodes.filter((n) => !n.id.startsWith('isl-')); // 前回の分は入れ直す
const allNodes = [...files.values()].flatMap(({ T }) => T.nodes);
const hackableNodes = allNodes.filter((n) => n.hackable !== false);

(async () => {
  const cands = await fetchAll();
  const islandItems = (await fetchIslands()).filter((x) => /島$|嶼$/.test(x.name));
  console.log(`Wikidata 島 ${ISLAND_CLASS}: ${islandItems.length} 件(名前が「島」で終わるもの)`);
  // 1. 島(都道府県ごと)
  const islands = [];
  const fileList = fs.readdirSync(n03Dir).filter((f) => /^N03-\d{8}_\d{2}\.geojson$/.test(f)).sort();
  for (const f of fileList) {
    const pp = f.slice(-10, -8); const pref = prefByCode.get(pp); if (!pref) continue;
    const data = JSON.parse(fs.readFileSync(path.join(n03Dir, f), 'utf8'));
    const rings = [];
    for (const ft of data.features) {
      const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates;
      for (const p of polys) {
        const ring = p[0]; const bb = [180, 90, -180, -90];
        for (const [x, y] of ring) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
        rings.push({ ring, bb, area: ringArea(ring), code: ft.properties.N03_007 });
      }
    }
    // 陸続きのまとまり(範囲の隙間が GAP 以下の輪をつなぐ)
    const n = rings.length, parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const order = rings.map((_, i) => i).sort((i, j) => rings[i].bb[0] - rings[j].bb[0]);
    for (let a = 0; a < n; a++) {
      const i = order[a], bi = rings[i].bb;
      for (let b = a + 1; b < n; b++) {
        const j = order[b], bj = rings[j].bb;
        if (bj[0] - bi[2] > GAP) break;
        if (bj[1] - bi[3] > GAP || bi[1] - bj[3] > GAP) continue;
        parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(rings[i]); }
    const list = [...groups.values()].map((rs) => ({ rings: rs, area: rs.reduce((s, r) => s + r.area, 0), bb: rs.reduce((b, r) => [Math.min(b[0], r.bb[0]), Math.min(b[1], r.bb[1]), Math.max(b[2], r.bb[2]), Math.max(b[3], r.bb[3])], [180, 90, -180, -90]) }));
    list.sort((a, b) => b.area - a.area);
    for (const g of list.slice(1)) {
      if (g.area < MIN_AREA_KM2 || isRestricted(g) || g.rings.some((r) => isNorthern(r.code, r.bb[0]))) continue;
      islands.push({ ...g, pref });
    }
  }
  // 2. ハックできる拠点が無い島
  const inIsland = (pt, g) => pt.lon >= g.bb[0] && pt.lon <= g.bb[2] && pt.lat >= g.bb[1] && pt.lat <= g.bb[3] && g.rings.some((r) => pt.lon >= r.bb[0] && pt.lon <= r.bb[2] && pt.lat >= r.bb[1] && pt.lat <= r.bb[3] && pointInRing([pt.lon, pt.lat], r.ring));
  const empty = islands.filter((g) => !hackableNodes.some((nd) => inIsland(nd, g)));
  console.log(`島(1.5 km² 以上、本土側を除く): ${islands.length}。ハックできる拠点が無い島: ${empty.length}`);

  // 3. 空港と港を島に当てる(陸地の中か、陸地の頂点から 1.5 km 以内)
  const margin = NEAR_KM / KM_PER_DEG;
  const nearIsland = (c, g) => {
    if (c.lon < g.bb[0] - margin * 1.5 || c.lon > g.bb[2] + margin * 1.5 || c.lat < g.bb[1] - margin || c.lat > g.bb[3] + margin) return null;
    if (inIsland(c, g)) { const r = g.rings.find((x) => pointInRing([c.lon, c.lat], x.ring)); return { d: 0, code: r.code }; }
    let best = null;
    for (const r of g.rings) {
      if (c.lon < r.bb[0] - margin * 1.5 || c.lon > r.bb[2] + margin * 1.5 || c.lat < r.bb[1] - margin || c.lat > r.bb[3] + margin) continue;
      for (let i = 0; i < r.ring.length; i += 2) { const d = distKm(c, { lon: r.ring[i][0], lat: r.ring[i][1] }); if (d <= NEAR_KM && (!best || d < best.d)) best = { d, code: r.code }; }
    }
    return best;
  };
  const levelOf = (sl) => (sl >= 40 ? 5 : sl >= 25 ? 4 : sl >= 15 ? 3 : sl >= 8 ? 2 : 1);
  let added = 0; const filled = []; const still = [];
  for (const g of empty) {
    const hits = [];
    for (const c of cands) { const m = nearIsland(c, g); if (m) hits.push({ ...c, code: m.code, d: m.d }); }
    const pick = [...hits.filter((h) => h.genre === 'airport').sort((a, b) => b.sitelinks - a.sitelinks).slice(0, 1), ...hits.filter((h) => h.genre === 'port').sort((a, b) => b.sitelinks - a.sitelinks || a.d - b.d).slice(0, 2)];
    if (!pick.length) {
      // 空港も港も無い島: 島そのもの(知名度の高い 1 件。島の陸地の中か 1.5 km 以内)
      const isl = [];
      // 島の陸地の中にあり、知名度(言語版の数)が 2 以上の島の項目だけ(近くの岩礁を拾わないため)
      for (const c of islandItems) { if (c.sitelinks < 2 || EXCLUDE_ISLAND.test(c.name)) continue; const m = nearIsland(c, g); if (m && m.d === 0) isl.push({ ...c, code: m.code, d: m.d }); }
      isl.sort((a, b) => b.sitelinks - a.sitelinks || a.d - b.d);
      if (isl.length) pick.push(isl[0]);
    }
    if (!pick.length) { still.push(g); continue; }
    const names = [];
    for (const c of pick) {
      const region = regionByCode.get(c.code); const f = files.get(g.pref.id);
      if (!region || !f) continue;
      if (allNodes.some((nd) => distKm(nd, c) < 0.025)) continue; // 同じ場所の二重登録を避ける
      const taken = new Set(f.T.nodes.map((nd) => nd.name));
      let name = c.name; if (taken.has(name)) name = `${c.name}(${region.name})`; if (taken.has(name)) name = `${c.name}(${c.qid})`;
      const level = gatewayLevel(c.genre, c.name, levelOf(c.sitelinks)); // 空港・港は最低レベルを上げる(tools/gateway.js)
      const node = { id: `isl-${c.qid.toLowerCase()}`, name, genre: c.genre, kind: 'GW', area: region.name, region: region.id, lat: Number(c.lat.toFixed(5)), lon: Number(c.lon.toFixed(5)), level, value: level, codes: { wikidata: c.qid }, src: 'src-wikidata' };
      // 玄関口(DATA-FORMAT.md 第 4 章): 空港・港は航路を受けられる。島そのもの(nature)は玄関口の役割だけで航路は受けない
      if (c.genre === 'airport' || c.genre === 'port') node.gateway = { type: c.genre, scope: HUB_AIRPORTS.has(name) ? 'international' : 'domestic' };
      f.T.nodes.push(node); allNodes.push(node); added++; names.push(name);
    }
    if (names.length) filled.push(`${g.pref.name}: ${names.join('、')}(${g.area.toFixed(1)} km²)`); else still.push(g);
  }

  // 4. 書き出し
  const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
  const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
  const writeList = (headObj, key, items, groupKey) => {
    let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`); let prev = null;
    out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
    return out + '\n  ]\n}\n';
  };
  for (const { file, T } of files.values()) {
    T.nodes = T.nodes.map((nd, i) => ({ nd, i })).sort((a, b) => (order[a.nd.region] - order[b.nd.region]) || ((a.nd.genre === 'station') - (b.nd.genre === 'station')) || (a.i - b.i)).map((x) => x.nd);
    T.updatedAt = TODAY;
    const { nodes, ...headObj } = T;
    fs.writeFileSync(file, writeList(headObj, 'nodes', nodes, 'area'));
  }
  console.log(`入れた拠点: ${added} 件(空港・港・島)。拠点ができた島: ${filled.length}`);
  for (const line of filled) console.log('  ' + line);
  console.log(`空港・港・島の項目のどれも見つからなかった島: ${still.length}`);
  for (const g of still.sort((a, b) => b.area - a.area).slice(0, 25)) console.log(`  ${g.pref.name} ${g.area.toFixed(1)} km²(${((g.bb[1] + g.bb[3]) / 2).toFixed(3)}, ${((g.bb[0] + g.bb[2]) / 2).toFixed(3)})`);
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
