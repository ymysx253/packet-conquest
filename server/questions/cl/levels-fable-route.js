'use strict';
// Fable の分: 冗長と経路(束 A・B)。新しい番号 255・256・259・260・262・263・266・268・269・327(docs/LEVEL-LIST.md)。担当: Claude Fable 5.1(2026-10-25)。書き方は docs/questions/CL.md
// 上級(255〜269)・専門(327)はヒントなし(解説 explanation だけ)。表(FactBank)は server/questions/data/cl/fable-route/、テストは test/cl-fable-route.js
// 生成のレベルは verify で、表の文字を読み直して別の実装(並べ替え・ペアの比較・BigInt)で解き直す。meta は確かめ用(画面には送らない)
//
// ゲーム内の規則(模擬の規則の表。公開の一次資料で確かめた):
//   VRRP(RFC 5798 第 6.4 節): 代表(マスター)は優先度がいちばん高いルーター。同じなら IF のアドレスが大きい方(数として比べる)。仮想アドレスを自分の IF に持つルーター(持ち主)は優先度 255 で必ず代表
//     preempt あり = 自分より優先度の低い代表がいれば代わる(同じ優先度では代わらない)。なし = 今の代表が止まるまで代わらない。持ち主(255)は preempt の設定にかかわらず、動き出せば代表(第 6.4.1 節: 起動時にそのまま Master)
//   OSPF のネイバー(RFC 2328 第 10.5 節): エリア ID・hello 間隔・dead 間隔・同じ網とマスク(ブロードキャストの網)・認証・スタブの印(E ビット)がそろえばネイバーになる。ルーター ID は違っていなければならない。IF の帯域・プロセス番号は関係ない
//   OSPF の DR(RFC 2328 第 9.4 節): 優先度がいちばん高いルーターが DR、次が BDR。同じならルーター ID が大きい方。優先度 0 はどちらにもならない。あとから起動したルーターは、優先度が高くても今の DR・BDR を押しのけない(DR・BDR が止まるまで)
//   RSTP(IEEE 802.1D-2004 第 17 章): ポートの役割はルート・指定・代替・バックアップ、状態は破棄・学習・転送。提案と合意、代替ポートへの切り替えはタイマーを待たない
//   BGP の経路の選び方(RFC 4271 第 9.1 節): LOCAL_PREF が大きい → 自分が生成した経路 → AS パスが短い → ORIGIN(IGP < EGP < Incomplete) → MED が小さい(同じ隣の AS から来た経路どうしだけ) → eBGP を iBGP より → IGP のメトリックが小さい → ルーター ID が小さい。
//     この問題は AS パス(268)か LOCAL_PREF(269)で決まる所までしか使わない(それより後で決まる場合は作らない)
//   切り替えの時間: OSPF 風の hello/dead は、最後に hello を受け取ってから dead 間隔で落ちたと判断する(止まってから気づくまでは最長 dead、最短 dead − hello)。
//     VRRP は Master_Down_Interval = 3 × 広告間隔 + skew、skew = ((256 − 優先度) ÷ 256) × 広告間隔(RFC 5798 第 6.1 節)
const { loadFacts } = require('./build');

// ================= 共通の道具(levels-adv.js と同じ考え方。そこから require はしない) =================
const F = (file) => loadFacts(`fable-route/${file}`);
const stmtRows = (rows) => rows.filter((r) => typeof r.attrs.true === 'boolean');
const groupRows = (rows, group) => rows.filter((r) => r.attrs.group === group);
const wa = (name) => (/[A-Za-z0-9)]$/.test(name) ? `${name} は、` : `${name}は、`);
const numField = (name, label, value, hint, extra = {}) => ({ name, label, format: 'number', hint, accept: [String(value)], ...extra });
const textQ = (fields) => ({ answerKind: 'text', fields });
const ip2n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const DEV = ['R1', 'R2', 'R3', 'R4'];
const list = (xs) => xs.join('・');

