'use strict';
// Fable の分(冗長と経路: 255・256・259・260・262・263・266・268・269・327)の確かめ(2026-10-25。docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// 自分のモジュールを直接読み、seed 1〜3000 で作って確かめる(ほかの担当のファイルが書きかけでも動くように、cl の index は読まない)。
// test/cl.js が形・verify(生成は 1 万問)・違う問題の数を確かめるので、ここではこの束ならではのこと(表の行の出典と確認者、境界の場合が出ること、使ってよいアドレス)を確かめる。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeRng } = require('../server/questions/rng');
const { normalize } = require('../server/questions/normalize');
const MOD = require('../server/questions/cl/levels-fable-route');

const DATA = path.join(__dirname, '..', 'server', 'questions', 'data', 'cl', 'fable-route');
const LV = Object.keys(MOD.LEVELS).map(Number).sort((a, b) => a - b);
const N = 3000;
const CHECKED = 'Claude Fable 5.1 2026-10-25';

// ---------- 1. 表(FactBank)の行 ----------
let rowCount = 0;
const banks = {};
for (const f of fs.readdirSync(DATA).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  banks[f] = d.rows;
  assert.ok(typeof d.note === 'string' && d.note, `${f}: note がない`);
  const ids = new Set();
  for (const r of d.rows) {
    rowCount++;
    assert.ok(r.id && !ids.has(r.id), `${f}: id が無いか重複 ${r.id}`); ids.add(r.id);
    assert.ok(typeof r.ja === 'string' && r.ja.trim(), `${f} ${r.id}: ja が無い`);
    assert.ok(typeof r.source === 'string' && r.source.trim(), `${f} ${r.id}: source(根拠)が無い`);
    assert.strictEqual(r.checkedBy, CHECKED, `${f} ${r.id}: checkedBy`);
    if (typeof r.attrs.true === 'boolean') assert.ok(r.attrs.why && r.attrs.why.endsWith('。'), `${f} ${r.id}: 文の解説(why)が無い`);
    if (r.attrs.group) assert.ok(r.attrs.desc && !r.attrs.desc.endsWith('。'), `${f} ${r.id}: 説明(desc)が無いか句点で終わる`);
  }
  assert.strictEqual(new Set(d.rows.map((r) => r.ja)).size, d.rows.length, `${f}: 同じ文・名前が 2 行ある`);
  const groups = {};
  for (const r of d.rows.filter((x) => x.attrs.group)) (groups[r.attrs.group] = groups[r.attrs.group] || []).push(r);
  for (const [g, rs] of Object.entries(groups)) {
    assert.ok(rs.length >= 3, `${f} ${g}: 用語が 3 つ未満`);
    assert.strictEqual(new Set(rs.map((r) => r.attrs.desc)).size, rs.length, `${f} ${g}: 説明が重複`);
  }
  const st = d.rows.filter((r) => typeof r.attrs.true === 'boolean');
  assert.ok(st.filter((r) => r.attrs.true).length >= 4 && st.filter((r) => !r.attrs.true).length >= 4, `${f}: 正しい文・誤った文が 4 つずつ要る`);
}

// ---------- 2. 使ってよいアドレス・ドメイン(COMMON.md 第 7 章) ----------
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
function allText(q) {
  const parts = [q.text, q.explanation, ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(...t.headers, ...t.rows.flat());
  for (const f of q.fields || []) parts.push(f.label, f.hint || '', ...(f.accept || []));
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = allText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) {
    if (m[1].startsWith('255.')) continue;
    assert.ok(v4ok(m[1]), `${where}: 使ってよい範囲の外のアドレス ${m[1]}`);
  }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    const name = m[1];
    if (/^\d+(\.\d+)*$/.test(name) || /^\d/.test(name) || /^(802|rfc|ieee)/i.test(name)) continue;
    assert.ok(/\.example$/i.test(name), `${where}: .example 以外のドメインらしい名前 ${name}`);
  }
  for (const as of s.matchAll(/AS (\d{5})/g)) assert.ok(Number(as[1]) >= 64512 && Number(as[1]) <= 65534, `${where}: プライベートでない AS 番号 ${as[1]}`);
}

