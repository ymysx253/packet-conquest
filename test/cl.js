'use strict';
// 新しい番号(docs/LEVEL-LIST.md)の問題をまとめて確かめる(2026-10-22。docs/questions/CL.md 第 5 章)。
// 登録された全レベルを seed を変えて作り、形・答え・違う問題の数を確かめる。担当ごとのテスト test/cl-*.js も読む
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LEVELS, getClQuestion } = require('../server/questions/cl');
const { judge } = require('../server/questions/normalize');

const N_TABLE = 600, N_GEN = 10000;
const report = [];
for (const [lv, ent] of [...LEVELS.entries()].sort((a, b) => a[0] - b[0])) {
  const n = ent.kind === '生' ? N_GEN : N_TABLE;
  const seen = new Set();
  for (let s = 1; s <= n; s++) {
    const q = getClQuestion({ level: lv, seed: s });
    const where = `Lv${lv}(${ent.title}) seed ${s}`;
    assert.ok(typeof q.text === 'string' && q.text.trim(), `${where}: 問題文がない`);
    assert.ok(typeof q.explanation === 'string' && q.explanation.trim(), `${where}: 解説がない`);
    assert.ok(typeof q.kind === 'string' && /^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: 型の名前(kind)が cl<番号>-<名前>-v<版> でない: ${q.kind}`);
    if (q.answerKind === 'text') {
      assert.ok(Array.isArray(q.fields) && q.fields.length, `${where}: 入力欄がない`);
      const ans = q.fields.map((f) => String((f.accept || [])[0] ?? ''));
      assert.ok(judge(q, ans), `${where}: accept の値が正解と判定されない`);
    } else {
      assert.ok(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4, `${where}: 選択肢は 2〜4 個`);
      assert.strictEqual(new Set(q.options).size, q.options.length, `${where}: 選択肢が重複`);
      assert.ok(Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.options.length, `${where}: answerIndex が範囲外`);
    }
    if (ent.verify) ent.verify(q);
    seen.add(JSON.stringify([q.text, q.options || null, q.table || null]));
  }
  const want = ent.minDistinct ?? (ent.kind === '生' ? 1000 : 30);
  assert.ok(seen.size >= Math.min(want, n), `Lv${lv}(${ent.title}): 違う問題が ${seen.size} 通りしか作れない(${want} 通り要る)`);
  report.push(`${lv}`);
}
for (const f of fs.readdirSync(__dirname).filter((x) => /^cl-.+\.js$/.test(x)).sort()) require(path.join(__dirname, f)); // 担当ごとのテスト
console.log(`cl ok: ${LEVELS.size} levels${LEVELS.size ? ` (${report[0]}…${report[report.length - 1]})` : ''}`);
