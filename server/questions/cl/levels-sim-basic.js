'use strict';
// 構成図・設定・模擬ターミナルの問題のうち、入門・初級の 11 項目(docs/LEVEL-LIST.md): 67 自分のアドレスを見る(入門)、149〜155 構成図(初級)、156・157 設定を書く(初級)、158 ping で確かめる(初級)。
// 担当: Claude Fable 5.1(2026-10-25)。形は docs/questions/SIM-API.md(第 2〜7 章)、書き方は CL.md。模擬は server/sim。テストは test/cl-sim-basic.js
// 入門は card(説明カード)、初級は hint(ヒントボタン)を付ける。図(diagram)は必ず付け、正解の id は図にも問題文にも入れない
// verify は生成と別の方法で解き直す: 図の note と spec を 2 進で読み直す、リンクを自分で BFS する、設定は sim.judgeConfig に正解と誤答を通す、ターミナルは実際に打って出力を読む
//
// 決めたこと:
//   - 149 は機器の名前を伏せ(ア・イ・ウ …)、記号とアドレスから読む。ほかは名前を見せる
//   - 150 の「同じ LAN の機器」はアドレスを持つ機器(PC・ルーターの IF)だけ。スイッチはアドレスが無いので数えない(問題文に書く)
//   - 151 の「ブロードキャストが届く機器」は同じ線(ドメイン)にある PC・スイッチ・ルーター全部(ルーターは受け取るが先へ流さない)。PC1 自身は除く
//   - 155 の壊し方は マスク / ゲートウェイ / 網違い の 3 つ(重複アドレスはどちらが悪いか決まらないので出さない)
//   - 158 の TTL を問うのは PC2 宛だけ(ルーター自身への ping の TTL は模擬の数え方に依るので問わない)
const sim = require('../../sim');

// ================= 共通の道具 =================
const ip2n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const n2ip = (n) => [24, 16, 8, 0].map((b) => Math.floor(n / 2 ** b) % 256).join('.');
const bin32 = (s) => s.split('.').map((x) => Number(x).toString(2).padStart(8, '0')).join('');
const netOfCidr = (cidr) => { const [a, l] = cidr.split('/'); const b = bin32(a).slice(0, Number(l)).padEnd(32, '0'); return `${n2ip(parseInt(b, 2))}/${l}`; };
const sameNet = (c1, c2) => { const [a, l1] = c1.split('/'), [b, l2] = c2.split('/'); return l1 === l2 && bin32(a).slice(0, Number(l1)) === bin32(b).slice(0, Number(l1)); };
const list = (xs) => xs.join('・');
const textQ = (fields) => ({ answerKind: 'text', fields });
const numField = (name, label, value, hint) => ({ name, label, format: 'number', hint, accept: [String(value)] });
const gen = (title, kindName, make, verify, extra = {}) => ({ title, kind: '生', minDistinct: 1000, make(rng) { return { ...make(rng), kind: kindName }; }, verify, ...extra });

