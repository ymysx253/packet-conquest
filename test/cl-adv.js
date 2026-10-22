'use strict';
// 上級(新しい番号 253〜319)の問題の確かめ(2026-10-22。docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// test/cl.js が形・verify(生成は 1 万問)・違う問題の数を確かめるので、ここでは上級ならではのこと
// (表の行の出典と確認者、境界の場合が出ること、紛らわしい答えが正解にならないこと、使ってよいアドレスとドメイン)を確かめる。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LEVELS, getClQuestion } = require('../server/questions/cl');
const { normalize } = require('../server/questions/normalize');
const ADV = require('../server/questions/cl/levels-adv');

const DATA = path.join(__dirname, '..', 'server', 'questions', 'data', 'cl', 'adv');
const ADV_LEVELS = Object.keys(ADV.LEVELS).map(Number).sort((a, b) => a - b);
const N = 3000;

// ---------- 1. 表(FactBank)の行 ----------
const seenJa = new Map();
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
    assert.strictEqual(r.checkedBy, 'Claude Opus 5.5 2026-10-22', `${f} ${r.id}: checkedBy`);
    if (typeof r.attrs.true === 'boolean') {
      assert.ok(r.attrs.why && r.attrs.why.endsWith('。'), `${f} ${r.id}: 文の解説(why)が無い`);
      const prev = seenJa.get(r.ja);
      assert.ok(prev === undefined || prev === r.attrs.true, `${f} ${r.id}: 同じ文が別の表で正誤が逆`);
      seenJa.set(r.ja, r.attrs.true);
    }
    if (r.attrs.group) assert.ok(r.attrs.desc && !r.attrs.desc.endsWith('。'), `${f} ${r.id}: 説明(desc)が無いか句点で終わる`);
  }
  // 同じ group の説明・名前が重ならない(正解が 2 つにならない)
  const groups = {};
  for (const r of d.rows.filter((x) => x.attrs.group)) (groups[r.attrs.group] = groups[r.attrs.group] || []).push(r);
  for (const [g, rs] of Object.entries(groups)) {
    assert.strictEqual(new Set(rs.map((r) => r.ja)).size, rs.length, `${f} ${g}: 名前が重複`);
    assert.strictEqual(new Set(rs.map((r) => r.attrs.desc)).size, rs.length, `${f} ${g}: 説明が重複`);
  }
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
    const ip = m[1];
    if (ip.startsWith('255.')) continue; // サブネットマスク
    assert.ok(v4ok(ip), `${where}: 使ってよい範囲の外のアドレス ${ip}`);
  }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    const name = m[1];
    if (/^\d+(\.\d+)*$/.test(name) || /^\d/.test(name)) continue; // 数・アドレス
    if (/^(802|rfc|ieee)/i.test(name)) continue;
    assert.ok(/\.example$/i.test(name) || /^_?domainkey$/.test(name), `${where}: .example 以外のドメインらしい名前 ${name}`);
  }
  assert.ok(!/Math\.random/.test(s), `${where}: 文に Math.random`);
}

