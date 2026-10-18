'use strict';
// Lv11〜20 アドレス計算を自分で組み立てる(docs/questions/design-11-50.md 第 1 章、COMMON.md 第 1・3・5・7 章)。
// すべて入力式(answerKind: 'text')。答えは計算で決まるので常に正確。
//   Lv11 2 進 ⇄ 10 進(1 オクテット)                 Lv16 あるホストが属するサブネットの番号(1 始まり)+ その CIDR
//   Lv12 16 進 ⇄ 2 進 ⇄ 10 進(ヘクステット・バイト)   Lv17 N 番目のサブネットの CIDR(分割数も)
//   Lv13 MAC アドレスの構造(OUI / 機器識別部 / U/L / I/G)  Lv18 N 番目のサブネットの 4 値(ネットワーク・ブロードキャスト・最初・最後)
//   Lv14 任意プレフィックスのネットワークとブロードキャスト  Lv19 IPv6 の非 16 ビット境界プレフィックス / N 番目の /64
//   Lv15 使用可能範囲の両端                           Lv20 2 進表記からの総合(プレフィックス長・CIDR・ホスト番号)
// 生成器は rng を引数で受け取り Math.random を使わない((templateId, seed, generatorVersion) から再現できる)。
// 乱数で決めるパラメータと、パラメータから問題を描く BUILDERS[level](params) を分けてある(検証テストは例題を同じ値で作る)。
// fields[].accept は normalize を通した正規形。アドレスは拠点の base / span から、安全範囲(10/8、172.16/12、192.168/16)の中だけで作る。

const { toIp, maskOf, netOf, bcastOf } = require('./subnet');
const { v6Canonical, v6Full } = require('./basics');
const { normalize } = require('./normalize');

const VERSION = '2026.10';
const RANGE = [11, 20];

const fmt = (n) => n.toLocaleString('ja-JP');
const sizeOf = (p) => 2 ** (32 - p);
const octet = (ip, k) => (ip >>> (24 - 8 * k)) & 255;
const bin8 = (n) => n.toString(2).padStart(8, '0');
const binDotted = (ip) => [0, 1, 2, 3].map((k) => bin8(octet(ip, k))).join('.');
const hexOf = (n, digits) => n.toString(16).padStart(digits, '0');
const cidr = (net, p) => `${toIp(net)}/${p}`;

// ---------- 安全範囲(COMMON.md 第 7 章) ----------
const FAMILIES = [
  { start: 0x0a000000, p: 8, label: '10.0.0.0/8' },
  { start: 0xac100000, p: 12, label: '172.16.0.0/12' },
  { start: 0xc0a80000, p: 16, label: '192.168.0.0/16' },
];
const familyOf = (ip) => FAMILIES.find((f) => netOf(ip, f.p) === f.start) || null;

// 拠点のアドレス帳から 1 つ選ぶ。/p のブロックが拠点の範囲(172.16/12 の拠点で /11 など)に収まらないときは、収まる範囲に逃がす
function anchorFor(rng, node, p) {
  const span = Math.max(1, node.span || 65534);
  let ip = ((node.base >>> 0) + rng.rand(0, span)) >>> 0;
  const fam = familyOf(ip);
  if (!fam || fam.p > p) {
    const f = rng.pick(FAMILIES.filter((x) => x.p <= p));
    ip = (f.start + rng.rand(0, sizeOf(f.p) - 1)) >>> 0;
  }
  return ip;
}
// 拠点に由来する /p のブロックと、その中の 1 アドレス(hostOnly なら両端を除く)
function blockFor(rng, node, p) { return netOf(anchorFor(rng, node, p), p); }
function addrIn(rng, net, p, hostOnly = false) {
  const size = sizeOf(p);
  return (net + rng.rand(hostOnly ? 1 : 0, size - 1 - (hostOnly ? 1 : 0))) >>> 0;
}

