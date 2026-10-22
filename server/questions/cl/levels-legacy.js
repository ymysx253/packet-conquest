'use strict';
// 前の生成器を新しい番号(docs/LEVEL-LIST.md の「今の問題」列が埋まっている 57 レベル)で出す口(2026-10-22)。担当: 前の生成器の口。
// 書き方は docs/questions/CL.md。前の生成器(subnet.js・basics.js・calc.js・vlsm.js・transport.js)は 1 つの Lv に型を 2〜5 つ混ぜているので、
// ここでは 1 レベルに型を 1 つだけ決めて作る。答え(answerIndex・accept・meta)・問題文・解説は前の生成器のまま使い、
// 新しい番号の型の名前(kind)と、段に応じた手助け(入門は card、初級は hint、中級は firstStep)を足す。
// 乱数は引数の rng だけ。subnet.js・basics.js は Math.random で作る作りなので、subnet.withRng で一時的に rng に差し替える(今のゲームの出題は変わらない)。
// verify は前の生成器とは別の素朴な計算(または問題文・表の読み直し)で答えを解き直す。テストは test/cl.js(まとめて)と test/cl-legacy.js(型が 1 つだけか)
const subnet = require('../subnet');
const basics = require('../basics');
const calc = require('../calc');
const vlsm = require('../vlsm');
const transport = require('../transport');
const { normalize } = require('../normalize');

// ---------- 作る口 ----------
// 拠点が無いとき(ctx.node が null)の架空ネットワーク: 10.x.y.0/20(server/map/geo.js の addrOf と同じ形)
function nodeOf(rng, ctx) {
  const n = ctx && ctx.node;
  if (n && Number.isFinite(n.base)) return n;
  return { base: (0x0a000000 + rng.rand(0, 4095) * 4096) >>> 0, span: 4094 };
}
const fromSubnet = (d, opts) => (rng, node) => subnet.withRng(rng, () => subnet.makeQuestion(d, node.base, node.span || 65534, opts));
const fromBasics = (lv, i) => (rng, node) => subnet.withRng(rng, () => basics.BY_LEVEL[lv][i](node.base));
const fromCalc = (lv, opts) => (rng, node) => calc.make(lv, node, rng, typeof opts === 'function' ? opts(rng) : opts || {});
const fromVlsm = (lv, opts) => (rng, node) => vlsm.make(lv, node, rng, opts || {});
const fromTransport = (lv, i) => (rng, node) => ({ ...transport.BY_LEVEL[lv][i](node, rng), generatorVersion: transport.VERSION });

// 段に応じた手助けの欄(CL.md 第 3 章)。上級・専門は無し
const helpKey = (lv) => (lv <= 67 ? 'card' : lv <= 158 ? 'hint' : lv <= 252 ? 'firstStep' : null);

// 1 レベルを作る。src: 前の生成器のファイルと Lv、types: 出してよい前の型(q.type)、help: 手助けの文(または q から作る関数)
function level(lv, { title, kind = '生', name, src, types, gen, help, verify, minDistinct }) {
  const key = helpKey(lv);
  return {
    title, kind, minDistinct, legacy: { src, types },
    make(rng, ctx) {
      const node = nodeOf(rng, ctx);
      const q = gen(rng, node);
      const out = { ...q, kind: `cl${lv}-${name}-v1`, legacy: { src, level: Number(src.split('Lv')[1]), type: q.type, templateId: q.templateId || null } };
      delete out.level;
      if (key) out[key] = typeof help === 'function' ? help(q) : help;
      return out;
    },
    verify(q) {
      must(types.includes(q.legacy.type), q, `前の型 ${q.legacy.type} は ${types.join('・')} でない`);
      verify(q);
    },
  };
}

// ---------- 確かめるための素朴な計算(前の生成器とは別に書く。ビット演算を使わず割り算で) ----------
function must(cond, q, msg) { if (!cond) throw new Error(`${q.kind}: ${msg}\n${q.text}`); }
const ans = (q) => q.options[q.answerIndex];
const ip2n = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const n2ip = (n) => [16777216, 65536, 256, 1].map((d) => Math.floor(n / d) % 256).join('.');
const blk = (p) => 2 ** (32 - p);
const netN = (n, p) => n - (n % blk(p));
const bcN = (n, p) => netN(n, p) + blk(p) - 1;
const maskStr = (p) => { const b = '1'.repeat(p) + '0'.repeat(32 - p); return [0, 8, 16, 24].map((i) => parseInt(b.slice(i, i + 8), 2)).join('.'); };
const num = (s) => Number(String(s).replace(/,/g, ''));
const ja = (n) => n.toLocaleString('ja-JP');
function match(q, re) { const m = q.text.match(re); must(m, q, `問題文が読めない ${re}`); return m; }
// 入力の欄: name の欄の accept が、raw を同じ形式で正規化したものと同じか
function eqAccept(q, name, format, raw) {
  const f = (q.fields || []).find((x) => x.name === name);
  must(f, q, `欄 ${name} が無い`);
  must(f.format === format, q, `欄 ${name} の形式が ${f.format}(${format} のはず)`);
  const want = normalize(format, String(raw), f);
  must(want !== null && f.accept[0] === want, q, `欄 ${name}: accept ${f.accept[0]} ≠ 解き直し ${want}`);
}
// 入力の欄の全部(順不同)が raws と同じか
function setAccept(q, format, raws) {
  const got = q.fields.map((f) => f.accept[0]).sort();
  const want = raws.map((r) => normalize(format, String(r))).sort();
  must(got.length === want.length && got.every((v, i) => v === want[i]), q, `accept ${got.join(' ')} ≠ 解き直し ${want.join(' ')}`);
}
function choiceIs(q, correct, isRight = (o) => o === correct) {
  must(ans(q) === correct, q, `正解の選択肢 ${ans(q)} ≠ 解き直し ${correct}`);
  q.options.forEach((o, i) => { if (i !== q.answerIndex) must(!isRight(o), q, `誤答 ${o} も正解になる`); });
}
// IPv6: 展開(:: をほどく)と、RFC 5952 の短い書き方
function v6Expand(s) {
  if (!s.includes('::')) return s.split(':').map((g) => parseInt(g, 16));
  const [l, r] = s.split('::');
  const L = l ? l.split(':') : [], R = r ? r.split(':') : [];
  return [...L, ...Array(8 - L.length - R.length).fill('0'), ...R].map((g) => parseInt(g, 16));
}
function v6Short(g) {
  let bestAt = -1, bestLen = 0;
  for (let i = 0; i < 8; i++) {
    let j = i; while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { bestAt = i; bestLen = j - i; }
    if (j > i) i = j - 1;
  }
  const h = g.map((x) => x.toString(16));
  return bestLen < 2 ? h.join(':') : `${h.slice(0, bestAt).join(':')}::${h.slice(bestAt + bestLen).join(':')}`;
}
const v6Cut = (g, p) => g.map((x, i) => { const keep = Math.max(0, Math.min(16, p - 16 * i)); const d = 2 ** (16 - keep); return Math.floor(x / d) * d; });
// VLSM: 台数 + 2 が入る最小の 2 の冪の指数(最小 2 = /30)
const bitsFor = (hosts) => { let b = 2; while (2 ** b < hosts + 2) b++; return b; };
const placeDesc = (start, regions) => {
  const rs = regions.map((r, i) => ({ ...r, i, size: 2 ** bitsFor(r.hosts), p: 32 - bitsFor(r.hosts) })).sort((a, b) => b.size - a.size || a.i - b.i);
  let cur = start; for (const r of rs) { r.net = cur; cur += r.size; }
  return { rs, end: cur };
};
const cidr = (net, p) => `${n2ip(net)}/${p}`;

