'use strict';
// 入門(新しい番号 1〜67)ならではの確かめ(2026-10-22。docs/questions/CL.md 第 5 章)。test/cl.js が読む
//   ○× の表: 文が 30 以上・正誤の偏りがない・同じ文が無い
//   n 択の表: 正解が誤答の候補に無い・同じ問いの文の別の行の正解が誤答に入らない・選択肢の組み合わせ(並びを除く)が 30 通り以上
//   生成: 並びを除いた違う問題の数・境界の値・紛らわしい選択肢が正解にならないこと
//   全部: 説明カードと解説がある・選択肢の数が一覧の「答え方」どおり・アドレスとドメインは文書用・プライベートの範囲だけ
const assert = require('assert');
const { LEVELS } = require('../server/questions/cl/levels-intro');
const { getClQuestion } = require('../server/questions/cl');
const { judge } = require('../server/questions/normalize');

// 一覧(docs/LEVEL-LIST.md 第 2 章)の「答え方」: 選択肢の数(0 = 入力)
const FORM = {
  1: 2, 2: 3, 3: 2, 4: 3, 5: 4, 6: 2, 7: 3, 8: 3, 9: 2, 10: 4, 11: 3, 12: 0, 13: 4, 14: 0, 15: 0, 18: 4, 19: 4, 20: 0,
  21: 4, 22: 0, 23: 4, 24: 0, 25: 4, 26: 4, 27: 4, 28: 4, 29: 4, 30: 2, 31: 3, 32: 3, 33: 2, 34: 4, 35: 2, 36: 4, 37: 4,
  38: 0, 39: 4, 40: 4, 41: 2, 42: 4, 43: 2, 44: 4, 45: 4, 46: 4, 47: 4, 48: 4, 49: 4, 50: 4, 51: 4, 52: 4, 53: 4, 54: 4,
  55: 3, 56: 4, 57: 3, 58: 2, 59: 4, 60: 2, 61: 2, 62: 4, 63: 4, 64: 4, 65: 0, 66: 4,
};
const NOT_MADE = [16, 17, 67]; // 16・17 は前の生成器の口の担当、67 は模擬ターミナル
for (let lv = 1; lv <= 67; lv++) {
  if (NOT_MADE.includes(lv)) assert.ok(!LEVELS[lv], `Lv${lv} は入門では作らない`);
  else assert.ok(LEVELS[lv], `Lv${lv} がない`);
}
assert.deepStrictEqual(Object.keys(LEVELS).map(Number).sort((a, b) => a - b), Object.keys(FORM).map(Number).sort((a, b) => a - b));

// ---------- 安全: アドレス・ドメインの範囲(docs/questions/COMMON.md 第 7 章) ----------
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function safeV4(a) {
  const p = a.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 192 && p[1] === 0 && p[2] === 2)
    || (p[0] === 198 && p[1] === 51 && p[2] === 100) || (p[0] === 203 && p[1] === 0 && p[2] === 113) || p[0] === 127 || a === '255.255.255.255'
    || a === '172.32.0.1'; // 172.32.0.1 はプライベートの範囲の外の例(Lv42 の誤答)。COMMON.md 第 7 章で種別判定の題材に限り使ってよい
}
function checkSafe(where, s) {
  const hosts = [];
  const rest = s.replace(/https?:\/\/([^/\s]+)\S*/g, (_, h) => { hosts.push(h); return ' '; }); // URL はホスト名だけを見る
  const toks = [...hosts, ...rest.split(/[\s、。「」()()・,?]+/)].map((t) => t.replace(/[.:]+$/, '')).filter(Boolean);
  for (const tok of toks) {
    if (IPV4_RE.test(tok)) { assert.ok(safeV4(tok), `${where}: 使えない範囲の IPv4 ${tok}`); continue; }
    if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(tok)) { assert.ok(/^.[26ae]/i.test(tok), `${where}: ローカル管理でない MAC ${tok}`); continue; }
    if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i.test(tok) && (tok.includes('::') || tok.split(':').length === 8)) { assert.ok(/^(2001:db8|fe80|::1$)/i.test(tok), `${where}: 文書用でない IPv6 ${tok}`); continue; }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tok) && /^[a-z][a-z0-9-]+$/i.test(tok.split('.').pop())) assert.ok(/\.example$/.test(tok), `${where}: .example 以外のドメイン ${tok}`);
  }
}

