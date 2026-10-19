'use strict';
// 観光地(ジャンル tourism)を都道府県の拠点マスターに入れる(2026-10-19 ユーザー決定。docs/tourism/README.md、docs/GENRE.md)。
// 候補の一覧 docs/tourism/candidates.csv は tools/collect-tourism.js が Wikidata(CC0)から作る。
//
// 使い方:
//   node tools/import-tourism.js
// 何度実行しても同じ結果になる(前回この道具で入れた観光地 id が ts- で始まるものを入れ直す)。
// 順番: import-stations → import-landmarks → import-islands → import-gateways → **import-tourism** → import-towns → import-water → fetch-codes → import-links → import-routes
// (町・字の「中にある拠点」(contains)に観光地を入れるため、import-towns より前に動かす)
//
// 決まり(2026-10-19):
//   - 入れる種類: 温泉・景勝地・展望・滝・岬・海岸・峠・町並み(伝建地区)の「推奨」(既存の拠点と重ならず、知名度 3 以上か指定・百選があるもの)
//   - 入れない種類: スキー場・キャンプ場(企業の運営)、灯台(海の安全の施設)、道の駅(知名度の低いものが多い)
//   - 基礎レベル: 世界遺産・日本三景・特別名勝 Lv300 / 各都道府県で知名度 1 位(上を除く)Lv150 / 指定・百選あり Lv30〜70(知名度で) / ほか Lv15〜25
//   - 種類の分け方がおかしいもの、PLACES.md の避けるジャンル(慰霊の場、墓地、重要インフラ、企業の施設)に当たるものは入れない(下の EXCLUDE)
//   - 寺の庭園は寺社と同じくハック不可(下の TEMPLE)
//   - 既存の拠点から 25 m 以内のものは同じ場所の二重登録になるので入れない
//   - 名前の後ろの「 (北海道)」のような区別の括弧は外す。同じ県・同じジャンルに同じ名前があれば「(市区町村名)」を付ける
const fs = require('fs');
const path = require('path');
const { L, fameLevel } = require('./levels');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const CSV = path.join(ROOT, 'docs/tourism/candidates.csv');
const TODAY = '2026-10-19';

// 種類 → 情報パネルに出す細分(tags の先頭)
const KINDS = { 温泉: '温泉', '景勝地・展望': '景勝地', 滝: '滝', '岬・海岸': '岬・海岸', 峠: '峠', '町並み(伝建地区)': '町並み' };
// 入れないもの(名前): 慰霊の場・墓地(PLACES.md 第 3 章)、重要インフラ、企業の施設、種類の分け方が違うもの(博物館・大学の植物園)
const EXCLUDE = new Map([
  ['平和記念公園', '慰霊の場'], ['神戸市立外国人墓地', '墓地'], ['末浄水場', '重要インフラ'],
  ['SHIBUYA SKY', '企業の施設'], ['ラクーア', '企業の施設'],
  ['東京大学大学院理学系研究科附属植物園', '大学の植物園(観光地ではない)'], ['横山大観記念館', '記念館(博物館)'], ['朝倉彫塑館', '博物館'],
]);
// 寺の庭園・塔頭(寺社と同じくハック不可。線をつながない)
const TEMPLE = /寺.*庭園$|寺雪舟庭$|^天徳院庭園$|^孤篷庵$|^真珠庵$/;
// 国を代表する観光地(Lv300)の指定
const NATIONAL = /世界遺産|日本三景|特別名勝/;

// ---------- 一覧を読む ----------
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
const rows = parseCsv(fs.readFileSync(CSV, 'utf8').replace(/^﻿/, ''));
const head = rows.shift();
const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`一覧に列「${name}」がありません`); return i; };
const C = { pref: col('都道府県'), area: col('市区町村'), name: col('名前'), kind: col('種類'), des: col('指定・百選'), sl: col('知名度(言語版の数)'), qid: col('Wikidata'), lat: col('緯度'), lon: col('経度'), dup: col('既存の拠点と重複'), rec: col('推奨'), decide: col('採否(確認用)') };