// 名前 → 問題ごとの乱数 id(6 桁の 16 進。正解の情報を id に入れない)
function makeIds(rng, names) {
  const used = new Set(); const ids = {};
  for (const n of names) { let id; do { id = rng.rand(0, 0xffffff).toString(16).padStart(6, '0'); } while (used.has(id)); used.add(id); ids[n] = id; }
  return ids;
}
function specOf(rng, opts) { return sim.gen.serial(rng, opts); }
const devNames = (spec) => Object.keys(spec.devices);
// 図。idOf(名前) と、名前 → id の対応(meta 用。画面には送らない)
function figure(rng, spec, opts = {}) {
  const ids = makeIds(rng, devNames(spec));
  const diagram = sim.diagram(spec, { nodeIds: ids, showIps: opts.showIps !== false });
  return { ids, diagram, idOf: (n) => ids[n] };
}
// spec の中のアドレスを持つ端(ホストの ip、ルーターの IF)を集める: [{ dev, iface, cidr }]
function addrEnds(spec) {
  const out = [];
  for (const [name, d] of Object.entries(spec.devices)) {
    if (d.kind === 'host' || d.kind === 'server') { if (d.ip) out.push({ dev: name, iface: 'Eth0', cidr: d.ip }); }
    else for (const f of d.ifaces || []) if (f.ip) out.push({ dev: name, iface: f.name, cidr: f.ip });
  }
  return out;
}
// リンクを自分でたどる BFS(模擬の l2 を使わない)。from の機器から、ルーターを越えずに届く機器(ルーター自身は含める)
function bfsDomain(spec, from) {
  const adj = {}; for (const [a, b] of spec.links) { const da = a.split(':')[0], db = b.split(':')[0]; (adj[da] = adj[da] || []).push(db); (adj[db] = adj[db] || []).push(da); }
  const seen = new Set([from]); const q = [from];
  while (q.length) { const c = q.shift(); if (spec.devices[c].kind === 'router' && c !== from) continue; for (const n of adj[c] || []) if (!seen.has(n)) { seen.add(n); q.push(n); } }
  return seen;
}
// ドメインの数を自分で数える(ルーターの IF ごとに切った線の集まり)
function countDomains(spec) {
  const parent = {}; const find = (x) => (parent[x] === x || parent[x] === undefined ? (parent[x] = x) : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const endKey = (e) => { const [d, p] = e.split(':'); return spec.devices[d].kind === 'router' ? `${d}:${p}` : d; }; // ルーターは IF ごと、ほかは機器で 1 つ
  const keys = new Set();
  for (const [a, b] of spec.links) { const ka = endKey(a), kb = endKey(b); keys.add(ka); keys.add(kb); union(ka, kb); }
  return new Set([...keys].map(find)).size;
}
const lanOf = (spec, pc) => netOfCidr(spec.devices[pc].ip);
const routerIfOnLan = (spec, lan) => { for (const e of addrEnds(spec)) if (spec.devices[e.dev].kind === 'router' && sameNet(e.cidr, lan)) return e; return null; };

// ================= Lv67 自分のアドレスを見る(入門・模擬ターミナル) =================
const ASK67 = {
  ip: { label: 'IPv4 アドレス', format: 'ipv4', hint: '例: 192.168.1.10', text: '自分(PC1)の IPv4 アドレス' },
  gw: { label: 'デフォルトゲートウェイ', format: 'ipv4', hint: '例: 192.168.1.1', text: '自分(PC1)のデフォルトゲートウェイのアドレス' },
  len: { label: 'プレフィックス長', format: 'prefixlen', hint: '例: 24', text: '自分(PC1)のアドレスのプレフィックス長(/ のあとの数)' },
};
function myAddrQ(rng) {
  const spec = specOf(rng, { routers: 1, hostsOnLan1: rng.rand(1, 2), switches: true });
  const ask = rng.pick(['ip', 'ip', 'gw', 'len']);
  const net = sim.build(spec); const mac = net.devices.PC1.ifaces[0].mac;
  const pc = spec.devices.PC1; const [ip, len] = pc.ip.split('/');
  const answer = ask === 'ip' ? ip : ask === 'gw' ? pc.gateway : String(Number(len));
  const fig = figure(rng, spec, { showIps: false });
  const a = ASK67[ask];
  return {
    text: `あなたは PC1(MAC アドレス ${mac})を使っている。ターミナルで ipconfig と打って自分の設定を見て、${a.text}を答えよ。`,
    card: 'PC のターミナルで ipconfig(ip addr でも同じ)と打つと、自分の IPv4 アドレス、プレフィックス長(/ のあとの数)、デフォルトゲートウェイが出ます。出てきた値を答えの欄に写します。',
    diagram: fig.diagram, terminal: { devices: ['PC1'], start: 'PC1' }, sim: { spec },
    ...textQ([{ name: ask, label: a.label, format: a.format, hint: a.hint, accept: [answer] }]),
    explanation: `正解は ${answer}。ipconfig の出力の「IPv4 アドレス: ${ip}/${len}」が自分のアドレスとプレフィックス長、「デフォルトゲートウェイ: ${pc.gateway}」がゲートウェイ(ほかの網へ出るときに渡すルーター)。`,
    meta: { ask, hosts: spec.meta.hostsOnLan1 },
  };
}
function verifyMyAddr(q) { // 実際に ipconfig を打って出力から読む
  const s = sim.session(q.sim.spec, 'PC1');
  const out = sim.exec(s, 'ipconfig');
  const m = /IPv4 アドレス: ([\d.]+)\/(\d+)/.exec(out), g = /デフォルトゲートウェイ: ([\d.]+)/.exec(out);
  const want = q.meta.ask === 'ip' ? m[1] : q.meta.ask === 'gw' ? g[1] : String(Number(m[2]));
  if (q.fields[0].accept[0] !== want) throw new Error(`Lv67: 出力と答えが違う ${want}`);
  if (!q.card) throw new Error('Lv67: card が無い');
  if (q.diagram.nodes.some((n) => n.note)) throw new Error('Lv67: 図にアドレスが出ている');
}

// ================= Lv149 構成図: 機器の名前(名前を伏せて記号から読む) =================
const KANA = ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ'];
function hideNames(rng, diagram) {
  const order = rng.shuffle(diagram.nodes.map((n) => n.id));
  const label = {}; order.forEach((id, i) => { label[id] = KANA[i]; });
  return { ...diagram, nodes: diagram.nodes.map((n) => ({ ...n, name: label[n.id] })) };
}
const KIND_JA = { router: 'ルーター', switch: 'スイッチ', host: 'PC' };
function deviceNameQ(rng) {
  const spec = specOf(rng, { routers: 1, hostsOnLan1: rng.rand(1, 3), switches: true });
  const fig = figure(rng, spec);
  const dg = hideNames(rng, fig.diagram);
  const labelOf = (name) => dg.nodes.find((n) => n.id === fig.idOf(name)).name;
  const t = rng.pick(['router', 'router', 'switch-of-pc1', 'host-of-ip']);
  let ans, ask, why;
  if (t === 'router') { ans = 'R1'; ask = 'ルーター(ほかの網へ中継する機器)はどれか。'; why = `丸に矢印の記号がルーター。2 つの IF に別の網のアドレス(${spec.devices.R1.ifaces.map((f) => f.ip).join(' と ')})を持ち、2 つの網をつないでいる。四角に矢印はスイッチ、画面の形は PC。`; }
  else if (t === 'switch-of-pc1') { ans = 'SW1'; ask = `PC(アドレス ${spec.devices.PC1.ip})が線でつながっているスイッチはどれか。`; why = `その PC から出る線の先にある、四角に矢印の記号がスイッチ。スイッチはアドレスを持たないので、記号で見分ける。もう 1 つのスイッチは反対側の網にある。`; }
  else { const pcs = Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'host'); ans = rng.pick(pcs); ask = `アドレス ${spec.devices[ans].ip} を持つ機器はどれか。`; why = `そばに ${spec.devices[ans].ip} と書かれた画面の形の記号が、その PC。`; }
  const options = null;
  return {
    text: `構成図の機器の名前は伏せてある(ア・イ・ウ …)。記号とそばのアドレスから読み取る(この図の LAN は ${spec.meta.lan1}.0/24 と ${spec.meta.lan2}.0/24)。${ask}`,
    diagram: dg, answerKind: 'tap', tap: { mode: 'one' }, accept: { ids: [fig.idOf(ans)] },
    hint: '記号の形で見分ける: 丸に矢印はルーター、四角に矢印はスイッチ、画面の形は PC。アドレスは機器のそばに書いてある',
    explanation: `正解は ${labelOf(ans)}(${ans})。${why}`,
    meta: { t, labelOfAns: labelOf(ans), options },
  };
}
function verifyDeviceName(q) { // 図の kind と note から独立に決める
  const m = q.meta; const nodes = q.diagram.nodes;
  let hits;
  if (m.t === 'router') hits = nodes.filter((n) => n.kind === 'router');
  else if (m.t === 'switch-of-pc1') {
    const ip = /アドレス ([\d./]+)\)が線で/.exec(q.text)[1];
    const pc = nodes.find((n) => n.kind === 'host' && (n.note || '').split('\n')[0] === ip);
    const linked = q.diagram.links.filter((l) => l.a.node === pc.id || l.b.node === pc.id).map((l) => (l.a.node === pc.id ? l.b.node : l.a.node));
    hits = nodes.filter((n) => n.kind === 'switch' && linked.includes(n.id));
  } else { const ip = /アドレス ([\d./]+) を持つ/.exec(q.text)[1]; hits = nodes.filter((n) => (n.note || '').split('\n')[0] === ip); }
  if (hits.length !== 1 || hits[0].id !== q.accept.ids[0]) throw new Error(`Lv149: 正解が 1 つに決まらない(${hits.length})`);
  if (nodes.some((n) => /^(R|SW|PC)\d/.test(n.name))) throw new Error('Lv149: 名前が伏せられていない');
  if (q.accept.ids.some((id) => /R1|SW1|PC/.test(id))) throw new Error('Lv149: id に名前が入っている');
}

