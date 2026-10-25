'use strict';
// 構成図・設定・模擬ターミナルの問題の「サーバーの口」の確かめ(2026-10-25。docs/questions/SIM-API.md 第 5・7 章)。
// 問題の生成器が無くても動くよう、固定の問題(sim.gen.serial の構成)をここで作る。
//   1. judge / judgeDetail: タップ(one/many/order)と設定(正解・足りない・設定できない機器・行数の上限)
//   2. questionPayload: 答え(accept・sim・solution・meta)を送らず、図・tap・editable・terminal(補完の語)を送る
//   3. world.term: 出力が返る・速すぎる・60 回まで・終わった問題・120 字まで
//   4. cl-preview: ask → answer(tap の正解・不正解・形違い、config の正解・設定できない機器)、term
const assert = require('assert');
const sim = require('../server/sim');
const { makeRng } = require('../server/questions/rng');
const { judge, judgeDetail } = require('../server/questions/normalize');
const { World, questionPayload } = require('../server/world');
const { createClPreview } = require('../server/cl-preview');

const ids = (spec) => Object.fromEntries(Object.keys(spec.devices).map((n, i) => [n, `x${(i + 1) * 7919 % 100000}`]));
const ipOnly = (c) => String(c).split('/')[0];

// ---------- 固定の問題 ----------
const specTap = sim.gen.serial(makeRng(1), { routers: 2 });
const idTap = ids(specTap);
const qTapOne = { answerKind: 'tap', tap: { mode: 'one' }, text: 'PC1 のゲートウェイをタップ', diagram: sim.diagram(specTap, { nodeIds: idTap }), accept: { ids: [idTap.R1] }, sim: { spec: specTap }, meta: { x: 1 }, explanation: 'R1' };
const qTapMany = { ...qTapOne, tap: { mode: 'many' }, accept: { ids: [idTap.R1, idTap.R2] } };
const qTapOrder = { ...qTapOne, tap: { mode: 'order' }, accept: { ids: [idTap.SW1, idTap.R1, idTap.R2, idTap.SW2] } };

const specCfg = sim.gen.serial(makeRng(2), { routers: 2 });
const lan1 = `${specCfg.meta.lan1}.0/24`, lan2 = `${specCfg.meta.lan2}.0/24`;
const r1Link = ipOnly(specCfg.devices.R1.ifaces[1].ip), r2Link = ipOnly(specCfg.devices.R2.ifaces[0].ip);
specCfg.devices.R1.routes = []; specCfg.devices.R2.routes = [];
specCfg.editable = ['R1', 'R2'];
specCfg.requirements = [
  { id: 1, kind: 'reach', from: 'PC1', to: 'PC2', proto: 'icmp', roundTrip: true, expect: true },
  { id: 2, kind: 'route', device: 'R1', prefix: lan2, via: r2Link },
];
const solution = [{ device: 'R1', text: `ip route ${lan2} ${r2Link}` }, { device: 'R2', text: `ip route ${lan1} ${r1Link}` }];
const qCfg = { answerKind: 'config', text: '往復の静的経路を書く', editable: ['R1', 'R2'], configView: { R1: ['interface Gi0/0'] }, requirementsText: [{ id: 1, text: 'PC1 → PC2 往復' }, { id: 2, text: 'R1 の経路' }], sim: { spec: specCfg, requirements: specCfg.requirements }, solution, diagram: sim.diagram(specCfg, { nodeIds: ids(specCfg) }), explanation: '両方に書く' };

const specTerm = sim.gen.serial(makeRng(3), { routers: 1 });
const qTerm = { answerKind: 'text', text: 'PC1 のアドレスは', fields: [{ name: 'ip', label: 'IPv4', format: 'ipv4', accept: [ipOnly(specTerm.devices.PC1.ip)] }], terminal: { devices: ['PC1', 'R1'], start: 'PC1' }, sim: { spec: specTerm }, explanation: 'ipconfig' };