// MAC: 文書用(RFC 7042)とローカル管理(第 1 バイトの下位 2 ビットが 10)を半々
function macFor(rng, kind) {
  const bytes = kind === 'doc'
    ? [0x00, 0x00, 0x5e, 0x00, 0x53, rng.rand(0, 255)]
    : [(rng.rand(0, 255) & 0xfc) | 0x02, ...Array.from({ length: 5 }, () => rng.rand(0, 255))];
  return bytes.map((b) => hexOf(b, 2)).join(':');
}
function v6Groups(rng) {
  const g = Array.from({ length: 8 }, () => rng.rand(0, 0xffff));
  g[0] = 0x2001; g[1] = 0x0db8; // 文書用 2001:db8::/32
  return g;
}

// ---------- 欄と問題の骨組み ----------
// 欄の例示は答えになり得ない固定文(ipv4 は文書用、ipv6cidr は /32、prefixlen は /8 で、11〜20 の答えには現れない。数は例を出さず形だけ書く)
const HINTS = { number: '半角の数字', ipv4: '例: 192.0.2.1', ipv4cidr: '例: 192.0.2.0/24', ipv6cidr: '例: 2001:db8::/32', prefixlen: '例: 8', mac: '例: 02:00:00', yesno: '○ か ×' };
const hintOf = (format, digits) => (format === 'bin' ? `0 と 1 を ${digits} 桁` : format === 'hex' ? `16 進 ${digits} 桁(0〜9、a〜f)` : HINTS[format]);
function field(name, label, format, raw, extra = {}) {
  const f = { name, label, format, hint: hintOf(format, extra.digits), ...(extra.digits ? { digits: extra.digits } : {}) };
  const accept = normalize(format, raw, f);
  if (accept === null) throw new Error(`正解が正規化できません: ${format} ${raw}`);
  return { ...f, accept: [accept] };
}
const DEFENSE = (what) => `${what}を正しく切れると、ACL や経路の対象範囲を取りこぼさない。`;
function question(templateId, type, text, fields, explanation, defenseNote, meta) {
  return { templateId: `${templateId}-v1`, type, answerKind: 'text', text, fields, explanation, defenseNote, meta, generatorVersion: VERSION };
}
function explainBlock(ip, p) {
  const k = Math.floor(p / 8), block = 2 ** (8 - (p % 8)), v = octet(ip, k), nv = Math.floor(v / block) * block;
  if (p % 8 === 0) return `/${p} は先頭 ${k} オクテットがネットワーク部で、残りを 0 にしたものがネットワーク、255 にしたものがブロードキャスト。`;
  const tail = k < 3 ? 'それより後ろのオクテットは、ネットワークでは 0、ブロードキャストでは 255。' : '';
  return `/${p} は第 ${k + 1} オクテットに境目があり、ブロック幅は ${block}。${v} を ${block} の倍数に切り捨てて ${nv}、ブロックの末尾は ${nv + block - 1}。${tail}`;
}

// ---------- Lv11 2 進 ⇄ 10 進 ----------
const BOUNDARY8 = [0, 1, 127, 128, 254, 255];
function params11(rng) {
  const n = rng.rand(1, 8) === 1 ? rng.pick(BOUNDARY8) : rng.rand(0, 255);
  return { n, dir: rng.pick(['bin2dec', 'dec2bin']) };
}
function build11({ n, dir }) {
  const bin = bin8(n);
  const weights = [...bin].map((b, i) => (b === '1' ? 2 ** (7 - i) : 0)).filter(Boolean);
  const sum = weights.length ? `${weights.join('+')} = ${n}` : '1 のビットが無いので 0';
  const defense = DEFENSE('2 進の位取り(マスクやワイルドカードの境界)');
  if (dir === 'bin2dec') {
    return question('bin-dec', 'bin2dec',
      `2 進数 ${bin} を 10 進数で答えてください。`,
      [field('dec', '10 進数', 'number', String(n))],
      `位の重みは左から 128・64・32・16・8・4・2・1。1 のビットの重みを足すと ${sum}。`, defense, { n, dir, bin });
  }
  const steps = []; let acc = 0;
  for (const w of weights) { acc += w; steps.push(`+${w} → ${acc}`); }
  return question('bin-dec', 'dec2bin',
    `10 進数 ${n} を 8 桁の 2 進数で答えてください(先頭の 0 も書く)。`,
    [field('bin', '2 進数(8 桁)', 'bin', bin, { digits: 8 })],
    `128 から順に引けるかを見る。${weights.length ? steps.join('、') : '0 なので 8 桁すべて 0'} → ${bin.slice(0, 4)} ${bin.slice(4)}。`, defense, { n, dir, bin });
}

