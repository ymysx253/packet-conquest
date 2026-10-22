'use strict';
// 1〜100 のレベル(2026-10-23 ユーザー決定。server/questions/cl/level100.json。割り当ての元は level100-map.json)の確かめ
const assert = require('assert');
const { L100, LEVELS, hasLevel, getLevelQuestion } = require('../server/questions/cl');

// 段の範囲。各項目は自分の段のレベルに入る(段は LEVEL-LIST.md の項目番号の範囲)
const band = { 入門: [1, 15], 初級: [16, 35], 中級: [36, 60], 上級: [61, 78], 専門: [79, 89] };
const itemBand = { 入門: [1, 67], 初級: [68, 158], 中級: [159, 252], 上級: [253, 319], 専門: [320, 361] };
const seen = new Map();
for (const [st, [lo, hi]] of Object.entries(band)) {
  for (let lv = lo; lv <= hi; lv++) {
    const e = L100.levels[lv];
    assert.ok(e && e.items.length >= 1, `Lv${lv}: 1 項目以上`);
    assert.strictEqual(e.stage, st, `Lv${lv} は ${st}`);
    assert.ok(e.topic, `Lv${lv}: 話題(topic)がある`);
    const [a, b] = itemBand[st];
    for (const n of e.items) {
      assert.ok(n >= a && n <= b, `Lv${lv}(${st}): 項目 ${n} は ${st} の項目(${a}〜${b})`);
      assert.ok(!seen.has(n), `項目 ${n} が Lv${seen.get(n)} と Lv${lv} の両方にある`);
      seen.set(n, lv);
    }
  }
}
assert.strictEqual(seen.size, 361, 'LEVEL-LIST の 361 項目がちょうど 1 回ずつどれかのレベルに入る');
for (let n = 1; n <= 361; n++) assert.ok(seen.has(n), `項目 ${n} がどこかのレベルにある`);
for (let lv = 90; lv <= 100; lv++) assert.ok(!L100.levels[lv] && !hasLevel(lv), `Lv${lv} は神レベル(まだ中身が無い)`);
// 問題のあるレベルは、同じ seed で同じ問題。いくつかの seed で、できている項目が全部出る
let ready = 0;
for (let lv = 1; lv <= 89; lv++) {
  if (!hasLevel(lv)) continue;
  ready++;
  const a = getLevelQuestion({ level: lv, seed: 7 }), b = getLevelQuestion({ level: lv, seed: 7 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), `Lv${lv}: 同じ seed で同じ問題`);
  const items = new Set(); for (let s = 1; s <= 300; s++) items.add(getLevelQuestion({ level: lv, seed: s }).item);
  const want = L100.levels[lv].items.filter((n) => LEVELS.has(n)).length;
  assert.strictEqual(items.size, want, `Lv${lv}: できている項目 ${want} つが全部出る`);
}
console.log(`cl-level100 ok: 1〜89 に 361 項目、問題のあるレベル ${ready}/89、90〜100 は神レベル(空き)`);
