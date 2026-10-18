'use strict';
// 日本全体の地域マスター(都道府県・市区町村)を国土数値情報 N03 から地域マスター(regions.json)に足す(設計書 3.4、第 14 章)。
//
// 使い方:
//   node tools/import-regions.js <N03 の GeoJSON が入ったフォルダ>   # 各都道府県の N03-YYYYMMDD_PP.geojson を全部読む
// 出どころ: 国土交通省「国土数値情報」行政区域データ(N03)。
//
// やること:
//   1. 地方(8 つ)と 47 都道府県(kind: state、id はローマ字、code は JP-PP)を足す(あるものは触らない)
//   2. 市区町村(kind: city、id は <都道府県 id>-<行政区域コード>、名前は N03_004(+ 政令市の区は N03_005 を付けて「横浜市鶴見区」))を足す
//      既存の東京の区・市(id が tokyo-chiyoda など)は名前と code で一致させて残す
//   3. 拠点の無い地域も入れる(形だけ先に出すため)。nodeFile は拠点ファイルがある都道府県にだけ付ける
//   4. 境界の多角形から中心(center: ラベルを置く位置)と範囲(bbox: [西, 南, 東, 北])を求めて持たせる(2026-10-19)。
//      市区町村は最も大きい輪の重心、都道府県は陸続きの最大のまとまりの重心(離島に引っぱられない)、地方・国は全体の重心。
//      拠点が無くても縮小表示に名前が出る
const fs = require('fs');
const path = require('path');

