'use strict';
// 正規化と判定の検証(docs/questions/COMMON.md 第 8.1 節の既知例 + 冪等性 + 語彙表 + 形式不備)
const assert = require('assert');
const { normalize, judge, VOCAB } = require('../server/questions/normalize');
const { makeRng } = require('../server/questions/rng');

const cases = [
  ['number', '１,５５６番目', '1556'], ['number', '+120', '120'], ['number', '120 µs', '120'], ['number', '0', '0'], ['number', '007', '7'],
  ['number', '10.80', '10.8', { decimal: true }], ['number', '1.5', null], ['number', '12 秒', '12'], ['number', 'abc', null],
  ['ipv4', '０１０.０７７.２００.０', '10.77.200.0'], ['ipv4', '010.000.001.001', '10.0.1.1'], ['ipv4', '10.77.200', null], ['ipv4', '10.77.200.256', null],
  ['ipv4cidr', '１０.0.0.0／２４', '10.0.0.0/24'], ['ipv4cidr', '10.0.0.0 255.255.255.0', '10.0.0.0/24'], ['ipv4cidr', '10.0.0.5/24', '10.0.0.5/24'], ['ipv4cidr', '10.0.0.0/33', null], ['ipv4cidr', '/24', null],
  ['ipv6', '2001:0DB8:0000:0000:0200:5EFF:FE00:537A', '2001:db8::200:5eff:fe00:537a'], ['ipv6', 'fe80:0:0:0:0:0:0:1', 'fe80::1'], ['ipv6', '2001:db8::1::2', null], ['ipv6', '[2001:db8::1]', null], ['ipv6', '::', '::'], ['ipv6', '::1', '::1'],
  ['ipv6cidr', '2001:DB8:5C7E:9000::/52', '2001:db8:5c7e:9000::/52'], ['ipv6cidr', '2001:db8::/129', null],
  ['prefixlen', '/21', '21'], ['prefixlen', '21', '21'], ['prefixlen', '／21', '21'], ['prefixlen', '255.255.248.0', '21'], ['prefixlen', '255.255.247.0', null],
  ['bin', '1011 0010', '10110010'], ['bin', '1011_0010', '10110010'], ['bin', '0000110110111000', '0000110110111000', { digits: 16 }], ['bin', '00101', '101'], ['bin', '102', null], ['bin', '1' + '0'.repeat(16), null, { digits: 16 }],
  ['hex', '0xE5', 'e5'], ['hex', 'E5', 'e5'], ['hex', 'g1', null],
  ['mac', '00-00-5E-00-53-7A', '00:00:5e:00:53:7a'], ['mac', '0000.5e00.537a', '00:00:5e:00:53:7a'], ['mac', '00:00:5E', '00:00:5e'], ['mac', '00:00:5e:00:53', null],
  ['yesno', '○', 'yes'], ['yesno', 'はい', 'yes'], ['yesno', '転送する', 'yes'], ['yesno', '×', 'no'], ['yesno', 'いいえ', 'no'], ['yesno', '転送しない', 'no'], ['yesno', 'たぶん', null],
  ['token', 'APIPA', 'v4-linklocal', { vocab: 'v4-kind' }], ['token', 'link-local', 'v4-linklocal', { vocab: 'v4-kind' }], ['token', 'リンクローカルアドレス', 'v4-linklocal', { vocab: 'v4-kind' }],
  ['token', '全ポート', 'flood', { vocab: 'switch-action' }], ['token', 'フラッディング', 'flood', { vocab: 'switch-action' }], ['token', 'flood', 'flood', { vocab: 'switch-action' }],
  ['token', '逆引き', 'dns', { vocab: 'diag-cause' }], ['token', 'PTR', 'dns', { vocab: 'diag-cause' }], ['token', 'DNS', 'dns', { vocab: 'diag-cause' }], ['token', 'なにか', null, { vocab: 'diag-cause' }], ['token', 'dns', null, { vocab: 'nope' }],
  ['addrport', '２０３.0.113.10：51002', '203.0.113.10:51002'], ['addrport', '203.0.113.10:0', null], ['addrport', '203.0.113.10', null],
  ['ifname', 'GigabitEthernet0/1', 'gi0/1'], ['ifname', 'Gi 0/1', 'gi0/1'], ['ifname', 'g0/1', 'gi0/1'], ['ifname', 'GigabitEthernet 1/0/24', 'gi1/0/24'], ['ifname', 'Null 0', 'null0'], ['ifname', 'Ethernet0', 'eth0'], ['ifname', 'Gi', null],
  ['devname', 'pc-2', 'pc2'], ['devname', 'PC 2', 'pc2'],
  ['order', '3-1-2', '3-1-2'], ['order', '3 1 2', '3-1-2'], ['order', '3,1,2', '3-1-2'], ['order', '3→1→2', '3-1-2'], ['order', '３－１－２', '3-1-2'], ['order', '312', '3-1-2'], ['order', '3、1、2', '3-1-2'], ['order', 'abc', null], ['order', '3-0-2', null],
  ['number', '50%', '50'], ['number', '50 %', '50'], ['number', '５０％', '50'], ['number', '12.5%', '12.5', { decimal: true }],
  ['dnsname', '23.7.0.10.IN-ADDR.ARPA.', '23.7.0.10.in-addr.arpa'], ['dnsname', 'www..example', null],
  ['aclverdict', '10 permit', 'permit 10'], ['aclverdict', '許可 10', 'permit 10'], ['aclverdict', '拒否 10', 'deny 10'], ['aclverdict', '暗黙の拒否', 'deny implicit'], ['aclverdict', 'deny implicit', 'deny implicit'], ['aclverdict', 'deny', null],
  ['prefixplan', 'R1 10.0.0.0/24\nR2 10.0.1.0/24', 'r1 10.0.0.0/24\nr2 10.0.1.0/24'], ['prefixplan', 'r2 10.0.1.0/24, r1 10.0.0.0/24', 'r1 10.0.0.0/24\nr2 10.0.1.0/24'], ['prefixplan', 'r1', null],
];
for (const [f, input, want, opts] of cases) {
  const got = normalize(f, input, opts || {});
  assert.strictEqual(got, want, `${f}(${JSON.stringify(input)}) → ${JSON.stringify(got)}(期待 ${JSON.stringify(want)})`);
  if (got !== null) assert.strictEqual(normalize(f, got, opts || {}), got, `${f} は冪等: ${got}`);
}
// 語彙表: 別名はすべて自分の id に戻る。id どうしの衝突が無い
for (const [vocab, table] of Object.entries(VOCAB)) {
  if (vocab === 'note') continue;
  for (const [id, aliases] of Object.entries(table)) {
    for (const a of aliases) assert.strictEqual(normalize('token', a, { vocab }), id, `${vocab}: ${a} → ${id}`);
    assert.strictEqual(normalize('token', id, { vocab }), id);
  }
}
// 冪等性(ランダム): ipv4 / ipv4cidr / bin / hex / mac
const rng = makeRng(7);
for (let i = 0; i < 10000; i++) {
  const ip = `${rng.rand(0, 255)}.${rng.rand(0, 255)}.${rng.rand(0, 255)}.${rng.rand(0, 255)}`;
  const c = `${ip}/${rng.rand(0, 32)}`;
  assert.strictEqual(normalize('ipv4cidr', normalize('ipv4cidr', c)), normalize('ipv4cidr', c));
  const b = rng.rand(0, 0xffff).toString(2); assert.strictEqual(normalize('bin', normalize('bin', b)), normalize('bin', b));
  const h = rng.rand(0, 0xffffff).toString(16); assert.strictEqual(normalize('hex', normalize('hex', h)), normalize('hex', h));
}
// 判定: choice / text(ordered・set)/ 欄数違い / 形式不備
assert.ok(judge({ answerKind: 'choice', answerIndex: 2 }, 2) && !judge({ answerKind: 'choice', answerIndex: 2 }, 1));
const qText = { answerKind: 'text', fields: [{ name: 'net', format: 'ipv4cidr', accept: ['10.0.0.0/24'] }, { name: 'n', format: 'number', accept: ['254'] }] };
assert.ok(judge(qText, ['１０.0.0.0／２４', '254台']));
assert.ok(!judge(qText, ['10.0.0.5/24', '254']), '切り詰めないので不正解');
assert.ok(!judge(qText, ['10.0.0.0/24']), '欄数違い');
assert.ok(!judge(qText, ['10.0.0.0/24', 'abc']), '形式不備は不正解');
const qSet = { answerKind: 'text', compare: 'set', fields: [{ name: 'a', format: 'ipv4cidr', accept: ['10.0.0.0/25'] }, { name: 'b', format: 'ipv4cidr', accept: ['10.0.0.128/26'] }] };
assert.ok(judge(qSet, ['10.0.0.128/26', '10.0.0.0/25']), 'set は入替を許す');
assert.ok(!judge(qSet, ['10.0.0.0/25', '10.0.0.0/25']));
// rng: 同じ seed で同じ列、違う seed で違う列
const a1 = makeRng(123), a2 = makeRng(123), b1 = makeRng(124);
const s1 = Array.from({ length: 20 }, () => a1.rand(0, 1000)), s2 = Array.from({ length: 20 }, () => a2.rand(0, 1000)), s3 = Array.from({ length: 20 }, () => b1.rand(0, 1000));
assert.deepStrictEqual(s1, s2); assert.notDeepStrictEqual(s1, s3);
assert.ok(s1.every((x) => x >= 0 && x <= 1000));
console.log(`normalize ok: ${cases.length} cases, ${Object.keys(VOCAB).length - 1} vocab tables, judge + rng`);