// ================= Lv150 構成図: 同じ LAN の機器 =================
function sameLanQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(2, 4), switches: true });
  const fig = figure(rng, spec);
  const side = rng.next() < 0.75 ? 'PC1' : 'PC2';
  const lan = lanOf(spec, side);
  const members = addrEnds(spec).filter((e) => e.dev !== side && sameNet(e.cidr, lan)).map((e) => e.dev);
  const ids = [...new Set(members)].map(fig.idOf);
  return {
    text: `${side}(アドレス ${spec.devices[side].ip})と同じ LAN(同じ網)にある機器を全部タップせよ。同じ網のアドレスを持つ機器(PC と、ルーターのその網の側の IF)を選ぶ。スイッチはアドレスを持たないので含めない。${side} 自身も含めない。`,
    diagram: fig.diagram, answerKind: 'tap', tap: { mode: 'many' }, accept: { ids },
    hint: `${side} のアドレスの /24 なら、先頭から 3 つの数が同じ機器が同じ網(${lan})`,
    explanation: `正解は ${list([...new Set(members)])}。${side} の網は ${lan}。この網のアドレスを持つのは ${list([...new Set(members)].map((d) => `${d}(${addrEnds(spec).find((e) => e.dev === d && sameNet(e.cidr, lan)).cidr})`))}。ルーターのもう片方の IF と反対側の PC は別の網。スイッチはアドレスが無い(どの網にも属さず、線をつないでいるだけ)。`,
    meta: { side, n: ids.length, routers: spec.meta.routers },
  };
}
function verifySameLan(q) { // 図の note を 2 進で比べて集め直す
  const side = /^(PC\d)\(アドレス ([\d./]+)\)/.exec(q.text); const cidr = side[2];
  const want = new Set();
  for (const n of q.diagram.nodes) {
    if (n.name === side[1]) continue;
    const cidrs = [...(n.note || '').split('\n'), ...(n.ports || []).map((p) => p.note || '')].map((l) => l.replace(/^Gi\S+ /, '').replace(/^GW .*/, '')).filter((x) => /\//.test(x)); // IF のアドレスはポートの note(SIM-API 第 9 章)
    if (cidrs.some((c) => sameNet(c, cidr))) want.add(n.id);
  }
  const got = new Set(q.accept.ids);
  if (want.size !== got.size || [...want].some((x) => !got.has(x))) throw new Error('Lv150: 集合が違う');
}

// ================= Lv151 構成図: 全員宛の届く範囲 =================
function bcastQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(2, 4), switches: true });
  const fig = figure(rng, spec);
  const side = rng.next() < 0.7 ? 'PC1' : 'PC2';
  const dom = [...bfsDomain(spec, side)].filter((d) => d !== side);
  const rules = 'ブロードキャスト(全員宛)はスイッチを通って同じ線(同じブロードキャストドメイン)の全部の機器に届き、ルーターで止まる(ルーターは受け取るが先へは流さない)。';
  return {
    text: `${side}(アドレス ${spec.devices[side].ip})がブロードキャストを送った。${rules}届く機器を全部タップせよ(受け取るスイッチとルーターも含める。${side} 自身は含めない)。`,
    diagram: fig.diagram, answerKind: 'tap', tap: { mode: 'many' }, accept: { ids: dom.map(fig.idOf) },
    hint: `${side} から線をたどり、ルーターに当たったらそこで止める。途中のスイッチと、同じスイッチにつながる PC が全部届く`,
    explanation: `正解は ${list(dom)}。${side} からスイッチを通って同じ線にある PC とルーターの IF まで届く。ルーターはブロードキャストを別の網へ流さないので、その先(${list(devNames(spec).filter((d) => d !== side && !dom.includes(d)))})には届かない。`,
    meta: { side, n: dom.length, routers: spec.meta.routers },
  };
}
function verifyBcast(q) { // 図のリンクを自分でたどる(kind が router なら止まる)
  const side = /^(PC\d)\(/.exec(q.text)[1];
  const nodes = q.diagram.nodes; const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const start = nodes.find((n) => n.name === side).id;
  const adj = {}; for (const l of q.diagram.links) { (adj[l.a.node] = adj[l.a.node] || []).push(l.b.node); (adj[l.b.node] = adj[l.b.node] || []).push(l.a.node); }
  const seen = new Set([start]); const qu = [start];
  while (qu.length) { const c = qu.shift(); if (byId[c].kind === 'router' && c !== start) continue; for (const n of adj[c] || []) if (!seen.has(n)) { seen.add(n); qu.push(n); } }
  seen.delete(start);
  const got = new Set(q.accept.ids);
  if (seen.size !== got.size || [...seen].some((x) => !got.has(x))) throw new Error('Lv151: 届く範囲が違う');
}

// ================= Lv152 構成図: ブロードキャストドメインの数 =================
function domainCountQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 3), hostsOnLan1: rng.rand(1, 3), switches: rng.next() < 0.7 });
  const fig = figure(rng, spec);
  const n = countDomains(spec);
  const lans = [spec.meta.lan1, spec.meta.lan2].map((l) => `${l}.0/24`);
  return {
    text: `この構成図(LAN は ${lans.join(' と ')})にブロードキャストドメイン(ブロードキャストが届く範囲)はいくつあるか。ルーターはブロードキャストを止めるので、ルーターの IF ごとに別のドメインになる。ルーターどうしをつなぐ線も 1 つのドメインと数える。スイッチはドメインを分けない。`,
    diagram: fig.diagram, ...textQ([numField('count', 'ドメインの数', n, '例: 2')]),
    hint: 'ルーターの IF(ポート)を数える。1 本の線の両端が両方ルーターなら、その線で 1 つ',
    explanation: `正解は ${n}。LAN が 2 つ(${lans.join('、')})と、ルーターどうしの線が ${spec.meta.routers - 1} 本で、合わせて ${n}。スイッチは同じドメインの中で線を増やすだけで、ドメインは分けない。`,
    meta: { routers: spec.meta.routers, n, switches: !!spec.devices.SW1 },
  };
}
function verifyDomainCount(q) { // 図のリンクから union-find で数え直す
  const byId = Object.fromEntries(q.diagram.nodes.map((n) => [n.id, n]));
  const parent = {}; const find = (x) => (parent[x] === undefined || parent[x] === x ? (parent[x] = x) : (parent[x] = find(parent[x])));
  const keys = new Set();
  for (const l of q.diagram.links) {
    const k = (e) => (byId[e.node].kind === 'router' ? `${e.node}:${e.port}` : e.node);
    const a = k(l.a), b = k(l.b); keys.add(a); keys.add(b); parent[find(a)] = find(b);
  }
  const n = new Set([...keys].map(find)).size;
  if (q.fields[0].accept[0] !== String(n)) throw new Error(`Lv152: 数が違う ${n}`);
}

