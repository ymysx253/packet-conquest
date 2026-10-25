'use strict';
// 構成図・設定・模擬ターミナルの問題(専門。新しい番号 322・324〜326・330・331・344・345・354〜360。docs/LEVEL-LIST.md 第 6 章)。
// 担当: Claude Fable 5.1(2026-10-25)。書き方は docs/questions/CL.md と docs/questions/SIM-API.md。模擬の本体は server/sim。
// 専門はヒントなし(解説だけ)。図(diagram)は必ず付ける。tap の正解は accept.ids、config の正解の例は solution(どちらも画面には送らない)。
// 構成は sim.gen の型から作り、そろった状態を壊す(plant-then-perturb)。verify は spec から独立に(総当たり・別の計算で)解き直す。
//
// ゲーム内の規則(問題文にも書く): 経路は直結 < 静的 < OSPF の優先度で最長一致、OSPF は IF のコストの合計が最小の道、状態を見る FW はポリシーに無い新しい通信を捨て返りは覚えて通す、
//   PC クラウドのサブネットは 0.0.0.0/0 の行き先(IGW = 公開、NAT GW = 非公開、無し = 隔離)で外との通信が決まる。
//
// sim に無いので問題の側で代わりにしたこと(sim に足してほしいこと):
//   - 322: IPsec のトンネルは無い。本社 R1 と支社 R2 の Gi0/2 どうしを「できあがったトンネル」として直接の線でつなぎ、守る範囲(互いの LAN)への静的経路をトンネルへ向ける問題にした。両端でそろえる項目は解説で
//   - 344: ping に大きさと分割禁止の引数が無い。分割禁止つき ping の結果を表で見せ、経路の MTU を数で答える
//   - 345: traceroute に時間(ms)が無い。線ごとの遅れ(delayMs)を問題側で持ち、traceroute の出力を表で見せる。答えは遅い線をタップ
//   - 359: 設定を段(工事前・工事後)で判定する口が無いので、工事前の設定だけを書かせ、工事後に戻すことは解説で書く
//   - 設定の問題はすべて「止める」要件(expect: false)を入れる決まりだが、359(切り替え)だけは止める相手がいないので failover(切っても届く)を代わりにしている
const sim = require('../../sim');
const { addresses, cidr24, p2pIps } = sim.gen;

// ================= 共通の道具 =================
const HEX = '0123456789abcdef';
const randId = (rng) => Array.from({ length: 6 }, () => HEX[rng.rand(0, 15)]).join('');
// 機器名 → 問題ごとの乱数 id(図のタップは id で答える。名前は入れない)
function nodeIdsOf(rng, spec) { const m = {}; const used = new Set(); for (const n of Object.keys(spec.devices)) { let id; do { id = randId(rng); } while (used.has(id)); used.add(id); m[n] = id; } return m; }
const invert = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
const diagramOf = (spec, ids, opts = {}) => sim.diagram(spec, { nodeIds: ids, showIps: true, ...opts });
// 図の線の id(機器名 2 つから)
function linkIdOf(dg, ids, a, b) { const A = ids[a], B = ids[b]; const l = dg.links.find((x) => (x.a.node === A && x.b.node === B) || (x.a.node === B && x.b.node === A)); return l ? l.id : null; }
const nameOfId = (ids, id) => invert(ids)[id];
const list = (xs) => xs.join('・');
const nameOf = (ids, id) => invert(ids)[String(id).split(':')[0]];
// 設定の問題の共通の形
function configQ({ spec, ids, text, requirements, reqText, solution, explanation, meta, hide = {}, viewDevs = null, terminal = null, extraDiagram = null, configView: cv = null }) {
  const s = { ...spec, requirements };
  const net = sim.build(s);
  const configView = cv || {};
  if (!cv) for (const d of viewDevs || s.editable) configView[d] = sim.runningConfig(net, d, { hide: hide[d] || [] });
  const q = {
    text, answerKind: 'config', diagram: extraDiagram || diagramOf(s, ids), editable: s.editable.slice(), configView,
    requirementsText: requirements.map((r) => ({ id: r.id, text: reqText[r.id] })),
    sim: { spec: s, requirements }, solution, explanation, meta,
  };
  if (terminal) q.terminal = terminal;
  return q;
}
const tapQ = ({ text, diagram, mode, answerIds, explanation, meta, tables = null, terminal = null, spec, table = null }) => {
  const q = { text, answerKind: 'tap', tap: { mode }, diagram: tables ? { ...diagram, tables } : diagram, accept: { ids: mode === 'many' ? answerIds.slice().sort() : answerIds.slice() }, explanation, meta, sim: { spec } };
  if (terminal) q.terminal = terminal;
  if (table) q.table = table;
  return q;
};
// 正解の例が要件を全部満たし、わざと壊した答えが満たさないことを確かめる(config の verify の土台)
function verifyConfig(q, brokenList) {
  const ok = sim.judgeConfig(q.sim.spec, q.solution);
  if (!ok.ok) throw new Error(`${q.kind}: 正解の例が通らない(${ok.failed.join(',')} ${ok.errors.map((e) => `${e.device} 行 ${e.line}: ${e.message}`).join(' / ')})`);
  const empty = sim.judgeConfig(q.sim.spec, []); if (empty.ok) throw new Error(`${q.kind}: 何も書かなくても通る`);
  for (const b of brokenList || []) { const r = sim.judgeConfig(q.sim.spec, b); if (r.ok) throw new Error(`${q.kind}: 壊した答えが通る`); }
}
// 要件の文(共通)
const rt = {
  reach: (a, b, what = 'ping') => `${a} から ${b} へ ${what} が届く(往復)`,
  noreach: (a, b, what = 'ping') => `${a} から ${b} へ ${what} は届かない(止める)`,
};

// ================= Lv322 拠点間 VPN を書く(config) =================
const TUN = ['10.255.0.1', '10.255.0.2'];
function vpnQ(rng) {
  const spec = sim.gen.twoSites(rng);
  const { hq, br } = spec.meta;
  const t = spec.devices;
  // トンネル(できあがった IPsec のトンネルを、R1 と R2 の Gi0/2 どうしの線として見せる)。守る範囲への経路は消してある
  t.R1.ifaces.push({ name: 'Gi0/2', ip: `${TUN[0]}/30` }); t.R2.ifaces.push({ name: 'Gi0/2', ip: `${TUN[1]}/30` });
  t.R1.routes = [{ prefix: '0.0.0.0/0', via: '203.0.113.254' }]; t.R2.routes = [{ prefix: '0.0.0.0/0', via: '203.0.113.254' }];
  spec.links.push(['R1:Gi0/2', 'R2:Gi0/2']);
  spec.editable = ['R1', 'R2'];
  const ids = nodeIdsOf(rng, spec);
  const srvPort = spec.meta.srvPort;
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC1', to: 'PC2' },
    { id: 2, kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: srvPort },
    { id: 3, kind: 'route', device: 'R1', prefix: `${br}.0/24`, via: TUN[1] },
    { id: 4, kind: 'route', device: 'R2', prefix: `${hq}.0/24`, via: TUN[0] },
    { id: 5, kind: 'reach', from: 'INET', to: 'PC2', expect: false },
  ];
  const reqText = { 1: rt.reach('本社の PC1', '支社の PC2'), 2: `支社の PC2 から本社の SRV1 へ TCP ${srvPort} が届く`, 3: `R1 の経路表で、支社の網 ${br}.0/24 の次の相手がトンネルの向こう ${TUN[1]} になっている(トンネルを通す)`, 4: `R2 の経路表で、本社の網 ${hq}.0/24 の次の相手がトンネルの向こう ${TUN[0]} になっている`, 5: rt.noreach('外(INET)', '支社の PC2') };
  const solution = [{ device: 'R1', text: `ip route ${br}.0/24 ${TUN[1]}` }, { device: 'R2', text: `ip route ${hq}.0/24 ${TUN[0]}` }];
  const dg = diagramOf(spec, ids);
  for (const l of dg.links) if ((l.a.node === ids.R1 && l.b.node === ids.R2) || (l.a.node === ids.R2 && l.b.node === ids.R1)) { l.label = `VPN トンネル ${TUN[0]}/30 – ${TUN[1]}/30`; l.style = 'dash'; }
  return configQ({
    spec, ids, requirements, reqText, solution, extraDiagram: dg,
    text: `本社(LAN ${hq}.0/24)と支社(LAN ${br}.0/24)の間に、インターネット越しの拠点間 VPN(IPsec)を張った。両端の IKE の版・暗号・鍵・相手のアドレスはそろっていて、トンネルは上がっている(図の点線。R1 と R2 の Gi0/2 がトンネルの両端で、${TUN[0]}/30 と ${TUN[1]}/30)。あとは「守る範囲」(互いの LAN)への経路をトンネルへ向けるだけになっている。R1 と R2 に設定を書き、要件を全部満たせ。経路は直結 < 静的の順に優先し、最長一致で引く。`,
    explanation: `正しい設定の例:\nR1\n  ip route ${br}.0/24 ${TUN[1]}\nR2\n  ip route ${hq}.0/24 ${TUN[0]}\n拠点間 VPN では、トンネルの両端でそろえる項目(IKE の版・暗号・ハッシュ・DH グループ・事前共有鍵・相手の外側のアドレス・守る範囲が鏡写し)に加えて、「守る範囲宛の通信がトンネルに入る」ように経路を向ける必要がある。次の相手を ISP 側(203.0.113.x)にすると、暗号化されずに外の網へ出て届かない(今回は外に経路が無いので止まる)。ほかの書き方でも要件を全部満たせば正解。`,
    meta: { kind: 'vpn' },
  });
}
function verifyVpn(q) {
  const { hq, br } = q.sim.spec.meta;
  verifyConfig(q, [
    [{ device: 'R1', text: `ip route ${br}.0/24 203.0.113.2` }, { device: 'R2', text: `ip route ${hq}.0/24 203.0.113.1` }], // ISP 側へ向ける(トンネルを通らない)
    [{ device: 'R1', text: `ip route ${br}.0/24 ${TUN[1]}` }], // 片側だけ
  ]);
}

