'use strict';
// 構成図・設定・模擬ターミナルの問題(上級)。番号 257・265・270・286・297・298・309〜319(docs/LEVEL-LIST.md)。
// 担当: Claude Fable 5.1(2026-10-25)。作り方は docs/questions/SIM-API.md(spec・要件・図・答えの形)。模擬は server/sim。テストは test/cl-sim-adv.js
// 上級はヒントなし(解説だけ)。構成は sim.gen の「そろった」spec から作り、消す・壊す(plant-then-perturb)。
// 答えの形:
//   config  … answerKind 'config'。q.sim = { spec, requirements }(送らない)、q.solution = 正解の例(送らない)、q.editable・q.configView・q.requirementsText(送る)
//   tap     … answerKind 'tap'。q.tap = { mode }、q.accept = { ids }(送らない)。図の id は問題ごとの乱数(名前は入れない)
//   terminal… q.terminal = { devices, start } + q.sim = { spec }。答えは text か choice
// verify は生成と別の方法で解き直す: config は sim.judgeConfig に正解の例を通して ok、わざと壊した設定(meta.wrongs)は不正解。
//   診断の問題(297・298・319)は「原因の機器だけを元に戻せば直り、ほかの機器を戻しても直らない」ことを sim で総当たり
//
// この問題で使うゲーム内の規則(問題文にも書く):
//   STP: ブリッジ ID = 優先度(4096 の倍数、既定 32768)+ MAC。小さい方がルートブリッジ。同じコストの線は、ルートから遠い側の 1 本が止まる
//   OSPF: 同じ網で両方が参加していれば隣。コストは出ていく IF の ospf cost(既定 1)。最短の道。再配送した静的経路は外部経路
//   静的経路の優先度(AD): 書かなければ 1。大きい方は、小さい方の経路が消えたときだけ使われる(予備)
//   NAT: 内側 IF と外側 IF を決め、内 → 外は送信元を外側 IF のアドレスに(NAPT)。ポートフォワードは外 → 内の宛先を書き換える。受信 ACL は変換前、送信 ACL は変換後
//   VRRP: 優先度が高い方が代表。同じならアドレスが大きい方。preempt は既定で有効
//   LACP: 両端が束の設定をしていて、少なくとも片方が active なら束になる(この問題では両端とも active で組む決まり)
//   DHCP スヌーピング: 信頼するポートは DHCP サーバーへ向かうポートだけ
//
// sim に足してほしいこと(2026-10-25): IPv6 の届くかの判定と表記の正規化(313 は state の文字一致で代用)、要件 kind 'lag'(束が up か。317 は state で代用)
const sim = require('../../sim');
const { LAYOUTS } = require('../../sim/diagram');
const U = sim.util;

// ================= 共通の道具 =================
const gen = (title, kindName, make, verify) => ({ title, kind: '生', minDistinct: 1000, make(rng) { return { ...make(rng), kind: kindName }; }, verify });
const hexId = (rng) => `n${rng.rand(0, 0xffffff).toString(16).padStart(6, '0')}`;
function idsFor(rng, spec) { const ids = {}; const used = new Set(); for (const n of Object.keys(spec.devices)) { let id; do { id = hexId(rng); } while (used.has(id)); used.add(id); ids[n] = id; } return ids; }
const ipOf = (cidr) => String(cidr).split('/')[0];
const list = (xs) => xs.join('・');
// その LAN(a.b.c)でまだ使われていないホスト番号を候補から選ぶ(アドレスの重複を避ける)
function freeHost(spec, lan, cands) {
  const used = new Set();
  for (const d of Object.values(spec.devices)) { if (d.ip && d.ip.startsWith(`${lan}.`)) used.add(Number(ipOf(d.ip).split('.')[3])); for (const f of d.ifaces || []) if (f.ip && f.ip.startsWith(`${lan}.`)) used.add(Number(ipOf(f.ip).split('.')[3])); }
  const h = cands.find((x) => !used.has(x)); if (h === undefined) throw new Error('空いている番地が無い'); return h;
}
const PROTO_JA = { icmp: 'ping', tcp: 'TCP', udp: 'UDP' };
// 要件の日本語(r.text があればそれ)
function reqText(r) {
  if (r.text) return r.text;
  const proto = r.proto || 'icmp'; const svc = proto === 'icmp' ? 'ping' : `${PROTO_JA[proto]} ${r.port}`;
  switch (r.kind) {
    case 'reach': return `${r.from} から ${r.to || r.toIp}(${svc})に${r.expect === false ? '届かない' : '往復で届く'}`;
    case 'route': return `${r.device} の経路表に ${r.prefix} の行が${r.proto === 'O' ? ' OSPF(O)で' : r.proto === 'C' ? '直結(C)で' : ''}ある${r.via ? `(次の相手 ${r.via})` : ''}`;
    case 'path': return `${r.from} → ${r.to} は ${r.via.join(' → ')} の順に通る`;
    case 'master': return `${r.vip} の代表(マスター)は${r.down && r.down.length ? ` ${list(r.down)} が止まったあと` : ''} ${r.device}`;
    case 'failover': return `${(r.cut || []).map((c) => `${c[0]} と ${c[1]} の線`).concat((r.down || []).map((d) => `${d}`)).join('・')}が${r.down && r.down.length && !(r.cut || []).length ? '止まった' : '切れた'}あとも、${reqText(r.then)}`;
    case 'state': return `${r.device} の ${r.path} が ${JSON.stringify(r.equals)}`;
    default: return `${r.kind}`;
  }
}
const reqTexts = (reqs) => reqs.map((r) => ({ id: r.id, text: reqText(r) }));
const cfgLines = (solution) => solution.map((s) => `${s.device}:\n${s.text.split('\n').map((l) => `  ${l}`).join('\n')}`).join('\n');
// 設定の問題を組む。spec に editable と requirements を入れ、図・今の設定の抜粋・要件の文を付ける
function configQ(rng, { text, spec, editable, requirements, solution, why, wrongs = [], showIps = true, configView = null, meta = {}, terminal = null, hideView = [] }) {
  spec.editable = editable; spec.requirements = requirements;
  const net = sim.build(spec);
  const ids = idsFor(rng, spec);
  const view = configView || Object.fromEntries(editable.map((d) => [d, sim.runningConfig(net, d, { hide: hideView })]));
  const q = {
    text, diagram: sim.diagram(spec, { nodeIds: ids, showIps }),
    answerKind: 'config', editable, configView: view, requirementsText: reqTexts(requirements),
    sim: { spec, requirements }, solution,
    explanation: `正解の例:\n${cfgLines(solution)}\n${why}\nほかの書き方でも、要件を全部満たせば正解。`,
    meta: { ...meta, wrongs },
  };
  if (terminal) q.terminal = terminal;
  return q;
}
function verifyConfig(q, label) {
  const spec = q.sim.spec;
  if (sim.judgeConfig(spec, []).ok) throw new Error(`${label}: 何も書かなくても正解になる`);
  const r = sim.judgeConfig(spec, q.solution);
  if (!r.ok) throw new Error(`${label}: 正解の例が不正解 ${JSON.stringify({ failed: r.failed, errors: r.errors, results: r.results.filter((x) => !x.ok) })}`);
  for (const w of q.meta.wrongs || []) { const rw = sim.judgeConfig(spec, w); if (rw.ok) throw new Error(`${label}: 誤りの設定が正解になる ${JSON.stringify(w)}`); }
  if (!q.diagram || !q.diagram.nodes.length) throw new Error(`${label}: 図が無い`);
  for (const n of q.diagram.nodes) if (/^(R|SW|PC|SRV|L3SW|INET|ISP|DHCP)\d*$/.test(n.id)) throw new Error(`${label}: 図の id に名前が入っている`);
  return r;
}
// 診断の問題の「原因が 1 つに決まる」確かめ: broken の各機器を good の設定に戻し、直るのが culprit だけ
function uniqueCulprit(good, broken, culprit, reqs) {
  const fixed = [];
  for (const name of Object.keys(broken.devices)) {
    const s = U.clone(broken); s.devices[name] = U.clone(good.devices[name]);
    if (sim.check(sim.build(s), reqs).every((x) => x.ok)) fixed.push(name);
  }
  if (fixed.length !== 1 || fixed[0] !== culprit) throw new Error(`原因が 1 つに決まらない: 直るのは ${fixed.join(',') || '無し'}(原因 ${culprit})`);
}
const DIAG_REQ = (pairs) => pairs.map(([a, b], i) => ({ id: i + 1, kind: 'reach', from: a, to: b, roundTrip: true }));