// ---------- 答えの解き直し(レベルごと) ----------
const V = {
  mask(q) { const p = Number(match(q, /^\/(\d+) をサブネットマスク/)[1]); choiceIs(q, maskStr(p)); return p; },
  network(q) { const m = match(q, /^(\S+)\/(\d+) のネットワークアドレスは/); const p = Number(m[2]); choiceIs(q, n2ip(netN(ip2n(m[1]), p))); return p; },
  broadcast(q) { const m = match(q, /^(\S+)\/(\d+) のブロードキャストアドレスは/); const p = Number(m[2]); choiceIs(q, n2ip(bcN(ip2n(m[1]), p))); return p; },
  hosts(q) { const p = Number(match(q, /^\/(\d+) のネットワークで/)[1]); choiceIs(q, ja(blk(p) - 2)); return p; },
  same(q) {
    const m = match(q, /^(\S+)\/(\d+) と同じネットワーク/); const p = Number(m[2]); const net = netN(ip2n(m[1]), p);
    const inside = (o) => netN(ip2n(o), p) === net;
    must(inside(ans(q)), q, '正解が同じネットワークに無い');
    q.options.forEach((o, i) => { if (i !== q.answerIndex) must(!inside(o), q, `誤答 ${o} も同じネットワーク`); });
    return p;
  },
};
const prefixIn = (list) => (q, p) => must(list.includes(p), q, `/${p} は ${list.join('・')} でない`);

