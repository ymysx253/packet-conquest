'use strict';
// 専門(新しい番号 320〜361。docs/LEVEL-LIST.md 第 6 章)のうち、担当 O で仕組みの要らない「生成・入力」の 8 項目: 320・321・334・335・337・338・340・348。
// 担当: Claude Fable 5.1(2026-10-25)。書き方は docs/questions/CL.md。専門はヒントなし(解説 explanation だけ)。テストは test/cl-expert.js
// 生成のレベルは verify で、問題文と表の文字を読み直して別の方法(2 進の文字列・BigInt・1 歩ずつの模擬)で解き直す。meta は確かめ用(画面には送らない)
//
// ゲーム内の規則(問題文にも書く):
//   320 IPv4 の計画: 親の網を拠点に分けるとき、台数の違う拠点は大きい順に親の先頭から詰める(集約できる形。大きさは 2 の累乗で、台数 + 2(網とブロードキャスト)が入るいちばん小さいもの)
//   321 IPv6 の計画: /48 を /52・/56・/60 ずつに切る。k 拠点目(1 始まり)は先頭から k 番目のかたまり
//   334 PC クラウドのサブネット: 経路表の 0.0.0.0/0 がインターネットゲートウェイへ向く = 公開(外から始める通信も受けられる)、NAT ゲートウェイへ向く = 非公開(外へ出るだけ。外から始める通信は入れない)、0.0.0.0/0 の行が無い = 隔離(外と通信しない)
//   335 PC クラウドのアドレス: 各サブネットで先頭の 4 つと最後の 1 つ(計 5 つ)は予約で VM に使えない
//   337 負荷分散: 順番に振る(ラウンドロビン)。1 番目の要求は 1 台目。重み付きは重みの数だけ続けて同じ台に振る。止まっている台は飛ばす
//   338 死活監視: NG が連続 n 回で振り分け先から外し、OK が連続 m 回で戻す。表の左端より前は全部 OK で全部入っていた
//   348 ログの時刻: JST = UTC + 9 時間。「+09:00」付きの表し方は JST と同じ

// ================= 共通の道具 =================
const ip2n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const n2ip = (n) => [24, 16, 8, 0].map((b) => Math.floor(n / 2 ** b) % 256).join('.');
const blockSize = (len) => 2 ** (32 - len);
const netOf = (n, len) => n - (n % blockSize(len));
const cidr = (net, len) => `${n2ip(net)}/${len}`;
const bin32 = (s) => s.split('.').map((x) => Number(x).toString(2).padStart(8, '0')).join('');
const binToIp = (b) => [0, 8, 16, 24].map((i) => parseInt(b.slice(i, i + 8), 2)).join('.');
const numField = (name, label, value, hint) => ({ name, label, format: 'number', hint, accept: [String(value)] });
const textQ = (fields) => ({ answerKind: 'text', fields });
const list = (xs) => xs.join('・');
const gen = (title, kindName, make, verify) => ({ title, kind: '生', minDistinct: 1000, make(rng) { return { ...make(rng), kind: kindName }; }, verify });
// 4 択(正解 1 つ + 誤答)。正解の位置を返す
function choice4(rng, correct, wrongs) {
  const set = new Set([correct]);
  for (const w of rng.shuffle(wrongs)) { if (set.size >= 4) break; if (w !== correct) set.add(w); }
  const options = rng.shuffle([...set]);
  return { options, answerIndex: options.indexOf(correct) };
}