// ================= Lv153 構成図: PC のいる網 =================
function hostNetQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(1, 3), switches: true });
  const fig = figure(rng, spec);
  const pcs = Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'host');
  const pc = rng.pick(pcs); const net = netOfCidr(spec.devices[pc].ip);
  return {
    text: `構成図の ${pc}(アドレス ${spec.devices[pc].ip})が属する網を、ネットワークアドレス/プレフィックス長で答えよ。`,
    diagram: fig.diagram, ...textQ([{ name: 'net', label: `${pc} の網`, format: 'ipv4cidr', hint: '例: 192.168.1.0/24', accept: [net] }]),
    hint: '/24 なら、アドレスの最後の数を 0 にしたものがネットワークアドレス',
    explanation: `正解は ${net}。${spec.devices[pc].ip} は /24 なので、先頭の 24 ビット(最初の 3 つの数)が網で、最後の数を 0 にした ${net.split('/')[0]} がネットワークアドレス。ルーターのその側の IF(${routerIfOnLan(spec, net).cidr})も同じ網にいる。`,
    meta: { pc },
  };
}
function verifyHostNet(q) {
  const m = /(PC\d)\(アドレス ([\d./]+)\)/.exec(q.text);
  if (q.fields[0].accept[0] !== netOfCidr(m[2])) throw new Error('Lv153: 網が違う');
  const node = q.diagram.nodes.find((n) => n.name === m[1]); if (!node || !(node.note || '').startsWith(m[2])) throw new Error('Lv153: 図の note と文が合わない');
}

