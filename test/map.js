'use strict';
// 拠点マスター(JSON)の検証: 形式、重複、座標の範囲、Lv と点数、拠点どうしの距離、リンクの連結
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { NODES, EDGES, ADJ, KINDS, AREAS, SPAWN_CENTER, REGION } = require('../server/map/all');
const { validate } = require('../server/map/load');
const { distanceKm, project, buildLinks } = require('../server/map/geo');

assert.strictEqual(REGION, 'japan', '全部の都道府県ファイルをまとめて読む');
const prefOf = (n) => n.region.split('-')[0];
assert.ok(new Set(NODES.map(prefOf)).size >= 3, '東京・神奈川・千葉が入っている');
assert.ok(NODES.length >= 60, '都内の拠点が少なすぎます');
assert.strictEqual(new Set(NODES.map((n) => n.id)).size, NODES.length, 'id が重複');
assert.strictEqual(new Set(NODES.map((n) => prefOf(n) + '|' + n.name)).size, NODES.length, '名称が重複(同じ都道府県の中)');
// 架空ネットワークは id から決定的に作るので重複してよい(DESIGN.md 第 13 章)。代わりにタイルと国を確認
for (const n of NODES) { assert.strictEqual(n.country, 'japan'); for (let z = 0; z <= 4; z++) assert.match(n['t' + z], new RegExp('^t' + z + ':-?\\d+:-?\\d+$')); assert.match(n.subnet, /^10\.\d+\.\d+\.0\/20$/); assert.strictEqual(n.span, 4094); }
for (const n of NODES) {
  assert.ok(KINDS[n.kind], `${n.name}: kind が不正 ${n.kind}`);
  assert.ok(n.lat > 24 && n.lat < 45.6 && n.lon > 122.9 && n.lon < 146, `${n.name}: 日本の範囲外`);
  assert.ok(Number.isInteger(n.level) && n.level >= 1 && (n.level <= 5 || (n.genre !== 'station' && n.level <= 30)), `${n.name}: 駅は Lv1〜5(象徴的な名所は 30 まで)`);
  assert.ok(Number.isInteger(n.value) && n.value >= 1 && n.value <= 999, `${n.name}: 点数は 1〜999`);
  assert.ok(n.value >= n.level - 1, `${n.name}: Lv に対して点数が低すぎる`);
  if (n.hackable && n.status === 'public') assert.ok(ADJ[n.id].length >= 1, `${n.name}: つながりがない`);
  else assert.strictEqual(ADJ[n.id].length, 0, `${n.name}: ハック不可・非公開の拠点に線がある`);
  assert.strictEqual(n.hits, Math.max(1, n.adj.length), `${n.name}: 突破回数 = つながりの本数`);
  for (const m of n.adj) assert.ok(ADJ[m].includes(n.id), `${n.name}: つながりが片向き`);
  assert.ok(typeof n.area === 'string' && n.area, `${n.name}: area がない`);
  assert.match(n.subnet, /^10\.\d+\.\d+\.0\/20$/);
}
// 同じ場所の二重登録がない(25 m 未満)。隣り合う別の駅や、駅と名所が 100 m ほど離れているのは正常
// 全国(約 9,000 拠点)でも速いよう、約 1 km の格子に分けて近所だけ比べる
const cell = (n) => `${Math.floor(n.lat * 100)}:${Math.floor(n.lon * 100)}`;
const grid = new Map();
for (const n of NODES) { const k = cell(n); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
for (const n of NODES) {
  const cy = Math.floor(n.lat * 100), cx = Math.floor(n.lon * 100);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const m of grid.get(`${cy + dy}:${cx + dx}`) || []) {
    if (m.id <= n.id) continue;
    const d = distanceKm(n, m);
    assert.ok(d >= 0.025, `${n.name} と ${m.name} が同じ場所です (${(d * 1000).toFixed(0)} m)`);
  }
}
// 連結: ハック可能な公開の拠点どうしは、どこからでも全部へ到達できる
const HACKABLE = NODES.filter((n) => n.hackable && n.status === 'public'); // 非公開の拠点(自衛隊・米軍の飛行場)はゲームの地図に入らない
assert.ok(HACKABLE.length >= 100 && HACKABLE.length < NODES.length, 'ハック不可の拠点(寺社)がいくつかある');
const seen = new Set([HACKABLE[0].id]); const stack = [HACKABLE[0].id];
while (stack.length) for (const m of ADJ[stack.pop()]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
assert.strictEqual(seen.size, HACKABLE.length, '地図が分断されています');
for (const e of EDGES) assert.ok(ADJ[e.a] && ADJ[e.b] && e.a !== e.b, 'リンクの端点が不正');
// つながりは路線に沿う(第 14 章): 新宿駅がいちばん多く、末端の駅は 1 本。名所は近い駅をレベルと同じ数だけ
const byName = Object.fromEntries(NODES.filter((n) => n.region.startsWith('tokyo-')).map((n) => [n.name, n])); // 全国に同名の駅があるので東京に限る
const railLinks = (n) => n.adj.filter((id) => id.startsWith('st-')).length; // 名所を除いた路線のつながり
assert.ok(railLinks(byName['新宿駅']) >= 10 && railLinks(byName['新宿駅']) === Math.max(...NODES.filter((n) => n.genre === 'station').map(railLinks)), '路線のつながりは新宿駅が最多(名所が集まる駅は名所の線ぶん本数が増える)');
assert.ok(byName['東京駅'].adj.includes(byName['神田駅'].id) && byName['東京駅'].adj.includes(byName['有楽町駅'].id), '東京駅は山手線の前後とつながる');
assert.strictEqual(railLinks(byName['奥多摩駅']), 1, '終点は路線のつながりが 1 本');
assert.strictEqual(byName['東京タワー'].adj.length, 8, '名所は近い駅をレベルの数だけ(上限 8)');
assert.strictEqual(byName['国会議事堂'].level, 30); assert.strictEqual(byName['東京都庁'].level, 15); assert.strictEqual(byName['国会議事堂'].adj.length, 8, '象徴拠点も 8 本まで');
assert.ok(byName['東京タワー'].adj.every((id) => NODES.find((n) => n.id === id).genre === 'station'), '名所は駅とだけつながる');
// 開始地点の近くに拠点がある
assert.ok(NODES.some((n) => distanceKm(n, SPAWN_CENTER) < SPAWN_CENTER.radiusKm), '開始地点の近くに拠点がない');
assert.ok(AREAS.length >= 20, '区・市が少なすぎます');

// 地域マスター: 階層が正しく、拠点の region がすべて区・市を指し、派生値(中心・拠点数)が付く
const { loadRegions, validateRegions, regionDocs } = require('../server/map/load');
const R = loadRegions();
assert.ok(R.byId.get('universe').kind === 'universe' && R.byId.get('earth').parent === 'universe' && R.byId.get('japan').parent === 'asia' && R.byId.get('tokyo').parent === 'kanto', '宇宙 > 地球 > アジア > 日本 > 関東 > 東京都');
for (const n of NODES) assert.ok(R.isLeaf(n.region), `${n.name}: region が最下層でない`);
assert.deepStrictEqual(R.ancestors('tokyo-chiyoda'), ['tokyo', 'kanto', 'japan', 'asia', 'earth', 'universe']);
assert.strictEqual(R.countryOf('tokyo-chiyoda'), 'japan');
assert.strictEqual(R.tierOf('tokyo'), 5);
const docs = regionDocs(NODES);
const tokyoDoc = docs.find((d) => d.id === 'tokyo');
assert.strictEqual(tokyoDoc.nodeCount, NODES.filter((n) => prefOf(n) === 'tokyo').length, '東京都の拠点数 = 東京のファイルの拠点');
assert.strictEqual(docs.find((d) => d.id === 'kanagawa').state, 'kanagawa'); assert.strictEqual(docs.find((d) => d.id === 'kanagawa-14101').state, 'kanagawa', '区・市は所属する都道府県を持つ');
assert.strictEqual(docs.find((d) => d.id === 'kanagawa-14101').name, '横浜市鶴見区', '政令市の区は市名つき');
assert.ok(docs.filter((d) => d.kind === 'state').length === 47 && docs.filter((d) => d.kind === 'city').length >= 1800, '全国の都道府県と市区町村');
assert.deepStrictEqual(tokyoDoc.path, ['universe', 'earth', 'asia', 'japan', 'kanto', 'tokyo']);
assert.strictEqual(tokyoDoc.code, 'JP-13');
assert.strictEqual(tokyoDoc.country, 'japan');
assert.ok(tokyoDoc.center && Math.abs(tokyoDoc.center.lat - 35.68) < 0.1, '中心は都内');
assert.strictEqual(docs.find((d) => d.id === 'universe').nodeCount, NODES.filter((n) => n.status === 'public').length, '宇宙まで集計が伝わる(非公開の拠点は数えない)');
assert.strictEqual(docs.filter((d) => d.parent === 'tokyo' && d.localKind === '区').length, 23, '東京 23 区');
const rawR = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/map/data/regions.json'), 'utf8'));
const brokenR = (mut) => { const d = JSON.parse(JSON.stringify(rawR)); mut(d); return () => validateRegions(d); };
const idx = (id) => rawR.regions.findIndex((r) => r.id === id);
assert.throws(brokenR((d) => { d.regions[idx('kanto')].parent = 'nowhere'; }), /がありません/);
assert.throws(brokenR((d) => { d.regions[idx('japan')].parent = 'tokyo'; }), /浅い段であるべき/);
assert.throws(brokenR((d) => { d.regions[idx('kanto')].id = 'japan'; }), /重複/);
assert.throws(brokenR((d) => { d.regions[idx('asia')].parent = null; }), /tier 0/);
// 地方のない国は 国 → 州 と段を飛ばせる
assert.doesNotThrow(brokenR((d) => { d.regions.push({ id: 'sg', name: 'シンガポール', kind: 'country', parent: 'asia', status: 'public' }, { id: 'sg-central', name: '中央地域', kind: 'city', parent: 'sg', status: 'public' }); }));
assert.doesNotThrow(brokenR(() => {}));

// 検証器: 壊れたデータを拒む
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/map/data/tokyo.json'), 'utf8'));
const broken = (mut) => { const d = JSON.parse(JSON.stringify(raw)); mut(d); return () => validate('t', d); };
assert.throws(broken((d) => { d.nodes[1].id = d.nodes[0].id; }), /id が重複/);
assert.throws(broken((d) => { d.nodes[0].level = 1000; }), /level は/);
assert.throws(broken((d) => { d.nodes[0].level = 0; }), /level は/);
assert.throws(broken((d) => { d.nodes[0].kind = 'XX'; }), /kind が不正/);
assert.throws(broken((d) => { d.nodes[0].lat = 'a'; }), /緯度・経度/);
assert.throws(broken((d) => { delete d.nodes[0].area; }), /area が必要/);
assert.throws(broken((d) => { d.nodes[0].region = 'tokyo'; }), /最下層/);
assert.throws(broken((d) => { delete d.nodes[0].genre; }), /genre が不正/);
assert.throws(broken((d) => { d.nodes[0].genre = 'shop'; }), /genre が不正/);
assert.throws(broken((d) => { d.nodes[0].name = '銀座四丁目'; }), /丁目/);
// 名前は名所: 全拠点に genre があり、寺社はハック不可
const { GENRES } = require('../server/map/load');
for (const n of NODES) {
  assert.ok(GENRES.has(n.genre), `${n.name}: genre`);
  if (n.genre === 'shrine_temple') assert.strictEqual(n.hackable, false, `${n.name}: 寺社はハック不可`);
}
assert.ok(NODES.filter((n) => n.genre === 'station').length >= 50, '駅が主な拠点');
// 全国の名所(2026-10-19): Wikidata から取り込んだもの(id が lm-)は出どころを持つ。企業名の施設はハック不可。各都道府県に名所がある
const LM = NODES.filter((n) => n.id.startsWith('lm-'));
// 離島の空港・港・島(2026-10-19): Wikidata の id を持ち、ハック可。北方領土・尖閣・立ち入り制限の島には置かない
const ISL = NODES.filter((n) => n.id.startsWith('isl-'));
for (const n of ISL) {
  assert.ok(/^Q[0-9]+$/.test(n.wikidata || '') && n.id === 'isl-' + n.wikidata.toLowerCase(), `${n.name}: Wikidata の id`);
  assert.ok(n.hackable !== false && n.kind === 'GW' && ['airport', 'port', 'nature'].includes(n.genre), `${n.name}: 離島の拠点は玄関口(ハック可)`);
  assert.ok(!/^hokkaido-0169[5-9]$|^hokkaido-01700$/.test(n.region), `${n.name}: 北方領土に置かない`);
  assert.ok(!(n.lat > 25.6 && n.lat < 26.1 && n.lon > 123.3 && n.lon < 124.7), `${n.name}: 尖閣諸島に置かない`);
  assert.ok(n.adj.length >= 1, `${n.name}: 離島の拠点もどこかとつながる`);
}
if (ISL.length) assert.ok(ISL.length >= 50 && ISL.some((n) => n.name === '御蔵島') && ISL.some((n) => n.name === '母島'), '有人の離島に拠点がある');
for (const n of LM) {
  assert.match(n.wikidata || '', /^Q[0-9]+$/, `${n.name}: Wikidata の id`);
  assert.strictEqual(n.id, 'lm-' + n.wikidata.toLowerCase());
}
for (const n of NODES) if (n.company) assert.strictEqual(n.hackable, false, `${n.name}: 企業名の施設はハック不可`);
if (LM.length) {
  const prefsWithLm = new Set(LM.map(prefOf));
  assert.strictEqual(prefsWithLm.size, 47, '47 都道府県すべてに名所がある');
  assert.ok(LM.some((n) => n.level === 15 && n.genre === 'government'), '都道府県の庁舎は象徴(Lv15)');
}
assert.ok(!NODES.some((n) => /DC$|IX$/.test(n.name)), '架空名の DC / IX は使わない');
assert.throws(broken((d) => { d.nodes[0].region = 'tokyo-chuo'; }), /食い違います/);
assert.throws(broken((d) => { d.nodes[0].id = 'Bad_ID'; }), /英小文字/);
// 形式 pc.nodes/1(docs/DATA-FORMAT.md 第 4 章)
assert.throws(broken((d) => { d.nodes.find((n) => n.genre === 'airport').routes = [{ to: 'haneda', mode: 'air' }]; }), /data.routes/, '航路は拠点に書かない(独立した記録)');
assert.throws(broken((d) => { d.schema = 'pc.nodes/0'; }), /schema/);
assert.throws(broken((d) => { d.defaultSource = 'src-nope'; }), /defaultSource/);
assert.throws(broken((d) => { d.nodes[0].src = 'src-nope'; }), /台帳に無い/);
assert.throws(broken((d) => { d.nodes[0].codes = { iata: 'hnd' }; }), /codes[.]iata の形/);
assert.throws(broken((d) => { d.nodes[0].codes = { icao: 'RJT' }; }), /codes[.]icao の形/);
assert.throws(broken((d) => { d.nodes[0].codes = { unlocode: 'JP-TYO' }; }), /codes[.]unlocode の形/);
assert.throws(broken((d) => { d.nodes[0].codes = { iso: 'x' }; }), /決まった名前でない/);
assert.throws(broken((d) => { d.nodes[0].codes = { ext: [{ scheme: 'src-nope', value: 'x' }] }; }), /codes[.]ext/, '協力企業のコードは台帳の出典 id で名前空間を分ける');
assert.throws(broken((d) => { d.nodes[0].wikidata = 'Q1'; }), /codes[.]wikidata/);
assert.throws(broken((d) => { d.nodes.find((n) => n.gateway).gateway = { type: 'airport', scope: 'world' }; }), /gateway は/);
assert.throws(broken((d) => { const n = d.nodes.find((x) => x.hackable === false); n.gateway = { type: 'port', scope: 'domestic' }; }), /玄関口/);
assert.throws(broken((d) => { d.nodes[0].names = { en: 1 }; }), /names は/);
// 公開状態: 非公開には理由が要り、線を持てない
assert.throws(broken((d) => { d.nodes[0].status = 'secret'; }), /status は/);
assert.throws(broken((d) => { d.nodes[0].status = 'hidden'; }), /hiddenReason/);
assert.throws(broken((d) => { d.nodes[0].hiddenReason = 'military'; }), /非公開の拠点だけ/);
assert.throws(broken((d) => { const n = d.nodes.find((x) => x.adj && x.adj.length); n.status = 'hidden'; n.hiddenReason = 'military'; }), /非公開の拠点に adj/);
assert.doesNotThrow(broken((d) => { d.nodes[0].codes = { iata: 'HND', icao: 'RJTT', unlocode: 'JPHND', wikidata: 'Q1', ext: [{ scheme: 'src-internal', value: 'A-1' }] }; d.nodes[0].names = { en: 'Haneda' }; }));
{
  const { loadSources } = require('../server/map/sources');
  const S = loadSources();
  const byIdAll = Object.fromEntries(NODES.map((n) => [n.id, n]));
  // 外部コードは拠点ごとに一意(協力企業のデータを結びつける鍵になる)
  for (const k of ['iata', 'icao', 'unlocode', 'wikidata', 'ksj']) {
    const seen = new Map();
    for (const n of NODES) { const v = n.codes[k]; if (!v) continue; assert.ok(!seen.has(v), `codes.${k} ${v} が ${seen.get(v)} と ${n.id} で重複`); seen.set(v, n.id); }
  }
  assert.strictEqual(NODES.find((n) => n.id === 'haneda').codes.iata, 'HND', '羽田は IATA コードを持つ');
  // 自衛隊・米軍が設置・管理する飛行場(空港法の共用空港 8 か所)は DB に入れるが非公開(2026-10-18 決定。tools/military.js)
  const { isMilitaryAirfield } = require('../tools/military');
  const mil = NODES.filter((n) => isMilitaryAirfield(n));
  assert.strictEqual(mil.length, 8, '自衛隊・米軍の飛行場 8 か所(丘珠・千歳・三沢・百里・小松・美保・徳島・岩国)がマスターにある');
  for (const n of mil) {
    assert.ok(n.status === 'hidden' && n.hiddenReason === 'military', `${n.name}: 非公開`);
    assert.ok(!n.adj.length && !n.routes.length, `${n.name}: 線も航路も無い`);
  }
  for (const n of NODES) if (n.status === 'public') for (const m of n.adj) assert.strictEqual(byIdAll[m].status, 'public', `${n.name}: 非公開の拠点への線`);
  for (const n of NODES) for (const r of n.routes) assert.strictEqual(byIdAll[r.to].status, 'public', `${n.name}: 非公開の拠点への航路`);
  assert.ok(NODES.find((n) => n.name === '那覇空港').status === 'public' && NODES.find((n) => n.name === '名古屋飛行場').status === 'public', '国・自治体が管理する空港(那覇・名古屋)は民間として公開');
  for (const n of NODES) {
    assert.ok(S.usable(n.src).ok, `${n.name}: 出典 ${n.src} はゲームに使える`);
    if (n.genre === 'airport' || n.genre === 'port') if (n.hackable !== false) assert.ok(n.gateway && n.gateway.type === n.genre, `${n.name}: ハック可の空港・港は玄関口(gateway)`);
    if (/^st-[0-9]+$/.test(n.id)) assert.strictEqual(n.codes.ksj, n.id.slice(3), `${n.name}: 駅は国土数値情報のコードを持つ`);
  }
}
assert.throws(broken((d) => { d.nodes.find((n) => n.adj && n.adj.length).adj.push('ST NOPE'); }), /不正/, 'adj の id の形を検査(別ファイルの拠点への線は許す)');
assert.throws(broken((d) => { const n = d.nodes.find((x) => x.hackable === false); n.adj = ['st-003766']; }), /ハック不可の拠点に adj/);
assert.doesNotThrow(broken(() => {}));

// geo.js 単体: 距離と投影の基本性質
assert.ok(Math.abs(distanceKm({ lat: 35.6812, lon: 139.7671 }, { lat: 34.7025, lon: 135.4959 }) - 403) < 5, '東京-大阪 約403km');
const p = project([{ id: 'a', lat: 35, lon: 139 }, { id: 'b', lat: 36, lon: 140 }], { width: 100, height: 100, margin: 10 });
assert.ok(p[0].y > p[1].y && p[0].x < p[1].x, '北が上、東が右');
const two = buildLinks([{ id: 'a', lat: 35, lon: 139 }, { id: 'b', lat: 36, lon: 140 }, { id: 'c', lat: 0, lon: 0 }], 1);
assert.ok(two.some((e) => e.a === 'c' || e.b === 'c'), '離れた拠点も橋でつながる');

const byLevel = [1, 2, 3, 4, 5].map((l) => `Lv${l}:${NODES.filter((n) => n.level === l).length}`).join(' ');
console.log(`map ok: ${NODES.length} nodes in ${new Set(NODES.map(prefOf)).size} prefs, ${EDGES.length} links, ${AREAS.length} areas, ${docs.length} regions (${byLevel})`);