// ================= Lv320 拠点ごとの IPv4 計画 =================
const SITE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const PARENTS = [() => [ip2n('10.0.0.0'), 8], () => [ip2n('172.16.0.0'), 12], () => [ip2n('192.168.0.0'), 16]];
function parentNet(rng, L) {
  for (;;) {
    const [pn, pl] = rng.pick(PARENTS)();
    if (pl > L) continue;
    const off = rng.rand(0, 2 ** (L - pl) - 1) * blockSize(L);
    return [pn + off, L];
  }
}
// 台数 → 2 の累乗の大きさ(網とブロードキャストを足した台数が入るいちばん小さいもの)
const sizeFor = (hosts) => { let s = 4; while (s - 2 < hosts) s *= 2; return s; };
const lenOf = (size) => 32 - Math.log2(size);
// prefixplan の正規形(normalize.js の prefixplan と同じ: 行を並べ替えて改行でつなぐ。名前は小文字)
const planAccept = (rows) => rows.map(([name, c]) => `${name.toLowerCase()} ${c}`).sort().join('\n');
function ipv4PlanQ(rng) {
  const equal = rng.next() < 0.5;
  let sites, pnet, plen, intro;
  if (equal) {
    const n = rng.pick([2, 4, 4, 8]);
    plen = rng.pick([16, 16, 18, 20, 22, 24]);
    [pnet] = parentNet(rng, plen);
    const sl = plen + Math.log2(n);
    sites = SITE_NAMES.slice(0, n).map((name, i) => ({ name, net: pnet + i * blockSize(sl), len: sl }));
    intro = `${cidr(pnet, plen)} を ${n} 拠点(${list(sites.map((s) => `拠点 ${s.name}`))})に同じ大きさで分け、拠点 A から順に先頭から並べる(あとでまとめて 1 つの経路に集約できる形)。`;
  } else {
    const n = rng.pick([3, 3, 4]);
    plen = rng.pick([16, 16, 20]);
    [pnet] = parentNet(rng, plen);
    // 大きさが全部違うように台数を選ぶ(大きさが同じだと並べ方が 2 通りになる)
    const lens = rng.shuffle([18, 19, 20, 21, 22, 23, 24, 25, 26].filter((l) => l > plen && l <= 26)).slice(0, n).sort((a, b) => a - b);
    const hostsOf = (l) => { const cap = blockSize(l) - 2; const lo = Math.floor(blockSize(l + 1) - 2) + 1; return rng.rand(lo, cap); }; // その大きさがちょうど要る台数
    const named = rng.shuffle(SITE_NAMES.slice(0, n));
    const spec = lens.map((l, i) => ({ name: named[i], hosts: hostsOf(l), size: blockSize(l) }));
    let cur = pnet;
    for (const s of spec) { s.net = cur; s.len = lenOf(s.size); cur += s.size; } // lens は昇順 = 大きさは降順
    sites = spec.slice().sort((a, b) => SITE_NAMES.indexOf(a.name) - SITE_NAMES.indexOf(b.name));
    intro = `${cidr(pnet, plen)} を ${n} 拠点に分ける。各拠点の大きさは、台数に網のアドレスとブロードキャストを足した数が入る、いちばん小さい 2 の累乗にする。台数の多い拠点から順に、親の網の先頭から詰めて並べる(集約できる形)。各拠点の台数は表のとおり。`;
  }
  const table = equal ? null : { headers: ['拠点', '台数'], rows: sites.map((s) => [`拠点 ${s.name}`, String(s.hosts)]) };
  const order = sites.slice().sort((a, b) => a.net - b.net);
  const sizeLine = equal ? '' : `大きさは ${list(order.map((s) => `拠点 ${s.name}: ${s.hosts} 台 → ${s.size}(/${s.len})`))}。大きい順に先頭から並べると、`;
  const layout = list(order.map((s) => `拠点 ${s.name} = ${cidr(s.net, s.len)}`));
  const ask = rng.next() < 0.55 ? 'kth' : 'all';
  if (ask === 'kth') {
    const k = rng.pick(equal ? [1, 2, sites.length, rng.rand(1, sites.length)] : [1, sites.length, rng.rand(1, sites.length)]);
    const s = order[k - 1];
    return {
      text: `${intro}先頭から ${k} 番目の拠点の網を、ネットワークアドレス/プレフィックス長で答えよ。`, table,
      ...textQ([{ name: 'net', label: `${k} 番目の網`, format: 'ipv4cidr', hint: '例: 10.0.64.0/18', accept: [cidr(s.net, s.len)] }]),
      explanation: `正解は ${cidr(s.net, s.len)}(拠点 ${s.name})。${sizeLine}${layout}。${equal ? `${sites.length} 等分なので 1 拠点は /${s.len}(${blockSize(s.len)} アドレス)で、${k} 番目は先頭から ${(k - 1)} × ${blockSize(s.len)} 進んだ所。` : ''}`,
      meta: { equal, ask, k, n: sites.length, plen },
    };
  }
  const rows = sites.map((s) => [s.name, cidr(s.net, s.len)]);
  return {
    text: `${intro}全部の拠点の網を書け(1 行に 1 拠点、「拠点の名前 ネットワークアドレス/プレフィックス長」の形。例: A 10.0.0.0/18。順序は問わない)。`, table,
    ...textQ([{ name: 'plan', label: '拠点ごとの網', format: 'prefixplan', hint: '例: A 10.0.0.0/18(改行で区切る)', accept: [planAccept(rows)] }]),
    explanation: `正解は ${layout}。${sizeLine}${equal ? `${sites.length} 等分なので 1 拠点は /${sites[0].len}。` : '合計は親の網に収まる。'}`,
    meta: { equal, ask, n: sites.length, plen },
  };
}
function verifyIpv4Plan(q) { // 問題文と表から 2 進の文字列で並べ直す
  const pm = /^([\d.]+)\/(\d+) を (\d+) 拠点/.exec(q.text);
  const pb = bin32(pm[1]).slice(0, Number(pm[2]));
  const n = Number(pm[3]);
  let blocks; // [name, bin, len] 先頭から
  if (q.table) {
    const spec = q.table.rows.map(([nm, h]) => { const hosts = Number(h); let bits = 2; while (2 ** bits - 2 < hosts) bits++; return { name: nm.replace('拠点 ', ''), bits }; });
    spec.sort((a, b) => b.bits - a.bits);
    if (new Set(spec.map((s) => s.bits)).size !== spec.length) throw new Error('Lv320: 同じ大きさの拠点がある');
    let cur = BigInt('0b' + pb.padEnd(32, '0'));
    blocks = spec.map((s) => { const len = 32 - s.bits; const b = cur.toString(2).padStart(32, '0'); cur += 1n << BigInt(s.bits); return [s.name, b, len]; });
    if (cur > BigInt('0b' + pb.padEnd(32, '1')) + 1n) throw new Error('Lv320: 親の網に収まらない');
  } else {
    const bits = Math.log2(n); if (!Number.isInteger(bits)) throw new Error('Lv320: 等分の数が 2 の累乗でない');
    blocks = Array.from({ length: n }, (_, i) => [SITE_NAMES[i], (pb + i.toString(2).padStart(bits, '0')).padEnd(32, '0'), pb.length + bits]);
  }
  const f = q.fields[0];
  if (f.format === 'ipv4cidr') {
    const k = Number(/先頭から (\d+) 番目/.exec(q.text)[1]);
    const [, b, len] = blocks[k - 1];
    if (f.accept[0] !== `${binToIp(b)}/${len}`) throw new Error(`Lv320: ${k} 番目が違う ${f.accept[0]}`);
  } else {
    const want = blocks.map(([nm, b, len]) => `${nm.toLowerCase()} ${binToIp(b)}/${len}`).sort().join('\n');
    if (f.accept[0] !== want) throw new Error('Lv320: 計画が違う');
  }
}