// ================= Lv154 構成図: ゲートウェイを読む =================
function gatewayQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(1, 3), switches: true });
  const pcs = Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'host');
  const pc = rng.pick(pcs);
  spec.hidden = Object.fromEntries(pcs.map((p) => [p, ['gateway']])); // PC のゲートウェイは図から隠す(答えそのものなので)
  const fig = figure(rng, spec);
  const lan = lanOf(spec, pc); const gw = routerIfOnLan(spec, lan);
  const ans = gw.cidr.split('/')[0];
  return {
    text: `構成図の ${pc}(アドレス ${spec.devices[pc].ip})のデフォルトゲートウェイにするアドレスはどれか。ゲートウェイは、同じ網にあるルーターの IF のアドレス。`,
    diagram: fig.diagram, ...textQ([{ name: 'gw', label: 'デフォルトゲートウェイ', format: 'ipv4', hint: '例: 192.168.1.1', accept: [ans] }]),
    hint: `${pc} と同じ網(${lan})のアドレスを持つルーターの IF を探す`,
    explanation: `正解は ${ans}。${pc} の網は ${lan} で、ルーター ${gw.dev} の ${gw.iface}(${gw.cidr})が同じ網にある。ゲートウェイは自分と同じ網にあるルーターの IF でなければならない(${gw.dev} の反対側の IF は別の網なので使えない)。`,
    meta: { pc, routers: spec.meta.routers },
  };
}
function verifyGateway(q) { // 図の note から、同じ網のルーターの IF を探す
  const m = /(PC\d)\(アドレス ([\d./]+)\)/.exec(q.text);
  const cands = [];
  for (const n of q.diagram.nodes) { if (n.kind !== 'router') continue; for (const line of [...(n.note || '').split('\n'), ...(n.ports || []).map((p) => p.note || '')]) { const c = line.replace(/^Gi\S+ /, ''); if (/\//.test(c) && sameNet(c, m[2])) cands.push(c.split('/')[0]); } }
  if (cands.length !== 1 || cands[0] !== q.fields[0].accept[0]) throw new Error(`Lv154: ゲートウェイが 1 つに決まらない ${cands}`);
  for (const n of q.diagram.nodes) if (n.kind === 'host' && /GW/.test(n.note || '')) throw new Error('Lv154: 図にゲートウェイが出ている');
}

// ================= Lv155 構成図: 設定の違う PC =================
const CAUSES155 = { mask: 'プレフィックス長(マスク)', gw: 'デフォルトゲートウェイ', net: 'アドレス(網が違う)' };
function oddPcQ(rng) {
  const spec = specOf(rng, { routers: 1, hostsOnLan1: rng.rand(3, 4), switches: true });
  const pcs = Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'host' && n !== 'PC2');
  const bad = rng.pick(pcs); const d = spec.devices[bad];
  const cause = rng.pick(Object.keys(CAUSES155));
  const [ip] = d.ip.split('/'); const lan = spec.meta.lan1;
  if (cause === 'mask') d.ip = `${ip}/${rng.pick([25, 26, 23, 16])}`;
  if (cause === 'gw') { let h; do { h = rng.rand(2, 254); } while (`${lan}.${h}` === ip || pcs.some((p) => spec.devices[p].ip.startsWith(`${lan}.${h}/`))); d.gateway = `${lan}.${h}`; }
  if (cause === 'net') { const [a, b, c] = lan.split('.'); const c2 = (Number(c) + rng.pick([1, 2, 10])) % 256; d.ip = `${a}.${b}.${c2}.${ip.split('.')[3]}/24`; }
  const fig = figure(rng, spec);
  const r1 = spec.devices.R1.ifaces[0].ip;
  return {
    text: `R1 の Gi0/0(${r1})につながる LAN の PC は、R1 と同じ網のアドレス・同じプレフィックス長・ゲートウェイは R1 の Gi0/0、にそろえる決まり。構成図の PC のうち、設定が 1 台だけ決まりと違う。その PC をタップせよ(PC2 は別の網なので対象外)。`,
    diagram: fig.diagram, answerKind: 'tap', tap: { mode: 'one' }, accept: { ids: [fig.idOf(bad)] },
    hint: `R1 の Gi0/0 は ${r1}。各 PC のアドレスの網・/ のあとの数・GW をこれと見比べる`,
    explanation: `正解は ${bad}。違うのは${CAUSES155[cause]}: ${bad} は ${d.ip}、GW ${d.gateway}。R1 の Gi0/0 は ${r1} なので、${cause === 'mask' ? `プレフィックス長は /24 でなければならない` : cause === 'gw' ? `ゲートウェイは ${r1.split('/')[0]} でなければならない(${d.gateway} にルーターはいない)` : `アドレスは ${lan}.x でなければならない(${d.ip} は隣の網)`}。ほかの PC はそろっている。`,
    meta: { cause, bad },
  };
}
function verifyOddPc(q) { // 図の note と R1 の IF を読み直し、決まりに合わない PC が 1 台だけか
  const r1 = /R1 の Gi0\/0\(([\d./]+)\)/.exec(q.text)[1];
  const [gwIp, len] = r1.split('/');
  const bad = [];
  for (const n of q.diagram.nodes) {
    if (n.kind !== 'host' || n.name === 'PC2') continue;
    const [cidr, gwl] = (n.note || '').split('\n'); const gw = (gwl || '').replace('GW ', '');
    const ok = cidr.split('/')[1] === len && sameNet(cidr, r1) && gw === gwIp;
    if (!ok) bad.push(n.id);
  }
  if (bad.length !== 1 || bad[0] !== q.accept.ids[0]) throw new Error(`Lv155: 違う PC が 1 台に決まらない(${bad.length})`);
}

// ================= Lv156 設定: PC にアドレスを付ける(config) =================
function reqText(reqs, spec) {
  return reqs.map((r) => ({ id: r.id, text: r.kind === 'reach' ? `${r.from} から ${r.to}(${spec.devices[r.to].ip ? spec.devices[r.to].ip.split('/')[0] : ''})へ ping が往復で届く` : r.kind === 'state' ? r.text : r.text || r.kind }));
}
function pcConfigQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(1, 3), switches: true });
  const lan = spec.meta.lan1; const r1ip = `${lan}.1`;
  const used = new Set(Object.values(spec.devices).filter((d) => d.kind === 'host').map((d) => d.ip.split('/')[0]));
  let h; do { h = rng.rand(10, 200); } while (used.has(`${lan}.${h}`));
  const want = `${lan}.${h}`;
  spec.devices.PC1 = { kind: 'host', ttl: spec.devices.PC1.ttl }; // アドレスもゲートウェイも無い
  spec.editable = ['PC1'];
  spec.requirements = [
    { id: 1, kind: 'state', device: 'PC1', path: 'ifaces.0.ip', equals: want, text: `PC1 のアドレスを ${want}(/24)にする` },
    { id: 2, kind: 'reach', from: 'PC1', to: 'PC2', proto: 'icmp', roundTrip: true },
  ];
  const fig = figure(rng, spec);
  const net = sim.build(spec);
  const solution = [{ device: 'PC1', text: `ip address ${want}/24\ngateway ${r1ip}` }];
  return {
    text: `PC1 にはまだアドレスが無い。PC1 に設定を書いて、要件を満たせ。LAN の網は R1 の Gi0/0(${r1ip}/24)と同じ。PC の設定の書き方: 「ip address <アドレス>/<長さ>」「gateway <アドレス>」(1 行に 1 つ)。`,
    diagram: fig.diagram, answerKind: 'config', editable: ['PC1'], configView: { PC1: sim.runningConfig(net, 'PC1') },
    requirementsText: reqText(spec.requirements, spec), sim: { spec, requirements: spec.requirements }, solution,
    hint: `ip address ${want}/24 と、gateway に R1 の Gi0/0 のアドレスを書く`,
    explanation: `正解の例:\nip address ${want}/24\ngateway ${r1ip}\nアドレスは指定の ${want} に /24(R1 と同じ長さ)を付ける。PC2 は別の網なので、ゲートウェイ(同じ網にあるルーターの IF = R1 の Gi0/0)が無いと届かない。行の順は問わない。`,
    meta: { routers: spec.meta.routers, hosts: spec.meta.hostsOnLan1 },
  };
}
function verifyPcConfig(q) {
  const ok = sim.judgeConfig(q.sim.spec, q.solution);
  if (!ok.ok) throw new Error(`Lv156: 正解の例が通らない ${JSON.stringify(ok.failed)} ${JSON.stringify(ok.errors)}`);
  const [ipLine, gwLine] = q.solution[0].text.split('\n');
  if (sim.judgeConfig(q.sim.spec, [{ device: 'PC1', text: ipLine }]).ok) throw new Error('Lv156: ゲートウェイ無しで通る');
  const [, gw] = gwLine.split(' '); const parts = gw.split('.'); const other = `${parts[0]}.${parts[1]}.${parts[2]}.${(Number(parts[3]) + 100) % 250 + 2}`;
  if (sim.judgeConfig(q.sim.spec, [{ device: 'PC1', text: `${ipLine}\ngateway ${other}` }]).ok) throw new Error('Lv156: 違うゲートウェイで通る');
  if (sim.judgeConfig(q.sim.spec, [{ device: 'PC1', text: `${ipLine.replace(/\.\d+\/24$/, '.251/24')}\n${gwLine}` }]).ok) throw new Error('Lv156: 違うアドレスで通る');
  if (sim.judgeConfig(q.sim.spec, [{ device: 'R1', text: 'interface Gi0/0' }]).ok) throw new Error('Lv156: 設定できない機器で通る');
}