// ================= Lv324・325 ハブとスポーク =================
// 本社 R1(PC1・SW1)、支社 A の R2(PC2)、支社 B の R3(PC3)。外の網 203.0.113.0/24 の ISP(スイッチ)でつながる。支社どうしは本社経由
function hubSpokeSpec(rng) {
  const A = addresses(rng); const hq = A.lan(), brA = A.lan(), brB = A.lan();
  const dev = {
    PC1: { kind: 'host', ip: cidr24(hq, rng.rand(10, 200)), gateway: `${hq}.1` },
    SW1: { kind: 'switch' },
    R1: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(hq, 1) }, { name: 'Gi0/1', ip: '203.0.113.1/24' }], routes: [{ prefix: `${brA}.0/24`, via: '203.0.113.2' }, { prefix: `${brB}.0/24`, via: '203.0.113.3' }, { prefix: '0.0.0.0/0', via: '203.0.113.254' }] },
    ISP: { kind: 'switch' },
    INET: { kind: 'internet', ip: '203.0.113.254/24' },
    R2: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(brA, 1) }, { name: 'Gi0/1', ip: '203.0.113.2/24' }], routes: [{ prefix: '0.0.0.0/0', via: '203.0.113.1' }] },
    PC2: { kind: 'host', ip: cidr24(brA, rng.rand(10, 200)), gateway: `${brA}.1` },
    R3: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(brB, 1) }, { name: 'Gi0/1', ip: '203.0.113.3/24' }], routes: [{ prefix: '0.0.0.0/0', via: '203.0.113.1' }] },
    PC3: { kind: 'host', ip: cidr24(brB, rng.rand(10, 200)), gateway: `${brB}.1` },
  };
  const links = [['PC1', 'SW1:Gi1/0/1'], ['SW1:Gi1/0/24', 'R1:Gi0/0'], ['R1:Gi0/1', 'ISP:Gi1/0/1'], ['INET', 'ISP:Gi1/0/4'], ['R2:Gi0/1', 'ISP:Gi1/0/2'], ['R2:Gi0/0', 'PC2'], ['R3:Gi0/1', 'ISP:Gi1/0/3'], ['R3:Gi0/0', 'PC3']];
  const layout = { w: 1000, h: 600, pos: { PC1: [500, 520], SW1: [500, 430], R1: [500, 320], ISP: [500, 180], INET: [500, 60], R2: [180, 180], PC2: [60, 180], R3: [820, 180], PC3: [940, 180] } };
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout, meta: { hq, brA, brB } };
}
const HUB_RULE = '経路は直結 < 静的の順に優先し、最長一致で引く。ISP の網(203.0.113.0/24)は本社と支社が直接つながる外の網で、ここでは暗号や NAT は考えない。';
function hubSpokeQ(rng) {
  const spec = hubSpokeSpec(rng); const { hq, brA, brB } = spec.meta;
  // 壊す: 支社のデフォルトルートと、本社の支社向けの経路を消す(デフォルトは残す)
  spec.devices.R1.routes = [{ prefix: '0.0.0.0/0', via: '203.0.113.254' }];
  spec.devices.R2.routes = []; spec.devices.R3.routes = [];
  spec.editable = ['R1', 'R2', 'R3'];
  const ids = nodeIdsOf(rng, spec);
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC2', to: 'PC1' },
    { id: 2, kind: 'reach', from: 'PC3', to: 'PC1' },
    { id: 3, kind: 'path', from: 'PC2', to: 'PC3', via: ['R2', 'R1', 'R3'] },
    { id: 4, kind: 'path', from: 'PC3', to: 'PC2', via: ['R3', 'R1', 'R2'] },
    { id: 5, kind: 'reach', from: 'INET', to: 'PC2', expect: false },
  ];
  const reqText = { 1: rt.reach('支社 A の PC2', '本社の PC1'), 2: rt.reach('支社 B の PC3', '本社の PC1'), 3: `支社 A の PC2 から支社 B の PC3 へは、R2 → R1 → R3 の順(本社を通って)で届く`, 4: `支社 B の PC3 から支社 A の PC2 へは、R3 → R1 → R2 の順で届く`, 5: rt.noreach('外(INET)', '支社 A の PC2') };
  const solution = [
    { device: 'R1', text: `ip route ${brA}.0/24 203.0.113.2\nip route ${brB}.0/24 203.0.113.3` },
    { device: 'R2', text: 'ip route 0.0.0.0/0 203.0.113.1' },
    { device: 'R3', text: 'ip route 0.0.0.0/0 203.0.113.1' },
  ];
  return configQ({
    spec, ids, requirements, reqText, solution,
    text: `本社(R1。LAN ${hq}.0/24)と支社 A(R2。LAN ${brA}.0/24)・支社 B(R3。LAN ${brB}.0/24)を、ハブ(本社)とスポーク(支社)の形でつなぐ。支社の通信は全部いったん本社を通す決まり(支社どうしも本社経由)。R1 は外(INET 203.0.113.254)へのデフォルトルートだけ、R2・R3 は経路を何も持っていない。R1・R2・R3 に静的経路を書き、要件を全部満たせ。${HUB_RULE}`,
    explanation: `正しい設定の例:\nR1\n  ip route ${brA}.0/24 203.0.113.2\n  ip route ${brB}.0/24 203.0.113.3\nR2\n  ip route 0.0.0.0/0 203.0.113.1\nR3\n  ip route 0.0.0.0/0 203.0.113.1\n支社(スポーク)はデフォルトルートを本社(ハブ)へ向けるだけでよく、本社は支社ごとの網を静的に持つ。支社に相手の支社の網を直接(203.0.113.3 など)向けると本社を通らず、要件 3・4 に反する。外(INET)から支社へは経路が無いので届かない(要件 5)。ほかの書き方でも要件を全部満たせば正解。`,
    meta: { kind: 'hub' },
  });
}
function verifyHubSpoke(q) {
  const { brA, brB, hq } = q.sim.spec.meta;
  verifyConfig(q, [
    [{ device: 'R1', text: `ip route ${brA}.0/24 203.0.113.2\nip route ${brB}.0/24 203.0.113.3` }, { device: 'R2', text: `ip route 0.0.0.0/0 203.0.113.1\nip route ${brB}.0/24 203.0.113.3` }, { device: 'R3', text: 'ip route 0.0.0.0/0 203.0.113.1' }], // 支社どうし直接(本社を通らない)
    [{ device: 'R2', text: 'ip route 0.0.0.0/0 203.0.113.1' }, { device: 'R3', text: 'ip route 0.0.0.0/0 203.0.113.1' }], // 本社の戻りの経路が無い
    [{ device: 'R1', text: `ip route ${hq}.0/24 203.0.113.2` }], // 無意味
  ]);
}
function spokeOrderQ(rng) {
  const spec = hubSpokeSpec(rng); const { brA, brB } = spec.meta;
  const ids = nodeIdsOf(rng, spec);
  const dir = rng.pick(['AB', 'BA', 'A1', 'B1']);
  const [from, to] = { AB: ['PC2', 'PC3'], BA: ['PC3', 'PC2'], A1: ['PC2', 'PC1'], B1: ['PC3', 'PC1'] }[dir];
  const net = sim.build(spec);
  const r = sim.reach(net, from, to, { roundTrip: false });
  const routers = r.path.filter((n) => spec.devices[n].kind === 'router');
  const site = (pc) => ({ PC1: '本社', PC2: `支社 A(${brA}.0/24)`, PC3: `支社 B(${brB}.0/24)` }[pc]);
  return tapQ({
    mode: 'order', diagram: diagramOf(spec, ids), spec, answerIds: routers.map((n) => ids[n]),
    text: `本社(R1)と支社 A(R2)・支社 B(R3)はハブとスポークの形で、支社のルーターはデフォルトルートを本社 R1 へ向け、R1 は各支社の網への静的経路を持つ(各ルーターの経路表は機器の「表を見る」で見られる)。${site(from)}の ${from} から${site(to)}の ${to} へのパケットが通るルーターを、通る順にタップせよ(ルーターだけ)。`,
    tables: Object.fromEntries(['R1', 'R2', 'R3'].map((d) => [ids[d], [{ title: `${d} の経路表`, headers: ['宛先', '次の相手'], rows: (spec.devices[d].routes).map((x) => [x.prefix, x.via]).concat([[`直結`, spec.devices[d].ifaces.map((f) => f.ip).join('、')]]) }]])),
    explanation: `正解は ${routers.join(' → ')}。${from} はゲートウェイ ${routers[0]} に送る。${routers.length === 3 ? `${routers[0]} の経路表には相手の支社の網が無く、デフォルトルートで本社 R1 へ送る。R1 は相手の支社の網 ${to === 'PC3' ? brB : brA}.0/24 への静的経路で ${routers[2]} へ送り、${routers[2]} が ${to} に届ける。支社どうしが直接やりとりする道は無い(ハブとスポーク)。` : `${routers[0]} のデフォルトルートで本社 R1 へ送られ、R1 が本社の LAN の ${to} に届ける。`}`,
    meta: { kind: 'order', dir, n: routers.length },
  });
}
function verifySpokeOrder(q) { // 図の表(経路表)だけで独立にたどる。デフォルトと静的だけの小さな転送
  const m = /の (PC\d) から.*?の (PC\d) へ/.exec(q.text); const from = m[1], to = m[2];
  const gw = { PC1: 'R1', PC2: 'R2', PC3: 'R3' };
  const tblOf = {}; for (const [id, tabs] of Object.entries(q.diagram.tables)) tblOf[/^(R\d) の経路表/.exec(tabs[0].title)[1]] = { id, rows: tabs[0].rows };
  const { brA, brB } = q.sim.spec.meta;
  const dstNet = to === 'PC2' ? `${brA}.0/24` : to === 'PC3' ? `${brB}.0/24` : null; // PC1 の網は R1 の直結
  const ofIp = { '203.0.113.1': 'R1', '203.0.113.2': 'R2', '203.0.113.3': 'R3' };
  let cur = gw[from]; const order = [cur];
  for (let i = 0; i < 4 && cur !== gw[to]; i++) {
    const rows = tblOf[cur].rows;
    const hit = dstNet ? rows.find((r) => r[0] === dstNet) : null;
    const next = hit ? hit[1] : (rows.find((r) => r[0] === '0.0.0.0/0') || [])[1];
    const nd = ofIp[next]; if (!nd) break; order.push(nd); cur = nd;
  }
  if (cur !== gw[to]) throw new Error('Lv325: 表からたどり着けない');
  const want = order.map((n) => tblOf[n].id);
  if (JSON.stringify(q.accept.ids) !== JSON.stringify(want)) throw new Error(`Lv325: 順が違う ${order.join('>')}`);
}