const [, , dir] = process.argv;
if (!dir) { console.error('使い方: node tools/import-regions.js <N03 の GeoJSON フォルダ>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const REGION_FILE = path.join(ROOT, 'server/map/data/regions.json');
const TODAY = '2026-10-19';

// 都道府県コード → id(ローマ字)、名前、地方
const PREFS = [
  ['01', 'hokkaido', '北海道', 'Hokkaido', 'hokkaido-region'], ['02', 'aomori', '青森県', 'Aomori', 'tohoku'], ['03', 'iwate', '岩手県', 'Iwate', 'tohoku'], ['04', 'miyagi', '宮城県', 'Miyagi', 'tohoku'],
  ['05', 'akita', '秋田県', 'Akita', 'tohoku'], ['06', 'yamagata', '山形県', 'Yamagata', 'tohoku'], ['07', 'fukushima', '福島県', 'Fukushima', 'tohoku'],
  ['08', 'ibaraki', '茨城県', 'Ibaraki', 'kanto'], ['09', 'tochigi', '栃木県', 'Tochigi', 'kanto'], ['10', 'gunma', '群馬県', 'Gunma', 'kanto'], ['11', 'saitama', '埼玉県', 'Saitama', 'kanto'],
  ['12', 'chiba', '千葉県', 'Chiba', 'kanto'], ['13', 'tokyo', '東京都', 'Tokyo', 'kanto'], ['14', 'kanagawa', '神奈川県', 'Kanagawa', 'kanto'],
  ['15', 'niigata', '新潟県', 'Niigata', 'chubu'], ['16', 'toyama', '富山県', 'Toyama', 'chubu'], ['17', 'ishikawa', '石川県', 'Ishikawa', 'chubu'], ['18', 'fukui', '福井県', 'Fukui', 'chubu'],
  ['19', 'yamanashi', '山梨県', 'Yamanashi', 'chubu'], ['20', 'nagano', '長野県', 'Nagano', 'chubu'], ['21', 'gifu', '岐阜県', 'Gifu', 'chubu'], ['22', 'shizuoka', '静岡県', 'Shizuoka', 'chubu'], ['23', 'aichi', '愛知県', 'Aichi', 'chubu'],
  ['24', 'mie', '三重県', 'Mie', 'kinki'], ['25', 'shiga', '滋賀県', 'Shiga', 'kinki'], ['26', 'kyoto', '京都府', 'Kyoto', 'kinki'], ['27', 'osaka', '大阪府', 'Osaka', 'kinki'], ['28', 'hyogo', '兵庫県', 'Hyogo', 'kinki'], ['29', 'nara', '奈良県', 'Nara', 'kinki'], ['30', 'wakayama', '和歌山県', 'Wakayama', 'kinki'],
  ['31', 'tottori', '鳥取県', 'Tottori', 'chugoku'], ['32', 'shimane', '島根県', 'Shimane', 'chugoku'], ['33', 'okayama', '岡山県', 'Okayama', 'chugoku'], ['34', 'hiroshima', '広島県', 'Hiroshima', 'chugoku'], ['35', 'yamaguchi', '山口県', 'Yamaguchi', 'chugoku'],
  ['36', 'tokushima', '徳島県', 'Tokushima', 'shikoku'], ['37', 'kagawa', '香川県', 'Kagawa', 'shikoku'], ['38', 'ehime', '愛媛県', 'Ehime', 'shikoku'], ['39', 'kochi', '高知県', 'Kochi', 'shikoku'],
  ['40', 'fukuoka', '福岡県', 'Fukuoka', 'kyushu'], ['41', 'saga', '佐賀県', 'Saga', 'kyushu'], ['42', 'nagasaki', '長崎県', 'Nagasaki', 'kyushu'], ['43', 'kumamoto', '熊本県', 'Kumamoto', 'kyushu'], ['44', 'oita', '大分県', 'Oita', 'kyushu'], ['45', 'miyazaki', '宮崎県', 'Miyazaki', 'kyushu'], ['46', 'kagoshima', '鹿児島県', 'Kagoshima', 'kyushu'], ['47', 'okinawa', '沖縄県', 'Okinawa', 'kyushu'],
];
const AREAS = [
  ['hokkaido-region', '北海道地方', 'Hokkaido'], ['tohoku', '東北', 'Tohoku'], ['kanto', '関東', 'Kanto'], ['chubu', '中部', 'Chubu'],
  ['kinki', '近畿', 'Kinki'], ['chugoku', '中国', 'Chugoku'], ['shikoku', '四国', 'Shikoku'], ['kyushu', '九州・沖縄', 'Kyushu & Okinawa'],
];
// ---------- 図形の計算(経度・緯度の平面で近似。ラベル位置と範囲だけなので十分) ----------
function ringStats(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j], [x1, y1] = ring[i];
    const k = x0 * y1 - x1 * y0;
    a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  }
  a /= 2;
  const bb = [180, 90, -180, -90];
  for (const [x, y] of ring) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
  if (Math.abs(a) < 1e-12) { const m = ring[0]; return { area: 0, cx: m[0], cy: m[1], bb }; }
  return { area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a), bb };
}
// 陸続きのまとまり: 範囲(bbox)どうしの隙間が GAP 以下の輪をつなぐ。島は離れているので別のまとまりになる
const GAP = 0.05; // 度(約 5 km)
function mainCluster(rings) {
  const n = rings.length, parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const order = rings.map((_, i) => i).sort((i, j) => rings[i].bb[0] - rings[j].bb[0]);
  for (let a = 0; a < n; a++) {
    const i = order[a], bi = rings[i].bb;
    for (let b = a + 1; b < n; b++) {
      const j = order[b], bj = rings[j].bb;
      if (bj[0] - bi[2] > GAP) break; // 経度方向に離れたら以降は届かない
      if (bj[1] - bi[3] > GAP || bi[1] - bj[3] > GAP) continue;
      parent[find(i)] = find(j);
    }
  }
  const area = new Map();
  for (let i = 0; i < n; i++) { const k = find(i); area.set(k, (area.get(k) || 0) + rings[i].area); }
  let best = null, bestA = -1;
  for (const [k, v] of area) if (v > bestA) { best = k; bestA = v; }
  return rings.filter((_, i) => find(i) === best);
}
const geo = new Map(); // 地域 id → { rings: [{ area, cx, cy }], bbox }
function addGeom(id, geometry) {
  const g = geo.get(id) || { rings: [], bbox: [180, 90, -180, -90] };
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    const outer = poly[0];
    g.rings.push(ringStats(outer));
    for (const [x, y] of outer) { g.bbox[0] = Math.min(g.bbox[0], x); g.bbox[1] = Math.min(g.bbox[1], y); g.bbox[2] = Math.max(g.bbox[2], x); g.bbox[3] = Math.max(g.bbox[3], y); }
  }
  geo.set(id, g);
}
function mergeGeom(intoId, fromId) {
  const src = geo.get(fromId); if (!src) return;
  const g = geo.get(intoId) || { rings: [], bbox: [180, 90, -180, -90] };
  g.rings.push(...src.rings);
  g.bbox = [Math.min(g.bbox[0], src.bbox[0]), Math.min(g.bbox[1], src.bbox[1]), Math.max(g.bbox[2], src.bbox[2]), Math.max(g.bbox[3], src.bbox[3])];
  geo.set(intoId, g);
}
const r5 = (x) => Number(x.toFixed(5));
function centerOf(g, mode) {
  if (!g || !g.rings.length) return null;
  if (mode === 'largest') { const big = g.rings.reduce((a, b) => (b.area > a.area ? b : a)); return { lat: r5(big.cy), lon: r5(big.cx) }; }
  const rings = mode === 'cluster' ? mainCluster(g.rings) : g.rings;
  const tot = rings.reduce((s, x) => s + x.area, 0) || 1;
  return { lat: r5(rings.reduce((s, x) => s + x.cy * x.area, 0) / tot), lon: r5(rings.reduce((s, x) => s + x.cx * x.area, 0) / tot) };
}

const localKindOf = (name) => (/区$/.test(name) ? '区' : /市$/.test(name) ? '市' : /町$/.test(name) ? '町' : /村$/.test(name) ? '村' : '');

const R = JSON.parse(fs.readFileSync(REGION_FILE, 'utf8'));
const byId = new Map(R.regions.map((r) => [r.id, r]));
const byCode = new Map(R.regions.filter((r) => r.code).map((r) => [r.code, r]));
let added = { area: 0, pref: 0, city: 0 }, kept = 0;

