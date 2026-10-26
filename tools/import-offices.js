'use strict';
// 市区町村役場・政令指定都市の区役所と、国の機関の庁舎(ジャンル government)を拠点マスターに入れる(2026-10-26 ユーザー決定。
// 専門の段(79〜89)にふさわしい大きな拠点を足す。docs/DESIGN.md の 2026-10-26 の記録、docs/GENRE.md 第 4 章)。
//
// 使い方:
//   node tools/import-offices.js <P05 のフォルダ> <N03 の GeoJSON のフォルダ> [Wikidata の作業フォルダ]
//   P05 のフォルダ: 国土数値情報「市町村役場等及び公的集会施設データ」(P05)2022 年の全国の zip(P05-22_GML.zip)を展開したもの。
//                   中の P05-22_NN.geojson(都道府県ごと)を下のフォルダまで探して読む
//   N03 のフォルダ: 国土数値情報 行政区域(N03)の N03-YYYYMMDD_NN.geojson(浜松市の区の再編のように、P05 のあとに変わった市区町村を位置で引く。国の機関の市区町村を決める)
//   作業フォルダ: Wikidata の応答を保存する(2 回目以降は取り直さない。消せば取り直す)。既定は OS の一時フォルダの pc-offices
//
// 何度実行しても同じ結果になる(前回この道具で入れたもの: id が go- のもの、tags の先頭が「国の機関」の lm- を入れ直す)。
// 順番: import-stations → import-landmarks → import-islands → import-gateways → import-tourism → **import-offices** → import-universities
//       → import-towns → import-water → fetch-codes → import-links → import-routes
// (import-landmarks は lm- を全部入れ直すので、この道具より前に動かす。町・字の「中にある拠点」(contains)に入れるため import-towns より前)
//
// 決まり(2026-10-26):
//   1. 市区町村役場・区役所: P05 の施設分類(P05_002)が 1(本庁: 市役所・区役所・町役場・村役場)のものだけ。支所・出張所・公民館は入れない。
//      P34(市区町村役場データ)は使用許諾が非商用なので使わない。
//      - 市区町村は行政区域コード(P05_001)で地域マスターに結びつける。コードが地域マスターに無い(2022 年のあとに変わった)ものは、座標が入る今の市区町村(N03)
//      - 名前は P05_003 のまま。ただし政令指定都市の区役所で市の名前が付いていないもの(「青葉区役所」)は市の名前を付ける(「仙台市青葉区役所」)
//      - 名前の市区町村と、置かれている市区町村が違うものは入れない(コードの誤り、古い名前、なくなった区、避難先の役場など)。
//        ただし役場が村・町の外にあることが知られているもの(下の OUTSIDE)は入れる
//      - 同じ建物(25 m 以内)の市役所と区役所は市役所だけ(相模原・新潟・堺)。同じ市区町村に同じ名前の本庁が 2 件あれば地域マスターの名前に合う 1 件
//      - id は go-<行政区域コード>-<名前の SHA-1 の先頭 8 桁>。基礎レベルは仮に 15(名所と同じ扱い。レベルは 1〜89 に付け直す)
//      - 北方領土の村は非公開(disputed)。P05 には北方領土の村の本庁は無い
//   2. 国の機関の庁舎: Wikidata(CC0)の中央省庁・外局と、地方の出先機関(地方整備局・地方運輸局・運輸支局・法務局・財務局・農政局・
//      経済産業局・総合通信局・労働局・厚生局・国税局・税務署・税関・森林管理局・合同庁舎 など)の座標を持つもの。
//      裁判所・検察・警察・消防・自衛隊・防衛・刑務所・入管・海上保安・大使館は入れない(PLACES.md 第 3 章)。気象台・航空管制は安全の設備なので入れない。
//      都道府県・市区町村の機関、廃止されたもの、「旧〇〇」(建物の跡)は入れない。国土数値情報の「国・都道府県の機関」は非商用なので使わない
//      - id は lm-q<QID>(今の名所と同じ)。基礎レベルは知名度(言語版の数)で 15〜70(仮)
//   3. 今の拠点と重なるもの(同じ Wikidata の項目、同じ都道府県の同じジャンルの同じ名前、町・字以外の拠点から 25 m 以内)は入れない
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const U = require('./place-utils');
const { fameLevel } = require('./levels');

