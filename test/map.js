'use strict';
// 拠点マスターの検証: 重複、座標の範囲、Lv と点数、リンクの連結、描画座標が画面内に収まること
const assert = require('assert');
const { NODES, EDGES, ADJ, WIDTH, HEIGHT, KINDS } = require('../server/map/tokyo');
const { distanceKm, project, buildLinks } = require('../server/map/geo');

assert.ok(NODES.length >= 20, '拠点が少なすぎます');
assert.strictEqual(new Set(NODES.map((n) => n.id)).size, NODES.length, 'id が重複');
assert.strictEqual(new Set(NODES.map((n) => n.name)).size, NODES.length, '名称が重複');
assert.strictEqual(new Set(NODES.map((n) => n.subnet)).size, NODES.length, 'サブネットが重複');
for (const n of NODES) {
  assert.ok(KINDS[n.kind], `${n.name}: kind が不正 ${n.kind}`);
  assert.ok(n.lat > 35.4 && n.lat < 35.9 && n.lon > 139.4 && n.lon < 140.0, `${n.name}: 東京周辺の範囲外`);
  assert.ok([1, 2, 3].includes(n.level), `${n.name}: Lv は 1〜3`);
  assert.ok(Number.isInteger(n.value) && n.value >= 1 && n.value <= 5, `${n.name}: 点数は 1〜5`);
  assert.ok(n.x >= 0 && n.x <= WIDTH && n.y >= 0 && n.y <= HEIGHT, `${n.name}: 画面外 (${n.x}, ${n.y})`);
  assert.ok(ADJ[n.id].length >= 2, `${n.name}: リンクが2本未満`);
  assert.match(n.subnet, /^10\.\d+\.0\.0\/16$/);
}
// 連結: どの拠点からも全拠点へ到達できる
const seen = new Set([NODES[0].id]); const stack = [NODES[0].id];
while (stack.length) for (const m of ADJ[stack.pop()]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
assert.strictEqual(seen.size, NODES.length, '地図が分断されています');
for (const e of EDGES) assert.ok(ADJ[e.a] && ADJ[e.b] && e.a !== e.b, 'リンクの端点が不正');

// geo.js 単体: 距離と投影の基本性質
assert.ok(Math.abs(distanceKm({ lat: 35.6812, lon: 139.7671 }, { lat: 34.7025, lon: 135.4959 }) - 403) < 5, '東京-大阪 約403km');
const p = project([{ id: 'a', lat: 35, lon: 139 }, { id: 'b', lat: 36, lon: 140 }], { width: 100, height: 100, margin: 10 });
assert.ok(p[0].y > p[1].y && p[0].x < p[1].x, '北が上、東が右');
const two = buildLinks([{ id: 'a', lat: 35, lon: 139 }, { id: 'b', lat: 36, lon: 140 }, { id: 'c', lat: 0, lon: 0 }], 1);
assert.ok(two.some((e) => e.a === 'c' || e.b === 'c'), '離れた拠点も橋でつながる');

console.log(`map ok: ${NODES.length} nodes, ${EDGES.length} links`);