// 地方
for (const [id, name, nameEn] of AREAS) {
  if (byId.has(id)) continue;
  const r = { id, name, nameEn, kind: 'region', parent: 'japan', code: null, status: 'public' };
  R.regions.push(r); byId.set(id, r); added.area++;
}
// 都道府県
for (const [code, id, name, nameEn, area] of PREFS) {
  if (byId.has(id)) { byId.get(id).parent = area; continue; }
  const r = { id, name, nameEn, kind: 'state', parent: area, code: `JP-${code}`, status: 'public' };
  R.regions.push(r); byId.set(id, r); byCode.set(r.code, r); added.pref++;
}
// 市区町村(N03 の全ファイル)
const files = fs.readdirSync(dir).filter((f) => /^N03-\d{8}_\d{2}\.geojson$/.test(f)).sort();
if (!files.length) { console.error('N03 の GeoJSON が見つかりません:', dir); process.exit(1); }
for (const f of files) {
  const pp = f.slice(-10, -8);
  const pref = PREFS.find((p) => p[0] === pp); if (!pref) continue;
  const prefId = pref[1];
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const seen = new Set();
  for (const ft of data.features) {
    const p = ft.properties;
    const code = p.N03_007; if (!code) continue;
    const known = byCode.get(`JP-${pp}-${code}`);
    if (known) addGeom(known.id, ft.geometry); else if (p.N03_004) addGeom(`${prefId}-${code}`, ft.geometry);
    if (seen.has(code)) continue;
    seen.add(code);
    // N03 の項目: N03_003 郡名、N03_004 市区町村名、N03_005 政令市の区名(2024 年版以降の形)
    const gun = p.N03_003 || '', city = p.N03_004 || '', ward = p.N03_005 || '';
    if (!city) continue; // 所属未定地など
    const town = ward || city;
    const name = ward ? `${city}${ward}` : city; // 政令市の区は「横浜市鶴見区」
    const fullCode = `JP-${pp}-${code}`;
    const existing = byCode.get(fullCode);
    if (existing) {
      existing.parent = prefId;
      if (!existing.localKind) existing.localKind = localKindOf(town);
      if (!existing.id.startsWith('tokyo-') && existing.name !== name) existing.name = name; // 取り込み直しで名前を直す
      kept++; continue;
    }
    const r = { id: `${prefId}-${code}`, name, nameEn: null, kind: 'city', parent: prefId, code: fullCode, status: 'public', localKind: localKindOf(town) };
    if (gun && !/市$/.test(gun)) r.county = gun; // 郡名(表示の補助)
    R.regions.push(r); byId.set(r.id, r); byCode.set(fullCode, r); added.city++;
  }
}
// 中心と範囲: 市区町村 → 都道府県 → 地方 → 日本 の順に集める
for (const c of R.regions.filter((x) => x.kind === 'city' && geo.has(x.id))) { mergeGeom(c.parent, c.id); }
for (const p of R.regions.filter((x) => x.kind === 'state' && geo.has(x.id))) { mergeGeom(p.parent, p.id); }
for (const a of R.regions.filter((x) => x.kind === 'region' && x.parent === 'japan' && geo.has(x.id))) { mergeGeom('japan', a.id); }
let withCenter = 0;
for (const x of R.regions) {
  const g = geo.get(x.id); if (!g) continue;
  // 市区町村: 最も大きい輪 / 都道府県: 陸続きの最大のまとまり(離島に引っぱられない)/ 地方・国: 全体の重心
  x.center = centerOf(g, x.kind === 'city' ? 'largest' : x.kind === 'state' ? 'cluster' : 'weighted');
  x.bbox = g.bbox.map(r5);
  withCenter++;
}

// 並び: 段 → 親 → code
const tier = (r) => R.kinds[r.kind].tier;
R.regions.sort((a, b) => tier(a) - tier(b) || String(a.parent).localeCompare(String(b.parent)) || String(a.code || a.id).localeCompare(String(b.code || b.id)));
R.version = (R.version || 0) + 1;
R.updatedAt = TODAY;
const NOTE_ADD = '2026-10-19: 日本全体の都道府県・市区町村を N03 から追加(拠点の無い地域も形を出すため)。center と bbox は境界から求めたもの。';
R.note = String(R.note || '').replace(/ ?2026-10-19: 日本全体の都道府県・市区町村を N03 から追加[^。]*。(center と bbox は境界から求めたもの。)?/g, '').trim();
R.note = (R.note ? R.note + ' ' : '') + NOTE_ADD;

const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
let out = JSON.stringify({ version: R.version, updatedAt: R.updatedAt, note: R.note, kinds: R.kinds, leafKinds: R.leafKinds }, null, 2).replace(/\n}$/, ',\n  "regions": [\n');
let prev = null;
out += R.regions.map((it) => { const gap = prev && prev !== it.parent ? '\n' : ''; prev = it.parent; return gap + oneLine(it); }).join(',\n');
out += '\n  ]\n}\n';
fs.writeFileSync(REGION_FILE, out);
console.log(`地方 +${added.area}、都道府県 +${added.pref}、市区町村 +${added.city}(既存を維持 ${kept})。合計 ${R.regions.length} 件、中心と範囲あり ${withCenter} 件。読んだファイル ${files.length}`);
