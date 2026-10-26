'use strict';
// 大学(ジャンル university)を広げる(2026-10-26 ユーザー決定。専門の段(79〜90。2026-10-27 から)にふさわしい大きな拠点を足す。docs/DESIGN.md の 2026-10-26 の記録)。
// 今の大学は tools/import-landmarks.js が知名度で絞って入れたもの(各都道府県 50 件の枠の中)。ここでは Wikidata(CC0)の日本の大学のうち、まだ無いものを足す。
//
// 使い方:
//   node tools/import-universities.js <N03 の GeoJSON のフォルダ> [Wikidata の作業フォルダ]
//   作業フォルダ: Wikidata の応答を保存する(2 回目以降は取り直さない。消せば取り直す)。既定は OS の一時フォルダの pc-universities
//
// 何度実行しても同じ結果になる(前回この道具で入れたもの: tags の先頭が「大学」の lm- を入れ直す)。
// 順番: … → import-tourism → import-offices → **import-universities** → import-towns → … → import-links(tools/import-offices.js の頭の書き込みを参照)
//
// 決まり(2026-10-26):
//   - Wikidata で大学(Q3918)とその下位の分類にあり、日本にあり、座標と日本語の名前を持つもの。名前に「大学」「大學」を含むもの
//   - 入れない: 短期大学・専門職短期大学・高等専門学校、防衛大学校などの省庁大学校・士官学校(自衛隊)、キャンパス・学部・附属の項目、
//     廃止・統合されたもの(P576 解散・廃止日、P3999 閉鎖日)、旧制・官立の大学(戦前の学校)
//   - 分校・キャンパスは入れない(大学の項目の座標 1 つ = 本部のキャンパス)。座標が複数あって離れているものは、本部の所在地(P159)に近い座標
//   - 今の拠点と重なるもの(同じ Wikidata の項目、同じ都道府県の同じ名前の大学、町・字以外の拠点から 25 m 以内)は入れない
//   - 名所の候補一覧(docs/landmarks/candidates.csv)で「採否(確認用)」を × にした項目(同じ Wikidata の id)は入れない(2026-10-26 ユーザー決定:
//     短期大学の秋田公立美術工芸短期大学・華頂短期大学、統合で無くなった大阪市立大学・大阪府立大学。Wikidata に廃止日の無いものがあるため)
//   - id は lm-q<QID>(今の名所と同じ)。基礎レベルは知名度(言語版の数)で 15〜70(仮。tools/levels.js の fameLevel)。kind は EDU
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./place-utils');
const { fameLevel } = require('./levels');

const [, , n03Dir, workDir = path.join(os.tmpdir(), 'pc-universities')] = process.argv;
if (!n03Dir) { console.error('使い方: node tools/import-universities.js <N03 の GeoJSON のフォルダ> [Wikidata の作業フォルダ]'); process.exit(1); }
const TODAY = '2026-10-26';
const TAG = '大学';
// 大学ではない、またはもう無い学校の分類(Wikidata の P31。2026-10-26 にラベルで確認)
const EXCLUDE_TYPES = {
  Q110296306: '短期大学', Q109364820: '専門職短期大学', Q370258: 'ジュニアカレッジ', Q841248: '高等専門学校', Q24898692: '専修学校',
  Q917182: '士官学校', Q1898357: '海軍兵学校', Q4688921: '施設等機関(省庁大学校)', Q11582564: '省庁大学校',
  Q209465: 'キャンパス', Q21514702: '廃止されたプロジェクト', Q96086516: 'かつての教育機関',
  Q11510986: '旧制大学', Q10211046: '官立大学', Q18701212: '官立医科大学', Q10855485: '官立文理科大学', Q11086909: '官立商業大学',
};
const EXCLUDE_NAME = /短期大学|短大|高等専門学校|キャンパス|校舎|学舎$|学部$|研究科$|附属|分校|大学校$|自衛隊|防衛/;
// 名所の候補一覧で × にした Wikidata の id(引用符つきの CSV を 1 行ずつ読む)
const REJECTED = (() => {
  const file = path.join(U.ROOT, 'docs/landmarks/candidates.csv');
  if (!fs.existsSync(file)) return new Set();
  const cells = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const [head, ...lines] = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const h = cells(head), qi = h.indexOf('Wikidata'), di = h.indexOf('採否(確認用)');
  return new Set(lines.map(cells).filter((r) => /^[×xX]$/.test(r[di] || '')).map((r) => r[qi]));
})();