const [, , p05Dir, n03Dir, workDir = path.join(os.tmpdir(), 'pc-offices')] = process.argv;
if (!p05Dir || !n03Dir) { console.error('使い方: node tools/import-offices.js <P05 のフォルダ> <N03 の GeoJSON のフォルダ> [Wikidata の作業フォルダ]'); process.exit(1); }
const TODAY = '2026-10-26';
const SRC_P05 = 'src-ksj-p05-2022';
const OFFICE_LEVEL = 15; // 仮(tools/levels.js の名所の下限と同じ)
const TAG_TOWNHALL = '市区町村役場', TAG_WARD = '区役所', TAG_NATIONAL = '国の機関';

// 役場が村・町の外(ほかの市)にあることが知られているもの(2026-10-26 確認)。名前の市区町村と置かれている市区町村が違っても入れる
const OUTSIDE = new Set(['十島村役場', '三島村役場', '竹富町役場']); // 十島村・三島村は鹿児島市、竹富町は石垣市に役場がある
// 名前の異体字をそろえる(地域マスターと P05 で字が違うもの)
const norm = (s) => s.replace(/ヶ/g, 'ケ').replace(/ヵ/g, 'カ').replace(/梼/g, '檮');

// ---------- 1. 市区町村役場・区役所(P05) ----------
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /^P05-22_[0-9]{2}\.geojson$/.test(e.name) ? [path.join(d, e.name)] : []));
const p05Files = walk(p05Dir).sort();
if (!p05Files.length) { console.error(`${p05Dir} に P05-22_NN.geojson がありません`); process.exit(1); }
const honcho = [];
for (const f of p05Files) {
  for (const ft of JSON.parse(fs.readFileSync(f, 'utf8')).features) {
    const p = ft.properties;
    if (String(p.P05_002) !== '1') continue; // 1 = 本庁
    const [lon, lat] = ft.geometry.coordinates;
    honcho.push({ code: String(p.P05_001), name: String(p.P05_003).trim(), lat, lon });
  }
}
// 市区町村: コードで引けなければ座標で(N03)
const byCodeMiss = honcho.filter((h) => !U.regionByCode.has(h.code));
U.locate(byCodeMiss, n03Dir);
for (const h of honcho) if (!h.region) h.region = U.regionByCode.get(h.code) || null;
// 名前の市区町村(「仙台市役所」→ 仙台市、「青葉区役所」→ 青葉区)と、置かれている市区町村が合うか
const cityPart = (regionName) => { const m = /^(.+?市)(.+区)$/.exec(regionName); return m ? { city: m[1], ward: m[2] } : null; }; // 政令指定都市の区
function nameFits(h) {
  const base = norm(h.name.replace(/(役所|役場)(庁舎)?$/, ''));
  const rn = norm(h.region.name);
  const cp = cityPart(rn);
  if (base === rn) return true;
  if (cp && (base === cp.ward || base === cp.city)) return true; // 区役所(市の名前なし)、区にある市役所
  return false;
}
const skippedP05 = { noRegion: [], mismatch: [], dupName: [], sameBuilding: [], existing: [] };
let cands = [];
for (const h of honcho) {
  if (!h.region) { skippedP05.noRegion.push(`${h.name}(${h.code})`); continue; }
  if (!nameFits(h) && !OUTSIDE.has(h.name)) { skippedP05.mismatch.push(`${h.name}(${h.code} ${h.region.name}にある)`); continue; }
  const cp = cityPart(h.region.name);
  h.isWard = !!cp && !h.name.replace(/(役所|役場)(庁舎)?$/, '').endsWith('市');
  h.display = h.isWard && !h.name.startsWith(cp.city) ? cp.city + h.name : h.name;
  cands.push(h);
}
// 同じ市区町村に同じ名前(異体字をそろえて)の本庁が 2 件: 地域マスターの名前に合う方(無ければ先の 1 件)
{
  const seen = new Map();
  cands.sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name) || a.lat - b.lat || a.lon - b.lon);
  const keep = [];
  for (const h of cands) {
    const k = `${h.region.id}|${norm(h.display)}`;
    const prev = seen.get(k);
    if (!prev) { seen.set(k, h); keep.push(h); continue; }
    const fitsName = (x) => norm(x.name.replace(/(役所|役場)(庁舎)?$/, '')) === norm(x.region.name) && x.name.replace(/(役所|役場)(庁舎)?$/, '') === x.region.name;
    if (fitsName(h) && !fitsName(prev)) { keep[keep.indexOf(prev)] = h; seen.set(k, h); skippedP05.dupName.push(`${prev.name}(${h.name} と同じ)`); }
    else skippedP05.dupName.push(`${h.name}(${prev.name} と同じ)`);
  }
  cands = keep;
}
// 市役所を先に(同じ建物の区役所より市役所を残す)
cands.sort((a, b) => (a.isWard - b.isWard) || a.code.localeCompare(b.code) || a.display.localeCompare(b.display));