// ---------- 3. レベルごとに作って数える ----------
const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
const answerIds = {};
for (const lv of LV) {
  const ent = MOD.LEVELS[lv];
  for (let s = 1; s <= N; s++) {
    const q = ent.make(makeRng(s), { level: lv, node: null });
    const where = `Lv${lv} seed ${s}`;
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind`);
    assert.ok(typeof q.explanation === 'string' && q.explanation.includes('正解は') || q.options?.[0] === '○', `${where}: 解説に正解が書かれていない`);
    assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 上級・専門はヒント・カードを付けない`);
    if (q.answerKind === 'text') for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない ${f.accept[0]}`);
    else { assert.strictEqual(new Set(q.options).size, q.options.length, `${where}: 選択肢が重複`); assert.ok(q.answerIndex >= 0 && q.answerIndex < q.options.length, `${where}: answerIndex`); }
    ent.verify(q);
    checkSafe(q, where);
    const m = q.meta || {};
    if (m.type === 'stmt' || m.type === 'term' || m.type === 'termRev' || m.type === 'tf') (answerIds[lv] = answerIds[lv] || new Set()).add(m.type === 'tf' ? m.id : m.ids[q.answerIndex]);
    switch (lv) {
      case 255: inc(`255-${m.kind}`); if (m.strTrap) inc('255-strTrap'); break;
      case 256: inc(`256-${m.ev}`); inc(`256-setup-${m.setupKind}`); if (m.tieAfter) inc('256-tieAfter'); {
        // 優先度だけで決めた答え(preempt なしの戻りで元の代表)が正解になっていない
        if (m.ev === 'return-nopreempt') { const M = /(R\d) が止まり/.exec(q.text)[1]; assert.notStrictEqual(q.options[q.answerIndex], M, `${where}: preempt なしなのに元の代表が正解`); }
        if (m.ev === 'return-owner') { const M = /(R\d) が止まり/.exec(q.text)[1]; assert.strictEqual(q.options[q.answerIndex], M, `${where}: 持ち主が戻らない`); assert.ok(q.table.rows.some((r) => r[0] === M && r[3] === 'なし'), `${where}: 持ち主の preempt が「なし」でない`); }
      } break;
      case 260: inc(`260-${m.variant}-${m.mis || 'ok'}`); {
        // 関係ない項目(ルーター ID・帯域・プロセス番号)が正解にならない
        if (m.variant === 'why') assert.ok(!['ルーター ID', 'IF の帯域', 'プロセス番号'].includes(q.options[q.answerIndex]), `${where}: 関係ない項目が正解`);
        const rid = q.table.rows.find((r) => r[0] === 'ルーター ID'); assert.notStrictEqual(rid[1], rid[2], `${where}: ルーター ID が同じ`);
      } break;
      case 262: inc(`262-${m.kind}`); inc(`262-${m.late ? 'late' : 'sim'}`); inc(`262-${m.role}`); if (m.strTrap) inc('262-strTrap'); {
        if (m.late) { const lateRow = q.table.rows.find((r) => r[3] === 'あとから'); assert.notStrictEqual(q.options[q.answerIndex], lateRow[0], `${where}: あとから来たルーターが ${m.role}`); const top = Math.max(...q.table.rows.map((r) => Number(r[1]))); assert.strictEqual(Number(lateRow[1]), top, `${where}: あとから来たルーターの優先度がいちばん高くない(わなになっていない)`); }
        for (const r of q.table.rows) if (r[1] === '0') assert.notStrictEqual(q.options[q.answerIndex], r[0], `${where}: 優先度 0 が ${m.role}`);
      } break;
      case 268: case 269: inc(`${lv}-n${m.n}`); if (m.trap) inc(`${lv}-trap`); {
        // 268 で AS パスが短い方、269 で LOCAL_PREF が大きい方だけが正解。269 では AS パスが最短の経路が正解でない場合がある(trap)
        const rows = q.table.rows; const win = rows.find((r) => r[0] === q.options[q.answerIndex]);
        if (lv === 268) for (const r of rows) if (r !== win) assert.ok(r[3].split(' ').length > win[3].split(' ').length, `${where}: AS パスが最短でない経路が正解`);
        if (lv === 269) { for (const r of rows) if (r !== win) assert.ok(Number(r[2]) < Number(win[2]), `${where}: LOCAL_PREF が最大でない経路が正解`); if (m.trap) assert.ok(rows.some((r) => r !== win && r[3].split(' ').length < win[3].split(' ').length), `${where}: trap の印なのに AS パスが短い経路が無い`); }
      } break;
      case 327: inc(`327-${m.t}`); if (m.t === 'ospf-when' && m.d > 0) inc('327-ospf-when-late'); if (q.fields[0].accept[0].includes('.')) inc('327-decimal'); break;
      default: break;
    }
  }
}
const need = [
  '255-prio', '255-tie', '255-owner', '255-strTrap',
  '256-down', '256-other-down', '256-return-preempt', '256-return-nopreempt', '256-return-owner', '256-setup-tie', '256-setup-owner', '256-tieAfter',
  '260-tf-ok', '260-tf-area', '260-why-area', '260-why-hello', '260-why-dead', '260-why-net', '260-why-mask', '260-why-auth', '260-why-stub', '260-tf-mask', '260-tf-stub',
  '262-prio', '262-tie', '262-p0', '262-sim', '262-late', '262-DR', '262-BDR', '262-strTrap',
  '268-n2', '268-n4', '268-trap', '269-n2', '269-n4', '269-trap',
  '327-ospf-max', '327-ospf-min', '327-ospf-when', '327-ospf-when-late', '327-vrrp', '327-vrrp-when', '327-decimal',
];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);

// 表のレベル: 文と用語の行が、どれも正解として 1 回は出る(使われない行を残さない)
for (const [lv, f] of [[259, 'rstp.json'], [263, 'ospf-area.json'], [266, 'redistribute.json']]) {
  for (const r of banks[f]) assert.ok(answerIds[lv] && answerIds[lv].has(r.id), `Lv${lv}: 行 ${r.id} が正解に出ない`);
}

// ---------- 4. 道具の手で確かめる例(LEVEL-LIST の例と、文字と数の比べ方) ----------
const T = MOD._test;
const vip = '192.168.1.1';
const mk = (name, prio, host) => ({ name, prio, addr: `192.168.1.${host}`, preempt: true });
assert.strictEqual(T.vrrpElect([mk('R1', 120, 2), mk('R2', 100, 3)], vip).name, 'R1'); // LEVEL-LIST の例: 120 と 100 → R1
assert.strictEqual(T.vrrpElect([mk('R1', 100, 9), mk('R2', 100, 10)], vip).name, 'R2'); // 同じ優先度は数として大きいアドレス(10 > 9)
assert.strictEqual(T.electByText([mk('R1', 100, 9), mk('R2', 100, 10)], vip).name, 'R2');
assert.strictEqual(T.vrrpElect([mk('R1', 250, 2), { name: 'R2', prio: 255, addr: vip }], vip).name, 'R2'); // 持ち主
assert.throws(() => T.electByText([mk('R1', 255, 2), mk('R2', 100, 3)], vip), /255/); // 持ち主でないのに 255 は作らない
const route = (lp, len, origin = 'IGP') => ({ lp, path: new Array(len).fill(64512), origin });
assert.deepStrictEqual(T.bgpDecide([route(100, 2), route(100, 3)]), { idx: 0, step: 'aspath' }); // LEVEL-LIST の例: AS パス 2 個と 3 個 → 2 個
assert.deepStrictEqual(T.bgpDecide([route(200, 3), route(100, 2)]), { idx: 0, step: 'localpref' }); // LOCAL_PREF 200(長い方)が勝つ
assert.strictEqual(T.bgpDecide([route(100, 2), route(100, 2)]), null); // 同点は作らない
assert.strictEqual(T.frac256(BigInt(3 * 1 * 256 + (256 - 128) * 1)), '3.5'); // VRRP: 広告 1 秒・優先度 128 → 3.5 秒
assert.strictEqual(T.frac256(BigInt(3 * 4 * 256 + (256 - 128) * 4)), '14');
assert.strictEqual(T.frac256(BigInt(3 * 1 * 256 + (256 - 240) * 1)), '3.0625');

console.log(`cl-fable-route ok: ${LV.length} levels (${LV.join(',')}), 表の行 ${rowCount}`);