// ================= Lv326 1 か所で止まる所(tap one) =================
// 冗長のある所と無い所を作る: 片方の拠点のゲートウェイは VRRP の 2 台、間は 2 本の道、もう片方は 1 台(単一障害点)。variant: 'pc2side'(R4 が唯一)・'pc1side'(R1 が唯一)・'middle'(真ん中の R3 が唯一)
function spofSpec(rng, variant) {
  const A = addresses(rng); const lan1 = A.lan(), lan2 = A.lan();
  const o = { networks: [A.block], area: 0 };
  const dev = {}; const links = []; const pos = {};
  const vip1 = `${lan1}.1`, vip2 = `${lan2}.1`;
  dev.PC1 = { kind: 'host', ip: cidr24(lan1, rng.rand(10, 200)), gateway: vip1 }; dev.SW1 = { kind: 'switch' };
  dev.PC2 = { kind: 'host', ip: cidr24(lan2, rng.rand(10, 200)), gateway: vip2 }; dev.SW2 = { kind: 'switch' };
  links.push(['PC1', 'SW1:Gi1/0/1'], ['PC2', 'SW2:Gi1/0/1']);
  pos.PC1 = [60, 300]; pos.SW1 = [170, 300]; pos.PC2 = [940, 300]; pos.SW2 = [830, 300];
  const pair = (names, lan, vip, swName, x) => { // VRRP の 2 台
    names.forEach((n, i) => {
      dev[n] = { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(lan, 2 + i), vrrp: { group: 1, vip, priority: i === 0 ? 120 : 100 } }], ospf: o };
      links.push([`${n}:Gi0/0`, `${swName}:Gi1/0/${2 + i}`]); pos[n] = [x, i === 0 ? 150 : 450];
    });
  };
  const single = (n, lan, x) => { dev[n] = { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(lan, 2), vrrp: { group: 1, vip: `${lan}.1`, priority: 120 } }], ospf: o }; links.push([`${n}:Gi0/0`, `${lan === lan1 ? 'SW1' : 'SW2'}:Gi1/0/2`]); pos[n] = [x, 300]; };
  const p2p = (a, b, ia, ib, cost = 1) => { const [pa, pb] = p2pIps(A.p2p()); dev[a].ifaces.push({ name: ia, ip: pa, ospfCost: cost }); dev[b].ifaces.push({ name: ib, ip: pb, ospfCost: cost }); links.push([`${a}:${ia}`, `${b}:${ib}`]); };
  let answer;
  if (variant === 'pc2side') { pair(['R1', 'R2'], lan1, vip1, 'SW1', 330); single('R4', lan2, 670); p2p('R1', 'R4', 'Gi0/1', 'Gi0/1'); p2p('R2', 'R4', 'Gi0/1', 'Gi0/2'); answer = 'R4'; }
  else if (variant === 'pc1side') { single('R1', lan1, 330); pair(['R3', 'R4'], lan2, vip2, 'SW2', 670); p2p('R1', 'R3', 'Gi0/1', 'Gi0/1'); p2p('R1', 'R4', 'Gi0/2', 'Gi0/1'); answer = 'R1'; }
  else { pair(['R1', 'R2'], lan1, vip1, 'SW1', 290); dev.R3 = { kind: 'router', ifaces: [], ospf: o }; pos.R3 = [500, 300]; pair(['R4', 'R5'], lan2, vip2, 'SW2', 710); p2p('R1', 'R3', 'Gi0/1', 'Gi0/0'); p2p('R2', 'R3', 'Gi0/1', 'Gi0/1'); p2p('R3', 'R4', 'Gi0/2', 'Gi0/1'); p2p('R3', 'R5', 'Gi0/3', 'Gi0/1'); answer = 'R3'; }
  return { spec: { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout: { w: 1000, h: 600, pos }, meta: { lan1, lan2, variant } }, answer };
}
function spofQ(rng) {
  const variant = rng.pick(['pc2side', 'pc1side', 'middle']);
  const { spec, answer } = spofSpec(rng, variant);
  const ids = nodeIdsOf(rng, spec);
  const routers = Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'router');
  const red = routers.filter((n) => n !== answer);
  return tapQ({
    mode: 'one', diagram: diagramOf(spec, ids), spec, answerIds: [ids[answer]],
    text: `PC1(${spec.devices.PC1.ip})と PC2(${spec.devices.PC2.ip})の間の構成は図のとおり。ルーターは OSPF で経路を交換し、同じ LAN に 2 台あるルーターは VRRP で 1 つのゲートウェイ(仮想アドレス)を分け合っている(片方が止まればもう片方が引き継ぐ)。ルーターのうち、その 1 台が止まると PC1 と PC2 の通信が必ず止まるもの(単一障害点)をタップせよ。`,
    explanation: `正解は ${answer}。${answer} は ${variant === 'middle' ? '両側の 2 台ずつをつなぐ真ん中の 1 台で、代わりの道が無い' : `${answer === 'R1' ? 'PC1' : 'PC2'} 側のゲートウェイが 1 台だけで、VRRP の相方も別の道も無い`}。ほかのルーター(${list(red)})は、同じ役目の相方(VRRP の 2 台・2 本の道)があるので、1 台止まっても通信は続く。冗長化は「どこか 1 か所でも 1 台しか無ければ、そこが全体の弱点になる」ことを図で確かめる。`,
    meta: { kind: 'spof', variant },
  });
}
function verifySpof(q, spec) { // 機器を 1 台ずつ止めて reach を総当たり
  const net = sim.build(spec);
  const routers = Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'router');
  if (!sim.reach(net, 'PC1', 'PC2').ok) throw new Error('Lv326: そろった状態で届かない');
  const dead = routers.filter((r) => !sim.check(net, [{ id: 1, kind: 'failover', down: [r], then: { kind: 'reach', from: 'PC1', to: 'PC2' } }])[0].ok);
  if (dead.length !== 1) throw new Error(`Lv326: 単一障害点が ${dead.join(',')}`);
  const want = Object.entries(q.diagram.nodes.reduce((m, n) => { m[n.name] = n.id; return m; }, {})).find(([n]) => n === dead[0])[1];
  if (q.accept.ids[0] !== want) throw new Error('Lv326: 答えが違う');
}

