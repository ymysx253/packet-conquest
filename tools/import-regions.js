'use strict';
// 日本全体の地域マスター(都道府県・市区町村)を国土数値情報 N03 から地域マスター(regions.json)に足す(設計書 3.4、第 14 章)。
//
// 使い方:
//   node tools/import-regions.js <N03 の GeoJSON が入ったフォルダ>   # 各都道府県の N03-YYYYMMDD_PP.geojson を全部読む
// 出どころ: 国土交通省「国土数値情報」行政区域データ(N03)。
//
// やること:
//   1. 地方(8 つ)と 47 都道府県(kind: state、id はローマ字、code は JP-PP)を足す(あるものは触らない)
//   2. 市区町村(kind: city、id は <都道府県 id>-<行政区域コード>、名前は N03_004。政令市の区は「横浜市中区」のように市名を付ける)を足す
//      既存の東京の区・市(id が tokyo-chiyoda など)は名前と code で一致させて残す
//   3. 拠点の無い地域も入れる(形だけ先に出すため)。nodeFile は拠点ファイルがある都道府県にだけ付ける
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
    const code = p.N03_007; if (!code || seen.has(code)) continue;
    seen.add(code);
    const gun = p.N03_003 || '', town = p.N03_004 || '';
    if (!town) continue; // 所属未定地など
    const name = /市$/.test(gun) ? `${gun}${town}` : town; // 政令市の区は市名を付ける
    const fullCode = `JP-${pp}-${code}`;
    const existing = byCode.get(fullCode);
    if (existing) { existing.parent = prefId; if (!existing.localKind) existing.localKind = localKindOf(town); kept++; continue; }
    const r = { id: `${prefId}-${code}`, name, nameEn: null, kind: 'city', parent: prefId, code: fullCode, status: 'public', localKind: localKindOf(town) };
    if (gun && !/市$/.test(gun)) r.county = gun; // 郡名(表示の補助)
    R.regions.push(r); byId.set(r.id, r); byCode.set(fullCode, r); added.city++;
  }
}
// 並び: 段 → 親 → code
const tier = (r) => R.kinds[r.kind].tier;
R.regions.sort((a, b) => tier(a) - tier(b) || String(a.parent).localeCompare(String(b.parent)) || String(a.code || a.id).localeCompare(String(b.code || b.id)));
R.version = (R.version || 0) + 1;
R.updatedAt = TODAY;
R.note = (R.note ? R.note + ' ' : '') + '2026-10-19: 日本全体の都道府県・市区町村を N03 から追加(拠点の無い地域も形を出すため)。';

const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
let out = JSON.stringify({ version: R.version, updatedAt: R.updatedAt, note: R.note, kinds: R.kinds, leafKinds: R.leafKinds }, null, 2).replace(/\n}$/, ',\n  "regions": [\n');
let prev = null;
out += R.regions.map((it) => { const gap = prev && prev !== it.parent ? '\n' : ''; prev = it.parent; return gap + oneLine(it); }).join(',\n');
out += '\n  ]\n}\n';
fs.writeFileSync(REGION_FILE, out);
console.log(`地方 +${added.area}、都道府県 +${added.pref}、市区町村 +${added.city}(既存を維持 ${kept})。合計 ${R.regions.length} 件。読んだファイル ${files.length}`);
