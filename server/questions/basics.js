'use strict';
// Lv4〜10 の知識(設計書 8.18 訂正版の表)を生成する。すべて 4 択。答えは計算で決まるので常に正確。
//   Lv4  VLSM(必要ホスト数 → 最小プレフィックス)、ワイルドカードマスク
//   Lv5  CIDR の集約(2〜4 個をまとめる)、IPv6 の省略表記
//   Lv6  IPv6 のプレフィックスと範囲、アドレスの種類(GUA / ULA / リンクローカル / マルチキャスト)
//   Lv7  経路表(3〜4 行)の最長一致で次の転送先を選ぶ
//   Lv8  ARP テーブル・MAC アドレステーブルから機器の場所を特定する
//   Lv9  ACL(1〜2 行)を読んで通る・通らないを判定する
//   Lv10 NAT/NAPT の変換表を読んで内外のアドレス対応を答える
// 表を使う問題は q.table = { headers, rows } を付け、画面側が表として描く。
// q.meta はテスト用の真の値で、クライアントには送らない(world.ask が payload に含めない)。

// 乱数は subnet.js の rand・pick・shuffle・random(ふだんは Math.random。新しい番号の口は withRng で seed 付きに差し替える)
const { toIp, maskOf, netOf, bcastOf, buildOptions, rand, pick, shuffle, random } = require('./subnet');

const fmt = (n) => n.toLocaleString('ja-JP');
const wildcardOf = (p) => (~maskOf(p)) >>> 0;
const parseIp = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0) >>> 0;

// ---------- Lv4 ----------
function vlsm(base) {
  const hosts = pick([2, 5, 10, 14, 20, 25, 30, 50, 60, 100, 120, 126, 200, 250, 254, 300, 500, 510, 1000, 2000]);
  // 必要ホスト数 + ネットワークアドレス + ブロードキャストが収まる最小のブロック
  let h = 2;
  while (2 ** h - 2 < hosts) h++;
  const p = 32 - h;
  const correct = `/${p}`;
  const cands = [p + 1, p - 1, p + 2, p - 2].filter((x) => x >= 8 && x <= 30).map((x) => `/${x}`);
  const q = buildOptions(correct, cands, () => `/${rand(16, 30)}`);
  q.text = `ホスト(機器)が ${fmt(hosts)} 台必要なサブネットで、最も小さいプレフィックス長は？`;
  q.explanation = `ネットワークアドレスとブロードキャストの 2 個を除いて ${fmt(hosts)} 台を収めるには 2^${h} = ${fmt(2 ** h)} 個のアドレスが必要。ホスト部が ${h} ビットなので 32 − ${h} = /${p}。`;
  q.type = 'vlsm'; q.meta = { hosts, p };
  return q;
}
function wildcard(base) {
  const p = rand(8, 30);
  const correct = toIp(wildcardOf(p));
  const cands = [toIp(maskOf(p)), toIp(wildcardOf(p - 1)), toIp(wildcardOf(p + 1)), toIp(wildcardOf(p + 2))];
  const q = buildOptions(correct, cands, () => toIp(wildcardOf(rand(8, 30))));
  q.text = `/${p} に対応するワイルドカードマスクは？`;
  q.explanation = `ワイルドカードマスクはサブネットマスク ${toIp(maskOf(p))} の各ビットを反転したもの。0 は「一致が必要」、1 は「何でもよい」を表し、${correct} になる。`;
  q.type = 'wildcard'; q.meta = { p };
  return q;
}