// ================= Lv330・331 DMZ と FW のポリシー =================
// FW1: Gi0/0 = inside(SW1・PC1)、Gi0/1 = dmz(SW2・SRV1)、Gi0/2 = outside(ISP・INET)。DMZ は文書用の 198.51.100.0/24、外は 203.0.113.0/24
function dmzSpec(rng, { withPolicies }) {
  const A = addresses(rng); const inside = A.lan(); const dmz = '198.51.100';
  const srvHost = rng.rand(10, 200);
  const dev = {
    PC1: { kind: 'host', ip: cidr24(inside, rng.rand(10, 99)), gateway: `${inside}.1` }, SW1: { kind: 'switch' },
    SRV2: { kind: 'server', ip: cidr24(inside, rng.rand(100, 200)), gateway: `${inside}.1`, listen: [{ proto: 'tcp', port: 445 }] }, // 内側のファイルサーバー(公開しないもの。330 の誤答の候補)
    SRV1: { kind: 'server', ip: cidr24(dmz, srvHost), gateway: `${dmz}.1`, listen: [{ proto: 'tcp', port: 443 }, { proto: 'tcp', port: 22 }] }, SW2: { kind: 'switch' },
    FW1: { kind: 'firewall', ifaces: [{ name: 'Gi0/0', ip: cidr24(inside, 1) }, { name: 'Gi0/1', ip: cidr24(dmz, 1) }, { name: 'Gi0/2', ip: '203.0.113.1/24' }], routes: [{ prefix: '0.0.0.0/0', via: '203.0.113.254' }],
      zones: { inside: ['Gi0/0'], dmz: ['Gi0/1'], outside: ['Gi0/2'] },
      policies: withPolicies ? [{ from: 'outside', to: 'dmz', proto: 'tcp', dport: 443, action: 'permit' }, { from: 'inside', to: 'dmz', proto: 'tcp', dport: 443, action: 'permit' }, { from: 'inside', to: 'outside', proto: 'tcp', dport: 443, action: 'permit' }] : [] },
    ISP: { kind: 'switch' },
    INET: { kind: 'internet', ip: '203.0.113.254/24', gateway: '203.0.113.1' },
  };
  const links = [['PC1', 'SW1:Gi1/0/1'], ['SRV2', 'SW1:Gi1/0/2'], ['SW1:Gi1/0/24', 'FW1:Gi0/0'], ['SRV1', 'SW2:Gi1/0/1'], ['SW2:Gi1/0/24', 'FW1:Gi0/1'], ['FW1:Gi0/2', 'ISP:Gi1/0/1'], ['INET', 'ISP:Gi1/0/2']];
  const flip = rng.next() < 0.5; // 内側と DMZ の上下を入れ替える(位置で覚えないように)
  const yIn = flip ? 460 : 140, yDmz = flip ? 140 : 460;
  const layout = { w: 1000, h: 600, pos: { PC1: [70, yIn - 70], SRV2: [70, yIn + 70], SW1: [250, yIn], SRV1: [70, yDmz], SW2: [250, yDmz], FW1: [480, 300], ISP: [700, 300], INET: [900, 300] } };
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout, meta: { inside, dmz, srvHost } };
}
function dmzQ(rng) {
  const spec = dmzSpec(rng, { withPolicies: true });
  const askSrv = rng.next() < 0.5; // 問い方: 置く場所(セグメント = スイッチ)をタップ / 公開サーバーをタップ
  const ids = nodeIdsOf(rng, spec);
  const dg = diagramOf(spec, ids, { showIps: true });
  const zoneNote = { SW1: '内側(inside)の LAN', SW2: 'DMZ', ISP: '外(outside)' };
  for (const n of dg.nodes) if (zoneNote[n.name]) n.note = zoneNote[n.name];
  // 置く場所の問題では、公開サーバーの名前と場所を見せない(SRV1 を「置く前」にする)
  if (!askSrv) { for (const n of dg.nodes) if (n.name === 'SRV1') { n.name = '?'; n.note = 'ここに置く候補'; n.kind = 'server'; } }
  return tapQ({
    mode: 'one', diagram: dg, spec, answerIds: [ids[askSrv ? 'SRV1' : 'SW2']],
    text: askSrv
      ? `FW1 は内側(inside。LAN ${spec.meta.inside}.0/24)・DMZ(${spec.meta.dmz}.0/24)・外(outside)の 3 つの区域を分けている(図)。ポリシーは「外 → DMZ の TCP 443」「内側 → DMZ の TCP 443」「内側 → 外の TCP 443」だけ許可し、ほかは捨てる。この構成で、外(インターネット)から直接つながれる(公開されている)サーバーをタップせよ。`
      : `FW1 は内側(inside。LAN ${spec.meta.inside}.0/24)・DMZ(${spec.meta.dmz}.0/24)・外(outside)の 3 つの区域を分けている(図)。これから、外(インターネット)に公開する Web サーバー(TCP 443)を 1 台置く。外から直接つながれても、内側の LAN(PC1 など)には手が届かないようにしたい。サーバーをつなぐスイッチ(置く区域)をタップせよ。`,
    explanation: askSrv
      ? `正解は SRV1(DMZ)。外から始める通信を FW1 が通すのは「外 → DMZ の TCP 443」だけなので、外から直接つながれるのは DMZ にある SRV1 だけ。内側の PC1 へは外からの通信を通す行が無く、届かない。`
      : `正解は DMZ のスイッチ(SW2)。公開サーバーは、外から直接つながれる区域(DMZ)に置き、内側の LAN とは FW で区切る。こうすると、公開サーバーが乗っ取られても、DMZ → 内側の通信を FW が止めるので内側に手が届かない。内側の LAN に置くと、外から内側へ穴を開けることになり、外の網に置くと FW で守れない。`,
    meta: { kind: 'dmz', askSrv },
  });
}
function verifyDmz(q) { // 図だけから: DMZ の印のあるスイッチと、そこにつながるサーバー
  const dmzSw = q.diagram.nodes.find((n) => n.note === 'DMZ'); if (!dmzSw) throw new Error('Lv330: DMZ の印が無い');
  const srvs = q.diagram.links.filter((l) => l.a.node === dmzSw.id || l.b.node === dmzSw.id).map((l) => (l.a.node === dmzSw.id ? l.b.node : l.a.node)).map((id) => q.diagram.nodes.find((n) => n.id === id)).filter((n) => n.kind === 'server');
  if (srvs.length !== 1) throw new Error('Lv330: DMZ のサーバーが 1 台でない');
  const servers = q.diagram.nodes.filter((n) => n.kind === 'server'); if (servers.length < 2) throw new Error('Lv330: サーバーが 1 台しかない(選ぶ意味が無い)');
  const ans = q.meta.askSrv ? srvs[0].id : dmzSw.id;
  if (q.accept.ids[0] !== ans) throw new Error('Lv330: 答えが違う');
  if (!/DMZ/.test(q.explanation)) throw new Error('Lv330: 解説');
}
const FW_RULE = 'FW1 は状態を見る FW で、新しく始める通信は「policy <送信元の区域> <宛先の区域> permit|deny [tcp|udp|icmp|ip] [eq <ポート>]」の行に合う最初のものに従い、合う行が無ければ捨てる。通した通信の返りは覚えていて通す。';
function fwPolicyQ(rng) {
  const spec = dmzSpec(rng, { withPolicies: false }); spec.editable = ['FW1'];
  const { srvHost, dmz } = spec.meta;
  const ids = nodeIdsOf(rng, spec);
  const requirements = [
    { id: 1, kind: 'reach', from: 'INET', to: 'SRV1', proto: 'tcp', port: 443 },
    { id: 2, kind: 'reach', from: 'PC1', to: 'SRV1', proto: 'tcp', port: 443 },
    { id: 3, kind: 'reach', from: 'PC1', to: 'INET', proto: 'tcp', port: 443 },
    { id: 4, kind: 'reach', from: 'INET', to: 'PC1', expect: false },
    { id: 5, kind: 'reach', from: 'SRV1', to: 'PC1', expect: false },
  ];
  const reqText = { 1: `外(INET)から DMZ の SRV1(${dmz}.${srvHost})へ TCP 443(Web)が届く`, 2: '内側の PC1 から DMZ の SRV1 へ TCP 443 が届く', 3: '内側の PC1 から外(INET)へ TCP 443 が届く', 4: '外(INET)から内側の PC1 へは何も届かない(止める)', 5: 'DMZ の SRV1 から内側の PC1 へは ping も届かない(止める。DMZ が乗っ取られても内側に入れない)' };
  const solution = [{ device: 'FW1', text: 'policy outside dmz permit tcp eq 443\npolicy inside dmz permit tcp eq 443\npolicy inside outside permit tcp eq 443' }];
  return configQ({
    spec, ids, requirements, reqText, solution,
    text: `FW1 は内側(inside: Gi0/0。LAN ${spec.meta.inside}.0/24)・DMZ(dmz: Gi0/1。${dmz}.0/24。Web サーバー SRV1 は ${dmz}.${srvHost})・外(outside: Gi0/2)の 3 つの区域を分けている(図)。今はポリシーが 1 行も無く、どの区域の間も通らない。必要な通信だけを通すポリシーを FW1 に書き、要件を全部満たせ。${FW_RULE}`,
    explanation: `正しい設定の例:\nFW1\n  policy outside dmz permit tcp eq 443\n  policy inside dmz permit tcp eq 443\n  policy inside outside permit tcp eq 443\n必要な 3 つの通信だけを許可し、ほかは「合う行が無ければ捨てる」に任せる。外 → 内側、DMZ → 内側の行は書かない(書かないことが止めること)。「policy outside inside permit ip」のように広く開けると要件 4 に、「policy dmz inside permit …」を足すと要件 5 に反する。返りの通信は FW が覚えて通すので、返りの行は要らない。ほかの書き方でも要件を全部満たせば正解。`,
    meta: { kind: 'fw' },
  });
}
function verifyFwPolicy(q) {
  verifyConfig(q, [
    [{ device: 'FW1', text: 'policy outside dmz permit tcp eq 443\npolicy inside dmz permit tcp eq 443\npolicy inside outside permit tcp eq 443\npolicy outside inside permit ip' }],
    [{ device: 'FW1', text: 'policy outside dmz permit tcp eq 443\npolicy inside dmz permit tcp eq 443\npolicy inside outside permit tcp eq 443\npolicy dmz inside permit ip' }],
    [{ device: 'FW1', text: 'policy outside dmz permit tcp eq 443\npolicy inside dmz permit tcp eq 443' }],
  ]);
}

// ================= Lv344 経路の MTU(表 + 数) =================
function mtuQ(rng) {
  const spec = sim.gen.serial(rng, { routers: 2, switches: false });
  const ids = nodeIdsOf(rng, spec);
  const M = rng.pick([1500, 1500, 1492, 1472, 1458, 1450, 1442, 1438, 1400, 1380, rng.rand(1380, 1500)]);
  const maxOk = M - 28; // IP 20 + ICMP 8
  // 試した大きさ: 通る方と通らない方を数個ずつ。境目(maxOk と maxOk + 1)を必ず入れる
  const sizes = new Set([maxOk, maxOk + 1]);
  while (sizes.size < rng.rand(5, 7)) { const s = maxOk + rng.rand(-120, 120); if (s > 0 && s !== maxOk && s !== maxOk + 1) sizes.add(s); }
  const rows = [...sizes].sort((a, b) => a - b).map((s) => [`ping ${spec.devices.PC2.ip.split('/')[0]} -s ${s} -df`, s <= maxOk ? '応答あり' : '分割が必要だが分割禁止(DF)の印がある。送れない']);
  const dg = diagramOf(spec, ids);
  for (const l of dg.links) if ((l.a.node === ids.R1 && l.b.node === ids.R2) || (l.a.node === ids.R2 && l.b.node === ids.R1)) { l.label = `${l.label || ''} (MTU は不明。トンネル)`.trim(); l.style = 'dash'; }
  return {
    text: `PC1 から PC2 まで、途中の線(R1–R2 の間。VPN のトンネル)の MTU が分からない。PC1 で、ICMP のデータの大きさ(-s。バイト)を変え、分割禁止(-df)を付けて ping を打った結果が表(表の順は大きさの順)。IPv4 のヘッダは 20 バイト、ICMP のヘッダは 8 バイトで、オプションは無い。PC1 から PC2 への経路の MTU(通る IP パケットの最大の大きさ。バイト)はいくつか。`,
    diagram: dg, table: { headers: ['打ったコマンド', '結果'], rows },
    answerKind: 'text', fields: [{ name: 'mtu', label: '経路の MTU(バイト)', format: 'number', hint: '例: 1500', accept: [String(M)] }],
    explanation: `正解は ${M}。通った最大のデータは ${maxOk} バイトで、${maxOk + 1} バイトは通らない。IP パケットの大きさ = データ + ICMP ヘッダ 8 + IP ヘッダ 20 なので、通る最大の IP パケットは ${maxOk} + 28 = ${M} バイト。これが経路の MTU(途中でいちばん小さい MTU)。${M < 1500 ? `ふつうのイーサネット(1500)より小さいのは、トンネルで包む分(${1500 - M} バイト)が引かれているから。` : 'トンネルの分が引かれていないので、ふつうのイーサネットと同じ 1500。'}データの大きさ ${maxOk} をそのまま答えるのは、ヘッダの 28 バイトを忘れている。`,
    meta: { kind: 'mtu', M },
  };
}
function verifyMtu(q) {
  const ok = q.table.rows.filter((r) => r[1] === '応答あり').map((r) => Number(/-s (\d+) /.exec(r[0])[1]));
  const ng = q.table.rows.filter((r) => r[1] !== '応答あり').map((r) => Number(/-s (\d+) /.exec(r[0])[1]));
  const mx = Math.max(...ok), mn = Math.min(...ng);
  if (mn !== mx + 1) throw new Error('Lv344: 境目が無い');
  if (q.fields[0].accept[0] !== String(mx + 28)) throw new Error('Lv344: MTU が違う');
}