// ================= Lv257 STP の優先度を書く =================
function stpSpec(rng) {
  const A = sim.gen.addresses(rng); const lan = A.lan();
  const rootDefault = rng.pick(['SW2', 'SW3']);
  const macs = { SW1: 'f0', SW2: rootDefault === 'SW2' ? '10' : '20', SW3: rootDefault === 'SW3' ? '10' : '20' };
  const sw = (name, ports) => ({ kind: 'switch', ifaces: ports.map((p, i) => ({ name: p, mac: `02:00:00:${macs[name]}:0${i}:${rng.rand(16, 255).toString(16).padStart(2, '0')}` })) });
  const h1 = rng.rand(10, 99), h2 = rng.rand(100, 200);
  // PC1 は MAC の大きい方(SW1 が根になったとき、SW2–SW3 の線で止まるポートを持つ側)に置く。
  // sim の l2path は「入る側」のポートが止まっているかを見ないので、PC1 側のポートが止まる形にしないと通る順が正しく出ない(sim に足してほしいこと)
  const other = rootDefault === 'SW2' ? 'SW3' : 'SW2';
  const spec = {
    seed: rng.rand(0, 2 ** 31),
    devices: { SW1: sw('SW1', ['Gi1/0/23', 'Gi1/0/24']), SW2: sw('SW2', ['Gi1/0/1', 'Gi1/0/23', 'Gi1/0/24']), SW3: sw('SW3', ['Gi1/0/1', 'Gi1/0/23', 'Gi1/0/24']), PC1: { kind: 'host', ip: `${lan}.${h1}/24` }, PC2: { kind: 'host', ip: `${lan}.${h2}/24` } },
    links: [['PC1', `${other}:Gi1/0/1`], ['PC2', `${rootDefault}:Gi1/0/1`], ['SW1:Gi1/0/23', 'SW2:Gi1/0/23'], ['SW1:Gi1/0/24', 'SW3:Gi1/0/23'], ['SW2:Gi1/0/24', 'SW3:Gi1/0/24']],
    layout: { pos: { SW1: [500, 110], SW2: [300, 370], SW3: [700, 370], PC1: other === 'SW2' ? [110, 500] : [890, 500], PC2: rootDefault === 'SW2' ? [110, 500] : [890, 500] } },
    editable: [], requirements: [], meta: { lan, rootDefault, other },
  };
  return spec;
}
function stpQ(rng) {
  const spec = stpSpec(rng); const { rootDefault: rd, other } = spec.meta;
  const prio = rng.pick([4096, 8192, 0]);
  const requirements = [
    { id: 1, kind: 'path', from: 'PC1', to: 'PC2', via: [other, 'SW1', rd], text: `PC1 → PC2 の通信が ${other} → SW1 → ${rd} の順に通る(SW2–SW3 の線が止まる)` },
    { id: 2, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
  ];
  return configQ(rng, {
    text: `3 台のスイッチ SW1・SW2・SW3 が輪につながり、PC1(${ipOf(spec.devices.PC1.ip)})と PC2(${ipOf(spec.devices.PC2.ip)})は同じ網 ${spec.meta.lan}.0/24 にいる(図)。STP の優先度は 3 台とも既定の 32768 なので、MAC アドレスがいちばん小さい ${rd} が今のルートブリッジになり、SW1 と${rd === 'SW2' ? ' SW3' : ' SW2'} の間の線が止まっている。PC1 は ${other} に、PC2 は ${rd} につながる。ルートブリッジを SW1 にし、PC1 → PC2 の通信が ${other} → SW1 → ${rd} の順に通る(SW2 と SW3 の間の線が止まる)ようにせよ。設定できるのは SW1 だけ。\n決まり: ブリッジ ID = 優先度 + MAC アドレスで、小さい方がルートブリッジ。優先度は 0〜61440 の 4096 の倍数。同じコストの線は、ルートブリッジから遠い側の 1 本が止まる。`,
    spec, editable: ['SW1'], requirements,
    solution: [{ device: 'SW1', text: `spanning-tree priority ${prio}` }],
    why: `SW1 の優先度を既定の 32768 より小さくすれば、ブリッジ ID が 3 台の中でいちばん小さくなり SW1 がルートブリッジになる(${prio} のほか 4096 の倍数ならどれでもよい)。ルートから見て SW2 と SW3 は同じコストなので、その 2 台の間の線が止まり、PC1 → PC2 は ${other} → SW1 → ${rd} と通る。優先度を大きくする(61440 など)と逆に遠ざかる。`,
    wrongs: [[{ device: 'SW1', text: 'spanning-tree priority 61440' }], [{ device: 'SW1', text: 'spanning-tree priority 32768' }]],
    meta: { prio, rootDefault: rd },
  });
}
function verifyStp(q) { // 別の方法: 設定後の優先度 + 最小 MAC を文字で並べて根を出す
  const r = verifyConfig(q, 'Lv257');
  const st = sim.state(r.net);
  const bid = (sw) => `${String(r.net.devices[sw].stpPriority).padStart(5, '0')}.${r.net.devices[sw].ifaces.map((i) => i.mac).sort()[0]}`;
  const root = ['SW1', 'SW2', 'SW3'].sort((a, b) => (bid(a) < bid(b) ? -1 : 1))[0];
  if (root !== 'SW1' || st.stp.root !== 'SW1') throw new Error(`Lv257: 根が SW1 でない ${root}/${st.stp.root}`);
  if (sim.state(sim.build(q.sim.spec)).stp.root === 'SW1') throw new Error('Lv257: 最初から SW1 が根');
}

// ================= Lv265 再配送を書く =================
function redistSpec(rng) {
  const spec = sim.gen.serial(rng, { routers: 3, ospf: true, switches: true });
  const base = spec.meta.block.split('.').slice(0, 2).join('.');
  const lan3 = `${base}.3${rng.rand(0, 9)}`; const p2p = `${base}.250.8`;
  spec.devices.R1.ifaces.push({ name: 'Gi0/2', ip: `${p2p.replace(/\.\d+$/, '')}.9/30` });
  spec.devices.R1.routes = [{ prefix: `${lan3}.0/24`, via: `${p2p.replace(/\.\d+$/, '')}.10` }];
  spec.devices.R0 = { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: `${lan3}.1/24` }, { name: 'Gi0/1', ip: `${p2p.replace(/\.\d+$/, '')}.10/30` }], routes: [{ prefix: '0.0.0.0/0', via: `${p2p.replace(/\.\d+$/, '')}.9` }] };
  spec.devices.PC3 = { kind: 'host', ip: `${lan3}.${rng.rand(10, 200)}/24`, gateway: `${lan3}.1` };
  spec.links.push(['R1:Gi0/2', 'R0:Gi0/1'], ['R0:Gi0/0', 'PC3']);
  const pos = {}; for (const k of Object.keys(spec.devices)) if (LAYOUTS.serial[k]) pos[k] = LAYOUTS.serial[k].slice();
  pos.R0 = [390, 110]; pos.PC3 = [230, 110];
  spec.layout = { pos };
  spec.meta.lan3 = lan3;
  return spec;
}
function redistQ(rng) {
  const spec = redistSpec(rng); const { lan2, lan3, block } = spec.meta;
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC3', to: 'PC2', roundTrip: true },
    { id: 2, kind: 'route', device: 'R2', prefix: `${lan3}.0/24`, proto: 'O' },
    { id: 3, kind: 'route', device: 'R3', prefix: `${lan3}.0/24`, proto: 'O' },
    { id: 4, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
  ];
  return configQ(rng, {
    text: `R1・R2・R3 は OSPF(エリア 0、network ${block})で経路を交換している。R0 は OSPF を使わない古いルーターで、R1 には R0 の先の網 ${lan3}.0/24 への静的経路が書いてある(R0 は R1 へのデフォルトルートを持つ)。PC3(${lan3}.0/24)から PC2(${lan2}.0/24)へ届かない。R2・R3 の経路表に ${lan3}.0/24 が無いためである。R1 の設定で、静的経路を OSPF に流して(再配送して)PC3 と PC2 が往復で届くようにせよ。設定できるのは R1 だけ。R2・R3 に静的経路は書けない。\n決まり: 再配送した経路は OSPF の外部経路(O)としてほかのルーターの経路表に載る。`,
    spec, editable: ['R1'], requirements,
    solution: [{ device: 'R1', text: 'router ospf 1\n redistribute static' }],
    why: `R1 の静的経路(${lan3}.0/24 → R0)を OSPF に再配送すると、R2・R3 は ${lan3}.0/24 を外部経路として覚え、PC2 からの返りが R1 → R0 → PC3 と戻れる。R1 に network ${lan3}.0/24 area 0 と書いても、R1 にその網の IF が無いので何も流れない。`,
    wrongs: [[{ device: 'R1', text: `router ospf 1\n network ${lan3}.0/24 area 0` }], [{ device: 'R1', text: 'router ospf 1\n redistribute connected' }]],
    meta: { lan3 },
  });
}
function verifyRedist(q) {
  const r = verifyConfig(q, 'Lv265');
  const st = sim.state(r.net);
  for (const d of ['R2', 'R3']) { const row = (st.routes[d] || []).find((x) => x.prefix === `${q.meta.lan3}.0/24`); if (!row || row.proto !== 'O' || !row.external) throw new Error(`Lv265: ${d} に外部経路が無い`); }
  const before = sim.reach(sim.build(q.sim.spec), 'PC3', 'PC2'); if (before.ok || !/^back:/.test(before.reason)) throw new Error(`Lv265: 壊れ方が違う ${before.reason}`);
}

// ================= Lv270 DNS の別名の連鎖 =================
const SITES = ['shop', 'news', 'portal', 'learn', 'store', 'docs'];
const CDNS = ['cdn', 'edge', 'cache'];
function dnsChainQ(rng) {
  const spec = sim.gen.serial(rng, { routers: rng.rand(1, 2), switches: true });
  const { lan1, lan2 } = spec.meta;
  const dnsIp = `${lan1}.${freeHost(spec, lan1, [53, 54, 55, 5])}`; // PC1 と重ならない番地
  const site = rng.pick(SITES); const cdn = rng.pick(CDNS);
  const k = rng.rand(1, 3); // CNAME の数
  const srvIp = `${lan2}.${freeHost(spec, lan2, rng.shuffle([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]))}`;
  const names = [`www.${site}.example`];
  if (k >= 2) names.push(`web.${site}.example`);
  if (k >= 3) names.push(`origin.${site}.example`);
  names.push(`${cdn}-${rng.rand(1, 9)}.${cdn}.example`); // 最後の名前(A を持つ)
  const records = [];
  for (let i = 0; i < names.length - 1; i++) records.push({ name: names[i], type: 'CNAME', value: names[i + 1] });
  records.push({ name: names[names.length - 1], type: 'A', value: srvIp });
  // 紛らわしい記録(別の名前)
  const other = rng.pick(SITES.filter((s) => s !== site));
  records.push({ name: `www.${other}.example`, type: 'A', value: `${lan2}.${rng.rand(10, 99)}` }, { name: `mail.${site}.example`, type: 'A', value: `${lan1}.${rng.rand(200, 250)}` });
  spec.devices.SRV1 = { kind: 'server', ip: `${dnsIp}/24`, gateway: `${lan1}.1`, listen: [{ proto: 'udp', port: 53 }], dnsRecords: rng.shuffle(records) };
  spec.devices.SRV2 = { kind: 'server', ip: `${srvIp}/24`, gateway: `${lan2}.1`, listen: [{ proto: 'tcp', port: 443 }] };
  spec.links.push(['SRV1', 'SW1:Gi1/0/9'], ['SRV2', 'SW2:Gi1/0/2']);
  spec.devices.PC1.dns = dnsIp;
  const pos = {}; for (const key of Object.keys(spec.devices)) if (LAYOUTS.serial[key]) pos[key] = LAYOUTS.serial[key].slice();
  pos.SRV1 = [230, 470]; pos.SRV2 = [840, 470]; spec.layout = { pos };
  const ids = idsFor(rng, spec);
  return {
    text: `PC1 は DNS サーバー SRV1(${dnsIp})を使っている。PC1 のターミナルで ${names[0]} を引き(nslookup)、別名(CNAME)の連鎖をたどって最後に得た A レコードのアドレスと、通った CNAME の数を答えよ。`,
    diagram: sim.diagram(spec, { nodeIds: ids, showIps: true }),
    terminal: { devices: ['PC1'], start: 'PC1' }, sim: { spec },
    answerKind: 'text',
    fields: [{ name: 'ip', label: '最後の A のアドレス', format: 'ipv4', hint: '例: 10.0.2.10', accept: [srvIp] }, { name: 'n', label: 'CNAME の数', format: 'number', hint: '例: 2', accept: [String(k)] }],
    explanation: `正解は ${srvIp}、CNAME は ${k} 個。${names.slice(0, -1).map((n, i) => `${n} → (CNAME) → ${names[i + 1]}`).join('、')}、最後の ${names[names.length - 1]} が A ${srvIp}。CNAME は「この名前の本名はこちら」という別名で、A が出るまでたどる。`,
    meta: { k, name: names[0] },
  };
}
function verifyDnsChain(q) {
  const s = sim.session(q.sim.spec, 'PC1');
  const out = sim.exec(s, `nslookup ${q.meta.name}`);
  const cnames = out.split('\n').filter((l) => /\bCNAME\b/.test(l)).length;
  const a = /\bA\s+(\d+\.\d+\.\d+\.\d+)/.exec(out);
  if (!a || a[1] !== q.fields[0].accept[0] || String(cnames) !== q.fields[1].accept[0]) throw new Error(`Lv270: nslookup の出力と合わない\n${out}`);
  if (q.diagram.nodes.some((n) => /example/.test(n.note || ''))) throw new Error('Lv270: 図に名前が出ている');
}