// 文の 4 択: 正しいもの(または誤っているもの)を 1 つ選ぶ。正解 1 つ + 反対の文 3 つ
function stmtQ(rng, rows, subject) {
  const wantTrue = rng.next() < 0.5;
  const right = rows.filter((r) => r.attrs.true === wantTrue);
  const wrong = rows.filter((r) => r.attrs.true !== wantTrue);
  if (!right.length || wrong.length < 3) throw new Error(`${subject}: 文が足りません`);
  const ans = rng.pick(right);
  const others = rng.shuffle(wrong).slice(0, 3);
  const picked = rng.shuffle([ans, ...others]);
  const explanation = [`正解は「${ans.ja}」(${wantTrue ? '正しい文' : '誤っている文'})。${ans.attrs.why}`,
    ...others.map((r) => `「${r.ja}」は${r.attrs.true ? '正しい' : '誤り'}。${r.attrs.why}`)].join('\n');
  return { text: `${subject}について、${wantTrue ? '正しい' : '誤っている'}ものはどれか。`, options: picked.map((r) => r.ja), answerIndex: picked.indexOf(ans), explanation, meta: { type: 'stmt', wantTrue, ids: picked.map((r) => r.id) } };
}
// ○×: 文が正しいか
function tfQ(rng, rows) {
  const r = rng.pick(rows);
  return { text: `次の文は正しいか。\n「${r.ja}」`, options: ['○', '×'], answerIndex: r.attrs.true ? 0 : 1, explanation: `${r.attrs.true ? '正しい(○)' : '誤り(×)'}。${r.attrs.why}`, meta: { type: 'tf', id: r.id } };
}
// 説明 → 名前(reverse なら 名前 → 説明)。同じ group の行から選ぶ
function termQ(rng, rows, group, { only = null, reverse = false } = {}) {
  const pool = groupRows(rows, group);
  const ans = rng.pick(only ? pool.filter((r) => only.includes(r.id)) : pool);
  const others = rng.shuffle(pool.filter((r) => r !== ans)).slice(0, 3);
  if (others.length < 2) throw new Error(`${group}: 用語が足りません`);
  const picked = rng.shuffle([ans, ...others]);
  const explanation = [`正解は「${reverse ? ans.attrs.desc : ans.ja}」。${wa(ans.ja)}${ans.attrs.desc}。`, ...others.map((r) => `${wa(r.ja)}${r.attrs.desc}。`)].join('\n');
  return reverse
    ? { text: `「${ans.ja}」の説明として正しいものはどれか。`, options: picked.map((r) => r.attrs.desc), answerIndex: picked.indexOf(ans), explanation, meta: { type: 'termRev', group, ids: picked.map((r) => r.id), ans: ans.id } }
    : { text: `次の説明に当たるものはどれか。\n「${ans.attrs.desc}」`, options: picked.map((r) => r.ja), answerIndex: picked.indexOf(ans), explanation, meta: { type: 'term', group, ids: picked.map((r) => r.id), ans: ans.id } };
}
// 表のレベルの確かめ(表の行から正解が 1 つだけかを数え直す)
function verifyFacts(q, rows) {
  const m = q.meta || {};
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (m.type === 'stmt') {
    const hits = q.options.map((o) => { const r = rows.find((x) => x.ja === o); if (!r) throw new Error(`表に無い文: ${o}`); return r.attrs.true === m.wantTrue; });
    if (hits.filter(Boolean).length !== 1 || !hits[q.answerIndex]) throw new Error(`正解が 1 つに決まらない: ${q.text}`);
  } else if (m.type === 'tf') {
    const r = byId.get(m.id); if ((r.attrs.true ? 0 : 1) !== q.answerIndex) throw new Error('○× の答えが表と合わない');
  } else if (m.type === 'term' || m.type === 'termRev') {
    const pool = groupRows(rows, m.group);
    const want = byId.get(m.ans);
    const hits = q.options.map((o) => (m.type === 'term' ? pool.filter((r) => r.ja === o) : pool.filter((r) => r.attrs.desc === o)));
    if (hits.some((h) => h.length !== 1)) throw new Error('選択肢が表の 1 行に決まらない');
    if (hits.filter((h) => h[0] === want).length !== 1 || hits[q.answerIndex][0] !== want) throw new Error('正解の位置が違う');
    if (m.type === 'term' && !q.text.includes(want.attrs.desc)) throw new Error('説明が正解の行のものでない');
  }
}
function tableLevel(title, rows, kindName, types) {
  return {
    title, kind: '表', minDistinct: 20,
    make(rng) { const q = rng.pick(types)(rng); return { ...q, kind: kindName }; },
    verify(q) { verifyFacts(q, rows); },
  };
}
const gen = (title, kindName, make, verify) => ({ title, kind: '生', minDistinct: 1000, make(rng) { return { ...make(rng), kind: kindName }; }, verify });

// ================= 表のレベル =================
const RSTP = F('rstp.json');
const AREA = F('ospf-area.json');
const REDIST = F('redistribute.json');

