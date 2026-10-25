'use strict';
// 問題のダイアログまわりのサーバー側の検証(2026-10-22):
//   1. 画面に送る問題の形(questionPayload): 説明カードはいつも、ヒント・最初の 1 手は使えるときだけ。答えは入れない
//   2. ヒントの出し分け(CURRICULUM.md 第 7.5 節): 中立の拠点を攻める・自分の拠点を強化するときだけ送る。
//      ほかの人の拠点・ほかのチームの持ち物・同じチームの仲間の拠点を攻めるときは送らない(画面で隠すだけにしない)
//   3. 見本のページの口(server/cl-preview.js): CL_PREVIEW=1 のときだけ開く。答えを送らず、サーバーで判定する
const assert = require('assert');

// いまのゲームの問題(前の番号)にはまだヒントが無いので、テストの間だけ取得口にヒント・説明カードを足す。
// world.js は読み込んだときに getQuestion を取り出すので、world.js より先に差し替える
const Q = require('../server/questions');
const origGet = Q.getQuestion;
const HINT = 'テストのヒント: 256 ÷ 4 = 64', FIRST = 'テストの最初の 1 手: まずブロックの大きさを出す', CARD = 'テストの説明カード';
Q.getQuestion = (a) => ({ ...origGet(a), hint: HINT, firstStep: FIRST, card: CARD });

const { World, questionPayload, hintsAllowed, NEWBIE_MS } = require('../server/world');
const { MemoryStore } = require('../server/store');

const fakeWs = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() { this.readyState = 3; } });
const hasHint = (q) => q.hint === HINT && q.firstStep === FIRST && !q.hintLocked;
const noHint = (q) => q.hint === null && q.firstStep === null && q.hintLocked === true && !JSON.stringify(q).includes(HINT) && !JSON.stringify(q).includes(FIRST);