// ================= Lv157 設定: ルーターの IF にアドレス(config) =================
function routerIfQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(1, 2), switches: true });
  const side = rng.pick([0, 1]); // R1 のどちらの IF を空にするか
  const ifc = spec.devices.R1.ifaces[side]; const want = ifc.ip; delete ifc.ip;
  spec.editable = ['R1'];
  spec.requirements = [{ id: 1, kind: 'reach', from: 'PC1', to: 'PC2', proto: 'icmp', roundTrip: true }];
  const fig = figure(rng, spec);
  const net = sim.build(spec);
  const [wIp, wLen] = want.split('/');
  const why = side === 0 ? `PC1 側の LAN の PC はゲートウェイを ${wIp} にしているので、R1 の ${ifc.name} にそのアドレスを付ける` : spec.meta.routers === 1 ? `PC2 はゲートウェイを ${wIp} にしているので、R1 の ${ifc.name} にそのアドレスを付ける` : `R2 は ${spec.meta.lan1}.0/24 への経路の次の送り先を ${wIp} にしているので、R1 の ${ifc.name} にそのアドレス(/30)を付ける`;
  const solution = [{ device: 'R1', text: `interface ${ifc.name}\n ip address ${want}` }];
  return {
    text: `R1 の ${ifc.name} にアドレスが設定されていない(図では「未設定」)。R1 に設定を書いて、PC1 から PC2 に ping が往復で届くようにせよ。${side === 0 ? `PC1 側の PC はゲートウェイを ${wIp} にしている。` : spec.meta.routers === 1 ? `PC2 はゲートウェイを ${wIp} にしている。` : `R2 の経路表では ${spec.meta.lan1}.0/24 の次の送り先が ${wIp}(${wIp}/${wLen} の網)。`}書き方: 「interface ${ifc.name}」の次の行に「ip address <アドレス>/<長さ>」。`,
    diagram: fig.diagram, answerKind: 'config', editable: ['R1'], configView: { R1: sim.runningConfig(net, 'R1') },
    requirementsText: reqText(spec.requirements, spec), sim: { spec, requirements: spec.requirements }, solution,
    hint: `interface ${ifc.name} のあとに ip address ${wIp}/${wLen}`,
    explanation: `正解の例:\ninterface ${ifc.name}\n ip address ${want}\n${why}。ほかのアドレスにすると、相手(PC のゲートウェイや隣のルーターの経路)が指している番地に機器がいなくなり、届かない。`,
    meta: { side, routers: spec.meta.routers },
  };
}
function verifyRouterIf(q) {
  const ok = sim.judgeConfig(q.sim.spec, q.solution);
  if (!ok.ok) throw new Error(`Lv157: 正解の例が通らない ${JSON.stringify(ok.failed)} ${JSON.stringify(ok.errors)}`);
  if (sim.judgeConfig(q.sim.spec, []).ok) throw new Error('Lv157: 何もしなくても通る');
  const m = /ip address ([\d.]+)\/(\d+)/.exec(q.solution[0].text); const p = m[1].split('.');
  const other = `${p[0]}.${p[1]}.${p[2]}.${Number(p[3]) + 1}/${m[2]}`;
  if (sim.judgeConfig(q.sim.spec, [{ device: 'R1', text: q.solution[0].text.replace(/ip address \S+/, `ip address ${other}`) }]).ok) throw new Error('Lv157: 違うアドレスで通る');
  const net = sim.build(q.sim.spec); const ifc = net.devices.R1.ifaces[q.meta.side]; if (ifc.ip) throw new Error('Lv157: IF にアドレスが残っている');
  if (!q.configView.R1.some((l) => /^interface/.test(l))) throw new Error('Lv157: configView が無い');
}