// ================= Lv255・256 VRRP =================
const PRIOS = [80, 90, 100, 110, 120, 150, 200, 250];
// 代表を決める(生成の側)。alive は動いているルーター
function vrrpElect(alive, vip) {
  const owner = alive.find((r) => r.addr === vip);
  if (owner) return owner;
  return alive.reduce((b, r) => (!b || r.prio > b.prio || (r.prio === b.prio && ip2n(r.addr) > ip2n(b.addr)) ? r : b), null);
}
// kind: prio = 優先度で決まる / tie = 同じ優先度が並び、アドレスで決まる / owner = 仮想アドレスの持ち主(255)がいる
function vrrpSetup(rng, kind) {
  const n = rng.rand(3, 4);
  const net = rng.pick([`192.168.${rng.rand(0, 255)}`, `10.${rng.rand(0, 255)}.${rng.rand(0, 255)}`, `172.${rng.rand(16, 31)}.${rng.rand(0, 255)}`]);
  const vipHost = rng.pick([1, 254]);
  const vip = `${net}.${vipHost}`;
  const used = new Set([vipHost]);
  const host = (lo = 2, hi = 253) => { let h; do { h = rng.rand(lo, hi); } while (used.has(h)); used.add(h); return h; };
  let prios, strTrap = false;
  const hosts = new Array(n).fill(null);
  if (kind === 'tie') {
    const k = rng.rand(2, Math.min(3, n)); const top = rng.pick(PRIOS.slice(n - k)); // 下の優先度が n − k 個残る所から選ぶ
    const lows = rng.shuffle(PRIOS.filter((p) => p < top)).slice(0, n - k);
    prios = rng.shuffle([...new Array(k).fill(top), ...lows]);
    if (rng.next() < 0.5) { // 桁の違うアドレス(9 と 10 など): 文字ではなく数で比べる
      const tied = prios.map((p, i) => (p === top ? i : -1)).filter((i) => i >= 0);
      hosts[tied[0]] = host(2, 9); hosts[tied[1]] = host(10, 253); strTrap = true;
    }
  } else prios = rng.shuffle(PRIOS).slice(0, n);
  for (let i = 0; i < n; i++) if (hosts[i] === null) hosts[i] = host();
  const routers = DEV.slice(0, n).map((name, i) => ({ name, prio: prios[i], addr: `${net}.${hosts[i]}`, preempt: rng.next() < 0.5 }));
  if (kind === 'owner') { const o = rng.pick(routers); o.prio = 255; o.addr = vip; }
  const table = () => ({ headers: ['ルーター', '優先度', 'IF のアドレス', 'preempt'], rows: rng.shuffle(routers).map((r) => [r.name, String(r.prio), r.addr, r.preempt ? 'あり' : 'なし']) });
  // なぜその代表か(alive の中で)
  const why = (alive, m) => {
    if (m.addr === vip) return `${m.name} の IF のアドレスは仮想アドレス ${vip} と同じ(仮想アドレスの持ち主)なので優先度 255 で、ほかの優先度に関係なく代表になる。`;
    const top = Math.max(...alive.map((r) => r.prio)); const tied = alive.filter((r) => r.prio === top);
    if (tied.length > 1) return `優先度がいちばん高い ${top} が ${list(tied.map((r) => r.name))} で同じ。同じときは IF のアドレスが大きい方(文字ではなく数として比べる)なので、${list(tied.map((r) => `${r.name} は ${r.addr}`))} のうち ${m.name} が代表。`;
    return `優先度がいちばん高い(${m.prio})のは ${m.name}。${list(alive.filter((r) => r !== m).map((r) => `${r.name} は ${r.prio}`))}。`;
  };
  return { n, vip, routers, table, why, strTrap, elect: (alive) => vrrpElect(alive, vip) };
}
function vrrpMasterQ(rng) {
  const kind = rng.pick(['prio', 'prio', 'tie', 'owner']);
  const s = vrrpSetup(rng, kind);
  const m = s.elect(s.routers);
  const options = rng.shuffle(s.routers.map((r) => r.name));
  return {
    text: `${s.n} 台のルーターで VRRP を組んでいる(仮想アドレスは ${s.vip})。設定は表のとおりで、全員同時に起動し、全部動いている。代表(マスター)になるのはどれか。`,
    table: s.table(), options, answerIndex: options.indexOf(m.name),
    explanation: `正解は ${m.name}。${s.why(s.routers, m)}\n代表は優先度がいちばん高いルーター。同じなら IF のアドレスが大きい方。仮想アドレスを自分の IF に持つルーターは優先度 255 で必ず代表。preempt は、全員同時に起動したときの代表の決め方には関係ない。`,
    meta: { kind, strTrap: s.strTrap },
  };
}
// 確かめ用: 表の文字から並べ替えで決め直す
function parseVrrp(q) {
  const vip = /仮想アドレスは ([\d.]+)/.exec(q.text)[1];
  const rows = q.table.rows.map(([name, prio, addr, pre]) => ({ name, prio: Number(prio), addr, preempt: pre === 'あり' }));
  if (new Set(rows.map((r) => r.addr)).size !== rows.length) throw new Error('VRRP: アドレスが重複');
  return { vip, rows };
}
function electByText(rows, vip) {
  const owner = rows.filter((r) => r.addr === vip);
  if (owner.length) { if (owner.length !== 1 || owner[0].prio !== 255) throw new Error('VRRP: 持ち主の優先度が 255 でない'); return owner[0]; }
  if (rows.some((r) => r.prio === 255)) throw new Error('VRRP: 持ち主でないのに 255');
  return rows.slice().sort((a, b) => b.prio - a.prio || ip2n(b.addr) - ip2n(a.addr))[0];
}
function verifyVrrpMaster(q) {
  const { vip, rows } = parseVrrp(q);
  const m = electByText(rows, vip);
  if (q.options[q.answerIndex] !== m.name || q.options.filter((o) => o === m.name).length !== 1) throw new Error(`Lv255: 代表が違う ${m.name}`);
}
function vrrpFailoverQ(rng) {
  const ev = rng.pick(['down', 'down', 'other-down', 'return-preempt', 'return-nopreempt', 'return-owner']);
  const setupKind = ev === 'return-owner' ? 'owner' : ev.startsWith('return') ? 'prio' : rng.pick(['prio', 'tie', 'owner']);
  const s = vrrpSetup(rng, setupKind);
  const M = s.elect(s.routers);
  if (ev === 'return-preempt') M.preempt = true;
  if (ev === 'return-nopreempt' || ev === 'return-owner') M.preempt = false;
  const rest = s.routers.filter((r) => r !== M);
  const N = s.elect(rest);
  let ans, evText, why;
  if (ev === 'down') { ans = N; evText = `${M.name} が止まった。`; why = `はじめの代表は ${M.name}。${s.why(s.routers, M)}その ${M.name} が止まったので、残りの中で決め直す。${s.why(rest, N)}`; }
  else if (ev === 'other-down') { const B = rng.pick(rest); ans = M; evText = `${B.name} が止まった。`; why = `代表は ${M.name}。${s.why(s.routers, M)}止まった ${B.name} は代表ではなく、代表が動いている間はほかのルーターは代わらないので、${M.name} のまま。`; }
  else {
    evText = `${M.name} が止まり、${N.name} が代表になった。しばらくして ${M.name} が直って動き出した。`;
    if (ev === 'return-owner') { ans = M; why = `${M.name} は仮想アドレス ${s.vip} の持ち主(優先度 255)なので、preempt が「なし」でも、動き出せば代表に戻る。${N.name} は ${M.name} が止まっている間だけの代表。`; }
    else if (ev === 'return-preempt') { ans = M; why = `${M.name} は preempt が「あり」で、優先度 ${M.prio} は今の代表 ${N.name} の ${N.prio} より高いので、代表を取り戻す。`; }
    else { ans = N; why = `${M.name} は優先度 ${M.prio} で ${N.name} の ${N.prio} より高いが、preempt が「なし」なので、今の代表 ${N.name} が止まるまで代わらない。${N.name} のまま。優先度だけ見て ${M.name} と答えるのは誤り。`; }
  }
  const options = rng.shuffle(s.routers.map((r) => r.name));
  const tieAfter = ev === 'down' && rest.filter((r) => r.prio === Math.max(...rest.map((x) => x.prio))).length > 1 && N.addr !== s.vip;
  return {
    text: `${s.n} 台のルーターで VRRP を組んでいる(仮想アドレスは ${s.vip})。設定は表のとおりで、はじめは全員動いていた。preempt は、あり = 自分より優先度の低い代表がいれば代わって代表になる、なし = 今の代表が止まるまで代わらない(優先度 255 = 仮想アドレスの持ち主は、preempt にかかわらず動き出せば代表になる)。\n${evText}\nこのあと、仮想アドレス宛のパケットを受け取る(代表になる)のはどれか。`,
    table: s.table(), options, answerIndex: options.indexOf(ans.name),
    explanation: `正解は ${ans.name}。${why}`,
    meta: { ev, setupKind, tieAfter },
  };
}
// 確かめ用: 出来事を文から読み、動いているルーターの集合を追い直す
function verifyVrrpFailover(q) {
  const { vip, rows } = parseVrrp(q);
  const by = (n) => rows.find((r) => r.name === n);
  let want;
  const ret = /(R\d) が止まり、(R\d) が代表になった。しばらくして (R\d) が直って動き出した。/.exec(q.text);
  if (ret) {
    const M = by(ret[1]); const alive = rows.filter((r) => r !== M);
    const N = electByText(alive, vip);
    if (N.name !== ret[2]) throw new Error('Lv256: 止まったあとの代表が文と合わない');
    if (M.addr === vip) want = M;
    else if (M.preempt && M.prio > N.prio) want = M;
    else want = N;
  } else {
    const d = /\n(R\d) が止まった。/.exec(q.text); if (!d) throw new Error('Lv256: 出来事が読めない');
    want = electByText(rows.filter((r) => r.name !== d[1]), vip);
  }
  if (q.options[q.answerIndex] !== want.name || q.options.filter((o) => o === want.name).length !== 1) throw new Error(`Lv256: 代表が違う ${want.name}`);
}