// ---------- 地域と既存の拠点 ----------
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const prefByName = new Map(R.regions.filter((r) => r.kind === 'state').map((r) => [r.name, r]));
const cityOf = new Map(R.regions.filter((r) => r.kind === 'city').map((r) => [`${r.parent}|${r.name}`, r]));
const files = new Map(); // pref id → { file, T }
for (const r of R.regions.filter((x) => x.nodeFile)) {
  const file = path.join(DATA, `${r.nodeFile}.json`);
  files.set(r.id, { file, T: JSON.parse(fs.readFileSync(file, 'utf8')) });
}
const distKm = (a, b) => { const toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

// 前回入れた観光地(ts-)は外して入れ直す。近さの判定に使うのは町・字以外の既存の拠点(町・字は代表点なので比べない)
const grid = new Map();
const cell = (p) => `${Math.floor(p.lat * 200)}:${Math.floor(p.lon * 200)}`;
for (const { T } of files.values()) {
  T.nodes = T.nodes.filter((n) => !n.id.startsWith('ts-'));
  for (const n of T.nodes) { if (n.genre === 'town') continue; const k = cell(n); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
}
const nearExisting = (p) => {
  const cy = Math.floor(p.lat * 200), cx = Math.floor(p.lon * 200);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of grid.get(`${cy + dy}:${cx + dx}`) || []) if (distKm(n, p) < 0.025) return n;
  return null;
};
// 「毛無峠 (長野県・群馬県)」「川湯温泉 (北海道)」のような区別の括弧は外す(地名で区別しているものだけ)。ほかは全角の括弧にする
const cleanName = (s) => {
  const m = s.match(/^(.*?)\s*\((.+)\)$/);
  if (!m) return s.trim();
  return /[都道府県市町村]/.test(m[2]) ? m[1].trim() : `${m[1].trim()}(${m[2]})`;
};

// ---------- 選ぶ ----------
const picked = [];
const skipped = { notRec: 0, kind: 0, excluded: [], decided: 0, noRegion: [], near: [] };
for (const r of rows) {
  if (!r[C.name]) continue;
  const decide = (r[C.decide] || '').trim();
  if (decide === '×' || decide === 'x' || decide === 'X') { skipped.decided++; continue; }
  if (!r[C.rec] && decide !== '○') { skipped.notRec++; continue; }
  if (r[C.dup]) { skipped.notRec++; continue; }
  const kind = KINDS[r[C.kind]];
  if (!kind) { skipped.kind++; continue; }
  if (EXCLUDE.has(r[C.name])) { skipped.excluded.push(`${r[C.name]}(${EXCLUDE.get(r[C.name])})`); continue; }
  const pref = prefByName.get(r[C.pref]);
  const city = pref && cityOf.get(`${pref.id}|${r[C.area]}`);
  if (!pref || !city || !files.has(pref.id)) { skipped.noRegion.push(`${r[C.name]}(${r[C.pref]} ${r[C.area]})`); continue; }
  const p = { lat: Number(r[C.lat]), lon: Number(r[C.lon]) };
  const near = nearExisting(p);
  if (near) { skipped.near.push(`${r[C.name]}(${near.name} から ${Math.round(distKm(near, p) * 1000)} m)`); continue; }
  { const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ name: r[C.name], lat: p.lat, lon: p.lon }); }
  const des = (r[C.des] || '').split('/').map((x) => x.trim()).filter(Boolean);
  picked.push({ qid: r[C.qid], name: cleanName(r[C.name]), raw: r[C.name], kind, des, sl: Number(r[C.sl]) || 0, pref, city, lat: p.lat, lon: p.lon, hackable: !TEMPLE.test(r[C.name]) });
}