// ================= Lv158 確かめる: ping(模擬ターミナル) =================
const BREAKS158 = ['none', 'none', 'pc2-gw', 'r-route-back', 'pc1-gw', 'r1-route'];
function pingCheckQ(rng) {
  const spec = specOf(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(1, 2), switches: true });
  let brk = rng.pick(BREAKS158);
  if (spec.meta.routers === 1 && (brk === 'r-route-back' || brk === 'r1-route')) brk = 'pc2-gw';
  const lan1 = spec.meta.lan1, lan2 = spec.meta.lan2;
  if (brk === 'pc2-gw') spec.devices.PC2.gateway = `${lan2}.${rng.rand(200, 250)}`;
  if (brk === 'pc1-gw') spec.devices.PC1.gateway = `${lan1}.${rng.rand(200, 250)}`;
  if (brk === 'r-route-back') spec.devices.R2.routes = spec.devices.R2.routes.filter((r) => r.prefix !== `${lan1}.0/24`);
  if (brk === 'r1-route') spec.devices.R1.routes = spec.devices.R1.routes.filter((r) => r.prefix !== `${lan2}.0/24`);
  spec.hidden = Object.fromEntries(Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'host').map((n) => [n, ['gateway']])); // ゲートウェイは図に出さない(ping で確かめる)
  const fig = figure(rng, spec);
  const net = sim.build(spec);
  const pc2 = spec.devices.PC2.ip.split('/')[0], r1 = spec.devices.R1.ifaces[0].ip.split('/')[0];
  const toPc2 = sim.reach(net, 'PC1', 'PC2', { roundTrip: true }).ok;
  const toR1 = sim.reach(net, 'PC1', null, { toIp: r1, roundTrip: true }).ok;
  const t = rng.pick(toPc2 ? ['pc2', 'r1', 'ttl'] : ['pc2', 'pc2', 'r1']);
  const base = `PC1 のターミナルで ping を打って確かめる(表示の設定だけでは分からないことがある)。`;
  const common = { diagram: fig.diagram, terminal: { devices: ['PC1'], start: 'PC1' }, sim: { spec }, hint: 'ping <アドレス> と打つ。応答があれば届いている' };
  const whyNo = { 'pc2-gw': 'PC2 のゲートウェイが R の IF と違う番地なので、PC2 からの返事が出られない(行きは届くが往復しない)', 'r-route-back': `R2 に ${lan1}.0/24 への経路が無く、PC2 の返事が R2 で捨てられる`, 'pc1-gw': 'PC1 のゲートウェイが R1 の IF と違う番地で、そこに機器がいないので、ほかの網へ出られない(同じ網の R1 へは直接届く)', 'r1-route': `R1 に ${lan2}.0/24 への経路が無く、行きのパケットが R1 で捨てられる` }[brk];
  if (t === 'pc2') return { ...common, text: `${base}PC1 から PC2(${pc2})に ping は届くか(4 回とも応答が返るなら ○)。`, options: ['○', '×'], answerIndex: toPc2 ? 0 : 1, explanation: toPc2 ? `届く(○)。ping ${pc2} で 4 回とも応答が返る。` : `届かない(×)。${whyNo}。`, meta: { brk, t, ok: toPc2 } };
  if (t === 'r1') return { ...common, text: `${base}PC1 から R1 の Gi0/0(${r1})に ping は届くか(4 回とも応答が返るなら ○)。`, options: ['○', '×'], answerIndex: toR1 ? 0 : 1, explanation: toR1 ? `届く(○)。R1 の Gi0/0 は PC1 と同じ網なので、ゲートウェイの設定に関係なく直接届く。${brk === 'pc1-gw' ? 'PC1 のゲートウェイが違っていても、同じ網の相手には届く。' : ''}` : `届かない(×)。`, meta: { brk, t, ok: toR1 } };
  const routers = spec.meta.routers; const ttl = spec.devices.PC2.ttl - routers;
  return { ...common, text: `${base}PC1 から PC2(${pc2})に ping したとき、応答に付いている TTL はいくつか。`, ...textQ([numField('ttl', 'TTL', ttl, '例: 126')]), explanation: `正解は ${ttl}。PC2 が返す応答は TTL ${spec.devices.PC2.ttl} で出て、ルーターを 1 台通るたびに 1 減る。ルーター ${routers} 台を通るので ${spec.devices.PC2.ttl} − ${routers} = ${ttl}。`, meta: { brk, t, ok: true } };
}
function verifyPingCheck(q) { // 実際に打って出力を読む
  const s = sim.session(q.sim.spec, 'PC1');
  if (q.meta.t === 'ttl') {
    const out = sim.exec(s, `ping ${/PC2\(([\d.]+)\)/.exec(q.text)[1]}`);
    const m = /TTL=(\d+)/.exec(out); if (!m || q.fields[0].accept[0] !== m[1]) throw new Error(`Lv158: TTL が出力と違う ${out}`);
    return;
  }
  const ip = q.meta.t === 'pc2' ? /PC2\(([\d.]+)\)/.exec(q.text)[1] : /Gi0\/0\(([\d.]+)\)/.exec(q.text)[1];
  const out = sim.exec(s, `ping ${ip}`);
  const ok = /4 回応答/.test(out);
  if ((ok ? 0 : 1) !== q.answerIndex) throw new Error(`Lv158: ○× が出力と違う\n${out}`);
  if (q.diagram.nodes.some((n) => n.kind === 'host' && /GW/.test(n.note || ''))) throw new Error('Lv158: 図にゲートウェイが出ている');
}

