'use strict';
// Lv4〜10 の生成問題を別の計算で解き直して検証する(答えの正確さが信頼の土台)
const assert = require('assert');
const { makeBasics, BY_LEVEL, v6Canonical, v6Full, aclEval, wildcardOf, parseIp } = require('../server/questions/basics');
const { toIp, maskOf, netOf } = require('../server/questions/subnet');
const { NODES } = require('../server/map/all');

// IPv6 の正規化を別実装(展開 → 再圧縮)で確認する
function expandV6(s) {
  const [l, r] = s.split('::');
  const left = l ? l.split(':') : [], right = r ? r.split(':') : [];
  const zeros = 8 - left.length - right.length;
  const groups = s.includes('::') ? [...left, ...Array(zeros).fill('0'), ...right] : left;
  return groups.map((g) => parseInt(g, 16));
}

let n = 0;
const seenTypes = new Set();
for (let i = 0; i < 20000; i++) {
  const level = 4 + (i % 7);
  const base = NODES[i % NODES.length].base;
  const q = makeBasics(level, base);
  seenTypes.add(q.type);
  assert.strictEqual(q.options.length, 4, q.type);
  assert.strictEqual(new Set(q.options).size, 4, `${q.type}: 選択肢が重複 ${q.options}`);
  assert.ok(q.answerIndex >= 0 && q.answerIndex < 4);
  assert.ok(q.text && q.explanation, q.type);
  const ans = q.options[q.answerIndex];
  const m = q.meta;
  switch (q.type) {
    case 'vlsm': { let h = 2; while (2 ** h - 2 < m.hosts) h++; assert.strictEqual(ans, `/${32 - h}`); break; }
    case 'wildcard': assert.strictEqual(ans, toIp((~maskOf(m.p)) >>> 0)); assert.strictEqual(parseIp(ans), wildcardOf(m.p)); break;
    case 'summary': {
      const nets = m.blocks.map((b) => parseIp(b.split('/')[0]));
      const [a, sp] = ans.split('/');
      assert.strictEqual(Number(sp), m.p - Math.log2(m.k));
      for (const x of nets) assert.strictEqual(netOf(x, Number(sp)), parseIp(a), '全ブロックが集約に含まれる');
      assert.notStrictEqual(netOf(nets[0] - 1 >>> 0, Number(sp)), parseIp(a), '最小である(1 つ前は含まれない)');
      break;
    }
    case 'v6compress': {
      assert.deepStrictEqual(expandV6(ans), m.groups, '展開すると元に戻る');
      assert.ok(!/(^|:)0[0-9a-f]/.test(ans.replace('::', ':')), '先頭ゼロなし');
      assert.ok((ans.match(/::/g) || []).length <= 1, ':: は 1 か所');
      for (const o of q.options) if (o !== ans) assert.ok(expandV6(o).join() !== m.groups.join() || o !== v6Canonical(m.groups), '誤答は正規形ではない');
      break;
    }
    case 'v6kind': {
      const h = m.groups[0];
      const kind = (h & 0xe000) === 0x2000 ? 'グローバルユニキャスト' : (h & 0xfe00) === 0xfc00 ? 'ユニークローカル' : (h & 0xffc0) === 0xfe80 ? 'リンクローカル' : (h & 0xff00) === 0xff00 ? 'マルチキャスト' : '?';
      assert.strictEqual(ans, kind); break;
    }
    case 'v6prefix': {
      const [a, p] = ans.split('/'); assert.strictEqual(Number(p), m.p);
      const g = expandV6(a); for (let k = 0; k < 8; k++) assert.strictEqual(g[k], k < m.p / 16 ? m.groups[k] : 0);
      break;
    }
    case 'route': {
      const best = m.rows.map((r) => { const [net, p] = r.prefix.split('/'); return { p: Number(p), ok: netOf(m.dst, Number(p)) === parseIp(net), hop: r.hop }; }).filter((r) => r.ok).sort((a, b) => b.p - a.p)[0];
      assert.strictEqual(ans, best.hop); assert.ok(q.table && q.table.rows.length === m.rows.length); break;
    }
    case 'mactable': assert.strictEqual(ans, m.port); assert.strictEqual(m.rows.find((r) => r.mac === m.mac).port, ans); break;
    case 'arptable': assert.strictEqual(ans, m.mac); assert.strictEqual(m.rows.find((r) => r.ip === m.ip).mac, ans); break;
    case 'acl': {
      // 別実装で評価
      let res = { action: 'deny', line: null };
      for (const l of m.lines) {
        const protoOk = l.proto === 'ip' || l.proto === m.pkt.proto;
        const srcOk = l.srcNet == null || netOf(m.pkt.src, l.srcP) === l.srcNet;
        const portOk = l.port == null || l.port === m.pkt.port;
        if (protoOk && srcOk && portOk) { res = { action: l.action, line: l.no }; break; }
      }
      const expect = res.line == null ? '暗黙の拒否で拒否される' : `行 ${res.line} で${res.action === 'permit' ? '許可' : '拒否'}される`;
      assert.strictEqual(ans, expect);
      assert.deepStrictEqual(aclEval(m.lines.map((l) => ({ ...l, src: l.srcNet == null ? 'any' : 'x', dst: 'any' })), m.pkt), res);
      break;
    }
    case 'nat': assert.strictEqual(ans, m.dir === 'in' ? m.row.local : m.row.globalAddr); break;
    default: assert.fail('未知の type ' + q.type);
  }
  n++;
}
assert.deepStrictEqual([...seenTypes].sort(), ['acl', 'arptable', 'mactable', 'nat', 'route', 'summary', 'v6compress', 'v6kind', 'v6prefix', 'vlsm', 'wildcard'], '全種類が出る');
for (let lv = 4; lv <= 10; lv++) assert.ok(BY_LEVEL[lv] && BY_LEVEL[lv].length >= 1);
// IPv6 の正規化の既知例
assert.strictEqual(v6Canonical([0x2001, 0xdb8, 0, 0, 0, 0xff00, 0x42, 0x8329]), '2001:db8::ff00:42:8329');
assert.strictEqual(v6Canonical([0x2001, 0xdb8, 0, 1, 0, 0, 0, 1]), '2001:db8:0:1::1');
assert.strictEqual(v6Canonical([0x2001, 0xdb8, 0, 0, 1, 0, 0, 1]), '2001:db8::1:0:0:1', '同じ長さなら先頭側を ::');
assert.strictEqual(v6Full([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]), '2001:0db8:0000:0000:0000:0000:0000:0001');
console.log('basics ok:', n, 'questions,', seenTypes.size, 'types');