// ================= Lv345 遅い所を探す(表 + tap link) =================
function slowQ(rng) {
  const spec = sim.gen.serial(rng, { routers: 3, switches: false });
  const ids = nodeIdsOf(rng, spec);
  const chain = ['PC1', 'R1', 'R2', 'R3', 'PC2'];
  const base = chain.slice(1).map(() => rng.rand(1, 4)); // 線ごとの片道の遅れ(ms)。線 i は chain[i] と chain[i+1] の間
  const slow = rng.rand(0, 3); // 遅い線(0 = PC1–R1 … 3 = R3–PC2)
  const slowAdd = rng.rand(80, 120);
  const trap = rng.next() < 0.7 ? rng.rand(1, 3) : 0; // 返事を後回しにするルーター(1〜3。0 = 無し)
  const trapAdd = rng.rand(20, 30);
  const net = sim.build(spec);
  const rows = [];
  for (let k = 1; k <= 4; k++) { // ホップ k = chain[k] からの返事
    let ms = 0; for (let i = 0; i < k; i++) ms += 2 * base[i] + (i === slow ? 2 * slowAdd : 0);
    if (k === trap) ms += trapAdd;
    const dev = net.devices[chain[k]]; const ip = k === 4 ? dev.ifaces[0].ip : dev.ifByName['Gi0/0'].ip;
    rows.push([String(k), ip, `${ms} ms`, `${ms + rng.rand(0, 1)} ms`, `${ms + rng.rand(0, 1)} ms`]);
  }
  const dg = diagramOf(spec, ids);
  const linkIds = chain.slice(1).map((n, i) => linkIdOf(dg, ids, chain[i], n));
  const seg = (i) => `${chain[i]} と ${chain[i + 1]} の間`;
  return tapQ({
    mode: 'link', diagram: dg, spec, answerIds: [linkIds[slow]],
    table: { headers: ['ホップ', 'アドレス', '1 回目', '2 回目', '3 回目'], rows },
    text: `PC1 から PC2 への通信が遅い。PC1 で traceroute を 3 回打った結果が表(各ホップの往復の時間。1 列目は PC1 から数えたホップ、2 列目はそのホップのアドレス)。ルーターによっては、自分宛の返事を後回しにして、そのホップだけ時間が長く見えることがある(通り抜ける通信は遅くない)。本当に遅い線(区間)は、その線より先のホップが全部遅くなる。遅い線を図でタップせよ。`,
    explanation: `正解は ${seg(slow)}。${slow === 0 ? '最初のホップ(R1)から時間が大きく、その先も全部大きいので、PC1 と R1 の間の線で遅れが足されている。' : `ホップ ${slow + 1} から先の時間が全部大きくなっている(ホップ ${slow} までは小さい)ので、遅れはホップ ${slow} と ${slow + 1} の間の線で足されている。`}${trap ? `ホップ ${trap}(${chain[trap]})は、それだけが突出して次のホップでは戻っているので、${chain[trap]} が自分宛の返事を後回しにしているだけで、通り抜ける通信は遅くない(わな)。` : ''}遅い区間を探すときは「1 つのホップの値」ではなく「そこから先がずっと遅いか」を見る。`,
    meta: { kind: 'slow', slow, trap: trap || null },
  });
}
function verifySlow(q) {
  const ms = q.table.rows.map((r) => Number(/^(\d+) ms/.exec(r[2])[1]));
  const cands = [];
  for (let i = 0; i < 4; i++) { const before = i === 0 ? 0 : Math.max(...ms.slice(0, i)); const later = Math.min(...ms.slice(i)); if (later - before >= 50) cands.push(i); }
  if (cands.length !== 1) throw new Error(`Lv345: 遅い線が ${cands.join(',')}`);
  const names = q.diagram.nodes.reduce((m, n) => { m[n.name] = n.id; return m; }, {});
  const chain = ['PC1', 'R1', 'R2', 'R3', 'PC2']; const a = names[chain[cands[0]]], b = names[chain[cands[0] + 1]];
  const l = q.diagram.links.find((x) => (x.a.node === a && x.b.node === b) || (x.a.node === b && x.b.node === a));
  if (!l || q.accept.ids[0] !== l.id) throw new Error('Lv345: 答えが違う');
}

// ================= Lv354 クラウドで外に出られない(tap one) =================
function cloudOutQ(rng) {
  const spec = sim.gen.cloud(rng, { isolatedPrivate: true }); // SUB-B・SUB-C の両方を非公開(NAT GW 経由)にしてから、片方を壊す
  const broken = rng.pick(['SUB-B', 'SUB-C']);
  const vm = broken === 'SUB-B' ? 'VM2' : 'VM3', other = broken === 'SUB-B' ? 'SUB-C' : 'SUB-B', otherVm = broken === 'SUB-B' ? 'VM3' : 'VM2';
  spec.devices[broken].routeTable = spec.devices[broken].routeTable.filter((r) => r.prefix !== '0.0.0.0/0');
  const ids = nodeIdsOf(rng, spec);
  const dg = diagramOf(spec, ids);
  const tables = {};
  for (const s of ['SUB-A', 'SUB-B', 'SUB-C']) tables[ids[s]] = [{ title: `${s} の経路表`, headers: ['宛先', '行き先'], rows: spec.devices[s].routeTable.map((r) => [r.prefix, { local: '中(この仮想網の中)', igw: 'インターネットゲートウェイ', natgw: 'NAT ゲートウェイ' }[r.target] || r.target]) }];
  return tapQ({
    mode: 'one', diagram: dg, spec, answerIds: [ids[broken]], tables,
    text: `PC クラウドの仮想網 ${spec.meta.vnet}(図)。SUB-A は公開(0.0.0.0/0 がインターネットゲートウェイへ)、SUB-B と SUB-C は非公開で、中の VM は NAT ゲートウェイ経由で外へ出て更新を取る決まり。ところが ${vm}(${spec.devices[vm].ip})だけが更新を取れない(${otherVm}(${spec.devices[otherVm].ip})は取れる)。各サブネットの経路表は、サブネットをタップして「表を見る」で見られる。原因のある場所(直すべき経路表を持つサブネット)をタップせよ。PC クラウドの規則: サブネットの外との通信は、そのサブネットの経路表の 0.0.0.0/0 の行き先で決まる(インターネットゲートウェイ = 公開、NAT ゲートウェイ = 外へ出るだけ、行が無い = 外と通信しない)。`,
    explanation: `正解は ${broken}。${broken} の経路表には 0.0.0.0/0 の行が無く、中の ${vm} は仮想網の外へ出る道が無い(隔離の状態)。${other} には 0.0.0.0/0 → NAT ゲートウェイの行があるので ${otherVm} は出られる。NAT ゲートウェイそのものや VM の設定ではなく、そのサブネットの経路表に「0.0.0.0/0 → NAT ゲートウェイ」を足すのが直し方。`,
    meta: { kind: 'cloud', broken },
  });
}
function verifyCloudOut(q, spec) {
  const net = sim.build(spec);
  const bad = ['SUB-B', 'SUB-C'].filter((s) => !sim.reach(net, s === 'SUB-B' ? 'VM2' : 'VM3', 'INET').ok);
  if (bad.length !== 1) throw new Error(`Lv354: 出られないのが ${bad.join(',')}`);
  const id = q.diagram.nodes.find((n) => n.name === bad[0]).id;
  if (q.accept.ids[0] !== id) throw new Error('Lv354: 答えが違う');
  if (!sim.reach(net, 'VM1', 'INET').ok) throw new Error('Lv354: 公開のサブネットが出られない');
}

