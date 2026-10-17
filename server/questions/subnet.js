'use strict';
// サブネット計算の問題をその場で生成する。答えは計算で求めるので常に正確。

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskOf = (p) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
const netOf = (ip, p) => (ip & maskOf(p)) >>> 0;
const bcastOf = (ip, p) => (netOf(ip, p) | (~maskOf(p) >>> 0)) >>> 0;
const octet = (ip, k) => (ip >>> (24 - 8 * k)) & 255;

const PREFIXES = {
  1: [16, 24],
  2: [25, 26, 27, 28],
  3: [19, 20, 21, 22, 23, 29, 30],
};
const TYPES = {
  1: ['mask', 'network', 'hosts'],
  2: ['mask', 'network', 'broadcast', 'hosts', 'same'],
  3: ['mask', 'network', 'broadcast', 'hosts', 'same'],
};

function explainNetwork(ip, p) {
  const net = netOf(ip, p);
  if (p % 8 === 0) {
    return `/${p} なので先頭 ${p / 8} 区切りがネットワーク部。残りを 0 にして ${toIp(net)}。`;
  }
  const k = Math.floor(p / 8);
  const block = 2 ** (8 - (p % 8));
  const v = octet(ip, k);
  const nv = Math.floor(v / block) * block;
  return `/${p} は ${k + 1} 番目の区切りが境目で、ブロック幅は ${block}。${v} を ${block} の倍数に切り捨てると ${nv}。それより後ろは 0 にして ${toIp(net)}。`;
}

// 正解 + 候補から重複なしで4択を作る
function buildOptions(correct, candidates, filler) {
  const set = new Set([correct]);
  for (const c of candidates) {
    if (set.size >= 4) break;
    if (c != null && c !== '') set.add(c);
  }
  let guard = 0;
  while (set.size < 4 && guard++ < 50) set.add(filler());
  const options = shuffle([...set]);
  return { options, answerIndex: options.indexOf(correct) };
}

// base: 架空ネットワークの先頭アドレス。span: その中で使うアドレス数(既定は /16 ぶん)
function makeQuestion(difficulty, base, span = 65534) {
  const d = Math.max(1, Math.min(3, difficulty));
  const type = pick(TYPES[d]);
  const p = type === 'mask' && d === 1 ? pick([8, 16, 24]) : pick(PREFIXES[d]);
  const ip = (base + rand(1, Math.max(2, span))) >>> 0;
  const size = 2 ** (32 - p);
  const net = netOf(ip, p);
  const bc = bcastOf(ip, p);
  const inRange = (n) => n >= 0 && n <= 0xffffffff;
  const ipStr = (n) => (inRange(n) ? toIp(n) : null);
  let q;

  if (type === 'mask') {
    const correct = toIp(maskOf(p));
    const cands = [p - 1, p + 1, p + 2, p - 2, p + 3]
      .filter((x) => x >= 1 && x <= 32)
      .map((x) => toIp(maskOf(x)));
    q = buildOptions(correct, cands, () => toIp(maskOf(rand(8, 30))));
    q.text = `/${p} をサブネットマスクで書くと？`;
    q.explanation = `/${p} は先頭から ${p} ビットが 1。8 ビットずつ区切って 10 進数にすると ${correct}。`;
  } else if (type === 'network') {
    const correct = toIp(net);
    const cands = [ipStr(net + size), ipStr(net - size), toIp(bc), ip !== net ? toIp(ip) : null, ipStr(net + 2 * size)];
    q = buildOptions(correct, cands, () => toIp(netOf((base + rand(0, Math.max(3, span + 1))) >>> 0, p)));
    q.text = `${toIp(ip)}/${p} のネットワークアドレスは？`;
    q.explanation = explainNetwork(ip, p);
  } else if (type === 'broadcast') {
    const correct = toIp(bc);
    const cands = [ipStr(bc - size), ipStr(bc + size), toIp(net), ipStr(bc - 1)];
    q = buildOptions(correct, cands, () => toIp(bcastOf((base + rand(0, Math.max(3, span + 1))) >>> 0, p)));
    q.text = `${toIp(ip)}/${p} のブロードキャストアドレスは？`;
    q.explanation = `${explainNetwork(ip, p)} ブロック幅 ${size.toLocaleString('ja-JP')} 個分の範囲は ${toIp(net)}〜${toIp(bc)}。最後のアドレスがブロードキャスト。`;
  } else if (type === 'hosts') {
    const h = 32 - p;
    const fmt = (n) => n.toLocaleString('ja-JP');
    const correct = fmt(size - 2);
    const cands = [size, size - 1, size / 2 - 2, size * 2 - 2, size / 2]
      .filter((n) => n > 0)
      .map(fmt);
    q = buildOptions(correct, cands, () => fmt(2 ** rand(2, 16) - 2));
    q.text = `/${p} のネットワークで、機器に割り当てられるアドレスはいくつ？`;
    q.explanation = `ホスト部は 32 − ${p} = ${h} ビット。2^${h} = ${fmt(size)} 個から、ネットワークアドレスとブロードキャストアドレスの 2 個を引いて ${correct}。`;
  } else {
    // same: 同じネットワークにあるアドレスを選ぶ
    let ans = ip === net + 1 ? net + 2 : net + 1;
    for (let tries = 0; tries < 20; tries++) {
      const cand = net + rand(1, size - 2);
      if (cand !== ip) { ans = cand; break; }
    }
    const offset = ans - net;
    const correct = toIp(ans);
    const cands = [net + size + offset, net - size + offset, net + 2 * size + offset, net - 2 * size + offset]
      .filter(inRange)
      .map(toIp);
    q = buildOptions(correct, cands, () => toIp((net + size * rand(3, 9) + offset) >>> 0));
    q.text = `${toIp(ip)}/${p} と同じネットワークにあるのは？`;
    q.explanation = `/${p} で区切ると ${toIp(ip)} の範囲は ${toIp(net)}〜${toIp(bc)}。この範囲に入るのは ${correct}。`;
  }
  q.type = type;
  q.difficulty = d;
  return q;
}

module.exports = { makeQuestion, toIp, maskOf, netOf, bcastOf };
