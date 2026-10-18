'use strict';
// Lv11〜20(calc.js)の検証。生成器は 32 ビット整数演算、ここでは 2 進文字列・BigInt・素朴な計算で解き直す(COMMON.md 第 8 章)。
//   固定 seed 列で 1 万件(seed = i)。各レベル 1,000 件以上。accept は normalize の不動点。ありがちな間違いが accept に入らない。
//   欄名の重複なし。defenseNote 非空。本文・解説・hint に安全範囲外のアドレスが出ない。設計書の例題が同じ値で作れる。
const assert = require('assert');
const calc = require('../server/questions/calc');
const { make, BUILDERS, RANGE, VERSION } = calc;
const { makeRng } = require('../server/questions/rng');
const { normalize, judge } = require('../server/questions/normalize');
const { NODES } = require('../server/map/tokyo');

// ---------- 別実装の道具(2 進文字列・BigInt) ----------
const parseIp = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const ipBin = (ip) => ip.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('');
const binIp = (b) => b.match(/.{8}/g).map((x) => parseInt(x, 2)).join('.');
const netStr = (ip, p) => binIp(ipBin(ip).slice(0, p).padEnd(32, '0'));
const bcStr = (ip, p) => binIp(ipBin(ip).slice(0, p).padEnd(32, '1'));
const addIp = (ip, n) => binIp((BigInt(parseIp(ip)) + BigInt(n)).toString(2).padStart(32, '0'));
const ipOfInt = (n) => binIp(Number(n).toString(2).padStart(32, '0'));
function expandV6(s) {
  const [l, r] = s.split('::');
  const left = l ? l.split(':') : [], right = r ? r.split(':') : [];
  const groups = s.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((g) => parseInt(g, 16));
}
const v6Big = (groups) => groups.reduce((a, g) => (a << 16n) | BigInt(g), 0n);
const v6Str = (big) => Array.from({ length: 8 }, (_, i) => Number((big >> BigInt(16 * (7 - i))) & 0xffffn).toString(16)).join(':'); // 省略なし(normalize で正規形へ)
const v6Norm = (groupsOrBig, p) => normalize('ipv6cidr', `${typeof groupsOrBig === 'bigint' ? v6Str(groupsOrBig) : groupsOrBig.map((g) => g.toString(16)).join(':')}/${p}`);

// ---------- 安全範囲(COMMON.md 第 7 章) ----------
const SAFE_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]];
const safeV4 = (ip) => SAFE_V4.some(([n, p]) => ipBin(ip).slice(0, p) === ipBin(n).slice(0, p));
const safeMac = (m) => /^00:00:5e:00:53:[0-9a-f]{2}$/.test(m) || /^[0-9a-f][26ae](:[0-9a-f]{2}){5}$/.test(m);
// 本文を空白・句読点・括弧で切り、アドレスに見える語をすべて範囲判定する(':' は MAC・IPv6 の一部なので区切りにしない)
function lintText(s, q) {
  const tokens = String(s).split(/[\s、。()「」]+/).filter(Boolean);
  for (const t of tokens) {
    const m4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?[、。]?$/.exec(t);
    if (m4) { const ip = t.replace(/\/\d+$/, '').replace(/[、。]$/, ''); assert.ok(safeV4(ip), `安全範囲外の IPv4: ${ip} in ${s}`); continue; }
    if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(t)) { assert.ok(safeMac(t), `安全範囲外の MAC: ${t}`); continue; }
    if (/^[0-9a-f]{2}(:[0-9a-f]{2}){2}$/.test(t)) { assert.ok(/^[0-9a-f][26ae]:/.test(t) || (q.meta.mac && (q.meta.mac.startsWith(t) || q.meta.mac.endsWith(t))), `MAC の一部 ${t} が出題 MAC に無い`); continue; }
    if (/^[0-9a-f:]+(\/\d{1,3})?$/.test(t) && (t.match(/:/g) || []).length >= 2) {
      const a = normalize('ipv6', t.replace(/\/\d+$/, ''));
      assert.ok(a && a.startsWith('2001:db8:'), `安全範囲外の IPv6: ${t} in ${s}`);
    }
  }
}
// 文書用 IPv4 は hint の例示だけに使う。本文・解説には内側の 3 範囲だけ
const INNER_ONLY = (ip) => SAFE_V4.slice(0, 3).some(([n, p]) => ipBin(ip).slice(0, p) === ipBin(n).slice(0, p));