// ================= Lv321 拠点ごとの IPv6 計画 =================
const { v6Canonical } = require('../basics');
const v6Of = (big) => v6Canonical(Array.from({ length: 8 }, (_, i) => Number((big >> BigInt(112 - 16 * i)) & 0xffffn)));
function ipv6PlanQ(rng) {
  const X = rng.rand(1, 0xffff);
  const parent = (0x20010db8n << 96n) | (BigInt(X) << 80n);
  const S = rng.pick([52, 56, 56, 60]);
  const count = 2 ** (S - 48);
  const pcidr = `${v6Of(parent)}/48`;
  const t = rng.pick(['kth', 'kth', 'kth', 'which', 'count']);
  const kth = (k) => parent + (BigInt(k - 1) << BigInt(128 - S));
  const rule = `${pcidr} を /${S} ずつに切って拠点に割り当てる(1 拠点 1 つ。先頭のかたまりが 1 拠点目)。`;
  if (t === 'count') {
    return { text: `${rule}いくつの拠点に割り当てられるか。`, ...textQ([numField('count', '拠点の数', count, '例: 256')]), explanation: `正解は ${count}。/48 から /${S} までの ${S - 48} ビットが拠点の番号になるので、2 の ${S - 48} 乗 = ${count} 個。`, meta: { t, S } };
  }
  const k = rng.pick([1, 2, count, count - 1, 16, 17, 256, 257, rng.rand(1, count), rng.rand(1, count)].filter((x) => x >= 1 && x <= count));
  const net = kth(k);
  const ans = `${v6Of(net)}/${S}`;
  const how = `拠点の番号は /48 の次の ${S - 48} ビット(16 進で ${(S - 48) / 4} 桁)。${k} 拠点目はそこに ${k} − 1 = ${k - 1}(16 進 ${(k - 1).toString(16)})を入れる。`;
  if (t === 'kth') {
    return { text: `${rule}${k} 拠点目の網を、プレフィックス長付きで答えよ。`, ...textQ([{ name: 'net', label: `${k} 拠点目の網`, format: 'ipv6cidr', hint: '例: 2001:db8:1:200::/56', accept: [ans] }]), explanation: `正解は ${ans}。${how}1 拠点目が ${v6Of(kth(1))}/${S}、2 拠点目が ${v6Of(kth(2))}/${S}、…、最後(${count} 拠点目)が ${v6Of(kth(count))}/${S}。`, meta: { t, S, k, edge: k <= 2 || k >= count - 1 } };
  }
  return { text: `${rule}${ans} は何拠点目か。`, ...textQ([numField('k', '何拠点目', k, '例: 3')]), explanation: `正解は ${k} 拠点目。${how}この網の /48 の次の ${S - 48} ビットは 16 進で ${(k - 1).toString(16)} = 10 進 ${k - 1} なので、${k - 1} + 1 = ${k} 拠点目。`, meta: { t, S, k, edge: k <= 2 || k >= count - 1 } };
}
function verifyIpv6Plan(q) { // 問題文から読み直し、BigInt で別に計算する
  const m = /^(\S+)\/48 を \/(\d+) ずつ/.exec(q.text);
  const S = Number(m[2]);
  // 親の 8 グループを展開(v6Canonical と逆の作業)
  const expand = (s) => { const [h, t = ''] = s.split('::'); const hg = h ? h.split(':') : [], tg = t ? t.split(':') : []; const g = [...hg, ...new Array(8 - hg.length - tg.length).fill('0'), ...tg]; return g.reduce((a, x) => (a << 16n) | BigInt(parseInt(x, 16)), 0n); };
  const parent = expand(m[1]);
  if ((parent >> 96n) !== 0x20010db8n) throw new Error('Lv321: 親が 2001:db8 でない');
  const count = 1n << BigInt(S - 48);
  const f = q.fields[0];
  if (/いくつの拠点/.test(q.text)) { if (f.accept[0] !== String(count)) throw new Error('Lv321: 数が違う'); return; }
  if (/何拠点目か/.test(q.text)) {
    const net = expand(/^.*?ずつに切って拠点に割り当てる\(.*?\)。(\S+)\/\d+ は何拠点目か/.exec(q.text)[1]);
    const k = ((net - parent) >> BigInt(128 - S)) + 1n;
    if (((net - parent) % (1n << BigInt(128 - S))) !== 0n || k < 1n || k > count) throw new Error('Lv321: 網が境目に無い');
    if (f.accept[0] !== String(k)) throw new Error('Lv321: 何拠点目かが違う');
    return;
  }
  const k = BigInt(/(\d+) 拠点目の網を/.exec(q.text)[1]);
  const want = parent + ((k - 1n) << BigInt(128 - S));
  const [a, l] = f.accept[0].split('/');
  if (Number(l) !== S || expand(a) !== want) throw new Error(`Lv321: 網が違う ${f.accept[0]}`);
}

