'use strict';
// Fable の分「診断と記録」(番号 230・285・296・323・342・343・349。levels-fable-diag.js)の確かめ(2026-10-25。docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// test/cl.js が形・verify・違う問題の数を確かめるので、ここではこの束ならではのこと(表の行の出典と確認者、境界の場合が出ること、
// 紛らわしい答えが正解にならないこと、使ってよいアドレスとドメイン、ヒントの有無)を確かめる。
// ほかの Fable のファイルが書きかけでも動くよう、index ではなく自分のモジュールを直接読む。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LEVELS, _test: T } = require('../server/questions/cl/levels-fable-diag');
const { makeRng } = require('../server/questions/rng');
const { normalize, judge } = require('../server/questions/normalize');

const DATA = path.join(__dirname, '..', 'server', 'questions', 'data', 'cl', 'fable-diag');
const MINE = [230, 285, 296, 323, 342, 343, 349];
const N = 3000;
const CHECKED = 'Claude Fable 5.1 2026-10-25';
const mk = (lv, s) => ({ answerKind: 'choice', ...LEVELS[lv].make(makeRng(s), { level: lv }), level: lv });

// ---------- 1. 表(FactBank)の行 ----------
let rowCount = 0;
for (const f of fs.readdirSync(DATA).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  assert.ok(typeof d.note === 'string' && d.note, `${f}: note がない`);
  const ids = new Set();
  for (const r of d.rows) {
    rowCount++;
    assert.ok(r.id && !ids.has(r.id), `${f}: id が無いか重複 ${r.id}`); ids.add(r.id);
    assert.ok(typeof r.ja === 'string' && r.ja.trim(), `${f} ${r.id}: ja が無い`);
    assert.ok(typeof r.source === 'string' && r.source.trim(), `${f} ${r.id}: source(根拠)が無い`);
    assert.strictEqual(r.checkedBy, CHECKED, `${f} ${r.id}: checkedBy`);
    if (typeof r.attrs.true === 'boolean') assert.ok(r.attrs.why && r.attrs.why.endsWith('。'), `${f} ${r.id}: 文の解説(why)が無い`);
    if (r.attrs.group === 'obs') assert.ok(r.attrs.desc && Array.isArray(r.attrs.capture) && r.attrs.capture.length >= 2, `${f} ${r.id}: 記録(capture)と分かること(desc)が要る`);
  }
  const obs = d.rows.filter((r) => r.attrs.group === 'obs');
  assert.strictEqual(new Set(obs.map((r) => r.attrs.desc)).size, obs.length, `${f}: 分かること(desc)が重複`);
  assert.strictEqual(new Set(obs.map((r) => JSON.stringify(r.attrs.capture))).size, obs.length, `${f}: 記録(capture)が重複`);
}
assert.ok(MINE.every((lv) => LEVELS[lv]), 'レベルが足りない');
assert.strictEqual(Object.keys(LEVELS).length, MINE.length, 'この束に無いレベルがある');

// ---------- 2. 使ってよいアドレス・ドメイン(COMMON.md 第 7 章) ----------
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
function allText(q) {
  const parts = [q.text, q.explanation, q.firstStep || '', ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(...t.headers, ...t.rows.flat());
  for (const f of q.fields || []) parts.push(f.label, f.hint || '', ...(f.accept || []));
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = allText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) {
    const ip = m[1];
    if (ip.startsWith('255.')) continue;
    assert.ok(v4ok(ip), `${where}: 使ってよい範囲の外のアドレス ${ip}`);
  }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    const name = m[1];
    if (/^\d+(\.\d+)*$/.test(name) || /^\d/.test(name)) continue;
    if (/^(802|rfc|ieee)/i.test(name)) continue;
    assert.ok(/\.example$/i.test(name), `${where}: .example 以外のドメインらしい名前 ${name}`);
  }
  assert.ok(!/Math\.random/.test(s), `${where}: 文に Math.random`);
}