// ---------- 2. 国の機関の庁舎(Wikidata) ----------
// 入れる分類(Wikidata の P31。日本の国の行政機関・出先機関・合同庁舎)。下位の分類はたどらない(都道府県・市区町村の機関が混ざるため)
const GOV_CLASSES = {
  Q15409298: '日本の行政機関(省)', Q11484275: '庁', Q8010730: '外局', Q109121706: '府省の行政委員会', Q11438576: '大臣委員会等',
  Q77608093: '中央合同庁舎', Q1091292: '合同庁舎', Q11424378: '地方支分部局', Q11395528: '出先機関',
  Q11424381: '地方整備局', Q11424433: '地方運輸局', Q11640490: '運輸支局', Q11424419: '地方航空局', Q11555048: '法務局', Q11424387: '地方法務局',
  Q11634586: '財務局', Q11421203: '国税局', Q14642611: '税務署', Q15055812: '税関', Q11424432: '地方農政局', Q11424430: '地方農政事務所',
  Q11606460: '経済産業局', Q11607629: '総合通信局', Q11643849: '都道府県労働局', Q11424368: '地方厚生局', Q11424395: '地方環境事務所',
  Q11539889: '森林管理局', Q11565354: '漁業調整事務所',
};
// 名前で探すもの(分類が付いていない合同庁舎・ハローワーク・国道事務所など)。Wikidata の検索(日本にあり座標を持つ項目)
const GOV_SEARCH = ['合同庁舎', 'ハローワーク', '公共職業安定所', '国道事務所', '河川国道事務所', '河川事務所', '森林管理署', '地方環境事務所', '開発建設部', '総合事務局'];
// 国の機関であることを名前で確かめる(どれかを含むこと)
const NATIONAL_NAME = /(省|庁|国税局|税務署|税関|法務局|財務局|財務事務所|運輸局|運輸支局|整備局|国道事務所|河川事務所|農政局|農政事務所|経済産業局|総合通信局|環境事務所|労働局|厚生局|厚生支局|森林管理局|森林管理署|航空局|開発建設部|総合事務局|合同庁舎|ハローワーク|公共職業安定所|委員会|議員会館)/;
// 入れないもの(名前): PLACES.md 第 3 章(裁判所・警察・消防・軍・刑務所・大使館)、安全の設備(気象台・航空管制)、
// 都道府県・市区町村の機関、建物の跡、国会の院(国会議事堂の中)、皇室の機関
const EXCLUDE_NAME = /裁判所|検察|警察|公安|消防|自衛隊|防衛|刑務所|拘置|矯正|少年院|鑑別所|入国|入管|海上保安|大使館|領事館|気象|測候|管制|役所|役場|支所|教育委員会|都庁|道庁|府庁|県|都立|府立|道立|市立|町立|村立|振興局|宮内庁|交差点|^旧|跡$|^参議院$|^衆議院$|研究所|センター|機構|大学/;
// 入れないもの(Wikidata の分類): 裁判所・警察・消防・刑務所・大使館・軍・病院・市庁舎・役所
const EXCLUDE_TYPES = new Set(['Q41487', 'Q1137809', 'Q861951', 'Q1195942', 'Q6498663', 'Q40357', 'Q3917681', 'Q245016', 'Q18691599', 'Q1788820', 'Q16917', 'Q543654', 'Q25550691', 'Q11424344', 'Q108632433', 'Q11424442', 'Q6664211', 'Q5283344']);