// ---------- 3. レベルごとに作って数える ----------
const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
const answerIds = {}; // 表のレベル: 正解に出た行
for (const lv of ADV_LEVELS) {
  for (let s = 1; s <= N; s++) {
    const q = getClQuestion({ level: lv, seed: s });
    const where = `Lv${lv} seed ${s}`;
    checkSafe(q, where);
    assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 上級はヒント・カードを付けない`);
    if (q.answerKind === 'text') for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない ${f.accept[0]}`);
    const m = q.meta || {};
    if (m.type === 'stmt' || m.type === 'term' || m.type === 'termRev') (answerIds[lv] = answerIds[lv] || new Set()).add(m.ids ? m.ids[q.answerIndex] : null);
    switch (lv) {
      case 254: inc(`254-${m.type}`); if (m.type === 'count') inc(`254-count-${q.fields[0].accept[0]}`); break;
      case 261: {
        if (m.clamp) inc('261-clamp'); if (m.frac) inc('261-frac');
        // 1 より小さいコストを 0 のまま足す誤りは正解にならない
        const ref = m.ref; const parse = (x) => { const t = /^([\d.]+) (Mbps|Gbps)$/.exec(x.trim()); return t[2] === 'Gbps' ? Math.round(parseFloat(t[1]) * 1000) : Number(t[1]); };
        const naive = Math.min(...q.table.rows.map((r) => r[1].split('→').reduce((a, x) => a + Math.floor(ref / parse(x)), 0)));
        if (m.clamp && naive !== Number(q.fields[0].accept[0])) inc('261-clamp-matters');
        break;
      }
      case 264: inc(`264-${m.full ? 'full' : 'mixed'}`); if (m.L === 16) inc('264-L16'); if (m.L === 26) inc('264-L26'); break;
      case 272: {
        inc(`272-${m.type}`);
        const ans = Number(q.fields[0].accept[0]);
        const ttls = [...q.table.rows[0][1].matchAll(/TTL (\d+) 秒/g)].map((x) => Number(x[1]));
        assert.ok(ans > 0 && ans <= Math.max(...ttls), `${where}: TTL の残りが範囲外`);
        if (m.type === 'refetch') { const e2 = Number(q.table.rows[2][0]); assert.notStrictEqual(ans, ttls[0] - e2, `${where}: 聞き直しを見落とした値が正解`); }
        break;
      }
      case 273: if (m.near) inc('273-near'); {
        const dst = q.fields[0].accept[0];
        for (const r of q.table.rows) if (`${r[3]}:${r[4]}` === dst) assert.ok(q.text.includes(`${r[0]}:${r[1]}`) && q.text.includes(r[2]), `${where}: 合わない行の宛先が正解`);
      } break;
      case 274: inc(`274-${m.ask}`); if (m.ask === 'src') assert.ok(q.table.rows.every((r) => `${r[3]}:${r[4]}` !== q.fields[0].accept[0]), `${where}: 内のアドレスが返りの送信元の正解`); break;
      case 275: inc(`275-k${m.k}`); if (m.pathHop) inc('275-path'); break;
      case 277: inc(`277-${m.type}`); if (m.age) inc('277-age'); break;
      case 283: inc(`283-${m.res === m.n ? 'implicit' : `line${m.res + 1}`}`); if (m.icmp) inc('283-icmp'); break;
      case 287: if (m.union) inc('287-union'); inc(`287-j${m.j}`); break;
      case 289: inc(`289-${m.mode}`); if (m.denyFirst) inc('289-denyFirst'); break;
      case 295: inc(`295-${m.cause}`); break;
      case 300: case 301: inc(`${lv}-k${m.k}`); if (q.table.rows.some((r) => r[1].length === 5)) inc(`${lv}-3dec`); break;
      case 302: inc(`302-${m.struct}`); break;
      case 303: inc(`303-${m.variant}`); if (m.two) inc('303-trap-two'); if (m.pending) inc('303-trap-pending'); break;
      case 304: inc(`304-${m.tg}`); if (m.hits >= 3) inc('304-hits3'); break;
      case 307: inc(`307-${m.t}`); if (m.v6) inc('307-v6'); if (m.vlan) inc('307-vlan'); break;
      case 293: if (m.type) inc(`293-${m.type}`); break;
      default: break;
    }
  }
}
const need = [
  '254-odd', '254-count', '254-count-0', '254-count-4',
  '261-clamp', '261-frac', '261-clamp-matters', '264-full', '264-mixed', '264-L16', '264-L26',
  '272-basic', '272-cname', '272-refetch', '273-near', '274-src', '274-dst', '275-k1', '275-k3', '275-path',
  '277-basic', '277-age', '277-smax', '277-expires',
  '283-implicit', '283-line1', '283-line2', '283-line3', '283-line4', '283-line5', '283-icmp',
  '287-union', '287-j1', '287-j2', '287-j3', '287-j4', '289-pass', '289-drop', '289-denyFirst',
  '295-ip', '295-mask', '295-gw', '295-dup', '300-k2', '300-k3', '300-3dec', '301-k2', '301-k3', '301-3dec',
  '302-PS', '302-SP', '302-PP', '302-PofS', '303-pick', '303-count', '303-trap-two', '303-trap-pending',
  '304-local', '304-nat', '304-vpn', '304-dx', '304-peer', '304-hits3', '307-inner', '307-mss', '307-underlay', '307-v6', '307-vlan',
  '293-dscpUse', '293-dscpVal', '293-dscpName', '293-dscpDrop', '293-stmt',
];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);