// ================= Lv334 クラウドの経路表 =================
const SUBNETS = ['A', 'B', 'C', 'D'];
const IGW = 'インターネットゲートウェイ', NATGW = 'NAT ゲートウェイ', LOCAL = '中(この仮想網の中)';
const KIND_LABEL = { public: '公開', private: '非公開', isolated: '隔離' };
function cloudSubnetQ(rng) {
  for (;;) {
    const n = rng.rand(3, 4);
    const X = rng.rand(1, 250), Y = (X % 200) + 20;
    const kinds = SUBNETS.slice(0, n).map(() => rng.pick(['public', 'private', 'private', 'isolated']));
    const subs = kinds.map((kind, i) => ({ name: `サブネット ${SUBNETS[i]}`, c: `10.${X}.${i + 1}.0/24`, kind }));
    const t = rng.pick(['public', 'inbound', 'egress', 'noEgress', 'kind']);
    let ans, ask, why;
    const pubs = subs.filter((s) => s.kind === 'public'), outs = subs.filter((s) => s.kind !== 'isolated'), iso = subs.filter((s) => s.kind === 'isolated');
    if (t === 'public' || t === 'inbound') { if (pubs.length !== 1) continue; ans = pubs[0]; ask = t === 'public' ? '公開のサブネットはどれか。' : '外(インターネット)から始める通信を受ける VM を置けるサブネットはどれか。'; }
    else if (t === 'egress') { if (outs.length !== 1) continue; ans = outs[0]; ask = '中の VM が更新を取りに外(インターネット)へ出られるサブネットはどれか。'; }
    else if (t === 'noEgress') { if (iso.length !== 1) continue; ans = iso[0]; ask = '中の VM が外(インターネット)と一切通信できないサブネットはどれか。'; }
    else { ans = rng.pick(subs); ask = `${ans.name} はどの種類か。`; }
    const tables = subs.map((s) => {
      const rows = [[`10.${X}.0.0/16`, LOCAL]];
      if (s.kind === 'public') rows.push(['0.0.0.0/0', IGW]); else if (s.kind === 'private') rows.push(['0.0.0.0/0', NATGW]);
      if (rng.next() < 0.3) rows.push([`10.${Y}.0.0/16`, 'ピアリング(仮想網 B)']);
      return { title: `${s.name}(${s.c})の経路表`, headers: ['宛先', '行き先'], rows: rng.shuffle(rows) };
    });
    const desc = (s) => `${s.name} は ${s.kind === 'isolated' ? '0.0.0.0/0 の行が無いので隔離' : `0.0.0.0/0 が ${s.kind === 'public' ? IGW : NATGW} へ向くので${KIND_LABEL[s.kind]}`}`;
    why = subs.map(desc).join('。') + '。';
    const rule = 'PC クラウドの規則: 経路表の 0.0.0.0/0 がインターネットゲートウェイへ向くサブネットは公開(中の VM は外へ出られ、外から始める通信も受けられる)。NAT ゲートウェイへ向くサブネットは非公開(中の VM は外へ出られるが、外から始める通信は入れない)。0.0.0.0/0 の行が無いサブネットは隔離(外と通信しない)。';
    if (t === 'kind') {
      const { options, answerIndex } = choice4(rng, KIND_LABEL[ans.kind], Object.values(KIND_LABEL).filter((x) => x !== KIND_LABEL[ans.kind]));
      return { text: `${rule}各サブネットの経路表は次のとおり。${ask}`, tables, options, answerIndex, explanation: `正解は「${KIND_LABEL[ans.kind]}」。${why}`, meta: { t, n, kinds } };
    }
    const options = rng.shuffle(subs.map((s) => s.name));
    return { text: `${rule}各サブネットの経路表は次のとおり。${ask}`, tables, options, answerIndex: options.indexOf(ans.name), explanation: `正解は ${ans.name}。${why}`, meta: { t, n, kinds } };
  }
}
function verifyCloudSubnet(q) { // 表から種類を独立に決め直す
  const subs = q.tables.map((tb) => {
    const name = /^(サブネット [A-D])/.exec(tb.title)[1];
    const def = tb.rows.find((r) => r[0] === '0.0.0.0/0');
    const kind = !def ? 'isolated' : def[1] === IGW ? 'public' : def[1] === NATGW ? 'private' : null;
    if (!kind) throw new Error('Lv334: 0.0.0.0/0 の行き先が読めない');
    return { name, kind };
  });
  let want;
  if (/はどの種類か/.test(q.text)) { const nm = /(サブネット [A-D]) はどの種類か/.exec(q.text)[1]; want = KIND_LABEL[subs.find((s) => s.name === nm).kind]; }
  else {
    const pick = /公開のサブネットはどれか|受ける VM を置ける/.test(q.text) ? (s) => s.kind === 'public' : /更新を取りに/.test(q.text) ? (s) => s.kind !== 'isolated' : /一切通信できない/.test(q.text) ? (s) => s.kind === 'isolated' : null;
    if (!pick) throw new Error('Lv334: 問いが読めない');
    const hits = subs.filter(pick); if (hits.length !== 1) throw new Error('Lv334: 答えが 1 つでない');
    want = hits[0].name;
  }
  if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error(`Lv334: 答えが違う ${want}`);
}