async function collectNational() {
  const rows = [];
  const classQuery = `SELECT ?item ?ja ?sl ?c ?t ?dis WHERE {
  VALUES ?cls { ${Object.keys(GOV_CLASSES).map((q) => 'wd:' + q).join(' ')} }
  ?item wdt:P31 ?cls; wdt:P17 wd:Q17; wdt:P625 ?c; wikibase:sitelinks ?sl.
  ?item rdfs:label ?ja FILTER(LANG(?ja) = "ja")
  OPTIONAL { ?item wdt:P31 ?t } OPTIONAL { ?item wdt:P576|wdt:P3999 ?dis } }`;
  rows.push(...await U.cachedQuery(workDir, 'gov-classes', classQuery));
  for (const k of GOV_SEARCH) {
    const q = `SELECT ?item ?ja ?sl ?c ?t ?dis WHERE {
  SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "Generator"; mwapi:generator "search";
    mwapi:gsrsearch "${k} haswbstatement:P17=Q17 haswbstatement:P625"; mwapi:gsrlimit "max"; mwapi:gsrnamespace "0". ?item wikibase:apiOutputItem mwapi:title. }
  ?item wdt:P17 wd:Q17; wdt:P625 ?c; wikibase:sitelinks ?sl. ?item rdfs:label ?ja FILTER(LANG(?ja) = "ja")
  OPTIONAL { ?item wdt:P31 ?t } OPTIONAL { ?item wdt:P576|wdt:P3999 ?dis } }`;
    rows.push(...await U.cachedQuery(workDir, `gov-search-${Buffer.from(k).toString('hex').slice(0, 40)}`, q));
  }
  // 項目ごとにまとめる
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.item) || { qid: r.item, name: r.ja, sl: Number(r.sl), coords: [], types: new Set(), dissolved: false };
    const pt = U.parsePoint(r.c);
    if (pt && !x.coords.some((c) => c.lat === pt.lat && c.lon === pt.lon)) x.coords.push(pt);
    if (r.t) x.types.add(r.t);
    if (r.dis) x.dissolved = true;
    by.set(r.item, x);
  }
  return [...by.values()].sort((a, b) => a.qid.localeCompare(b.qid));
}