// ACL(1〜2 行 + 暗黙の拒否)を表から読み直して評価する
function aclResult(q) {
  const m = match(q, /送信元 (\S+) から宛先 (\S+) へ (TCP|UDP) ポート (\d+)\(/);
  const pkt = { src: ip2n(m[1]), dst: ip2n(m[2]), proto: m[3].toLowerCase(), port: Number(m[4]) };
  const inNet = (spec, ip) => spec === 'any' || (() => { const [a, p] = spec.split('/'); return netN(ip, Number(p)) === ip2n(a); })();
  for (const [no, action, proto, src, dst, port] of q.table.rows) {
    if (no === '(末尾)') break;
    const ok = (proto === 'ip' || proto === pkt.proto) && inNet(src, pkt.src) && inNet(dst, pkt.dst) && (port === '-' || Number(port.replace('eq ', '')) === pkt.port);
    if (ok) return `行 ${no} で${action === 'permit' ? '許可' : '拒否'}される`;
  }
  return '暗黙の拒否で拒否される';
}
// NAPT: 表の同じプロトコルの内側グローバルのポートを使用中として、port から 1 ずつ上げた最初の空き
function freePort(used, port) { let p = port; while (used.has(p)) p++; return p; }
const usedOf = (rows, proto, col) => new Set(rows.filter((r) => r[0] === proto).map((r) => Number(r[col].split(':')[1])));
// TCP の 3 ウェイハンドシェイク(一般的な定義。表とは別に持つ)
const HS = { 1: { flags: 'SYN', sender: 'クライアント' }, 2: { flags: 'SYN+ACK', sender: 'サーバー' }, 3: { flags: 'ACK', sender: 'クライアント' } };

const L = {};
// ===== 入門 =====
L[16] = level(16, {
  title: '8 けたの 2 進 → 10 進', name: 'bin2dec', src: 'calc.js Lv11', types: ['bin2dec'], minDistinct: 200,
  gen: fromCalc(11, { dir: 'bin2dec' }),
  help: '2 進数の位の重みは、左から 128・64・32・16・8・4・2・1。1 が立っている位の重みを足すと 10 進数になる(例: 00000101 は 4 + 1 = 5)。',
  verify(q) { eqAccept(q, 'dec', 'number', parseInt(match(q, /2 進数 ([01]{8}) を/)[1], 2)); },
});
L[17] = level(17, {
  title: '10 進 → 8 けたの 2 進', name: 'dec2bin', src: 'calc.js Lv11', types: ['dec2bin'], minDistinct: 200,
  gen: fromCalc(11, { dir: 'dec2bin' }),
  help: '8 けたの 2 進数の位の重みは、左から 128・64・32・16・8・4・2・1。128 から順に「残りから引けるなら 1 を書いて引く、引けないなら 0」を 8 回くり返す。',
  verify(q) { eqAccept(q, 'bin', 'bin', Number(match(q, /10 進数 (\d+) を 8 桁/)[1]).toString(2).padStart(8, '0')); },
});

// ===== 初級 =====
const macByte = (q) => { const m = match(q, /MAC アドレス (\S+) の (\d+) 番目のバイト/); return m[1].split(':')[Number(m[2]) - 1]; };
L[78] = level(78, {
  title: '16 進 2 けた → 10 進', name: 'hex2dec', src: 'calc.js Lv12', types: ['hex2dec'],
  gen: fromCalc(12, { unit: 'byte', dir: 'hex2dec' }),
  help: (q) => `16 進 2 けたは「上の桁 × 16 + 下の桁」。a=10、b=11、c=12、d=13、e=14、f=15。${q.meta.hex} なら ${q.meta.hex[0]} × 16 + ${q.meta.hex[1]}。`,
  verify(q) { eqAccept(q, 'dec', 'number', parseInt(macByte(q), 16)); },
});
L[79] = level(79, {
  title: '16 進 ⇄ 2 進', name: 'hex-bin', src: 'calc.js Lv12', types: ['hex2bin', 'bin2hex'],
  gen: fromCalc(12, (rng) => ({ unit: 'byte', dir: rng.pick(['hex2bin', 'bin2hex']) })),
  help: '16 進 1 けたは 2 進 4 けたに当たる(0=0000、5=0101、8=1000、a=1010、f=1111)。16 進は 1 けたずつ 4 けたに、2 進は右から 4 けたずつ区切って 1 けたに置き換える。',
  verify(q) {
    if (q.legacy.type === 'hex2bin') eqAccept(q, 'bin', 'bin', parseInt(macByte(q), 16).toString(2).padStart(8, '0'));
    else eqAccept(q, 'hex', 'hex', parseInt(match(q, /2 進数 ([01]{8})\(バイト/)[1], 2).toString(16).padStart(2, '0'));
  },
});
L[82] = level(82, {
  title: '/8・/16・/24 のマスク', name: 'mask-octet', src: 'subnet.js Lv1', types: ['mask'], minDistinct: 3,
  gen: fromSubnet(1, { type: 'mask' }),
  help: '/n は先頭から n ビットが 1。1 区切りは 8 ビットなので、/8 は 1 区切り、/16 は 2 区切り、/24 は 3 区切りが 255 で、残りは 0。',
  verify(q) { prefixIn([8, 16, 24])(q, V.mask(q)); },
});
L[83] = level(83, {
  title: '/25〜/28 のマスク', name: 'mask-25-28', src: 'subnet.js Lv2', types: ['mask'], minDistinct: 4,
  gen: fromSubnet(2, { type: 'mask' }),
  help: '/24 までの 3 区切りは 255。4 区切り目は、残りのビットの数だけ左から 1 を並べる: 1 個 128、2 個 128+64、3 個 +32、4 個 +16。',
  verify(q) { prefixIn([25, 26, 27, 28])(q, V.mask(q)); },
});
L[85] = level(85, {
  title: 'ネットワークアドレス(/16・/24)', name: 'network-16-24', src: 'subnet.js Lv1', types: ['network'],
  gen: fromSubnet(1, { type: 'network' }),
  help: '/16 は先頭の 2 区切り、/24 は先頭の 3 区切りをそのまま残し、残りの区切りを 0 にする。',
  verify(q) { prefixIn([16, 24])(q, V.network(q)); },
});
L[86] = level(86, {
  title: 'ホストの数(/16・/24)', name: 'hosts-16-24', src: 'subnet.js Lv1', types: ['hosts'], minDistinct: 2,
  gen: fromSubnet(1, { type: 'hosts' }),
  help: 'ホスト部は 32 − n ビット。2^(32 − n) 個から、ネットワークアドレスとブロードキャストアドレスの 2 個を引く。',
  verify(q) { prefixIn([16, 24])(q, V.hosts(q)); },
});
L[87] = level(87, {
  title: 'ホストの数(/25〜/28)', name: 'hosts-25-28', src: 'subnet.js Lv2', types: ['hosts'], minDistinct: 4,
  gen: fromSubnet(2, { type: 'hosts' }),
  help: (q) => { const p = Number(q.text.match(/^\/(\d+)/)[1]); return `ホスト部は 32 − ${p} = ${32 - p} ビット。2^${32 - p} 個から、ネットワークアドレスとブロードキャストの 2 個を引く。`; },
  verify(q) { prefixIn([25, 26, 27, 28])(q, V.hosts(q)); },
});
const width4 = (q) => { const p = Number(q.text.match(/\/(\d+)/)[1]); return { p, w: 2 ** (32 - p) }; };
L[88] = level(88, {
  title: 'ネットワーク(/25〜/28)', name: 'network-25-28', src: 'subnet.js Lv2', types: ['network'],
  gen: fromSubnet(2, { type: 'network' }),
  help: (q) => { const { p, w } = width4(q); return `/${p} は 4 区切り目で幅 ${w}(256 ÷ ${256 / w})。4 区切り目を ${w} の倍数に切り捨てる。`; },
  verify(q) { prefixIn([25, 26, 27, 28])(q, V.network(q)); },
});
L[89] = level(89, {
  title: 'ブロードキャスト(/25〜/28)', name: 'broadcast-25-28', src: 'subnet.js Lv2', types: ['broadcast'],
  gen: fromSubnet(2, { type: 'broadcast' }),
  help: (q) => { const { p, w } = width4(q); return `/${p} は 4 区切り目で幅 ${w}。ネットワーク(${w} の倍数に切り捨て)+ ${w} − 1 がブロードキャスト。`; },
  verify(q) { prefixIn([25, 26, 27, 28])(q, V.broadcast(q)); },
});
L[90] = level(90, {
  title: '同じサブネットか', name: 'same-subnet', src: 'subnet.js Lv2', types: ['same'],
  gen: fromSubnet(2, { type: 'same' }),
  help: (q) => { const { p, w } = width4(q); return `/${p} は 4 区切り目で幅 ${w}。問題のアドレスが入る範囲(${w} の倍数から ${w} 個)を出し、その中に入る選択肢を選ぶ。`; },
  verify(q) { prefixIn([25, 26, 27, 28])(q, V.same(q)); },
});
L[91] = level(91, {
  title: '/19〜/23', name: 'network-19-23', src: 'subnet.js Lv3', types: ['network'],
  gen: fromSubnet(3, { type: 'network', prefixes: [19, 20, 21, 22, 23] }),
  help: (q) => { const p = Number(q.text.match(/\/(\d+)/)[1]); return `/${p} は 3 区切り目に境目があり、幅は 2^(24 − ${p}) = ${2 ** (24 - p)}。3 区切り目を ${2 ** (24 - p)} の倍数に切り捨て、4 区切り目は 0 にする。`; },
  verify(q) { prefixIn([19, 20, 21, 22, 23])(q, V.network(q)); },
});
L[92] = level(92, {
  title: '/29・/30', name: 'broadcast-29-30', src: 'subnet.js Lv3', types: ['broadcast'],
  gen: fromSubnet(3, { type: 'broadcast', prefixes: [29, 30] }),
  help: '/29 は幅 8、/30 は幅 4。4 区切り目を幅の倍数に切り捨てたのがネットワーク、そこから幅 − 1 進めたのがブロードキャスト。',
  verify(q) { prefixIn([29, 30])(q, V.broadcast(q)); },
});
L[93] = level(93, {
  title: '台数 → 最小のプレフィックス', name: 'hosts-to-prefix', src: 'basics.js Lv4', types: ['vlsm'], minDistinct: 20,
  gen: fromBasics(4, 0),
  help: '台数 + 2(ネットワークアドレスとブロードキャスト)以上になる最小の 2 の冪 2^h を探す。プレフィックスは 32 − h。',
  verify(q) {
    const hosts = num(match(q, /ホスト\(機器\)が ([\d,]+) 台/)[1]);
    let h = 0; while (2 ** h < hosts + 2) h++;
    choiceIs(q, `/${32 - h}`);
  },
});
L[94] = level(94, {
  title: 'ワイルドカードマスク', name: 'wildcard', src: 'basics.js Lv4', types: ['wildcard'], minDistinct: 23,
  gen: fromBasics(4, 1),
  help: 'まず /n のサブネットマスクを出す。ワイルドカードマスクは区切りごとに 255 − マスク。',
  verify(q) {
    const p = Number(match(q, /^\/(\d+) に対応する/)[1]);
    choiceIs(q, maskStr(p).split('.').map((o) => 255 - Number(o)).join('.'));
  },
});
L[102] = level(102, {
  title: 'IPv6 の省略', name: 'v6-compress', src: 'basics.js Lv5', types: ['v6compress'],
  gen: fromBasics(5, 1),
  help: 'まず各区切りの先頭の 0 を省く(0db8 → db8、0000 → 0)。次に 0 だけの区切りがいちばん長く続く所を 1 か所だけ :: にする(同じ長さなら前の方。1 つだけの 0 は :: にしない)。',
  verify(q) {
    const full = q.text.split('\n')[1];
    const g = full.split(':').map((x) => parseInt(x, 16));
    must(g.length === 8, q, '元のアドレスが 8 区切りでない');
    choiceIs(q, v6Short(g));
  },
});
L[103] = level(103, {
  title: 'IPv6 の種類', name: 'v6-kind', src: 'basics.js Lv6', types: ['v6kind'],
  gen: fromBasics(6, 0),
  help: '先頭で見分ける: 2 か 3 で始まればグローバルユニキャスト、fc・fd はユニークローカル、fe80 はリンクローカル、ff はマルチキャスト。',
  verify(q) {
    const g0 = v6Expand(match(q, /IPv6 アドレス (\S+) の種類/)[1])[0];
    const kind = g0 >= 0x2000 && g0 <= 0x3fff ? 'グローバルユニキャスト' : g0 >= 0xfc00 && g0 <= 0xfdff ? 'ユニークローカル'
      : g0 >= 0xfe80 && g0 <= 0xfebf ? 'リンクローカル' : g0 >= 0xff00 ? 'マルチキャスト' : null;
    must(kind, q, `先頭 ${g0.toString(16)} の種類が決まらない`);
    choiceIs(q, kind);
  },
});
const macOf = (q) => match(q, /MAC アドレス (\S+) について/)[1];
L[104] = level(104, {
  title: 'MAC のメーカー部分', name: 'mac-oui', src: 'calc.js Lv13', types: ['macparts'],
  gen: fromCalc(13, { asks: ['oui', 'nic'] }),
  help: 'MAC アドレスは 6 バイト(xx:xx:xx:xx:xx:xx)。前の 3 バイトがメーカーの番号(OUI)、後ろの 3 バイトが機器ごとの番号。',
  verify(q) {
    must(q.fields.map((f) => f.name).join() === 'oui,nic', q, `欄が oui・nic でない: ${q.fields.map((f) => f.name)}`);
    const b = macOf(q).split(':');
    eqAccept(q, 'oui', 'mac', b.slice(0, 3).join(':')); eqAccept(q, 'nic', 'mac', b.slice(3).join(':'));
  },
});
L[105] = level(105, {
  title: 'MAC の U/L・I/G', name: 'mac-ul-ig', src: 'calc.js Lv13', types: ['macparts'],
  gen: fromCalc(13, { asks: ['local', 'group'] }),
  help: '先頭のバイトを 2 進 8 けたにする。いちばん右(最下位)のビットが I/G(1 ならマルチキャスト)、右から 2 番目が U/L(1 ならローカル管理)。',
  verify(q) {
    must(q.fields.map((f) => f.name).join() === 'local,group', q, `欄が local・group でない: ${q.fields.map((f) => f.name)}`);
    const first = parseInt(macOf(q).split(':')[0], 16);
    eqAccept(q, 'local', 'yesno', Math.floor(first / 2) % 2 === 1 ? 'yes' : 'no');
    eqAccept(q, 'group', 'yesno', first % 2 === 1 ? 'yes' : 'no');
  },
});
L[106] = level(106, {
  title: 'MAC アドレステーブル', name: 'mac-table', src: 'basics.js Lv8', types: ['mactable'],
  gen: fromBasics(8, 0),
  help: 'MAC アドレステーブルは「その MAC アドレスからのフレームを受けたポート」の表。問題の MAC アドレスの行を探す。',
  verify(q) {
    const mac = match(q, /MAC アドレス (\S+) の機器/)[1];
    const rows = q.table.rows.filter((r) => r[0] === mac);
    must(rows.length === 1, q, 'その MAC の行が 1 つでない');
    choiceIs(q, rows[0][1]);
  },
});
L[108] = level(108, {
  title: 'ARP テーブル', name: 'arp-table', src: 'basics.js Lv8', types: ['arptable'],
  gen: fromBasics(8, 1),
  help: 'ARP テーブルは「IP アドレス → MAC アドレス」の表。同じネットワークの宛先なら、その IP アドレスの行の MAC アドレスを宛先にする。',
  verify(q) {
    const ip = match(q, /同じネットワークの (\S+) へ送る/)[1];
    const rows = q.table.rows.filter((r) => r[0] === ip);
    must(rows.length === 1, q, 'その IP の行が 1 つでない');
    choiceIs(q, rows[0][1]);
  },
});
L[111] = level(111, {
  title: '最長一致', name: 'longest-match', src: 'basics.js Lv7', types: ['route'],
  gen: fromBasics(7, 0),
  help: '宛先が含まれる行(宛先ネットワークの範囲に入る行)を全部探し、その中で /n がいちばん長い行を選ぶ。0.0.0.0/0 はどの宛先にも合う。',
  verify(q) {
    const dst = ip2n(match(q, /ルータに (\S+) 宛のパケット/)[1]);
    const hits = q.table.rows.map(([pre, hop]) => { const [a, p] = pre.split('/'); return { p: Number(p), net: ip2n(a), hop }; })
      .filter((r) => netN(dst, r.p) === r.net).sort((a, b) => b.p - a.p);
    must(hits.length && (hits.length === 1 || hits[0].p > hits[1].p), q, '最長一致が 1 つに決まらない');
    choiceIs(q, hits[0].hop);
  },
});
const TCPUDP_HAS = { 'TCP にはあって UDP にはない': (a) => a.tcp && !a.udp, 'UDP にはあって TCP にはない': (a) => a.udp && !a.tcp, 'TCP と UDP の両方にある': (a) => a.tcp && a.udp };
L[113] = level(113, {
  title: 'TCP と UDP', kind: '表', name: 'tcp-udp', src: 'transport.js Lv51', types: ['tcpudp'], minDistinct: transport.FACTS.tcpUdp.length,
  gen: fromTransport(51, 0),
  help: 'TCP は通信の前に接続を作り、届いたかの確認・送り直し・順番そろえをする。UDP はそれらをせず軽い。ポート番号とチェックサムは両方にある。',
  verify(q) {
    const label = match(q, /次のうち、(.+)性質はどれ/)[1];
    const has = TCPUDP_HAS[label]; must(has, q, `問いの種類 ${label} が分からない`);
    const attrsOf = (o) => { const r = transport.FACTS.tcpUdp.find((x) => x.ja === o); return r ? r.attrs : null; };
    must(attrsOf(ans(q)) && has(attrsOf(ans(q))), q, '正解がその性質を持たない');
    q.options.forEach((o, i) => { if (i !== q.answerIndex) must(!attrsOf(o) || !has(attrsOf(o)), q, `誤答 ${o} も当てはまる`); });
  },
});
L[114] = level(114, {
  title: 'サービス → ポート番号', kind: '表', name: 'port-of-service', src: 'transport.js Lv52', types: ['portof'], minDistinct: transport.FACTS.ports.length,
  gen: fromTransport(52, 0),
  help: 'よく出る既定のポート番号を手がかりにする: HTTP 80、HTTPS 443、DNS 53、SSH 22。ほかのサービスも、何に使うプロトコルかから思い出す。',
  verify(q) {
    const rows = transport.FACTS.ports.filter((r) => q.text.startsWith(`${r.attrs.service} は${r.ja}に使うプロトコル。${r.attrs.ask ? `${r.attrs.ask}ポートとして` : ''}既定で使う ${r.attrs.transport.toUpperCase()} ポート番号`));
    must(rows.length === 1, q, `表の行が 1 つに決まらない(${rows.length})`);
    eqAccept(q, 'port', 'number', rows[0].attrs.port);
  },
});
L[115] = level(115, {
  title: 'ポート番号 → サービス', kind: '表', name: 'service-of-port', src: 'transport.js Lv53', types: ['serviceof'], minDistinct: transport.FACTS.ports.length,
  gen: fromTransport(53, 0),
  help: 'サービス → ポート番号の表を逆に引く(HTTP 80、HTTPS 443、DNS 53、SSH 22 など)。TCP か UDP かも手がかりになる。',
  verify(q) {
    const m = match(q, /^(TCP|UDP) ポート (\d+) を既定で使うサービス/);
    const labels = new Set(transport.FACTS.ports.filter((r) => r.attrs.port === Number(m[2]) && r.attrs.transport === m[1].toLowerCase()).map((r) => r.attrs.label));
    must(labels.size >= 1, q, 'そのポートの行が無い');
    choiceIs(q, ans(q), (o) => labels.has(o));
    must(labels.has(ans(q)), q, '正解がそのポートのサービスでない');
  },
});
L[116] = level(116, {
  title: 'ポート番号の 3 区分', name: 'port-range', src: 'transport.js Lv53', types: ['portrange'],
  gen: fromTransport(53, 1),
  help: '0〜1023 はウェルノウン、1024〜49151 は登録済み、49152〜65535 は動的・プライベート(エフェメラル)。境目の 1023・1024・49151・49152 に気をつける。',
  verify(q) {
    const n = Number(match(q, /ポート番号 (\d+) は/)[1]);
    const L3 = transport.internals.RANGE_LABELS;
    choiceIs(q, n <= 1023 ? L3.well : n <= 49151 ? L3.reg : L3.dyn);
  },
});
L[124] = level(124, {
  title: 'NAPT の変換表', name: 'napt-table', src: 'basics.js Lv10', types: ['nat'],
  gen: fromBasics(10, 0),
  help: '外から戻ってきたパケットは「内側グローバル」の列で表を引き、同じ行の「内側ローカル」へ届ける。外へ出るときは逆に「内側ローカル」の列で引いて「内側グローバル」に書き換える。',
  verify(q) {
    const back = q.text.match(/から (\S+) 宛に戻ってきた/);
    const [col, out] = back ? [1, 0] : [0, 1];
    const key = back ? back[1] : match(q, /内部の (\S+) から/)[1];
    const rows = q.table.rows.filter((r) => r[col] === key);
    must(rows.length === 1, q, '変換表の行が 1 つに決まらない');
    choiceIs(q, rows[0][out]);
  },
});
L[129] = level(129, {
  title: 'ACL を 1〜2 行読む', name: 'acl-read', src: 'basics.js Lv9', types: ['acl'],
  gen: fromBasics(9, 0),
  help: 'ACL は上から順に見て、プロトコル・送信元・宛先・ポートがすべて合った最初の行で決まる。どの行にも合わなければ末尾の暗黙の拒否。',
  verify(q) { choiceIs(q, aclResult(q)); },
});

// ===== 中級 =====
L[159] = level(159, {
  title: 'ネットワークとブロードキャスト', name: 'net-bcast', src: 'calc.js Lv14', types: ['netbcast'],
  gen: fromCalc(14),
  help: 'まず /n の境目がどの区切り(オクテット)にあるかと、その区切りでの幅 2^(8 − n を 8 で割った余り) を出す。',
  verify(q) {
    const m = match(q, /^(\S+)\/(\d+) のネットワークアドレスとブロードキャスト/); const ip = ip2n(m[1]), p = Number(m[2]);
    eqAccept(q, 'network', 'ipv4', n2ip(netN(ip, p))); eqAccept(q, 'broadcast', 'ipv4', n2ip(bcN(ip, p)));
  },
});
L[160] = level(160, {
  title: '使える範囲の両端', name: 'usable-range', src: 'calc.js Lv15', types: ['usable'],
  gen: fromCalc(15),
  help: 'まずネットワークアドレス(境目の区切りを幅の倍数に切り捨て)とブロードキャストアドレスを出す。',
  verify(q) {
    const m = match(q, /^(\S+)\/(\d+) のサブネットで/); const ip = ip2n(m[1]), p = Number(m[2]);
    eqAccept(q, 'first', 'ipv4', n2ip(netN(ip, p) + 1)); eqAccept(q, 'last', 'ipv4', n2ip(bcN(ip, p) - 1));
  },
});
const splitOf = (q) => { const m = match(q, /^(\S+)\/(\d+) を \/(\d+) のサブネットに等分/); return { parent: ip2n(m[1]), p1: Number(m[2]), p2: Number(m[3]) }; };
L[161] = level(161, {
  title: '何番目のサブネットか', name: 'subnet-index', src: 'calc.js Lv16', types: ['subnetindex'],
  gen: fromCalc(16),
  help: 'まず区画 1 つの大きさ 2^(32 − 新しいプレフィックス長) を出す。',
  verify(q) {
    const { parent, p2 } = splitOf(q); const ip = ip2n(match(q, /(\d+\.\d+\.\d+\.\d+) は何番目/)[1]);
    const k = Math.floor((ip - parent) / blk(p2));
    eqAccept(q, 'index', 'number', k + 1); eqAccept(q, 'cidr', 'ipv4cidr', cidr(parent + k * blk(p2), p2));
  },
});
L[162] = level(162, {
  title: 'N 番目のサブネット', name: 'nth-subnet', src: 'calc.js Lv17', types: ['nthsubnet'],
  gen: fromCalc(17),
  help: 'まず分割数 2^(新しいプレフィックス長 − 親のプレフィックス長) を出す。',
  verify(q) {
    const { parent, p1, p2 } = splitOf(q); const n = num(match(q, /1 番目として ([\d,]+) 番目/)[1]);
    eqAccept(q, 'count', 'number', 2 ** (p2 - p1)); eqAccept(q, 'cidr', 'ipv4cidr', cidr(parent + (n - 1) * blk(p2), p2));
  },
});
L[163] = level(163, {
  title: 'N 番目の 4 つの値', name: 'nth-subnet-range', src: 'calc.js Lv18', types: ['nthrange'],
  gen: fromCalc(18),
  help: 'まず N 番目の先頭 = 親の先頭 + (N − 1) × 区画の大きさ を出す。',
  verify(q) {
    const { parent, p2 } = splitOf(q); const n = num(match(q, /1 番目とする。 ?([\d,]+) 番目/)[1]);
    const net = parent + (n - 1) * blk(p2), bc = net + blk(p2) - 1;
    eqAccept(q, 'network', 'ipv4', n2ip(net)); eqAccept(q, 'broadcast', 'ipv4', n2ip(bc));
    eqAccept(q, 'first', 'ipv4', n2ip(net + 1)); eqAccept(q, 'last', 'ipv4', n2ip(bc - 1));
  },
});
L[164] = level(164, {
  title: '2 進の表記から', name: 'from-binary', src: 'calc.js Lv20', types: ['frombinary'],
  gen: fromCalc(20),
  help: 'まずマスクの 1 の数を数えてプレフィックス長を出す。',
  verify(q) {
    const m = match(q, /アドレス: ([01.]+)\nマスク: ([01.]+)/);
    const ip = parseInt(m[1].replace(/\./g, ''), 2), mask = m[2].replace(/\./g, '');
    const p = mask.indexOf('0') < 0 ? 32 : mask.indexOf('0');
    must(!mask.slice(p).includes('1'), q, 'マスクの 1 が続いていない');
    eqAccept(q, 'prefixlen', 'prefixlen', p); eqAccept(q, 'cidr', 'ipv4cidr', cidr(netN(ip, p), p)); eqAccept(q, 'hostno', 'number', ip - netN(ip, p));
  },
});
L[165] = level(165, {
  title: '集約', name: 'summarize', src: 'basics.js Lv5', types: ['summary'],
  gen: fromBasics(5, 0),
  help: 'まずまとめる個数が 2 の何乗かを見る(2 個なら 1 ビット、4 個なら 2 ビット、プレフィックスが短くなる)。',
  verify(q) {
    const nets = q.text.split('\n').slice(1).map((s) => { const [a, p] = s.split('/'); return { net: ip2n(a), p: Number(p) }; });
    let p = Math.min(...nets.map((x) => x.p));
    while (p > 0 && !nets.every((x) => netN(x.net, p) === netN(nets[0].net, p))) p--;
    choiceIs(q, cidr(netN(nets[0].net, p), p));
  },
});
L[167] = level(167, {
  title: 'IPv6 の /48・/64', name: 'v6-prefix', src: 'basics.js Lv6', types: ['v6prefix'],
  gen: fromBasics(6, 1),
  help: 'まず残す区切りの数(プレフィックス長 ÷ 16)を出す。/48 なら 3 区切り、/64 なら 4 区切り。',
  verify(q) {
    const m = match(q, /IPv6 アドレス (\S+) が属する \/(\d+) のプレフィックスは/); const p = Number(m[2]);
    choiceIs(q, `${v6Short(v6Cut(v6Expand(m[1]), p))}/${p}`);
  },
});
L[168] = level(168, {
  title: 'IPv6 の半端なプレフィックス', name: 'v6-prefix-nibble', src: 'calc.js Lv19', types: ['v6prefix'],
  gen: fromCalc(19, { mode: 'prefix' }),
  help: 'まずプレフィックス長を 16 × k + 余り に分ける(/56 = 48 + 8)。k + 1 番目の区切りは、先頭から 余り ÷ 4 けた(16 進)だけ残す。',
  verify(q) {
    const m = match(q, /IPv6 アドレス (\S+) が属する \/(\d+) のプレフィックスを/); const p = Number(m[2]);
    eqAccept(q, 'prefix', 'ipv6cidr', `${v6Short(v6Cut(v6Expand(m[1]), p))}/${p}`);
  },
});
L[169] = level(169, {
  title: 'N 番目の /64', name: 'v6-nth-64', src: 'calc.js Lv19', types: ['v6nth'],
  gen: fromCalc(19, { mode: 'nth' }),
  help: 'まず N − 1 を 16 進にする(0 始まりで数えるので 1 番目は 0)。',
  verify(q) {
    const m = match(q, /^(\S+)\/(\d+) を \/64 に等分/); const n = Number(match(q, /1 番目として (\d+) 番目の \/64/)[1]);
    const g = v6Expand(m[1]); g[3] += n - 1;
    must(g[3] <= 0xffff, q, '4 番目の区切りがあふれる');
    eqAccept(q, 'prefix', 'ipv6cidr', `${v6Short(g)}/64`);
  },
});
// VLSM(meta は前の生成器の要件。区画の表と同じもの)
const vm = (q) => { must(q.meta && q.meta.parent, q, 'meta.parent が無い'); return q.meta; };
L[170] = level(170, {
  title: 'VLSM: 3 区画の長さ', name: 'vlsm-prefix', src: 'vlsm.js Lv21', types: ['vlsm-prefix'],
  gen: fromVlsm(21),
  help: 'まず各区画の台数に 2(ネットワークアドレスとブロードキャスト)を足す。',
  verify(q) { setAccept(q, 'prefixlen', vm(q).regions.map((r) => 32 - bitsFor(r.hosts))); },
});
const placedCidrs = (q, regions) => placeDesc(vm(q).parent.net, regions).rs.map((r) => cidr(r.net, r.p));
L[171] = level(171, {
  title: 'VLSM: 3 区画の CIDR', name: 'vlsm-cidr3', src: 'vlsm.js Lv22', types: ['vlsm-cidr3'],
  gen: fromVlsm(22),
  help: 'まずブロックの大きい順に並べる。',
  verify(q) { setAccept(q, 'ipv4cidr', placedCidrs(q, vm(q).regions)); },
});
L[172] = level(172, {
  title: 'VLSM: 同じ大きさを含む 4 区画', name: 'vlsm-cidr4', src: 'vlsm.js Lv23', types: ['vlsm-cidr4'],
  gen: fromVlsm(23),
  help: 'まずブロックの大きい順に並べる(同じ大きさの区画は、どちらを先に置いてもよい)。',
  verify(q) { must(vm(q).regions.length === 4, q, '区画が 4 つでない'); setAccept(q, 'ipv4cidr', placedCidrs(q, vm(q).regions)); },
});
L[173] = level(173, {
  title: 'VLSM: 範囲と残り', name: 'vlsm-range', src: 'vlsm.js Lv24', types: ['vlsm-range'],
  gen: fromVlsm(24),
  help: 'まず全区画を大きい順に親の先頭から隙間なく置く。',
  verify(q) {
    const { parent, regions, k } = vm(q); const { rs, end } = placeDesc(parent.net, regions); const r = rs[k - 1];
    eqAccept(q, 'first', 'ipv4', n2ip(r.net + 1)); eqAccept(q, 'last', 'ipv4', n2ip(r.net + r.size - 2));
    eqAccept(q, 'unused', 'number', parent.net + 2 ** (32 - parent.p) - end);
  },
});
// [start, end) を少ない個数の CIDR に: 先頭から、整列していて入りきる最大のブロックを順に取る
function freeBlocks(start, end) {
  const out = []; let cur = start;
  while (cur < end) {
    let b = 32; while (b > 0 && !(cur % 2 ** b === 0 && cur + 2 ** b <= end)) b--;
    out.push(cidr(cur, 32 - b)); cur += 2 ** b;
  }
  return out;
}
L[174] = level(174, {
  title: 'VLSM: 残りを CIDR で', name: 'vlsm-free', src: 'vlsm.js Lv25', types: ['vlsm-free'],
  gen: fromVlsm(25),
  help: 'まず全区画を大きい順に置き、使い終わりの次のアドレスを出す。',
  verify(q) { const { parent, regions } = vm(q); setAccept(q, 'ipv4cidr', freeBlocks(placeDesc(parent.net, regions).end, parent.net + 2 ** (32 - parent.p))); },
});
L[175] = level(175, {
  title: 'VLSM: 足りるか', name: 'vlsm-fit', src: 'vlsm.js Lv26', types: ['vlsm-fit'],
  gen: fromVlsm(26),
  help: 'まず各区画のブロック(台数 + 2 以上の最小の 2 の冪)を合計する。',
  verify(q) {
    const { parent, regions } = vm(q); const total = regions.reduce((s, r) => s + 2 ** bitsFor(r.hosts), 0); const size = 2 ** (32 - parent.p);
    let b = 0; while (2 ** b < total) b++;
    eqAccept(q, 'fits', 'yesno', total <= size ? 'yes' : 'no'); eqAccept(q, 'shortage', 'number', Math.max(0, total - size)); eqAccept(q, 'minParent', 'prefixlen', 32 - b);
  },
});
L[176] = level(176, {
  title: 'VLSM: 書かれた順の無駄', name: 'vlsm-inorder', src: 'vlsm.js Lv27', types: ['vlsm-inorder'],
  gen: fromVlsm(27),
  help: 'まず 1 つ目を親の先頭に置く。2 つ目からは、前の区画の次のアドレス以降で、自分のブロックの大きさの倍数になる最初の位置を探す。',
  verify(q) {
    const { parent, regions } = vm(q); let cur = parent.net, skipped = 0;
    regions.forEach((r, i) => {
      const size = 2 ** bitsFor(r.hosts); let net = cur; while (net % size) net++;
      skipped += net - cur; cur = net + size;
      eqAccept(q, `c${i + 1}`, 'ipv4cidr', cidr(net, 32 - bitsFor(r.hosts)));
    });
    eqAccept(q, 'skipped', 'number', skipped);
  },
});
L[177] = level(177, {
  title: 'VLSM: まとめ直しと巻き込み', name: 'vlsm-summary', src: 'vlsm.js Lv28', types: ['vlsm-summary'],
  gen: fromVlsm(28),
  help: 'まず 2 つのネットワークアドレスを 2 進にして、先頭から同じ部分が何ビット続くかを数える。',
  verify(q) {
    const { parent, regions, pair } = vm(q); const { rs } = placeDesc(parent.net, regions);
    const a = rs.find((r) => r.i === pair[0]), b = rs.find((r) => r.i === pair[1]);
    let p = Math.min(a.p, b.p); while (p > 0 && netN(a.net, p) !== netN(b.net, p)) p--;
    const s = netN(a.net, p), e = s + blk(p);
    const engulfed = rs.filter((r) => r !== a && r !== b && r.net >= s && r.net + r.size <= e).length;
    eqAccept(q, 'summary', 'ipv4cidr', cidr(s, p)); eqAccept(q, 'engulfed', 'number', engulfed);
  },
});
L[178] = level(178, {
  title: 'VLSM: 今の割り当てに足す', name: 'vlsm-add', src: 'vlsm.js Lv29', types: ['vlsm-add'],
  gen: fromVlsm(29),
  help: 'まず新しい区画のブロックの大きさを出し、その倍数の位置を親の先頭から順に並べて、既存の区画と重ならない最初の位置を探す。',
  verify(q) {
    const { parent, existing, requests } = vm(q); const end = parent.net + 2 ** (32 - parent.p);
    const used = existing.map((e) => ({ s: e.net, e: e.net + blk(e.p) }));
    requests.forEach((r, i) => {
      const size = 2 ** bitsFor(r.hosts); let pos = parent.net; while (pos % size) pos++;
      while (pos + size <= end && used.some((u) => pos < u.e && u.s < pos + size)) pos += size;
      must(pos + size <= end, q, `${r.name} が置けない`);
      used.push({ s: pos, e: pos + size });
      eqAccept(q, `new${i + 1}`, 'ipv4cidr', cidr(pos, 32 - bitsFor(r.hosts)));
    });
  },
});
L[179] = level(179, {
  title: 'VLSM: 総合(LAN とリンク)', name: 'vlsm-total-plan', src: 'vlsm.js Lv30', types: ['vlsm-total-plan'],
  gen: fromVlsm(30, { form: 'plan' }),
  help: 'まずリンクはルータ 2 台なので /30(4 アドレス)。LAN はそれぞれ台数 + 2 以上の最小の 2 の冪。',
  verify(q) {
    const { regions, links, form } = vm(q);
    must(form === 'plan', q, `form が plan でない: ${form}`);
    setAccept(q, 'ipv4cidr', placedCidrs(q, [...regions, ...Array.from({ length: links }, () => ({ hosts: 2 }))]));
  },
});
L[203] = level(203, {
  title: '3 ウェイハンドシェイク', kind: '表', name: 'handshake', src: 'transport.js Lv54', types: ['handshake'], minDistinct: 9,
  gen: fromTransport(54, 0),
  help: 'まず 3 回のやりとりを順に思い出す。1 段目はクライアントからの接続の要求(SYN)。2 段目と 3 段目は、それに答える側と、その答えを確かめる側。',
  verify(q) {
    let m;
    if ((m = q.text.match(/ハンドシェイクの (\d) 段目で送られるセグメントに立っているフラグは/))) choiceIs(q, HS[m[1]].flags);
    else if ((m = q.text.match(/ハンドシェイクの (\d) 段目\(.+\)では、だれが/))) choiceIs(q, `${HS[m[1]].sender}が ${HS[m[1]].flags} を送る`);
    else {
      m = match(q, /、(クライアント|サーバー)が (\S+) を送るのは何段目/);
      const step = Object.keys(HS).filter((k) => HS[k].sender === m[1] && HS[k].flags === m[2]);
      must(step.length === 1, q, '段が 1 つに決まらない');
      choiceIs(q, `${step[0]} 段目`);
    }
  },
});
L[204] = level(204, {
  title: '送信元のポート', kind: '表', name: 'ephemeral', src: 'transport.js Lv54', types: ['ephemeral'], minDistinct: 300,
  gen: fromTransport(54, 1),
  help: 'まず IANA の動的・プライベートの範囲(49152〜65535)を思い出す。クライアントの送信元ポートはこの中から選ばれる。',
  verify(q) { const eph = (o) => /^\d+$/.test(o) && Number(o) >= 49152 && Number(o) <= 65535; choiceIs(q, ans(q), eph); must(eph(ans(q)), q, '正解が範囲外'); },
});
const HS_ASK = {
  'サーバーが返す SYN/ACK セグメントの SEQ 番号': (a, b) => b, 'サーバーが返す SYN/ACK セグメントの ACK 番号': (a) => a + 1,
  'クライアントが 3 段目に送る ACK セグメントの SEQ 番号': (a) => a + 1, 'クライアントが 3 段目に送る ACK セグメントの ACK 番号': (a, b) => b + 1,
};
L[205] = level(205, {
  title: 'ハンドシェイクの番号', name: 'handshake-seq', src: 'transport.js Lv55', types: ['hsseq'],
  gen: fromTransport(55, 0),
  help: 'まず SYN は番号を 1 つ使うことを思い出す(確認応答番号 = 相手の初期シーケンス番号 + 1)。',
  verify(q) {
    const m = match(q, /\(ISN\)が ([\d,]+)、サーバーの初期シーケンス番号が ([\d,]+) のとき、(.+?)は？/);
    const f = HS_ASK[m[3]]; must(f, q, `問い ${m[3]} が分からない`);
    eqAccept(q, 'value', 'number', f(num(m[1]), num(m[2])));
  },
});
L[206] = level(206, {
  title: 'データ転送の番号', name: 'data-ack', src: 'transport.js Lv56', types: ['dataack'],
  gen: fromTransport(56, 0),
  help: 'まず SEQ 番号の始まりに、送った(受け取った)セグメントのバイト数を順に足す。',
  verify(q) {
    const s = num(match(q, /SEQ 番号は ([\d,]+) から始まる/)[1]);
    const head = q.text.split('。')[1];
    const lens = [...head.matchAll(/([\d,]+) バイト/g)].map((x) => num(x[1]));
    let k = lens.length;
    const upTo = q.text.match(/受信側が (\d+) 本目までを受け取った/);
    if (upTo) k = Number(upTo[1]);
    eqAccept(q, 'value', 'number', s + lens.slice(0, k).reduce((a, b) => a + b, 0));
  },
});
L[207] = level(207, {
  title: '5 つの組で数える', name: 'five-tuple', src: 'transport.js Lv57', types: ['fivetuple'],
  gen: fromTransport(57, 0),
  help: 'まずプロトコル・送信元 IP・送信元ポート・宛先 IP・宛先ポートの 5 つが全部同じパケットをまとめる。復路は送信元と宛先を入れ替えて同じ組か見る。',
  verify(q) {
    const keys = new Set(q.table.rows.map(([, proto, src, dst]) => `${proto}|${[src, dst].sort().join('|')}`));
    eqAccept(q, 'count', 'number', keys.size);
  },
});
// NAPT に 1 本足す(208・209)
function naptOne(q) {
  const g = match(q, /内側グローバルのアドレスは (\S+?)\)/)[1];
  const m = match(q, /内部の (\S+):(\d+) から (\S+) へ (TCP|UDP) の新しい接続/);
  const rows = q.table.rows; must(rows.every((r) => r[2].startsWith(`${g}:`)), q, '内側グローバルのアドレスが違う行がある');
  return { g, port: Number(m[2]), used: usedOf(rows, m[4], 2) };
}
L[208] = level(208, {
  title: 'NAPT に 1 行足す', name: 'napt-add', src: 'transport.js Lv58', types: ['naptadd'],
  gen: fromTransport(58, 0),
  help: 'まず内側ローカルのポート番号が、同じプロトコルの「内側グローバル」の列で使われているかを見る(内側ローカルの列ではない)。',
  verify(q) { const { g, port, used } = naptOne(q); must(!used.has(port), q, '衝突が無いはずなのに使用中'); eqAccept(q, 'global', 'addrport', `${g}:${port}`); },
});
L[209] = level(209, {
  title: 'NAPT のポートの付け替え', name: 'napt-collide', src: 'transport.js Lv59', types: ['naptcollide'],
  gen: fromTransport(59, 0),
  help: 'まず内側ローカルのポート番号が内側グローバルの列で使用中かを見る。使用中なら 1 ずつ上げて、最初の空きを探す。',
  verify(q) { const { g, port, used } = naptOne(q); must(used.has(port), q, '衝突するはずなのに空き'); eqAccept(q, 'global', 'addrport', `${g}:${freePort(used, port)}`); },
});
L[210] = level(210, {
  title: 'NAPT に 2〜3 本を順に', name: 'napt-multi', src: 'transport.js Lv60', types: ['naptmulti'],
  // test/cl.js は問題文・選択肢・q.table で違いを数えるが、この型は表を q.tables(2 つ)に持つので、問題文(内側グローバルのアドレスと本数)だけで数える
  minDistinct: 300,
  gen: fromTransport(60, 0),
  help: 'まず 1 本目を表に足し、その行も使用中に数えてから 2 本目へ進む。TCP と UDP のポートは別々に数える。',
  verify(q) {
    const g = match(q, /内側グローバルのアドレスは (\S+?)\)/)[1];
    const [table, flows] = q.tables;
    const used = { TCP: usedOf(table.rows, 'TCP', 2), UDP: usedOf(table.rows, 'UDP', 2) };
    let last = null;
    for (const [, proto, local] of flows.rows) { last = freePort(used[proto], Number(local.split(':')[1])); used[proto].add(last); }
    eqAccept(q, 'global', 'addrport', `${g}:${last}`);
  },
});

module.exports = { LEVELS: L };