// ================= Lv335 クラウドのアドレス計画 =================
const RESERVED = 5;
function cloudAddrQ(rng) {
  const t = rng.pick(['count', 'usable', 'minlen', 'minlen']);
  const X = rng.rand(1, 250);
  const rule = `PC クラウドの規則: 各サブネットでは先頭の 4 つと最後の 1 つ(計 ${RESERVED} つ)のアドレスが予約されていて VM には使えない。`;
  if (t === 'count') {
    const a = rng.rand(16, 24), b = a + rng.rand(1, Math.min(8, 28 - a));
    return { text: `仮想網 10.${X}.0.0/${a} から、/${b} のサブネットは最大でいくつ切り出せるか(全部を同じ大きさで切る)。`, ...textQ([numField('count', 'サブネットの数', 2 ** (b - a), '例: 256')]), explanation: `正解は ${2 ** (b - a)}。/${a} と /${b} の差は ${b - a} ビットなので、2 の ${b - a} 乗 = ${2 ** (b - a)} 個。`, meta: { t, bits: b - a } };
  }
  if (t === 'usable') {
    const L = rng.rand(20, 28);
    const usable = blockSize(L) - RESERVED;
    return { text: `${rule}大きさが /${L} のサブネット 1 つに、VM に使えるアドレスはいくつあるか。`, ...textQ([numField('usable', '使えるアドレスの数', usable, '例: 251')]), explanation: `正解は ${usable}。/${L} のアドレスは 2 の ${32 - L} 乗 = ${blockSize(L)} 個。そこから予約の ${RESERVED} つを引いて ${blockSize(L)} − ${RESERVED} = ${usable}。ふつうの LAN の「網とブロードキャストの 2 つを引く」とは数が違う。`, meta: { t, L } };
  }
  const base = rng.pick([16, 32, 64, 128, 256, 512, 1024, 2048]);
  const n = rng.pick([base - RESERVED, base - RESERVED, base - RESERVED + 1, base - RESERVED - 1, rng.rand(1, 2000)]);
  let L = 32; while (blockSize(L) - RESERVED < n) L--;
  const edge = n === blockSize(L) - RESERVED || n === blockSize(L + 1) - RESERVED + 1;
  return { text: `${rule}VM を ${n} 台置くサブネットに要る、いちばん長い(= いちばん小さい)プレフィックス長はいくつか。`, ...textQ([numField('len', 'プレフィックス長', L, '例: 24')]), explanation: `正解は /${L}。予約の ${RESERVED} つを足して ${n} + ${RESERVED} = ${n + RESERVED} 個のアドレスが要る。それが入る 2 の累乗は ${blockSize(L)}(2 の ${32 - L} 乗)なので /${L}。${edge ? `/${L + 1} だと ${blockSize(L + 1)} − ${RESERVED} = ${blockSize(L + 1) - RESERVED} 台までで足りない。` : ''}`, meta: { t, L, edge } };
}
function verifyCloudAddr(q) { // 問題文の数を読み直し、ループで数え直す
  const acc = Number(q.fields[0].accept[0]);
  let m;
  if ((m = /\/(\d+) から、\/(\d+) のサブネット/.exec(q.text))) { let c = 1; for (let i = Number(m[1]); i < Number(m[2]); i++) c *= 2; if (acc !== c) throw new Error('Lv335: 数が違う'); return; }
  if ((m = /大きさが \/(\d+) のサブネット 1 つに/.exec(q.text))) { if (acc !== 2 ** (32 - Number(m[1])) - RESERVED) throw new Error('Lv335: 使える数が違う'); return; }
  m = /VM を (\d+) 台置く/.exec(q.text);
  const n = Number(m[1]);
  let L = 0; for (let l = 32; l >= 0; l--) { if (2 ** (32 - l) - RESERVED >= n) { L = l; break; } }
  if (acc !== L) throw new Error(`Lv335: 長さが違う ${acc} / ${L}`);
}

// ================= Lv337 負荷分散 =================
function lbQ(rng) {
  const n = rng.rand(2, 5);
  const t = rng.pick(['rr', 'rr', 'weighted', 'skip']);
  const k = rng.pick([n, n + 1, 2 * n, rng.rand(1, 40), rng.rand(1, 40)]);
  const weights = Array.from({ length: n }, () => (t === 'weighted' ? rng.rand(1, 3) : 1));
  const down = t === 'skip' ? rng.rand(1, n) : 0;
  const rule = `負荷分散装置は ${n} 台のサーバー(1〜${n})に要求を順番に振る(1 番目の要求はサーバー 1、2 番目はサーバー 2、…、一巡したらサーバー 1 に戻る)。`
    + (t === 'weighted' ? '重み付きで、各サーバーには重みの数だけ続けて振ってから次のサーバーへ進む(重みは表のとおり)。' : '')
    + (t === 'skip' ? `サーバー ${down} は止まっていて、止まっている台は飛ばして残りの台で順番に振る(1 番目の要求は、止まっていない最初の台)。` : '');
  // 生成の側: 1 巡の並びを作って k 番目を取る
  const cycle = [];
  for (let i = 1; i <= n; i++) if (i !== down) for (let w = 0; w < weights[i - 1]; w++) cycle.push(i);
  const ans = cycle[(k - 1) % cycle.length];
  const table = t === 'weighted' ? { headers: ['サーバー', '重み'], rows: weights.map((w, i) => [`サーバー ${i + 1}`, String(w)]) } : null;
  return {
    text: `${rule}${k} 番目の要求はどのサーバーに振られるか(サーバーの番号で答える)。`, table,
    ...textQ([numField('srv', 'サーバーの番号', ans, '例: 2')]),
    explanation: `正解はサーバー ${ans}。1 巡の並びは ${cycle.join(' → ')}(${cycle.length} 要求で一巡)。${k} を ${cycle.length} で割ると${k % cycle.length === 0 ? `割り切れるので巡の最後(${cycle.length} 番目)` : `余り ${k % cycle.length} なので巡の ${k % cycle.length} 番目`}に当たり、サーバー ${ans}。`,
    meta: { t, n, k, cycleLen: cycle.length, wrap: k > cycle.length },
  };
}
function verifyLb(q) { // 1 要求ずつ模擬して k 番目を数える(余りの計算は使わない)
  const n = Number(/(\d+) 台のサーバー/.exec(q.text)[1]);
  const k = Number(/(\d+) 番目の要求はどのサーバー/.exec(q.text)[1]);
  const dm = /サーバー (\d+) は止まっていて/.exec(q.text); const down = dm ? Number(dm[1]) : 0;
  const w = Array.from({ length: n }, (_, i) => (q.table ? Number(q.table.rows.find((r) => r[0] === `サーバー ${i + 1}`)[1]) : 1));
  let srv = 1, left = w[0], got = null;
  const advance = () => { srv = (srv % n) + 1; left = w[srv - 1]; };
  for (let i = 1; i <= k; i++) {
    while (srv === down || left === 0) advance();
    if (i === k) got = srv;
    left--;
  }
  if (Number(q.fields[0].accept[0]) !== got) throw new Error(`Lv337: 台が違う ${q.fields[0].accept[0]} / ${got}`);
}

