'use strict';
// 前の生成器の口(server/questions/cl/levels-legacy.js)のテスト(2026-10-22。docs/questions/CL.md 第 5 章)。test/cl.js が読む。単独でも動く。
// 確かめること:
//   1. docs/LEVEL-LIST.md の「今の問題」列が埋まっている行と、口のレベルが一致する
//   2. 新しい番号ごとに、決めた前の型(q.legacy.type)だけが出る。型の中の絞り込み(プレフィックス・欄・向き・形)も守られる
//   3. 段に応じた手助け(入門 card、初級 hint、中級 firstStep)が付き、ほかは付かない
//   4. 同じ seed なら同じ問題。拠点(node)を渡しても作れる
//   5. verify が、answerIndex・accept をずらした問題を誤りとして見つける(解き直しが空回りしていない)
//   6. 口で作ったあとも、前の番号の subnet.js は Math.random に戻っている(今のゲームの出題を変えない)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LEVELS: LEGACY } = require('../server/questions/cl/levels-legacy');
const { getClQuestion, LEVELS } = require('../server/questions/cl');
const subnet = require('../server/questions/subnet');
const { NODES } = require('../server/map/all');

// ---------- 1. 一覧との対応 ----------
const list = fs.readFileSync(path.join(__dirname, '..', 'docs', 'LEVEL-LIST.md'), 'utf8');
const listed = new Map(); // 新しい番号 → 「今の問題」の文字(例: subnet.js Lv1(mask))
for (const line of list.split('\n')) {
  const cells = line.split('|').map((s) => s.trim());
  if (!/^\d+$/.test(cells[1] || '')) continue;
  const now = cells[6] || '';
  if (/\.js Lv\d+/.test(now)) listed.set(Number(cells[1]), now);
}
const mine = Object.keys(LEGACY).map(Number).sort((a, b) => a - b);
assert.deepStrictEqual(mine, [...listed.keys()].sort((a, b) => a - b), '口のレベルが一覧の「今の問題」の行と合わない');
for (const lv of mine) {
  const want = listed.get(lv).match(/^(\S+\.js Lv\d+)/)[1];
  assert.strictEqual(LEGACY[lv].legacy.src, want, `Lv${lv}: 前の生成器 ${LEGACY[lv].legacy.src} が一覧(${want})と違う`);
  assert.ok(LEVELS.has(lv) && LEVELS.get(lv).file === './levels-legacy', `Lv${lv}: 取得口に登録されていない`);
}

