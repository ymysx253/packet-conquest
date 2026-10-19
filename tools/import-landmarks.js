'use strict';
// 名所の候補一覧(docs/landmarks/candidates.csv)から、取り込むものを都道府県の拠点マスターに入れる(2026-10-19 決定)。
//
// 使い方:
//   node tools/import-landmarks.js            # 一覧の「取り込み」と「採否(確認用)」に従って入れる
// 何度実行しても同じ結果になる(前回この道具で入れた名所 id が lm- で始まるものを入れ直す。手で入れた東京の名所 64 件はそのまま)。
// 取り込んだら tools/import-links.js でつながりを作り直し、node tools/db-setup.js --force で DB に反映する。
//
// 決まり(2026-10-19):
//   - 採否が × なら入れない。○ なら入れる。空欄なら「取り込み」の印(○ = ハック可 / ○(ハック不可))に従う
//   - 寺社・テーマパーク・命名権など企業名の施設はハック不可(線をつなげない)。企業名は company に入れて画面に出す
//   - 基礎レベルは知名度(言語版の数)で Lv15〜70。各都道府県の庁舎は Lv400、代表的な城(知名度 1 位)は Lv300、主要空港(同)は Lv250(2026-10-19 に新しい物差しへ。tools/levels.js)
//   - 候補一覧(candidates.csv)に無い都道府県庁舎は extra.csv(tools/fetch-pref-offices.js が書く)から足す
//   - 既存の拠点から 25 m 以内のものは同じ場所の二重登録になるので入れない(一覧に出す)
//   - 同じ都道府県に同じ名前があれば「(市区町村名)」を付ける
//   - 自衛隊・米軍が設置・管理する飛行場(三沢・徳島など。tools/military.js)は非公開(status: hidden)で入れる。DB には残すがゲームでは使わない(2026-10-18 決定)
const fs = require('fs');
const path = require('path');
const { gatewayLevel, HUB_AIRPORTS } = require('./gateway');
const { isMilitaryAirfield } = require('./military');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const CSV = path.join(ROOT, 'docs/landmarks/candidates.csv');
const TODAY = '2026-10-19';

// ---------- 一覧を読む(引用符つきの CSV) ----------
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
// 足りない都道府県庁舎(docs/landmarks/extra.csv。同じ列)。候補一覧と同じ Wikidata の項目があれば候補一覧の方を使う
const EXTRA = path.join(ROOT, 'docs/landmarks/extra.csv');
if (fs.existsSync(EXTRA)) {
  const ex = parseCsv(fs.readFileSync(EXTRA, 'utf8').replace(/^﻿/, '')); ex.shift();
    const qi = head.indexOf('Wikidata'), di = head.indexOf('採否(確認用)');
  for (const r of ex) {
    if (r.length <= 1) continue;
    const same = rows.find((x) => x[qi] === r[qi]);
    if (same) same[di] = '○'; else rows.push(r); // 候補一覧にあれば、その行を取り込む印に
  }
}
const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`一覧に列「${name}」がありません`); return i; };
const C = { pref: col('都道府県'), area: col('市区町村'), name: col('名前'), genre: col('genre'), sub: col('細分'), take: col('取り込み'), dup: col('既存と重複'), company: col('企業(命名権など)'), sl: col('知名度(言語版の数)'), qid: col('Wikidata'), lat: col('緯度'), lon: col('経度'), decide: col('採否(確認用)') };

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

// 前回この道具で入れた名所(lm-)は外して入れ直す。近さの判定に使う既存の拠点は lm- 以外
const grid = new Map();
const cell = (p) => `${Math.floor(p.lat * 200)}:${Math.floor(p.lon * 200)}`;
for (const { T } of files.values()) {
  T.nodes = T.nodes.filter((n) => !n.id.startsWith('lm-'));
  for (const n of T.nodes) { if (n.id.startsWith('ts-')) continue; const k = cell(n); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); } // 観光地(ts-、tools/import-tourism.js)は名所の後に入れるので比べない
}
const nearExisting = (p) => {
  const cy = Math.floor(p.lat * 200), cx = Math.floor(p.lon * 200);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of grid.get(`${cy + dy}:${cx + dx}`) || []) if (distKm(n, p) < 0.025) return n;
  return null;
};

