'use strict';
// 専門の生成・入力の 8 項目(320・321・334・335・337・338・340・348。levels-expert.js)の確かめ(2026-10-25。docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// 自分のモジュールを直接読み、seed 1〜3000 で作って、境界の場合が出ること・accept が正規形であること・使ってよいアドレスだけであることを確かめる(index は読まない)
const assert = require('assert');
const { makeRng } = require('../server/questions/rng');
const { normalize, judge } = require('../server/questions/normalize');
const EX = require('../server/questions/cl/levels-expert');

const LV = Object.keys(EX.LEVELS).map(Number).sort((a, b) => a - b);
const N = 3000;
const make = (lv, seed) => ({ answerKind: 'choice', ...EX.LEVELS[lv].make(makeRng(seed), { level: lv }), level: lv });

// 使ってよいアドレス・ドメイン(COMMON.md 第 7 章)
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
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) { if (m[1].startsWith('255.')) continue; assert.ok(v4ok(m[1]), `${where}: 使ってよい範囲の外のアドレス ${m[1]}`); }
  for (const m of s.matchAll(/(?<![0-9a-f:])([0-9a-f]{1,4}:[0-9a-f:]*:[0-9a-f]*)(?![0-9a-f:])/gi)) { if (/^\d\d:\d\d:\d\d$/.test(m[1])) continue; assert.ok(/^2001:db8:/i.test(m[1]), `${where}: 2001:db8 でない IPv6 ${m[1]}`); }
  for (const m of s.matchAll(/\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b/gi)) assert.ok(/\.example$/i.test(m[1]), `${where}: .example 以外のドメインらしい名前 ${m[1]}`);
}