// ---------- Lv5 ----------
function summarize(base) {
  const k = pick([2, 4]);             // まとめる個数
  const p = pick([22, 23, 24, 25, 26]); // 各ブロックのプレフィックス
  const sp = p - Math.log2(k);         // 集約後
  const size = 2 ** (32 - p);
  // 集約境界に揃った先頭ブロックを選ぶ
  const start = netOf((base + rand(0, 65535)) >>> 0, sp);
  const blocks = Array.from({ length: k }, (_, i) => `${toIp((start + i * size) >>> 0)}/${p}`);
  const correct = `${toIp(start)}/${sp}`;
  const cands = [`${toIp(start)}/${sp - 1}`, `${toIp(start)}/${sp + 1}`, `${toIp(start)}/${p}`, `${toIp((start + size) >>> 0)}/${sp}`];
  const q = buildOptions(correct, cands, () => `${toIp(netOf((base + rand(0, 65535)) >>> 0, sp))}/${rand(16, 24)}`);
  q.text = `次の ${k} 個のネットワークを 1 つにまとめた(集約した)最小のプレフィックスは？\n${blocks.join('\n')}`;
  q.explanation = `${k} 個の /${p} が連続して境界に揃っているので、プレフィックス長を ${Math.log2(k)} ビット短くして /${sp}。先頭は ${toIp(start)}。`;
  q.type = 'summary'; q.meta = { blocks, start, p, k, sp };
  return q;
}
// IPv6: 16 ビット × 8 の配列で扱う
function v6Full(groups) { return groups.map((g) => g.toString(16).padStart(4, '0')).join(':'); }
function v6Canonical(groups) {
  // RFC 5952: 最長のゼロ連続(2 個以上)を :: に。同じ長さなら最初。先頭ゼロは省く。小文字
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}
function randomV6() {
  const g = Array.from({ length: 8 }, () => rand(0, 0xffff));
  g[0] = 0x2001; g[1] = 0x0db8; // 文書用 2001:db8::/32
  const zeroStart = rand(2, 5), zeroLen = rand(2, 7 - zeroStart);
  for (let i = zeroStart; i < zeroStart + zeroLen; i++) g[i] = 0;
  if (random() < 0.5) g[7] = 0; // 短いゼロの候補も作る
  if (random() < 0.4) g[2] = 0;
  return g;
}
function v6Compress(base) {
  const g = randomV6();
  const correct = v6Canonical(g);
  const hex = g.map((x) => x.toString(16));
  // 誤答: 先頭ゼロだけ省いて :: を使わない / 短い方のゼロ連続を :: にする / 先頭ゼロを残す
  const noCompress = hex.join(':');
  const keepZeros = correct.replace(/(^|:)([0-9a-f]{1,3})(?=:|$)/g, (m, a, b) => a + b.padStart(4, '0'));
  let wrongRun = null;
  for (let i = 0; i < 8; i++) if (g[i] === 0 && !(correct.split('::')[0].split(':').length <= i && i < 8 - (correct.split('::')[1] || '').split(':').filter(Boolean).length)) { wrongRun = `${hex.slice(0, i).join(':')}::${hex.slice(i + 1).join(':')}`; break; }
  const cands = [noCompress, keepZeros, wrongRun].filter((c) => c && c !== correct);
  const q = buildOptions(correct, cands, () => v6Canonical(randomV6()));
  q.text = `次の IPv6 アドレスを、省略の規則(最も長い 0 の並びを 1 か所だけ :: にし、各区切りの先頭の 0 を省く)で正しく書いたものは？\n${v6Full(g)}`;
  q.explanation = `0 だけの区切りが最も長く続く所を 1 か所だけ :: にし(同じ長さなら先頭側)、各区切りの先頭の 0 を省くと ${correct}。`;
  q.type = 'v6compress'; q.meta = { groups: g };
  return q;
}

// ---------- Lv6 ----------
const V6_KINDS = [
  { name: 'グローバルユニキャスト', make: () => [0x2000 + rand(0, 0x1fff), rand(0, 0xffff)], hint: '先頭が 2000::/3(2 または 3 で始まる)' },
  { name: 'ユニークローカル', make: () => [0xfd00 + rand(0, 0xff), rand(0, 0xffff)], hint: '先頭が fc00::/7(fc または fd で始まる)。組織内だけで使う' },
  { name: 'リンクローカル', make: () => [0xfe80, 0], hint: '先頭が fe80::/10。同じリンク内だけで使い、ルータを越えない' },
  { name: 'マルチキャスト', make: () => [0xff00 + rand(1, 0xff), rand(0, 0xffff)], hint: '先頭が ff00::/8。複数の受信者へ届ける' },
];
function v6Kind(base) {
  const kind = pick(V6_KINDS);
  const head = kind.make();
  const g = [head[0], head[1], ...Array.from({ length: 6 }, () => rand(0, 0xffff))];
  if (kind.name === 'リンクローカル') { g[2] = 0; g[3] = 0; }
  const correct = kind.name;
  const q = buildOptions(correct, V6_KINDS.map((k) => k.name).filter((n) => n !== correct), () => 'ループバック');
  q.text = `IPv6 アドレス ${v6Canonical(g)} の種類は？`;
  q.explanation = `${kind.hint}。したがって${correct}アドレス。`;
  q.type = 'v6kind'; q.meta = { kind: correct, groups: g };
  return q;
}
function v6Prefix(base) {
  const p = pick([32, 48, 64]);
  const g = randomV6().map((x, i) => (i >= 2 ? rand(1, 0xffff) : x));
  const net = g.map((x, i) => (i < p / 16 ? x : 0));
  const correct = `${v6Canonical(net)}/${p}`;
  const wrong1 = `${v6Canonical(g.map((x, i) => (i < p / 16 + 1 ? x : 0)))}/${p}`;
  const wrong2 = `${v6Canonical(g.map((x, i) => (i < p / 16 - 1 ? x : 0)))}/${p}`;
  const wrong3 = `${v6Canonical(net)}/${p + 16}`;
  const q = buildOptions(correct, [wrong1, wrong2, wrong3], () => `${v6Canonical(randomV6())}/${p}`);
  q.text = `IPv6 アドレス ${v6Canonical(g)} が属する /${p} のプレフィックスは？`;
  q.explanation = `/${p} は先頭から ${p / 16} 区切り(${p} ビット)がネットワーク部。残りを 0 にして ${correct}。`;
  q.type = 'v6prefix'; q.meta = { groups: g, p };
  return q;
}