// ================= Lv260 OSPF のネイバー =================
const OSPF_ITEMS = ['ルーター ID', 'エリア ID', 'hello 間隔(秒)', 'dead 間隔(秒)', 'IF のアドレス/マスク', '認証', 'エリアの種類', 'IF の帯域', 'プロセス番号'];
const OSPF_RELEVANT = new Set(['エリア ID', 'hello 間隔(秒)', 'dead 間隔(秒)', 'IF のアドレス/マスク', '認証', 'エリアの種類']);
const MISMATCH = ['area', 'hello', 'dead', 'net', 'mask', 'auth', 'stub'];
const ITEM_OF = { area: 'エリア ID', hello: 'hello 間隔(秒)', dead: 'dead 間隔(秒)', net: 'IF のアドレス/マスク', mask: 'IF のアドレス/マスク', auth: '認証', stub: 'エリアの種類' };
function ospfPair(rng, mis) {
  const area = rng.pick([0, 0, 1, 2, 10]);
  const hello = rng.pick([5, 10, 10, 30]); const dead = hello * rng.pick([3, 4, 4]);
  const X = rng.rand(0, 255), Y = rng.rand(0, 254);
  const h1 = rng.rand(1, 100), h2 = h1 + rng.rand(1, 20);
  const key = `pc-key${rng.rand(1, 9)}`;
  const auth = rng.next() < 0.5 ? 'なし' : `パスワード ${key}`;
  const stub = rng.next() < 0.3 ? 'スタブ' : 'ふつう';
  const v = {
    'ルーター ID': [`10.255.255.${rng.rand(1, 100)}`, `10.255.255.${rng.rand(101, 250)}`],
    'エリア ID': [String(area), String(mis === 'area' ? (area === 0 ? rng.pick([1, 2]) : 0) : area)],
    'hello 間隔(秒)': [String(hello), String(mis === 'hello' ? (hello === 10 ? rng.pick([5, 30]) : 10) : hello)],
    'dead 間隔(秒)': [String(dead), String(mis === 'dead' ? dead * rng.pick([2, 3]) : dead)],
    'IF のアドレス/マスク': [`10.${X}.${Y}.${h1}/24`, mis === 'net' ? `10.${X}.${Y + 1}.${h2}/24` : mis === 'mask' ? `10.${X}.${Y}.${h2}/25` : `10.${X}.${Y}.${h2}/24`],
    '認証': [auth, mis === 'auth' ? (auth === 'なし' ? `パスワード ${key}` : rng.next() < 0.5 ? 'なし' : `パスワード pc-key${(Number(key.slice(-1)) % 9) + 1}`) : auth],
    'エリアの種類': [stub, mis === 'stub' ? (stub === 'スタブ' ? 'ふつう' : 'スタブ') : stub],
    'IF の帯域': [rng.pick(['100 Mbps', '1 Gbps']), rng.pick(['100 Mbps', '1 Gbps', '10 Gbps'])],
    'プロセス番号': [String(rng.pick([1, 10])), String(rng.pick([1, 10, 100]))],
  };
  return v;
}
const MIS_WHY = {
  area: (v) => `エリア ID が R1 は ${v['エリア ID'][0]}、R2 は ${v['エリア ID'][1]} で違う。hello に載るエリア ID が合わないと捨てられる。`,
  hello: (v) => `hello 間隔が R1 は ${v['hello 間隔(秒)'][0]} 秒、R2 は ${v['hello 間隔(秒)'][1]} 秒で違う。hello と dead の間隔は両方そろえる。`,
  dead: (v) => `dead 間隔が R1 は ${v['dead 間隔(秒)'][0]} 秒、R2 は ${v['dead 間隔(秒)'][1]} 秒で違う。hello と dead の間隔は両方そろえる。`,
  net: (v) => `R1 は ${v['IF のアドレス/マスク'][0]}、R2 は ${v['IF のアドレス/マスク'][1]} で、同じ網にいない(ブロードキャストの網では同じ網とマスクが要る)。`,
  mask: (v) => `R1 は ${v['IF のアドレス/マスク'][0]}、R2 は ${v['IF のアドレス/マスク'][1]} で、マスクが違う(hello に載せるマスクが合わない)。アドレスは近くても、マスクが違えばネイバーにならない。`,
  auth: (v) => `認証が R1 は「${v['認証'][0]}」、R2 は「${v['認証'][1]}」で合わない。認証の種類と鍵の両方をそろえる。`,
  stub: (v) => `エリアの種類が R1 は「${v['エリアの種類'][0]}」、R2 は「${v['エリアの種類'][1]}」で違う。hello のスタブの印(E ビット)が合わないルーターはネイバーにならない。`,
};
const OSPF_RULE = 'ネイバーになる条件は、エリア ID・hello と dead の間隔・同じ網とマスク・認証・エリアの種類(スタブの印)がそろうこと。ルーター ID は逆に違っていなければならず、IF の帯域とプロセス番号は関係ない。';
function ospfNeighborQ(rng) {
  const variant = rng.next() < 0.45 ? 'tf' : 'why';
  const mis = variant === 'tf' && rng.next() < 0.5 ? null : rng.pick(MISMATCH);
  const v = ospfPair(rng, mis);
  const table = { headers: ['項目', 'R1', 'R2'], rows: OSPF_ITEMS.map((k) => [k, v[k][0], v[k][1]]) };
  const intro = '同じ線(ブロードキャストの網)でつながる R1 と R2 の OSPF の設定は表のとおり。';
  const irrelevantDiff = OSPF_ITEMS.filter((k) => !OSPF_RELEVANT.has(k) && v[k][0] !== v[k][1]);
  const irrNote = `違っていても関係ない項目: ${list(irrelevantDiff)}(ルーター ID は違っていなければならない)。`;
  if (variant === 'tf') {
    return {
      text: `${intro}2 台はネイバー(隣接)になるか。`, table, options: ['○', '×'], answerIndex: mis ? 1 : 0,
      explanation: mis ? `ならない(×)。${MIS_WHY[mis](v)}${irrNote}\n${OSPF_RULE}` : `なる(○)。そろえる必要のある項目はすべて同じ。${irrNote}\n${OSPF_RULE}`,
      meta: { variant, mis },
    };
  }
  const ansItem = ITEM_OF[mis];
  const cands = [...rng.shuffle(irrelevantDiff), ...rng.shuffle(OSPF_ITEMS.filter((k) => k !== ansItem && !irrelevantDiff.includes(k)))];
  const options = rng.shuffle([ansItem, ...cands.slice(0, 3)]);
  return {
    text: `${intro}2 台はネイバー(隣接)にならない。原因になっている項目はどれか。`, table, options, answerIndex: options.indexOf(ansItem),
    explanation: `正解は「${ansItem}」。${MIS_WHY[mis](v)}${irrNote}\n${OSPF_RULE}`,
    meta: { variant, mis },
  };
}
// 確かめ用: 表の文字から、そろえる項目の食い違いを数え直す
function verifyOspfNeighbor(q) {
  const v = Object.fromEntries(q.table.rows.map(([k, a, b]) => [k, [a, b]]));
  const bad = [];
  for (const k of OSPF_RELEVANT) {
    const [a, b] = v[k];
    if (k === 'IF のアドレス/マスク') {
      const [a1, l1] = a.split('/'), [b1, l2] = b.split('/');
      const net = (ip, l) => Math.floor(ip2n(ip) / 2 ** (32 - Number(l)));
      if (l1 !== l2 || net(a1, l1) !== net(b1, l2)) bad.push(k);
    } else if (a !== b) bad.push(k);
  }
  if (v['ルーター ID'][0] === v['ルーター ID'][1]) throw new Error('Lv260: ルーター ID が同じ');
  if (q.meta.variant === 'tf') { if (q.answerIndex !== (bad.length ? 1 : 0) || bad.length > 1) throw new Error(`Lv260: ○× が違う ${bad}`); return; }
  if (bad.length !== 1 || q.options[q.answerIndex] !== bad[0] || q.options.filter((o) => o === bad[0]).length !== 1) throw new Error(`Lv260: 原因が 1 つに決まらない ${bad}`);
}