(async () => {
  const q = `SELECT ?item ?ja ?sl ?c ?t ?dis WHERE {
  ?item wdt:P31/wdt:P279* wd:Q3918; wdt:P17 wd:Q17; wdt:P625 ?c; wikibase:sitelinks ?sl.
  ?item rdfs:label ?ja FILTER(LANG(?ja) = "ja")
  ?item wdt:P31 ?t. OPTIONAL { ?item wdt:P576|wdt:P3999 ?dis } }`;
  const rows = await U.cachedQuery(workDir, 'universities', q);
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.item) || { qid: r.item, name: r.ja, sl: Number(r.sl), coords: [], types: new Set(), dissolved: false };
    const pt = U.parsePoint(r.c);
    if (pt && !x.coords.some((c) => c.lat === pt.lat && c.lon === pt.lon)) x.coords.push(pt);
    x.types.add(r.t);
    if (r.dis) x.dissolved = true;
    by.set(r.item, x);
  }
  const items = [...by.values()].sort((a, b) => a.qid.localeCompare(b.qid));
  const skipped = { dissolved: 0, rejected: [], type: {}, name: [], coord: [], noRegion: [], outOfBounds: [], existing: [] };
  let cands = [];
  for (const x of items) {
    if (x.dissolved) { skipped.dissolved++; continue; }
    if (REJECTED.has(x.qid)) { skipped.rejected.push(x.name); continue; }
    const bad = [...x.types].find((t) => EXCLUDE_TYPES[t]);
    if (bad) { skipped.type[EXCLUDE_TYPES[bad]] = (skipped.type[EXCLUDE_TYPES[bad]] || 0) + 1; continue; }
    if (EXCLUDE_NAME.test(x.name) || !/大学|大學/.test(x.name)) { skipped.name.push(x.name); continue; }
    cands.push(x);
  }
  for (const x of await U.pickCoords(cands, workDir, 'universities-hq')) skipped.coord.push(`${x.name}(座標が複数あり本部が分からない)`);
  cands = cands.filter((x) => x.lat !== null);
  U.locate(cands, n03Dir);

  const files = U.loadNodeFiles();
  for (const { T } of files.values()) T.nodes = T.nodes.filter((n) => !(n.id.startsWith('lm-') && n.genre === 'university' && n.tags && n.tags[0] === TAG));
  const all = [...files.values()].flatMap((x) => x.T.nodes);
  const byQid = new Map(all.filter((n) => n.codes && n.codes.wikidata).map((n) => [n.codes.wikidata, n]));
  const grid = U.nodeGrid(files);
  const added = [];
  // 知名度の高い順に(同じ場所に 2 つあれば知名度の高い方が残る)
  cands.sort((a, b) => b.sl - a.sl || a.qid.localeCompare(b.qid));
  for (const x of cands) {
    if (!x.region) { skipped.noRegion.push(x.name); continue; }
    if (U.outOfBounds(x)) { skipped.outOfBounds.push(x.name); continue; }
    const pref = U.prefOf(x.region);
    const T = files.get(pref.id).T;
    const p = { lat: Number(x.lat.toFixed(5)), lon: Number(x.lon.toFixed(5)) };
    if (byQid.has(x.qid)) { skipped.existing.push(`${x.name}(同じ Wikidata の拠点)`); continue; }
    const same = T.nodes.find((n) => n.genre === 'university' && n.name === x.name);
    if (same) { skipped.existing.push(`${x.name}(同じ名前の大学 ${same.id})`); continue; }
    const near = grid.near(p, 0.025)[0];
    if (near) { skipped.existing.push(`${x.name}(${near.n.name} から ${Math.round(near.d * 1000)} m)`); continue; }
    const level = fameLevel(x.sl);
    const node = { id: `lm-${x.qid.toLowerCase()}`, name: x.name, genre: 'university', kind: 'EDU', area: x.region.name, region: x.region.id,
      lat: p.lat, lon: p.lon, level, value: level, tags: [TAG], codes: { wikidata: x.qid }, src: 'src-wikidata' };
    T.nodes.push(node); grid.add(node); added.push(node);
  }
  for (const { T } of files.values()) if (Array.isArray(T.genres) && !T.genres.includes('university')) T.genres.push('university');
  const written = U.writeNodeFiles(files, TODAY);

  const byLv = {}; for (const n of added) byLv[n.level] = (byLv[n.level] || 0) + 1;
  console.log(`Wikidata の大学 ${items.length} 件 → 候補 ${cands.length} 件 → ${added.length} 件を入れた(レベルごと ${JSON.stringify(byLv)})`);
  console.log(`入れなかった: 廃止 ${skipped.dissolved}、候補一覧で × ${skipped.rejected.length}、分類 ${JSON.stringify(skipped.type)}、名前 ${skipped.name.length}、座標を決められない ${skipped.coord.length}、境界の外 ${skipped.noRegion.length}、扱わない地域 ${skipped.outOfBounds.length}、今の拠点と重なる ${skipped.existing.length}`);
  const list = (label, a) => { if (a.length) console.log(`  ${label}: ${a.join(' / ')}`); };
  list('候補一覧で ×', skipped.rejected); list('名前', skipped.name); list('座標', skipped.coord); list('境界の外', skipped.noRegion); list('扱わない地域', skipped.outOfBounds); list('重なり', skipped.existing);
  const perPref = {}; for (const n of added) { const p = U.prefOf(U.regionById.get(n.region)).name; perPref[p] = (perPref[p] || 0) + 1; }
  console.log('  都道府県ごと:', Object.entries(perPref).map(([k, v]) => `${k} ${v}`).join('、'));
  console.log(`書き直したファイル ${written}`);
})().catch((e) => { console.error('失敗:', e.stack || e.message); process.exit(1); });