// レベル: 国を代表する 300 → 各都道府県で一番 150 → 指定・百選あり 30〜70 → ほか 15〜25
const byPref = new Map();
for (const c of picked) {
  const national = c.des.some((d) => NATIONAL.test(d));
  c.tier = national ? 'national' : c.des.length ? 'designated' : 'plain';
  c.level = national ? L.TOURISM_NATIONAL : c.des.length ? Math.max(L.TOURISM_DESIGNATED_MIN, fameLevel(c.sl)) : Math.min(L.TOURISM_PLAIN_MAX, fameLevel(c.sl));
  if (!byPref.has(c.pref.id)) byPref.set(c.pref.id, []);
  byPref.get(c.pref.id).push(c);
}
for (const list of byPref.values()) {
  // 知名度 1 位(同じなら指定・百選のあるもの)。ハック可で、国を代表する観光地を除く
  const top = list.filter((c) => c.hackable && c.tier !== 'national').sort((a, b) => b.sl - a.sl || b.des.length - a.des.length)[0];
  if (top) { top.tier = 'prefTop'; top.level = L.TOURISM_PREF_TOP; }
}

// ---------- 書き込む ----------
let added = 0; const renamed = [];
for (const c of picked) {
  const { T } = files.get(c.pref.id);
  const names = new Set(T.nodes.filter((n) => n.genre === 'tourism').map((n) => n.name)); // 同じジャンルの中だけ
  let name = c.name;
  if (names.has(name)) { name = `${c.name}(${c.city.name})`; renamed.push(name); }
  if (names.has(name)) name = `${c.name}(${c.qid})`;
  const node = {
    id: `ts-${c.qid.toLowerCase()}`, name, genre: 'tourism', kind: 'LM', area: c.city.name, region: c.city.id,
    lat: Number(c.lat.toFixed(5)), lon: Number(c.lon.toFixed(5)), level: c.level, value: c.level,
    tags: [c.kind, ...c.des], // 先頭が細分(温泉・滝 …)、続けて指定・百選
  };
  if (!c.hackable) node.hackable = false;
  node.codes = { wikidata: c.qid };
  node.src = 'src-wikidata';
  T.nodes.push(node);
  if (Array.isArray(T.genres) && !T.genres.includes('tourism')) T.genres.push('tourism');
  added++;
}

// 地域の並び → 駅は後ろ、で並べて書き出す(tools/import-landmarks.js と同じ形)
const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(headObj, key, items, groupKey) {
  let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`);
  let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}
for (const { file, T } of files.values()) {
  T.nodes = T.nodes.map((n, i) => ({ n, i })).sort((a, b) => (order[a.n.region] - order[b.n.region]) || ((a.n.genre === 'station') - (b.n.genre === 'station')) || (a.i - b.i)).map((x) => x.n);
  T.version = (T.version || 0) + 1;
  T.updatedAt = TODAY;
  const { nodes, ...headObj } = T;
  fs.writeFileSync(file, writeList(headObj, 'nodes', nodes, 'area'));
}
const count = (f) => picked.filter(f).length;
console.log(`観光地 ${added} 件を入れた(ハック不可 ${count((c) => !c.hackable)})`);
console.log(`  Lv300 国を代表する ${count((c) => c.tier === 'national')} / Lv150 各都道府県で一番 ${count((c) => c.tier === 'prefTop')} / 指定・百選あり ${count((c) => c.tier === 'designated')} / ほか ${count((c) => c.tier === 'plain')}`);
const byKind = {}; for (const c of picked) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
console.log('  種類ごと:', Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('、'));
console.log(`入れなかった: 推奨でない・既存と重複 ${skipped.notRec}、種類が対象外 ${skipped.kind}、採否 × ${skipped.decided}、除外 ${skipped.excluded.length}、地域が引けない ${skipped.noRegion.length}、既存の拠点から 25 m 以内 ${skipped.near.length}`);
if (skipped.excluded.length) console.log('  除外:', skipped.excluded.join(' / '));
if (skipped.noRegion.length) console.log('  地域が引けない:', skipped.noRegion.join(' / '));
if (skipped.near.length) console.log('  25 m 以内:', skipped.near.join(' / '));
if (renamed.length) console.log(`同じ県に同じ名前があり市区町村名を付けた: ${renamed.join('、')}`);
