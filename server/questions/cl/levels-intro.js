'use strict';
// 入門(新しい番号 1〜67。docs/LEVEL-LIST.md 第 2 章)の問題。担当: 入門。書き方は docs/questions/CL.md
// 入門の決まり: 1 問 10 秒前後。○×・3 択・4 択(一覧の「答え方」に従う)。問題の前に見せる説明カード card(読めば解ける程度)と解説 explanation を必ず付ける
// 作らない行: 16・17(「今の問題」列が calc.js Lv11。前の生成器の口の担当が作る)、67(模擬ターミナル。仕組みがまだ無い)
// 表は server/questions/data/cl/intro/。○× の表は attrs.true・attrs.why、n 択の表は attrs.answer・attrs.wrong(誤答の候補)・attrs.why
const { loadFacts, trueFalse, choices } = require('./build');
const { normalize } = require('../normalize');

// ---------- 入門の共通の道具 ----------
const facts = (file) => loadFacts(`intro/${file}`);
const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); // 1000 → 1,000
const fail = (q, msg) => { throw new Error(`${q.kind}: ${msg}\n${q.text}`); };

// ○× の表から作るレベル。1 行 = 1 問(文の数がそのまま問題の数)
function tfLevel(file, { title, card, kind }) {
  const rows = facts(file);
  return {
    title, kind: '表', minDistinct: 30, rows, form: 'tf',
    make(rng) {
      const row = rng.pick(rows);
      const tf = trueFalse(row.ja, row.attrs.true);
      const ja = row.ja.replace(/「/g, '『').replace(/」/g, '』'); // かぎかっこの中のかぎかっこは二重かぎに
      return {
        text: `次の文は正しいですか。\n「${ja}」`, options: tf.options, answerIndex: tf.answerIndex, card,
        explanation: `${row.attrs.true ? '正しい' : '誤り'}。${row.attrs.why}`, kind, meta: { row: row.id },
      };
    },
  };
}

// n 択の表から作るレベル。1 行 = 問いの文と正解。誤答は行の attrs.wrong から n - 1 個選ぶ
function mcLevel(file, { title, n, card, kind }) {
  const rows = facts(file);
  return {
    title, kind: '表', minDistinct: 30, rows, form: 'mc', n,
    make(rng) {
      const row = rng.pick(rows);
      const c = choices(rng, row.attrs.answer, row.attrs.wrong, n);
      return { text: row.ja, ...c, card, explanation: `正解は「${row.attrs.answer}」。${row.attrs.why}`, kind, meta: { row: row.id } };
    },
  };
}

// 入力欄(docs/questions/COMMON.md 第 1 章)。accept は正規形にしておく
const FIELD_HINT = { number: '半角の数字', hex: '16 進 1 けた(0〜9、a〜f)', devname: '番号を 3 つ、- で区切って' };
function field(name, label, format, raw, extra = {}) {
  const f = { name, label, format, hint: format === 'bin' ? `0 と 1 を ${extra.digits} けた` : FIELD_HINT[format], ...(extra.digits ? { digits: extra.digits } : {}) };
  const accept = normalize(format, String(raw), f);
  if (accept === null) throw new Error(`正解が正規化できません: ${format} ${raw}`);
  return { ...f, accept: [accept] };
}
const textQ = (text, fields, card, explanation, kind, meta) => ({ answerKind: 'text', text, fields, card, explanation, kind, meta });

// 確かめに使う道具(作る側とは別の書き方で解き直す)
const binToDec = (s) => [...s].reduce((acc, ch) => acc * 2 + (ch === '1' ? 1 : 0), 0);
const decToBin = (v, digits) => { let s = ''; for (let i = 0; i < digits; i++) { s = (v % 2) + s; v = Math.floor(v / 2); } return s; };
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const chosen = (q) => q.options[q.answerIndex];

// ---------- 生成に使う値 ----------
const MASKS = [128, 192, 224, 240, 248, 252, 254, 255]; // 左から 1 が 1〜8 個並ぶ 8 けた
const HEX = '0123456789ABCDEF';
const SPEED = ['bps', 'kbps', 'Mbps', 'Gbps']; // 1,000 倍ずつ
const SIZE = ['バイト', 'KB', 'MB', 'GB', 'TB']; // ここでは 1,000 倍ずつ
const BITS_OF = [['バイト', 'ビット'], ['KB', 'kbit'], ['MB', 'Mbit'], ['GB', 'Gbit']];
// 単位のあとに日本語が続くとき、英字の単位だけ間をあける(「16 MB は」「16 バイトは」「何 MB」「何バイト」)
const latin = (u) => /^[A-Za-z]/.test(u);
const unitJa = (u) => (latin(u) ? `${u} ` : u);
const nani = (u) => (latin(u) ? `何 ${u}` : `何${u}`);
// 文書用・プライベートの範囲の IPv4(docs/questions/COMMON.md 第 7 章)
function v4Parts(rng) {
  switch (rng.rand(0, 5)) {
    case 0: return [192, 0, 2, rng.rand(1, 254)];
    case 1: return [198, 51, 100, rng.rand(1, 254)];
    case 2: return [203, 0, 113, rng.rand(1, 254)];
    case 3: return [10, rng.rand(0, 255), rng.rand(0, 255), rng.rand(1, 254)];
    case 4: return [172, rng.rand(16, 31), rng.rand(0, 255), rng.rand(1, 254)];
    default: return [192, 168, rng.rand(0, 255), rng.rand(1, 254)];
  }
}
// IPv4 として正しくない形(どれも文書用・プライベートのアドレスをもとに崩す)
const V4_BAD = {
  over: (rng) => { const p = v4Parts(rng); const i = rng.rand(0, 3); p[i] = rng.rand(256, 299); return { s: p.join('.'), why: `${p.join('.')} は ${p[i]} が 255 より大きい` }; },
  three: (rng) => { const s = v4Parts(rng).slice(0, 3).join('.'); return { s, why: `${s} は数が 3 つしかない` }; },
  five: (rng) => { const s = [...v4Parts(rng), rng.rand(0, 255)].join('.'); return { s, why: `${s} は数が 5 つある` }; },
  empty: (rng) => { const p = v4Parts(rng); const s = `${p.slice(0, 3).join('.')}..${p[3]}`; return { s, why: `${s} は点が 2 つ続き、空の区切りがある` }; },
};
const hex2 = (rng) => rng.rand(0, 255).toString(16).padStart(2, '0');
// ローカル管理の MAC(2 けた目が 2・6・a・e)。docs/questions/COMMON.md 第 7 章
const macParts = (rng) => [((rng.rand(0, 63) << 2) | 2).toString(16).padStart(2, '0'), ...Array.from({ length: 5 }, () => hex2(rng))];
const MAC_BAD = {
  v4: (rng) => { const s = v4Parts(rng).join('.'); return { s, why: `${s} は IPv4 アドレス` }; },
  v6: (rng) => { const s = `2001:db8::${rng.rand(1, 0xffff).toString(16)}`; return { s, why: `${s} は IPv6 アドレス` }; },
  short: (rng) => { const s = macParts(rng).slice(0, rng.pick([3, 5])).join(':'); return { s, why: `${s} は組が ${s.split(':').length} つしかない` }; },
  long: (rng) => { const s = [...macParts(rng), hex2(rng)].join(':'); return { s, why: `${s} は組が 7 つある` }; },
  badchar: (rng) => { const p = macParts(rng); const i = rng.rand(1, 5); const c = rng.pick('ghkmnprstuwxz'.split('')); p[i] = p[i][0] + c; const s = p.join(':'); return { s, why: `${s} は 16 進で使わない文字「${c}」がある` }; },
  wide: (rng) => { const p = macParts(rng); const i = rng.rand(1, 5); p[i] += rng.rand(0, 15).toString(16); const s = p.join(':'); return { s, why: `${s} は 3 けたの組がある` }; },
};
// 誤答の候補(種類ごとに 1 つ)から、正解と重ならない k 個を選ぶ
function pickBad(rng, table, k, avoid) {
  const out = [];
  for (const name of rng.shuffle(Object.keys(table))) {
    if (out.length >= k) break;
    const b = table[name](rng);
    if (b.s !== avoid && !out.some((o) => o.s === b.s)) out.push(b);
  }
  return out;
}
function distinctList(rng, gen, k, avoid) {
  const out = [];
  for (let guard = 0; out.length < k && guard < 100; guard++) { const s = gen(rng); if (s !== avoid && !out.includes(s)) out.push(s); }
  return out;
}

