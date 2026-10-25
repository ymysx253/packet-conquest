'use strict';
// 専門の「表」の 8 項目(levels-expert-facts.js: 332・333・336・339・341・346・347・350)の確かめ(2026-10-25。docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// 自分のモジュールと rng だけで動かす(ほかの担当のファイルが書きかけでも確かめられるように、server/questions/cl の index は読まない)。
// 見ること: 表の行の出典と確認者、同じ group の重複、文の全行が正解に出る、336 の規則表の型(通る・通らない・足す行)が出る、ヒントが無い、使ってよいアドレス
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeRng } = require('../server/questions/rng');
const M = require('../server/questions/cl/levels-expert-facts');

const DATA = path.join(__dirname, '..', 'server', 'questions', 'data', 'cl', 'expert');
const MINE = ['332-sdn.json', '333-overlay.json', '336-stateless.json', '339-cdn.json', '341-automation.json', '346-change.json', '347-diagram.json', '350-incident.json'];
const LEVELS = Object.keys(M.LEVELS).map(Number).sort((a, b) => a - b);
const N = 3000;

// ---------- 1. 表の行 ----------
let rowCount = 0;
for (const f of MINE) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  assert.ok(typeof d.note === 'string' && d.note, `${f}: note がない`);
  const ids = new Set(); let stmts = 0, terms = 0;
  for (const r of d.rows) {
    rowCount++;
    assert.ok(r.id && !ids.has(r.id), `${f}: id が無いか重複 ${r.id}`); ids.add(r.id);
    assert.ok(typeof r.ja === 'string' && r.ja.trim(), `${f} ${r.id}: ja が無い`);
    assert.ok(typeof r.source === 'string' && r.source.trim(), `${f} ${r.id}: source(根拠)が無い`);
    assert.strictEqual(r.checkedBy, 'Claude Fable 5.1 2026-10-25', `${f} ${r.id}: checkedBy`);
    if (typeof r.attrs.true === 'boolean') { stmts++; assert.ok(r.attrs.why && r.attrs.why.endsWith('。'), `${f} ${r.id}: why が無い`); }
    if (r.attrs.group) { terms++; assert.ok(r.attrs.desc && !r.attrs.desc.endsWith('。'), `${f} ${r.id}: desc が無いか句点で終わる`); }
  }
  assert.ok(stmts >= 10, `${f}: 文が ${stmts} 行(10 以上要る)`);
  assert.ok(terms >= 4, `${f}: 用語が ${terms} 行(4 以上要る)`);
  const groups = {};
  for (const r of d.rows.filter((x) => x.attrs.group)) (groups[r.attrs.group] = groups[r.attrs.group] || []).push(r);
  for (const [g, rs] of Object.entries(groups)) {
    assert.strictEqual(new Set(rs.map((r) => r.ja)).size, rs.length, `${f} ${g}: 名前が重複`);
    assert.strictEqual(new Set(rs.map((r) => r.attrs.desc)).size, rs.length, `${f} ${g}: 説明が重複`);
  }
  assert.strictEqual(new Set(d.rows.filter((r) => typeof r.attrs.true === 'boolean').map((r) => r.ja)).size, stmts, `${f}: 同じ文が 2 行ある`);
}

// ---------- 2. 使ってよいアドレス・ドメイン ----------
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
function allText(q) {
  const parts = [q.text, q.explanation, ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(...t.headers, ...t.rows.flat());
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = allText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) { if (m[1].startsWith('255.')) continue; assert.ok(v4ok(m[1]), `${where}: 使ってよい範囲の外のアドレス ${m[1]}`); }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    const name = m[1];
    if (/^\d/.test(name) || /^(802|rfc|ieee)/i.test(name)) continue;
    assert.ok(/\.example$/i.test(name), `${where}: .example 以外のドメインらしい名前 ${name}`);
  }
}

// ---------- 3. 作って数える ----------
const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
const answerIds = {};
for (const lv of LEVELS) {
  const ent = M.LEVELS[lv];
  const seen = new Set();
  for (let s = 1; s <= N; s++) {
    const q = ent.make(makeRng(s));
    const where = `Lv${lv} seed ${s}`;
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind`);
    assert.ok(q.text && q.explanation, `${where}: 文か解説が無い`);
    assert.ok(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 && new Set(q.options).size === q.options.length, `${where}: 選択肢`);
    assert.ok(q.answerIndex >= 0 && q.answerIndex < q.options.length, `${where}: answerIndex`);
    assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 専門はヒント・カードを付けない`);
    ent.verify(q);
    checkSafe(q, where);
    seen.add(JSON.stringify([q.text, q.options, q.table || null]));
    const m = q.meta || {};
    if (m.type === 'stmt' || m.type === 'tf') (answerIds[lv] = answerIds[lv] || new Set()).add(m.type === 'tf' ? m.id : m.ids[q.answerIndex]);
    inc(`${lv}-${m.type}`);
    if (lv === 336) { if (m.type === 'rulePass') inc(`336-pass-${m.shape}-${m.pass ? 'ok' : 'ng'}`); if (m.type === 'ruleAdd' && m.trap) inc('336-add-trap'); }
  }
  assert.ok(seen.size >= 20, `Lv${lv}: 違う問題が ${seen.size} 通りしか作れない`);
}
for (const k of ['336-pass-allow-ok', '336-pass-none-ng', '336-pass-wrong-net-ng', '336-pass-wrong-port-ng', '336-pass-deny-first-ng', '336-add-trap', '336-ruleAdd', '336-stmt', '336-term']) assert.ok(tally[k] > 0, `場合が出ていない: ${k}`);
for (const lv of LEVELS) for (const t of ['stmt', 'tf', 'term']) assert.ok(tally[`${lv}-${t}`] > 0, `Lv${lv}: ${t} の型が出ていない`);
// 文の全行が正解に 1 回は出る(使われない行を残さない)
for (const lv of LEVELS) for (const r of M._test.BANKS[lv].filter((x) => typeof x.attrs.true === 'boolean')) assert.ok(answerIds[lv].has(r.id), `Lv${lv}: 文 ${r.id} が正解に出ない`);

// ---------- 4. 道具の手で確かめる例 ----------
const T = M._test;
const ret = { proto: 'TCP', src: '198.51.100.9', dport: 51000 };
assert.strictEqual(T.ruleHit({ act: '許可', proto: 'TCP', src: 'any', ports: '1024〜65535' }, ret), true);
assert.strictEqual(T.ruleHit({ act: '許可', proto: 'TCP', src: 'any', ports: '443' }, ret), false, '宛先ポート 443 の行は返りに合わない');
assert.strictEqual(T.ruleHit({ act: '許可', proto: 'UDP', src: 'any', ports: '1024〜65535' }, ret), false);
assert.strictEqual(T.ruleHit({ act: '許可', proto: 'TCP', src: '203.0.113.0/24', ports: '1024〜65535' }, ret), false);
assert.deepStrictEqual(T.parseRuleText('許可 TCP 送信元 198.51.100.0/24 宛先ポート 1024〜65535'), { act: '許可', proto: 'TCP', src: '198.51.100.0/24', ports: '1024〜65535' });

console.log(`cl-expert-facts ok: ${LEVELS.length} levels (${LEVELS.join(',')}), 表の行 ${rowCount}`);