// ================= Lv355 組む: 2 拠点の設定一式(config。生+固) =================
function twoSitesConfigQ(rng) {
  const spec = sim.gen.twoSites(rng); const { hq, br, srvPort } = spec.meta;
  const srvIp = spec.devices.SRV1.ip.split('/')[0];
  spec.devices.R1.routes = [{ prefix: '0.0.0.0/0', via: '203.0.113.254' }]; spec.devices.R2.routes = [{ prefix: '0.0.0.0/0', via: '203.0.113.254' }];
  spec.editable = ['R1', 'R2'];
  const ids = nodeIdsOf(rng, spec);
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: srvPort },
    { id: 2, kind: 'reach', from: 'PC1', to: 'PC2' },
    { id: 3, kind: 'reach', from: 'INET', to: null, toIp: '203.0.113.1', proto: 'tcp', port: srvPort },
    { id: 4, kind: 'reach', from: 'INET', to: null, toIp: '203.0.113.1', proto: 'tcp', port: 22, expect: false },
    { id: 5, kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 22, expect: false },
  ];
  const reqText = { 1: `支社の PC2 から本社の SRV1(${srvIp})へ TCP ${srvPort} が届く`, 2: rt.reach('本社の PC1', '支社の PC2'), 3: `外(INET)から R1 の外側のアドレス 203.0.113.1 の TCP ${srvPort} へつなぐと SRV1 に届く(公開)`, 4: `外(INET)から 203.0.113.1 の TCP 22 へは届かない(止める)`, 5: `支社の PC2 から SRV1 の TCP 22 は届かない(止める。支社からは Web だけ)` };
  const solution = [
    { device: 'R1', text: `ip route ${br}.0/24 203.0.113.2\nnat static tcp ${srvIp} ${srvPort} 203.0.113.1 ${srvPort}\nacl EXT extended\n 10 deny tcp ${br}.0/24 host ${srvIp} eq 22\n 20 permit ip any any\ninterface Gi0/1\n nat outside\n acl EXT in\ninterface Gi0/0\n nat inside` },
    { device: 'R2', text: `ip route ${hq}.0/24 203.0.113.1` },
  ];
  return configQ({
    spec, ids, requirements, reqText, solution,
    text: `本社(R1。LAN ${hq}.0/24、Web サーバー SRV1 ${srvIp} は TCP ${srvPort} と 22 で待ち受け)と支社(R2。LAN ${br}.0/24)の設定を一式組む。R1・R2 は外(INET 203.0.113.254)へのデフォルトルートだけを持っている。本社と支社の間は ISP の網(203.0.113.0/24)で直接つながり、ここでは暗号は考えない。R1 と R2 に経路・NAT(ポートフォワード)・ACL を書き、要件 5 件(届く 3・止める 2)を全部満たせ。規則: 経路は最長一致、受信の ACL は NAT の前(変換前の宛先で照らす)、送信の ACL は NAT の後。ポートフォワードは「nat static tcp <内のアドレス> <内のポート> <外のアドレス> <外のポート>」で、外側 IF に nat outside・内側 IF に nat inside が要る。`,
    explanation: `正しい設定の例:\nR1\n  ip route ${br}.0/24 203.0.113.2\n  nat static tcp ${srvIp} ${srvPort} 203.0.113.1 ${srvPort}\n  acl EXT extended\n   10 deny tcp ${br}.0/24 host ${srvIp} eq 22\n   20 permit ip any any\n  interface Gi0/1\n   nat outside\n   acl EXT in\n  interface Gi0/0\n   nat inside\nR2\n  ip route ${hq}.0/24 203.0.113.1\n要件 1・2 は互いの LAN への静的経路。要件 3 は 203.0.113.1:${srvPort} を SRV1 へ転送する静的 NAT。TCP 22 は転送しないので要件 4 は何もしなくても満たす(転送の行を足せば破る)。要件 5 は外側 IF の受信 ACL で支社から SRV1 の 22 だけを捨て、ほかは通す(deny を permit any の上に置く)。ほかの書き方でも要件を全部満たせば正解。`,
    meta: { kind: 'twoSites' },
  });
}
function verifyTwoSites(q) {
  const { hq, br, srvPort } = q.sim.spec.meta; const srvIp = q.sim.spec.devices.SRV1.ip.split('/')[0];
  const r1 = q.solution[0].text;
  verifyConfig(q, [
    [{ device: 'R1', text: r1.replace(/acl EXT extended[\s\S]*?20 permit ip any any\n/, '').replace(' acl EXT in\n', '') }, q.solution[1]], // ACL 無し → 要件 5
    [{ device: 'R1', text: `${r1}\nnat static tcp ${srvIp} 22 203.0.113.1 22` }, q.solution[1]], // 22 も転送 → 要件 4
    [{ device: 'R1', text: `ip route ${br}.0/24 203.0.113.2` }, { device: 'R2', text: `ip route ${hq}.0/24 203.0.113.1` }], // 経路だけ → 要件 3
    [{ device: 'R1', text: r1.replace(` 10 deny tcp ${br}.0/24 host ${srvIp} eq 22\n 20 permit ip any any`, ` 10 permit ip any any\n 20 deny tcp ${br}.0/24 host ${srvIp} eq 22`) }, q.solution[1]], // 順が逆
    [{ device: 'R1', text: `${r1}\nacl EXT extended\n 10 deny tcp ${br}.0/24 host ${srvIp} eq ${srvPort}` }, q.solution[1]], // 443 も止める
  ]);
}

// ================= Lv356 1 本切れたら(tap order) =================
function cutOrderQ(rng) {
  // 主の道を R2 回りか R3 回りに(コストで)。切るのは主の道の線
  const mainVia = rng.pick(['R2', 'R3']);
  const costs = mainVia === 'R2' ? [1, 1, rng.rand(1, 3), rng.rand(2, 5)] : [rng.rand(1, 3), rng.rand(2, 5), 1, 1];
  const spec = sim.gen.square(rng, { costs });
  const ids = nodeIdsOf(rng, spec);
  const cutChoice = rng.pick(['near', 'far']);
  const cut = mainVia === 'R2' ? (cutChoice === 'near' ? ['R1:Gi0/1', 'R2:Gi0/0'] : ['R2:Gi0/1', 'R4:Gi0/1']) : (cutChoice === 'near' ? ['R1:Gi0/2', 'R3:Gi0/0'] : ['R3:Gi0/1', 'R4:Gi0/2']);
  const net = sim.build(spec);
  const before = sim.reach(net, 'PC1', 'PC2', { roundTrip: false }).path.filter((n) => spec.devices[n].kind === 'router');
  const cutSpec = { ...spec, links: spec.links.filter((l) => !(l[0] === cut[0] && l[1] === cut[1])) };
  const after = sim.reach(sim.build(cutSpec), 'PC1', 'PC2', { roundTrip: false }).path.filter((n) => spec.devices[n].kind === 'router');
  const dg = diagramOf(spec, ids);
  const [ca, cb] = cut.map((e) => e.split(':')[0]);
  const cutId = linkIdOf(dg, ids, ca, cb);
  for (const l of dg.links) if (l.id === cutId) { l.style = 'dash'; l.label = `${l.label || ''} ✕ 切れた`.trim(); }
  const costOf = (a, b) => { const d = spec.devices[a]; const f = d.ifaces.find((x) => spec.links.some((l) => (l[0] === `${a}:${x.name}` && l[1].startsWith(`${b}:`)) || (l[1] === `${a}:${x.name}` && l[0].startsWith(`${b}:`)))); return f.ospfCost; };
  return tapQ({
    mode: 'order', diagram: dg, spec, answerIds: after.map((n) => ids[n]),
    text: `R1〜R4 は OSPF で経路を交換し、PC1(${spec.devices.PC1.ip})から PC2(${spec.devices.PC2.ip})へは R1–${before[1]}–R4 の道を使っていた(線のそばの数字は OSPF のコスト。道のコストは通る線のコストの合計で、小さい方を選ぶ)。${ca} と ${cb} の間の線が切れた(図の点線)。切れたあと、PC1 から PC2 へのパケットが通るルーターを順にタップせよ。`,
    explanation: `正解は ${after.join(' → ')}。切れる前は R1–${before[1]}–R4(コスト ${costOf('R1', before[1]) + costOf(before[1], 'R4')})がいちばん小さかった。${ca}–${cb} が切れると、OSPF がその線を経路の計算から外し、残る R1–${after[1]}–R4(コスト ${costOf('R1', after[1]) + costOf(after[1], 'R4')})を使う。自動で切り替わるのが動的な経路制御のよさ。切れた線を通る順(${before.join(' → ')})を選ぶのは、切れる前の道。`,
    meta: { kind: 'cut', mainVia, cutChoice },
  });
}
function verifyCutOrder(q, spec) {
  const m = /(R\d) と (R\d) の間の線が切れた/.exec(q.text); const cut = [m[1], m[2]];
  const net = sim.build(spec);
  const link = spec.links.find((l) => (l[0].startsWith(`${cut[0]}:`) && l[1].startsWith(`${cut[1]}:`)) || (l[1].startsWith(`${cut[0]}:`) && l[0].startsWith(`${cut[1]}:`)));
  const names = q.diagram.nodes.reduce((mm, n) => { mm[n.id] = n.name; return mm; }, {});
  const via = q.accept.ids.map((id) => names[id]);
  const r = sim.check(net, [{ id: 1, kind: 'failover', cut: [link], then: { kind: 'path', from: 'PC1', to: 'PC2', via } }])[0];
  if (!r.ok) throw new Error(`Lv356: 順が違う ${r.detail}`);
  const before = sim.reach(net, 'PC1', 'PC2', { roundTrip: false }).path.filter((n) => spec.devices[n].kind === 'router');
  if (before.join() === via.join()) throw new Error('Lv356: 切っても道が変わらない');
}