// ================= Lv286 要件から ACL を書く =================
function aclReqQ(rng) {
  const spec = sim.gen.twoSites(rng, { srvPort: 443 });
  const { hq, br } = spec.meta;
  spec.devices.SRV2 = { kind: 'server', ip: `${br}.${freeHost(spec, br, rng.shuffle([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]))}/24`, gateway: `${br}.1`, listen: [{ proto: 'tcp', port: 443 }] };
  spec.links.push(['SRV2', 'SW2:Gi1/0/2']);
  const srv1 = ipOf(spec.devices.SRV1.ip), srv2 = ipOf(spec.devices.SRV2.ip);
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 443, roundTrip: true },
    { id: 2, kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 22, expect: false },
    { id: 3, kind: 'reach', from: 'PC2', to: 'PC1', proto: 'icmp', expect: false },
    { id: 4, kind: 'reach', from: 'PC1', to: 'SRV2', proto: 'tcp', port: 443, roundTrip: true },
  ];
  return configQ(rng, {
    text: `本社(${hq}.0/24)と支社(${br}.0/24)が外の網でつながっている(図)。本社の R1 に拡張 ACL を書いて次の要件を満たせ。設定できるのは R1 だけ。IF と向きは自分で決めてよい。\n決まり: ACL は上の行から最初に合った行で決まり、合う行が無ければ捨てる(暗黙の拒否)。ルーターの ACL は状態を見ないので、返りの通信も ACL を通る(返りの宛先ポートは送信側の一時ポートで、443 などではない)。`,
    spec, editable: ['R1'], requirements,
    solution: [{ device: 'R1', text: `acl A20 extended\n 10 permit tcp ${br}.0/24 host ${srv1} eq 443\n 20 permit tcp host ${srv2} ${hq}.0/24\ninterface Gi0/1\n acl A20 in` }],
    why: `支社から来る通信は R1 の Gi0/1 に入るので、そこに受信の ACL を当てる。10 行で支社 → SRV1 の 443 だけを通し、22 と PC1 への ping は暗黙の拒否で止まる。20 行は、本社の PC1 が支社の SRV2(443)へつないだときの返り(送信元 SRV2、宛先ポートは PC1 の一時ポート)を通すための行。これが無いと要件 4 の返りが捨てられる。Gi0/0 の受信に当てると、支社から来る通信を見ないので要件 2・3 を満たせない。`,
    wrongs: [
      [{ device: 'R1', text: `acl A20 extended\n 10 permit tcp ${br}.0/24 host ${srv1} eq 443\ninterface Gi0/1\n acl A20 in` }],
      [{ device: 'R1', text: `acl A20 extended\n 10 permit ip any any\ninterface Gi0/1\n acl A20 in` }],
      [{ device: 'R1', text: `acl A20 extended\n 10 permit tcp ${br}.0/24 host ${srv1} eq 443\n 20 permit tcp host ${srv2} ${hq}.0/24\ninterface Gi0/0\n acl A20 in` }],
    ],
    meta: { srv1, srv2 },
  });
}
function verifyAclReq(q) {
  const r = verifyConfig(q, 'Lv286');
  // 別の方法: 正解の例を当てた net で、4 つの通信を直接流して要件と同じ結果か
  const n = r.net;
  const want = [[sim.reach(n, 'PC2', 'SRV1', { proto: 'tcp', port: 443 }).ok, true], [sim.reach(n, 'PC2', 'SRV1', { proto: 'tcp', port: 22 }).ok, false], [sim.reach(n, 'PC2', 'PC1').ok, false], [sim.reach(n, 'PC1', 'SRV2', { proto: 'tcp', port: 443 }).ok, true]];
  if (want.some(([a, b]) => a !== b)) throw new Error(`Lv286: 通信の結果が要件と違う ${JSON.stringify(want)}`);
}

// ================= Lv297 コマンドで集める =================
const BREAKS_297 = ['route-missing', 'route-wrong', 'acl'];
function collectQ(rng) {
  for (;;) {
    const good = sim.gen.serial(rng, { routers: rng.rand(2, 3), switches: true });
    const { lan1, lan2, routers } = good.meta;
    const kind = rng.pick(BREAKS_297);
    const culprit = `R${rng.rand(1, routers)}`;
    const broken = U.clone(good); const dev = broken.devices[culprit];
    const toward2 = culprit !== `R${routers}` && (culprit === 'R1' || rng.next() < 0.5); // lan2 向きの経路を壊すか(最後のルーターは lan1 向きだけ)
    const target = toward2 ? `${lan2}.0/24` : `${lan1}.0/24`;
    let how;
    if (kind === 'route-missing') { if (culprit === 'R1' && toward2 === false) continue; dev.routes = dev.routes.filter((r) => r.prefix !== target); if (dev.routes.length === (good.devices[culprit].routes || []).length) continue; how = `${culprit} の経路表に ${target} の行が無い`; }
    else if (kind === 'route-wrong') {
      const row = dev.routes.find((r) => r.prefix === target); if (!row) continue;
      const wrongVia = row.via.replace(/\.(\d+)$/, (m, d) => `.${Number(d) === 1 ? 5 : Number(d) + 4}`); // 同じ /30 に無いアドレス(機器がいない)
      row.via = wrongVia; how = `${culprit} の ${target} の経路の次の相手が ${wrongVia} になっている(その番地に機器がいない)`;
    } else {
      const pc1 = ipOf(good.devices.PC1.ip);
      dev.acls = { A10: { type: 'standard', lines: [{ seq: 10, action: 'deny', src: `host ${pc1}` }, { seq: 20, action: 'permit', src: 'any' }] } };
      dev.ifaces[0].aclIn = 'A10'; how = `${culprit} の Gi0/0 の受信 ACL A10 が PC1(${pc1})を拒否している`;
    }
    const reqs = DIAG_REQ([['PC1', 'PC2']]);
    if (sim.check(sim.build(broken), reqs)[0].ok) continue;
    let ok = true; try { uniqueCulprit(good, broken, culprit, reqs); } catch { ok = false; } if (!ok) continue;
    const ids = idsFor(rng, broken);
    const cmd = kind === 'acl' ? 'show access-lists と show running-config' : 'show ip route';
    return {
      text: `PC1(${ipOf(broken.devices.PC1.ip)})から PC2(${ipOf(broken.devices.PC2.ip)})に ping が通らない。図のどこかのルーター 1 台の設定が誤っている。ターミナルで PC1 からの ping・traceroute と、各ルーターにつないで(connect R1 など)show ip route・show ip arp・show access-lists を使って調べ、原因になっている機器を図でタップせよ。`,
      diagram: sim.diagram(broken, { nodeIds: ids, showIps: true }),
      terminal: { devices: Object.keys(broken.devices).filter((n) => !/^SW/.test(n)), start: 'PC1' }, sim: { spec: broken, good },
      answerKind: 'tap', tap: { mode: 'one' }, accept: { ids: [ids[culprit]] },
      explanation: `正解は ${culprit}。${how}。PC1 から traceroute すると ${culprit} の手前までは返事があり、その先に進まない(または返りが戻らない)。${culprit} につないで ${cmd} を見ると分かる。ほかのルーターの経路表と ARP は正しい。`,
      meta: { kind, culprit, routers },
    };
  }
}
function verifyCollect(q) {
  const { spec, good } = q.sim; const reqs = DIAG_REQ([['PC1', 'PC2']]);
  uniqueCulprit(good, spec, q.meta.culprit, reqs);
  const name = Object.entries(q.diagram.nodes).map(([, n]) => n).find((n) => n.id === q.accept.ids[0]);
  if (!name || name.name !== q.meta.culprit) throw new Error('Lv297: 正解の id が原因の機器でない');
  const s = sim.session(spec, 'PC1'); const p = sim.exec(s, 'ping PC2'); if (!/届かない/.test(p)) throw new Error('Lv297: ping が通ってしまう');
  if (JSON.stringify(q.diagram).includes('deny')) throw new Error('Lv297: 図に ACL が出ている');
}