// ---------- Lv12 16 進 ⇄ 2 進 ⇄ 10 進 ----------
function params12(rng) {
  const unit = rng.pick(['hextet', 'byte']);
  const dir = rng.pick(['hex2bin', 'bin2hex', 'hex2dec']);
  if (unit === 'hextet') { const groups = v6Groups(rng), idx = rng.rand(1, 8); return { unit, dir, value: groups[idx - 1], groups, idx }; }
  const mac = macFor(rng, rng.pick(['doc', 'local'])), idx = rng.rand(1, 6);
  return { unit, dir, value: parseInt(mac.split(':')[idx - 1], 16), mac, idx };
}
function build12({ unit, dir, value, groups, mac, idx }) {
  const hexDigits = unit === 'hextet' ? 4 : 2, binDigits = hexDigits * 4;
  const hex = hexOf(value, hexDigits), bin = value.toString(2).padStart(binDigits, '0');
  const nibbles = [...hex].map((h) => `${h}→${parseInt(h, 16).toString(2).padStart(4, '0')}`).join('、');
  const ctx = unit === 'hextet'
    ? `IPv6 アドレス ${v6Full(groups)} の ${idx} 番目のヘクステット(16 ビット。先頭を 1 番目とする)${hex}`
    : `MAC アドレス ${mac} の ${idx} 番目のバイト(先頭を 1 番目とする)${hex}`;
  const unitName = unit === 'hextet' ? 'ヘクステット' : 'バイト';
  const defense = DEFENSE('16 進と 2 進の桁の対応(アドレスやマスクの境界)');
  const meta = { unit, dir, value, hex, bin, idx };
  if (dir === 'hex2bin') {
    return question('hex-bin', 'hex2bin', `${ctx} を ${binDigits} 桁の 2 進数で答えてください(先頭の 0 も書く)。`,
      [field('bin', `2 進数(${binDigits} 桁)`, 'bin', bin, { digits: binDigits })],
      `16 進 1 桁は 2 進 4 桁に対応する。${nibbles} → ${bin}。`, defense, meta);
  }
  if (dir === 'bin2hex') {
    const groupsOf4 = bin.match(/.{4}/g).map((b) => `${b}→${parseInt(b, 2).toString(16)}`).join('、');
    return question('hex-bin', 'bin2hex', `2 進数 ${bin}(${unitName}の ${binDigits} ビット)を 16 進 ${hexDigits} 桁で答えてください(先頭の 0 も書く)。`,
      [field('hex', `16 進数(${hexDigits} 桁)`, 'hex', hex, { digits: hexDigits })],
      `左から 4 桁ずつ区切って 16 進 1 桁にする。${groupsOf4} → ${hex}。`, defense, meta);
  }
  const terms = [...hex].map((h, i) => `${parseInt(h, 16)}×${16 ** (hexDigits - 1 - i)}`).join(' + ');
  return question('hex-bin', 'hex2dec', `${ctx} を 10 進数で答えてください。`,
    [field('dec', '10 進数', 'number', String(value))],
    `16 進の各桁に 16 の累乗の重みを掛けて足す。${terms} = ${value}。16 進をそのまま 10 進として読まないこと。`, defense, meta);
}

