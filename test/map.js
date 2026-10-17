'use strict';
// 拠点マスター(JSON)の検証: 形式、重複、座標の範囲、Lv と点数、拠点どうしの距離、リンクの連結
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { NODES, EDGES, ADJ, KINDS, AREAS, SPAWN_CENTER, REGION } = require('../server/map/tokyo');
const { validate } = require('../server/map/load');
const { distanceKm, project, buildLinks } = require('../server/map/geo');

assert.strictEqual(REGION, 'tokyo');
assert.ok(NODES.length >= 60, '都内の拠点が少なすぎます');
assert.strictEqual(new Set(NODES.map((n) => n.id)).size, NODES.length, 'id が重複');
assert.strictEqual(new Set(NODES.map((n) => n.name)).size, NODES.length, '名称が重複');
// 架空ネットワークは id から決定的に作るので重複してよい(DESIGN.md 第 13 章)。代わりにタイルと国を確認
for (const n of NODES) { assert.strictEqual(n.country, 'japan'); for (let z = 0; z <= 4; z++) assert.match(n['t' + z], new RegExp('^t' + z + ':-?\\d+:-?\\d+$')); assert.match(n.subnet, /^10\.\d+\.\d+\.0\/20$/); assert.strictEqual(n.span, 4094); }
for (const n of NODES) {
  assert.ok(KINDS[n.kind], `${n.name}: kind が不正 ${n.kind}`);
  assert.ok(n.lat > 35.4 && n.lat < 35.9 && n.lon > 139.0 && n.lon < 140.0, `${n.name}: 東京の範囲外`);
  assert.ok(Number.isInteger(n.level) && n.level >= 1 && n.level <= 5, `${n.name}: 東京の拠点は Lv1〜5`);
  assert.ok(Number.isInteger(n.value) && n.value >= 1 && n.value <= 999, `${n.name}: 点数は 1〜999`);
  assert.ok(n.value >= n.level - 1, `${n.name}: Lv に対して点数が低すぎる`);
  if (n.hackable) assert.ok(ADJ[n.id].length >= 2, `${n.name}: リンクが2本未満`);
  else assert.strictEqual(ADJ[n.id].length, 0, `${n.name}: ハック不可の拠点に線がある`);
  assert.ok(typeof n.area === 'string' && n.area, `${n.name}: area がない`);
  assert.match(n.subnet, /^10\.\d+\.\d+\.0\/20$/);
}
// 同じ場所の二重登録がない(25 m 未満)。隣り合う別の駅や、駅と名所が 100 m ほど離れているのは正常
for (let i = 0; i < NODES.length; i++) for (let j = i + 1; j < NODES.length; j++) {
  const d = distanceKm(NODES[i], NODES[j]);
  assert.ok(d >= 0.025, `${NODES[i].name} と ${NODES[j].name} が同じ場所です (${(d * 1000).toFixed(0)} m)`);
}
// 連結: ハック可能な拠点どうしは、どこからでも全部へ到達できる
const HACKABLE = NODES.filter((n) => n.hackable);
assert.ok(HACKABLE.length >= 100 && HACKABLE.length < NODES.length, 'ハック不可の拠点(寺社)がいくつかある');
const seen = new Set([HACKABLE[0].id]); const stack = [HACKABLE[0].id];
while (stack.length) for (const m of ADJ[stack.pop()]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
assert.strictEqual(seen.size, HACKABLE.length, '地図が分断されています');
for (const e of EDGES) assert.ok(ADJ[e.a] && ADJ[e.b] && e.a !== e.b, 'リンクの端点が不正');
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
assert.strictEqual(tokyoDoc.nodeCount, NODES.length, '東京都の拠点数 = 全拠点');
assert.deepStrictEqual(tokyoDoc.path, ['universe', 'earth', 'asia', 'japan', 'kanto', 'tokyo']);
assert.strictEqual(tokyoDoc.code, 'JP-13');
assert.strictEqual(tokyoDoc.country, 'japan');
assert.ok(tokyoDoc.center && Math.abs(tokyoDoc.center.lat - 35.68) < 0.1, '中心は都内');
assert.strictEqual(docs.find((d) => d.id === 'universe').nodeCount, NODES.length, '宇宙まで集計が伝わる');
assert.strictEqual(docs.filter((d) => d.localKind === '区').length, 23, '23 区');
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
assert.ok(!NODES.some((n) => /DC$|IX$/.test(n.name)), '架空名の DC / IX は使わない');
assert.throws(broken((d) => { d.nodes[0].region = 'tokyo-chuo'; }), /食い違います/);
assert.throws(broken((d) => { d.nodes[0].id = 'Bad_ID'; }), /英小文字/);
assert.doesNotThrow(broken(() => {}));

// geo.js 単体: 距離と投影の基本性質
assert.ok(Math.abs(distanceKm({ lat: 35.6812, lon: 139.7671 }, { lat: 34.7025, lon: 135.4959 }) - 403) < 5, '東京-大阪 約403km');
const p = project([{ id: 'a', lat: 35, lon: 139 }, { id: 'b', lat: 36, lon: 140 }], { width: 100, height: 100, margin: 10 });
assert.ok(p[0].y > p[1].y && p[0].x < p[1].x, '北が上、東が右');
const two = buildLinks([{ id: 'a', lat: 35, lon: 139 }, { id: 'b', lat: 36, lon: 140 }, { id: 'c', lat: 0, lon: 0 }], 1);
assert.ok(two.some((e) => e.a === 'c' || e.b === 'c'), '離れた拠点も橋でつながる');

const byLevel = [1, 2, 3, 4, 5].map((l) => `Lv${l}:${NODES.filter((n) => n.level === l).length}`).join(' ');
console.log(`map ok: ${NODES.length} nodes, ${EDGES.length} links, ${AREAS.length} areas (${byLevel})`);