// ---------- 2. 型が 1 つだけか、と型の中の絞り込み ----------
const pOf = (q) => Number(q.text.match(/\/(\d+)/)[1]);
const fieldNames = (q) => q.fields.map((f) => f.name).join(',');
const EXTRA = {
  16: (q) => assert.strictEqual(q.meta.dir, 'bin2dec'),
  17: (q) => assert.strictEqual(q.meta.dir, 'dec2bin'),
  78: (q) => { assert.strictEqual(q.meta.unit, 'byte'); assert.strictEqual(q.meta.dir, 'hex2dec'); },
  79: (q) => { assert.strictEqual(q.meta.unit, 'byte'); assert.ok(['hex2bin', 'bin2hex'].includes(q.meta.dir)); },
  82: (q) => assert.ok([8, 16, 24].includes(pOf(q))),
  83: (q) => assert.ok(pOf(q) >= 25 && pOf(q) <= 28),
  85: (q) => assert.ok([16, 24].includes(pOf(q))),
  86: (q) => assert.ok([16, 24].includes(pOf(q))),
  87: (q) => assert.ok(pOf(q) >= 25 && pOf(q) <= 28),
  88: (q) => assert.ok(pOf(q) >= 25 && pOf(q) <= 28),
  89: (q) => assert.ok(pOf(q) >= 25 && pOf(q) <= 28),
  90: (q) => assert.ok(pOf(q) >= 25 && pOf(q) <= 28),
  91: (q) => assert.ok(pOf(q) >= 19 && pOf(q) <= 23),
  92: (q) => assert.ok([29, 30].includes(pOf(q))),
  104: (q) => assert.strictEqual(fieldNames(q), 'oui,nic'),
  105: (q) => assert.strictEqual(fieldNames(q), 'local,group'),
  168: (q) => assert.strictEqual(q.meta.mode, 'prefix'),
  169: (q) => assert.strictEqual(q.meta.mode, 'nth'),
  179: (q) => assert.strictEqual(q.meta.form, 'plan'),
};
// 型の中で出し分けるもの(79 の向き、203 の問い方)は、どれも出ることも確かめる
const SPREAD = { 79: (q) => q.meta.dir, 113: (q) => q.meta.kind, 203: (q) => q.meta.kind };
const N = 400;
for (const lv of mine) {
  const ent = LEGACY[lv];
  const key = lv <= 67 ? 'card' : lv <= 158 ? 'hint' : 'firstStep';
  const spread = new Set();
  for (let s = 1; s <= N; s++) {
    const q = getClQuestion({ level: lv, seed: s });
    const where = `Lv${lv} seed ${s}`;
    assert.ok(ent.legacy.types.includes(q.legacy.type), `${where}: 前の型 ${q.legacy.type} が出た(${ent.legacy.types.join('・')} だけのはず)`);
    assert.ok(q.kind.startsWith(`cl${lv}-`), `${where}: kind ${q.kind}`);
    assert.strictEqual(q.level, lv, `${where}: level`);
    assert.strictEqual(q.legacy.src, ent.legacy.src, `${where}: legacy.src`);
    for (const k of ['card', 'hint', 'firstStep']) {
      if (k === key) assert.ok(typeof q[k] === 'string' && q[k].trim(), `${where}: ${k} が無い`);
      else assert.ok(q[k] === undefined, `${where}: ${k} は付けない(${key} の段)`);
    }
    if (EXTRA[lv]) EXTRA[lv](q);
    if (SPREAD[lv]) spread.add(SPREAD[lv](q));
  }
  if (lv === 79) assert.strictEqual(spread.size, 2, 'Lv79: 16 進 → 2 進と 2 進 → 16 進の両方が出る');
  if (lv === 113 || lv === 203) assert.strictEqual(spread.size, 3, `Lv${lv}: 問い方 3 つがどれも出る`);
}

// ---------- 4. seed の再現と拠点 ----------
for (const lv of mine) {
  for (const s of [1, 77, 123456]) {
    const a = getClQuestion({ level: lv, seed: s }), b = getClQuestion({ level: lv, seed: s });
    assert.deepStrictEqual(a, b, `Lv${lv} seed ${s}: 同じ seed で違う問題`);
  }
  for (let i = 0; i < 30; i++) {
    const node = NODES[(i * 7919) % NODES.length];
    const q = getClQuestion({ level: lv, seed: i + 1, node });
    if (LEGACY[lv].verify) LEGACY[lv].verify(q);
  }
}

// ---------- 5. verify が誤りを見つける ----------
for (const lv of mine) {
  const q = getClQuestion({ level: lv, seed: 42 });
  const bad = JSON.parse(JSON.stringify(q));
  if (q.answerKind === 'text') bad.fields[0].accept = [`x${bad.fields[0].accept[0]}`];
  else bad.answerIndex = (q.answerIndex + 1) % q.options.length;
  assert.throws(() => LEGACY[lv].verify(bad), `Lv${lv}: 答えをずらした問題を verify が見逃した`);
}

// ---------- 6. 前の番号は Math.random のまま ----------
{
  const orig = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return 0.5; };
  try { subnet.makeQuestion(2, 0x0a000000); } finally { Math.random = orig; }
  assert.ok(calls > 0, 'subnet.js が Math.random に戻っていない');
}

console.log(`cl-legacy ok: ${mine.length} levels (${mine.join(',')})`);