// ---------- Lv13 MAC アドレスの構造 ----------
const MAC_ASKS = ['oui', 'nic', 'local', 'group'];
function params13(rng) {
  const kind = rng.pick(['doc', 'local']);
  const asks = rng.shuffle(MAC_ASKS).slice(0, 2).sort((a, b) => MAC_ASKS.indexOf(a) - MAC_ASKS.indexOf(b));
  return { mac: macFor(rng, kind), kind, asks };
}
function build13({ mac, kind, asks }) {
  const bytes = mac.split(':');
  const first = parseInt(bytes[0], 16);
  const oui = bytes.slice(0, 3).join(':'), nic = bytes.slice(3).join(':');
  const local = (first & 0x02) !== 0, group = (first & 0x01) !== 0;
  const defs = {
    oui: () => field('oui', 'OUI(メーカー識別部。先頭 24 ビット)', 'mac', oui),
    nic: () => field('nic', '機器識別部(後ろ 24 ビット)', 'mac', nic),
    local: () => field('local', '(a) ローカル管理アドレスか', 'yesno', local ? 'yes' : 'no'),
    group: () => field('group', '(b) マルチキャスト(グループ)宛のアドレスか', 'yesno', group ? 'yes' : 'no'),
  };
  const asksText = {
    oui: 'OUI(メーカー識別部。先頭 24 ビット)を 16 進 6 桁(xx:xx:xx)で', nic: '機器識別部(後ろ 24 ビット)を 16 進 6 桁(xx:xx:xx)で',
    local: '(a) ローカル管理アドレスかを ○×で', group: '(b) マルチキャスト(グループ)宛のアドレスかを ○×で',
  };
  const text = `MAC アドレス ${mac} について、${asks.map((a) => asksText[a]).join('、')}答えてください。`;
  const parts = [];
  if (asks.includes('oui') || asks.includes('nic')) parts.push(`MAC は 48 ビットで、先頭 24 ビット(3 バイト)が OUI、後ろ 24 ビットが機器識別部。${mac} は ${oui} | ${nic} と切れる。16 ビットや 32 ビットで切らないこと。`);
  if (asks.includes('local') || asks.includes('group')) parts.push(`先頭バイト ${bytes[0]} = ${bin8(first).slice(0, 4)} ${bin8(first).slice(4)}。最下位ビット(I/G)が ${group ? 1 : 0} なので${group ? 'マルチキャスト' : 'ユニキャスト'}、下から 2 番目(U/L)が ${local ? 1 : 0} なので${local ? 'ローカル管理' : 'グローバル管理(メーカー割り当て)'}。`);
  return question('mac-parts', 'macparts', text, asks.map((a) => defs[a]()), parts.join(''),
    'OUI と機器識別部の境目と U/L ビットを正しく読めると、MAC によるフィルタの対象や、ARP 表に現れたローカル管理アドレス(詐称の疑い)を取りこぼさない。',
    { mac, kind, asks, oui, nic, local, group });
}

// ---------- Lv14 ネットワークとブロードキャスト ----------
function params14(rng, node) {
  const k = rng.pick([1, 2, 3]); // 境目のオクテット(第 2・3・4)を均等に。/16・/24 は除く
  const p = k === 1 ? rng.rand(9, 15) : k === 2 ? rng.rand(17, 23) : rng.rand(25, 30);
  const net = blockFor(rng, node, p);
  return { ip: addrIn(rng, net, p), p };
}
function build14({ ip, p }) {
  const net = netOf(ip, p), bc = bcastOf(ip, p);
  return question('net-bcast', 'netbcast',
    `${cidr(ip, p)} のネットワークアドレスとブロードキャストアドレスを答えてください。`,
    [field('network', 'ネットワークアドレス', 'ipv4', toIp(net)), field('broadcast', 'ブロードキャストアドレス', 'ipv4', toIp(bc))],
    `${explainBlock(ip, p)} 範囲は ${toIp(net)}〜${toIp(bc)}。`,
    DEFENSE(`/${p} の境界(${toIp(net)}〜${toIp(bc)})`), { ip, p, net, bc });
}