// ================= レベルの一覧 =================
const LEVELS = {
  67: gen('自分のアドレスを見る', 'cl67-ipconfig-v1', myAddrQ, verifyMyAddr),
  149: gen('構成図: 機器の名前', 'cl149-diagram-device-v1', deviceNameQ, verifyDeviceName),
  150: gen('構成図: 同じ LAN の機器', 'cl150-diagram-same-lan-v1', sameLanQ, verifySameLan),
  151: gen('構成図: 全員宛の届く範囲', 'cl151-diagram-broadcast-v1', bcastQ, verifyBcast),
  152: gen('構成図: ブロードキャストドメインの数', 'cl152-diagram-domains-v1', domainCountQ, verifyDomainCount),
  153: gen('構成図: PC のいる網', 'cl153-diagram-host-net-v1', hostNetQ, verifyHostNet),
  154: gen('構成図: ゲートウェイを読む', 'cl154-diagram-gateway-v1', gatewayQ, verifyGateway),
  155: gen('構成図: 設定の違う PC', 'cl155-diagram-odd-pc-v1', oddPcQ, verifyOddPc),
  156: gen('設定: PC にアドレスを付ける', 'cl156-config-pc-address-v1', pcConfigQ, verifyPcConfig),
  157: gen('設定: ルーターの IF にアドレス', 'cl157-config-router-if-v1', routerIfQ, verifyRouterIf),
  158: gen('確かめる: ping', 'cl158-terminal-ping-v1', pingCheckQ, verifyPingCheck),
};

module.exports = { LEVELS, _test: { bfsDomain, countDomains, sameNet, netOfCidr, addrEnds, makeIds, CAUSES155, BREAKS158 } };
