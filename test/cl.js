'use strict';
// 新しい番号(docs/LEVEL-LIST.md)の問題をまとめて確かめる(2026-10-22。docs/questions/CL.md 第 5 章)。
// 登録された全レベルを seed を変えて作り、形・答え・違う問題の数を確かめる。担当ごとのテスト test/cl-*.js も読む
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LEVELS, getClQuestion } = require('../server/questions/cl');
const { judge } = require('../server/questions/normalize');
const { questionPayload } = require('../server/world');

const N_TABLE = 600, N_GEN = 10000;
const TAP_MODES = new Set(['one', 'many', 'order', 'port', 'link']);
const SECRET_KEYS = ['accept', 'sim', 'solution', 'meta']; // 画面に送ってはいけない項目(SIM-API.md 第 5 章)
const DEVICE_NAME = /^(R|SW|L3SW|PC|SRV|FW|AP|INET)\d*$/i;
const report = [];
for (const [lv, ent] of [...LEVELS.entries()].sort((a, b) => a[0] - b[0])) {
  // 構成図・設定・模擬ターミナルの問題(levels-sim-*)は 1 問ごとに模擬を回すので 3,000 問(担当のテスト test/cl-sim-*.js が別に 2,000 seed を見る。2026-10-25)
  const n = ent.file && ent.file.includes('levels-sim') ? Math.min(N_GEN, 3000) : ent.kind === '生' ? N_GEN : N_TABLE;
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
    } else if (q.answerKind === 'tap') { // 構成図をタップ(SIM-API.md 第 5 章)
      assert.ok(q.tap && TAP_MODES.has(q.tap.mode), `${where}: tap.mode が one/many/order/port/link でない`);
      assert.ok(q.accept && Array.isArray(q.accept.ids) && q.accept.ids.length, `${where}: accept.ids が無い`);
      assert.ok(q.diagram && Array.isArray(q.diagram.nodes) && q.diagram.nodes.length, `${where}: 図(diagram)が無い`);
      assert.ok(judge(q, { ids: q.accept.ids }), `${where}: accept.ids が正解と判定されない`);
    } else if (q.answerKind === 'config') { // 設定を書く
      assert.ok(Array.isArray(q.editable) && q.editable.length, `${where}: editable が無い`);
      assert.ok(q.sim && q.sim.spec && q.sim.spec.devices, `${where}: sim.spec が無い`);
      assert.ok(Array.isArray(q.requirementsText) && q.requirementsText.length, `${where}: requirementsText が無い`);
      assert.ok(Array.isArray(q.solution) && q.solution.length, `${where}: 正解の例(solution)が無い`);
      assert.ok(judge(q, { configs: q.solution }), `${where}: 正解の例(solution)が正解と判定されない`);
    } else {
      assert.ok(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4, `${where}: 選択肢は 2〜4 個`);
      assert.strictEqual(new Set(q.options).size, q.options.length, `${where}: 選択肢が重複`);
      assert.ok(Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.options.length, `${where}: answerIndex が範囲外`);
    }
    if (q.diagram) { // 図の id は乱数で、機器の名前(R1 など)が入っていない(正解の id から機器を推し量れないように)
      const names = new Set(Object.keys((q.sim && q.sim.spec && q.sim.spec.devices) || {}));
      for (const node of q.diagram.nodes) assert.ok(typeof node.id === 'string' && !names.has(node.id) && !DEVICE_NAME.test(node.id), `${where}: 図の id に機器の名前が入っている: ${node.id}`);
    }
    if (q.diagram || q.terminal || q.answerKind === 'tap' || q.answerKind === 'config') { // 画面に送るものに答えが混ざらない
      const payload = questionPayload(q);
      for (const k of SECRET_KEYS) assert.ok(!(k in payload), `${where}: 画面に送るものに ${k} が入っている`);
    }
    if (ent.verify) ent.verify(q);
    seen.add(JSON.stringify([q.text, q.options || null, q.table || null, q.tables || null, q.accept || null])); // tables(表が 2 つ以上の問題)も数える(2026-10-22)
  }
  const want = ent.minDistinct ?? (ent.kind === '生' ? 1000 : 30);
  assert.ok(seen.size >= Math.min(want, n), `Lv${lv}(${ent.title}): 違う問題が ${seen.size} 通りしか作れない(${want} 通り要る)`);
  report.push(`${lv}`);
}
for (const f of fs.readdirSync(__dirname).filter((x) => /^cl-.+\.js$/.test(x)).sort()) require(path.join(__dirname, f)); // 担当ごとのテスト
console.log(`cl ok: ${LEVELS.size} levels${LEVELS.size ? ` (${report[0]}…${report[report.length - 1]})` : ''}`);