// ================= Lv338 死活監視 =================
function healthQ(rng) {
  for (;;) {
    const n = rng.rand(3, 4), W = rng.rand(5, 6);
    const outN = rng.rand(2, 3), inM = rng.rand(2, 3);
    const servers = Array.from({ length: n }, (_, i) => `SRV${i + 1}`);
    const results = servers.map(() => Array.from({ length: W }, () => (rng.next() < 0.7 ? 'OK' : 'NG')));
    // 生成の側: 連続の数を数えながら状態を追う
    const state = results.map((row) => { let inSvc = true, ng = 0, ok = 0; for (const r of row) { if (r === 'NG') { ng++; ok = 0; if (inSvc && ng >= outN) inSvc = false; } else { ok++; ng = 0; if (!inSvc && ok >= inM) inSvc = true; } } return inSvc; });
    const ins = servers.filter((_, i) => state[i]), outs = servers.filter((_, i) => !state[i]);
    const t = rng.pick(['out', 'in', 'next']);
    const rule = `負荷分散装置は各サーバーを一定の間隔で監視し、NG が連続 ${outN} 回になったら振り分け先から外し、外したサーバーは OK が連続 ${inM} 回になったら戻す。表は直近 ${W} 回の結果(左が古い)。表の左端より前は全部 OK で、全部のサーバーが振り分け先に入っていた。`;
    const table = { headers: ['サーバー', ...Array.from({ length: W }, (_, i) => `${i + 1} 回目`)], rows: servers.map((s, i) => [s, ...results[i]]) };
    let text, ans, options;
    if (t === 'out') { if (outs.length !== 1) continue; ans = outs[0]; text = `${rule}今、振り分け先から外れているサーバーはどれか。`; options = rng.shuffle(servers.slice()); }
    else if (t === 'in') { if (ins.length !== 1) continue; ans = ins[0]; text = `${rule}今、振り分け先に入っているサーバーはどれか。`; options = rng.shuffle(servers.slice()); }
    else {
      if (!ins.length || outs.length === 0) continue;
      const last = rng.pick(ins); const idx = ins.indexOf(last); ans = ins[(idx + 1) % ins.length];
      text = `${rule}要求は振り分け先に入っているサーバーに番号の順で振られ(最後まで行ったら最初に戻る)、外れているサーバーは飛ばす。直前の要求は ${last} に振られた。次の要求はどのサーバーに振られるか。`;
      options = rng.shuffle(servers.slice());
    }
    const trace = servers.map((s, i) => `${s}: ${results[i].join(' ')} → ${state[i] ? '入っている' : '外れている'}`).join('\n');
    return { text, table, options, answerIndex: options.indexOf(ans), explanation: `正解は ${ans}。\n${trace}\nNG が ${outN} 回続いた時点で外れ、そのあと OK が ${inM} 回続けば戻る(${inM} 回に満たなければ外れたまま)。` + (t === 'next' ? `入っているのは ${list(ins)} で、この順で巡るので次は ${ans}。` : ''), meta: { t, n, outN, inM, outs: outs.length } };
  }
}
function verifyHealth(q) { // 表を読み直し、状態機械を別の書き方(連続の数を正規表現で見る)で追う
  const outN = Number(/NG が連続 (\d+) 回/.exec(q.text)[1]), inM = Number(/OK が連続 (\d+) 回/.exec(q.text)[1]);
  const st = {};
  for (const r of q.table.rows) {
    const seq = r.slice(1); let inSvc = true;
    for (let i = 0; i < seq.length; i++) {
      const tail = seq.slice(0, i + 1).join(',');
      if (inSvc && new RegExp(`(?:^|,)(?:NG,){${outN - 1}}NG$`).test(tail)) inSvc = false;
      else if (!inSvc && new RegExp(`(?:^|,)(?:OK,){${inM - 1}}OK$`).test(tail)) inSvc = true;
    }
    st[r[0]] = inSvc;
  }
  const names = q.table.rows.map((r) => r[0]);
  let want;
  if (/外れているサーバーはどれか/.test(q.text)) { const o = names.filter((s) => !st[s]); if (o.length !== 1) throw new Error('Lv338: 外れが 1 台でない'); want = o[0]; }
  else if (/入っているサーバーはどれか/.test(q.text)) { const o = names.filter((s) => st[s]); if (o.length !== 1) throw new Error('Lv338: 入りが 1 台でない'); want = o[0]; }
  else { const last = /直前の要求は (SRV\d) に/.exec(q.text)[1]; const ins = names.filter((s) => st[s]); if (!st[last]) throw new Error('Lv338: 直前の台が外れている'); want = ins[(ins.indexOf(last) + 1) % ins.length]; }
  if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error(`Lv338: 答えが違う ${want}`);
}