// ================= Lv357 線を 1 本足す(tap many: 2 台) =================
// serial は 3 台までなので、4 台目(R4)は PC2 側に手で足す(R3–PC2 の線を R3–R4–PC2 にし、PC2 の LAN を R4 に移す)
function serial4(rng) {
  const spec = sim.gen.serial(rng, { routers: 3, switches: false, ospf: true });
  const { lan2, block } = spec.meta; const base = block.replace(/\.0\.0\/16$/, '');
  const [a34, b34] = p2pIps(`${base}.249.0`);
  spec.devices.R3.ifaces[1].ip = a34;
  spec.devices.R4 = { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: b34 }, { name: 'Gi0/1', ip: cidr24(lan2, 1) }], ospf: { networks: [block], area: 0 } };
  spec.links = spec.links.filter((l) => !(l[0] === 'R3:Gi0/1' && l[1] === 'PC2')).concat([['R3:Gi0/1', 'R4:Gi0/0'], ['R4:Gi0/1', 'PC2']]);
  spec.layout = { w: 1000, h: 600, pos: { PC1: [70, 300], R1: [270, 300], R2: [470, 300], R3: [670, 300], R4: [850, 300], PC2: [950, 300] } };
  spec.meta.routers = 4;
  return spec;
}
function addLinkQ(rng) {
  const routers = rng.pick([3, 3, 4]);
  const spec = routers === 4 ? serial4(rng) : sim.gen.serial(rng, { routers, switches: false, ospf: true });
  const ids = nodeIdsOf(rng, spec);
  const mid = routers === 3 ? ['R2'] : ['R2', 'R3'];
  const ans = ['R1', `R${routers}`];
  return tapQ({
    mode: 'many', diagram: diagramOf(spec, ids), spec, answerIds: ans.map((n) => ids[n]),
    text: `R1〜R${routers} は一直線につながり、OSPF で経路を交換している(図)。${list(mid)} ${mid.length > 1 ? 'のどれか' : ''}が止まると PC1(${spec.devices.PC1.ip})と PC2(${spec.devices.PC2.ip})の通信が止まる。線(と IF)を 1 本だけ足して、${list(mid)} ${mid.length > 1 ? 'のどれ' : ''}が止まっても PC1 と PC2 が通信できるようにしたい。線をつなぐ 2 台のルーターをタップせよ(2 つ選ぶ)。`,
    explanation: `正解は R1 と R${routers}。足した線で R1–R${routers} の 2 本目の道ができ、${list(mid)} が止まっても OSPF がその道に切り替える。${routers === 4 ? 'R1–R3 では R3 が止まったとき、R2–R4 では R2 が止まったときに道が無くなるので、両方に備えるには両端の R1–R4 しかない。' : 'R1 と R3 の間が、R2 を通らない唯一の道。'}PC1 のゲートウェイ R1 と PC2 のゲートウェイ R${routers} は、線を足しても止まれば通信できない(それを直すなら VRRP の 2 台にする)。`,
    meta: { kind: 'addLink', routers },
  });
}
function verifyAddLink(q, spec) { // 線の無いルーターの組を全部試し、真ん中のどれが止まっても届く組が 1 つだけ
  const routers = Object.keys(spec.devices).filter((n) => spec.devices[n].kind === 'router');
  const mid = routers.slice(1, -1);
  const hasLink = (a, b) => spec.links.some((l) => (l[0].startsWith(`${a}:`) && l[1].startsWith(`${b}:`)) || (l[1].startsWith(`${a}:`) && l[0].startsWith(`${b}:`)));
  const good = [];
  for (let i = 0; i < routers.length; i++) for (let j = i + 1; j < routers.length; j++) {
    const a = routers[i], b = routers[j]; if (hasLink(a, b)) continue;
    const s = JSON.parse(JSON.stringify(spec));
    s.devices[a].ifaces.push({ name: 'Gi0/2', ip: '10.254.254.1/30' }); s.devices[b].ifaces.push({ name: 'Gi0/2', ip: '10.254.254.2/30' });
    s.devices[a].ospf.networks.push('10.254.254.0/30'); s.devices[b].ospf.networks.push('10.254.254.0/30');
    s.links.push([`${a}:Gi0/2`, `${b}:Gi0/2`]);
    const net = sim.build(s);
    if (mid.every((m) => sim.check(net, [{ id: 1, kind: 'failover', down: [m], then: { kind: 'reach', from: 'PC1', to: 'PC2' } }])[0].ok)) good.push([a, b]);
  }
  if (good.length !== 1) throw new Error(`Lv357: 答えの組が ${good.length}`);
  const names = q.diagram.nodes.reduce((mm, n) => { mm[n.name] = n.id; return mm; }, {});
  const want = good[0].map((n) => names[n]).sort();
  if (JSON.stringify(q.accept.ids) !== JSON.stringify(want)) throw new Error('Lv357: 答えが違う');
}

// ================= Lv358 直す: 2 か所の誤り(terminal + config。生+固) =================
// twoSwitches(R1 の副 IF)+ VLAN 20 の SRV1。壊す 2 か所: SW1 の PC1 のポートが別の VLAN、R1 の ACL の行の順(deny all が permit 443 の上)
function fixTwoQ(rng) {
  const spec = sim.gen.twoSwitches(rng, { l3: 'subif' }); const { vlans, lan } = spec.meta; const [v10, v20] = vlans;
  const srvIp = cidr24(lan[v20], rng.rand(201, 240));
  spec.devices.SRV1 = { kind: 'server', ip: srvIp, gateway: `${lan[v20]}.1`, listen: [{ proto: 'tcp', port: 443 }, { proto: 'tcp', port: 22 }] };
  spec.devices.SW2.ifaces.push({ name: 'Gi1/0/3', mode: 'access', vlan: v20 }); spec.links.push(['SRV1', 'SW2:Gi1/0/3']);
  const srv = srvIp.split('/')[0];
  // ACL(VLAN v20 へ出る向き): 設計は 10 permit 443 / 20 deny 22 / 30 permit any。壊す: deny ip any any を permit 443 の上に
  spec.devices.R1.acls = { SRV: { type: 'extended', lines: [{ seq: 10, action: 'deny', proto: 'tcp', src: 'any', dst: `host ${srv}`, dport: 22 }, { seq: 20, action: 'deny', proto: 'ip', src: 'any', dst: 'any' }, { seq: 30, action: 'permit', proto: 'tcp', src: 'any', dst: `host ${srv}`, dport: 443 }] } };
  spec.devices.R1.ifaces.push({ name: `Gi0/0.${v20}`, aclOut: 'SRV' });
  // 壊す: PC1 のポートの VLAN
  const wrongVlan = rng.pick([v10 + 1, 30, 99].filter((v) => v !== v10 && v !== v20));
  spec.devices.SW1.vlans = [...new Set([...vlans, wrongVlan])];
  spec.devices.SW1.ifaces.find((f) => f.name === 'Gi1/0/1').vlan = wrongVlan;
  spec.editable = ['SW1', 'R1'];
  const ids = nodeIdsOf(rng, spec);
  spec.layout = 'two-switches'; // SRV1 は自動配置
  const requirements = [
    { id: 1, kind: 'reach', from: 'PC1', to: 'SRV1', proto: 'tcp', port: 443 },
    { id: 2, kind: 'reach', from: 'PC1', to: 'SRV1', proto: 'tcp', port: 22, expect: false },
    { id: 3, kind: 'reach', from: 'PC3', to: 'SRV1', proto: 'tcp', port: 443 },
    { id: 4, kind: 'reach', from: 'PC1', to: 'PC3' },
  ];
  const reqText = { 1: `PC1(VLAN ${v10})から SRV1(VLAN ${v20}、${srv})へ TCP 443 が届く`, 2: `PC1 から SRV1 へ TCP 22 は届かない(止める)`, 3: `PC3(VLAN ${v10})から SRV1 へ TCP 443 が届く`, 4: `PC1 から PC3(同じ VLAN ${v10})へ ping が届く` };
  const solution = [
    { device: 'SW1', text: `interface Gi1/0/1\n switchport access vlan ${v10}` },
    { device: 'R1', text: `acl SRV extended\n no 20\n no 30\n 20 permit tcp any host ${srv} eq 443\n 30 deny ip any any` },
  ];
  const net = sim.build({ ...spec, requirements });
  const configView = { SW1: ['(ポートごとの設定は、ターミナルで show vlan か show running-config を打って確かめる)'], R1: sim.runningConfig(net, 'R1', { hide: ['acl'] }).concat(['acl SRV extended', ' (行は show access-lists で確かめる)']) };
  return configQ({
    spec, ids, requirements, reqText, solution, configView, terminal: { devices: ['PC1', 'PC3', 'SW1', 'SW2', 'R1'], start: 'PC1' },
    text: `設計: PC1・PC3 は VLAN ${v10}(${lan[v10]}.0/24)、PC2・PC4・SRV1 は VLAN ${v20}(${lan[v20]}.0/24)。R1 の副 IF(Gi0/0.${v10}・Gi0/0.${v20})が VLAN 間を中継し、VLAN ${v20} へ出る向きに ACL「SRV」を当てて、SRV1 へは TCP 443 だけ通し TCP 22 は止め、ほかの通信は通す決まり。ところが PC1 から SRV1 の Web(443)が見えず、PC3 からも見えない。誤りが 2 か所ある。ターミナルで調べて(PC の ping・traceroute、SW1 の show vlan、R1 の show access-lists など)、SW1 と R1 の設定を直し、要件を全部満たせ。ACL は上の行から最初に合った行で決まる。`,
    explanation: `誤りは 2 か所。(1) SW1 の Gi1/0/1(PC1 のポート)が VLAN ${wrongVlan} になっていて、PC1 が VLAN ${v10} にいない(PC3 へも届かない)。(2) R1 の ACL SRV は「10 deny tcp … eq 22 / 20 deny ip any any / 30 permit tcp … eq 443」の順で、443 を通す 30 行目の前に 20 行目の deny ip any any がすべてを捨てている(PC3 からも届かない理由)。\n正しい設定の例:\nSW1\n  interface Gi1/0/1\n   switchport access vlan ${v10}\nR1\n  acl SRV extended\n   no 20\n   no 30\n   20 permit tcp any host ${srv} eq 443\n   30 deny ip any any\n片方だけ直しても要件は満たせない(VLAN だけ直すと PC1 は PC3 に届くが SRV1 には届かない。ACL だけ直すと PC3 は届くが PC1 は届かない)。ほかの書き方でも要件を全部満たせば正解。`,
    meta: { kind: 'fixTwo', wrongVlan },
  });
}
function verifyFixTwo(q) {
  verifyConfig(q, [[q.solution[0]], [q.solution[1]]]); // 片方だけ直す
  const s = q.sim.spec; const srv = s.devices.SRV1.ip.split('/')[0];
  const sloppy = [q.solution[0], { device: 'R1', text: `acl SRV extended\n no 20\n no 30\n 20 permit tcp any host ${srv} eq 443\n 30 permit ip any any` }];
  if (!sim.judgeConfig(s, sloppy).ok) throw new Error('Lv358: permit any で終える正しい別解が通らない');
  const minimal = [q.solution[0], { device: 'R1', text: 'acl SRV extended\n no 10\n no 20' }]; // 30 permit 443 だけ残す(暗黙の拒否で 22 は止まる)= 正しい別解
  if (!sim.judgeConfig(s, minimal).ok) throw new Error('Lv358: 443 だけ残す別解が通らない');
  const bad = [q.solution[0], { device: 'R1', text: 'acl SRV extended\n no 10\n no 20\n no 30\n 10 permit ip any any' }]; // 22 も通してしまう
  if (sim.judgeConfig(s, bad).ok) throw new Error('Lv358: 22 を通す答えが通る');
}