// ---------- 表のレベル ----------
const combos = (k, r) => { let c = 1; for (let i = 0; i < r; i++) c = (c * (k - i)) / (i + 1); return c; };
for (const [lvs, ent] of Object.entries(LEVELS)) {
  const lv = Number(lvs);
  if (ent.form === 'tf') {
    const rows = ent.rows;
    assert.ok(rows.length >= 30, `Lv${lv}: ○× の文が 30 未満(${rows.length})`);
    const t = rows.filter((r) => r.attrs.true === true).length; const f = rows.filter((r) => r.attrs.true === false).length;
    assert.strictEqual(t + f, rows.length, `Lv${lv}: attrs.true が真偽でない行がある`);
    assert.ok(t / rows.length >= 0.4 && t / rows.length <= 0.6, `Lv${lv}: 正しい文 ${t} / 誤った文 ${f} で偏っている`);
    assert.strictEqual(new Set(rows.map((r) => r.ja)).size, rows.length, `Lv${lv}: 同じ文がある`);
    assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, `Lv${lv}: 同じ id がある`);
    for (const r of rows) { assert.ok(r.attrs.why && r.source && r.checkedBy, `Lv${lv} ${r.id}: why・source・checkedBy`); checkSafe(`Lv${lv} ${r.id}`, `${r.ja} ${r.attrs.why}`); }
  }
  if (ent.form === 'mc') {
    const rows = ent.rows; let total = 0;
    assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, `Lv${lv}: 同じ id がある`);
    for (const r of rows) {
      const { answer, wrong, why } = r.attrs;
      assert.ok(answer && why && r.source && r.checkedBy, `Lv${lv} ${r.id}: answer・why・source・checkedBy`);
      assert.ok(!wrong.includes(answer), `Lv${lv} ${r.id}: 正解が誤答の候補にある`);
      assert.strictEqual(new Set(wrong).size, wrong.length, `Lv${lv} ${r.id}: 誤答の候補が重複`);
      assert.ok(wrong.length >= ent.n - 1, `Lv${lv} ${r.id}: 誤答の候補が足りない`);
      // 同じ問いの文のほかの行の正解は、どれもその問いの正解になり得るので、誤答に入れてはいけない
      for (const o of rows) if (o !== r && o.ja === r.ja) assert.ok(!wrong.includes(o.attrs.answer), `Lv${lv} ${r.id}: 同じ問いの正解「${o.attrs.answer}」が誤答にある`);
      total += combos(wrong.length, ent.n - 1);
      checkSafe(`Lv${lv} ${r.id}`, [r.ja, answer, ...wrong, why].join(' '));
    }
    assert.ok(total >= 30, `Lv${lv}: 選択肢の組み合わせが ${total} 通りしかない`);
  }
}

// ---------- 全レベル: 作った問題の形 ----------
const N = 10000;
const distinct = {};
for (const [lvs, ent] of Object.entries(LEVELS)) {
  const lv = Number(lvs); const seen = new Set(); const n = ent.kind === '生' ? N : 2000;
  for (let s = 1; s <= n; s++) {
    const q = getClQuestion({ level: lv, seed: s }); const where = `Lv${lv} seed ${s}`;
    assert.ok(typeof q.card === 'string' && q.card.length >= 20 && q.card.length <= 170, `${where}: 説明カードの長さ ${q.card && q.card.length}`);
    assert.ok(q.explanation.length >= 5, `${where}: 解説が短い`);
    if (FORM[lv] === 0) { assert.strictEqual(q.answerKind, 'text', `${where}: 入力の問題`); seen.add(q.text + '|' + q.fields.map((f) => f.accept[0]).join()); }
    else {
      assert.strictEqual(q.options.length, FORM[lv], `${where}: 選択肢は ${FORM[lv]} 個`);
      if (FORM[lv] === 2) assert.deepStrictEqual(q.options, ['○', '×'], `${where}: ○× の並び`);
      seen.add(q.text + '|' + q.options.slice().sort().join('|'));
    }
    if (s <= 2000) checkSafe(where, [q.text, ...(q.options || []), q.explanation, q.card].join(' '));
  }
  distinct[lv] = seen.size;
  if (ent.kind === '生') assert.ok(seen.size >= ent.minDistinct, `Lv${lv}: 選択肢の並びを除くと違う問題が ${seen.size} 通り(${ent.minDistinct} 要る)`);
  else assert.ok(seen.size >= 30, `Lv${lv}: 選択肢の並びを除くと違う問題が ${seen.size} 通り`);
}