// ================= Lv298 ARP が埋まらない =================
const CAUSES_298 = {
  gw: 'PC1 のデフォルトゲートウェイが R1 のアドレスと違う(その番地に機器がいない)',
  down: 'R1 の Gi0/0 が止めてある(shutdown)',
  vlan: 'SW1 で PC1 のポートが、R1 のポートと違う VLAN に入っている',
  route: 'R1 の経路表に PC2 の網への経路が無い',
};
function arpQ(rng) {
  for (;;) {
    const good = sim.gen.serial(rng, { routers: 1, switches: true });
    const { lan1 } = good.meta;
    const cause = rng.pick(['gw', 'down', 'vlan']);
    const broken = U.clone(good);
    let fixes;
    if (cause === 'gw') { broken.devices.PC1.gateway = `${lan1}.${rng.pick([254, 253, 2])}`; }
    else if (cause === 'down') { broken.devices.R1.ifaces[0].shutdown = true; }
    else { broken.devices.SW1 = { kind: 'switch', vlans: [1, 20], ifaces: [{ name: 'Gi1/0/1', mode: 'access', vlan: 20 }] }; }
    // 候補ごとの「直し」(原因が 1 つに決まる確かめ用)
    fixes = {
      gw: (s) => { s.devices.PC1.gateway = good.devices.PC1.gateway; },
      down: (s) => { if (s.devices.R1.ifaces[0]) delete s.devices.R1.ifaces[0].shutdown; },
      vlan: (s) => { s.devices.SW1 = { kind: 'switch' }; },
      route: (s) => { s.devices.R1.routes = (s.devices.R1.routes || []).concat([{ prefix: `${good.meta.lan2}.0/24`, via: 'Gi0/1' }]); },
    };
    const reqs = DIAG_REQ([['PC1', 'PC2']]);
    if (sim.check(sim.build(broken), reqs)[0].ok) continue;
    const works = Object.keys(fixes).filter((k) => { const s = U.clone(broken); fixes[k](s); return sim.check(sim.build(s), reqs)[0].ok; });
    if (works.length !== 1 || works[0] !== cause) continue;
    const keys = rng.shuffle(Object.keys(CAUSES_298));
    const options = keys.map((k) => CAUSES_298[k]);
    const ids = idsFor(rng, broken);
    const obs = { gw: 'ipconfig のデフォルトゲートウェイが R1 の Gi0/0 のアドレスと違い、arp -a にその番地が出ない(答える機器がいない)', down: 'ipconfig のゲートウェイは R1 のアドレスと同じだが arp -a に出ない。R1 につないで show ip interface brief を見ると Gi0/0 が admin down', vlan: 'ゲートウェイのアドレスは正しく R1 の IF も up だが、SW1 につないで show vlan を見ると PC1 のポートだけ VLAN 20 に入っていて、R1 のポート(VLAN 1)と別の VLAN' }[cause];
    return {
      text: `PC1(${ipOf(broken.devices.PC1.ip)})から PC2(${ipOf(broken.devices.PC2.ip)})に ping が通らない。PC1 で arp -a を見ると、デフォルトゲートウェイの ARP が埋まらない(答えが無い)。ターミナルで PC1(ipconfig・arp -a・ping)、R1(show ip interface brief・show ip route)、SW1(show vlan)を調べて、原因を選べ。`,
      diagram: sim.diagram(broken, { nodeIds: ids, showIps: true }),
      terminal: { devices: ['PC1', 'R1', 'SW1'], start: 'PC1' }, sim: { spec: broken, good },
      options, answerIndex: keys.indexOf(cause),
      explanation: `正解は「${CAUSES_298[cause]}」。${obs}。ARP が埋まらないのは、ゲートウェイの番地に答える機器がいないか(番地違い・IF が止まっている)、同じ VLAN にいないとき。R1 の経路表の有無は、ARP が埋まったあとの話なので今回の症状の原因ではない。`,
      meta: { cause },
    };
  }
}
function verifyArp(q) {
  const { spec, good } = q.sim; const reqs = DIAG_REQ([['PC1', 'PC2']]);
  const fixes = {
    gw: (s) => { s.devices.PC1.gateway = good.devices.PC1.gateway; },
    down: (s) => { if (s.devices.R1.ifaces[0]) delete s.devices.R1.ifaces[0].shutdown; },
    vlan: (s) => { s.devices.SW1 = { kind: 'switch' }; },
    route: (s) => { s.devices.R1.routes = (s.devices.R1.routes || []).concat([{ prefix: `${good.meta.lan2}.0/24`, via: 'Gi0/1' }]); },
  };
  const works = Object.keys(fixes).filter((k) => { const s = U.clone(spec); fixes[k](s); return sim.check(sim.build(s), reqs)[0].ok; });
  if (works.length !== 1 || CAUSES_298[works[0]] !== q.options[q.answerIndex]) throw new Error(`Lv298: 原因が 1 つに決まらない ${works}`);
  const s = sim.session(spec, 'PC1');
  if (!/届かない/.test(sim.exec(s, 'ping PC2'))) throw new Error('Lv298: ping が通る');
  const arp = sim.exec(s, 'arp -a'); if (arp.includes(spec.devices.PC1.gateway)) throw new Error('Lv298: ARP にゲートウェイが出ている');
}

// ================= Lv309 ルーターの副 IF で VLAN 間 =================
function subifQ(rng) {
  const spec = sim.gen.twoSwitches(rng, { l3: 'subif' });
  const { vlans, lan } = spec.meta; const [v1, v2] = vlans;
  spec.devices.R1 = { kind: 'router', ifaces: [{ name: 'Gi0/0' }] };
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
    { id: 2, kind: 'reach', from: 'PC3', to: 'PC4', roundTrip: true },
    { id: 3, kind: 'route', device: 'R1', prefix: `${lan[v1]}.0/24`, proto: 'C' },
    { id: 4, kind: 'route', device: 'R1', prefix: `${lan[v2]}.0/24`, proto: 'C' },
    { id: 5, kind: 'reach', from: 'PC1', to: 'PC3', roundTrip: true },
  ];
  return configQ(rng, {
    text: `SW1 と SW2 に VLAN ${v1}(${lan[v1]}.0/24。PC1 ${ipOf(spec.devices.PC1.ip)}・PC3 ${ipOf(spec.devices.PC3.ip)})と VLAN ${v2}(${lan[v2]}.0/24。PC2 ${ipOf(spec.devices.PC2.ip)}・PC4 ${ipOf(spec.devices.PC4.ip)})の PC がつながり、SW1 の Gi1/0/23 はトランク(VLAN ${v1}・${v2})で R1 の Gi0/0 につながっている(図)。R1 はまだ VLAN 間の経路を持たない。R1 の Gi0/0 に副 IF(サブインターフェース)を作って、各 VLAN のデフォルトゲートウェイ(.1)にし、VLAN をまたいで往復で届くようにせよ。設定できるのは R1 だけ。PC のゲートウェイは各網の .1。\n書き方: interface Gi0/0.<番号> の中で encapsulation dot1q <VLAN 番号> と ip address。`,
    spec, editable: ['R1'], requirements,
    solution: [{ device: 'R1', text: `interface Gi0/0.${v1}\n encapsulation dot1q ${v1}\n ip address ${lan[v1]}.1/24\ninterface Gi0/0.${v2}\n encapsulation dot1q ${v2}\n ip address ${lan[v2]}.1/24` }],
    why: `1 本のトランクで 2 つの VLAN が届くので、R1 側は物理 IF 1 つに VLAN ごとの副 IF を作り、タグ(dot1q)と各網の .1 を付ける。これで R1 は両方の網に直結(C)し、VLAN 間を経路できる。アドレスを .1 以外にすると PC のゲートウェイと合わない。`,
    wrongs: [[{ device: 'R1', text: `interface Gi0/0.${v1}\n encapsulation dot1q ${v1}\n ip address ${lan[v1]}.1/24` }], [{ device: 'R1', text: `interface Gi0/0.${v1}\n encapsulation dot1q ${v1}\n ip address ${lan[v1]}.2/24\ninterface Gi0/0.${v2}\n encapsulation dot1q ${v2}\n ip address ${lan[v2]}.2/24` }]],
    meta: { v1, v2 },
  });
}
function verifySubif(q) { const r = verifyConfig(q, 'Lv309'); if (!sim.reach(r.net, 'PC1', 'PC2').path.includes('R1')) throw new Error('Lv309: R1 を通っていない'); }

// ================= Lv310 OSPF を 1 エリアで =================
function ospfQ(rng) {
  const spec = sim.gen.serial(rng, { routers: 3, switches: rng.next() < 0.5 });
  const { lan1, lan2, block } = spec.meta;
  for (const r of ['R1', 'R2', 'R3']) { spec.devices[r].routes = []; delete spec.devices[r].ospf; }
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
    { id: 2, kind: 'route', device: 'R1', prefix: `${lan2}.0/24`, proto: 'O' },
    { id: 3, kind: 'route', device: 'R3', prefix: `${lan1}.0/24`, proto: 'O' },
    { id: 4, kind: 'route', device: 'R2', prefix: `${lan1}.0/24`, proto: 'O' },
  ];
  return configQ(rng, {
    text: `R1・R2・R3 を直列につないだ網(図。PC1 は ${ipOf(spec.devices.PC1.ip)}、PC2 は ${ipOf(spec.devices.PC2.ip)})に、静的経路の代わりに OSPF を入れる。3 台とも 1 つのエリア(エリア 0)に入れ、PC1 と PC2 が往復で届き、各ルーターが相手側の LAN を OSPF の経路(O)として覚えるようにせよ。設定できるのは R1・R2・R3。静的経路では要件を満たさない。\n書き方: router ospf 1 の中で network <網>/<長さ> area 0。IF のアドレスがその網に入っていれば OSPF に参加する(${block} のように広く書いてもよい)。\n決まり: 同じ網で両方が OSPF に参加し、エリアが同じなら隣になる。`,
    spec, editable: ['R1', 'R2', 'R3'], requirements,
    solution: ['R1', 'R2', 'R3'].map((d) => ({ device: d, text: `router ospf 1\n network ${block} area 0` })),
    why: `3 台で同じエリア 0 に全部の IF を入れれば、隣どうしが経路を交換し、各 LAN が O の経路として載る。R2 だけエリアを変えると R1・R3 と隣になれず、経路が届かない。`,
    wrongs: [
      [{ device: 'R1', text: `router ospf 1\n network ${block} area 0` }, { device: 'R2', text: `router ospf 1\n network ${block} area 1` }, { device: 'R3', text: `router ospf 1\n network ${block} area 0` }],
      [{ device: 'R1', text: `ip route ${lan2}.0/24 ${ipOf(spec.devices.R2.ifaces[0].ip)}` }, { device: 'R3', text: `ip route ${lan1}.0/24 ${ipOf(spec.devices.R2.ifaces[1].ip)}` }],
    ],
    meta: { switches: !!spec.devices.SW1 },
  });
}
function verifyOspf(q) { const r = verifyConfig(q, 'Lv310'); if (sim.state(r.net).ospfNeighbors.length !== 2) throw new Error('Lv310: ネイバーが 2 組でない'); }

