'use strict';
// 拠点の形の検証: Lv1〜999 のすべてが異なる模様になること(重複禁止)。形の要素が範囲内であること
const assert = require('assert');
const S = require('../public/shapes');

assert.strictEqual(S.MAX_LEVEL, 999);
const seen = new Map();
for (let lv = 1; lv <= S.MAX_LEVEL; lv++) {
  const d = S.describe(lv);
  assert.strictEqual(d.level, lv);
  assert.ok(d.shape >= 1 && d.shape <= 10 && S.SHAPES[d.shape], `Lv${lv}: 形が不正`);
  assert.ok(d.rings >= 0 && d.rings <= 4, `Lv${lv}: 外輪の本数が不正`);
  assert.ok(d.frame >= 0 && d.frame <= 9 && S.FRAME_NAMES[d.frame] != null, `Lv${lv}: 外枠が不正`);
  assert.strictEqual(d.badge, lv > 10);
  const key = `${d.shape}|${d.filled}|${d.rings}|${d.frame}`;
  assert.ok(!seen.has(key), `Lv${lv} と Lv${seen.get(key)} の模様が重複`);
  seen.set(key, lv);
}
// 基本の 10 種はそのまま
for (let lv = 1; lv <= 10; lv++) {
  const d = S.describe(lv);
  assert.deepStrictEqual([d.shape, d.filled, d.rings, d.frame], [lv, false, 0, 0], `Lv${lv} は飾りなし`);
}
// 桁の規則
assert.deepStrictEqual([S.describe(37).shape, S.describe(37).filled, S.describe(37).rings, S.describe(37).frame], [7, false, 3, 0]);
assert.deepStrictEqual([S.describe(87).shape, S.describe(87).filled, S.describe(87).rings, S.describe(87).frame], [7, true, 3, 0]);
assert.deepStrictEqual([S.describe(237).shape, S.describe(237).filled, S.describe(237).rings, S.describe(237).frame], [7, false, 3, 2]);
assert.strictEqual(S.describe(100).shape, 10);
assert.strictEqual(S.describe(1000).level, 999, '上限で止まる');
assert.strictEqual(S.describe(0).level, 1, '下限で止まる');
// 外接半径はレベルが上がっても小さくならない範囲で増える
assert.ok(S.outerRadius(1, 12) < S.outerRadius(45, 12) && S.outerRadius(45, 12) < S.outerRadius(945, 12));

console.log(`shapes ok: ${seen.size} unique patterns (Lv1〜${S.MAX_LEVEL})`);