// ---------- 選ぶ ----------
const KIND = { airport: 'GW', port: 'GW', bus_terminal: 'HUB', government: 'GOV', university: 'EDU', observatory: 'EDU', library: 'EDU' };
const { L, fameLevel } = require('./levels');
const levelOf = fameLevel; // 知名度 → Lv15〜70(2026-10-19 に新しい物差しへ。tools/levels.js)
const picked = [];
const skipped = { decided: 0, notTaken: 0, dup: 0, noRegion: 0, military: [], near: [] };
for (const r of rows) {
  if (!r[C.name]) continue;
  const decide = (r[C.decide] || '').trim();
  if (decide === '×' || decide === 'x' || decide === 'X') { skipped.decided++; continue; }
  const take = r[C.take];
  if (!take && decide !== '○') { skipped.notTaken++; continue; }
  if (r[C.dup]) { skipped.dup++; continue; }
  const pref = prefByName.get(r[C.pref]);
  const city = pref && cityOf.get(`${pref.id}|${r[C.area]}`);
  if (!pref || !city || !files.has(pref.id)) { skipped.noRegion++; continue; }
  const genre = r[C.genre];
  const nonHack = genre === 'shrine_temple' || !!r[C.company] || take === '○(ハック不可)';
  const p = { lat: Number(r[C.lat]), lon: Number(r[C.lon]) };
  const near = nearExisting(p);
  if (near) { skipped.near.push(`${r[C.name]}(${near.name} から ${Math.round(distKm(near, p) * 1000)} m)`); continue; }
  // 新しく入れる名所どうしも比べる(一覧は都道府県ごとに知名度の高い順なので、先に入れた方 = 知名度の高い方が残る)
  { const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ name: r[C.name], lat: p.lat, lon: p.lon }); }
  const military = isMilitaryAirfield({ name: r[C.name], qid: r[C.qid] });
  if (military) skipped.military.push(r[C.name]);
  picked.push({ qid: r[C.qid], name: r[C.name], genre, sub: r[C.sub], company: r[C.company] || null, sl: Number(r[C.sl]) || 0, pref, city, lat: p.lat, lon: p.lon, hackable: !nonHack, hidden: military ? 'military' : null });
}

// 象徴的な拠点: 各都道府県の庁舎 15、知名度 1 位の城 10、知名度 1 位の空港 8(ハック可のものだけ)
const top = (list, f) => list.filter(f).sort((a, b) => b.sl - a.sl)[0];
const byPref = new Map();
for (const c of picked) { if (!byPref.has(c.pref.id)) byPref.set(c.pref.id, []); byPref.get(c.pref.id).push(c); }
for (const list of byPref.values()) {
  for (const c of list) c.level = levelOf(c.sl);
  for (const c of list.filter((x) => x.hackable && x.genre === 'government' && x.sub === '都道府県庁舎')) c.level = L.PREF_OFFICE;
  const castle = top(list, (x) => x.hackable && x.genre === 'heritage' && x.sub === '城'); if (castle) castle.level = Math.max(castle.level, L.PREF_TOP_CASTLE);
  const airport = top(list, (x) => x.hackable && !x.hidden && x.genre === 'airport'); if (airport) airport.level = Math.max(airport.level, L.PREF_TOP_AIRPORT);
  // 空港・港(玄関口)は最低レベルを上げる(空港 5・国際線の拠点 10、港 3。tools/gateway.js)
  for (const c of list) if (c.hackable) c.level = gatewayLevel(c.genre, c.name, c.level);
}

// ---------- 書き込む ----------
let added = 0; const renamed = [];
for (const c of picked) {
  const { T } = files.get(c.pref.id);
  const names = new Set(T.nodes.filter((n) => n.genre === c.genre).map((n) => n.name)); // 同じジャンルの中だけ
  let name = c.name;
  if (names.has(name)) { name = `${c.name}(${c.city.name})`; renamed.push(name); }
  if (names.has(name)) { name = `${c.name}(${c.qid})`; }
  const node = {
    id: `lm-${c.qid.toLowerCase()}`, name, genre: c.genre, kind: KIND[c.genre] || 'LM', area: c.city.name, region: c.city.id,
    lat: Number(c.lat.toFixed(5)), lon: Number(c.lon.toFixed(5)), level: c.level, value: c.level,
  };
  if (!c.hackable) node.hackable = false;
  if (c.hidden) { node.status = 'hidden'; node.hiddenReason = c.hidden; }
  if (c.company) node.company = c.company;
  node.codes = { wikidata: c.qid }; // 形式は docs/DATA-FORMAT.md 第 4 章(空港・港の IATA などは tools/fetch-codes.js が足す)
  node.src = 'src-wikidata';
  if (c.hackable && (c.genre === 'airport' || c.genre === 'port')) {
    const hub = c.genre === 'airport' && HUB_AIRPORTS.has(name);
    node.gateway = { type: c.genre, scope: hub ? 'international' : 'domestic', ...(hub ? { hub: true } : {}) };
  }
  T.nodes.push(node);
  added++;
}

// 地域の並び → 名所は駅の前、で並べて書き出す
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
const nonHack = picked.filter((c) => !c.hackable).length;
console.log(`名所 ${added} 件を入れた(ハック可 ${added - nonHack}、ハック不可 ${nonHack})。象徴: 庁舎 Lv400 / 城 Lv300 / 空港 Lv250`);
console.log(`非公開で入れた自衛隊・米軍の飛行場: ${skipped.military.length}(${skipped.military.join('、')})`);
console.log(`入れなかった: 採否 × ${skipped.decided}、取り込みの印なし ${skipped.notTaken}、既存と重複 ${skipped.dup}、地域が引けない ${skipped.noRegion}、既存の拠点から 25 m 以内 ${skipped.near.length}`);
if (skipped.near.length) console.log('  25 m 以内:', skipped.near.slice(0, 20).join(' / ') + (skipped.near.length > 20 ? ' …' : ''));
if (renamed.length) console.log(`同じ県に同じ名前があり市区町村名を付けた: ${renamed.length} 件(例: ${renamed.slice(0, 5).join('、')})`);