// ---------- 10 進のオクテット → クラス境界(Lv16 の誤答「クラス境界から数えた番号」用) ----------
const classLen = (ip) => { const f = Number(ip.split('.')[0]); return f < 128 ? 8 : f < 192 ? 16 : 24; };

// ---------- 1 万件 ----------
const fakeNodes = [
  { id: 'home-a', base: parseIp('172.17.5.0'), span: 254 }, { id: 'home-b', base: parseIp('172.31.255.0'), span: 254 },
  { id: 'c', base: parseIp('192.168.200.0'), span: 254 }, { id: 'd', base: parseIp('192.168.0.0'), span: 65534 },
  { id: 'e', base: parseIp('10.0.0.0'), span: 65534 }, { id: 'f', base: parseIp('10.255.255.0'), span: 254 },
];
const perLevel = {}, seenTypes = new Set(), seen = { p14: new Set(), p15: new Set(), kinds13: new Set(), asks13: new Set(), b11: new Set(), modes19: new Set(), p19: new Set(), p16: new Set(), fams: new Set() };
let n = 0;
for (let i = 0; i < 10000; i++) {
  const level = RANGE[0] + (i % (RANGE[1] - RANGE[0] + 1));
  const node = i % 4 === 3 ? fakeNodes[i % fakeNodes.length] : NODES[i % NODES.length];
  const q = make(level, node, makeRng(i));
  perLevel[level] = (perLevel[level] || 0) + 1;
  seenTypes.add(q.type);

  // 形(COMMON.md 第 1 章)
  assert.strictEqual(q.level, level); assert.strictEqual(q.answerKind, 'text', q.type);
  assert.match(q.templateId, /^[a-z0-9-]+-v1$/); assert.strictEqual(q.seed, makeRng(i).seed); assert.strictEqual(q.generatorVersion, VERSION);
  assert.ok(q.text && q.explanation && q.meta && q.type, q.type);
  assert.ok(typeof q.defenseNote === 'string' && q.defenseNote.trim().length > 0, 'defenseNote 必須');
  assert.ok(Array.isArray(q.fields) && q.fields.length >= 1 && q.fields.length <= 6, '欄数 1〜6');
  assert.strictEqual(new Set(q.fields.map((f) => f.name)).size, q.fields.length, '欄名の重複なし');
  for (const f of q.fields) {
    assert.ok(f.name && f.label && f.format && f.hint, `欄の形 ${JSON.stringify(f)}`);
    assert.ok(Array.isArray(f.accept) && f.accept.length >= 1);
    for (const a of f.accept) assert.strictEqual(normalize(f.format, a, f), a, `accept は正規形: ${f.format} ${a}`);
    if (f.hint.startsWith('例: ')) assert.ok(!f.accept.includes(normalize(f.format, f.hint.slice(3), f)), `hint が答えと一致 ${f.hint}`);
    else assert.strictEqual(normalize(f.format, f.hint, f), null, `例でない hint は答えの形をしていない: ${f.hint}`);
    if (f.format === 'ipv4') assert.ok(INNER_ONLY(f.accept[0]), `答えは内側の範囲: ${f.accept[0]}`);
    if (f.format === 'ipv4cidr') assert.ok(INNER_ONLY(f.accept[0].split('/')[0]));
  }
  assert.ok(judge(q, q.fields.map((f) => f.accept[0])), '正解で judge が真');
  assert.ok(!judge(q, q.fields.map(() => 'zz')), '形式不備で judge が偽');
  for (const s of [q.text, q.explanation, q.defenseNote, ...q.fields.map((f) => f.hint), ...q.fields.map((f) => f.label)]) lintText(s, q);

  const m = q.meta, acc = (name) => q.fields.find((f) => f.name === name).accept, has = (name, v) => acc(name).includes(v);
  const notIn = (name, v, why) => { if (v !== null && v !== acc(name)[0]) assert.ok(!has(name, v), `${q.type}: ありがちな間違い(${why})が accept にある: ${v}`); };
  switch (q.type) {
    case 'bin2dec': {
      const bin = /2 進数 ([01]{8}) /.exec(q.text)[1];
      assert.strictEqual(acc('dec')[0], String(parseInt(bin, 2))); assert.strictEqual(parseInt(bin, 2), m.n);
      notIn('dec', String(parseInt([...bin].reverse().join(''), 2)), 'ビット順逆'); notIn('dec', String(parseInt(bin.slice(1), 2)), '最上位ビット落ち');
      notIn('dec', String(m.n + 1), '+1'); notIn('dec', String(m.n - 1), '−1');
      seen.b11.add(m.n); break;
    }
    case 'dec2bin': {
      const d = Number(/10 進数 (\d+) /.exec(q.text)[1]);
      assert.strictEqual(d, m.n); assert.strictEqual(acc('bin')[0], d.toString(2).padStart(8, '0')); assert.strictEqual(q.fields[0].digits, 8);
      notIn('bin', [...d.toString(2).padStart(8, '0')].reverse().join(''), 'ビット順逆'); notIn('bin', normalize('bin', (d & 127).toString(2), { digits: 8 }), '最上位ビット落ち');
      if (d < 255) notIn('bin', (d + 1).toString(2).padStart(8, '0'), '+1');
      seen.b11.add(m.n); break;
    }
    case 'hex2bin': {
      const digits = m.unit === 'hextet' ? 16 : 8;
      assert.strictEqual(q.fields[0].digits, digits);
      assert.ok(q.text.includes(m.hex), '本文に 16 進の値'); assert.strictEqual(acc('bin')[0], parseInt(m.hex, 16).toString(2).padStart(digits, '0'));
      assert.strictEqual(parseInt(acc('bin')[0], 2), m.value);
      notIn('bin', [...m.hex].reverse().map((h) => parseInt(h, 16).toString(2).padStart(4, '0')).join(''), 'ニブル順逆');
      notIn('bin', normalize('bin', m.hex.replace(/b/g, 'X').replace(/d/g, 'b').replace(/X/g, 'd').split('').map((h) => parseInt(h, 16).toString(2).padStart(4, '0')).join(''), { digits }), 'b と d の取り違え');
      break;
    }
    case 'bin2hex': {
      const digits = m.unit === 'hextet' ? 4 : 2;
      const bin = new RegExp(`2 進数 ([01]{${digits * 4}})`).exec(q.text)[1];
      assert.strictEqual(q.fields[0].digits, digits); assert.strictEqual(parseInt(bin, 2), m.value);
      assert.strictEqual(acc('hex')[0], parseInt(bin, 2).toString(16).padStart(digits, '0'));
      notIn('hex', [...acc('hex')[0]].reverse().join(''), 'ニブル順逆');
      notIn('hex', normalize('hex', ((m.value + 1) & (16 ** digits - 1)).toString(16), { digits }), '+1');
      break;
    }
    case 'hex2dec': {
      assert.ok(q.text.includes(m.hex)); assert.strictEqual(acc('dec')[0], String(parseInt(m.hex, 16))); assert.strictEqual(parseInt(m.hex, 16), m.value);
      if (/^\d+$/.test(m.hex)) notIn('dec', String(Number(m.hex)), '16 進をそのまま 10 進で読む');
      notIn('dec', String(parseInt([...m.hex].reverse().join(''), 16)), 'ニブル順逆');
      break;
    }
    case 'macparts': {
      const mac = /MAC アドレス ([0-9a-f:]{17}) /.exec(q.text)[1];
      assert.strictEqual(mac, m.mac); assert.ok(safeMac(mac), '生成 MAC が安全範囲');
      const flat = mac.replace(/:/g, ''); const firstBits = parseInt(flat.slice(0, 2), 16).toString(2).padStart(8, '0');
      const ul = firstBits[6] === '1', ig = firstBits[7] === '1';
      assert.strictEqual(m.kind === 'doc', /^00:00:5e:00:53:/.test(mac)); assert.strictEqual(ul, m.kind === 'local'); assert.strictEqual(ig, false, '安全範囲の MAC はユニキャスト');
      assert.strictEqual(q.fields.length, 2); assert.deepStrictEqual(q.fields.map((f) => f.name), m.asks);
      for (const f of q.fields) {
        if (f.name === 'oui') { assert.strictEqual(f.accept[0], flat.slice(0, 6).match(/.{2}/g).join(':')); notIn('oui', normalize('mac', flat.slice(0, 4)), '16 ビットで切る'); notIn('oui', normalize('mac', flat.slice(0, 8)), '32 ビットで切る'); }
        if (f.name === 'nic') { assert.strictEqual(f.accept[0], flat.slice(6).match(/.{2}/g).join(':')); notIn('nic', normalize('mac', flat.slice(4)), '16 ビットで切る'); }
        if (f.name === 'local') { assert.strictEqual(f.accept[0], ul ? 'yes' : 'no'); notIn('local', ig ? 'yes' : 'no', 'I/G と入替'); notIn('local', firstBits[0] === '1' ? 'yes' : 'no', '最上位ビットで判定'); }
        if (f.name === 'group') { assert.strictEqual(f.accept[0], ig ? 'yes' : 'no'); notIn('group', ul ? 'yes' : 'no', 'U/L と入替'); }
      }
      seen.kinds13.add(m.kind); seen.asks13.add(m.asks.join('+')); break;
    }
    case 'netbcast': {
      const [, ip, p] = /^(\d+\.\d+\.\d+\.\d+)\/(\d+) /.exec(q.text); const pn = Number(p);
      assert.ok(pn >= 9 && pn <= 30 && pn !== 16 && pn !== 24, `/${p}`); assert.strictEqual(ipOfInt(m.ip), ip);
      assert.strictEqual(acc('network')[0], netStr(ip, pn)); assert.strictEqual(acc('broadcast')[0], bcStr(ip, pn));
      notIn('network', acc('broadcast')[0], '入替'); notIn('broadcast', acc('network')[0], '入替');
      for (const d of [-8, 8, -1, 1]) { const pp = pn + d; if (pp >= 1 && pp <= 32) { notIn('network', netStr(ip, pp), `境目 ${d}`); notIn('broadcast', bcStr(ip, pp), `境目 ${d}`); } }
      notIn('broadcast', addIp(bcStr(ip, pn), -1), 'ブロードキャスト −1');
      seen.p14.add(pn); seen.fams.add(ip.split('.')[0]); break;
    }
    case 'usable': {
      const [, ip, p] = /^(\d+\.\d+\.\d+\.\d+)\/(\d+) /.exec(q.text); const pn = Number(p);
      assert.ok(pn >= 9 && pn <= 30);
      const net = netStr(ip, pn), bc = bcStr(ip, pn), first = addIp(net, 1), last = addIp(bc, -1);
      assert.strictEqual(acc('first')[0], first); assert.strictEqual(acc('last')[0], last);
      assert.ok(parseIp(first) < parseIp(last)); assert.strictEqual(netStr(first, pn), netStr(last, pn), '同じネットワーク');
      notIn('first', net, 'ネットワークそのもの'); notIn('last', bc, 'ブロードキャストそのもの'); notIn('first', addIp(net, 2), '+2'); notIn('last', addIp(bc, -2), '−2');
      notIn('first', addIp(bcStr(ip, pn), 2), '隣のブロックの先頭'); notIn('last', addIp(net, -2), '隣のブロックの末尾');
      seen.p15.add(pn); break;
    }
    case 'subnetindex': {
      const [, parent, p1, p2] = /^(\d+\.\d+\.\d+\.\d+)\/(\d+) を \/(\d+) /.exec(q.text); const ip = /とする。 (\d+\.\d+\.\d+\.\d+) は/.exec(q.text)[1];
      const a = Number(p1), b = Number(p2); assert.ok(a >= 8 && a <= 22 && b >= a + 2 && b <= Math.min(30, a + 8), `/${a} → /${b}`);
      assert.strictEqual(netStr(parent, a), parent, '親は整列'); assert.strictEqual(netStr(ip, a), parent, 'ip は親の中');
      const size = 2 ** (32 - b), offset = parseIp(ip) - parseIp(parent), idx = Math.floor(offset / size) + 1;
      assert.strictEqual(acc('index')[0], String(idx)); assert.ok(idx >= 1 && idx <= 2 ** (b - a));
      const sub = netStr(ip, b); assert.strictEqual(acc('cidr')[0], `${sub}/${b}`);
      assert.ok(parseIp(sub) <= parseIp(ip) && parseIp(ip) <= parseIp(bcStr(sub, b)));
      notIn('index', String(idx - 1), '0 始まり'); notIn('index', String(idx + 1), '+1'); notIn('index', String(Math.floor(offset / (2 * size)) + 1), '区画サイズ 2 倍');
      notIn('index', String(Math.floor((parseIp(ip) - parseIp(netStr(ip, classLen(ip)))) / size) + 1), 'クラス境界から数える');
      seen.p16.add(a); if (a === 8) assert.strictEqual(parent, '10.0.0.0'); break;
    }
    case 'nthsubnet': {
      const [, parent, p1, p2] = /^(\d+\.\d+\.\d+\.\d+)\/(\d+) を \/(\d+) /.exec(q.text); const nn = Number(/として ([\d,]+) 番目/.exec(q.text)[1].replace(/,/g, ''));
      const a = Number(p1), b = Number(p2), count = 2 ** (b - a); assert.ok(nn >= 1 && nn <= count); assert.strictEqual(nn, m.n);
      assert.strictEqual(acc('count')[0], String(count)); notIn('count', String(count / 2), '分割数半分'); notIn('count', String(count * 2), '分割数 2 倍');
      const sub = addIp(parent, (nn - 1) * 2 ** (32 - b));
      assert.strictEqual(acc('cidr')[0], `${sub}/${b}`); assert.strictEqual(netStr(sub, a), parent, '親に含まれる'); assert.strictEqual(netStr(sub, b), sub, '/p2 に整列');
      notIn('cidr', `${addIp(parent, (nn - 2) * 2 ** (32 - b))}/${b}`, 'N−1 番目'); notIn('cidr', `${addIp(parent, nn * 2 ** (32 - b))}/${b}`, 'N+1 番目'); notIn('cidr', `${parent}/${b}`, '親の先頭');
      break;
    }
    case 'nthrange': {
      const [, parent, p1, p2] = /^(\d+\.\d+\.\d+\.\d+)\/(\d+) を \/(\d+) /.exec(q.text); const nn = Number(/とする。 ([\d,]+) 番目/.exec(q.text)[1].replace(/,/g, ''));
      const a = Number(p1), b = Number(p2); assert.ok(nn >= 1 && nn <= 2 ** (b - a));
      const sub = addIp(parent, (nn - 1) * 2 ** (32 - b)), bc = bcStr(sub, b);
      assert.deepStrictEqual(q.fields.map((f) => f.accept[0]), [sub, bc, addIp(sub, 1), addIp(bc, -1)]);
      assert.deepStrictEqual(q.fields.map((f) => f.name), ['network', 'broadcast', 'first', 'last']);
      const v = q.fields.map((f) => parseIp(f.accept[0])); assert.ok(v[0] < v[2] && v[2] < v[3] && v[3] < v[1], 'net < first < last < bcast');
      notIn('network', addIp(parent, (nn - 2) * 2 ** (32 - b)), 'N−1 番目'); notIn('network', addIp(parent, nn * 2 ** (32 - b)), 'N+1 番目');
      notIn('first', sub, 'ネットワークそのもの'); notIn('last', bc, 'ブロードキャストそのもの');
      break;
    }
    case 'v6prefix': {
      const [, addr, p] = /IPv6 アドレス ([0-9a-f:]+) が属する \/(\d+) /.exec(q.text); const pn = Number(p);
      assert.ok([36, 40, 44, 52, 56, 60].includes(pn));
      const big = v6Big(expandV6(addr)); assert.strictEqual(big, v6Big(m.groups));
      const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - pn)) - 1n);
      assert.strictEqual(acc('prefix')[0], v6Norm(big & mask, pn));
      for (const cut of [48, 64, 32]) notIn('prefix', v6Norm(big & (((1n << 128n) - 1n) ^ ((1n << BigInt(128 - cut)) - 1n)), pn), `16 ビット境界 /${cut} で切る`);
      for (const d of [-4, 4]) notIn('prefix', v6Norm(big & (((1n << 128n) - 1n) ^ ((1n << BigInt(128 - pn - d)) - 1n)), pn), `ニブル ${d}`);
      seen.modes19.add('prefix'); seen.p19.add(pn); break;
    }
    case 'v6nth': {
      const [, parent, pp, nn] = /^([0-9a-f:]+)\/(\d+) を \/64 に等分した\(分割数 [\d,]+\)。最初を 1 番目として (\d+) 番目/.exec(q.text);
      const ppn = Number(pp), N = Number(nn); assert.ok([48, 56].includes(ppn) && N >= 1 && N <= 256); assert.strictEqual(N, m.n);
      const pb = v6Big(expandV6(parent)); assert.strictEqual(pb & ((1n << BigInt(128 - ppn)) - 1n), 0n, '親は整列');
      assert.strictEqual(acc('prefix')[0], v6Norm(pb + (BigInt(N - 1) << 64n), 64));
      notIn('prefix', v6Norm(pb + (BigInt(parseInt(String(N), 16)) << 64n), 64), 'N を 10 進のまま 16 進の位置に書く');
      notIn('prefix', v6Norm(pb + (BigInt(N) << 64n), 64), 'N 番目を 0 始まりで数える'); if (N >= 2) notIn('prefix', v6Norm(pb + (BigInt(N - 2) << 64n), 64), 'N−1 のずれ');
      assert.ok(q.text.includes(ppn === 48 ? '65,536' : '256'), '分割数を本文に');
      seen.modes19.add('nth'); break;
    }
    case 'frombinary': {
      const addrBin = /アドレス: ([01.]+)\n/.exec(q.text)[1], maskBin = /マスク: ([01.]+)\n/.exec(q.text)[1];
      const ab = addrBin.replace(/\./g, ''), mb = maskBin.replace(/\./g, '');
      assert.strictEqual(ab.length, 32); assert.match(mb, /^1+0*$/, 'マスクは連続 1');
      const p = mb.replace(/0/g, '').length; assert.ok(p >= 17 && p <= 29);
      const ip = binIp(ab), net = netStr(ip, p), hostNo = parseIp(ip) - parseIp(net);
      assert.strictEqual(acc('prefixlen')[0], String(p)); assert.strictEqual(acc('cidr')[0], `${net}/${p}`); assert.strictEqual(acc('hostno')[0], String(hostNo));
      assert.ok(hostNo >= 1 && hostNo <= 2 ** (32 - p) - 2, 'ホスト番号は [1, 2^(32−p) − 2]');
      notIn('prefixlen', String(p - 1), '1 の数 −1'); notIn('prefixlen', String(p + 1), '1 の数 +1');
      notIn('hostno', String(hostNo - 1), '0 始まり'); notIn('hostno', String(parseIp(bcStr(ip, p)) - parseIp(ip)), 'ブロードキャストから数える');
      notIn('cidr', `${netStr(ip, p - 1)}/${p}`, '境目 −1'); notIn('cidr', `${netStr(ip, p + 1)}/${p}`, '境目 +1');
      break;
    }
    default: assert.fail('未知の type ' + q.type);
  }
  n++;
}
for (let lv = RANGE[0]; lv <= RANGE[1]; lv++) assert.ok(perLevel[lv] >= 1000, `Lv${lv} が 1,000 件以上`);
assert.deepStrictEqual([...seenTypes].sort(), ['bin2dec', 'bin2hex', 'dec2bin', 'frombinary', 'hex2bin', 'hex2dec', 'macparts', 'netbcast', 'nthrange', 'nthsubnet', 'subnetindex', 'usable', 'v6nth', 'v6prefix'], '全種類が出る');
assert.ok(seen.p14.has(9) && seen.p14.has(30) && !seen.p14.has(16) && !seen.p14.has(24), 'Lv14 は /9 と /30 を含み /16・/24 を除く');
assert.ok([...seen.p14].filter((p) => p <= 15).length === 7 && [...seen.p14].filter((p) => p >= 25).length === 6, 'Lv14 は全プレフィックスが出る');
assert.ok(seen.p15.has(30) && seen.p15.has(9), 'Lv15 は /9 と /30 を含む');
assert.deepStrictEqual([...seen.kinds13].sort(), ['doc', 'local'], 'Lv13 は文書用とローカル管理の両方'); assert.strictEqual(seen.asks13.size, 6, 'Lv13 は 4 問いの 6 組み合わせが出る');
for (const b of [0, 1, 127, 128, 254, 255]) assert.ok(seen.b11.has(b), `Lv11 の境界値 ${b}`);
assert.deepStrictEqual([...seen.modes19].sort(), ['nth', 'prefix']); assert.strictEqual(seen.p19.size, 6, 'Lv19 の 6 つのプレフィックス長');
assert.ok(seen.p16.has(8) && seen.p16.has(22), 'Lv16 の親 /8〜/22');
assert.ok(seen.fams.has('10') && seen.fams.has('172') && seen.fams.has('192'), 'Lv14 は 3 つの内側範囲すべてから出る');