// ================= Lv311 コストで寄せる =================
function costQ(rng) {
  const spec = sim.gen.square(rng, { costs: [1, 1, 1, 2] });
  const cost = rng.pick([10, 20, 50, 100]);
  const requirements = [
    { id: 1, kind: 'path', from: 'PC1', to: 'PC2', via: ['R1', 'R3', 'R4'] },
    { id: 2, kind: 'path', from: 'PC2', to: 'PC1', via: ['R4', 'R3', 'R1'] },
    { id: 3, kind: 'failover', cut: [['R1:Gi0/2', 'R3:Gi0/0']], then: { kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true } },
    { id: 4, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
  ];
  return configQ(rng, {
    text: `R1〜R4 は OSPF で経路を交換し、PC1(${spec.meta.lan1}.0/24)→ PC2(${spec.meta.lan2}.0/24)の道は R1–R2–R4(コスト 1 + 1)と R1–R3–R4(コスト 1 + 2)の 2 本ある(図。線の文字はコスト)。今は R2 回りが使われている。保守のため、行きも返りも R3 回り(R1 → R3 → R4、R4 → R3 → R1)を使うように、OSPF のコストだけを変えて寄せよ。R2 回りの線は切らず、R1–R3 の線が切れたときは R2 回りで届くこと。設定できるのは R1 と R4。\n決まり: コストは出ていく IF の ospf cost(既定 1)。OSPF は合計のコストが小さい道を使う。\n書き方: interface Gi0/1 の中で ospf cost <数>。`,
    spec, editable: ['R1', 'R4'], requirements,
    solution: [{ device: 'R1', text: `interface Gi0/1\n ospf cost ${cost}` }, { device: 'R4', text: `interface Gi0/1\n ospf cost ${cost}` }],
    why: `R1 の Gi0/1(R2 への線)と R4 の Gi0/1(R2 への線)のコストを上げれば、R2 回りは ${cost} + 1 になり、R3 回り(1 + 2 = 3)より大きくなる。行きは R1 が、返りは R4 が決めるので両方に書く。R2 回りの線は残るので、R1–R3 が切れればそちらで届く。Gi0/2(R3 への線)に書くと逆に R3 回りが遠くなる。shutdown で R2 回りを消すと切れたときに届かない。`,
    wrongs: [[{ device: 'R1', text: `interface Gi0/2\n ospf cost ${cost}` }, { device: 'R4', text: `interface Gi0/2\n ospf cost ${cost}` }], [{ device: 'R1', text: `interface Gi0/1\n ospf cost ${cost}` }], [{ device: 'R1', text: 'interface Gi0/1\n shutdown' }, { device: 'R4', text: 'interface Gi0/1\n shutdown' }]],
    meta: { cost },
  });
}
function verifyCost(q) { // 別の方法: 全部の単純な道のコストを足して最小を出す
  const r = verifyConfig(q, 'Lv311');
  const net = r.net; const cost = (d, i) => net.devices[d].ifByName[i].ospfCost || 1;
  const viaR2 = cost('R1', 'Gi0/1') + cost('R2', 'Gi0/1'), viaR3 = cost('R1', 'Gi0/2') + cost('R3', 'Gi0/1');
  if (!(viaR3 < viaR2)) throw new Error('Lv311: R3 回りが短くない');
  const back2 = cost('R4', 'Gi0/1') + cost('R2', 'Gi0/0'), back3 = cost('R4', 'Gi0/2') + cost('R3', 'Gi0/0');
  if (!(back3 < back2)) throw new Error('Lv311: 返りの R3 回りが短くない');
}

// ================= Lv312 予備の静的経路 =================
function floatingQ(rng) {
  const spec = sim.gen.square(rng);
  const { lan1, lan2 } = spec.meta;
  const ip = (d, i) => ipOf(spec.devices[d].ifaces.find((f) => f.name === i).ip);
  for (const d of ['R1', 'R2', 'R3', 'R4']) { delete spec.devices[d].ospf; for (const f of spec.devices[d].ifaces) delete f.ospfCost; }
  spec.devices.R2.routes = [{ prefix: `${lan1}.0/24`, via: ip('R1', 'Gi0/1') }, { prefix: `${lan2}.0/24`, via: ip('R4', 'Gi0/1') }];
  spec.devices.R3.routes = [{ prefix: `${lan1}.0/24`, via: ip('R1', 'Gi0/2') }, { prefix: `${lan2}.0/24`, via: ip('R4', 'Gi0/2') }];
  spec.devices.R4.routes = [{ prefix: `${lan1}.0/24`, via: ip('R2', 'Gi0/1') }, { prefix: `${lan1}.0/24`, via: ip('R3', 'Gi0/1'), ad: 200 }];
  spec.devices.R1.routes = [];
  const ad = rng.pick([200, 150, 250, 100]);
  // sim に足してほしいこと: 線が切れた IF を端点から外す(直結の経路が消える)こと。それまでは failover の要件で予備の静的経路を確かめられないので、R1 の経路の中身(state)で確かめる
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
    { id: 2, kind: 'path', from: 'PC1', to: 'PC2', via: ['R1', 'R2', 'R4'] },
    { id: 3, kind: 'state', device: 'R1', path: 'routes.1.via', equals: ip('R3', 'Gi0/0'), text: `R1 の 2 行目の経路が R3(${ip('R3', 'Gi0/0')})向きの予備` },
    { id: 4, kind: 'state', device: 'R1', path: 'routes.1.ad', equals: ad, text: `予備の経路の優先度が ${ad}` },
    { id: 5, kind: 'state', device: 'R1', path: 'routes.0.ad', equals: 1, text: '主の経路(1 行目)の優先度が 1(書かない)' },
  ];
  return configQ(rng, {
    text: `PC1 → PC2 の道は R2 回り(主)と R3 回り(予備)の 2 本(図)。R2・R3・R4 には静的経路が書いてあり、R4 は ${lan1}.0/24 へ R2 向き(優先度 1)と R3 向き(優先度 200)の 2 本を持つ。R1 には ${lan2}.0/24 への経路がまだ無い。R1 に、普段は R2 回りを使い、R2 が止まったら自動で R3 回りに替わる静的経路を 2 行書け(1 行目に主、2 行目に予備。予備の優先度は ${ad})。設定できるのは R1 だけ。\n決まり: 静的経路の優先度(AD)は書かなければ 1。同じ宛先に 2 本あるとき、優先度の小さい方だけを使い、その経路の次の相手の網(直結)が消えたら大きい方を使う。\n書き方: ip route <網>/<長さ> <次の相手> [優先度]。`,
    spec, editable: ['R1'], requirements,
    solution: [{ device: 'R1', text: `ip route ${lan2}.0/24 ${ip('R2', 'Gi0/0')}\nip route ${lan2}.0/24 ${ip('R3', 'Gi0/0')} ${ad}` }],
    why: `主は R2 の ${ip('R2', 'Gi0/0')} 向き(優先度 1)、予備は R3 の ${ip('R3', 'Gi0/0')} 向きに 1 より大きい優先度(${ad} など)を付ける。普段は優先度 1 の方だけが経路表に載り、R2 の線が切れて R1–R2 の直結の網が消えると、予備が経路表に載って R3 回りで届く。予備だけ書く・両方同じ優先度にすると要件に合わない。`,
    wrongs: [[{ device: 'R1', text: `ip route ${lan2}.0/24 ${ip('R2', 'Gi0/0')}` }], [{ device: 'R1', text: `ip route ${lan2}.0/24 ${ip('R3', 'Gi0/0')}` }], [{ device: 'R1', text: `ip route ${lan2}.0/24 ${ip('R2', 'Gi0/0')} ${ad}\nip route ${lan2}.0/24 ${ip('R3', 'Gi0/0')}` }]],
    meta: { ad },
  });
}
function verifyFloating(q) {
  const r = verifyConfig(q, 'Lv312');
  const rows = sim.state(r.net).routes.R1.filter((x) => x.prefix === `${q.sim.spec.meta.lan2}.0/24`);
  if (rows.length !== 1 || rows[0].ad !== 1 || !sim.reach(r.net, 'PC1', 'PC2').path.includes('R2')) throw new Error('Lv312: 普段の経路が R2 回りでない');
  // 別の方法: 主の次の相手へ向く IF を止めた写しで、予備(AD の大きい方)だけが載って R3 回りで届く
  const c = sim.build(q.sim.spec); for (const s of q.solution) sim.applyConfig(c, s.device, s.text);
  c.editable = ['R1', 'R4']; sim.applyConfig(c, 'R1', 'interface Gi0/1\n shutdown'); sim.applyConfig(c, 'R4', 'interface Gi0/1\n shutdown'); // R2 への両側の IF を止める(R2 が止まったのと同じ形)
  const rows2 = sim.state(c).routes.R1.filter((x) => x.prefix === `${q.sim.spec.meta.lan2}.0/24`);
  if (rows2.length !== 1 || rows2[0].ad !== q.meta.ad) throw new Error('Lv312: 主を止めたあとに予備が載っていない');
  const alt = sim.reach(c, 'PC1', 'PC2'); if (!alt.ok || !alt.path.includes('R3')) throw new Error(`Lv312: 予備で届かない ${alt.reason} ${alt.path}`);
}