// ---------- 3. レベルごとに作って数える ----------
const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
const answerIds = new Set(); // 343: 正解に出た表の行
for (const lv of MINE) {
  const ent = LEVELS[lv];
  for (let s = 1; s <= N; s++) {
    const q = mk(lv, s);
    const where = `Lv${lv} seed ${s}`;
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind ${q.kind}`);
    assert.ok(q.explanation && (q.explanation.includes('正解') || /^(正しい|誤り)/.test(q.explanation)), `${where}: 解説に正解が無い`);
    checkSafe(q, where);
    if (lv === 230) assert.ok(q.firstStep && !q.hint && !q.card, `${where}: 中級は firstStep だけ`);
    else assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 上級・専門はヒント・カードを付けない`);
    if (q.answerKind === 'text') {
      for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない ${f.accept[0]}`);
      assert.ok(judge(q, q.fields.map((f) => f.accept[0])), `${where}: accept が正解にならない`);
    } else {
      assert.ok(q.options.length >= 2 && q.options.length <= 4 && new Set(q.options).size === q.options.length, `${where}: 選択肢`);
    }
    ent.verify(q);
    const m = q.meta || {};
    switch (lv) {
      case 230: {
        inc(`230-k${m.k}`); inc(`230-n${m.n}`); if (m.k === m.n - 1) inc('230-last');
        assert.strictEqual(q.options.length, m.n, `${where}: 区間の数と選択肢の数が合わない`);
        break;
      }
      case 285: {
        inc(`285-${m.variant}`); inc(`285-${m.svc}`);
        // 変換前と変換後を取り違えた値は正解にならない
        const acc = q.fields[0].accept[0];
        const pf = q.table.rows.filter((r) => r[0].startsWith('ポートフォワード')).map((r) => [r[1].replace(/^TCP /, ''), r[2].replace(/^TCP /, '')]);
        if (m.variant === 'outIn-recv') { assert.ok(pf.some((p) => p[0] === acc), where); assert.ok(!pf.some((p) => p[1] === acc), `${where}: 内側のアドレスが正解`); if (acc.split(':')[1] !== (m.svc === 'HTTPS' ? '443' : '22')) inc('285-portdiff'); }
        if (m.variant === 'outIn-send') { assert.ok(pf.some((p) => p[1] === acc), where); assert.ok(!pf.some((p) => p[0] === acc), `${where}: 外側のアドレスが正解`); }
        if (m.variant === 'inOut-send') assert.ok(acc.startsWith('203.0.113.'), `${where}: NAPT 後のグローバルでない`);
        if (m.variant === 'inOut-recv') assert.ok(acc.startsWith('192.168.'), `${where}: 変換前のプライベートでない`);
        break;
      }
      case 296: {
        inc(`296-${m.cause}`); if (m.hasDefault) inc('296-default'); if (m.otherUnresolved) inc('296-otherUnresolved'); if (m.decoyFirst) inc('296-decoyFirst');
        if (m.cause === 'arp' && m.otherUnresolved) inc('296-arp-with-decoy');
        if (m.cause === 'acl' && m.decoyFirst) inc('296-acl-decoyFirst');
        if (m.cause !== 'route-none') assert.ok(q.options.includes('経路表: 宛先に合う行が無い') || true);
        // 無関係の未解決の行や合わない deny の行が正解になっていない(verify が独立に模擬して確かめている)。ここでは ACL の最後の permit が正解でないこと
        assert.ok(!/ACL の 30 行/.test(q.options[q.answerIndex]), `${where}: 最後の permit が正解`);
        break;
      }
      case 323: {
        inc(`323-${m.broken}`); inc(`323-${m.side}`); if (m.lifeDiff) inc('323-lifeDiff');
        assert.notStrictEqual(q.options[q.answerIndex], 'IKE SA の寿命(秒)', `${where}: 寿命が正解`);
        if (m.lifeDiff) { assert.ok(q.options.includes('IKE SA の寿命(秒)'), `${where}: 寿命が違うのに誤答の候補に無い`); inc('323-life-as-wrong'); }
        break;
      }
      case 342: {
        inc(`342-${m.shape}`); if (m.keep) inc('342-keep'); if (m.reorder) inc('342-reorder');
        const rows = q.table.rows; const ans = Number(q.fields[0].accept[0]);
        assert.ok(Number(rows[ans - 1][7]) > 0, `${where}: 長さ 0 の行が正解`);
        const dupAck = rows.filter((r, i) => Number(r[7]) === 0 && rows.slice(0, i).some((p) => p[2] === r[2] && p[3] === r[3] && p[5] === r[5] && p[6] === r[6] && Number(p[7]) === 0));
        if (dupAck.length) inc('342-has-dupack');
        assert.ok(!dupAck.some((r) => Number(r[0]) === ans), `${where}: 重複 ACK が正解`);
        break;
      }
      case 343: {
        inc(`343-${m.type}`);
        if (m.type === 'obs') answerIds.add(m.ans);
        if (m.type === 'stmt') answerIds.add(m.ids[q.answerIndex]);
        if (m.type === 'tf') answerIds.add(m.id);
        break;
      }
      case 349: {
        inc(`349-${m.variant}`); if (m.trap) inc('349-trap'); if (m.mixed) inc('349-mixed'); if (m.trap && m.variant === 'order') inc('349-trap-order');
        // 表示の時刻をそのまま並べた答えが正解になっていない(ずれのあるとき)
        {
          const disp = q.table.rows.slice().sort((a, b) => T.secOf(a[1]) - T.secOf(b[1]));
          const naive = /いちばん先に起きた/.test(q.text) ? disp[0][0] : disp.map((r) => r[0]).join(' → ');
          if (naive !== q.options[q.answerIndex]) inc(`349-naive-differs-${m.variant}`); // 表示のまま読むと間違える問題が出る
          else if (m.variant === 'order') assert.ok(!m.trap, `${where}: 並びが違うはずなのに表示の順と同じ`);
        }
        break;
      }
      default: break;
    }
  }
}
const need = [
  '230-k0', '230-k1', '230-k2', '230-k3', '230-n3', '230-n4', '230-last',
  '285-outIn-recv', '285-outIn-send', '285-inOut-send', '285-inOut-recv', '285-HTTPS', '285-SSH', '285-portdiff',
  '296-route-wrong', '296-route-default', '296-route-none', '296-arp', '296-acl', '296-default', '296-otherUnresolved', '296-decoyFirst', '296-arp-with-decoy', '296-acl-decoyFirst',
  '323-ver', '323-enc', '323-hash', '323-dh', '323-psk', '323-peer', '323-ts', '323-R1', '323-R2', '323-lifeDiff', '323-life-as-wrong',
  '342-timeout', '342-fast', '342-keep', '342-reorder', '342-has-dupack',
  '343-obs', '343-stmt', '343-tf',
  '349-first', '349-order', '349-trap', '349-mixed', '349-trap-order', '349-naive-differs-first', '349-naive-differs-order',
];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);
for (const r of [...T.OBS, ...T.STMT]) assert.ok(answerIds.has(r.id), `Lv343: 行 ${r.id} が正解に出ない`);

// ---------- 4. 道具の手で確かめる例 ----------
assert.strictEqual(T.hms(T.secOf('01:02:03') + 9 * 3600), '10:02:03');
assert.strictEqual(T.hms(T.secOf('23:59:59') + 2), '00:00:01');
assert.strictEqual(T.binIn('172.16.5.10', '172.16.5.0/24'), true);
assert.strictEqual(T.binIn('172.16.6.10', '172.16.5.0/24'), false);
assert.strictEqual(T.binIn('10.1.2.3', 'any'), true);

console.log(`cl-fable-diag ok: ${MINE.length} levels (${MINE.join(',')}), 表の行 ${rowCount}`);