// ================= Lv340 JSON を読む =================
const DESCS = ['to SW1', 'to R2', 'uplink', 'server farm', 'office floor 2', 'camera', 'printer', 'unused', 'to FW1', 'wifi ap'];
function jsonQ(rng) {
  const t = rng.pick(['downCount', 'downCount', 'adminUpDown', 'upCount']);
  for (;;) {
    const n = rng.rand(4, 8);
    const ifs = Array.from({ length: n }, (_, i) => {
      const admin = rng.next() < 0.8 ? 'up' : 'down';
      const oper = admin === 'down' ? 'down' : rng.next() < 0.75 ? 'up' : 'down';
      return { name: `Gi0/${i + 1}`, adminStatus: admin, operStatus: oper, speedMbps: rng.pick([100, 1000, 10000]), description: rng.pick(DESCS) };
    });
    const operDown = ifs.filter((x) => x.operStatus === 'down'), aud = ifs.filter((x) => x.adminStatus === 'up' && x.operStatus === 'down');
    if (t === 'adminUpDown' && aud.length !== 1) continue;
    const json = JSON.stringify({ device: 'SW1', interfaces: ifs }, null, 2);
    const intro = `スイッチ SW1 の状態を API で取ると、次の JSON が返った(adminStatus は設定で有効にしているか、operStatus は実際に通信できる状態か)。\n${json}\n`;
    const why = `operStatus が down なのは ${operDown.length ? list(operDown.map((x) => x.name)) : '無し'}(${operDown.length} 個)。そのうち adminStatus が up(設定では有効なのに落ちている)のは ${aud.length ? list(aud.map((x) => x.name)) : '無し'}。adminStatus が down のものは、人が止めているので障害ではない。`;
    if (t === 'downCount') return { text: `${intro}通信できない(operStatus が down)インターフェースはいくつあるか。`, ...textQ([numField('count', '数', operDown.length, '例: 2')]), explanation: `正解は ${operDown.length}。${why}`, meta: { t, n, count: operDown.length } };
    if (t === 'upCount') { const up = ifs.filter((x) => x.operStatus === 'up'); return { text: `${intro}通信できる(operStatus が up)インターフェースはいくつあるか。`, ...textQ([numField('count', '数', up.length, '例: 5')]), explanation: `正解は ${up.length}。${why}`, meta: { t, n, count: up.length } }; }
    return { text: `${intro}設定では有効(adminStatus が up)なのに通信できない(operStatus が down)インターフェースはどれか(名前で答える)。`, ...textQ([{ name: 'if', label: 'インターフェース', format: 'ifname', hint: '例: Gi0/3', accept: [aud[0].name.toLowerCase()] }]), explanation: `正解は ${aud[0].name}。${why}`, meta: { t, n, count: aud.length } };
  }
}
function verifyJson(q) { // 問題文から JSON を切り出して読み直す
  const s = q.text; const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  const ifs = j.interfaces;
  if (ifs.some((x) => x.adminStatus === 'down' && x.operStatus !== 'down')) throw new Error('Lv340: adminStatus down なのに operStatus up');
  const acc = q.fields[0].accept[0];
  if (/operStatus が down\)インターフェースはいくつ/.test(s)) { if (acc !== String(ifs.filter((x) => x.operStatus === 'down').length)) throw new Error('Lv340: down の数が違う'); }
  else if (/operStatus が up\)インターフェースはいくつ/.test(s)) { if (acc !== String(ifs.filter((x) => x.operStatus === 'up').length)) throw new Error('Lv340: up の数が違う'); }
  else { const h = ifs.filter((x) => x.adminStatus === 'up' && x.operStatus === 'down'); if (h.length !== 1 || acc !== h[0].name.toLowerCase()) throw new Error('Lv340: 名前が違う'); }
}