const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
for (const lv of LV) {
  const ent = EX.LEVELS[lv];
  assert.strictEqual(ent.kind, '生', `Lv${lv}: 作り方は生`);
  for (let s = 1; s <= N; s++) {
    const q = make(lv, s);
    const where = `Lv${lv} seed ${s}`;
    checkSafe(q, where);
    assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 専門はヒント・カードを付けない`);
    assert.ok(q.explanation && q.explanation.includes('正解は'), `${where}: 解説に正解が無い`);
    ent.verify(q);
    if (q.answerKind === 'text') {
      for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない ${f.accept[0]}`);
      assert.ok(judge(q, q.fields.map((f) => f.accept[0])), `${where}: accept が正解にならない`);
    } else {
      assert.ok(q.options.length >= 2 && q.options.length <= 4 && new Set(q.options).size === q.options.length, `${where}: 選択肢の形`);
    }
    const m = q.meta || {};
    switch (lv) {
      case 320: inc(`320-${m.equal ? 'equal' : 'hosts'}-${m.ask}`); if (m.ask === 'kth' && m.k === 1) inc('320-k1'); if (m.ask === 'kth' && m.k === m.n) inc('320-klast'); if (m.n === 8) inc('320-n8'); if (m.plen === 24) inc('320-p24');
        if (m.ask === 'all') { // 行を入れ替えた入力・大文字・全角の入力も正解になる
          const lines = q.fields[0].accept[0].split('\n');
          assert.ok(judge(q, [lines.slice().reverse().map((l) => l.toUpperCase()).join('\n')]), `${where}: 行の順を変えた計画が不正解`);
          assert.ok(!judge(q, [lines.slice(1).join('\n')]), `${where}: 行の足りない計画が正解`);
        }
        break;
      case 321: inc(`321-${m.t}`); if (m.t !== 'count') { inc(`321-S${m.S}`); if (m.edge) inc('321-edge'); if (m.k === 1) inc('321-k1'); if (m.k === 2 ** (m.S - 48)) inc('321-klast'); if (m.k === 257) inc('321-k257'); }
        if (m.t === 'kth') assert.ok(!judge(q, [q.fields[0].accept[0].replace(/\/\d+$/, '/48')]), `${where}: 親の長さで答えて正解になる`);
        break;
      case 334: inc(`334-${m.t}`); inc(`334-n${m.n}`); if (m.kinds.includes('isolated')) inc('334-iso'); if (m.kinds.filter((k) => k === 'private').length >= 2) inc('334-2private'); break;
      case 335: inc(`335-${m.t}`); if (m.edge) inc('335-edge'); if (m.t === 'count' && m.bits === 8) inc('335-bits8'); if (m.t === 'usable' && m.L === 28) inc('335-L28');
        if (m.t === 'usable') assert.ok(!judge(q, [String(Number(q.fields[0].accept[0]) + 3)]), `${where}: 2 つ引いた数が正解になる`);
        break;
      case 337: inc(`337-${m.t}`); if (m.wrap) inc('337-wrap'); if (m.k === m.cycleLen) inc('337-exact'); if (m.n === 5) inc('337-n5'); break;
      case 338: inc(`338-${m.t}`); inc(`338-out${m.outN}-in${m.inM}`); if (m.outs >= 2) inc('338-2out'); break;
      case 340: inc(`340-${m.t}`); if (m.t === 'downCount' && m.count === 0) inc('340-down0'); if (m.t === 'downCount' && m.count >= 3) inc('340-down3'); if (m.n === 8) inc('340-n8');
        assert.ok(/"operStatus"/.test(q.text) && !q.table, `${where}: JSON が本文に無い`);
        break;
      case 348: inc(`348-${m.variant}`); if (m.trap) inc('348-trap'); if (m.kinds === 3) inc('348-3kinds'); if (m.n === 4) inc('348-n4');
        assert.ok(/JST|UTC|\+09:00/.test(q.table.rows.map((r) => r[1]).join(' ')), `${where}: 時刻の表し方`);
        break;
      default: break;
    }
  }
}
const need = [
  '320-equal-kth', '320-equal-all', '320-hosts-kth', '320-hosts-all', '320-k1', '320-klast', '320-n8', '320-p24',
  '321-kth', '321-which', '321-count', '321-S52', '321-S56', '321-S60', '321-edge', '321-k1', '321-klast', '321-k257',
  '334-public', '334-inbound', '334-egress', '334-noEgress', '334-kind', '334-n3', '334-n4', '334-iso', '334-2private',
  '335-count', '335-usable', '335-minlen', '335-edge', '335-bits8', '335-L28',
  '337-rr', '337-weighted', '337-skip', '337-wrap', '337-exact', '337-n5',
  '338-out', '338-in', '338-next', '338-out2-in2', '338-out3-in3', '338-2out',
  '340-downCount', '340-adminUpDown', '340-upCount', '340-down0', '340-down3', '340-n8',
  '348-order', '348-first', '348-trap', '348-3kinds', '348-n4',
];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);

// ---------- 道具の手で確かめる例 ----------
const T = EX._test;
assert.strictEqual(T.sizeFor(126), 128); assert.strictEqual(T.sizeFor(127), 256); assert.strictEqual(T.sizeFor(2), 4); assert.strictEqual(T.sizeFor(3), 8);
assert.strictEqual(T.planAccept([['B', '10.0.64.0/18'], ['A', '10.0.0.0/18']]), 'a 10.0.0.0/18\nb 10.0.64.0/18');
assert.strictEqual(normalize('prefixplan', 'B 10.0.64.0/18\nA 10.0.0.0/18'), 'a 10.0.0.0/18\nb 10.0.64.0/18');
assert.strictEqual(T.v6Of((0x20010db8n << 96n) | (0x100n << 80n) | (0x200n << 64n)), '2001:db8:100:200::'); // LEVEL-LIST の例(3 拠点目 → :200::/56)
assert.strictEqual(T.fmtTime(3600 + 240, 'jst'), '10:04:00 JST'); assert.strictEqual(T.fmtTime(3600 + 240, 'iso'), '2026-10-25T10:04:00+09:00'); assert.strictEqual(T.fmtTime(3600 + 240, 'utc'), '01:04:00 UTC');
// 同じ seed で同じ問題
for (const lv of LV) assert.deepStrictEqual(make(lv, 77), make(lv, 77), `Lv${lv}: 同じ seed で違う問題`);

console.log(`cl-expert ok: ${LV.length} levels (${LV.join(',')})`);