// ---------- Lv7 経路表 ----------
function routeTable(base) {
  const hops = shuffle(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']).slice(0, 4);
  const net16 = netOf((base + rand(0, 65535)) >>> 0, 16);
  const net24 = (net16 + rand(1, 255) * 256) >>> 0;
  const net28 = (net24 + pick([0, 16, 32, 64, 128])) >>> 0;
  const rows = [
    { prefix: '0.0.0.0/0', net: 0, p: 0, hop: hops[0] },
    { prefix: `${toIp(net16)}/16`, net: net16, p: 16, hop: hops[1] },
    { prefix: `${toIp(net24)}/24`, net: net24, p: 24, hop: hops[2] },
  ];
  if (random() < 0.6) rows.push({ prefix: `${toIp(net28)}/28`, net: net28, p: 28, hop: hops[3] });
  // 宛先: いずれかの行に一致する(最長一致で答えが決まる)
  const target = pick(rows);
  let dst;
  if (target.p === 0) dst = ((net16 ^ (1 << 24)) + rand(1, 65534)) >>> 0; // /16 の外
  else if (target.p === 16) dst = (net16 + ((rand(1, 255) ^ ((net24 >>> 8) & 255)) << 8) + rand(1, 254)) >>> 0; // /16 内で /24 の外
  else if (target.p === 24) { do { dst = (net24 + rand(1, 254)) >>> 0; } while (rows.length === 4 && netOf(dst, 28) === net28); }
  else dst = (net28 + rand(1, 14)) >>> 0;
  // 最長一致を計算(検証用に真の値を meta に)
  const match = rows.filter((r) => netOf(dst, r.p) === r.net).sort((a, b) => b.p - a.p)[0];
  const correct = match.hop;
  const q = buildOptions(correct, hops.filter((h) => h !== correct), () => `10.0.0.${rand(5, 9)}`);
  q.text = `次の経路表を持つルータに ${toIp(dst)} 宛のパケットが届いた。転送先(ネクストホップ)は？`;
  q.table = { headers: ['宛先ネットワーク', 'ネクストホップ'], rows: shuffle(rows.map((r) => [r.prefix, r.hop])) };
  q.explanation = `宛先 ${toIp(dst)} に一致する経路のうち、プレフィックスが最も長い ${match.prefix} が選ばれる(最長一致)。その転送先は ${correct}。`;
  q.type = 'route'; q.meta = { dst, rows: rows.map((r) => ({ prefix: r.prefix, hop: r.hop })) };
  return q;
}

// ---------- Lv8 ARP / MAC テーブル ----------
const randMac = () => Array.from({ length: 6 }, (_, i) => (i === 0 ? 0x02 : rand(0, 255)).toString(16).padStart(2, '0')).join(':');
function macTable(base) {
  const ports = shuffle(['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4', 'Gi0/5']).slice(0, 4);
  const rows = Array.from({ length: 4 }, (_, i) => ({ mac: randMac(), port: ports[i] }));
  const t = pick(rows);
  const q = buildOptions(t.port, ports.filter((p) => p !== t.port), () => 'Gi0/9');
  q.text = `スイッチの MAC アドレステーブルが次のとき、MAC アドレス ${t.mac} の機器が接続されているポートは？`;
  q.table = { headers: ['MAC アドレス', 'ポート'], rows: shuffle(rows.map((r) => [r.mac, r.port])) };
  q.explanation = `MAC アドレステーブルは「この MAC からのフレームをどのポートで受信したか」の記録。${t.mac} の行を読むと ${t.port}。`;
  q.type = 'mactable'; q.meta = { mac: t.mac, port: t.port, rows };
  return q;
}
function arpTable(base) {
  const net = netOf((base + rand(0, 65535)) >>> 0, 24);
  const hostNums = shuffle(Array.from({ length: 254 }, (_, i) => i + 1)).slice(0, 4); // 重複しないホスト番号
  const rows = hostNums.map((h) => ({ ip: toIp((net + h) >>> 0), mac: randMac() }));
  const t = pick(rows);
  const q = buildOptions(t.mac, rows.map((r) => r.mac).filter((m) => m !== t.mac), randMac);
  q.text = `ホストの ARP テーブルが次のとき、同じネットワークの ${t.ip} へ送るフレームの宛先 MAC アドレスは？`;
  q.table = { headers: ['IP アドレス', 'MAC アドレス'], rows: rows.map((r) => [r.ip, r.mac]) };
  q.explanation = `同じネットワーク内の宛先には、ARP で解決した相手の MAC を宛先にする。${t.ip} の行は ${t.mac}。`;
  q.type = 'arptable'; q.meta = { ip: t.ip, mac: t.mac, rows };
  return q;
}

// ---------- Lv9 ACL ----------
// ゲーム内の簡略文法: 行番号 permit|deny プロトコル 送信元(ネットワーク/プレフィックス or any) 宛先 [eq ポート]
function aclEval(lines, pkt) {
  for (const l of lines) {
    const protoOk = l.proto === 'ip' || l.proto === pkt.proto;
    const srcOk = l.src === 'any' || netOf(pkt.src, l.srcP) === l.srcNet;
    const dstOk = l.dst === 'any' || netOf(pkt.dst, l.dstP) === l.dstNet;
    const portOk = l.port == null || l.port === pkt.port;
    if (protoOk && srcOk && dstOk && portOk) return { action: l.action, line: l.no };
  }
  return { action: 'deny', line: null }; // 暗黙の拒否
}
function acl(base) {
  const inside = netOf((base + rand(0, 65535)) >>> 0, 24);
  const other = netOf((base + rand(0, 65535)) >>> 0, 24) === inside ? (inside ^ 0x100) >>> 0 : netOf((base + rand(0, 65535)) >>> 0, 24);
  const server = (netOf((base + 0x3000) >>> 0, 24) + 10) >>> 0;
  const svc = pick([{ proto: 'tcp', port: 22, name: 'SSH' }, { proto: 'tcp', port: 80, name: 'HTTP' }, { proto: 'tcp', port: 443, name: 'HTTPS' }, { proto: 'tcp', port: 23, name: 'Telnet' }, { proto: 'udp', port: 53, name: 'DNS' }]);
  const lines = [
    { no: 10, action: pick(['deny', 'permit']), proto: svc.proto, src: `${toIp(inside)}/24`, srcNet: inside, srcP: 24, dst: 'any', port: svc.port },
  ];
  if (random() < 0.7) lines.push({ no: 20, action: 'permit', proto: 'ip', src: 'any', dst: 'any', port: null });
  // パケット: 行 10 に当たる / 行 20 に当たる / 暗黙の拒否 のいずれか
  const which = pick(lines.length === 2 ? ['l10', 'l20', 'l20b'] : ['l10', 'implicit', 'implicit2']);
  let pkt;
  if (which === 'l10') pkt = { src: (inside + rand(1, 254)) >>> 0, dst: server, proto: svc.proto, port: svc.port };
  else if (which === 'l20') pkt = { src: (other + rand(1, 254)) >>> 0, dst: server, proto: svc.proto, port: svc.port };
  else if (which === 'l20b') pkt = { src: (inside + rand(1, 254)) >>> 0, dst: server, proto: svc.proto, port: svc.port === 80 ? 443 : 80 };
  else if (which === 'implicit') pkt = { src: (other + rand(1, 254)) >>> 0, dst: server, proto: svc.proto, port: svc.port };
  else pkt = { src: (inside + rand(1, 254)) >>> 0, dst: server, proto: svc.proto, port: svc.port === 80 ? 443 : 80 };
  const r = aclEval(lines, pkt);
  const label = (a, line) => (line == null ? '暗黙の拒否で拒否される' : `行 ${line} で${a === 'permit' ? '許可' : '拒否'}される`);
  const correct = label(r.action, r.line);
  const all = ['行 10 で許可される', '行 10 で拒否される', '行 20 で許可される', '行 20 で拒否される', '暗黙の拒否で拒否される'];
  const q = buildOptions(correct, shuffle(all.filter((o) => o !== correct)), () => '条件に合わないため転送されない');
  const protoName = pkt.proto.toUpperCase();
  q.text = `次の ACL が適用されたインターフェースに、送信元 ${toIp(pkt.src)} から宛先 ${toIp(pkt.dst)} へ ${protoName} ポート ${pkt.port}(${svc.port === pkt.port ? svc.name : 'その他'})のパケットが届いた。結果は？`;
  q.table = { headers: ['行', '動作', 'プロトコル', '送信元', '宛先', 'ポート'], rows: lines.map((l) => [String(l.no), l.action, l.proto, l.src, l.dst, l.port == null ? '-' : `eq ${l.port}`]).concat([['(末尾)', 'deny', 'ip', 'any', 'any', '暗黙の拒否']]) };
  q.explanation = `ACL は上から順に評価し、最初に一致した行で決まる。${r.line == null ? 'どの行にも一致しないので、末尾の暗黙の拒否で拒否される。' : `行 ${r.line} の条件(プロトコル・送信元・宛先・ポート)にすべて一致するので、その動作「${r.action}」になる。`}`;
  q.type = 'acl'; q.meta = { lines: lines.map((l) => ({ no: l.no, action: l.action, proto: l.proto, srcNet: l.src === 'any' ? null : l.srcNet, srcP: l.srcP || null, port: l.port })), pkt, result: r };
  return q;
}

// ---------- Lv10 NAT 表 ----------
function natTable(base) {
  const inside = netOf((base + rand(0, 65535)) >>> 0, 24);
  const global = '203.0.113.' + rand(2, 250); // 文書用アドレス
  const rows = shuffle([11, 12, 13, 14, 15, 16]).slice(0, 4).map((h, i) => ({
    local: `${toIp((inside + h) >>> 0)}:${rand(40000, 60000)}`, globalAddr: `${global}:${rand(40000, 60000)}`, outside: `198.51.100.${rand(2, 250)}:${pick([80, 443, 53])}`,
  }));
  const t = pick(rows);
  const dir = pick(['in', 'out']);
  let q;
  if (dir === 'in') {
    q = buildOptions(t.local, rows.map((r) => r.local).filter((l) => l !== t.local), () => `${toIp((inside + rand(20, 200)) >>> 0)}:${rand(40000, 60000)}`);
    q.text = `NAPT の変換表が次のとき、外部の ${t.outside} から ${t.globalAddr} 宛に戻ってきたパケットは、内部のどのアドレス:ポートへ届けられる？`;
    q.explanation = `戻りのパケットは「内側グローバル」の列で変換表を引き、対応する「内側ローカル」へ届く。${t.globalAddr} の行は ${t.local}。`;
  } else {
    q = buildOptions(t.globalAddr, rows.map((r) => r.globalAddr).filter((g) => g !== t.globalAddr), () => `${global}:${rand(40000, 60000)}`);
    q.text = `NAPT の変換表が次のとき、内部の ${t.local} から ${t.outside} へ送るパケットの送信元は、外へ出るときどのアドレス:ポートに書き換えられる？`;
    q.explanation = `外へ出るパケットは「内側ローカル」の列で変換表を引き、「内側グローバル」に書き換えられる。${t.local} の行は ${t.globalAddr}。`;
  }
  q.table = { headers: ['内側ローカル', '内側グローバル', '外側(宛先)'], rows: rows.map((r) => [r.local, r.globalAddr, r.outside]) };
  q.type = 'nat'; q.meta = { dir, row: t, rows };
  return q;
}

// レベル → 生成器(設計書 8.18 訂正版)
const BY_LEVEL = {
  4: [vlsm, wildcard],
  5: [summarize, v6Compress],
  6: [v6Kind, v6Prefix],
  7: [routeTable],
  8: [macTable, arpTable],
  9: [acl],
  10: [natTable],
};

function makeBasics(level, base) {
  const gens = BY_LEVEL[level];
  if (!gens) throw new Error(`Lv${level} の生成器はありません`);
  const q = pick(gens)(base);
  q.level = level;
  return q;
}

module.exports = { makeBasics, BY_LEVEL, v6Canonical, v6Full, aclEval, wildcardOf, parseIp };