// ================= Lv348 ログを時刻順に =================
const LOG_DEVS = ['R1', 'SW1', 'FW1', 'SRV1'];
const LOG_EVENTS = ['Gi0/1 がダウンした', '拠点間 VPN が切れた', 'OSPF のネイバーが落ちた', 'VRRP の代表が替わった', 'ディスクの空きが少ない', 'ログインに 5 回失敗した', '設定を保存した', 'NTP の同期が外れた'];
const hms = (sec) => [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map((x) => String(x).padStart(2, '0')).join(':');
const DATE = '2026-10-25';
const fmtTime = (utcSec, kind) => (kind === 'jst' ? `${hms(utcSec + 9 * 3600)} JST` : kind === 'utc' ? `${hms(utcSec)} UTC` : `${DATE}T${hms(utcSec + 9 * 3600)}+09:00`);
function permsOf(n) { const out = []; const go = (rest, cur) => { if (!rest.length) { out.push(cur); return; } rest.forEach((x, i) => go(rest.filter((_, j) => j !== i), cur.concat(x))); }; go([...Array(n).keys()], []); return out; }
function logOrderQ(rng) {
  const n = rng.rand(3, 4);
  const devs = rng.shuffle(LOG_DEVS).slice(0, n);
  const events = rng.shuffle(LOG_EVENTS).slice(0, n);
  const kinds = rng.shuffle(['jst', 'utc', 'iso', rng.pick(['jst', 'utc', 'iso'])]).slice(0, n);
  const base = rng.rand(1, 11) * 3600 + rng.rand(0, 3599); // UTC 01:00〜11:59 → JST 10:00〜20:59(日付をまたがない)
  let secs;
  for (;;) { secs = devs.map(() => base + rng.rand(0, 900)); const s = secs.slice().sort((a, b) => a - b); if (s.every((x, i) => i === 0 || x - s[i - 1] >= 5)) break; }
  const trueOrder = [...Array(n).keys()].sort((a, b) => secs[a] - secs[b]);
  const shownOrder = [...Array(n).keys()].sort((a, b) => { const ha = fmtTime(secs[a], kinds[a]).replace(/^\d{4}-\d\d-\d\dT/, ''), hb = fmtTime(secs[b], kinds[b]).replace(/^\d{4}-\d\d-\d\dT/, ''); return ha < hb ? -1 : 1; });
  const trap = trueOrder.join() !== shownOrder.join();
  const rows = rng.shuffle(devs.map((d, i) => [d, fmtTime(secs[i], kinds[i]), events[i]]));
  const text = `${n} 台の機器のログを集めた(表)。時刻の表し方が機器ごとに違う: 「JST」は日本時間、「UTC」は協定世界時、「+09:00」付きは UTC より 9 時間進んだ時間(日本時間と同じ)。JST は UTC より 9 時間進んでいる。時計のずれは無い。`;
  const conv = devs.map((d, i) => `${d}: ${fmtTime(secs[i], kinds[i])} = ${hms(secs[i])} UTC`).join('\n');
  const name = (p) => p.map((i) => devs[i]).join(' → ');
  const tail = `\n${conv}\nUTC にそろえると ${name(trueOrder)} の順。${trap ? `表示の数字だけで並べると ${name(shownOrder)} に見えるが、表し方がそろっていないので誤り。` : ''}`;
  const variant = rng.pick(['order', 'order', 'first']);
  if (variant === 'first') {
    const options = rng.shuffle(devs.slice()); const ans = devs[trueOrder[0]];
    return { text: `${text}いちばん先に起きたのはどの機器のログか。`, table: { headers: ['機器', '時刻', '内容'], rows }, options, answerIndex: options.indexOf(ans), explanation: `正解は ${ans}。${tail}`, meta: { variant, n, trap, kinds: [...new Set(kinds)].length } };
  }
  const ans = name(trueOrder);
  const near = []; for (let i = 0; i < n - 1; i++) { const a = trueOrder.slice(); [a[i], a[i + 1]] = [a[i + 1], a[i]]; near.push(name(a)); }
  const rest = permsOf(n).map(name).filter((o) => o !== ans && !near.includes(o));
  const options = rng.shuffle([ans, ...rng.shuffle(near).concat(rng.shuffle(rest)).slice(0, 3)]);
  return { text: `${text}起きた順に並べたものはどれか。`, table: { headers: ['機器', '時刻', '内容'], rows }, options, answerIndex: options.indexOf(ans), explanation: `正解は ${ans}。${tail}`, meta: { variant, n, trap, kinds: [...new Set(kinds)].length } };
}
function verifyLogOrder(q) { // 表の時刻の文字を独立に UTC 秒へ直して並べ直す
  const toUtc = (s) => {
    let m;
    if ((m = /^(\d\d):(\d\d):(\d\d) (JST|UTC)$/.exec(s))) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) - (m[4] === 'JST' ? 9 * 3600 : 0);
    if ((m = /^\d{4}-\d\d-\d\dT(\d\d):(\d\d):(\d\d)\+09:00$/.exec(s))) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) - 9 * 3600;
    throw new Error(`Lv348: 時刻が読めない ${s}`);
  };
  const rows = q.table.rows.map((r) => ({ d: r[0], t: toUtc(r[1]) })).sort((a, b) => a.t - b.t);
  for (let i = 1; i < rows.length; i++) if (rows[i].t === rows[i - 1].t) throw new Error('Lv348: 同時刻がある');
  if (rows[0].t < 0 || rows[rows.length - 1].t >= 86400) throw new Error('Lv348: 日付をまたいでいる');
  const want = /いちばん先に起きた/.test(q.text) ? rows[0].d : rows.map((r) => r.d).join(' → ');
  if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error(`Lv348: 答えが違う ${want}`);
}

// ================= レベルの一覧 =================
const LEVELS = {
  320: gen('拠点ごとの IPv4 計画', 'cl320-ipv4-plan-v1', ipv4PlanQ, verifyIpv4Plan),
  321: gen('拠点ごとの IPv6 計画', 'cl321-ipv6-plan-v1', ipv6PlanQ, verifyIpv6Plan),
  334: gen('クラウドの経路表', 'cl334-cloud-subnet-v1', cloudSubnetQ, verifyCloudSubnet),
  335: gen('クラウドのアドレス計画', 'cl335-cloud-addr-v1', cloudAddrQ, verifyCloudAddr),
  337: gen('負荷分散', 'cl337-round-robin-v1', lbQ, verifyLb),
  338: gen('死活監視', 'cl338-health-check-v1', healthQ, verifyHealth),
  340: gen('JSON を読む', 'cl340-json-status-v1', jsonQ, verifyJson),
  348: gen('ログを時刻順に', 'cl348-log-time-order-v1', logOrderQ, verifyLogOrder),
};

module.exports = { LEVELS, _test: { sizeFor, planAccept, v6Of, RESERVED, fmtTime, hms, KIND_LABEL } };