// ---------- 生成のレベルの境界・紛らわしい選択肢 ----------
const gen = (lv, n = N) => Array.from({ length: n }, (_, i) => getClQuestion({ level: lv, seed: i + 1 }));
const ok = (q, ...inputs) => judge(q, inputs);
// Lv12: 8 倍し忘れ(バイトの数のまま)は不正解
for (const q of gen(12, 500)) assert.ok(!ok(q, String(q.meta.bytes)) && ok(q, `${q.meta.bytes * 8}ビット`), 'Lv12: 8 倍し忘れ・単位付き');
// Lv13: 8 けたの左端 = 128、右端 = 1。けた数 4〜8 と左右がそろう
{
  const qs = gen(13); const sides = new Set(qs.map((q) => `${q.meta.w}${q.meta.fromLeft}`)); assert.strictEqual(sides.size, 10, 'Lv13: けた数 × 左右');
  for (const q of qs) {
    if (q.meta.w === 8 && q.meta.p === 1) assert.strictEqual(q.options[q.answerIndex], q.meta.fromLeft ? '128' : '1');
    if (q.meta.fromLeft && q.meta.p === q.meta.w) assert.strictEqual(q.options[q.answerIndex], '1', 'Lv13: 左から最後の位は 1');
  }
}
// Lv14: 2 の 0 乗は 1、2 の 10 乗は 1024
for (const q of gen(14, 2000)) { if (q.meta.n === 0) assert.ok(ok(q, '1')); if (q.meta.n === 10) assert.ok(ok(q, '1,024') && ok(q, '1024')); }
// Lv15: 0000 → 0、1111 → 15 が出る
{ const vs = new Set(gen(15, 2000).map((q) => q.meta.v)); assert.strictEqual(vs.size, 16, 'Lv15: 16 通り'); }
// Lv18: 8 つのマスクの数がどの問い方でも正解に出る。誤答もマスクの数だけ
{
  const seen = new Set(); const MASKS = ['128', '192', '224', '240', '248', '252', '254', '255'];
  for (const q of gen(18)) {
    seen.add(`${q.meta.mode}-${q.meta.k}`);
    if (q.meta.mode !== 1) for (const o of q.options) assert.ok(MASKS.includes(o), `Lv18: マスクでない誤答 ${o}`);
    else for (const o of q.options) assert.ok(/^1*0*$/.test(o) && o.length === 8, `Lv18: 1 が左から並ばない誤答 ${o}`);
  }
  assert.strictEqual(seen.size, 24, 'Lv18: 3 通りの問い方 × 8');
}
// Lv19: G は 16 進数の 1 けたにならない(正解に出ない)
for (const q of gen(19, 2000)) assert.notStrictEqual(q.options[q.answerIndex], 'G');
// Lv20: 16 通り × 2 向き。大文字・小文字・0x 付きも正解、3 けたは不正解
{
  const seen = new Set();
  for (const q of gen(20, 2000)) {
    seen.add(`${q.meta.dir}${q.meta.v}`);
    const a = q.fields[0].accept[0];
    if (q.meta.dir === 'bin2hex') assert.ok(ok(q, a.toUpperCase()) && ok(q, `0x${a}`), 'Lv20: 16 進の書き方');
    else assert.ok(ok(q, a) && !ok(q, `1${a}`), 'Lv20: 5 けたは不正解');
  }
  assert.strictEqual(seen.size, 32, 'Lv20: 16 通り × 2 向き');
}
// Lv22: 「1,000」も単位付きも正解。× 1,000 と ÷ 1,000 の取り違えは不正解
for (const q of gen(22, 1000)) {
  const a = q.fields[0].accept[0];
  assert.ok(ok(q, Number(a).toLocaleString('en-US')), 'Lv22: 桁区切り');
  const flip = q.meta.dir === 'down' ? q.meta.x : q.meta.x * 1000;
  if (String(flip) !== a) assert.ok(!ok(q, String(flip)), 'Lv22: 取り違え');
}
// Lv23: 選択肢の数の値が重ならない。1,024 倍の値は出さない(ここでは 1,000 倍ずつ)
for (const q of gen(23)) {
  const vals = q.options.map((o) => Number(o.replace(/,/g, '')));
  assert.strictEqual(new Set(vals).size, 4, `Lv23: 値が重なる ${q.options}`);
  assert.ok(vals.every((v) => v % 1024 !== 0 || v % 1000 === 0), `Lv23: 1,024 倍の値 ${q.options}`);
}
// Lv24: 8 倍し忘れは不正解
for (const q of gen(24, 500)) assert.ok(!ok(q, String(q.meta.x)), 'Lv24: 8 倍し忘れ');
// Lv37: 正しくない形はどれも IPv4 として読めない。先頭 0 の数は作らない
for (const q of gen(37)) {
  for (const o of q.options) assert.ok(!/(^|\.)0\d/.test(o), `Lv37: 先頭 0 ${o}`);
  assert.strictEqual(q.options.filter((o) => IPV4_RE.test(o)).length, q.meta.pickValid ? 1 : 3, `Lv37: 正しい形の数 ${q.options}`);
}
// Lv38: 255 か 256(何通り)だけ。256 と 255 の取り違えは不正解
{
  const modes = new Set();
  for (const q of gen(38)) { modes.add(q.meta.mode); const a = q.fields[0].accept[0]; assert.ok(a === (q.meta.mode === 'count' ? '256' : '255')); assert.ok(!ok(q, a === '255' ? '256' : '255')); }
  assert.strictEqual(modes.size, 4, 'Lv38: 4 つの問い方');
}
// Lv40: ハイフン区切り(正しい書き方)は誤答に出さない。正しい形の MAC はローカル管理
for (const q of gen(40)) {
  for (const o of q.options) assert.ok(!o.includes('-'), `Lv40: ハイフン区切り ${o}`);
  const valid = q.options.filter((o) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(o));
  assert.strictEqual(valid.length, q.meta.pickValid ? 1 : 3, `Lv40: 正しい形の数 ${q.options}`);
  for (const v of valid) assert.ok(/^.[26ae]/.test(v), `Lv40: ローカル管理でない ${v}`);
}
// Lv44: 127 で始まるのは正解の 1 つだけ。0.0.0.0(「この機器」と読める)は誤答に出さない
for (const q of gen(44)) {
  assert.strictEqual(q.options.filter((o) => o.startsWith('127.')).length, 1, `Lv44: ${q.options}`);
  assert.ok(!q.options.includes('0.0.0.0'), 'Lv44: 0.0.0.0');
}
// Lv42: 誤答の候補はプライベートの範囲の外、正解は範囲の中(作る側とは別に数で確かめる)
{
  const inPriv = (a) => { const [x, y] = a.split('.').map(Number); return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168); };
  for (const r of LEVELS[42].rows) if (IPV4_RE.test(r.attrs.answer)) { assert.ok(inPriv(r.attrs.answer), r.id); for (const w of r.attrs.wrong) assert.ok(!inPriv(w), `${r.id} ${w}`); }
}
// Lv46: 正解は IPv6 として読め、誤答は読めない(作る側とは別の読み方: :: を広げて 8 組)
{
  const isV6 = (s) => {
    if (!/^[0-9a-f:]+$/i.test(s) || (s.match(/::/g) || []).length > 1) return false;
    const [l, r] = s.includes('::') ? s.split('::') : [s, null];
    const L = l ? l.split(':') : []; const R = r ? r.split(':') : [];
    if ([...L, ...R].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
    return r === null ? L.length === 8 : L.length + R.length < 8;
  };
  for (const r of LEVELS[46].rows) if (r.attrs.answer.includes(':') && r.attrs.answer.length > 6) { assert.ok(isV6(r.attrs.answer), r.id); for (const w of r.attrs.wrong) assert.ok(!isV6(w), `${r.id} ${w}`); }
}
// Lv54・55: URL = スキーム://ホスト名 + パス。ドメインは .example
for (const r of LEVELS[54].rows) {
  const { scheme, host, path } = r.attrs;
  assert.strictEqual(r.ja, `${scheme}://${host}${path}`, r.id); assert.ok(['http', 'https'].includes(scheme) && /\.example$/.test(host) && path.startsWith('/'), r.id);
}
// Lv65: 線 → アドレス → 名前 の順。並べる順 6 通りがすべて出る。書き方のゆれ(全角・空白)も正解、逆順は不正解
{
  const orders = new Set();
  for (const q of gen(65, 2000)) {
    const a = q.fields[0].accept[0]; orders.add(a);
    const dashed = a.split('').join('-');
    assert.ok(ok(q, dashed) && ok(q, dashed.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))).replace(/-/g, '－')) && ok(q, a.split('').join(' ')), 'Lv65: 書き方のゆれ');
    assert.ok(!ok(q, a.split('').reverse().join('-')), 'Lv65: 逆順');
  }
  assert.strictEqual(orders.size, 6, 'Lv65: 並べる順 6 通り');
}

console.log(`cl-intro ok: ${Object.keys(LEVELS).length} levels (${Object.entries(distinct).map(([lv, n]) => `${lv}:${n}`).join(' ')})`);
