'use strict';
// 拠点の形(1〜100。public/shapes100.js)の検証: 100 のレベルがすべて違う模様、大きさが育ちすぎない
const assert = require('assert');
const S = require('../public/shapes100');

assert.strictEqual(S.MAX_LEVEL, 100);
const seen = new Map();
for (let lv = 1; lv <= 100; lv++) {
  const d = S.describe(lv);
  const key = `${d.shape}|${d.deco}`;
  assert.ok(!seen.has(key), `Lv${lv} と Lv${seen.get(key)} の模様が重複`);
  seen.set(key, lv);
  assert.ok(S.SHAPES[d.shape] && S.DECO_NAMES[d.deco], `Lv${lv}: 形か飾りが不正`);
  assert.ok(S.outerRadius(lv, 10) <= 16.5, `Lv${lv}: 飾りを含めて本体の 1.65 倍まで(${S.outerRadius(lv, 10)})`);
}
assert.strictEqual(seen.size, 100);
assert.ok(S.sizeScale(1) === 1 && Math.abs(S.sizeScale(100) - 1.2) < 1e-9, 'レベル 100 でも 1.2 倍');
assert.strictEqual(S.describe(0).level, 1); assert.strictEqual(S.describe(500).level, 100, '上限で止まる');
for (let lv = 1; lv <= 10; lv++) assert.strictEqual(S.describe(lv).deco, 0, 'Lv1〜10 は飾りなし(白抜き)');
for (let lv = 91; lv <= 100; lv++) assert.strictEqual(S.describe(lv).ring, 'gear', '神レベルはギザギザの輪');
for (let lv = 1; lv <= 100; lv++) assert.strictEqual(S.describe(lv).filled, false, `Lv${lv}: 塗りつぶしは使わない(2026-10-23 ユーザー指摘)`);
console.log('shapes100 ok: 100 unique patterns, outer ≤ 1.65r, size ≤ 1.2x');