// ================= Lv359 変更: 手順どおりに切り替える(config。生+固) =================
function maintenanceQ(rng) {
  const costs = [1, 1, rng.rand(2, 4), rng.rand(2, 4)]; // 主は R2 回り、予備は R3 回り
  const spec = sim.gen.square(rng, { costs });
  spec.editable = rng.pick([['R2'], ['R1', 'R4'], ['R1', 'R2', 'R4']]);
  const ids = nodeIdsOf(rng, spec);
  const requirements = [
    { id: 1, kind: 'path', from: 'PC1', to: 'PC2', via: ['R1', 'R3', 'R4'] },
    { id: 2, kind: 'path', from: 'PC2', to: 'PC1', via: ['R4', 'R3', 'R1'] },
    { id: 3, kind: 'failover', cut: [['R1:Gi0/1', 'R2:Gi0/0']], then: { kind: 'reach', from: 'PC1', to: 'PC2' } },
    { id: 4, kind: 'failover', cut: [['R2:Gi0/1', 'R4:Gi0/1']], then: { kind: 'reach', from: 'PC1', to: 'PC2' } },
    { id: 5, kind: 'reach', from: 'PC1', to: 'PC2' },
  ];
  const reqText = { 1: '工事前の今、PC1 から PC2 への通信が予備の道(R1 → R3 → R4)を通る', 2: 'PC2 から PC1 への通信も予備の道(R4 → R3 → R1)を通る(行きと帰りをそろえる)', 3: '工事で R1–R2 の線が切れても PC1 と PC2 が通信できる', 4: '工事で R2–R4 の線が切れても PC1 と PC2 が通信できる', 5: '今も PC1 と PC2 が通信できる(切り替えで止めない)' };
  const ed = spec.editable;
  const solution = ed.includes('R2') && ed.length === 1
    ? [{ device: 'R2', text: 'interface Gi0/0\n ospf cost 100\ninterface Gi0/1\n ospf cost 100' }]
    : [{ device: 'R1', text: 'interface Gi0/1\n ospf cost 100' }, { device: 'R4', text: 'interface Gi0/1\n ospf cost 100' }];
  return configQ({
    spec, ids, requirements, reqText, solution,
    text: `R1〜R4 は OSPF で経路を交換し、PC1(${spec.devices.PC1.ip})と PC2(${spec.devices.PC2.ip})の間に主の道 R1–R2–R4(コスト ${costs[0]} + ${costs[1]})と予備の道 R1–R3–R4(コスト ${costs[2]} + ${costs[3]})がある(線のそばの数字がコスト。小さい道を使う)。主の道の R2 で工事があり、R1–R2 と R2–R4 の線が順に切れる。手順は「①工事前に予備を優先する → ②届くことを確かめる → ③工事 → ④工事後に主に戻す」。今は①で、設定を書けるのは ${list(ed)}。どの段でも PC1 と PC2 の通信が止まらないように、①の設定(予備を優先し、主が切れても届く)を書け。IF のコストは interface の中で「ospf cost <数>」。`,
    explanation: `正しい設定の例:\n${solution.map((s) => `${s.device}\n  ${s.text.replace(/\n/g, '\n  ')}`).join('\n')}\n主の道のコストを予備より大きくすると、線を切る前に OSPF が予備の道へ切り替わる(①)。線が切れたときにあわてて切り替わるのではなく、先に動かしておくのが手順どおりの変更。行きと帰りが別の道にならないよう、両方向のコストを上げる(R2 の両方の IF、または R1 と R4 の R2 向きの IF)。工事後(④)は「no ospf cost」でコストを戻し、主の道に戻ったことを traceroute で確かめる。ほかの書き方でも要件を全部満たせば正解(線を shutdown する手も、要件は満たす)。`,
    meta: { kind: 'maint', editable: ed.join('+') },
  });
}
function verifyMaintenance(q) {
  const ed = q.sim.spec.editable;
  const oneWay = ed.includes('R2') && ed.length === 1 ? [{ device: 'R2', text: 'interface Gi0/1\n ospf cost 100' }] : [{ device: 'R1', text: 'interface Gi0/1\n ospf cost 100' }];
  verifyConfig(q, [oneWay]); // 片方向だけ上げる → 帰りが主のまま(要件 2)
}

// ================= Lv360 物理と論理の食い違い(tap link) =================
function mismatchQ(rng) {
  const spec = sim.gen.twoSwitches(rng, { l3: rng.pick(['l3sw', 'subif']), vlans: rng.pick([[10, 20], [10, 30], [20, 30], [100, 200], [11, 12], [10, 99]]) }); const { vlans } = spec.meta;
  const pcs = ['PC1', 'PC2', 'PC3', 'PC4'];
  const bad = rng.pick(pcs);
  const sw = bad === 'PC1' || bad === 'PC2' ? 'SW1' : 'SW2'; const port = bad === 'PC1' || bad === 'PC3' ? 'Gi1/0/1' : 'Gi1/0/2';
  const design = {}; for (const p of pcs) design[p] = p === 'PC1' || p === 'PC3' ? vlans[0] : vlans[1];
  const f = spec.devices[sw].ifaces.find((x) => x.name === port); f.vlan = design[bad] === vlans[0] ? vlans[1] : vlans[0];
  const ids = nodeIdsOf(rng, spec);
  const dg = diagramOf(spec, ids, { showIps: false });
  for (const n of dg.nodes) if (design[n.name]) n.note = `設計(論理図): VLAN ${design[n.name]}`;
  const tables = {};
  for (const s of ['SW1', 'SW2']) tables[ids[s]] = [{ title: `${s} のポート(物理の設定)`, headers: ['ポート', 'モード', 'VLAN'], rows: spec.devices[s].ifaces.map((x) => [x.name, x.mode === 'trunk' ? 'トランク' : 'アクセス', x.mode === 'trunk' ? `許可 ${x.allowed.join(',')}` : String(x.vlan)]) }];
  for (const l of dg.links) { const an = dg.nodes.find((n) => n.id === l.a.node), bn = dg.nodes.find((n) => n.id === l.b.node); const p = l.a.port || l.b.port; if (p && (an.kind === 'host' || bn.kind === 'host')) l.label = p; }
  return tapQ({
    mode: 'link', diagram: dg, spec, answerIds: [linkIdOf(dg, ids, bad, sw)], tables,
    table: { title: '論理図(設計)', headers: ['PC', 'VLAN', 'アドレス'], rows: pcs.map((p) => [p, String(design[p]), spec.devices[p].ip]) },
    text: `論理図(設計)では、各 PC がどの VLAN に属するかが決まっている(機器のそばの「設計」)。物理の配線とスイッチのポートの設定は図と表のとおり(スイッチをタップして「表を見る」)。設計と実際が食い違っている線(PC とスイッチの間)を 1 本タップせよ。`,
    explanation: `正解は ${bad} と ${sw} の間の線。${bad} は設計では VLAN ${design[bad]} だが、つながっている ${sw} の ${port} はアクセス VLAN ${f.vlan} に設定されていて、${bad} は別の VLAN に入ってしまっている。論理図(VLAN・アドレス)と物理図(線・ポート)を突き合わせると、こうした食い違いが見つかる。直すなら ${sw} の ${port} を VLAN ${design[bad]} にするか、${bad} を VLAN ${design[bad]} のポートにつなぎ替える。`,
    meta: { kind: 'mismatch', bad },
  });
}
function verifyMismatch(q) {
  const nodes = q.diagram.nodes; const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const vlanOf = (swId, port) => { const t = q.diagram.tables[swId][0].rows.find((r) => r[0] === port); return t ? t[2] : null; };
  const bad = [];
  for (const l of q.diagram.links) {
    const a = byId[l.a.node], b = byId[l.b.node]; const pc = a.kind === 'host' ? a : b.kind === 'host' ? b : null; if (!pc) continue;
    const sw = pc === a ? b : a; const port = pc === a ? l.b.port : l.a.port;
    const want = /VLAN (\d+)/.exec(pc.note || '')[1]; if (vlanOf(sw.id, port) !== want) bad.push(l.id);
  }
  if (bad.length !== 1 || q.accept.ids[0] !== bad[0]) throw new Error(`Lv360: 食い違いが ${bad.length}`);
}

// ================= レベルの一覧 =================
const gen = (title, kindName, make, verify, fixed = false) => ({ title, kind: fixed ? '生+固' : '生', minDistinct: fixed ? 15 : 1000, make(rng) { const q = make(rng); return { ...q, kind: kindName }; }, verify });

const LEVELS = {
  322: gen('拠点間 VPN を書く', 'cl322-vpn-route-v1', vpnQ, verifyVpn),
  324: gen('ハブとスポークの経路', 'cl324-hub-spoke-config-v1', hubSpokeQ, verifyHubSpoke),
  325: gen('支社どうしの通信', 'cl325-spoke-order-v1', spokeOrderQ, (q) => verifySpokeOrder(q)),
  326: gen('1 か所で止まる所', 'cl326-spof-v1', spofQ, (q) => verifySpof(q, q.sim.spec)),
  330: gen('DMZ', 'cl330-dmz-v1', dmzQ, verifyDmz),
  331: gen('必要なものだけ通す', 'cl331-fw-policy-v1', fwPolicyQ, verifyFwPolicy, true),
  344: gen('経路の MTU', 'cl344-path-mtu-v1', mtuQ, verifyMtu),
  345: gen('遅い所を探す', 'cl345-slow-link-v1', slowQ, verifySlow, true),
  354: gen('構成図: クラウドで外に出られない', 'cl354-cloud-no-egress-v1', cloudOutQ, (q) => verifyCloudOut(q, q.sim.spec)),
  355: gen('組む: 2 拠点の設定一式', 'cl355-two-sites-config-v1', twoSitesConfigQ, verifyTwoSites, true),
  356: gen('構成図: 1 本切れたら', 'cl356-cut-reroute-v1', cutOrderQ, (q) => verifyCutOrder(q, q.sim.spec)),
  357: gen('構成図: 線を 1 本足す', 'cl357-add-link-v1', addLinkQ, (q) => verifyAddLink(q, q.sim.spec)),
  358: gen('直す: 2 か所の誤り', 'cl358-fix-two-v1', fixTwoQ, verifyFixTwo, true),
  359: gen('変更: 手順どおりに切り替える', 'cl359-maintenance-v1', maintenanceQ, verifyMaintenance, true),
  360: gen('構成図: 物理と論理の食い違い', 'cl360-phys-logic-mismatch-v1', mismatchQ, verifyMismatch),
};

module.exports = { LEVELS, _test: { hubSpokeSpec, spofSpec, dmzSpec, nodeIdsOf, linkIdOf, TUN } };