// ---------- 1. judge / judgeDetail ----------
assert.ok(judge(qTapOne, { ids: [idTap.R1] }), 'tap one: 正解');
assert.ok(!judge(qTapOne, { ids: [idTap.R2] }), 'tap one: 別の機器は不正解');
assert.ok(!judge(qTapOne, { ids: [idTap.R1, idTap.R2] }), 'tap one: 2 つ選ぶと不正解');
assert.ok(!judge(qTapOne, { ids: [] }) && !judge(qTapOne, [idTap.R1]) && !judge(qTapOne, null), 'tap one: 形が違えば不正解');
assert.ok(judge(qTapMany, { ids: [idTap.R2, idTap.R1] }), 'tap many: 順は問わない');
assert.ok(!judge(qTapMany, { ids: [idTap.R1] }) && !judge(qTapMany, { ids: [idTap.R1, idTap.R1] }), 'tap many: 足りない・重複は不正解');
assert.ok(judge(qTapOrder, { ids: qTapOrder.accept.ids.slice() }), 'tap order: 正解');
assert.ok(!judge(qTapOrder, { ids: qTapOrder.accept.ids.slice().reverse() }), 'tap order: 逆順は不正解');
assert.deepStrictEqual(judgeDetail(qTapOne, { ids: [idTap.R2] }), { correct: false, failed: [], errors: [] }, 'tap の judgeDetail は failed・errors が空');

const okCfg = judgeDetail(qCfg, { configs: solution });
assert.ok(okCfg.correct && okCfg.failed.length === 0 && okCfg.errors.length === 0, `config: 正解の例が正解 ${JSON.stringify(okCfg)}`);
const half = judgeDetail(qCfg, { configs: [solution[0]] });
assert.ok(!half.correct && half.failed.includes(1) && !half.failed.includes(2) && half.errors.length === 0, `config: 片方だけだと要件 1(往復)が満たされない ${JSON.stringify(half)}`);
const notEditable = judgeDetail(qCfg, { configs: [{ device: 'PC1', text: 'gateway 10.0.0.1' }] });
assert.ok(!notEditable.correct && notEditable.errors.length === 1 && /設定できません/.test(notEditable.errors[0].message), 'config: editable でない機器は errors');
const tooLong = judgeDetail(qCfg, { configs: [{ device: 'R1', text: Array.from({ length: 41 }, () => 'no shutdown').join('\n') }] });
assert.ok(!tooLong.correct && tooLong.errors.some((e) => /40 行/.test(e.message)), 'config: 41 行は errors');
const longLine = judgeDetail(qCfg, { configs: [{ device: 'R1', text: 'x'.repeat(121) }] });
assert.ok(!longLine.correct && longLine.errors.some((e) => /120 字/.test(e.message) && e.line === 1), 'config: 121 字の行は errors(行番号つき)');
const typo = judgeDetail(qCfg, { configs: [{ device: 'R1', text: `ip rout ${lan2} ${r2Link}` }, solution[1]] });
assert.ok(!typo.correct && typo.errors.length === 1 && typo.errors[0].device === 'R1' && typo.errors[0].line === 1, `config: 文法の誤りは行番号つき ${JSON.stringify(typo.errors)}`);
assert.ok(!judge(qCfg, { configs: [] }) && !judge(qCfg, solution) && !judge(qCfg, { configs: [{ device: 'R1' }] }), 'config: 形が違えば不正解');