// ---------- Lv15 使用可能範囲の両端 ----------
function params15(rng, node) {
  const p = rng.rand(1, 6) === 1 ? 30 : rng.rand(9, 29);
  const net = blockFor(rng, node, p);
  return { ip: addrIn(rng, net, p), p };
}
function build15({ ip, p }) {
  const net = netOf(ip, p), bc = bcastOf(ip, p), first = (net + 1) >>> 0, last = (bc - 1) >>> 0;
  return question('usable-range', 'usable',
    `${cidr(ip, p)} のサブネットで、機器に割り当てられる最初のアドレスと最後のアドレスを答えてください。`,
    [field('first', '最初のアドレス', 'ipv4', toIp(first)), field('last', '最後のアドレス', 'ipv4', toIp(last))],
    `${explainBlock(ip, p)} ネットワーク ${toIp(net)} の次が最初のホスト、ブロードキャスト ${toIp(bc)} の手前が最後のホスト。${p === 30 ? '/30 は 4 アドレスで使えるのは 2 つだけ。' : ''}`,
    DEFENSE(`/${p} の境界(使えるのは ${toIp(first)}〜${toIp(last)})`), { ip, p, net, bc, first, last });
}

// ---------- Lv16〜18 共通: 親 /p1 を /p2 に等分 ----------
function splitParams(rng, node) {
  const p1 = rng.rand(8, 22);
  const p2 = Math.min(30, p1 + rng.rand(2, 8));
  return { parent: blockFor(rng, node, p1), p1, p2 };
}
const splitIntro = (parent, p1, p2) => `${cidr(parent, p1)} を /${p2} のサブネットに等分した(分割数 ${fmt(2 ** (p2 - p1))})。最初のサブネットを 1 番目とする。`;
function explainWidth(p2) {
  const k = Math.floor(p2 / 8), block = 2 ** (8 - (p2 % 8));
  return p2 % 8 === 0 ? `/${p2} の区画は第 ${k} オクテットが 1 ずつ進む` : `/${p2} の区画は第 ${k + 1} オクテットで幅 ${block}`;
}

// ---------- Lv16 属するサブネットの番号 ----------
function params16(rng, node) {
  const s = splitParams(rng, node);
  return { ...s, ip: addrIn(rng, s.parent, s.p1) };
}
function build16({ parent, p1, p2, ip }) {
  const sub = netOf(ip, p2), size = sizeOf(p2);
  const offset = ip - parent, index = Math.floor(offset / size) + 1;
  return question('subnet-index', 'subnetindex',
    `${splitIntro(parent, p1, p2)} ${toIp(ip)} は何番目のサブネットに属するか、その番号と、そのサブネットの CIDR(ネットワークアドレス/プレフィックス長)を答えてください。`,
    [field('index', '何番目か(1 始まり)', 'number', String(index)), field('cidr', 'そのサブネットの CIDR', 'ipv4cidr', cidr(sub, p2))],
    `親の先頭からのオフセットは ${fmt(offset)}。区画の大きさは 2^${32 - p2} = ${fmt(size)} なので ${fmt(offset)} ÷ ${fmt(size)} = ${Math.floor(offset / size)}(切り捨て)。0 始まりで ${Math.floor(offset / size)}、1 始まりで ${index} 番目。先頭は ${toIp(parent)} + ${Math.floor(offset / size)} × ${fmt(size)} = ${toIp(sub)}(${explainWidth(p2)})。`,
    DEFENSE(`/${p2} の区画の境界(${toIp(sub)}〜${toIp(bcastOf(sub, p2))})`), { parent, p1, p2, ip, sub, index });
}