// 表のレベル: 文の表の行が、どれも正解として 1 回は出る(使われない行を残さない)
const bankOf = { 253: 'lag.json', 258: 'stp-edge.json', 267: 'bgp-as.json', 271: 'dns-records.json', 276: 'http-cookie.json', 278: 'tls.json', 284: 'acl-place.json', 288: 'stateful-fw.json', 294: 'queuing.json', 299: 'wan.json', 305: 'cloud-connect.json', 306: 'lb.json', 308: 'zero-trust.json' };
for (const [lv, f] of Object.entries(bankOf)) {
  const rows = require(path.join(DATA, f)).rows.filter((r) => typeof r.attrs.true === 'boolean');
  for (const r of rows) assert.ok(answerIds[lv] && answerIds[lv].has(r.id), `Lv${lv}: 文 ${r.id} が正解に出ない`);
}
for (const [lv, topic] of [[281, 'spf'], [282, 'dkim'], [290, 'snoop'], [291, 'dai'], [292, 'dot1x']]) {
  const f = lv <= 282 ? 'mail-auth.json' : 'l2-security.json';
  for (const r of require(path.join(DATA, f)).rows.filter((x) => x.attrs.topic === topic)) assert.ok(answerIds[lv].has(r.id), `Lv${lv}: 文 ${r.id} が正解に出ない`);
}

// ---------- 4. 道具の手で確かめる例 ----------
const T = ADV._test;
assert.strictEqual(T.ospfCost(100, 10), 10); assert.strictEqual(T.ospfCost(100, 1000), 1); assert.strictEqual(T.ospfCost(100000, 40000), 2);
assert.strictEqual(T.dStr(T.dSer(['0.9', '0.9'].map(T.dec))), '0.81');
assert.strictEqual(T.dStr(T.dPar(['0.9', '0.9'].map(T.dec))), '0.99');
assert.strictEqual(T.dStr(T.dSer([T.dPar(['0.9', '0.9'].map(T.dec)), T.dec('0.99')])), '0.9801'); // LEVEL-LIST の例
// ACL の箱の引き算: 10.1.0.0/24 を 2 つの /25 で覆う → 届かない。片方だけなら届く
const n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const r24 = { act: 'deny', proto: 'tcp', src: [n('10.1.0.0'), 24], dst: [0, 0], port: 443 };
const lo = { act: 'permit', proto: 'ip', src: [n('10.1.0.0'), 25], dst: [0, 0], port: null };
const hi = { act: 'permit', proto: 'tcp', src: [n('10.1.0.128'), 25], dst: [0, 0], port: null };
assert.strictEqual(T.coveredBy(r24, [lo, hi]), true);
assert.strictEqual(T.coveredBy(r24, [lo]), false);
assert.strictEqual(T.coveredBy({ ...r24, proto: 'ip', port: null }, [lo, hi]), false, 'UDP・ICMP の上の半分は覆われない');
assert.strictEqual(T.coveredBy({ act: 'deny', proto: 'udp', src: [0, 0], dst: [0, 0], port: 53 }, [{ act: 'permit', proto: 'udp', src: [0, 0], dst: [0, 0], port: null }]), true);

console.log(`cl-adv ok: ${ADV_LEVELS.length} levels (${ADV_LEVELS.join(',')}), 表の行 ${rowCount}`);