// ================= Lv262 DR の選び方 =================
const DR_PRIOS = [1, 5, 10, 50, 100, 200];
function drQ(rng) {
  const n = rng.rand(3, 4);
  const late = rng.next() < 0.4;
  const m = late ? n - 1 : n; // 同時に起動する台数
  let kind = rng.pick(['prio', 'prio', 'tie', 'p0']);
  if (kind === 'p0' && m < 3) kind = 'prio';
  let prios;
  if (kind === 'tie') { const top = rng.pick([1, 10, 100]); const k = rng.rand(2, m); prios = rng.shuffle([...new Array(k).fill(top), ...rng.shuffle(DR_PRIOS.filter((p) => p < top)).slice(0, m - k)]); if (prios.length < m) prios = [...prios, ...new Array(m - prios.length).fill(top)]; }
  else if (kind === 'p0') { prios = rng.shuffle([0, ...rng.shuffle(DR_PRIOS).slice(0, m - 1)]); }
  else prios = rng.shuffle(DR_PRIOS).slice(0, m);
  const top = Math.max(...prios);
  if (late) prios.push(Math.min(255, top + rng.pick([1, 50, 100])));
  const third = rng.rand(0, 255);
  const strTrap = rng.next() < 0.4;
  const hostPool = strTrap ? rng.shuffle([2, 3, 5, 7, 9]).slice(0, 1).concat(rng.shuffle([10, 20, 30, 100, 200, 250])) : rng.shuffle([2, 3, 5, 7, 9, 10, 20, 30, 100, 200, 250]);
  const routers = DEV.slice(0, n).map((name, i) => ({ name, prio: prios[i], rid: `10.255.${third}.${hostPool[i]}`, late: late && i === n - 1 }));
  const initial = routers.filter((r) => !r.late);
  const elig = initial.filter((r) => r.prio > 0).sort((a, b) => b.prio - a.prio || ip2n(b.rid) - ip2n(a.rid));
  const role = rng.pick(['DR', 'BDR']);
  const ans = role === 'DR' ? elig[0] : elig[1];
  const options = rng.shuffle(routers.map((r) => r.name));
  const tiedTop = initial.filter((r) => r.prio === elig[0].prio);
  const lateR = routers.find((r) => r.late);
  const why = [
    `同時に起動した ${list(initial.map((r) => `${r.name}(優先度 ${r.prio})`))} の中で、優先度 0 のルーターを除き、優先度が高い順に DR・BDR になる。`,
    tiedTop.length > 1 ? `優先度 ${elig[0].prio} が ${list(tiedTop.map((r) => r.name))} で同じなので、ルーター ID が大きい方(数として比べる)が先: ${list(tiedTop.map((r) => `${r.name} は ${r.rid}`))}。` : '',
    `DR は ${elig[0].name}、BDR は ${elig[1].name}。`,
    initial.some((r) => r.prio === 0) ? `優先度 0 の ${list(initial.filter((r) => r.prio === 0).map((r) => r.name))} は DR にも BDR にもならない。` : '',
    lateR ? `あとから起動した ${lateR.name} は優先度 ${lateR.prio} でいちばん高いが、決まっている DR・BDR を押しのけない(DR か BDR が止まるまで、ほかのルーター(DROther)のまま)。` : '',
  ].filter(Boolean).join('');
  return {
    text: `同じ線(ブロードキャストの網)に ${n} 台のルーターがつながり、OSPF の設定は表のとおり。${late ? '「同時」のルーターが先に同時に起動して DR と BDR が決まり、そのあと「あとから」のルーターが起動した。' : '全員同時に起動した。'}今の ${role} はどれか。`,
    table: { headers: ['ルーター', '優先度', 'ルーター ID', '起動'], rows: rng.shuffle(routers).map((r) => [r.name, String(r.prio), r.rid, r.late ? 'あとから' : '同時']) },
    options, answerIndex: options.indexOf(ans.name),
    explanation: `正解は ${ans.name}。${why}`,
    meta: { kind, late, role, strTrap: tiedTop.length > 1 && tiedTop.some((r) => Number(r.rid.split('.')[3]) < 10) && tiedTop.some((r) => Number(r.rid.split('.')[3]) >= 10) },
  };
}
function verifyDr(q) {
  const rows = q.table.rows.map(([name, prio, rid, boot]) => ({ name, prio: Number(prio), rid, boot }));
  const role = /今の (DR|BDR) はどれか/.exec(q.text)[1];
  const elig = rows.filter((r) => r.boot === '同時' && r.prio > 0).sort((a, b) => b.prio - a.prio || ip2n(b.rid) - ip2n(a.rid));
  if (elig.length < 2) throw new Error('Lv262: DR と BDR になれるルーターが 2 台ない');
  if (new Set(rows.map((r) => r.rid)).size !== rows.length) throw new Error('Lv262: ルーター ID が重複');
  const want = (role === 'DR' ? elig[0] : elig[1]).name;
  if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error(`Lv262: ${role} が違う ${want}`);
}