(async () => {
  const files = U.loadNodeFiles();
  // 前回この道具で入れたもの(go-、tags の先頭が「国の機関」の lm-)は外して入れ直す
  for (const { T } of files.values()) T.nodes = T.nodes.filter((n) => !n.id.startsWith('go-') && !(n.id.startsWith('lm-') && n.genre === 'government' && n.tags && n.tags[0] === TAG_NATIONAL));
  const all = [...files.values()].flatMap((x) => x.T.nodes);
  const byQid = new Map(all.filter((n) => n.codes && n.codes.wikidata).map((n) => [n.codes.wikidata, n]));
  const grid = U.nodeGrid(files);
  const namesIn = (prefId, genre) => new Set(files.get(prefId).T.nodes.filter((n) => n.genre === genre).map((n) => n.name));
  const added = [];
  const place = (node, prefId) => { files.get(prefId).T.nodes.push(node); grid.add(node); added.push(node); };

  // 1. 役場・区役所
  for (const h of cands) {
    const pref = U.prefOf(h.region);
    const p = { lat: Number(h.lat.toFixed(5)), lon: Number(h.lon.toFixed(5)) };
    const sameName = namesIn(pref.id, 'government').has(h.display) ? h.display : null;
    if (sameName) { skippedP05.existing.push(`${h.display}(同じ名前の拠点がある)`); continue; }
    const near = grid.near(p, 0.025)[0];
    if (near) { (near.n.id.startsWith('go-') ? skippedP05.sameBuilding : skippedP05.existing).push(`${h.display}(${near.n.name} から ${Math.round(near.d * 1000)} m)`); continue; }
    const node = { id: `go-${h.code}-${crypto.createHash('sha1').update(h.name).digest('hex').slice(0, 8)}`, name: h.display, genre: 'government', kind: 'GOV', area: h.region.name, region: h.region.id,
      lat: p.lat, lon: p.lon, level: OFFICE_LEVEL, value: OFFICE_LEVEL, tags: [h.isWard ? TAG_WARD : TAG_TOWNHALL], codes: { ext: [{ scheme: SRC_P05, value: `${h.code}:${h.name}` }] }, src: SRC_P05 };
    if (/^hokkaido-0(1695|1696|1697|1698|1699|1700)$/.test(h.region.id)) { node.status = 'hidden'; node.hiddenReason = 'disputed'; }
    place(node, pref.id);
  }

  // 2. 国の機関
  const gov = await collectNational();
  const skippedGov = { dissolved: [], type: [], name: [], notNational: [], coord: [], noRegion: [], outOfBounds: [], existing: [] };
  const govCands = [];
  for (const x of gov) {
    if (x.dissolved) { skippedGov.dissolved.push(x.name); continue; }
    if ([...x.types].some((t) => EXCLUDE_TYPES.has(t))) { skippedGov.type.push(x.name); continue; }
    if (EXCLUDE_NAME.test(x.name)) { skippedGov.name.push(x.name); continue; }
    if (!NATIONAL_NAME.test(x.name)) { skippedGov.notNational.push(x.name); continue; }
    govCands.push(x);
  }
  for (const x of await U.pickCoords(govCands, workDir, 'gov-hq')) skippedGov.coord.push(`${x.name}(座標が複数あり本部が分からない)`);
  const govPicked = govCands.filter((x) => x.lat !== null);
  U.locate(govPicked, n03Dir);
  // 同じ建物に入っている機関は 1 つだけ入る(25 m)。建物(合同庁舎)を先に、続けて知名度の高い順
  govPicked.sort((a, b) => (/合同庁舎/.test(b.name) - /合同庁舎/.test(a.name)) || b.sl - a.sl || a.qid.localeCompare(b.qid));
  for (const x of govPicked) {
    if (!x.region) { skippedGov.noRegion.push(x.name); continue; }
    if (U.outOfBounds(x)) { skippedGov.outOfBounds.push(x.name); continue; }
    const pref = U.prefOf(x.region);
    const p = { lat: Number(x.lat.toFixed(5)), lon: Number(x.lon.toFixed(5)) };
    if (byQid.has(x.qid)) { skippedGov.existing.push(`${x.name}(同じ Wikidata の拠点 ${byQid.get(x.qid).name})`); continue; }
    if (namesIn(pref.id, 'government').has(x.name)) { skippedGov.existing.push(`${x.name}(同じ名前の拠点がある)`); continue; }
    const near = grid.near(p, 0.025)[0];
    if (near) { skippedGov.existing.push(`${x.name}(${near.n.name} から ${Math.round(near.d * 1000)} m)`); continue; }
    const level = fameLevel(x.sl);
    place({ id: `lm-${x.qid.toLowerCase()}`, name: x.name, genre: 'government', kind: 'GOV', area: x.region.name, region: x.region.id,
      lat: p.lat, lon: p.lon, level, value: level, tags: [TAG_NATIONAL], codes: { wikidata: x.qid }, src: 'src-wikidata' }, pref.id);
  }

  for (const { T } of files.values()) if (Array.isArray(T.genres) && !T.genres.includes('government')) T.genres.push('government');
  const written = U.writeNodeFiles(files, TODAY);

  const cnt = (tag) => added.filter((n) => n.tags[0] === tag).length;
  console.log(`P05 の本庁 ${honcho.length} 件 → 市区町村役場 ${cnt(TAG_TOWNHALL)} 件、政令指定都市の区役所 ${cnt(TAG_WARD)} 件を入れた(非公開 ${added.filter((n) => n.status === 'hidden').length})`);
  const list = (label, a) => { if (a.length) console.log(`  ${label} ${a.length}: ${a.join(' / ')}`); };
  list('市区町村が引けない', skippedP05.noRegion);
  list('名前の市区町村と置かれている市区町村が違う', skippedP05.mismatch);
  list('同じ市区町村に同じ名前の本庁', skippedP05.dupName);
  list('市役所と同じ建物(25 m 以内)の区役所', skippedP05.sameBuilding);
  list('今の拠点と重なる', skippedP05.existing);
  const missing = U.R.regions.filter((r) => r.kind === 'city' && r.name !== '所属未定地' && !added.some((n) => n.region === r.id && n.tags[0] !== TAG_NATIONAL) && !all.some((n) => n.region === r.id && n.genre === 'government' && /(役所|役場)$/.test(n.name)));
  list('本庁の拠点が無い市区町村', missing.map((r) => r.name));
  console.log(`国の機関(Wikidata の候補 ${gov.length} 件)→ ${cnt(TAG_NATIONAL)} 件を入れた`);
  list('廃止', skippedGov.dissolved); list('分類で除いた', skippedGov.type); list('名前で除いた', skippedGov.name); list('国の機関の名前でない', skippedGov.notNational);
  list('座標を決められない', skippedGov.coord); list('境界の外', skippedGov.noRegion); list('扱わない地域', skippedGov.outOfBounds); list('今の拠点と重なる', skippedGov.existing);
  console.log('  入れた国の機関:', added.filter((n) => n.tags[0] === TAG_NATIONAL).map((n) => `${n.name}(${n.area})`).join('、'));
  console.log(`書き直したファイル ${written}`);
})().catch((e) => { console.error('失敗:', e.stack || e.message); process.exit(1); });