// ================= Lv313 IPv6 のアドレスと経路 =================
function ipv6Q(rng) {
  const spec = sim.gen.serial(rng, { routers: 2, switches: false });
  const X = rng.rand(1, 0xffff).toString(16);
  const p = (s) => `2001:db8:${X}:${s}`;
  const lan1 = `${p('1')}::/64`, lan2 = `${p('2')}::/64`, link = `${p('12')}::/64`;
  spec.devices.PC1.ipv6 = `${p('1')}::${rng.rand(10, 99)}/64`; spec.devices.PC2.ipv6 = `${p('2')}::${rng.rand(10, 99)}/64`;
  spec.devices.R2.ifaces[0].ipv6 = `${p('12')}::2/64`; spec.devices.R2.ifaces[1].ipv6 = `${p('2')}::1/64`;
  spec.devices.R2.routes6 = [{ prefix: lan1, via: `${p('12')}::1` }];
  const requirements = [
    { id: 1, kind: 'state', device: 'R1', path: 'ifByName.Gi0/0.ipv6', equals: `${p('1')}::1/64`, text: `R1 の Gi0/0 に ${p('1')}::1/64 が付いている` },
    { id: 2, kind: 'state', device: 'R1', path: 'ifByName.Gi0/1.ipv6', equals: `${p('12')}::1/64`, text: `R1 の Gi0/1 に ${p('12')}::1/64 が付いている` },
    { id: 3, kind: 'state', device: 'R1', path: 'routes6.0.prefix', equals: lan2, text: `R1 に ${lan2} への IPv6 の静的経路がある(1 行だけ書く)` },
    { id: 4, kind: 'state', device: 'R1', path: 'routes6.0.via', equals: `${p('12')}::2`, text: `その経路の次の相手が R2 の ${p('12')}::2` },
  ];
  return configQ(rng, {
    text: `IPv6 を入れる。PC1 の網は ${lan1}、PC2 の網は ${lan2}、R1–R2 の間は ${link}。R2 には ${p('12')}::2/64 と ${p('2')}::1/64 が付き、${lan1} への経路も書いてある。R1 に、Gi0/0 へ ${p('1')}::1/64、Gi0/1 へ ${p('12')}::1/64 を付け、${lan2} への静的経路(次の相手は R2 の ${p('12')}::2)を 1 行書け。設定できるのは R1 だけ。\nこの問題では、アドレスは問題文の表記のまま(小文字・省略形)で書く。\n書き方: interface の中で ipv6 address <アドレス>/<長さ>。トップで ipv6 route <網>/<長さ> <次の相手>。`,
    spec, editable: ['R1'], requirements,
    solution: [{ device: 'R1', text: `interface Gi0/0\n ipv6 address ${p('1')}::1/64\ninterface Gi0/1\n ipv6 address ${p('12')}::1/64\nipv6 route ${lan2} ${p('12')}::2` }],
    why: `IPv4 と同じ考え方で、各 IF に網のアドレスを付け、直結でない網(${lan2})へは次の相手(R2 の R1 側のアドレス ${p('12')}::2)を書いた静的経路を置く。R2 側は ${lan1} への経路を持っているので往復がそろう。`,
    wrongs: [[{ device: 'R1', text: `interface Gi0/0\n ipv6 address ${p('1')}::1/64\ninterface Gi0/1\n ipv6 address ${p('12')}::1/64` }], [{ device: 'R1', text: `interface Gi0/0\n ipv6 address ${p('1')}::1/64\ninterface Gi0/1\n ipv6 address ${p('12')}::1/64\nipv6 route ${lan2} ${p('2')}::1` }]],
    meta: { X },
  });
}
function verifyIpv6(q) {
  const r = verifyConfig(q, 'Lv313');
  const R1 = r.net.devices.R1;
  if (!/^2001:db8:[0-9a-f]{1,4}:1::1\/64$/.test(R1.ifByName['Gi0/0'].ipv6) || R1.routes6.length !== 1) throw new Error('Lv313: アドレスか経路が違う');
  const s = JSON.stringify(q); for (const m of s.matchAll(/\b([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})\b/g)) if (!/^2001:db8:/.test(m[1])) throw new Error(`Lv313: 2001:db8 以外の IPv6 ${m[1]}`);
}

// ================= Lv314 NAPT =================
function naptQ(rng) {
  const spec = sim.gen.twoSites(rng);
  const { hq } = spec.meta;
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC1', to: 'INET', proto: 'tcp', port: 443, roundTrip: true },
    { id: 2, kind: 'reach', from: 'INET', to: 'PC1', expect: false, text: `外(INET)から PC1 のプライベートアドレスへは届かない` },
    { id: 3, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
  ];
  return configQ(rng, {
    text: `本社 LAN(${hq}.0/24)の PC1(${ipOf(spec.devices.PC1.ip)})が外(INET)の Web サーバーに届かない。プライベートアドレスのまま外へ出ていて、返りが戻れないためである。R1 に NAPT を書いて、PC1 から外へ往復で届くようにせよ。Gi0/0 が LAN 側(内側)、Gi0/1 が外側(203.0.113.1)。設定できるのは R1 だけ。\n決まり: 内側 IF から外側 IF へ出る通信の送信元を、外側 IF のアドレスに書き換える(ポートは付け替え)。返りは表で元に戻す。\n書き方: interface の中で nat inside / nat outside。トップで nat source <網>/<長さ> interface <外側の IF> overload。`,
    spec, editable: ['R1'], requirements,
    solution: [{ device: 'R1', text: `interface Gi0/0\n nat inside\ninterface Gi0/1\n nat outside\nnat source ${hq}.0/24 interface Gi0/1 overload` }],
    why: `内側(Gi0/0)と外側(Gi0/1)を決め、LAN の送信元を Gi0/1 のアドレス 203.0.113.1 に書き換える。外から見える送信元がグローバルになるので返りが R1 に戻り、R1 が表で PC1 に戻す。nat outside を書き忘れると変換が起きない。外から PC1 のプライベートアドレスへは、この設定でも届かない(要件 2)。`,
    wrongs: [[{ device: 'R1', text: `interface Gi0/0\n nat inside\nnat source ${hq}.0/24 interface Gi0/1 overload` }], [{ device: 'R1', text: 'interface Gi0/0\n nat inside\ninterface Gi0/1\n nat outside' }]],
    meta: {},
  });
}
function verifyNapt(q) {
  const r = verifyConfig(q, 'Lv314');
  const res = sim.reach(r.net, 'PC1', 'INET', { proto: 'tcp', port: 443 });
  if (!res.nat || !res.nat.R1 || res.nat.R1[0].outIp !== '203.0.113.1') throw new Error('Lv314: NAT の表に変換が無い');
}

// ================= Lv315 ポートフォワード =================
function pfQ(rng) {
  const spec = sim.gen.twoSites(rng, { srvPort: 443 });
  const ext = rng.pick([443, 8443, 10443]);
  const srv = ipOf(spec.devices.SRV1.ip);
  const requirements = [
    { id: 1, kind: 'reach', from: 'INET', to: null, toIp: '203.0.113.1', proto: 'tcp', port: ext, roundTrip: true, text: `外(INET)から 203.0.113.1 の TCP ${ext} へつなぐと SRV1 の 443 に届き、返りも戻る` },
    { id: 2, kind: 'reach', from: 'INET', to: null, toIp: '203.0.113.1', proto: 'tcp', port: 22, expect: false, text: '外から 203.0.113.1 の TCP 22 へは届かない' },
    { id: 3, kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 443, roundTrip: true },
  ];
  return configQ(rng, {
    text: `本社の Web サーバー SRV1(${srv}、TCP 443 で待ち受け)を外(INET)に公開したい。外からは R1 の外側のアドレス 203.0.113.1 の TCP ${ext} へつなぐ。R1 にポートフォワード(静的 NAT)を書け。Gi0/0 が LAN 側(内側)、Gi0/1 が外側。SRV1 の 22 番は公開しない。設定できるのは R1 だけ。\n決まり: 外側 IF で受けた宛先 <外のアドレス>:<外のポート> を <内のアドレス>:<内のポート> に書き換える。返りは逆に戻す。\n書き方: interface の中で nat inside / nat outside。トップで nat static tcp <内のアドレス> <内のポート> <外のアドレス> <外のポート>。`,
    spec, editable: ['R1'], requirements,
    solution: [{ device: 'R1', text: `interface Gi0/0\n nat inside\ninterface Gi0/1\n nat outside\nnat static tcp ${srv} 443 203.0.113.1 ${ext}` }],
    why: `外からの宛先 203.0.113.1:${ext} を SRV1 の 443 に書き換える 1 行と、内側・外側の IF の指定。内と外のポートの順を取り違えると、外の ${ext} が SRV1 の ${ext} に向いてしまい、待ち受けていないので届かない。22 番は書かないので外からは届かない。`,
    wrongs: [...(ext !== 443 ? [[{ device: 'R1', text: `interface Gi0/0\n nat inside\ninterface Gi0/1\n nat outside\nnat static tcp ${srv} ${ext} 203.0.113.1 443` }]] : []), [{ device: 'R1', text: `nat static tcp ${srv} 443 203.0.113.1 ${ext}` }]], // 外のポートが 443 なら入れ替えても同じ
    meta: { ext },
  });
}
function verifyPf(q) {
  const r = verifyConfig(q, 'Lv315');
  const res = sim.reach(r.net, 'INET', null, { proto: 'tcp', port: q.meta.ext, toIp: '203.0.113.1' });
  if (!res.ok || res.path[res.path.length - 1] !== 'SRV1') throw new Error('Lv315: SRV1 に届いていない');
}