// ---------- 設計書の例題が同じ値で作れる(design-11-50.md 第 1.2 節) ----------
const ex = (lv, prm) => BUILDERS[lv](prm).fields.map((f) => f.accept[0]);
const g = (s) => expandV6(s);
assert.deepStrictEqual(ex(11, { n: 178, dir: 'bin2dec' }), ['178']); assert.ok(BUILDERS[11]({ n: 178, dir: 'bin2dec' }).text.includes('10110010'));
assert.deepStrictEqual(ex(11, { n: 203, dir: 'dec2bin' }), ['11001011']);
assert.deepStrictEqual(ex(12, { unit: 'hextet', dir: 'hex2bin', value: 0x0db8, groups: g('2001:db8:5c7e:9a31:abcd::1'), idx: 2 }), ['0000110110111000']);
assert.deepStrictEqual(ex(12, { unit: 'byte', dir: 'bin2hex', value: 0xe5, mac: '02:00:5e:00:53:e5', idx: 6 }), ['e5']);
assert.deepStrictEqual(ex(13, { mac: '00:00:5e:00:53:7a', kind: 'doc', asks: ['oui', 'nic'] }), ['00:00:5e', '00:53:7a']);
assert.deepStrictEqual(ex(13, { mac: '02:1a:4f:33:c0:9d', kind: 'local', asks: ['local', 'group'] }), ['yes', 'no']);
assert.deepStrictEqual(ex(14, { ip: parseIp('172.16.200.77'), p: 13 }), ['172.16.0.0', '172.23.255.255']);
assert.deepStrictEqual(ex(14, { ip: parseIp('10.77.203.150'), p: 21 }), ['10.77.200.0', '10.77.207.255']);
assert.deepStrictEqual(ex(15, { ip: parseIp('192.168.37.130'), p: 26 }), ['192.168.37.129', '192.168.37.190']);
assert.deepStrictEqual(ex(15, { ip: parseIp('10.200.14.9'), p: 11 }), ['10.192.0.1', '10.223.255.254']);
assert.deepStrictEqual(ex(16, { parent: parseIp('192.168.0.0'), p1: 16, p2: 20, ip: parseIp('192.168.77.5') }), ['5', '192.168.64.0/20']);
assert.deepStrictEqual(ex(16, { parent: parseIp('10.8.0.0'), p1: 14, p2: 18, ip: parseIp('10.10.200.33') }), ['12', '10.10.192.0/18']);
assert.deepStrictEqual(ex(17, { parent: parseIp('172.20.0.0'), p1: 16, p2: 19, n: 6 }), ['8', '172.20.160.0/19']);
assert.deepStrictEqual(ex(17, { parent: parseIp('10.64.0.0'), p1: 12, p2: 15, n: 3 }), ['8', '10.68.0.0/15']);
assert.deepStrictEqual(ex(18, { parent: parseIp('192.168.100.0'), p1: 24, p2: 27, n: 4 }), ['192.168.100.96', '192.168.100.127', '192.168.100.97', '192.168.100.126']);
assert.deepStrictEqual(ex(18, { parent: parseIp('10.50.0.0'), p1: 16, p2: 22, n: 23 }), ['10.50.88.0', '10.50.91.255', '10.50.88.1', '10.50.91.254']);
assert.deepStrictEqual(ex(19, { mode: 'prefix', groups: g('2001:db8:5c7e:9a31:abcd::1'), p: 52 }), ['2001:db8:5c7e:9000::/52']);
assert.deepStrictEqual(ex(19, { mode: 'nth', groups: g('2001:db8:4a00::'), pp: 56, n: 18 }), ['2001:db8:4a00:11::/64']);
const q20 = BUILDERS[20]({ ip: parseIp('192.168.10.75'), p: 27 });
assert.deepStrictEqual(q20.fields.map((f) => f.accept[0]), ['27', '192.168.10.64/27', '11']);
assert.ok(q20.text.includes('11000000.10101000.00001010.01001011') && q20.text.includes('11111111.11111111.11111111.11100000'));
assert.deepStrictEqual(ex(20, { ip: parseIp('10.25.182.20'), p: 20 }), ['20', '10.25.176.0/20', '1556']);
// 入力ゆれが正解になる(COMMON.md 8.1 の例を calc の問題で)
assert.ok(judge(BUILDERS[20]({ ip: parseIp('10.25.182.20'), p: 20 }), ['/20', '１０.25.176.0／２０', '１,５５６番目']));
assert.ok(judge(BUILDERS[13]({ mac: '00:00:5e:00:53:7a', kind: 'doc', asks: ['oui', 'nic'] }), ['00-00-5E', '0053.7a']));
assert.ok(!judge(BUILDERS[16]({ parent: parseIp('192.168.0.0'), p1: 16, p2: 20, ip: parseIp('192.168.77.5') }), ['4', '192.168.64.0/20']), '0 始まりは不正解');
assert.ok(!judge(BUILDERS[16]({ parent: parseIp('192.168.0.0'), p1: 16, p2: 20, ip: parseIp('192.168.77.5') }), ['5', '192.168.77.5/20']), '切り詰めない CIDR は不正解');

// 同じ seed なら同じ問題、違う seed なら(ほぼ)違う問題
const nodeA = NODES[0];
assert.deepStrictEqual(make(14, nodeA, makeRng(42)), make(14, nodeA, makeRng(42)));
assert.notDeepStrictEqual(make(14, nodeA, makeRng(42)).text, make(14, nodeA, makeRng(43)).text);

console.log(`calc ok: ${n} questions, ${seenTypes.size} types, Lv${RANGE[0]}〜${RANGE[1]} (${Object.values(perLevel).join('/')} each), examples ok`);