const LEVELS = {
  // Lv1 ネットワークとは(○×)。見本として土台を作ったときに書き(2026-10-22)、文を 30 以上に足した
  1: tfLevel('network-what.json', {
    title: 'ネットワークとは', kind: 'cl1-network-what-v1',
    card: 'ネットワークは、2 台以上の機器をつないで、データをやりとりできるようにしたしくみ。ケーブルでも無線でもよく、インターネットにつながっていなくてもよい。',
  }),
  2: mcLevel('devices-connect.json', {
    title: 'つながる機器', n: 3, kind: 'cl2-devices-connect-v1',
    card: 'PC・スマホ・タブレット・プリンターなどは、ネットワークにつないでデータをやりとりできる。電卓や辞書のように、データを送り受けするしくみの無い道具はつながらない。',
  }),
  3: tfLevel('lan.json', {
    title: 'LAN とは', kind: 'cl3-lan-v1',
    card: 'LAN(Local Area Network)は、家・学校・会社の建物の中など、狭い範囲のネットワーク。ケーブルでも無線(無線 LAN)でもよい。離れた場所どうしをつなぐのは WAN。',
  }),
  4: mcLevel('wan.json', {
    title: 'WAN とは', n: 3, kind: 'cl4-wan-v1',
    card: 'WAN(Wide Area Network)は、東京と大阪のように離れた場所どうしをつなぐ広い範囲のネットワーク。ふつう通信会社の回線を使う。建物の中など狭い範囲は LAN。',
  }),
  5: mcLevel('internet.json', {
    title: 'インターネットとは', n: 4, kind: 'cl5-internet-v1',
    card: 'インターネットは、世界中のたくさんのネットワークをつなぎ合わせた「ネットワークのネットワーク」。だれか 1 社のものではなく、多くの組織のネットワークが決まりに沿ってつながっている。',
  }),
  6: tfLevel('intranet.json', {
    title: '社内のネットワーク', kind: 'cl6-intranet-v1',
    card: '会社の中のネットワーク(社内網)は、その会社の人や機器だけが使う。外の人が勝手に入れないよう、ID・パスワードやファイアウォールで守る。インターネットとは出入口でつながる。',
  }),
  7: mcLevel('server.json', {
    title: 'サーバーの役割', n: 3, kind: 'cl7-server-v1',
    card: 'サーバーは、頼まれた仕事をして結果を返す側の機器やソフト。たとえば Web サーバーはページを送り返す。頼む側はクライアントという。',
  }),
  8: mcLevel('client.json', {
    title: 'クライアントの役割', n: 3, kind: 'cl8-client-v1',
    card: 'クライアントは、サーバーに仕事を頼んで結果を受け取る側。ブラウザでページを見るスマホや PC がその例。頼まれて返す側はサーバー。',
  }),
  9: tfLevel('packet.json', {
    title: 'パケットとは', kind: 'cl9-packet-v1',
    card: '大きなデータは、そのままでは送らず小分けにして送る。小分けにした 1 つ 1 つをパケットという。パケットには宛先などの情報が付き、受け取った側で元のデータに組み立て直す。',
  }),
  10: mcLevel('packet-merit.json', {
    title: '小分けにするよさ', n: 4, kind: 'cl10-packet-merit-v1',
    card: 'データを小分け(パケット)にして送ると、1 本の線を何人もで順番に使える。途中で壊れたり失われたりしても、その分だけを送り直せばよい。',
  }),
  11: mcLevel('byte-bit.json', {
    title: '1 バイトは何ビット', n: 3, kind: 'cl11-byte-bit-v1',
    card: 'ビットはデータのいちばん小さい単位で、0 か 1 の 1 けた。8 ビットをまとめて 1 バイトという。',
  }),

  // Lv12 バイト → ビット(入力)。1〜160 バイト × 問いの言い方 7 通り
  12: {
    title: 'バイト → ビット', kind: '生', minDistinct: 1000,
    make(rng) {
      const n = rng.rand(1, 160);
      const say = rng.pick([
        `${n} バイトは何ビット?`, `${n} バイトのデータは、何ビット?`, `大きさが ${n} バイトのファイルは、何ビット?`,
        `${n} バイトのメッセージを送ると、何ビット送ることになる?`, `パケットの中のデータが ${n} バイトのとき、それは何ビット?`,
        `${n} バイトをビットで表すと、何ビット?`, `記憶する場所が ${n} バイトあるとき、それは何ビット分?`,
      ]);
      return textQ(say, [field('bits', 'ビット数', 'number', n * 8)],
        'ビットの数 = バイトの数 × 8。1 バイトは 8 ビットなので、バイトの数を 8 倍する。',
        `${n} バイト × 8 = ${n * 8} ビット。8 倍し忘れて ${n} と答えないよう注意。`, 'cl12-byte-to-bit-v1', { bytes: n });
    },
    verify(q) {
      const n = Number(/(\d+) バイト/.exec(q.text)[1]);
      let bits = 0; for (let i = 0; i < 8; i++) bits += n; // 8 回足す
      if (q.fields[0].accept[0] !== String(bits)) fail(q, `答えが ${bits} でない`);
    },
  },

  // Lv13 2 進の位の重み(4 択)。けた数 4〜8 × 位置 × 左右 = 問いの文 60 通り、誤答は 1〜128 のほかの重みから 3 つ
  13: {
    title: '2 進の位の重み', kind: '生', minDistinct: 1000,
    make(rng) {
      const w = rng.rand(4, 8); const p = rng.rand(1, w); const fromLeft = rng.next() < 0.5;
      const weight = fromLeft ? 2 ** (w - p) : 2 ** (p - 1);
      const c = choices(rng, String(weight), MASKS.map((_, i) => String(2 ** i)), 4);
      const side = fromLeft ? '左' : '右';
      return {
        text: `${w} けたの 2 進数で、${side}から ${p} 番目の位の重みはいくつ?`, ...c,
        card: '2 進数の位の重みは、右端が 1 で、左へ 1 つ進むごとに 2 倍になる(1・2・4・8・16・32・64・128)。8 けたなら左端の重みは 128。',
        explanation: `${w} けたの重みは左から ${Array.from({ length: w }, (_, i) => 2 ** (w - 1 - i)).join('・')}。${side}から ${p} 番目は ${weight}。`,
        kind: 'cl13-bin-weight-v1', meta: { w, p, fromLeft },
      };
    },
    verify(q) {
      const [, w, side, p] = /(\d) けたの 2 進数で、(左|右)から (\d) 番目/.exec(q.text).map((x) => (/^\d$/.test(x) ? Number(x) : x));
      const pos = side === '左' ? p - 1 : w - p; // 左から数えた位置(0 始まり)
      const s = Array.from({ length: w }, (_, i) => (i === pos ? '1' : '0')).join('');
      const v = String(binToDec(s));
      if (chosen(q) !== v || q.options.filter((o) => o === v).length !== 1) fail(q, `正解は ${v}`);
    },
  },

  // Lv14 2 の n 乗(入力)。n = 0〜10 と言い方 3 通り(問いの文は 31 通り)
  14: {
    title: '2 の n 乗', kind: '生', minDistinct: 31,
    make(rng) {
      const kindOf = rng.rand(0, 2); const n = rng.rand(kindOf === 0 ? 0 : 1, 10);
      const text = [`2 の ${n} 乗はいくつ?`, `2 を ${n} 回掛けた数はいくつ?`, `${n} ビットで表せる値は、全部で何通り?`][kindOf];
      return textQ(text, [field('value', '答え', 'number', 2 ** n)],
        '2 の n 乗は、2 を n 回掛けた数。1 乗 = 2、2 乗 = 4、3 乗 = 8 と、1 つ増えるごとに 2 倍になる。2 の 0 乗は 1。n ビットで表せる値は 2 の n 乗通り。',
        `${kindOf === 2 ? `${n} ビットで表せる値は 2 の ${n} 乗通り。` : ''}${n === 0 ? '2 の 0 乗は 1(1 から 1 回も 2 倍しない)。' : n === 1 ? '2 の 1 乗は 2。' : `2 を ${n} 回掛けると ${Array(n).fill(2).join(' × ')} = ${2 ** n}。`}`,'cl14-pow2-v1', { n });
    },
    verify(q) {
      const n = Number(/(\d+) (乗|回|ビット)/.exec(q.text)[1]);
      let v = 1; for (let i = 0; i < n; i++) v *= 2;
      if (q.fields[0].accept[0] !== String(v)) fail(q, `答えが ${v} でない`);
    },
  },

  // Lv15 4 けたの 2 進 → 10 進(入力)。0000〜1111 の 16 通り × 言い方 2 通り
  15: {
    title: '4 けたの 2 進 → 10 進', kind: '生', minDistinct: 32,
    make(rng) {
      const v = rng.rand(0, 15); const s = v.toString(2).padStart(4, '0');
      const text = rng.next() < 0.5 ? `2 進数の ${s} は、10 進数でいくつ?` : `4 けたの 2 進数 ${s} を 10 進数にすると?`;
      const parts = [...s].map((ch, i) => (ch === '1' ? 8 >> i : 0)).filter(Boolean);
      return textQ(text, [field('value', '10 進数', 'number', v)],
        '4 けたの 2 進数の位の重みは、左から 8・4・2・1。1 の位の重みを足すと 10 進数になる。例: 1100 = 8 + 4 = 12。',
        `${s} は${parts.length ? ` ${parts.join(' + ')} = ${v}` : 'すべて 0 なので 0'}。`, 'cl15-bin4-to-dec-v1', { v });
    },
    verify(q) {
      const s = /([01]{4})/.exec(q.text)[1];
      if (q.fields[0].accept[0] !== String(parseInt(s, 2))) fail(q, `答えが ${parseInt(s, 2)} でない`);
    },
  },

  // Lv18 よく出る値(マスクの数)(4 択)。1 の個数 8 通り × 問い方 3 通り、誤答はほかのマスクの数から 3 つ
  18: {
    title: 'よく出る値(マスクの数)', kind: '生', minDistinct: 800,
    make(rng) {
      const k = rng.rand(1, 8); const v = MASKS[k - 1]; const bin = '1'.repeat(k) + '0'.repeat(8 - k);
      const others = MASKS.filter((x) => x !== v); const mode = rng.rand(0, 2);
      let text; let c;
      if (mode === 1) { text = `10 進数の ${v} を 8 けたの 2 進数にすると?`; c = choices(rng, bin, others.map((x) => decToBin(x, 8)), 4); }
      else {
        text = mode === 0 ? `8 けたの 2 進数 ${bin} は、10 進数でいくつ?` : (k === 8 ? '8 けたすべてが 1 の 2 進数は、10 進数でいくつ?' : `左から 1 が ${k} 個並び、残りが 0 の 8 けたの 2 進数は、10 進数でいくつ?`);
        c = choices(rng, String(v), others.map(String), 4);
      }
      return {
        text, ...c,
        card: '左から 1 が並ぶ 8 けたの 2 進数は、サブネットマスクによく出る。1 が 1 個 = 128、2 個 = 192、3 個 = 224、4 個 = 240、5 個 = 248、6 個 = 252、7 個 = 254、8 個 = 255。',
        explanation: `${bin} = ${k === 1 ? '128' : `${[128, 64, 32, 16, 8, 4, 2, 1].slice(0, k).join(' + ')} = ${v}`}。`, kind: 'cl18-mask-values-v1', meta: { k, mode },
      };
    },
    verify(q) {
      let want;
      if (/10 進数の (\d+) を/.test(q.text)) {
        const v = Number(/10 進数の (\d+) を/.exec(q.text)[1]);
        want = q.options.find((o) => binToDec(o) === v); // 2 進の選択肢を 10 進に直して照らす
        if (q.options.filter((o) => binToDec(o) === v).length !== 1) fail(q, '正解が 1 つでない');
      } else {
        const m = /2 進数 ([01]{8}) は/.exec(q.text);
        const k = m ? m[1].indexOf('0') === -1 ? 8 : m[1].indexOf('0') : (/すべてが 1/.test(q.text) ? 8 : Number(/1 が (\d) 個/.exec(q.text)[1]));
        if (m && !/^1*0*$/.test(m[1])) fail(q, '1 が左から並んでいない');
        want = String(256 - 2 ** (8 - k));
        if (q.options.filter((o) => o === want).length !== 1) fail(q, '正解が 1 つでない');
      }
      if (chosen(q) !== want) fail(q, `正解は ${want}`);
    },
  },

  // Lv19 16 進の数字(4 択)。A〜F → 10 進、10〜15 → 16 進 1 けた、1 けたの最大、16 進の 10
  19: {
    title: '16 進の数字', kind: '生', minDistinct: 400,
    make(rng) {
      const r = rng.next(); let text; let c; let explanation;
      if (r < 0.4) {
        const v = rng.rand(10, 15);
        text = `16 進数の ${HEX[v]} は、10 進数でいくつ?`;
        c = choices(rng, String(v), [9, 10, 11, 12, 13, 14, 15, 16].map(String), 4);
        explanation = `16 進数の A = 10、B = 11、C = 12、D = 13、E = 14、F = 15。${HEX[v]} は ${v}。`;
      } else if (r < 0.8) {
        const v = rng.rand(10, 15);
        text = `10 進数の ${v} を、16 進数 1 けたで書くと?`;
        c = choices(rng, HEX[v], ['A', 'B', 'C', 'D', 'E', 'F', 'G', '9'], 4);
        explanation = `10 = A、11 = B、12 = C、13 = D、14 = E、15 = F。${v} は ${HEX[v]}。G は 16 進数では使わない。`;
      } else if (r < 0.9) {
        text = '16 進数 1 けたで表せる、いちばん大きい数は 10 進数でいくつ?';
        c = choices(rng, '15', ['9', '10', '14', '16', '255'], 4);
        explanation = '1 けたで最大は F で、10 進数の 15。16 は 2 けた(10)になる。255 は 2 けた(FF)の最大。';
      } else {
        text = '16 進数の 10 は、10 進数でいくつ?';
        c = choices(rng, '16', ['10', '15', '100', '20', '1'], 4);
        explanation = 'F(15)の次でけたが上がって 10 になる。16 進数の 10 は 10 進数の 16。';
      }
      return {
        text, ...c,
        card: '16 進数は、0〜9 のあとを A〜F で表す。A = 10、B = 11、C = 12、D = 13、E = 14、F = 15。F の次で 1 けた上がって 10(10 進の 16)になる。',
        explanation, kind: 'cl19-hex-digit-v1',
      };
    },
    verify(q) {
      let want;
      let m;
      if ((m = /16 進数の ([A-F]) は/.exec(q.text))) want = String(HEX.indexOf(m[1]));
      else if ((m = /10 進数の (\d+) を/.exec(q.text))) want = Number(m[1]).toString(16).toUpperCase();
      else if (/いちばん大きい/.test(q.text)) want = String(parseInt('F', 16));
      else if (/16 進数の 10 は/.test(q.text)) want = String(parseInt('10', 16));
      else fail(q, '問いの形がわからない');
      if (chosen(q) !== want || q.options.filter((o) => o === want).length !== 1) fail(q, `正解は ${want}`);
    },
  },

  // Lv20 16 進 1 けた ⇄ 2 進 4 けた(入力)。16 通り × 向き 2 通り
  20: {
    title: '16 進 1 けた ⇄ 2 進 4 けた', kind: '生', minDistinct: 32,
    make(rng) {
      const v = rng.rand(0, 15); const b = v.toString(2).padStart(4, '0'); const h = HEX[v];
      const card = '16 進数 1 けたは、2 進数 4 けたにちょうど対応する。2 進 4 けたの重みは左から 8・4・2・1。例: 16 進の 9 = 8 + 1 → 1001。';
      const sum = [8, 4, 2, 1].filter((x) => v & x);
      const how = `${h} = ${v}${sum.length > 1 ? ` = ${sum.join(' + ')}` : ''} → ${b}`;
      if (rng.next() < 0.5) {
        return textQ(`16 進数の ${h} を、2 進数 4 けたで書くと?`, [field('bin', '2 進数 4 けた', 'bin', b, { digits: 4 })], card, `${how}。`, 'cl20-hex-bin4-v1', { v, dir: 'hex2bin' });
      }
      return textQ(`2 進数の ${b} を、16 進数 1 けたで書くと?`, [field('hex', '16 進数 1 けた', 'hex', h, { digits: 1 })], card, `${b} = ${sum.length ? sum.join(' + ') : '0'} = ${v} → 16 進の ${h}。`, 'cl20-hex-bin4-v1', { v, dir: 'bin2hex' });
    },
    verify(q) {
      let m;
      if ((m = /16 進数の ([0-9A-F]) を/.exec(q.text))) { const want = decToBin(HEX.indexOf(m[1]), 4); if (q.fields[0].accept[0] !== want) fail(q, `正解は ${want}`); }
      else if ((m = /2 進数の ([01]{4}) を/.exec(q.text))) { const want = HEX[binToDec(m[1])].toLowerCase(); if (q.fields[0].accept[0] !== want) fail(q, `正解は ${want}`); }
      else fail(q, '問いの形がわからない');
    },
  },

  21: mcLevel('bps.json', {
    title: 'bps とは', n: 4, kind: 'cl21-bps-v1',
    card: 'bps(bits per second)は、1 秒に送れるビットの数で、回線の速さを表す。1 kbps = 1,000 bps、1 Mbps = 1,000 kbps、1 Gbps = 1,000 Mbps。',
  }),

  // Lv22 k・M・G(速さ)(入力)。となりの単位の組 3 通り × 向き 2 通り × 1〜100
  22: {
    title: 'k・M・G(速さ)', kind: '生', minDistinct: 550,
    make(rng) {
      const i = rng.rand(1, 3); const big = SPEED[i]; const small = SPEED[i - 1]; const x = rng.rand(1, 100);
      const card = '速さの単位は 1,000 倍ずつ: 1 kbps = 1,000 bps、1 Mbps = 1,000 kbps、1 Gbps = 1,000 Mbps。大きい単位から小さい単位へは × 1,000、小さい単位から大きい単位へは ÷ 1,000。';
      if (rng.next() < 0.5) {
        return textQ(`${x} ${big} は何 ${small}?`, [field('value', small, 'number', x * 1000)], card, `${big} → ${small} は 1,000 倍。${x} × 1,000 = ${comma(x * 1000)} ${small}。`, 'cl22-speed-units-v1', { x, i, dir: 'down' });
      }
      return textQ(`${comma(x * 1000)} ${small} は何 ${big}?`, [field('value', big, 'number', x)], card, `${small} → ${big} は 1,000 で割る。${comma(x * 1000)} ÷ 1,000 = ${x} ${big}。`, 'cl22-speed-units-v1', { x, i, dir: 'up' });
    },
    verify(q) {
      const m = /^([\d,]+) (\w+) は何 (\w+)\?$/.exec(q.text); if (!m) fail(q, '問いの形がわからない');
      const given = Number(m[1].replace(/,/g, '')); const d = SPEED.indexOf(m[2]) - SPEED.indexOf(m[3]);
      if (Math.abs(d) !== 1) fail(q, 'となりの単位でない');
      const want = d > 0 ? given * 1000 : given / 1000;
      if (!Number.isInteger(want) || q.fields[0].accept[0] !== String(want)) fail(q, `正解は ${want}`);
    },
  },

  // Lv23 KB・MB・GB(4 択)。1 つ・2 つ離れた単位の組 14 通り × 1〜20。誤答は 10 倍・100 倍のずれ、変えないまま など
  23: {
    title: 'KB・MB・GB', kind: '生', minDistinct: 500,
    make(rng) {
      let i; let j; do { i = rng.rand(0, 4); j = rng.rand(0, 4); } while (Math.abs(i - j) < 1 || Math.abs(i - j) > 2);
      const x = rng.rand(1, 20); const f = 1000 ** Math.abs(i - j);
      const down = i > j; // 大きい単位 → 小さい単位
      const given = down ? x : x * f; const ans = down ? x * f : x;
      const fmt = (v) => (Number.isInteger(v) ? comma(v) : String(v));
      const cand = [ans * 10, ans * 100, ans * 1000, ans / 10, ans / 100, ans / 1000, given].filter((v) => v !== ans && v >= 0.001);
      const c = choices(rng, fmt(ans), [...new Set(cand.map(fmt))], 4);
      return {
        text: `${fmt(given)} ${unitJa(SIZE[i])}は${nani(SIZE[j])}?\n(ここでは 1 KB = 1,000 バイトのように、1,000 倍ずつで数える)`, ...c,
        card: 'データの量の単位は、ここでは 1,000 倍ずつで数える: 1 KB = 1,000 バイト、1 MB = 1,000 KB、1 GB = 1,000 MB、1 TB = 1,000 GB。',
        explanation: `${SIZE[i]} → ${SIZE[j]} は ${Math.abs(i - j) === 1 ? '1 つ' : '2 つ'}${down ? '下の単位なので × ' : '上の単位なので ÷ '}${comma(f)}。${fmt(given)} ${down ? '×' : '÷'} ${comma(f)} = ${fmt(ans)} ${SIZE[j]}。`,
        kind: 'cl23-size-units-v1', meta: { i, j, x },
      };
    },
    verify(q) {
      const m = /^([\d,.]+) (バイト|KB|MB|GB|TB) ?は何 ?(バイト|KB|MB|GB|TB)\?/.exec(q.text); if (!m) fail(q, '問いの形がわからない');
      let v = Number(m[1].replace(/,/g, '')); let a = SIZE.indexOf(m[2]); const b = SIZE.indexOf(m[3]);
      while (a > b) { v *= 1000; a--; } while (a < b) { v /= 1000; a++; } // 1 段ずつ直す
      const num = (s) => Number(s.replace(/,/g, ''));
      if (num(chosen(q)) !== v || q.options.filter((o) => num(o) === v).length !== 1) fail(q, `正解は ${v}`);
    },
  },

  // Lv24 データ量 → ビット(入力)。単位 4 通り × 1〜125 × 言い方 2 通り
  24: {
    title: 'データ量 → ビット', kind: '生', minDistinct: 990,
    make(rng) {
      const [u, v] = rng.pick(BITS_OF); const x = rng.rand(1, 125);
      const text = rng.next() < 0.5 ? `${x} ${unitJa(u)}は${nani(v)}?` : `${x} ${unitJa(u)}のファイルを送ると、${nani(v)}${latin(v) ? ' ' : ''}送ることになる?`;
      return textQ(text, [field('value', v, 'number', x * 8)],
        'ビットの数 = バイトの数 × 8。k・M・G の付いた単位も同じで、単位の頭(k・M・G)はそのままにして数だけ 8 倍する。例: 2 MB = 16 Mbit。',
        `1 バイト = 8 ビットなので、${x} ${u} = ${x} × 8 = ${x * 8} ${v}。`, 'cl24-size-to-bits-v1', { x, u });
    },
    verify(q) {
      const m = /^(\d+) (バイト|KB|MB|GB) ?(は何|のファイル)/.exec(q.text); if (!m) fail(q, '問いの形がわからない');
      const pair = BITS_OF.find(([u]) => u === m[2]); if (!pair || !q.text.includes(nani(pair[1]))) fail(q, '単位の組が合わない');
      if (q.fields[0].accept[0] !== String(Number(m[1]) << 3)) fail(q, `正解は ${Number(m[1]) << 3}`);
    },
  },

  25: mcLevel('switch.json', {
    title: 'スイッチ', n: 4, kind: 'cl25-switch-v1',
    card: 'スイッチは、同じ LAN の中で、データを届け先の機器がつながった差し口にだけ配る機器。PC やプリンターをケーブルで何台もつなぐのに使う。',
  }),
  26: mcLevel('router.json', {
    title: 'ルーター', n: 4, kind: 'cl26-router-v1',
    card: 'ルーターは、ネットワークとネットワークの間に置き、届け先のネットワークへの道(ルート)を選んでデータを送り出す機器。網と網をつなぐのが主な役割。',
  }),
  27: mcLevel('ap.json', {
    title: 'アクセスポイント', n: 4, kind: 'cl27-ap-v1',
    card: 'アクセスポイント(AP)は、電波を出して、スマホや PC などの無線の端末を LAN につなぐ機器。無線 LAN の入口になる。',
  }),
  28: mcLevel('onu.json', {
    title: 'モデム・ONU', n: 4, kind: 'cl28-onu-modem-v1',
    card: '光回線の入口には ONU を置き、光の信号と電気の信号を変換する。電話線などの回線では、モデムが回線の信号とデジタルの信号を変換する。',
  }),
  29: mcLevel('firewall.json', {
    title: 'ファイアウォール', n: 4, kind: 'cl29-firewall-v1',
    card: 'ファイアウォール(FW)は、前もって決めた規則に合う通信だけを通し、それ以外を止める機器やソフト。社内とインターネットの境目に置いて、外からの勝手な通信を防ぐ。',
  }),
  30: tfLevel('combo-device.json', {
    title: '1 台で兼ねる機器', kind: 'cl30-combo-device-v1',
    card: 'スイッチ・ルーター・アクセスポイントなどは「役割」の名前。1 つの箱がいくつもの役割を兼ねることがあり、家庭用の無線ルーターはルーター・アクセスポイント・スイッチを兼ねることが多い。',
  }),
  31: mcLevel('cable.json', {
    title: 'ケーブルの種類', n: 3, kind: 'cl31-cable-v1',
    card: 'LAN ケーブル(より対線)は、銅の線で電気の信号を送る(長さは 100 m ほどまで)。光ファイバーは、細いガラスなどの線で光の信号を送り、長い距離に向き、電気のノイズの影響を受けにくい。',
  }),
  32: mcLevel('rj45.json', {
    title: 'LAN ケーブルの差し口', n: 3, kind: 'cl32-rj45-v1',
    card: 'LAN ケーブル(銅線)の先は RJ-45 という四角いコネクターで、中に 8 本の線が並ぶ。PC やスイッチの LAN の差し口に差すと、つめでカチッと止まる。',
  }),
  33: tfLevel('wired-wireless.json', {
    title: '有線と無線', kind: 'cl33-wired-wireless-v1',
    card: '有線(ケーブル)は、電波の影響を受けにくく速さが安定しやすいが、ケーブルの届く所でしか使えない。無線は線が要らず手軽だが、電波の干渉・距離・壁などで速さが変わりやすい。',
  }),
  34: mcLevel('ssid.json', {
    title: 'SSID', n: 4, kind: 'cl34-ssid-v1',
    card: 'SSID は、無線 LAN のネットワークに付けた名前。スマホなどは、まわりの SSID の一覧からつなぎたいネットワークを選ぶ。つなぐための合言葉(パスワード)とは別のもの。',
  }),
  35: tfLevel('ip-what.json', {
    title: 'IP アドレスとは', kind: 'cl35-ip-what-v1',
    card: 'IP アドレスは、ネットワークの上で機器を見分けるための住所(番号)。データは届け先の IP アドレスをたよりに運ばれる。同じネットワークの中で、同じアドレスを 2 台に付けてはいけない。',
  }),
  36: mcLevel('ipv4-bits.json', {
    title: 'IPv4 は何ビット', n: 4, kind: 'cl36-ipv4-bits-v1',
    card: 'IPv4 アドレスは 32 ビット。8 ビット(= 1 バイト)ずつ 4 つに区切り、192.0.2.10 のように 10 進の数を点でつないで書く。',
  }),

  // Lv37 正しい IPv4 の形(4 択)。正しい形を 1 つ選ぶ / 正しくない形を 1 つ選ぶ
  37: {
    title: '正しい IPv4 の形', kind: '生', minDistinct: 1000,
    make(rng) {
      const pickValid = rng.next() < 0.6;
      let answer; let others; let bads;
      if (pickValid) {
        answer = v4Parts(rng).join('.'); bads = pickBad(rng, V4_BAD, 3, answer); others = bads.map((b) => b.s);
      } else {
        bads = pickBad(rng, V4_BAD, 1, null); answer = bads[0].s; others = distinctList(rng, (r) => v4Parts(r).join('.'), 3, answer);
      }
      const c = choices(rng, answer, others, 4);
      return {
        text: `IPv4 アドレスの書き方として${pickValid ? '正しい' : '正しくない'}のはどれ?`, ...c,
        card: 'IPv4 アドレスは、0〜255 の数を点(.)で区切って 4 つ並べて書く。例: 192.0.2.10。256 以上の数があるもの、数が 3 つや 5 つのもの、空の区切りがあるものは正しくない。',
        explanation: `${pickValid ? `${answer} は 0〜255 の数が 4 つ並んでいて正しい。` : ''}${bads.map((b) => b.why).join('。')}。`,
        kind: 'cl37-ipv4-form-v1', meta: { pickValid },
      };
    },
    verify(q) {
      const wantValid = !q.text.includes('正しくない');
      const hits = q.options.map((o) => IPV4_RE.test(o) === wantValid);
      if (!hits[q.answerIndex] || hits.filter(Boolean).length !== 1) fail(q, '当てはまる選択肢が正解の 1 つだけでない');
    },
  },

  // Lv38 1 区切りの最大(入力)。□ に書ける最大の数(アドレスの形を変えて)、1 区切りの最大、0 から何まで、何通り
  38: {
    title: '1 区切りの最大', kind: '生', minDistinct: 1000,
    make(rng) {
      const card = 'IPv4 アドレスの 1 区切りは 8 ビット。8 ビットで表せるのは 0〜255 の 256 通りなので、1 区切りに書けるいちばん大きい数は 255。';
      const r = rng.next();
      if (r < 0.7) {
        const p = v4Parts(rng); const fixed = p[0] === 10 ? 1 : (p[0] === 172 || (p[0] === 192 && p[1] === 168)) ? 2 : 3; // 範囲を決める区切りは残す
        const i = rng.rand(fixed, 3); const shown = p.map((x, k) => (k === i ? '□' : String(x))).join('.');
        return textQ(`IPv4 アドレスの書き方として、${shown} の □ に書ける、いちばん大きい数は?`, [field('value', '数', 'number', 255)], card,
          `1 区切りは 8 ビットで 0〜255。□ に書ける最大は 255(256 は書けない)。`, 'cl38-octet-max-v1', { mode: 'blank' });
      }
      if (r < 0.8) return textQ('IPv4 アドレスの 1 区切り(8 ビット)で表せる、いちばん大きい数は?', [field('value', '数', 'number', 255)], card, '8 ビットがすべて 1 の 11111111 = 255。', 'cl38-octet-max-v1', { mode: 'max' });
      if (r < 0.9) return textQ('IPv4 アドレスの 1 区切りに書ける数は、0 から何まで?', [field('value', '数', 'number', 255)], card, '0〜255。8 ビットで表せる最大が 255。', 'cl38-octet-max-v1', { mode: 'range' });
      return textQ('IPv4 アドレスの 1 区切りに書ける数は、0 から数えて全部で何通り?', [field('value', '数', 'number', 256)], card, '0〜255 なので、0 も数えて 256 通り(2 の 8 乗)。最大の 255 と取り違えないよう注意。', 'cl38-octet-max-v1', { mode: 'count' });
    },
    verify(q) {
      let all = 1; for (let i = 0; i < 8; i++) all *= 2; // 8 ビットで表せる数の通り
      const want = q.text.includes('何通り') ? all : all - 1;
      if (q.fields[0].accept[0] !== String(want)) fail(q, `正解は ${want}`);
      const m = /、(\S+) の □/.exec(q.text);
      if (m && (!IPV4_RE.test(m[1].replace('□', String(want))) || IPV4_RE.test(m[1].replace('□', String(want + 1))))) fail(q, '□ の最大が合わない');
    },
  },

  39: mcLevel('mac-what.json', {
    title: 'MAC アドレスとは', n: 4, kind: 'cl39-mac-what-v1',
    card: 'MAC アドレスは、ネットワークにつなぐ部品(LAN の差し口や無線の部品)ごとに、作るときに付けられる 48 ビットの番号。同じ LAN の中で相手を見分けるのに使う。',
  }),

  // Lv40 MAC アドレスの形(4 択)。正しい形を 1 つ選ぶ / 正しくない形を 1 つ選ぶ。区切りはコロンだけを使う(ハイフン区切りも正しい書き方なので誤答にしない)
  40: {
    title: 'MAC アドレスの形', kind: '生', minDistinct: 1000,
    make(rng) {
      const pickValid = rng.next() < 0.6;
      let answer; let others; let bads;
      if (pickValid) {
        answer = macParts(rng).join(':'); bads = pickBad(rng, MAC_BAD, 3, answer); others = bads.map((b) => b.s);
      } else {
        bads = pickBad(rng, MAC_BAD, 1, null); answer = bads[0].s; others = distinctList(rng, (r) => macParts(r).join(':'), 3, answer);
      }
      const c = choices(rng, answer, others, 4);
      return {
        text: `MAC アドレスの書き方として${pickValid ? '正しい' : '正しくない'}のはどれ?`, ...c,
        card: 'MAC アドレスは 48 ビット。16 進 2 けた(00〜ff)を 6 組、コロン(:)で区切って書く。例: 02:1a:2b:3c:4d:5e。16 進で使う文字は 0〜9 と a〜f だけ。',
        explanation: `${pickValid ? `${answer} は 16 進 2 けたが 6 組で正しい。` : ''}${bads.map((b) => b.why).join('。')}。`,
        kind: 'cl40-mac-form-v1', meta: { pickValid },
      };
    },
    verify(q) {
      const wantValid = !q.text.includes('正しくない');
      const hits = q.options.map((o) => MAC_RE.test(o) === wantValid);
      if (!hits[q.answerIndex] || hits.filter(Boolean).length !== 1) fail(q, '当てはまる選択肢が正解の 1 つだけでない');
    },
  },

  41: tfLevel('ip-vs-mac.json', {
    title: 'IP と MAC の使い分け', kind: 'cl41-ip-vs-mac-v1',
    card: 'MAC アドレスは、同じ LAN の中で次に渡す相手を見分けるのに使う。IP アドレスは、ネットワークをまたいだ最後の届け先を表す。ルーターを越えると MAC アドレスは付けかえられ、届け先の IP アドレスはふつうそのまま。',
  }),
  42: mcLevel('private.json', {
    title: 'プライベートアドレス', n: 4, kind: 'cl42-private-v1',
    card: 'プライベートアドレスは、家や会社の中(LAN)だけで使う IPv4 アドレス。10.0.0.0〜10.255.255.255、172.16.0.0〜172.31.255.255、192.168.0.0〜192.168.255.255 の 3 つの範囲。ほかの家や会社と重なってもよい。',
  }),
  43: tfLevel('global.json', {
    title: 'グローバルアドレス', kind: 'cl43-global-v1',
    card: 'グローバルアドレスは、インターネットで使う IP アドレスで、世界の中で重ならないように割り当てて管理される。家や会社の中のプライベートアドレス(10.・172.16〜31.・192.168. で始まる)は、外に出るとき出口でグローバルアドレスに置きかえる。',
  }),

  // Lv44 ループバック(4 択)。127 で始まるアドレス(ふつう 127.0.0.1)を選ぶ
  44: {
    title: 'ループバック', kind: '生', minDistinct: 1000,
    make(rng) {
      const answer = rng.next() < 0.6 ? '127.0.0.1' : `127.${rng.rand(0, 255)}.${rng.rand(0, 255)}.${rng.rand(1, 254)}`;
      const others = distinctList(rng, (r) => (r.next() < 0.15 ? '255.255.255.255' : v4Parts(r).join('.')), 3, answer);
      const c = choices(rng, answer, others, 4);
      const text = rng.pick(['自分自身(この機器)を指す IPv4 アドレスはどれ?', 'IPv4 のループバックアドレスはどれ?', '送ったデータが外へ出ず、自分に戻ってくる IPv4 アドレスはどれ?']);
      return {
        text, ...c,
        card: 'ループバックアドレスは、自分自身を指すアドレス。IPv4 では 127 で始まるアドレス(ふつうは 127.0.0.1)。送ったデータは外へ出ず、自分に戻ってくる。',
        explanation: `127 で始まる ${answer} がループバックアドレス。${others.join('・')} は 127 で始まらないので、ほかの機器や範囲を指す。`,
        kind: 'cl44-loopback-v1', meta: { answer },
      };
    },
    verify(q) {
      const hits = q.options.map((o) => IPV4_RE.test(o) && o.split('.')[0] === '127');
      if (!hits[q.answerIndex] || hits.filter(Boolean).length !== 1) fail(q, '127 で始まる選択肢が正解の 1 つだけでない');
    },
  },

  45: mcLevel('ipv6-why.json', {
    title: 'IPv6 があるわけ', n: 4, kind: 'cl45-ipv6-why-v1',
    card: 'IPv4 アドレスは 32 ビットで、約 43 億個しかない。インターネットにつながる機器が増えて足りなくなったため、128 ビットでとても多くのアドレスを持つ IPv6(IP のバージョン 6)が作られた。',
  }),
  46: mcLevel('ipv6-look.json', {
    title: 'IPv6 の見た目', n: 4, kind: 'cl46-ipv6-look-v1',
    card: 'IPv6 アドレスは、16 進の数を 4 けたずつ 8 組、コロン(:)で区切って書く。0 が続く所は「::」でまとめられる。例: 2001:db8::1。IPv4 は 192.0.2.1 のように点で区切った 10 進。',
  }),
  47: mcLevel('ipv6-bits.json', {
    title: 'IPv6 は何ビット', n: 4, kind: 'cl47-ipv6-bits-v1',
    card: 'IPv6 アドレスは 128 ビット。16 ビット(16 進 4 けた)ずつ 8 組に区切って書く。IPv4 は 32 ビット、MAC アドレスは 48 ビット。',
  }),
  48: mcLevel('gateway.json', {
    title: 'デフォルトゲートウェイ', n: 4, kind: 'cl48-gateway-v1',
    card: 'デフォルトゲートウェイは、ほかのネットワークへ送るとき最初に渡す相手で、ふつうは LAN の出口のルーター。同じ LAN の中の相手には、ゲートウェイを通さず直接送る。',
  }),
  49: mcLevel('domain.json', {
    title: 'ドメイン名', n: 4, kind: 'cl49-domain-v1',
    card: 'ドメイン名は、www.shop.example のように、数の IP アドレスの代わりに人が覚えやすいよう付けた名前。点(.)で区切って書く。',
  }),
  50: mcLevel('dns.json', {
    title: 'DNS', n: 4, kind: 'cl50-dns-v1',
    card: 'DNS は、ドメイン名から IP アドレスを調べるしくみ。電話帳のように名前を引くと番号が返ってくる。ブラウザに名前を打つと、まず DNS サーバーに問い合わせて相手の IP アドレスを調べる。',
  }),
  51: mcLevel('dhcp.json', {
    title: 'DHCP', n: 4, kind: 'cl51-dhcp-v1',
    card: 'DHCP は、ネットワークにつないだ機器に IP アドレスなどを自動で配るしくみ。配る役は DHCP サーバー(家ではルーターが兼ねることが多い)。手で 1 台ずつ設定しなくてよくなる。',
  }),
  52: mcLevel('dhcp-items.json', {
    title: 'DHCP で配るもの', n: 4, kind: 'cl52-dhcp-items-v1',
    card: 'DHCP で配るのは、IP アドレス・サブネットマスク・デフォルトゲートウェイ・DNS サーバーのアドレスなど。MAC アドレスは部品に初めから付いているので配らない。無線 LAN の SSID やパスワードも DHCP では配らない。',
  }),
  53: mcLevel('http.json', {
    title: 'HTTP', n: 4, kind: 'cl53-http-v1',
    card: 'HTTP は、ブラウザと Web サーバーがページをやりとりするときの決まり(プロトコル)。ブラウザが「このページをください」と頼み(リクエスト)、サーバーがページを返す(レスポンス)。',
  }),

  // Lv54 URL のホスト名(4 択)。URL の表から。誤答はその URL のスキーム・パス・URL 全体・スキーム付きのホスト
  54: (() => {
    const rows = facts('url-samples.json');
    return {
      title: 'URL のホスト名', kind: '表', minDistinct: 30, rows,
      make(rng) {
        const row = rng.pick(rows); const { scheme, host, path: p } = row.attrs;
        const c = choices(rng, host, [scheme, p, row.ja, `${scheme}://${host}`], 4);
        return {
          text: `次の URL のホスト名はどれ?\n${row.ja}`, ...c,
          card: 'URL の「://」のあとから、次の「/」の前までがホスト名(どのサーバーか)。https://www.shop.example/news なら、ホスト名は www.shop.example。前の https はスキーム、後ろの /news はパス。',
          explanation: `ホスト名は「://」と次の「/」の間なので ${host}。${scheme} はスキーム、${p} はパス。`, kind: 'cl54-url-host-v1', meta: { row: row.id },
        };
      },
    };
  })(),

  // Lv55 URL のスキームとパス(3 択)。誤答はその URL のほかの部分と URL 全体
  55: (() => {
    const rows = facts('url-samples.json');
    return {
      title: 'URL のスキームとパス', kind: '表', minDistinct: 30, rows,
      make(rng) {
        const row = rng.pick(rows); const { scheme, host, path: p } = row.attrs; const askScheme = rng.next() < 0.5;
        const c = choices(rng, askScheme ? scheme : p, [host, askScheme ? p : scheme, row.ja], 3);
        return {
          text: `次の URL の${askScheme ? 'スキーム' : 'パス'}はどれ?\n${row.ja}`, ...c,
          card: 'URL は「スキーム://ホスト名/パス」の形。「://」の前がスキーム(https や http。やりとりの決まり)、ホスト名のあとの「/」から後ろがパス(サーバーの中のどのページか)。',
          explanation: `${row.ja} は、スキーム ${scheme}、ホスト名 ${host}、パス ${p}。`, kind: 'cl55-url-parts-v1', meta: { row: row.id, ask: askScheme ? 'scheme' : 'path' },
        };
      },
    };
  })(),

  56: mcLevel('smtp.json', {
    title: 'メールを送る', n: 4, kind: 'cl56-smtp-v1',
    card: 'メールを送るとき(メールアプリから送信用のサーバーへ、サーバーから相手のサーバーへ)は SMTP という決まりを使う。メールアプリで受け取って読むときは POP や IMAP を使う。',
  }),
  57: mcLevel('imap.json', {
    title: 'メールを受け取る', n: 3, kind: 'cl57-imap-v1',
    card: 'メールを受け取る決まりには POP と IMAP がある。POP はメールを自分の機器に持ち帰って読む。IMAP はメールをサーバーに置いたまま読むので、スマホと PC で同じメールを見られる。送るのは SMTP。',
  }),
  58: tfLevel('password.json', {
    title: 'パスワードの基本', kind: 'cl58-password-v1',
    card: 'パスワードは長く、推測されにくくし、サービスごとに変える(使い回さない)。ほかの人に教えず、もれたらすぐ変える。できれば、パスワードに加えて別の確認(2 段階の認証)も使う。',
  }),
  59: mcLevel('https.json', {
    title: 'HTTPS', n: 4, kind: 'cl59-https-v1',
    card: 'HTTPS は、HTTP のやりとりを暗号化したもの(S は Secure)。途中で盗み見られたり書きかえられたりしにくい。URL が https:// で始まる。',
  }),
  60: tfLevel('update.json', {
    title: '更新と対策ソフト', kind: 'cl60-update-v1',
    card: 'ソフトの更新(アップデート)は、見つかった弱点をふさぐ大事な守り。OS・アプリ・機器のソフトを作った会社の正しい入手先から更新して新しく保ち、ウイルス対策ソフトも使い、あやしいファイルは開かない。',
  }),
  61: tfLevel('cloud-what.json', {
    title: 'クラウドとは', kind: 'cl61-cloud-what-v1',
    card: 'クラウドは、事業者が持つコンピューター(サーバー)や保存場所を、インターネット越しに借りて使う形。自分で機器を買って置かなくてよく、使った分だけ払うことが多い。データを守る設定は使う人もする。',
  }),
  62: mcLevel('cloud-merit.json', {
    title: 'クラウドのよさ', n: 4, kind: 'cl62-cloud-merit-v1',
    card: 'クラウドのよさ: 機器を買わずにすぐ使い始められる、使う分だけ払う、必要に応じてすぐ増やしたり減らしたりできる、機器の手入れを事業者に任せられる。インターネットにつながっている必要はある。',
  }),
  63: mcLevel('virtualization.json', {
    title: '仮想化とは', n: 4, kind: 'cl63-virtualization-v1',
    card: '仮想化は、1 台の物理のコンピューターの中で、ソフトの力で何台ものコンピューター(仮想マシン)を動かすしくみ。機器の台数を減らせ、作るのも消すのも早い。',
  }),
  64: mcLevel('vpn.json', {
    title: '社外から社内のネットワークへ', n: 4, kind: 'cl64-vpn-v1',
    card: 'VPN(Virtual Private Network)は、インターネットの上に暗号で守った専用の道を作り、離れた所から社内のネットワークに安全に入るしくみ。家や出先から社内のシステムを使うときに使う。',
  }),

  // Lv65 つながらないとき(並べ替え。入力で「2-3-1」の形に答える)。線・アドレス・名前の段から 1 つずつ選び、並べる順を変える
  65: (() => {
    const rows = facts('trouble-order.json');
    const byLayer = [1, 2, 3].map((l) => rows.filter((r) => r.attrs.layer === l));
    const LAYER_NAME = { 1: '線・無線', 2: 'アドレス', 3: '名前' };
    return {
      title: 'つながらないとき', kind: '表', minDistinct: 30, rows,
      make(rng) {
        const items = rng.shuffle(byLayer.map((g) => rng.pick(g)));
        const order = [1, 2, 3].map((l) => items.findIndex((it) => it.attrs.layer === l) + 1);
        return textQ(`ネットワークにつながらないとき、次の 3 つを確かめる。見る順に番号を並べると?\n${items.map((it, i) => `${i + 1}. ${it.ja}`).join('\n')}`,
          [field('order', '見る順(番号を - で区切る)', 'devname', order.join('-'))],
          'つながらないときは下から順に見る。まず線(ケーブルが差さっているか・無線につながっているか)、次にアドレス(IP アドレスが付いているか・ゲートウェイに届くか)、最後に名前(ドメイン名から調べられるか)。',
          `答えは ${order.join('-')}。${order.map((i) => `${LAYER_NAME[items[i - 1].attrs.layer]}(${items[i - 1].ja})`).join(' → ')} の順。下の段がだめなら、上の段も動かないから。`,
          'cl65-trouble-order-v1', { rows: items.map((it) => it.id) });
      },
      verify(q) {
        const lines = q.text.split('\n').slice(1).map((s) => s.replace(/^\d\. /, ''));
        const layers = lines.map((ja) => rows.find((r) => r.ja === ja).attrs.layer);
        const want = [...layers.keys()].sort((a, b) => layers[a] - layers[b]).map((i) => i + 1).join('');
        if (q.fields[0].accept[0] !== want) fail(q, `正解は ${want}`);
      },
    };
  })(),

  66: mcLevel('ping.json', {
    title: 'ping', n: 4, kind: 'cl66-ping-v1',
    card: 'ping は、相手に「届いたら返事して」という小さな合図を送り、返事が来るかで届くかどうかを確かめるコマンド。ping 192.0.2.1 のように相手のアドレスか名前を付けて打つ。返事までの時間もわかる。',
  }),
};

module.exports = { LEVELS };
