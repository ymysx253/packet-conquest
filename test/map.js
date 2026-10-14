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
assert.strictEqual(new Set(NODES.map((n) => n.subnet)).size, NODES.length, 'サブネットが重複');
for (const n of NODES) {
  assert.ok(KINDS[n.kind], `${n.name}: kind が不正 ${n.kind}`);
  assert.ok(n.lat > 35.4 && n.lat < 35.9 && n.lon > 139.2 && n.lon < 140.0, `${n.name}: 東京の範囲外`);
  assert.ok(Number.isInteger(n.level) && n.level >= 1 && n.level <= 5, `${n.name}: 東京の拠点は Lv1〜5`);
  assert.ok(Number.isInteger(n.value) && n.value >= 1 && n.value <= 999, `${n.name}: 点数は 1〜999`);
  assert.ok(n.value >= n.level - 1, `${n.name}: Lv に対して点数が低すぎる`);
  assert.ok(ADJ[n.id].length >= 2, `${n.name}: リンクが2本未満`);
  assert.ok(typeof n.area === 'string' && n.area, `${n.name}: area がない`);
  assert.match(n.subnet, /^10\.\d+\.0\.0\/16$/);
}
// 拠点どうしが近すぎない(画面で重なる・同じ場所を二重登録)
for (let i = 0; i < NODES.length; i++) for (let j = i + 1; j < NODES.length; j++) {
  const d = distanceKm(NODES[i], NODES[j]);
  assert.ok(d >= 0.15, `${NODES[i].name} と ${NODES[j].name} が近すぎます (${d.toFixed(2)} km)`);
}
// 連結: どの拠点からも全拠点へ到達できる
const seen = new Set([NODES[0].id]); const stack = [NODES[0].id];
while (stack.length) for (const m of ADJ[stack.pop()]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
assert.strictEqual(seen.size, NODES.length, '地図が分断されています');
for (const e of EDGES) assert.ok(ADJ[e.a] && ADJ[e.b] && e.a !== e.b, 'リンクの端点が不正');
// 開始地点の近くに拠点がある
assert.ok(NODES.some((n) => distanceKm(n, SPAWN_CENTER) < SPAWN_CENTER.radiusKm), '開始地点の近くに拠点がない');
assert.ok(AREAS.length >= 20, '区・市が少なすぎます');

// 検証器: 壊れたデータを拒む
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/map/data/tokyo.json'), 'utf8'));
const broken = (mut) => { const d = JSON.parse(JSON.stringify(raw)); mut(d); return () => validate('t', d); };
assert.throws(broken((d) => { d.nodes[1].id = d.nodes[0].id; }), /id が重複/);
assert.throws(broken((d) => { d.nodes[0].level = 1000; }), /level は/);
assert.throws(broken((d) => { d.nodes[0].level = 0; }), /level は/);
assert.throws(broken((d) => { d.nodes[0].kind = 'XX'; }), /kind が不正/);
assert.throws(broken((d) => { d.nodes[0].lat = 'a'; }), /緯度・経度/);
assert.throws(broken((d) => { delete d.nodes[0].area; }), /area が必要/);
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