// ---------- Lv17 N 番目のサブネットの CIDR ----------
function params17(rng, node) {
  const s = splitParams(rng, node);
  return { ...s, n: rng.rand(1, 2 ** (s.p2 - s.p1)) };
}
function build17({ parent, p1, p2, n }) {
  const count = 2 ** (p2 - p1), size = sizeOf(p2), sub = (parent + (n - 1) * size) >>> 0;
  return question('nth-subnet', 'nthsubnet',
    `${cidr(parent, p1)} を /${p2} のサブネットに等分した。分割数と、最初のサブネットを 1 番目として ${fmt(n)} 番目のサブネットの CIDR(ネットワークアドレス/プレフィックス長)を答えてください。`,
    [field('count', '分割数', 'number', String(count)), field('cidr', `${fmt(n)} 番目のサブネットの CIDR`, 'ipv4cidr', cidr(sub, p2))],
    `分割数は 2^(${p2}−${p1}) = ${fmt(count)}。区画の大きさは 2^${32 - p2} = ${fmt(size)} なので、${fmt(n)} 番目の先頭は ${toIp(parent)} + (${fmt(n)}−1) × ${fmt(size)} = ${toIp(sub)}(${explainWidth(p2)})。N 番目は (N−1) 個ぶん進めることに注意。`,
    DEFENSE(`/${p2} の区画の境界(${toIp(sub)}〜${toIp(bcastOf(sub, p2))})`), { parent, p1, p2, n, count, sub });
}

// ---------- Lv18 N 番目のサブネットの 4 値 ----------
const params18 = params17;
function build18({ parent, p1, p2, n }) {
  const size = sizeOf(p2), sub = (parent + (n - 1) * size) >>> 0, bc = bcastOf(sub, p2);
  const first = (sub + 1) >>> 0, last = (bc - 1) >>> 0;
  return question('nth-subnet-range', 'nthrange',
    `${splitIntro(parent, p1, p2)} ${fmt(n)} 番目のサブネットのネットワークアドレス・ブロードキャストアドレス・機器に割り当てられる最初のアドレス・最後のアドレスを答えてください。`,
    [field('network', 'ネットワークアドレス', 'ipv4', toIp(sub)), field('broadcast', 'ブロードキャストアドレス', 'ipv4', toIp(bc)),
      field('first', '最初のアドレス', 'ipv4', toIp(first)), field('last', '最後のアドレス', 'ipv4', toIp(last))],
    `区画の大きさは 2^${32 - p2} = ${fmt(size)}。${fmt(n)} 番目の先頭は ${toIp(parent)} + (${fmt(n)}−1) × ${fmt(size)} = ${toIp(sub)}(${explainWidth(p2)})。末尾は先頭 + ${fmt(size - 1)} = ${toIp(bc)}。使えるのはその内側の ${toIp(first)}〜${toIp(last)}。`,
    DEFENSE(`/${p2} の区画の境界(${toIp(sub)}〜${toIp(bc)})`), { parent, p1, p2, n, sub, bc, first, last });
}

// ---------- Lv19 IPv6 ----------
const V6_PREFIXES = [36, 40, 44, 52, 56, 60];
function v6Mask(groups, p) { return groups.map((g, i) => { const keep = Math.max(0, Math.min(16, p - 16 * i)); return keep === 0 ? 0 : (g & ((0xffff << (16 - keep)) & 0xffff)); }); }
function params19(rng) {
  if (rng.pick(['prefix', 'nth']) === 'prefix') return { mode: 'prefix', groups: v6Groups(rng), p: rng.pick(V6_PREFIXES) };
  const pp = rng.pick([48, 56]);
  const groups = [0x2001, 0x0db8, rng.rand(0, 0xffff), pp === 56 ? rng.rand(0, 0xff) << 8 : 0, 0, 0, 0, 0];
  return { mode: 'nth', groups, pp, n: rng.rand(1, 256) };
}
function build19(prm) {
  const defense = 'IPv6 のプレフィックスの境界を正しく切れると、経路や ACL の対象範囲を取りこぼさない。';
  if (prm.mode === 'prefix') {
    const { groups, p } = prm;
    const net = v6Mask(groups, p), i = Math.floor(p / 16), nib = (p % 16) / 4;
    const g = hexOf(groups[i], 4);
    return question('v6-prefix-nibble', 'v6prefix',
      `IPv6 アドレス ${v6Canonical(groups)} が属する /${p} のプレフィックスを、CIDR(プレフィックス/プレフィックス長)で答えてください。`,
      [field('prefix', `/${p} のプレフィックス`, 'ipv6cidr', `${v6Canonical(net)}/${p}`)],
      `/${p} = ${16 * i} + ${p % 16} ビット。${i + 1} 番目のヘクステット ${g} の先頭 ${nib} ニブル(16 進 ${nib} 桁)「${g.slice(0, nib)}」だけを残し、残りの桁と後ろのヘクステットを 0 にする → ${v6Canonical(net)}/${p}。16 ビット境界(/${16 * i} や /${16 * (i + 1)})で切らないこと。`,
      defense, { mode: 'prefix', groups, p, net });
  }
  const { groups, pp, n } = prm;
  const sub = groups.slice(); sub[3] = groups[3] + (n - 1);
  const count = 2 ** (64 - pp);
  return question('v6-nth-64', 'v6nth',
    `${v6Canonical(groups)}/${pp} を /64 に等分した(分割数 ${fmt(count)})。最初を 1 番目として ${n} 番目の /64 を CIDR で答えてください。`,
    [field('prefix', `${n} 番目の /64`, 'ipv6cidr', `${v6Canonical(sub)}/64`)],
    `/${pp} → /64 の ${64 - pp} ビットは 4 番目のヘクステット${pp === 56 ? 'の下位バイト' : ''}。${n} 番目は 0 始まりで ${n - 1} = 16 進 ${(n - 1).toString(16)} なので、4 番目のヘクステットは ${hexOf(groups[3], 4)} + ${(n - 1).toString(16)} = ${hexOf(sub[3], 4)} → ${v6Canonical(sub)}/64。10 進の ${n} をそのまま 16 進の位置に書かないこと。`,
    defense, { mode: 'nth', groups, pp, n, sub });
}