// ================= Lv316 VRRP =================
function vrrpSpec(rng) {
  const spec = sim.gen.serial(rng, { routers: 1, switches: true });
  const { lan1, lan2 } = spec.meta;
  const vip1 = `${lan1}.254`, vip2 = `${lan2}.254`;
  spec.devices.R2 = { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: `${lan1}.2/24` }, { name: 'Gi0/1', ip: `${lan2}.2/24` }], routes: [] };
  spec.links.push(['R2:Gi0/0', 'SW1:Gi1/0/23'], ['R2:Gi0/1', 'SW2:Gi1/0/23']);
  spec.devices.PC1.gateway = vip1; spec.devices.PC2.gateway = vip2;
  for (const h of Object.keys(spec.devices)) if (/^PC/.test(h) && h !== 'PC1' && h !== 'PC2') spec.devices[h].gateway = vip1;
  spec.layout = { pos: { PC1: [80, 300], SW1: [230, 300], R1: [460, 170], R2: [460, 430], SW2: [690, 300], PC2: [900, 300] } };
  spec.meta.vip1 = vip1; spec.meta.vip2 = vip2;
  return spec;
}
function vrrpQ(rng) {
  const spec = vrrpSpec(rng); const { vip1, vip2, lan1, lan2 } = spec.meta;
  const prio = rng.pick([110, 120, 150, 200]);
  const requirements = [
    { id: 1, kind: 'master', vip: vip1, device: 'R1' },
    { id: 2, kind: 'master', vip: vip2, device: 'R1' },
    { id: 3, kind: 'master', vip: vip1, device: 'R2', down: ['R1'] },
    { id: 4, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
    { id: 5, kind: 'failover', down: ['R1'], then: { kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }, text: 'R1 が止まったあとも、PC1 から PC2 に往復で届く' },
  ];
  const cfg = (prio1) => [
    { device: 'R1', text: `interface Gi0/0\n vrrp 1 ip ${vip1}${prio1 ? `\n vrrp 1 priority ${prio1}` : ''}\ninterface Gi0/1\n vrrp 2 ip ${vip2}${prio1 ? `\n vrrp 2 priority ${prio1}` : ''}` },
    { device: 'R2', text: `interface Gi0/0\n vrrp 1 ip ${vip1}\ninterface Gi0/1\n vrrp 2 ip ${vip2}` },
  ];
  return configQ(rng, {
    text: `LAN1(${lan1}.0/24)と LAN2(${lan2}.0/24)の間に R1(.1)と R2(.2)が並んでいる(図)。PC のデフォルトゲートウェイは仮想アドレス(LAN1 は ${vip1}、LAN2 は ${vip2})だが、VRRP はまだ設定されていない。R1 と R2 に VRRP を書き、普段は R1 が両方の LAN の代表(マスター)になり、R1 が止まったら R2 が代表になって PC1 と PC2 が往復で届き続けるようにせよ。LAN1 はグループ 1、LAN2 はグループ 2。設定できるのは R1・R2。\n決まり: 優先度(既定 100)が高い方が代表。同じならアドレスが大きい方(R2 の .2 の方が大きい)。preempt は既定で有効。\n書き方: interface の中で vrrp <グループ> ip <仮想アドレス>、vrrp <グループ> priority <1〜254>。`,
    spec, editable: ['R1', 'R2'], requirements,
    solution: cfg(prio),
    why: `両方の IF に同じ仮想アドレスを書き、R1 の優先度を既定の 100 より高く(${prio})する。優先度を書かないと同じ 100 どうしになり、アドレスの大きい R2(.2)が代表になってしまう。R2 だけに書く・R1 だけに書くと、片方が止まったときに代表がいない。`,
    wrongs: [cfg(null), [cfg(prio)[0]], [{ device: 'R1', text: `interface Gi0/0\n vrrp 1 ip ${vip1}\n vrrp 1 priority ${prio}` }, { device: 'R2', text: `interface Gi0/0\n vrrp 1 ip ${vip1}` }]],
    meta: { prio },
  });
}
function verifyVrrp(q) {
  const r = verifyConfig(q, 'Lv316');
  const st = sim.state(r.net);
  if (st.vrrp.length !== 2 || st.vrrp.some((g) => g.master !== 'R1' || g.backup !== 'R2')) throw new Error('Lv316: 代表が R1 でない');
  // 別の方法: 優先度 → アドレスの大きさで並べ直す
  for (const g of st.vrrp) { const sorted = g.members.slice().sort((a, b) => b.priority - a.priority || U.ipToInt(b.ip) - U.ipToInt(a.ip)); if (sorted[0].dev !== 'R1') throw new Error('Lv316: 並べ直すと R1 が先頭でない'); }
}

// ================= Lv317 リンク集約 =================
function lagQ(rng) {
  const A = sim.gen.addresses(rng); const lan = A.lan();
  const spec = {
    seed: rng.rand(0, 2 ** 31),
    devices: { SW1: { kind: 'switch', ifaces: [{ name: 'Gi1/0/23' }, { name: 'Gi1/0/24' }] }, SW2: { kind: 'switch', ifaces: [{ name: 'Gi1/0/23' }, { name: 'Gi1/0/24' }] }, PC1: { kind: 'host', ip: `${lan}.${rng.rand(10, 99)}/24` }, PC2: { kind: 'host', ip: `${lan}.${rng.rand(100, 200)}/24` } },
    links: [['PC1', 'SW1:Gi1/0/1'], ['PC2', 'SW2:Gi1/0/1'], ['SW1:Gi1/0/23', 'SW2:Gi1/0/23'], ['SW1:Gi1/0/24', 'SW2:Gi1/0/24']],
    layout: { pos: { PC1: [100, 300], SW1: [350, 300], SW2: [650, 300], PC2: [900, 300] } },
    editable: [], requirements: [], meta: { lan },
  };
  const gid = rng.pick([1, 2, 5]);
  const st = (d, p, k, v, text) => ({ kind: 'state', device: d, path: `ifByName.${p}.channelGroup.${k}`, equals: v, text });
  const requirements = [
    st('SW1', 'Gi1/0/23', 'id', gid, `SW1 の Gi1/0/23 が束 ${gid} に入っている`), st('SW1', 'Gi1/0/24', 'id', gid, `SW1 の Gi1/0/24 が束 ${gid} に入っている`),
    st('SW2', 'Gi1/0/23', 'id', gid, `SW2 の Gi1/0/23 が束 ${gid} に入っている`), st('SW2', 'Gi1/0/24', 'id', gid, `SW2 の Gi1/0/24 が束 ${gid} に入っている`),
    st('SW1', 'Gi1/0/23', 'mode', 'active', 'SW1 側は active(自分から知らせを送る)'), st('SW2', 'Gi1/0/23', 'mode', 'active', 'SW2 側も active'),
    { kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
  ].map((r, i) => ({ ...r, id: i + 1 }));
  return configQ(rng, {
    text: `SW1 と SW2 は Gi1/0/23 と Gi1/0/24 の 2 本でつながり、PC1(${ipOf(spec.devices.PC1.ip)})と PC2(${ipOf(spec.devices.PC2.ip)})は同じ網 ${lan}.0/24 にいる(図)。今は STP が片方を止めていて 1 本分しか使えない。2 本を LACP で 1 つの束(グループ ${gid})にまとめ、両方の線を使えるようにせよ。この問題の決まりとして両端とも active で組む。設定できるのは SW1・SW2。\n決まり: 両端が束の設定をしていて、少なくとも片方が active なら束になる(passive どうしは束にならない)。束になれば STP はその 2 本を 1 本の線として扱い、どちらも止めない。\n書き方: interface Gi1/0/23-24 の中で channel-group <番号> mode active。`,
    spec, editable: ['SW1', 'SW2'], requirements,
    solution: [{ device: 'SW1', text: `interface Gi1/0/23-24\n channel-group ${gid} mode active` }, { device: 'SW2', text: `interface Gi1/0/23-24\n channel-group ${gid} mode active` }],
    why: `両方のスイッチで、2 本のポートを同じグループ番号 ${gid} の束に入れ、active にする。片方だけ設定しても相手に束の設定が無いので束にならない。passive どうしは、どちらも知らせを待つだけなので束にならない。`,
    wrongs: [[{ device: 'SW1', text: `interface Gi1/0/23-24\n channel-group ${gid} mode active` }], [{ device: 'SW1', text: `interface Gi1/0/23-24\n channel-group ${gid} mode passive` }, { device: 'SW2', text: `interface Gi1/0/23-24\n channel-group ${gid} mode passive` }]],
    meta: { gid },
  });
}
function verifyLag(q) {
  const r = verifyConfig(q, 'Lv317');
  const st = sim.state(r.net);
  if (!st.lag.SW1 || !st.lag.SW1[q.meta.gid] || !st.lag.SW1[q.meta.gid].up) throw new Error('Lv317: 束が up でない');
  const roles = Object.values(st.stp.bridges).flatMap((b) => Object.values(b.ports)); if (roles.includes('alternate')) throw new Error('Lv317: 束なのに止まるポートがある');
  const before = sim.state(sim.build(q.sim.spec)); if (!Object.values(before.stp.bridges).flatMap((b) => Object.values(b.ports)).includes('alternate')) throw new Error('Lv317: 最初から止まるポートが無い');
}

// ================= Lv318 構成図: 信頼するポート =================
function trustQ(rng) {
  const A = sim.gen.addresses(rng); const lan = A.lan();
  const variant = rng.pick(['router', 'server']);
  const pcPorts = rng.shuffle([1, 2, 3, 4]).slice(0, 2).sort((a, b) => a - b);
  const srvPort = rng.pick([5, 6, 7, 8]);
  const pool = { pools: [{ name: 'LAN', network: `${lan}.0/24`, gateway: `${lan}.1`, exclude: [[`${lan}.1`, `${lan}.9`]] }] };
  const devices = {
    SW1: { kind: 'switch', dhcpSnooping: true },
    SW2: { kind: 'switch' },
    PC1: { kind: 'host', dhcp: true }, PC2: { kind: 'host', dhcp: true }, PC3: { kind: 'host', dhcp: true },
    R1: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: `${lan}.1/24` }] },
  };
  const links = [['PC1', `SW1:Gi1/0/${pcPorts[0]}`], ['PC2', `SW1:Gi1/0/${pcPorts[1]}`], ['SW1:Gi1/0/24', 'R1:Gi0/0'], ['SW1:Gi1/0/23', 'SW2:Gi1/0/24'], ['PC3', 'SW2:Gi1/0/1']];
  let answerPort;
  if (variant === 'router') { devices.R1.dhcp = pool; answerPort = 'Gi1/0/24'; }
  else { devices.DHCP1 = { kind: 'dhcp', ifaces: [{ name: 'Eth0', ip: `${lan}.${rng.rand(10, 20)}/24` }], dhcp: pool }; links.push(['DHCP1:Eth0', `SW1:Gi1/0/${srvPort}`]); answerPort = `Gi1/0/${srvPort}`; }
  const spec = { seed: rng.rand(0, 2 ** 31), devices, links, layout: { pos: { PC1: [120, 150], PC2: [120, 450], SW1: [420, 300], R1: [720, 150], SW2: [720, 450], PC3: [920, 450], DHCP1: [420, 90] } }, editable: [], requirements: [] };
  const ids = idsFor(rng, spec);
  const where = variant === 'router' ? 'R1(ルーター)が DHCP サーバーの役をしている' : 'DHCP サーバー DHCP1 が SW1 に直接つながっている';
  return {
    text: `SW1 で DHCP スヌーピングを有効にした。${where}。PC1・PC2・PC3 は DHCP でアドレスをもらう。SW1 のポートのうち、DHCP サーバーからの応答(OFFER・ACK)を通してよい「信頼するポート(trust)」にすべきポートを 1 つタップせよ。\n決まり: 信頼するポートは、DHCP サーバーへ向かうポートだけ。端末やほかのスイッチの先に正しいサーバーがいないポートは信頼しない(偽の DHCP サーバーの応答を止めるため)。`,
    diagram: sim.diagram(spec, { nodeIds: ids, showIps: true }),
    answerKind: 'tap', tap: { mode: 'port' }, accept: { ids: [`${ids.SW1}:${answerPort}`] },
    explanation: `正解は SW1 の ${answerPort}。${variant === 'router' ? 'DHCP サーバーの役をしている R1 へ向かう上流のポート' : 'DHCP1 がつながるポート'}だけを信頼する。PC のポートや、SW2(その先に PC3 しかいない)へのポートを信頼すると、そこにつないだ偽のサーバーの応答が通ってしまう。`,
    meta: { variant, answerPort },
  };
}
function verifyTrust(q) { // 別の方法: 図の線をたどって、DHCP の範囲を持つ機器に行き着く SW1 のポートを数える
  const d = q.diagram; const sw = d.nodes.find((n) => n.name === 'SW1');
  const poolHolder = new Set(['R1', 'DHCP1'].filter((n) => d.nodes.some((x) => x.name === n && (x.kind === 'router' ? q.meta.variant === 'router' : true))));
  const adj = {}; for (const l of d.links) { (adj[l.a.node] = adj[l.a.node] || []).push([l.b.node, l.a.port]); (adj[l.b.node] = adj[l.b.node] || []).push([l.a.node, l.b.port]); }
  const nameOf = (id) => d.nodes.find((n) => n.id === id).name;
  const hits = [];
  for (const [nb, port] of adj[sw.id]) {
    const seen = new Set([sw.id]); const stack = [nb]; let found = false;
    while (stack.length) { const c = stack.pop(); if (seen.has(c)) continue; seen.add(c); if (poolHolder.has(nameOf(c))) found = true; for (const [n2] of adj[c] || []) stack.push(n2); }
    if (found) hits.push(`${sw.id}:${port}`);
  }
  if (hits.length !== 1 || hits[0] !== q.accept.ids[0]) throw new Error(`Lv318: 信頼するポートが 1 つに決まらない ${hits}`);
  if (!sw.ports.some((p) => p.id === q.accept.ids[0])) throw new Error('Lv318: 正解のポートが図に無い');
}