// ---------- 2. questionPayload ----------
for (const [name, q] of [['tap', qTapOne], ['config', qCfg], ['term', qTerm]]) {
  const p = questionPayload(q);
  for (const k of ['accept', 'sim', 'solution', 'meta']) assert.ok(!(k in p), `${name}: 画面に ${k} を送らない`);
  assert.ok(!JSON.stringify(p).includes('ip route '), `${name}: 正解の設定の文が画面に混ざらない`);
}
assert.deepStrictEqual(questionPayload(qTapOne).tap, { mode: 'one' });
assert.ok(questionPayload(qTapOne).diagram.nodes.length === 6 && questionPayload(qTapOne).diagram.nodes.every((n) => /^x\d+$/.test(n.id)), '図の id は問題が決めたもの');
const pc = questionPayload(qCfg);
assert.deepStrictEqual(pc.editable, ['R1', 'R2']); assert.deepStrictEqual(pc.configView, { R1: ['interface Gi0/0'] }); assert.strictEqual(pc.requirementsText.length, 2);
const pt = questionPayload(qTerm);
assert.deepStrictEqual(pt.terminal.devices, ['PC1', 'R1']); assert.strictEqual(pt.terminal.start, 'PC1');
assert.ok(pt.terminal.completions.includes('ipconfig') && pt.terminal.completions.includes('R1') && !pt.terminal.completions.some((w) => /\d+\.\d+\.\d+\.\d+/.test(w)), '補完の語はコマンドと機器名だけ(アドレスは無い)');
assert.strictEqual(questionPayload({ text: 'a', options: ['1', '2'], answerIndex: 0 }).terminal, null, '今までの問題には terminal が無い');