// ---------- Lv20 2 進表記からの総合 ----------
function params20(rng, node) {
  const p = rng.rand(17, 29);
  const net = blockFor(rng, node, p);
  return { ip: addrIn(rng, net, p, true), p };
}
function build20({ ip, p }) {
  const net = netOf(ip, p), hostNo = ip - net;
  return question('from-binary', 'frombinary',
    `次のアドレスとサブネットマスクは 2 進数(8 ビットずつ . で区切り)で書かれている。\nアドレス: ${binDotted(ip)}\nマスク: ${binDotted(maskOf(p))}\n(1) プレフィックス長、(2) ネットワークアドレスを CIDR(ネットワークアドレス/プレフィックス長)で、(3) このアドレスはそのサブネットの何番目のホストか(ネットワークアドレスの次を 1 番目とする)を答えてください。`,
    [field('prefixlen', '(1) プレフィックス長', 'prefixlen', String(p)), field('cidr', '(2) ネットワークアドレス(CIDR)', 'ipv4cidr', cidr(net, p)), field('hostno', '(3) 何番目のホストか(1 始まり)', 'number', String(hostNo))],
    `マスクの 1 の数は ${p} 個なので /${p}。アドレスを 10 進に戻すと ${toIp(ip)}。${explainBlock(ip, p)} ネットワークは ${cidr(net, p)}。ホスト番号はアドレス − ネットワークアドレス = ${fmt(hostNo)}(最初のホストが 1 番目なので、ネットワークアドレス自身は 0)。`,
    DEFENSE(`/${p} の境界(${toIp(net)}〜${toIp(bcastOf(net, p))})`), { ip, p, net, hostNo });
}

const PARAMS = { 11: params11, 12: params12, 13: params13, 14: params14, 15: params15, 16: params16, 17: params17, 18: params18, 19: params19, 20: params20 };
const BUILDERS = { 11: build11, 12: build12, 13: build13, 14: build14, 15: build15, 16: build16, 17: build17, 18: build18, 19: build19, 20: build20 };

function make(level, node, rng) {
  if (!PARAMS[level]) throw new Error(`Lv${level} は calc.js の範囲(${RANGE.join('〜')})外です`);
  const q = BUILDERS[level](PARAMS[level](rng, node));
  q.level = level;
  q.seed = rng.seed;
  return q;
}

module.exports = { make, RANGE, VERSION, BUILDERS, FAMILIES, familyOf, v6Mask, binDotted };
