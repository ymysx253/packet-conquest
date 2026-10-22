'use strict';
// 1〜100 のレベル(2026-10-23 ユーザー決定。server/questions/cl/level100.json)の確かめ
const assert = require('assert');
const { L100, LEVELS, hasLevel, getLevelQuestion } = require('../server/questions/cl');

const seen = new Map();
for (let lv = 1; lv <= 89; lv++) {
  const e = L100.levels[lv];
  assert.ok(e && e.items.length >= 3 && e.items.length <= 5, `Lv${lv}: 1 レベルに 3〜5 項目`);
  for (const n of e.items) { assert.ok(!seen.has(n), `項目 ${n} が Lv${seen.get(n)} と Lv${lv} の両方にある`); seen.set(n, lv); }
}
assert.strictEqual(seen.size, 361, 'LEVEL-LIST の 361 項目がどれか 1 つのレベルに入る');
for (let lv = 90; lv <= 100; lv++) assert.ok(!L100.levels[lv] && !hasLevel(lv), `Lv${lv} は神レベル(まだ中身が無い)`);
// 段の境目
const band = { 入門: [1, 15], 初級: [16, 35], 中級: [36, 60], 上級: [61, 78], 専門: [79, 89] };
for (const [st, [lo, hi]] of Object.entries(band)) for (let lv = lo; lv <= hi; lv++) assert.strictEqual(L100.levels[lv].stage, st, `Lv${lv} は ${st}`);
// 学ぶ順: レベルが上がると項目の番号も上がる
for (let lv = 2; lv <= 89; lv++) assert.ok(Math.min(...L100.levels[lv].items) > Math.max(...L100.levels[lv - 1].items), `Lv${lv}: 項目は学ぶ順`);
// 問題のあるレベルは、同じ seed で同じ問題。いくつかの seed で、できている項目がいろいろ出る
let ready = 0;
for (let lv = 1; lv <= 89; lv++) {
  if (!hasLevel(lv)) continue;
  ready++;
  const a = getLevelQuestion({ level: lv, seed: 7 }), b = getLevelQuestion({ level: lv, seed: 7 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), `Lv${lv}: 同じ seed で同じ問題`);
  const items = new Set(); for (let s = 1; s <= 200; s++) items.add(getLevelQuestion({ level: lv, seed: s }).item);
  const want = L100.levels[lv].items.filter((n) => LEVELS.has(n)).length;
  assert.strictEqual(items.size, want, `Lv${lv}: できている項目 ${want} つが全部出る`);
}
console.log(`cl-level100 ok: 1〜89 に 361 項目、問題のあるレベル ${ready}/89、90〜100 は神レベル(空き)`);