// ================= Lv319 直す: 1 か所の誤り =================
const BREAKS_319 = ['route', 'mask', 'vlan', 'acl'];
function fixQ(rng) {
  for (;;) {
    const good = sim.gen.serial(rng, { routers: 2, hostsOnLan1: 2, switches: true });
    const { lan1, lan2 } = good.meta;
    good.devices.PC1.ip = `${lan1}.${freeHost(good, lan1, rng.shuffle([130, 140, 150, 160, 170, 180, 190, 200, 135, 145]))}/24`; // マスクの誤りで .1 が外に出る位置(PC3 と重ねない)
    const kind = rng.pick(BREAKS_319);
    const broken = U.clone(good);
    let culprit, solution, how;
    const r2gi0 = ipOf(good.devices.R2.ifaces[0].ip);
    if (kind === 'route') {
      culprit = 'R1'; const row = broken.devices.R1.routes.find((r) => r.prefix === `${lan2}.0/24`); const wrong = r2gi0.replace(/\.\d+$/, (m) => `.${Number(m.slice(1)) + 4}`); row.via = wrong;
      solution = [{ device: 'R1', text: `no ip route ${lan2}.0/24 ${wrong}\nip route ${lan2}.0/24 ${r2gi0}` }]; how = `R1 の ${lan2}.0/24 への経路の次の相手が ${wrong} になっていて、その番地に機器がいない(R2 は ${r2gi0})`;
    } else if (kind === 'mask') {
      culprit = 'PC1'; broken.devices.PC1.ip = `${ipOf(good.devices.PC1.ip)}/25`;
      solution = [{ device: 'PC1', text: `ip address ${good.devices.PC1.ip}` }]; how = `PC1 のマスクが /25 になっていて、ゲートウェイ ${lan1}.1 が自分の網の外に見える`;
    } else if (kind === 'vlan') {
      culprit = 'SW1'; broken.devices.SW1 = { kind: 'switch', vlans: [1, 20], ifaces: [{ name: 'Gi1/0/1', mode: 'access', vlan: 20 }] };
      solution = [{ device: 'SW1', text: 'interface Gi1/0/1\n switchport access vlan 1' }]; how = 'SW1 の Gi1/0/1(PC1)だけが VLAN 20 に入っていて、R1 のポート(VLAN 1)と別の VLAN';
    } else {
      culprit = 'R2'; const pc1 = ipOf(good.devices.PC1.ip);
      broken.devices.R2.acls = { A10: { type: 'standard', lines: [{ seq: 10, action: 'deny', src: `host ${pc1}` }, { seq: 20, action: 'permit', src: 'any' }] } }; broken.devices.R2.ifaces[0].aclIn = 'A10';
      solution = [{ device: 'R2', text: 'interface Gi0/0\n no acl A10 in' }]; how = `R2 の Gi0/0 の受信 ACL A10 が PC1(${pc1})を拒否している(この設計に ACL は無い)`;
    }
    const requirements = [
      { id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true },
      { id: 2, kind: 'reach', from: 'PC3', to: 'PC2', roundTrip: true },
      { id: 3, kind: 'reach', from: 'PC1', to: 'PC3', roundTrip: true },
    ];
    broken.editable = ['PC1', 'PC3', 'SW1', 'R1', 'R2']; broken.requirements = requirements;
    if (sim.check(sim.build(broken), requirements).every((x) => x.ok)) continue;
    let ok = true; try { uniqueCulprit(good, broken, culprit, requirements); } catch { ok = false; } if (!ok) continue;
    if (!sim.judgeConfig(broken, solution).ok) continue;
    const ids = idsFor(rng, broken);
    const design = { headers: ['項目', '設計'], rows: [['LAN1', `${lan1}.0/24(R1 の Gi0/0 が ${lan1}.1。PC1・PC3 のゲートウェイ)`], ['LAN2', `${lan2}.0/24(R2 の Gi0/1 が ${lan2}.1)`], ['R1–R2', `${ipOf(good.devices.R1.ifaces[1].ip)} と ${r2gi0}(/30)`], ['PC1', good.devices.PC1.ip], ['PC3', good.devices.PC3.ip], ['PC2', good.devices.PC2.ip], ['VLAN', 'すべてのポートが VLAN 1(アクセス)'], ['ACL', '使わない']] };
    return {
      text: `設計(表)どおりに組んだはずの網で、PC1 から PC2 に届かない。1 か所だけ設定が設計と違う。ターミナルで観測し(PC1 の ipconfig・ping・traceroute、R1・R2 の show ip route・show access-lists・show ip interface brief、SW1 の show vlan)、誤りのある機器を直して、PC1・PC3 と PC2 が往復で届くようにせよ。設定できるのは図の機器すべてだが、直すのは誤りの 1 か所だけでよい(要件を満たせば正解)。`,
      table: design,
      diagram: sim.diagram(broken, { nodeIds: ids, showIps: false }),
      terminal: { devices: ['PC1', 'PC3', 'R1', 'R2', 'SW1'], start: 'PC1' },
      answerKind: 'config', editable: broken.editable, configView: {}, requirementsText: reqTexts(requirements),
      sim: { spec: broken, requirements, good }, solution,
      explanation: `誤りは ${culprit}: ${how}。直し方の例:\n${cfgLines(solution)}\n観測の手がかり: ${{ route: 'PC1 からの traceroute が R1 で止まり、R1 の show ip route の次の相手が設計と違う', mask: 'PC1 の ipconfig のマスクが /25 で、ゲートウェイ ' + lan1 + '.1 に届かない(PC3 は届く)', vlan: 'PC1 だけゲートウェイにも PC3 にも届かず、SW1 の show vlan で Gi1/0/1 だけ VLAN 20', acl: 'PC3 は届くのに PC1 だけ届かず、R2 の show access-lists に PC1 を拒否する行' }[kind]}。ほかの書き方でも、要件を全部満たせば正解。`,
      meta: { kind, culprit },
    };
  }
}
function verifyFix(q) {
  const { spec, good, requirements } = q.sim;
  uniqueCulprit(good, spec, q.meta.culprit, requirements);
  const r = sim.judgeConfig(spec, q.solution); if (!r.ok) throw new Error(`Lv319: 直し方の例で直らない ${JSON.stringify(r.failed)}`);
  if (sim.judgeConfig(spec, []).ok) throw new Error('Lv319: 壊れていない');
  if (q.diagram.nodes.some((n) => n.note)) throw new Error('Lv319: 図にアドレスが出ている');
  const s = sim.session(spec, 'PC1'); if (!/届かない/.test(sim.exec(s, 'ping PC2'))) throw new Error('Lv319: ping が通る');
}

// ================= レベルの一覧 =================
const LEVELS = {
  257: gen('STP の優先度を書く', 'cl257-stp-priority-v1', stpQ, verifyStp),
  265: gen('再配送を書く', 'cl265-redistribute-v1', redistQ, verifyRedist),
  270: gen('DNS の別名の連鎖', 'cl270-dns-cname-chain-v1', dnsChainQ, verifyDnsChain),
  286: gen('要件から ACL を書く', 'cl286-acl-from-requirements-v1', aclReqQ, verifyAclReq),
  297: gen('コマンドで集める', 'cl297-collect-by-commands-v1', collectQ, verifyCollect),
  298: gen('ARP が埋まらない', 'cl298-arp-incomplete-v1', arpQ, verifyArp),
  309: gen('設定: ルーターの副 IF で VLAN 間', 'cl309-router-subif-v1', subifQ, verifySubif),
  310: gen('設定: OSPF を 1 エリアで', 'cl310-ospf-single-area-v1', ospfQ, verifyOspf),
  311: gen('設定: コストで寄せる', 'cl311-ospf-cost-steer-v1', costQ, verifyCost),
  312: gen('設定: 予備の静的経路', 'cl312-floating-static-v1', floatingQ, verifyFloating),
  313: gen('設定: IPv6 のアドレスと経路', 'cl313-ipv6-address-route-v1', ipv6Q, verifyIpv6),
  314: gen('設定: NAPT', 'cl314-napt-v1', naptQ, verifyNapt),
  315: gen('設定: ポートフォワード', 'cl315-port-forward-v1', pfQ, verifyPf),
  316: gen('設定: VRRP', 'cl316-vrrp-v1', vrrpQ, verifyVrrp),
  317: gen('設定: リンク集約', 'cl317-lacp-v1', lagQ, verifyLag),
  318: gen('構成図: 信頼するポート', 'cl318-dhcp-snooping-trust-v1', trustQ, verifyTrust),
  319: gen('直す: 1 か所の誤り', 'cl319-fix-one-error-v1', fixQ, verifyFix),
};

module.exports = { LEVELS, _test: { reqText, uniqueCulprit, BREAKS_297, BREAKS_319, CAUSES_298, stpSpec, vrrpSpec } };