// ================= Lv268・269 BGP =================
const ORIGINS = ['IGP', 'EGP', 'Incomplete']; const ORANK = { IGP: 0, EGP: 1, Incomplete: 2 };
const RNAMES = ['経路 A', '経路 B', '経路 C', '経路 D'];
const BGP_RULE = 'BGP は、LOCAL_PREF が大きい → 自分が生成した経路 → AS パスが短い → ORIGIN(IGP < EGP < Incomplete) → MED が小さい(同じ隣の AS から来た経路どうしだけ) → eBGP を iBGP より → IGP のメトリックが小さい → ルーター ID が小さい、の順に比べ、差が出たところで決まる。';
function asPool(rng, k) { const s = new Set(); while (s.size < k) s.add(rng.rand(64512, 65534)); return [...s]; }
// 生成の側: 段ごとに絞る
function bgpDecide(rs) {
  let c = rs.map((_, i) => i);
  const top = Math.max(...c.map((i) => rs[i].lp)); c = c.filter((i) => rs[i].lp === top); if (c.length === 1) return { idx: c[0], step: 'localpref' };
  const sh = Math.min(...c.map((i) => rs[i].path.length)); c = c.filter((i) => rs[i].path.length === sh); if (c.length === 1) return { idx: c[0], step: 'aspath' };
  return null;
}
function bgpSetup(rng, mode) {
  for (;;) {
    const n = rng.rand(2, 4);
    const pool = asPool(rng, n + 9);
    const nbrs = pool.slice(0, n), tails = pool.slice(n, n + 8), myAs = pool[n + 8];
    const w = rng.rand(0, n - 1);
    const lens = new Array(n).fill(0); const lps = new Array(n).fill(0);
    if (mode === 'aspath') {
      const lp = rng.pick([100, 100, 150, 200]); lps.fill(lp);
      lens[w] = rng.rand(1, 3); for (let i = 0; i < n; i++) if (i !== w) lens[i] = lens[w] + rng.rand(1, 3);
    } else {
      lps[w] = rng.pick([150, 200, 300]); for (let i = 0; i < n; i++) if (i !== w) lps[i] = rng.pick([50, 100, 100, lps[w] - 50]);
      lens[w] = rng.rand(2, 4); for (let i = 0; i < n; i++) if (i !== w) lens[i] = rng.rand(1, 4);
      const o = rng.pick([...Array(n).keys()].filter((i) => i !== w)); lens[o] = rng.rand(1, lens[w] - 1); // 少なくとも 1 本は AS パスが短い(わな)
    }
    const rs = nbrs.map((nb, i) => ({ name: RNAMES[i], nbr: nb, lp: lps[i], path: [nb, ...rng.shuffle(tails).slice(0, lens[i] - 1)], origin: rng.pick(ORIGINS), med: rng.pick([0, 10, 20, 50, 100]) }));
    const d = bgpDecide(rs);
    if (!d || d.step !== mode || d.idx !== w) continue;
    const win = rs[w];
    const trap = mode === 'aspath'
      ? rs.some((r) => r !== win && (ORANK[r.origin] < ORANK[win.origin] || r.med < win.med))
      : rs.some((r) => r !== win && r.path.length < win.path.length);
    const pfx = rng.pick([`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `10.${rng.rand(1, 250)}.0.0/16`]);
    return { rs, win, myAs, pfx, trap };
  }
}
function bgpQ(rng, mode) {
  const s = bgpSetup(rng, mode);
  const options = rng.shuffle(s.rs.map((r) => r.name));
  const lenList = list(s.rs.map((r) => `${r.name} は ${r.path.length} 個`));
  const why = mode === 'aspath'
    ? `LOCAL_PREF は全部 ${s.win.lp} で同じで、どれも隣から受け取った経路。次に AS パスの長さを比べると ${lenList} で、いちばん短い ${s.win.name} で決まる。${s.trap ? `${s.win.name} の ORIGIN や MED がほかより悪くても、先に AS パスで決まっているので見ない。` : 'ORIGIN と MED はその後に比べる値なので見ない。'}`
    : `LOCAL_PREF がいちばん大きい(${s.win.lp})のは ${s.win.name} だけなので、最初の比べ方で決まる。AS パスは ${lenList} で ${s.win.name} より短い経路があるが、AS パスは LOCAL_PREF の後に比べる値なので見ない。`;
  return {
    text: `R1(AS ${s.myAs})は、宛先 ${s.pfx} の経路を次の表のとおり受け取った。どれも eBGP の隣から受け取ったもので、次の送り先には届く。ベンダー固有の値(weight など)は使っていない。R1 が選ぶ経路はどれか。`,
    table: { headers: ['経路', '隣の AS', 'LOCAL_PREF', 'AS パス', 'ORIGIN', 'MED'], rows: rng.shuffle(s.rs).map((r) => [r.name, String(r.nbr), String(r.lp), r.path.join(' '), r.origin, String(r.med)]) },
    options, answerIndex: options.indexOf(s.win.name),
    explanation: `正解は ${s.win.name}。${why}\n${BGP_RULE}`,
    meta: { step: mode, trap: s.trap, n: s.rs.length },
  };
}
// 確かめ用: 表の文字をペアで比べて勝ち残りを出す(段で絞る生成の側とは別の方法)
function verifyBgp(q) {
  const rs = q.table.rows.map(([name, nbr, lp, path, origin, med]) => ({ name, nbr, lp: Number(lp), len: path.split(' ').length, origin, med: Number(med) }));
  for (const r of rs) if (!(r.origin in ORANK)) throw new Error('Lv268/269: ORIGIN が読めない');
  const cmp = (a, b) => (b.lp - a.lp) || (a.len - b.len) || (ORANK[a.origin] - ORANK[b.origin]);
  const best = rs.reduce((b, r) => (cmp(r, b) < 0 ? r : b));
  if (rs.some((r) => r !== best && cmp(r, best) === 0)) throw new Error('Lv268/269: 同点で決まらない');
  if (q.options[q.answerIndex] !== best.name || q.options.filter((o) => o === best.name).length !== 1) throw new Error(`Lv268/269: 選ぶ経路が違う ${best.name}`);
  // どの段で決まったかの印を独立に確かめる
  if (q.meta.step === 'aspath') { if (new Set(rs.map((r) => r.lp)).size !== 1) throw new Error('Lv268: LOCAL_PREF がそろっていない'); if (rs.some((r) => r !== best && r.len <= best.len)) throw new Error('Lv268: AS パスで決まっていない'); }
  else if (rs.some((r) => r !== best && r.lp >= best.lp)) throw new Error('Lv269: LOCAL_PREF で決まっていない');
}

// ================= Lv327 切り替えの時間 =================
const HELLOS = [1, 2, 3, 5, 10, 30];
const VRRP_PRIOS = [32, 64, 96, 128, 160, 192, 224, 240]; // skew が短い小数で終わる優先度
const VRRP_ADV = [1, 2, 4];
// 256 分の 1 秒の整数から、割り切れる小数の文字列にする(BigInt。確かめ用にも使う)
function frac256(n) {
  const i = n / 256n, r = n % 256n;
  if (r === 0n) return String(i);
  const d = ((r * 100000000n) / 256n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${i}.${d}`;
}
function failoverQ(rng) {
  const t = rng.pick(['ospf-max', 'ospf-min', 'ospf-when', 'ospf-when', 'vrrp', 'vrrp-when', 'vrrp-when']);
  if (t.startsWith('ospf')) {
    const H = rng.pick(HELLOS); const D = H * rng.pick([3, 4]);
    const base = `R1 と R2 は OSPF のネイバーで、hello 間隔 ${H} 秒・dead 間隔 ${D} 秒。R2 は、R1 から最後に hello を受け取ってから dead 間隔がたつと、R1 が落ちたと判断する。`;
    if (t === 'ospf-max') return { text: `${base}R1 が止まってから R2 がそう判断するまでの時間は、最長で何秒か。`, ...textQ([numField('sec', '秒', D, '例: 40')]), explanation: `正解は ${D} 秒。R1 が hello を送った直後に止まると、R2 はその hello から dead 間隔 ${D} 秒待ってから落ちたと判断する。これが最長。最短は、次の hello を送る直前に止まったときの ${D} − ${H} = ${D - H} 秒。`, meta: { t } };
    if (t === 'ospf-min') return { text: `${base}R1 が止まってから R2 がそう判断するまでの時間は、最短で何秒か(R1 は hello を送る直前に止まったとする)。`, ...textQ([numField('sec', '秒', D - H, '例: 30')]), explanation: `正解は ${D - H} 秒。最後の hello は止まる ${H} 秒前に届いているので、そこから dead 間隔 ${D} 秒までの残りは ${D} − ${H} = ${D - H} 秒。hello を送った直後に止まる最長の場合は ${D} 秒。`, meta: { t } };
    const a = rng.rand(0, 300); const d = H === 1 ? 0 : rng.rand(0, H - 1);
    return { text: `${base}R2 が R1 から最後の hello を受け取ったのは時刻 ${a} 秒で、R1 は時刻 ${a + d} 秒に止まった(その後 hello は届かない)。R2 が R1 を落ちたと判断するのは時刻何秒か。`, ...textQ([numField('sec', '時刻(秒)', a + D, '例: 140')]), explanation: `正解は時刻 ${a + D} 秒。dead 間隔は最後に hello を受け取った時刻 ${a} 秒から数えるので、${a} + ${D} = ${a + D} 秒。止まった時刻 ${a + d} 秒から数えて ${a + d + D} 秒とするのは誤り(R2 には R1 がいつ止まったか分からず、最後の hello からしか数えられない)。`, meta: { t, d } };
  }
  const A = rng.pick(VRRP_ADV); const P = rng.pick(VRRP_PRIOS);
  const n = BigInt(3 * A * 256 + (256 - P) * A); const mdi = frac256(n); const skew = frac256(BigInt((256 - P) * A));
  const base = `VRRP の代表(マスター)は ${A} 秒ごとに広告を送る。バックアップ R2 の優先度は ${P}。バックアップは、代表の広告が Master_Down_Interval の間届かないと代表が止まったと判断する。Master_Down_Interval = 3 × 広告間隔 + skew、skew = ((256 − 優先度) ÷ 256) × 広告間隔。`;
  const calc = `skew = (256 − ${P}) ÷ 256 × ${A} = ${skew} 秒、Master_Down_Interval = 3 × ${A} + ${skew} = ${mdi} 秒。`;
  if (t === 'vrrp') return { text: `${base}代表が広告を送った直後に止まったとき、R2 が止まったと判断するまで何秒か。割り切れるところまで小数で答える。`, ...textQ([numField('sec', '秒', mdi, '例: 3.5', { decimal: true })]), explanation: `正解は ${mdi} 秒。${calc}優先度が高いバックアップほど skew が短く、早く気づく。`, meta: { t } };
  const a = rng.rand(0, 300);
  return { text: `${base}R2 が代表から最後の広告を受け取ったのは時刻 ${a} 秒で、その直後に代表が止まった。R2 が代表が止まったと判断するのは時刻何秒か。割り切れるところまで小数で答える。`, ...textQ([numField('sec', '時刻(秒)', frac256(BigInt(a) * 256n + n), '例: 103.5', { decimal: true })]), explanation: `正解は時刻 ${frac256(BigInt(a) * 256n + n)} 秒。${calc}最後の広告の時刻 ${a} 秒に足して ${a} + ${mdi}。`, meta: { t } };
}
function verifyFailover(q) {
  const s = q.text; const acc = q.fields[0].accept[0];
  let want;
  if (s.includes('OSPF')) {
    const H = Number(/hello 間隔 (\d+) 秒/.exec(s)[1]), D = Number(/dead 間隔 (\d+) 秒/.exec(s)[1]);
    if (/最長で何秒か/.test(s)) want = String(D);
    else if (/最短で何秒か/.test(s)) want = String(D - H);
    else { const a = Number(/最後の hello を受け取ったのは時刻 (\d+) 秒/.exec(s)[1]); const stop = Number(/時刻 (\d+) 秒に止まった/.exec(s)[1]); if (stop < a || stop >= a + H) throw new Error('Lv327: 止まった時刻が hello の間にない'); want = String(a + D); }
  } else {
    const A = BigInt(/(\d+) 秒ごとに広告/.exec(s)[1]), P = BigInt(/優先度は (\d+)/.exec(s)[1]);
    let n = 3n * A * 256n + (256n - P) * A;
    const m = /最後の広告を受け取ったのは時刻 (\d+) 秒/.exec(s); if (m) n += BigInt(m[1]) * 256n;
    want = frac256(n);
    if (Number(want) * 256 !== Number(n)) throw new Error('Lv327: 小数が割り切れていない');
  }
  if (acc !== want) throw new Error(`Lv327: 時間が違う ${acc} / ${want}`);
}

// ================= レベルの一覧 =================
const LEVELS = {
  255: gen('ゲートウェイの冗長化', 'cl255-vrrp-master-v1', vrrpMasterQ, verifyVrrpMaster),
  256: gen('切り替わったあと', 'cl256-vrrp-failover-v1', vrrpFailoverQ, verifyVrrpFailover),
  259: tableLevel('速い STP', RSTP, 'cl259-rstp-v1', [(r) => stmtQ(r, stmtRows(RSTP), 'RSTP(速い STP)'), (r) => termQ(r, RSTP, 'role'), (r) => termQ(r, RSTP, 'role', { reverse: true }), (r) => termQ(r, RSTP, 'state'), (r) => tfQ(r, stmtRows(RSTP))]),
  260: gen('OSPF のネイバー', 'cl260-ospf-neighbor-v1', ospfNeighborQ, verifyOspfNeighbor),
  262: gen('DR の選び方', 'cl262-ospf-dr-v1', drQ, verifyDr),
  263: tableLevel('エリアの種類', AREA, 'cl263-ospf-area-v1', [(r) => stmtQ(r, stmtRows(AREA), 'OSPF のエリアの種類'), (r) => termQ(r, AREA, 'area'), (r) => termQ(r, AREA, 'area', { reverse: true }), (r) => termQ(r, AREA, 'area', { only: ['t-stub', 't-totally', 't-nssa'] }), (r) => tfQ(r, stmtRows(AREA))]),
  266: tableLevel('再配送の落とし穴', REDIST, 'cl266-redistribute-v1', [(r) => stmtQ(r, stmtRows(REDIST), '経路の再配送'), (r) => stmtQ(r, stmtRows(REDIST), '経路の再配送'), (r) => termQ(r, REDIST, 'tool'), (r) => termQ(r, REDIST, 'tool', { reverse: true }), (r) => tfQ(r, stmtRows(REDIST))]),
  268: gen('AS パスで選ぶ', 'cl268-bgp-aspath-v1', (rng) => bgpQ(rng, 'aspath'), verifyBgp),
  269: gen('LOCAL_PREF で選ぶ', 'cl269-bgp-localpref-v1', (rng) => bgpQ(rng, 'localpref'), verifyBgp),
  327: gen('切り替えの時間', 'cl327-failover-time-v1', failoverQ, verifyFailover),
};

module.exports = { LEVELS, _test: { vrrpElect, electByText, bgpDecide, frac256, ORANK } };