// ---------- 3. world.term(World の init は要らないので、term だけを呼ぶ) ----------
(async () => {
  const fake = { events: { add() {} } };
  const mkPending = (q) => ({ qid: 'q1', nodeId: 'n1', mode: 'attack', level: 35, hints: true, terminal: q.terminal, sim: q.sim, term: null, termCount: 0, termLast: 0 });
  const p = { id: 'p1', pending: mkPending(qTerm) };
  const term = (line, qid = 'q1') => World.prototype.term.call(fake, p, qid, line);
  const r1 = await term('ipconfig');
  assert.strictEqual(r1.t, 'termOut'); assert.strictEqual(r1.qid, 'q1'); assert.strictEqual(r1.line, 'ipconfig'); assert.strictEqual(r1.device, 'PC1');
  assert.ok(r1.out.includes(ipOnly(specTerm.devices.PC1.ip)), `ipconfig に自分のアドレスが出る: ${r1.out}`);
  assert.strictEqual(p.pending.termCount, 1);
  const r2 = await term('ping 10.0.0.1');
  assert.ok(/速すぎ/.test(r2.out) && p.pending.termCount === 1, '0.3 秒以内の 2 行目は「速すぎます」で数えない');
  p.pending.termLast = 0;
  const r3 = await term('connect R1');
  assert.strictEqual(r3.device, 'R1', 'connect で機器が替わる'); assert.strictEqual(p.pending.termCount, 2);
  p.pending.termLast = 0; p.pending.termCount = 60;
  const r4 = await term('show ip route');
  assert.ok(/60 回/.test(r4.out) && p.pending.termCount === 60, '61 回目は拒否');
  const r5 = await term('ipconfig', 'q-other');
  assert.ok(/終わっています/.test(r5.out), '違う qid は「終わっています」');
  await assert.rejects(() => term('x'.repeat(121)), /120 字/, '121 字の行は拒否');
  const r6 = await World.prototype.term.call(fake, { id: 'p2', pending: mkPending(qTapOne) }, 'q1', 'ipconfig');
  assert.ok(/ターミナルがありません/.test(r6.out), 'terminal の無い問題では使えない');
  assert.ok(!JSON.stringify(r1).includes('"spec"'), 'termOut に構成を含めない');

  // ---------- 4. cl-preview ----------
  const pv = createClPreview();
  const a1 = pv.ask({ level: 'demo-tap' });
  assert.strictEqual(a1.answerKind, 'tap'); assert.ok(a1.diagram && !('accept' in a1) && !('sim' in a1), 'demo-tap: 図を送り、答えは送らない');
  const want = pv.pending.get(a1.qid).accept.ids[0];
  const wrongId = a1.diagram.nodes.find((n) => n.id !== want).id;
  const w1 = pv.answer({ qid: a1.qid, ids: [wrongId] });
  assert.ok(!w1.correct && Array.isArray(w1.correctIds) && w1.correctIds[0] === want && w1.answerIndex === null, 'demo-tap: 不正解なら正解の id を返す(見本)');
  assert.throws(() => pv.answer({ qid: a1.qid, ids: [want] }), /終わっています/, '答えたあとはもう終わっている');
  const a2 = pv.ask({ level: 'demo-tap' });
  assert.throws(() => pv.answer({ qid: a2.qid, choice: 0 }), /形が違います/, 'tap の問題に choice は形違い');
  const ok2 = pv.answer({ qid: a2.qid, ids: [pv.pending.get(a2.qid).accept.ids[0]] });
  assert.ok(ok2.correct && ok2.correctIds === null, 'demo-tap: 正解');

  const c1 = pv.ask({ level: 'demo-config' });
  assert.strictEqual(c1.answerKind, 'config'); assert.deepStrictEqual(c1.editable, ['R1', 'R2']); assert.ok(c1.requirementsText.length === 3 && c1.configView.R1.length && !('solution' in c1), 'demo-config: 要件と今の設定を送り、正解の例は送らない');
  const sol = pv.pending.get(c1.qid).solution;
  const c1r = pv.answer({ qid: c1.qid, configs: sol });
  assert.ok(c1r.correct && c1r.failed.length === 0 && c1r.errors === null, `demo-config: 正解の例で正解 ${JSON.stringify(c1r)}`);
  const c2 = pv.ask({ level: 'demo-config' });
  const c2r = pv.answer({ qid: c2.qid, configs: [{ device: 'PC1', text: 'gateway 10.0.0.1' }] });
  assert.ok(!c2r.correct && c2r.errors && /設定できません/.test(c2r.errors[0].message), 'demo-config: 設定できない機器は errors');
  const c3 = pv.ask({ level: 'demo-config' });
  const c3r = pv.answer({ qid: c3.qid, configs: [pv.pending.get(c3.qid).solution[0]] });
  assert.ok(!c3r.correct && c3r.failed.includes(1), 'demo-config: 片方だけなら要件 1 が満たされない');

  const t1 = pv.ask({ level: 'demo-term' });
  assert.ok(t1.terminal && t1.terminal.completions.includes('ping') && !('sim' in t1), 'demo-term: ターミナルの語を送り、構成は送らない');
  const t1a = pv.term({ qid: t1.qid, line: 'ipconfig' });
  assert.ok(t1a.t === 'termOut' && t1a.device === 'PC1' && /IPv4/.test(t1a.out), 'demo-term: 出力が返る');
  const t1b = pv.term({ qid: t1.qid, line: 'ipconfig' });
  assert.ok(/速すぎ/.test(t1b.out), 'demo-term: 続けて打つと速すぎる');
  pv.sessions.get(t1.qid).last = 0;
  const t1c = pv.term({ qid: t1.qid, line: 'ping 203.0.113.9' });
  assert.ok(/ping/.test(t1c.out) || t1c.out.length > 0, 'demo-term: ping の出力');
  const ipAns = pv.pending.get(t1.qid).fields[0].accept[0];
  const t1r = pv.answer({ qid: t1.qid, inputs: [ipAns] });
  assert.ok(t1r.correct, 'demo-term: 答えは入力の欄で');
  assert.ok(/終わっています/.test(pv.term({ qid: t1.qid, line: 'ipconfig' }).out), 'demo-term: 答えたあとのターミナルは終わっている');
  assert.throws(() => pv.term({ qid: t1.qid, line: 'x'.repeat(121) }), /120 字/);

  console.log('sim-wire ok: judge(tap/config)・questionPayload・world.term・cl-preview(demo-tap/demo-config/demo-term)');
})().catch((e) => { console.error(e); process.exit(1); });