(async () => {
  // ---------- 1. 送る形 ----------
  {
    const q = { text: '問題', options: ['○', '×'], answerIndex: 1, explanation: '解説', card: CARD, hint: HINT, firstStep: FIRST, kind: 'x' };
    const on = questionPayload(q, { hints: true });
    assert.ok(hasHint(on) && on.card === CARD, 'ヒントを使えるときはヒントと最初の 1 手を送る');
    const off = questionPayload(q, { hints: false });
    assert.ok(noHint(off) && off.card === CARD, '使えないときはヒントを送らず hintLocked だけ。説明カードは送る');
    for (const p of [on, off]) {
      const js = JSON.stringify(p);
      assert.ok(!('answerIndex' in p) && !('explanation' in p) && !js.includes('解説'), '答えと解説は送らない');
    }
    const plain = questionPayload({ text: '問題', options: ['a', 'b', 'c'], answerIndex: 0 }, { hints: false });
    assert.ok(plain.hint === null && plain.firstStep === null && plain.hintLocked === false && plain.card === null, 'ヒントの無い問題には hintLocked を付けない');
    const tq = questionPayload({ text: '入力', answerKind: 'text', fields: [{ name: 'a', label: 'アドレス', format: 'ipv4', hint: '例: 192.0.2.1', accept: ['192.0.2.9'] }, { name: 'b', label: '2 進', format: 'bin', digits: 8, accept: ['00001111'] }] });
    assert.ok(!JSON.stringify(tq).includes('accept') && !JSON.stringify(tq).includes('192.0.2.9'), '入力式の accept は送らない');
    assert.strictEqual(tq.fields[1].digits, 8, '2 進の欄のけた数は送る(画面が切り替えボタンを並べるため)');
    assert.strictEqual(tq.fields[0].hint, '例: 192.0.2.1', '欄の入力例(hint)は答えのヒントとは別なのでいつも送る');
    assert.ok(hintsAllowed({ owner: null }, 'attack') && hintsAllowed({ owner: 'me' }, 'fortify') && !hintsAllowed({ owner: 'other' }, 'attack'), 'hintsAllowed の決まり');
  }

  // ---------- 2. ワールドでの出し分け ----------
  const store = new MemoryStore();
  const w = await new World({ store, minAnswerMs: 0 }).init();
  const a = await w.join(fakeWs(), 'あき', null);
  const home = w.nodes.get(a.homeNodeId);
  const nbs = [...w.adj.get(home.id)].map((id) => w.nodes.get(id)).filter((n) => n && !n.isPlayerNode && n.hackable !== false);
  assert.ok(nbs.length >= 1, '隣に固定拠点がある');
  const [n1] = nbs;
  assert.ok(!n1.owner && await w.canAttack(a.id, n1.id));

  // 中立の拠点を攻める → ヒントあり
  const q1 = await w.ask(a, n1.id);
  assert.strictEqual(q1.mode, 'attack');
  assert.ok(hasHint(q1) && q1.card === CARD, '中立の拠点を攻めるときはヒントを送る');
  assert.ok(!('answerIndex' in q1), '答えは送らない');

  // 中立 → ほかの人の拠点に変わったら、同じ拠点・同じレベルでも出し直してヒントを消す
  const b = await w.join(fakeWs(), 'ベン', null);
  b.createdAt = Date.now() - NEWBIE_MS - 1000; b.nodesOwned = 10; // 初心者保護を外す
  const lvBefore = w.levelFor(n1, 'attack');
  n1.owner = b.id;
  assert.ok(await w.canAttack(a.id, n1.id), 'ほかの人の拠点を攻撃できる');
  const q2 = await w.ask(a, n1.id);
  assert.ok(noHint(q2) && q2.card === CARD, 'ほかの人の拠点を攻めるときはヒントを送らない(説明カードは送る)');
  if (w.levelFor(n1, 'attack') === lvBefore) assert.notStrictEqual(q2.qid, q1.qid, '持ち主が変わったら、ヒントつきの問題を使い回さない');
  assert.strictEqual(a.pending.hints, false);
  // ヒントがあってもなくても判定と回数は同じ(正解すれば 1 回に数える)
  const r2 = await w.answer(a, q2.qid, a.pending.answerKind === 'text' ? a.pending.fields.map((f) => f.accept[0]) : a.pending.answerIndex);
  assert.ok(r2.correct, 'ヒントの無い問題も同じように判定する');

  // ほかのチームの持ち物 → ヒントなし
  n1.owner = 'team-other'; n1.ownerIsTeam = true; n1.progress = {};
  assert.ok(await w.canAttack(a.id, n1.id), 'ほかのチームの持ち物を攻撃できる');
  assert.ok(noHint(await w.ask(a, n1.id)), 'ほかのチームの持ち物を攻めるときはヒントを送らない');

  // 同じチームの仲間の拠点 → ヒントなし(中立でも自分の拠点の強化でもない)
  const team = await w.createTeam(a, 'ためしチーム', 3);
  await w.joinTeam(b, team.id);
  n1.owner = b.id; delete n1.ownerIsTeam; n1.progress = {};
  assert.ok(await w.canAttack(a.id, n1.id), '仲間の拠点は攻撃できる(いまの決まり)');
  assert.ok(noHint(await w.ask(a, n1.id)), '仲間の拠点を攻めるときもヒントを送らない');
  // 自分のチームの持ち物は攻撃も強化もできない(ヒント以前に出題しない)
  n1.owner = team.id; n1.ownerIsTeam = true;
  await assert.rejects(() => w.ask(a, n1.id), /チームの持ち物/);
  n1.owner = null; delete n1.ownerIsTeam;
  await w.leaveTeam(b); await w.leaveTeam(a);

  // 自分の拠点を強化する → ヒントあり
  a.pending = null;
  const q3 = await w.ask(a, home.id);
  assert.strictEqual(q3.mode, 'fortify');
  assert.ok(hasHint(q3), '自分の拠点を強化するときはヒントを送る');

  // ---------- 3. 見本のページの口 ----------
  {
    Q.getQuestion = origGet;
    const { createClPreview, enabled } = require('../server/cl-preview');
    const { LEVELS } = require('../server/questions/cl');
    const pv = createClPreview();
    const fakeRes = () => ({ code: 0, body: '', writeHead(c) { this.code = c; }, end(s) { this.body = s || ''; } });
    const saved = process.env.CL_PREVIEW;
    delete process.env.CL_PREVIEW;
    assert.ok(!enabled());
    for (const path of ['/cl-preview.html', '/cl-preview.js', '/cl-preview/levels', '/CL-Preview.html', '/cl%2Dpreview.html']) {
      const res = fakeRes();
      assert.ok(pv.handle({ method: 'GET' }, res, new URL(path, 'http://localhost'), {}), `${path} は口が扱う`);
      assert.strictEqual(res.code, 404, `CL_PREVIEW が無ければ ${path} は 404`);
    }
    assert.strictEqual(pv.handle({ method: 'GET' }, fakeRes(), new URL('/index.html', 'http://localhost'), {}), false, 'ほかの道には触らない');
    process.env.CL_PREVIEW = '1';
    { const res = fakeRes(); assert.strictEqual(pv.handle({ method: 'GET' }, res, new URL('/cl-preview.html', 'http://localhost'), {}), false, '開いているときはページをふつうに配る'); }
    { const res = fakeRes(); pv.handle({ method: 'GET' }, res, new URL('/cl-preview/levels', 'http://localhost'), {}); assert.strictEqual(res.code, 200); assert.ok(JSON.parse(res.body).levels.length === LEVELS.size); }
    if (saved === undefined) delete process.env.CL_PREVIEW; else process.env.CL_PREVIEW = saved;

    const levels = [...LEVELS.keys()];
    assert.ok(levels.length >= 1, '新しい番号の問題が 1 つはある');
    for (const lv of levels) {
      for (let seed = 1; seed <= 20; seed++) {
        const q = pv.ask({ level: lv, seed });
        assert.strictEqual(q.seed, seed, 'seed で同じ問題を作り直せる');
        const js = JSON.stringify(q);
        assert.ok(!('answerIndex' in q) && !js.includes('"accept"') && !('explanation' in q), `Lv${lv}: 見本のページにも答えを送らない`);
        const full = pv.pending.get(q.qid);
        const off = pv.ask({ level: lv, seed, hints: false });
        assert.ok(off.hint === null && off.firstStep === null, `Lv${lv}: hints: false ならヒントを送らない`);
        assert.strictEqual(off.hintLocked, !!(full.hint || full.firstStep));
        const right = full.answerKind === 'text' ? { inputs: full.fields.map((f) => f.accept[0]) } : { choice: full.answerIndex };
        const r = pv.answer({ qid: q.qid, ...right });
        assert.ok(r.correct && r.explanation, `Lv${lv}: 正しい答えは正解`);
        assert.throws(() => pv.answer({ qid: q.qid, ...right }), /終わっています/, '同じ問題には 2 回答えられない');
        if (full.answerKind !== 'text') {
          assert.throws(() => pv.answer({ qid: off.qid, choice: full.options.length }), /選択肢/, '選択肢の数を超える番号は断る');
          const wrong = (full.answerIndex + 1) % full.options.length;
          assert.ok(!pv.answer({ qid: off.qid, choice: wrong }).correct, '違う選択肢は不正解');
        }
      }
    }
    assert.throws(() => pv.ask({ level: 998 }), /まだありません/);
    assert.throws(() => pv.ask({ level: 'toString' }), /まだありません/, '見本の名前以外の文字は断る');
    // 画面の形の見本: 答えが合うこと。入力の部品が作る文字列(4 つの欄 → 「a.b.c.d」、切り替えボタン → 「01011010」)で正解になること
    const ui = { 'demo-ipv4': ['192.168.10.64'], 'demo-bin8': ['01011010'], 'demo-cidr': ['198.51.100.128/25', '126'] };
    for (const s of pv.levels().samples) {
      const q = pv.ask({ level: s.level });
      const full = pv.pending.get(q.qid);
      const right = full.answerKind === 'text' ? { inputs: ui[s.level] } : { choice: full.answerIndex };
      assert.ok(pv.answer({ qid: q.qid, ...right }).correct, `${s.level}: 部品が作る文字列で正解になる`);
      assert.ok(q.hint || q.firstStep || full.answerKind === 'text', `${s.level}: 形が出る`);
    }
    { const q = pv.ask({ level: 'demo-bin8' }); assert.ok(!pv.answer({ qid: q.qid, inputs: ['00000000'] }).correct, '0 のままのボタンは不正解'); }
    { const q = pv.ask({ level: 'demo-ipv4' }); assert.ok(!pv.answer({ qid: q.qid, inputs: ['192.168.10.'] }).correct, '欠けたアドレスは不正解'); }
    { const q = pv.ask({ level: 'demo-3' }); assert.strictEqual(q.options.length, 3); assert.ok(q.hint && !q.hintLocked); const off = pv.ask({ level: 'demo-3', hints: false }); assert.ok(off.hint === null && off.hintLocked); }
  }

  // ---------- 4. 図・設定・ターミナルの画面の部品(public/diagram.js・terminal.js。2026-10-25。DOM の無い純粋な関数だけ) ----------
  {
    const DG = require('../public/diagram');
    const T = require('../public/terminal');
    // 選びの決まり: one/port/link は 1 つ(選び直し)、many は反転、order は押した順(もう一度で外れる)、view は選べない
    assert.deepStrictEqual(DG.toggleSelect('one', [], 'a'), ['a']);
    assert.deepStrictEqual(DG.toggleSelect('one', ['a'], 'b'), ['b']);
    assert.deepStrictEqual(DG.toggleSelect('one', ['a'], 'a'), [], '同じものをもう一度押すと外れる');
    assert.deepStrictEqual(DG.toggleSelect('many', ['a'], 'b'), ['a', 'b']);
    assert.deepStrictEqual(DG.toggleSelect('many', ['a', 'b'], 'a'), ['b']);
    assert.deepStrictEqual(DG.toggleSelect('order', ['a', 'b', 'c'], 'b'), ['a', 'c'], '順の途中を外すと詰まる(番号が振り直される)');
    assert.deepStrictEqual(DG.toggleSelect('port', ['n1:Gi0/0'], 'n1:Gi0/1'), ['n1:Gi0/1']);
    assert.deepStrictEqual(DG.toggleSelect('view', [], 'a'), []);
    assert.strictEqual(DG.selectableKind('port'), 'port'); assert.strictEqual(DG.selectableKind('order'), 'node'); assert.strictEqual(DG.selectableKind('view'), null);
    assert.ok(DG.HIT_R * 2 * (320 / 1000) >= 44, 'スマホ幅(320 px)でも機器の当たりは 44 px 以上');
    // 設定の文字の上限(SIM-API.md 第 5 章: 1 台 40 行・1 行 120 字)
    assert.strictEqual(T.LIMITS.lines, 40); assert.strictEqual(T.LIMITS.lineChars, 120); assert.strictEqual(T.LIMITS.cmds, 60);
    assert.ok(T.checkConfigText('ip route 10.3.3.0/24 10.0.12.2\n').ok);
    assert.strictEqual(T.checkConfigText('a\nb\n\n\n').lines, 2, '末尾の空行は数えない');
    assert.ok(!T.checkConfigText(Array(41).fill('x').join('\n')).ok, '41 行は超え');
    assert.ok(T.checkConfigText(Array(40).fill('x').join('\n')).ok, '40 行はよい');
    assert.ok(!T.checkConfigText('y'.repeat(121)).ok && T.checkConfigText('y'.repeat(120)).ok, '1 行 120 字まで');
    assert.strictEqual(T.checkConfigText('   \n').nonEmpty, 0, '空白だけは書いたことにならない');
    // Tab 補完: 語の頭で補う。1 つなら入れ替え、複数なら共通の頭と候補。値(アドレス)は補わない
    const words = T.WORDS.concat(['R1', 'R2', 'FW1', 'Gi0/0', 'Gi0/1']);
    assert.strictEqual(T.complete('show ip nat transl', words).line, 'show ip nat translations ', '1 つに決まれば入れ替えて空白を足す');
    assert.strictEqual(T.complete('show ip ro', words).line, 'show ip rout', '複数(route・router・routing)なら共通の頭まで');
    { const c = T.complete('connect R', words).candidates; assert.ok(c.includes('R1') && c.includes('R2'), '機器名も候補に入る(大文字小文字は区別しない)'); }
    assert.strictEqual(T.complete('connect FW', words).line, 'connect FW1 ');
    assert.strictEqual(T.complete('connect R', words).line, 'connect R');
    assert.strictEqual(T.complete('interface Gi0/', words).line, 'interface Gi0/');
    assert.deepStrictEqual(T.complete('interface Gi0/', words).candidates, ['Gi0/0', 'Gi0/1']);
    assert.deepStrictEqual(T.complete('ping 10.1.', words).candidates, [], 'アドレスは補わない');
    assert.ok(!T.WORDS.some((w) => /\d+\.\d+\.\d+\.\d+/.test(w)), '補完の語にアドレスが無い');
  }

  console.log('qdialog: ok(ヒントの出し分け・送る形・見本のページの口・図と設定の部品)');
})().catch((e) => { console.error(e); process.exit(1); });
