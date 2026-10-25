'use strict';
// 構成図・設定・模擬ターミナルの問題(中級)。新しい番号 192・193・200・201・215・228・241〜252(docs/LEVEL-LIST.md)。
// 担当: Claude Fable 5.1(2026-10-25)。作り方は docs/questions/SIM-API.md、模擬は server/sim。テストは test/cl-sim-mid.js
// 中級なので firstStep(ヒントの最初の 1 手)を付ける。構成は sim.gen から作り、そろった状態から 1 か所だけ消す・壊す(plant-then-perturb)。
// verify は、生成と別の方法(spec を自分で読んで計算する・模擬ターミナルに実際に打つ・正しい設定と壊した設定を判定に通す)で確かめる。
//
// ゲーム内の規則(問題文にも書く):
//   STP(192): ブリッジ ID = 優先度 + MAC(小さい方が根)。線のコストは全部同じ。根でないスイッチは根にいちばん近いポートをルートポートにし、
//            同じ線の両端ではブリッジ ID の小さい方が指定ポート、もう一方が代替(止める)
//   ACL の置き場所(250): 標準 ACL(送信元だけ)は宛先の近くの IF の送信(out)、拡張 ACL は送信元の近くの IF の受信(in)。284 の表と同じ
//   設定の文法: DIAGRAM-CONFIG.md 4.2(省略形は受けない。no で消す)。要件は SIM-API.md 第 4 章
const sim = require('../../sim');
const { LAYOUTS } = require('../../sim/diagram');

// ================= 共通の道具 =================
const gen = (title, kindName, make, verify) => ({ title, kind: '生', minDistinct: 1000, make(rng) { return { ...make(rng), kind: kindName }; }, verify });
const hex6 = (rng) => rng.rand(0, 0xffffff).toString(16).padStart(6, '0');
// 機器の名前 → 問題ごとの乱数 id(図のタップはこの id で答える。名前は図に見えるので隠す意味は薄いが、正解の id を推測させない)
function nodeIds(rng, spec) { const ids = {}; const used = new Set(); for (const n of Object.keys(spec.devices)) { let id; do { id = `n${hex6(rng)}`; } while (used.has(id)); used.add(id); ids[n] = id; } return ids; }
const ipOf = (cidr) => String(cidr).split('/')[0];
const ifaceOf = (spec, dev, name) => spec.devices[dev].ifaces.find((f) => f.name === name);
const ifIp = (spec, dev, name) => ipOf(ifaceOf(spec, dev, name).ip);
const textQ = (fields) => ({ answerKind: 'text', fields });
const field = (name, label, format, value, hint) => ({ name, label, format, hint, accept: [String(value)] });
const list = (xs) => xs.join('・');
const nameOfId = (q, id) => (q.diagram.nodes.find((n) => n.id === id) || {}).name;
const idOfName = (q, name) => (q.diagram.nodes.find((n) => n.name === name) || {}).id;
// 型の座標の表に足す(INET など、型に無い機器を置く)
function layoutWith(spec, extra) { const base = typeof spec.layout === 'string' ? LAYOUTS[spec.layout] || {} : (spec.layout && spec.layout.pos) || {}; spec.layout = { pos: { ...base, ...extra } }; }
// ルーター R に外の網(INET。203.0.113.0/24)を Gi0/2 でつなぎ、既定経路と NAPT を済ませておく(「外へは出さない」の要件に使う)
function attachInet(spec, router, pos = [540, 120]) {
  const r = spec.devices[router];
  r.ifaces.push({ name: 'Gi0/2', ip: '203.0.113.1/24' });
  r.routes = (r.routes || []).concat([{ prefix: '0.0.0.0/0', via: '203.0.113.254' }]);
  r.nat = { inside: r.ifaces.filter((f) => f.name !== 'Gi0/2').map((f) => f.name), outside: ['Gi0/2'], source: [{ src: spec.meta.block, iface: 'Gi0/2', overload: true }] };
  spec.devices.INET = { kind: 'internet', ip: '203.0.113.254/24' };
  spec.links.push([`${router}:Gi0/2`, 'INET']);
  layoutWith(spec, { INET: pos });
}
// 図: IF のアドレスは機器の note にまとめず、ポートのそば(ports[].note)に置く(SIM-API.md 第 9 章)。macs なら MAC も見せる
function mkDiagram(spec, ids, { macs = false, net = null } = {}) {
  const d = sim.diagram(spec, { nodeIds: ids });
  const n = net || sim.build(spec);
  for (const node of d.nodes) {
    const dev = n.devices[node.name]; if (!dev) continue;
    if (dev.kind === 'router' || dev.kind === 'l3switch' || dev.kind === 'firewall') {
      const svis = dev.ifaces.filter((f) => f.vlanId && f.ip).map((f) => `${f.name} ${f.ip}/${f.len}`);
      node.note = svis.length ? svis.join('\n') : null;
      for (const p of node.ports) { const f = dev.ifByName[p.name]; if (!f) continue; const parts = []; if (f.ip) parts.push(`${f.ip}/${f.len}`); if (macs && f.mac) parts.push(`MAC ${f.mac}`); p.note = parts.join('\n') || null; }
    } else if (macs && (dev.kind === 'host' || dev.kind === 'server')) node.note = `${node.note || ''}\nMAC ${dev.ifaces[0].mac}`.trim();
  }
  return d;
}
// 要件の文(画面に見せる)
function reqText(reqs) {
  return reqs.map((r) => {
    let t = '';
    if (r.kind === 'reach') { const how = r.proto === 'tcp' || r.proto === 'udp' ? `${r.proto.toUpperCase()} ${r.port} で` : 'ping で'; t = `${r.from} から ${r.to || r.toIp} へ ${how}${r.expect === false ? '届かない(止める)' : '往復で届く'}`; }
    else if (r.kind === 'route') t = `${r.device} の経路表に ${r.prefix} の行がある${r.via ? `(次の相手 ${r.via})` : ''}`;
    else if (r.kind === 'vlan') t = `${r.device} の ${r.port} が VLAN ${r.vlan} のアクセスポート`;
    else if (r.kind === 'trunk') t = `${r.device} の ${r.port} がトランクで VLAN ${r.allowed.join('・')} を通す`;
    else if (r.kind === 'lease') t = r.host ? `${r.host} が DHCP で最初にもらうアドレスが ${r.ip}${r.gateway ? `(デフォルトゲートウェイ ${r.gateway} も配る)` : ''}` : `${r.device} の範囲 ${r.pool} で配れるアドレスの数が ${r.count}`;
    else t = JSON.stringify(r);
    return { id: r.id, text: t };
  });
}
const cfgText = (configs) => configs.map((c) => `[${c.device}]\n${c.text}`).join('\n');
// 設定の問題の共通の形。spec に editable と requirements を入れ、図・今の設定の抜粋・要件の文・正解の例(送らない)を付ける
function configQ(rng, { spec, editable, reqs, solution, wrong, text, why, firstStep, meta, hide = [] }) {
  spec.editable = editable; spec.requirements = reqs;
  const net = sim.build(spec);
  const ids = nodeIds(rng, spec);
  const configView = {}; for (const dv of editable) configView[dv] = sim.runningConfig(net, dv, { hide });
  return {
    text, answerKind: 'config', diagram: mkDiagram(spec, ids, { net }), editable, configView, requirementsText: reqText(reqs),
    sim: { spec, requirements: reqs }, solution, wrong,
    explanation: `${why}\n正しい設定の例:\n${cfgText(solution)}\nほかの書き方でも、要件をすべて満たせば正解。`, firstStep, meta,
  };
}
// 設定の問題の確かめ: 正解の例が通り、壊した設定が通らない
function verifyConfig(q) {
  const good = sim.judgeConfig(q.sim.spec, q.solution);
  if (!good.ok) throw new Error(`Lv${q.level || ''} 正解の例が通らない: ${JSON.stringify({ failed: good.failed, errors: good.errors, results: good.results })}`);
  for (const w of q.wrong || []) { const bad = sim.judgeConfig(q.sim.spec, w); if (bad.ok) throw new Error(`壊した設定が正解になる: ${JSON.stringify(w)}`); }
  const empty = sim.judgeConfig(q.sim.spec, []); if (empty.ok) throw new Error('何も書かなくても正解になる');
  if (!q.requirementsText.length || !q.diagram || !q.editable.length) throw new Error('設定の問題の形が足りない');
}
// ターミナルの問題: 実際に打って出力から答えを読み直す
function termRun(spec, start, lines) { const s = sim.session(spec, start); return lines.map((l) => sim.exec(s, l)); }
// 経路表(図の中で機器をタップすると出る表)
function routeTable(spec, dev) {
  const d = spec.devices[dev]; const rows = [];
  for (const f of d.ifaces) if (f.ip) rows.push([sim.util.cidrOf(ipOf(f.ip), Number(f.ip.split('/')[1])), '直結', f.name]);
  for (const r of d.routes || []) rows.push([r.prefix, r.via, '—']);
  return { title: `${dev} の経路表`, headers: ['宛先', '次の相手', 'IF'], rows };
}

// ================= Lv192 止めるポート(STP。tap port) =================
const PRIO = { low: 4096, mid: 8192, def: 32768 };
function stpQ(rng) {
  const A = sim.gen.addresses(rng); const lan = A.lan();
  const sws = ['SW1', 'SW2', 'SW3'];
  const variant = rng.pick(['prio', 'prio', 'two', 'mac']);
  const prio = { SW1: PRIO.def, SW2: PRIO.def, SW3: PRIO.def };
  if (variant === 'prio') prio[rng.pick(sws)] = PRIO.low;
  if (variant === 'two') { const [a, b] = rng.shuffle(sws); prio[a] = PRIO.low; prio[b] = PRIO.mid; }
  const ports = { SW1: ['Gi1/0/23', 'Gi1/0/24'], SW2: ['Gi1/0/22', 'Gi1/0/23'], SW3: ['Gi1/0/22', 'Gi1/0/24'] };
  const spec = {
    seed: rng.rand(0, 2 ** 31), layout: { pos: { SW1: [250, 160], SW2: [750, 160], SW3: [500, 440], PC1: [90, 160], PC2: [910, 160], PC3: [500, 560] } },
    devices: { PC1: { kind: 'host', ip: `${lan}.${rng.rand(10, 99)}/24` }, PC2: { kind: 'host', ip: `${lan}.${rng.rand(100, 199)}/24` }, PC3: { kind: 'host', ip: `${lan}.${rng.rand(200, 250)}/24` } },
    links: [['PC1', 'SW1:Gi1/0/1'], ['PC2', 'SW2:Gi1/0/1'], ['PC3', 'SW3:Gi1/0/1'], ['SW1:Gi1/0/23', 'SW2:Gi1/0/22'], ['SW2:Gi1/0/23', 'SW3:Gi1/0/22'], ['SW1:Gi1/0/24', 'SW3:Gi1/0/24']],
    editable: [], requirements: [], meta: { variant },
  };
  for (const s of sws) spec.devices[s] = { kind: 'switch', stpPriority: prio[s], ifaces: ['Gi1/0/1', ...ports[s]].map((p) => ({ name: p })) }; // ポートを spec に書いておく(リンクだけで作られたポートには MAC が付かず、ブリッジ ID が全部同じになる)
  const net = sim.build(spec); const st = sim.state(net);
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids, { net });
  const bidOf = {}; for (const s of sws) bidOf[s] = st.stp.bridges[s].bid;
  for (const node of diagram.nodes) if (sws.includes(node.name)) node.note = `優先度 ${prio[node.name]}\nMAC ${bidOf[node.name].split('.')[1]}`;
  // 生成の側: 模擬の STP から代替ポートを取る
  const alt = []; for (const s of sws) for (const [p, role] of Object.entries(st.stp.bridges[s].ports)) if (role === 'alternate') alt.push({ sw: s, port: p });
  if (alt.length !== 1) throw new Error(`Lv192: 代替ポートが ${alt.length}`);
  const root = st.stp.root; const others = sws.filter((s) => s !== root);
  const acceptId = `${ids[alt[0].sw]}:${alt[0].port}`;
  return {
    text: `LAN(${lan}.0/24)の 3 台のスイッチを輪につないである(全部 1 Gbps)。STP の決まり: ブリッジ ID は「優先度 + MAC アドレス」で、小さい方が根(ルートブリッジ)。線のコストは全部同じ。根でないスイッチは、根にいちばん近い(コストが同じなら、相手のブリッジ ID が小さい)ポートをルートポートにする。同じ線の両端では、ブリッジ ID の小さいスイッチ側が指定ポートになり、もう一方は代替ポート(止める)になる。図の各スイッチの優先度と MAC を見て、STP で止まる(代替になる)ポートをタップせよ。`,
    answerKind: 'tap', tap: { mode: 'port' }, diagram, accept: { ids: [acceptId] }, sim: { spec },
    firstStep: 'まず根を決める(優先度がいちばん小さいスイッチ。同じなら MAC がいちばん小さいスイッチ)',
    explanation: `正解は ${alt[0].sw} の ${alt[0].port}。根は ${root}(ブリッジ ID ${bidOf[root]})。${list(others.map((s) => `${s} は根に直接つながるポートがルートポート`))}。残る ${others[0]} と ${others[1]} の間の線では、ブリッジ ID の小さい ${others.find((s) => s !== alt[0].sw)}(${bidOf[others.find((s) => s !== alt[0].sw)]})側が指定ポート、大きい ${alt[0].sw}(${bidOf[alt[0].sw]})側の ${alt[0].port} が代替ポートになって止まる。${variant === 'mac' ? '優先度が全部同じなので、MAC アドレスだけで決まる。' : variant === 'prio' ? `根は優先度 ${PRIO.low} の ${root} で決まり、残り 2 台は優先度が同じなので MAC で比べる。` : '優先度だけで全部決まる(MAC は見なくてよい)。'}`,
    meta: { variant, root, alt: alt[0].sw },
  };
}
function verifyStp(q) { // spec の優先度と図の MAC から、素朴に決め直す
  const spec = q.sim.spec; const sws = ['SW1', 'SW2', 'SW3'];
  const bid = {}; for (const n of q.diagram.nodes) if (sws.includes(n.name)) { const m = /MAC ([0-9a-f:]+)/.exec(n.note); bid[n.name] = `${String(spec.devices[n.name].stpPriority).padStart(5, '0')}.${m[1]}`; }
  const root = sws.slice().sort((a, b) => (bid[a] < bid[b] ? -1 : 1))[0];
  const [a, b] = sws.filter((s) => s !== root).sort((x, y) => (bid[x] < bid[y] ? -1 : 1)); // a が小さい → b 側が代替
  const link = spec.links.find((l) => [l[0], l[1]].every((e) => e.startsWith(`${a}:`) || e.startsWith(`${b}:`)));
  const port = link.find((e) => e.startsWith(`${b}:`)).split(':')[1];
  const want = `${idOfName(q, b)}:${port}`;
  if (q.accept.ids.length !== 1 || q.accept.ids[0] !== want) throw new Error(`Lv192: 代替が違う ${q.accept.ids[0]} / ${want}`);
  if (!q.diagram.nodes.find((n) => n.name === b).ports.some((p) => p.id === want)) throw new Error('Lv192: 正解のポートが図に無い');
}

// ================= Lv193 区間ごとの MAC と IP(入力) =================
function macQ(rng) {
  const routers = rng.rand(2, 3);
  const spec = sim.gen.serial(rng, { routers, switches: true });
  const net = sim.build(spec);
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids, { macs: true, net });
  // 区間: PC1–R1 / R1–R2 / … / Rn–PC2。向きは PC1 → PC2 か逆
  const chain = ['PC1', ...Array.from({ length: routers }, (_, i) => `R${i + 1}`), 'PC2'];
  const k = rng.rand(0, chain.length - 2); const fwd = rng.next() < 0.6;
  const [X, Y] = fwd ? [chain[k], chain[k + 1]] : [chain[k + 1], chain[k]];
  const src = fwd ? 'PC1' : 'PC2', dst = fwd ? 'PC2' : 'PC1';
  const macOnSeg = (dev, other) => { // dev の、other と同じ網にある IF の MAC
    const d = net.devices[dev]; const o = net.devices[other];
    for (const f of d.ifaces) for (const g of o.ifaces) if (f.ip && g.ip && f.len === g.len && sim.util.inNet(f.ip, g.ip, f.len)) return f.mac;
    throw new Error('同じ網の IF が無い');
  };
  const sm = macOnSeg(X, Y), dm = macOnSeg(Y, X);
  const sip = ipOf(spec.devices[src].ip), dip = ipOf(spec.devices[dst].ip);
  const segName = `${X} と ${Y} の間`;
  return {
    text: `${src}(${sip})から ${dst}(${dip})へ ping を送る。図には各機器の IF のアドレスと MAC アドレスを書いてある。このパケットが ${segName}の線を通るとき、イーサネットのフレームの送信元 MAC・宛先 MAC と、IP の送信元・宛先はそれぞれ何か。`,
    diagram, sim: { spec },
    ...textQ([field('smac', '送信元 MAC', 'mac', sm, '例: 02:00:1a:2b:3c:4d'), field('dmac', '宛先 MAC', 'mac', dm, '例: 02:00:1a:2b:3c:4e'), field('sip', '送信元 IP', 'ipv4', sip, '例: 10.1.1.10'), field('dip', '宛先 IP', 'ipv4', dip, '例: 10.3.3.20')]),
    firstStep: 'まず IP は端から端まで変わらないことを押さえ、MAC だけがその区間の両端の IF のものになると考える',
    explanation: `正解は 送信元 MAC ${sm}(${X} のこの区間側の IF)、宛先 MAC ${dm}(${Y} のこの区間側の IF)、送信元 IP ${sip}(${src})、宛先 IP ${dip}(${dst})。IP アドレスはルーターを越えても変わらない(NAT は無い)。MAC アドレスは区間ごとに付け替わり、その区間の送り手の IF と受け手の IF のものになる。`,
    meta: { routers, k, fwd, seg: X === 'PC1' || Y === 'PC1' ? 'first' : X === 'PC2' || Y === 'PC2' ? 'last' : 'mid' },
  };
}
function verifyMac(q) { // 問題文の区間と向きから、図の MAC(ポートの note と機器の note)で読み直す
  const m = /^(PC\d)\([\d.]+\)から (PC\d)\([\d.]+\)へ ping を送る。.*このパケットが (\S+) と (\S+) の間の線を通るとき/.exec(q.text);
  const [, src, dst, X, Y] = m;
  const macOf = (dev, other) => {
    const node = q.diagram.nodes.find((n) => n.name === dev);
    if (dev.startsWith('PC')) return /MAC ([0-9a-f:]+)/.exec(node.note)[1];
    // ルーター: other につながる線のポートの note
    const otherId = idOfName(q, other);
    const viaSw = (id) => { const n = q.diagram.nodes.find((x) => x.id === id); return n && n.kind === 'switch'; };
    let port = null;
    for (const l of q.diagram.links) {
      for (const [me, o] of [[l.a, l.b], [l.b, l.a]]) {
        if (me.node !== node.id) continue;
        if (o.node === otherId) port = me.port;
        else if (viaSw(o.node)) { const sw = o.node; if (q.diagram.links.some((l2) => (l2.a.node === sw && l2.b.node === otherId) || (l2.b.node === sw && l2.a.node === otherId))) port = me.port; }
      }
    }
    const p = node.ports.find((x) => x.name === port); return /MAC ([0-9a-f:]+)/.exec(p.note)[1];
  };
  const want = [macOf(X, Y), macOf(Y, X), ipOf(q.sim.spec.devices[src].ip), ipOf(q.sim.spec.devices[dst].ip)];
  q.fields.forEach((f, i) => { if (f.accept[0] !== want[i]) throw new Error(`Lv193: ${f.name} が違う ${f.accept[0]} / ${want[i]}`); });
  if (want[0] === want[1]) throw new Error('Lv193: 送信元と宛先の MAC が同じ');
}

// ================= Lv200・201 静的経路・デフォルトルート(config) =================
function routeQ(rng, kind) {
  const spec = sim.gen.serial(rng, { routers: 2, switches: rng.next() < 0.5 });
  const { lan1, lan2 } = spec.meta;
  attachInet(spec, 'R2');
  const nh = ifIp(spec, 'R2', 'Gi0/0');
  spec.devices.R1.routes = []; // R1 の経路を全部消す(直結だけ)
  const syntax = '書き方: ip route <網>/<長さ> <次の相手のアドレス>(デフォルトルートは 0.0.0.0/0)。';
  if (kind === 'static') {
    const reqs = [{ id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }, { id: 2, kind: 'route', device: 'R1', prefix: `${lan2}.0/24` }, { id: 3, kind: 'reach', from: 'PC1', to: 'INET', expect: false }];
    return configQ(rng, {
      spec, editable: ['R1'], reqs,
      solution: [{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh}` }],
      wrong: [[{ device: 'R1', text: `ip route 0.0.0.0/0 ${nh}` }], [{ device: 'R1', text: `ip route ${lan2}.0/24 ${ifIp(spec, 'R1', 'Gi0/1')}` }]],
      text: `R1 には ${lan2}.0/24(PC2 の網)への経路が無く、PC1 から PC2 に届かない。R1 に静的経路を 1 つ書いて、PC1 と PC2 が往復で届くようにせよ。ただし、この拠点から外(INET。203.0.113.0/24)へは出さない決まりなので、何でも通すデフォルトルートは書かないこと(R2 は外へ出る NAT の設定が済んでいる)。${syntax}`,
      why: `R1 から見て ${lan2}.0/24 は R2 の先にあるので、次の相手は R2 の R1 側のアドレス ${nh}。デフォルトルート(0.0.0.0/0)を書くと外(INET)にも届いてしまい、要件 3 に反する。次の相手に自分の IF のアドレスを書いても相手には届かない。`,
      firstStep: 'まず宛先の網(PC2 の /24)と、その方向にいる隣のルーターのアドレスを図から読む', meta: { kind, lan2 },
    });
  }
  const reqs = [{ id: 1, kind: 'route', device: 'R1', prefix: '0.0.0.0/0' }, { id: 2, kind: 'reach', from: 'PC1', to: 'INET', roundTrip: true }, { id: 3, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }];
  return configQ(rng, {
    spec, editable: ['R1'], reqs,
    solution: [{ device: 'R1', text: `ip route 0.0.0.0/0 ${nh}` }],
    wrong: [[{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh}` }], [{ device: 'R1', text: `ip route 0.0.0.0/0 ${ifIp(spec, 'R1', 'Gi0/0')}` }]],
    text: `R1 には直結の網しか経路が無く、PC1(${ipOf(spec.devices.PC1.ip)})から外(INET。203.0.113.0/24)にも PC2(${ipOf(spec.devices.PC2.ip)})にも届かない。R1 にデフォルトルートを 1 つ書いて、PC1 から外と PC2 の両方に届くようにせよ(R2 は外へ出る NAT の設定が済んでいる)。${syntax}`,
    why: `R1 から見ると、PC2 の網も外(INET)も全部 R2 の先にあるので、宛先ごとに書かずに 0.0.0.0/0(どこ宛でも)を R2 の R1 側のアドレス ${nh} へ向ければよい。${lan2}.0/24 だけ書くと外へ出られない。次の相手に自分の IF を書いても相手には届かない。`,
    firstStep: 'まず「R1 から見て R2 の先に何があるか」を数える(全部なら、宛先ごとではなく 0.0.0.0/0 で書ける)', meta: { kind },
  });
}

// ================= Lv215 問い合わせの道具(模擬ターミナル) =================
const SITES = ['sakura', 'ume', 'matsu', 'kaede', 'momiji'];
const HOSTS = ['www', 'mail', 'portal', 'files', 'wiki'];
function dnsSpec(rng) {
  const spec = sim.gen.serial(rng, { routers: rng.rand(1, 2), switches: true });
  const { lan1, lan2 } = spec.meta;
  const site = rng.pick(SITES), host = rng.pick(HOSTS);
  const name = `${host}.${site}.example`;
  const target = ipOf(spec.devices.PC2.ip);
  const cname = rng.next() < 0.4;
  const records = cname ? [{ name, type: 'CNAME', value: `srv.${site}.example` }, { name: `srv.${site}.example`, type: 'A', value: target }] : [{ name, type: 'A', value: target }];
  records.push({ name: `${rng.pick(HOSTS.filter((h) => h !== host))}.${site}.example`, type: 'A', value: `${lan2}.${rng.rand(201, 250)}` }); // 違う名前の記録(まぎれ)
  spec.devices.SRV1 = { kind: 'server', ip: `${lan1}.5/24`, gateway: `${lan1}.1`, listen: [{ proto: 'udp', port: 53 }], dnsRecords: records }; // .5(PC のアドレスは .10 以上なので重ならない)
  spec.links.push(['SRV1', 'SW1:Gi1/0/9']);
  spec.devices.PC1.dns = `${lan1}.5`;
  layoutWith(spec, { SRV1: [230, 120] });
  return { spec, name, target, cname };
}
function dnsToolQ(rng) {
  const { spec, name, target, cname } = dnsSpec(rng);
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids);
  const variant = rng.next() < 0.7 ? 'lookup' : 'tool';
  const base = { diagram, terminal: { devices: ['PC1'], start: 'PC1' }, sim: { spec }, meta: { variant, cname } };
  if (variant === 'tool') {
    const options = rng.shuffle(['nslookup', 'ping', 'arp -a', 'traceroute']);
    return { ...base, text: `PC1 のターミナルで、名前 ${name} に対応するアドレスを DNS サーバーに問い合わせたい(つながるかどうかではなく、名前からアドレスを引く)。この目的に合うコマンドはどれか。下のターミナルで試してよい。`, options, answerIndex: options.indexOf('nslookup'), firstStep: 'まず「名前 → アドレス」を引く道具と、「届くか」を見る道具を分けて考える', explanation: '正解は nslookup。名前からアドレス(やその逆)を DNS サーバーに問い合わせる道具。ping と traceroute は届くか・どこを通るかを見るもので、名前を入れても裏で引くだけ。arp -a は同じ網の中の IP と MAC の対応を見るもの。' };
  }
  return {
    ...base, text: `PC1 のターミナルで、名前 ${name} のアドレスを DNS サーバー(${spec.devices.PC1.dns})に問い合わせ、返ってきた IPv4 アドレスを答えよ。${cname ? '(別名が返ることがある。その場合は本名のアドレスまでたどる)' : ''}`,
    ...textQ([field('ip', `${name} のアドレス`, 'ipv4', target, '例: 10.2.2.20')]),
    firstStep: 'まず nslookup <名前> を打つ',
    explanation: `正解は ${target}。nslookup ${name} で DNS サーバーに問い合わせると${cname ? `、まず CNAME(別名)で srv.… が返り、その A レコードが ${target}` : ` A レコード ${target} が返る`}。${target} は PC2 のアドレス。`,
  };
}
function verifyDnsTool(q) {
  if (q.meta.variant === 'tool') { if (q.options[q.answerIndex] !== 'nslookup') throw new Error('Lv215: 道具が違う'); return; }
  const name = /名前 (\S+) のアドレスを/.exec(q.text)[1];
  const [out] = termRun(q.sim.spec, 'PC1', [`nslookup ${name}`]);
  const m = out.match(/ A {2}(\d+\.\d+\.\d+\.\d+)/g); if (!m) throw new Error(`Lv215: nslookup の出力に A が無い: ${out}`);
  const last = /(\d+\.\d+\.\d+\.\d+)/.exec(m[m.length - 1])[1];
  if (q.fields[0].accept[0] !== last) throw new Error(`Lv215: 出力と答えが違う ${last}`);
  if (q.meta.cname && !/CNAME/.test(out)) throw new Error('Lv215: CNAME が出ていない');
}

// ================= Lv228 traceroute を読む(模擬ターミナル) =================
function parseTrace(out) { return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+) ms/.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[1]), ip: m[2] })); }
function traceReadQ(rng) {
  const routers = rng.rand(2, 3);
  const spec = sim.gen.serial(rng, { routers, switches: true });
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids);
  const variant = rng.pick(routers === 3 ? ['third', 'count', 'second'] : ['count', 'second']);
  const hops = Array.from({ length: routers }, (_, i) => ifIp(spec, `R${i + 1}`, 'Gi0/0')); // 各ルーターの入ってきた側(PC1 側)の IF
  const base = { diagram, terminal: { devices: ['PC1'], start: 'PC1' }, sim: { spec }, meta: { variant, routers } };
  const expl = `PC1 で traceroute ${ipOf(spec.devices.PC2.ip)} を打つと、${hops.map((h, i) => `${i + 1} 番目に ${h}(R${i + 1} の PC1 側の IF)`).join('、')}、最後に PC2 が並ぶ。各行はそのルーターの「入ってきた側」の IF のアドレスで、ルーターの台数は PC2 の前の行の数。`;
  if (variant === 'count') return { ...base, text: `PC1 のターミナルで PC2(${ipOf(spec.devices.PC2.ip)})へ traceroute を打ち、PC1 から PC2 までの間に通るルーターの台数を答えよ(図のルーターの絵を数えるのではなく、出力から読む)。`, ...textQ([field('n', 'ルーターの台数', 'number', routers, '例: 2')]), firstStep: 'まず traceroute <PC2 のアドレス> を打つ', explanation: `正解は ${routers} 台。${expl}` };
  const k = variant === 'third' ? 3 : 2;
  return { ...base, text: `PC1 のターミナルで PC2(${ipOf(spec.devices.PC2.ip)})へ traceroute を打ち、${k} 番目に返事をしたルーターのアドレス(出力の ${k} 行目のアドレス)を答えよ。`, ...textQ([field('ip', `${k} 番目のアドレス`, 'ipv4', hops[k - 1], '例: 10.0.12.2')]), firstStep: 'まず traceroute <PC2 のアドレス> を打ち、行の番号を数える', explanation: `正解は ${hops[k - 1]}。${expl}` };
}
function verifyTraceRead(q) {
  const dst = ipOf(q.sim.spec.devices.PC2.ip);
  const [out] = termRun(q.sim.spec, 'PC1', [`traceroute ${dst}`]);
  const hops = parseTrace(out);
  if (!hops.length || hops[hops.length - 1].ip !== dst) throw new Error(`Lv228: traceroute が届いていない: ${out}`);
  const routers = hops.length - 1;
  if (q.meta.variant === 'count') { if (q.fields[0].accept[0] !== String(routers)) throw new Error('Lv228: 台数が違う'); return; }
  const k = q.meta.variant === 'third' ? 3 : 2;
  if (q.fields[0].accept[0] !== hops[k - 1].ip) throw new Error(`Lv228: ${k} 番目が違う ${hops[k - 1].ip}`);
}

// ================= Lv241 通る機器を順に(tap order) =================
function pathQ(rng) {
  const shape = rng.pick(['tri', 'tri', 'serial']);
  let spec, routersOrder, why;
  const fwd = rng.next() < 0.7;
  if (shape === 'serial') {
    spec = sim.gen.serial(rng, { routers: 3, switches: true });
    routersOrder = ['R1', 'R2', 'R3'];
    why = '直列なので R1 → R2 → R3 の順に通る(スイッチと PC は数えない)。';
  } else {
    let costs;
    do { costs = { r1r2: rng.pick([1, 1, 2, 5]), r2r3: rng.pick([1, 1, 2, 5]), r1r3: rng.pick([1, 2, 5, 10, 10]) }; } while (costs.r1r3 === costs.r1r2 + costs.r2r3);
    spec = sim.gen.triangle(rng, { costs });
    const direct = costs.r1r3 < costs.r1r2 + costs.r2r3;
    routersOrder = direct ? ['R1', 'R3'] : ['R1', 'R2', 'R3'];
    why = `OSPF は合計のコストが小さい道を選ぶ。R1–R3 の直接の線はコスト ${costs.r1r3}、R2 回り(R1–R2–R3)は ${costs.r1r2} + ${costs.r2r3} = ${costs.r1r2 + costs.r2r3} なので、${direct ? '直接の線' : 'R2 回り'}を通る。`;
  }
  if (!fwd) routersOrder = routersOrder.slice().reverse();
  const src = fwd ? 'PC1' : 'PC2', dst = fwd ? 'PC2' : 'PC1';
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids);
  if (shape !== 'serial') { // 線のラベルにコストを足す
    const c = spec.meta.costs; const pairs = { 'R1|R2': c.r1r2, 'R2|R3': c.r2r3, 'R1|R3': c.r1r3 };
    for (const l of diagram.links) { const a = nameOfId({ diagram }, l.a.node), b = nameOfId({ diagram }, l.b.node); const k = [a, b].sort().join('|'); if (pairs[k] !== undefined) l.label = `${l.label || ''}(コスト ${pairs[k]})`.trim(); }
  }
  const net = sim.build(spec); const r = sim.reach(net, src, dst, { roundTrip: false });
  const got = r.path.filter((n) => n.startsWith('R'));
  if (!r.ok || got.join() !== routersOrder.join()) throw new Error(`Lv241: 模擬の道と合わない ${r.path}`);
  return {
    text: `${src}(${ipOf(spec.devices[src].ip)})から ${dst}(${ipOf(spec.devices[dst].ip)})へパケットを送るとき、通るルーターを順にタップせよ(PC とスイッチはタップしない)。${shape === 'serial' ? '' : 'ルーターどうしは OSPF で経路を交換していて、線のコストは図のとおり。OSPF は合計のコストがいちばん小さい道を選ぶ。'}`,
    answerKind: 'tap', tap: { mode: 'order' }, diagram, accept: { ids: routersOrder.map((n) => ids[n]) }, sim: { spec },
    firstStep: shape === 'serial' ? 'まず送り元の PC のゲートウェイ(いちばん近いルーター)から順にたどる' : 'まず 2 つの道の合計のコストを計算して比べる',
    explanation: `正解は ${routersOrder.join(' → ')}。${why}`,
    meta: { shape, fwd, hops: routersOrder.length, direct: shape !== 'serial' && routersOrder.length === 2 },
  };
}
function verifyPath(q) { // 図のコストから総当たりで最短を決め直す(直列はつながり順)
  const spec = q.sim.spec; const names = q.accept.ids.map((id) => nameOfId(q, id));
  const fwd = /^PC1\(/.test(q.text);
  let want;
  if (spec.layout === 'serial' || (spec.meta && spec.meta.routers)) want = fwd ? ['R1', 'R2', 'R3'] : ['R3', 'R2', 'R1'];
  else {
    const cost = {}; for (const l of q.diagram.links) { const m = /コスト (\d+)/.exec(l.label || ''); if (m) cost[[nameOfId(q, l.a.node), nameOfId(q, l.b.node)].sort().join('|')] = Number(m[1]); }
    const direct = cost['R1|R3'], around = cost['R1|R2'] + cost['R2|R3'];
    if (direct === around) throw new Error('Lv241: 同じコストで決まらない');
    want = direct < around ? ['R1', 'R3'] : ['R1', 'R2', 'R3']; if (!fwd) want.reverse();
  }
  if (names.join() !== want.join()) throw new Error(`Lv241: 順が違う ${names} / ${want}`);
}

// ================= Lv242 止まる所(tap one) =================
function stopQ(rng) {
  const routers = rng.rand(2, 3);
  const spec = sim.gen.serial(rng, { routers, switches: true });
  const { lan1, lan2 } = spec.meta;
  const cause = rng.pick(['no-route', 'no-route', 'wrong-gw', 'bad-nexthop']);
  let stopDev, why;
  if (cause === 'wrong-gw') { const bad = `${lan1}.${rng.pick([254, 253, 252])}`; spec.devices.PC1.gateway = bad; stopDev = 'PC1'; why = `PC1 のデフォルトゲートウェイが ${bad} になっているが、その番地に機器はいない(R1 は ${lan1}.1)。PC1 は ARP で答えが無く、最初の 1 歩が出せない。`; }
  else if (cause === 'no-route') { const k = rng.rand(1, routers - 1); spec.devices[`R${k}`].routes = spec.devices[`R${k}`].routes.filter((r) => !r.prefix.startsWith(lan2)); stopDev = `R${k}`; why = `R${k} の経路表に ${lan2}.0/24(PC2 の網)の行が無い。R${k} まではたどり着くが、そこで宛先に合う行が無くて捨てられる。`; }
  else { const bad = `${lan1}.${rng.pick([250, 251, 252])}`; const r = spec.devices.R1.routes.find((x) => x.prefix.startsWith(lan2)); r.via = bad; stopDev = 'R1'; why = `R1 の ${lan2}.0/24 の行の次の相手が ${bad} になっているが、その番地に機器はいない。R1 は行を見つけるが、次の相手に ARP で届かず捨てる。`; }
  const net = sim.build(spec); const r = sim.reach(net, 'PC1', 'PC2', { roundTrip: false });
  if (r.ok || r.stoppedAt !== stopDev) throw new Error(`Lv242: 模擬の止まる所が合わない ${r.stoppedAt} / ${stopDev}`);
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids, { net });
  diagram.tables = {}; for (let i = 1; i <= routers; i++) diagram.tables[ids[`R${i}`]] = [routeTable(spec, `R${i}`)];
  return {
    text: `PC1(${ipOf(spec.devices.PC1.ip)})から PC2(${ipOf(spec.devices.PC2.ip)})へ ping を送ったが届かない。図の各ルーターをタップすると経路表が見られる(PC の設定は図の note)。PC1 から出たパケットが捨てられる(止まる)機器をタップせよ。`,
    answerKind: 'tap', tap: { mode: 'one' }, diagram, accept: { ids: [ids[stopDev]] }, sim: { spec },
    firstStep: 'まず PC1 のゲートウェイのアドレスが、R1 の LAN 側の IF と同じかを見る。同じなら R1 から順に経路表をたどる',
    explanation: `正解は ${stopDev}。${why}ほかの機器の設定は正しい。`,
    meta: { cause, routers, stopDev },
  };
}
function verifyStop(q) { // spec を自分で読んで 1 ホップずつ進める(経路表は最長一致、次の相手がいなければ止まる)
  const spec = q.sim.spec; const U = sim.util;
  const dst = ipOf(spec.devices.PC2.ip);
  const allIps = new Set(); for (const d of Object.values(spec.devices)) { if (d.ip) allIps.add(ipOf(d.ip)); for (const f of d.ifaces || []) if (f.ip) allIps.add(ipOf(f.ip)); }
  const pc = spec.devices.PC1; let stop = null;
  if (!pc.gateway || !allIps.has(pc.gateway) || !U.inNet(pc.gateway, ipOf(pc.ip), Number(pc.ip.split('/')[1]))) stop = 'PC1';
  let cur = 'R1', guard = 0;
  while (!stop && guard++ < 10) {
    const d = spec.devices[cur];
    const conn = d.ifaces.filter((f) => f.ip).map((f) => ({ prefix: U.cidrOf(ipOf(f.ip), Number(f.ip.split('/')[1])), via: null }));
    const rows = conn.concat(d.routes || []);
    let best = null; for (const r of rows) { const [n, l] = r.prefix.split('/'); if (U.inNet(dst, n, Number(l)) && (!best || Number(l) > Number(best.prefix.split('/')[1]))) best = r; }
    if (!best) { stop = cur; break; }
    if (!best.via) { if (allIps.has(dst)) break; stop = cur; break; } // 直結: PC2 がいる
    if (!allIps.has(best.via)) { stop = cur; break; }
    const next = Object.entries(spec.devices).find(([, dd]) => (dd.ifaces || []).some((f) => f.ip && ipOf(f.ip) === best.via));
    cur = next[0];
  }
  const want = stop ? idOfName(q, stop) : null;
  if (!want || q.accept.ids[0] !== want) throw new Error(`Lv242: 止まる所が違う ${stop} / ${nameOfId(q, q.accept.ids[0])}`);
}

// ================= Lv243 往復の静的経路(config) =================
function roundTripQ(rng) {
  const spec = sim.gen.serial(rng, { routers: 3, switches: rng.next() < 0.5 });
  const { lan1, lan2 } = spec.meta;
  attachInet(spec, 'R2', [540, 120]);
  spec.devices.R1.routes = spec.devices.R1.routes.filter((r) => !r.prefix.startsWith(lan2));
  spec.devices.R3.routes = spec.devices.R3.routes.filter((r) => !r.prefix.startsWith(lan1));
  const nh1 = ifIp(spec, 'R2', 'Gi0/0'), nh3 = ifIp(spec, 'R2', 'Gi0/1');
  const reqs = [{ id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }, { id: 2, kind: 'route', device: 'R1', prefix: `${lan2}.0/24` }, { id: 3, kind: 'route', device: 'R3', prefix: `${lan1}.0/24` }, { id: 4, kind: 'reach', from: 'PC1', to: 'INET', expect: false }, { id: 5, kind: 'reach', from: 'PC2', to: 'INET', expect: false }];
  return configQ(rng, {
    spec, editable: ['R1', 'R3'], reqs,
    solution: [{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh1}` }, { device: 'R3', text: `ip route ${lan1}.0/24 ${nh3}` }],
    wrong: [[{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh1}` }], [{ device: 'R1', text: `ip route 0.0.0.0/0 ${nh1}` }, { device: 'R3', text: `ip route 0.0.0.0/0 ${nh3}` }], [{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh3}` }, { device: 'R3', text: `ip route ${lan1}.0/24 ${nh1}` }]],
    text: `R1 には PC2 の網(${lan2}.0/24)への経路が、R3 には PC1 の網(${lan1}.0/24)への経路が無い。R1 と R3 に静的経路を書いて、PC1 と PC2 が往復で届くようにせよ。この拠点から外(INET。203.0.113.0/24)へは出さない決まりなので、デフォルトルートは書かないこと(R2 の経路と NAT は設定済みで変えられない)。書き方: ip route <網>/<長さ> <次の相手のアドレス>。`,
    why: `行きは R1 に ${lan2}.0/24 → ${nh1}(R2 の R1 側)、返りは R3 に ${lan1}.0/24 → ${nh3}(R2 の R3 側)。片方だけだと行きは届いても返事が戻らず、ping は失敗する。次の相手は「自分の隣」のアドレス(R2 の、自分につながっている側)にする。デフォルトルートを書くと外(INET)にも届いてしまう。`,
    firstStep: 'まず行き(PC1 → PC2)に足りない経路と、返り(PC2 → PC1)に足りない経路を分けて考える', meta: { nh1, nh3 },
  });
}

// ================= Lv244 VLAN を作る(config) =================
function vlanCreateQ(rng) {
  const A = sim.gen.addresses(rng); const lan = A.lan();
  const v = rng.pick([10, 20, 30]), v2 = rng.pick([40, 50, 99]);
  const hosts = ['PC1', 'PC2', 'PC3']; const ips = new Set(); const ip = () => { let h; do { h = rng.rand(10, 200); } while (ips.has(h)); ips.add(h); return `${lan}.${h}/24`; };
  const spec = { seed: rng.rand(0, 2 ** 31), layout: { pos: { SW1: [500, 300], PC1: [160, 140], PC2: [160, 460], PC3: [840, 300] } }, devices: { SW1: { kind: 'switch' } }, links: [], editable: [], requirements: [], meta: { lan, v, v2 } };
  hosts.forEach((h, i) => { spec.devices[h] = { kind: 'host', ip: ip() }; spec.links.push([h, `SW1:Gi1/0/${i + 1}`]); });
  const reqs = [{ id: 1, kind: 'vlan', device: 'SW1', port: 'Gi1/0/1', vlan: v }, { id: 2, kind: 'vlan', device: 'SW1', port: 'Gi1/0/2', vlan: v }, { id: 3, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }, { id: 4, kind: 'reach', from: 'PC1', to: 'PC3', expect: false }];
  return configQ(rng, {
    spec, editable: ['SW1'], reqs,
    solution: [{ device: 'SW1', text: `vlan ${v}\ninterface Gi1/0/1-2\n switchport mode access\n switchport access vlan ${v}` }],
    wrong: [[{ device: 'SW1', text: `interface Gi1/0/1-2\n switchport mode access\n switchport access vlan ${v}` }], [{ device: 'SW1', text: `vlan ${v}\ninterface Gi1/0/1\n switchport mode access\n switchport access vlan ${v}` }], [{ device: 'SW1', text: `vlan ${v}\ninterface Gi1/0/1-3\n switchport mode access\n switchport access vlan ${v}` }]],
    text: `SW1 のポートは全部 VLAN 1(初期のまま)で、PC1・PC2・PC3 は同じ網(${lan}.0/24)にいる。PC1 と PC2 を VLAN ${v} に入れて 2 台の間は通信でき、PC3(別の部署)とは通信できないようにせよ。PC3 のポートは VLAN 1 のままでよい。書き方: vlan <番号> / interface Gi1/0/1-2 / switchport mode access / switchport access vlan <番号>。`,
    why: `まず vlan ${v} で VLAN を作り、Gi1/0/1 と Gi1/0/2 をその VLAN のアクセスポートにする。VLAN を作らずにポートに ${v} を付けると、スイッチにその VLAN が無いのでポートは何も通さない。PC3 は VLAN 1 に残るので、同じ網のアドレスでも PC1 からは届かない(VLAN が違えばブロードキャストも ARP も届かない)。Gi1/0/3 まで VLAN ${v} に入れると PC3 に届いてしまい要件 4 に反する。`,
    firstStep: 'まず VLAN を作る行(vlan 番号)を書き、そのあとでポートに割り当てる', meta: { v },
  });
}

// ================= Lv245 2 台にまたがる VLAN(tap many) =================
function vlanSpanSpec(rng) {
  const spec = sim.gen.twoSwitches(rng, { l3: 'l3sw' });
  delete spec.devices.L3SW1; spec.links = spec.links.filter((l) => !l.some((e) => e.startsWith('L3SW1')));
  spec.devices.SW1.ifaces = spec.devices.SW1.ifaces.filter((f) => f.name !== 'Gi1/0/23');
  const [v10, v20] = spec.meta.vlans; const lan = spec.meta.lan;
  // PC5 を足す(どちらかのスイッチ、どちらかの VLAN)
  const sw5 = rng.pick(['SW1', 'SW2']), v5 = rng.pick([v10, v20]);
  spec.devices.PC5 = { kind: 'host', ip: `${lan[v5]}.${rng.rand(201, 250)}/24`, gateway: `${lan[v5]}.1` };
  spec.devices[sw5].ifaces.push({ name: 'Gi1/0/3', mode: 'access', vlan: v5 });
  spec.links.push(['PC5', `${sw5}:Gi1/0/3`]);
  layoutWith(spec, { PC5: sw5 === 'SW1' ? [300, 530] : [700, 530], SW1: [300, 300], SW2: [700, 300] });
  return spec;
}
function vlanSpanQ(rng) {
  for (;;) {
    const spec = vlanSpanSpec(rng);
    const [v10, v20] = spec.meta.vlans;
    const cause = rng.pick(['ok', 'ok', 'trunk-drop', 'trunk-drop', 'port-wrong', 'port-wrong']); // 「VLAN が作られていない」は、模擬がアクセスポートの VLAN を自動で作るので出せない
    let note = '';
    if (cause === 'trunk-drop') { const drop = rng.pick([v10, v20]); const sw = rng.pick(['SW1', 'SW2']); spec.devices[sw].ifaces.find((f) => f.name === 'Gi1/0/24').allowed = [drop === v10 ? v20 : v10]; note = `${sw} のトランク Gi1/0/24 は VLAN ${drop === v10 ? v20 : v10} しか通していない。`; }
    if (cause === 'port-wrong') { const sw = rng.pick(['SW1', 'SW2']); const pn = rng.pick(['Gi1/0/1', 'Gi1/0/2']); const f = spec.devices[sw].ifaces.find((x) => x.name === pn); f.vlan = f.vlan === v10 ? v20 : v10; note = `${sw} のポート ${f.name} が VLAN ${f.vlan} になっている(つながる PC の網と合っていない)。`; }
    const net = sim.build(spec);
    const pcs = Object.keys(spec.devices).filter((n) => n.startsWith('PC'));
    const ask = rng.pick(pcs);
    const can = pcs.filter((p) => p !== ask && sim.reach(net, ask, p, { roundTrip: true }).ok);
    if (!can.length) continue; // 「ない」が答えになる問題は作らない
    const ids = nodeIds(rng, spec);
    const diagram = mkDiagram(spec, ids, { net });
    const askLink = spec.links.find((l) => l[0] === ask); const [askSw, askPort] = askLink[1].split(':');
    const askIf = spec.devices[askSw].ifaces.find((f) => f.name === askPort); const askVlan = askIf ? askIf.vlan : 1;
    // 図に VLAN の設定を見せる(ポートの note と線)
    for (const node of diagram.nodes) { const d = spec.devices[node.name]; if (d.kind !== 'switch') continue; node.note = `VLAN: ${d.vlans.join(', ')}`; for (const p of node.ports) { const f = d.ifaces.find((x) => x.name === p.name); p.note = f ? (f.mode === 'trunk' ? `trunk ${(f.allowed || ['all']).join(',')}` : `VLAN ${f.vlan}`) : 'VLAN 1'; } }
    return {
      text: `2 台のスイッチ SW1・SW2 をトランクでつないである。図の各ポートに VLAN(アクセス)か、トランクが通す VLAN を書いてある。スイッチごとに作ってある VLAN も note にある。ルーターは無い。${ask}(${ipOf(spec.devices[ask].ip)})と通信できる PC を全部タップせよ(同じ網(/24)のアドレスを持ち、同じ VLAN で、ポートの VLAN がスイッチに作られていて、別のスイッチなら両方のトランクがその VLAN を通すとき通信できる)。`,
      answerKind: 'tap', tap: { mode: 'many' }, diagram, accept: { ids: can.map((p) => ids[p]).sort() }, sim: { spec },
      firstStep: `まず ${ask} のポートの VLAN を見て、同じ VLAN のポートにつながる PC を集める。別のスイッチの PC は、両端のトランクがその VLAN を通すかも見る`,
      explanation: `正解は ${list(can)}。${note}${ask} は ${askSw} の ${askPort}(VLAN ${askVlan})につながる。同じ VLAN のポートにつながり、その VLAN が両方のスイッチにあり、トランクがその VLAN を通す PC だけが通信できる。VLAN が違う PC には、同じ網のアドレスでも ARP が届かない。網(/24)が違う PC には、同じ VLAN でも(ゲートウェイがいないので)届かない。`,
      meta: { cause, ask, n: can.length },
    };
  }
}
function verifyVlanSpan(q) { // spec を自分で読んで、同じ VLAN・VLAN がある・トランクが通す、を判定し直す
  const spec = q.sim.spec;
  const portOf = (pc) => { const l = spec.links.find((x) => x[0] === pc); const [sw, port] = l[1].split(':'); const f = (spec.devices[sw].ifaces || []).find((x) => x.name === port); return { sw, vlan: f ? f.vlan || 1 : 1 }; };
  const trunkOk = (sw, v) => { const f = spec.devices[sw].ifaces.find((x) => x.name === 'Gi1/0/24'); return f && f.mode === 'trunk' && (!f.allowed || f.allowed.includes(v)); };
  const hasVlan = (sw, v) => (spec.devices[sw].vlans || [1]).includes(v) || v === 1;
  const ask = /。(PC\d)\([\d.]+\)と通信できる PC を全部/.exec(q.text)[1];
  const a = portOf(ask);
  const want = Object.keys(spec.devices).filter((p) => p.startsWith('PC') && p !== ask).filter((p) => { const b = portOf(p); const sameNet = sim.util.inNet(ipOf(spec.devices[p].ip), ipOf(spec.devices[ask].ip), 24); if (!sameNet || a.vlan !== b.vlan || !hasVlan(a.sw, a.vlan) || !hasVlan(b.sw, b.vlan)) return false; return a.sw === b.sw || (trunkOk(a.sw, a.vlan) && trunkOk(b.sw, a.vlan)); }).map((p) => idOfName(q, p)).sort();
  if (!want.length || want.join() !== q.accept.ids.slice().sort().join()) throw new Error(`Lv245: 集合が違う ${want.map((id) => nameOfId(q, id))} / ${q.accept.ids.map((id) => nameOfId(q, id))}`);
}

// ================= Lv246 トランク(config) =================
function trunkQ(rng) {
  const spec = vlanSpanSpec(rng);
  delete spec.devices.PC5; spec.links = spec.links.filter((l) => l[0] !== 'PC5'); for (const s of ['SW1', 'SW2']) spec.devices[s].ifaces = spec.devices[s].ifaces.filter((f) => f.name !== 'Gi1/0/3');
  const [v10, v20] = spec.meta.vlans;
  for (const s of ['SW1', 'SW2']) { const f = spec.devices[s].ifaces.find((x) => x.name === 'Gi1/0/24'); f.mode = 'access'; f.vlan = 1; delete f.allowed; delete f.native; }
  const reqs = [{ id: 1, kind: 'trunk', device: 'SW1', port: 'Gi1/0/24', allowed: [v10, v20] }, { id: 2, kind: 'trunk', device: 'SW2', port: 'Gi1/0/24', allowed: [v10, v20] }, { id: 3, kind: 'reach', from: 'PC1', to: 'PC3', roundTrip: true }, { id: 4, kind: 'reach', from: 'PC2', to: 'PC4', roundTrip: true }, { id: 5, kind: 'reach', from: 'PC1', to: 'PC4', expect: false }];
  const t = `interface Gi1/0/24\n switchport mode trunk\n switchport trunk allowed vlan ${v10},${v20}`;
  return configQ(rng, {
    spec, editable: ['SW1', 'SW2'], reqs,
    solution: [{ device: 'SW1', text: t }, { device: 'SW2', text: t }],
    wrong: [[{ device: 'SW1', text: t }], [{ device: 'SW1', text: `interface Gi1/0/24\n switchport mode trunk\n switchport trunk allowed vlan ${v10}` }, { device: 'SW2', text: `interface Gi1/0/24\n switchport mode trunk\n switchport trunk allowed vlan ${v10}` }]],
    text: `SW1 と SW2 の間の線(両方とも Gi1/0/24)は、今はアクセスポート(VLAN 1)なので、VLAN ${v10} の PC1(${ipOf(spec.devices.PC1.ip)})と PC3(${ipOf(spec.devices.PC3.ip)})、VLAN ${v20} の PC2 と PC4 はスイッチをまたいで通信できない。両方のスイッチの Gi1/0/24 をトランクにして VLAN ${v10} と ${v20} を通し、同じ VLAN の PC どうしが届くようにせよ(VLAN が違う PC どうしは届かないまま)。書き方: interface Gi1/0/24 / switchport mode trunk / switchport trunk allowed vlan ${v10},${v20}。`,
    why: `トランクは線の両端で設定する。片方だけトランクにしても、もう片方がアクセス(VLAN 1)のままではタグ付きのフレームを受けられない。allowed vlan に両方の VLAN を書く(片方だけだと、もう片方の VLAN がまたげない)。VLAN が違う PC1 と PC4 は、ルーターが無いので届かないままでよい。`,
    firstStep: 'まず「トランクは両端で設定する」を思い出し、SW1 と SW2 の両方に同じ設定を書く', meta: { v10, v20 },
  });
}

// ================= Lv247 L3 スイッチで VLAN 間(config) =================
function sviQ(rng) {
  const spec = sim.gen.twoSwitches(rng, { l3: 'l3sw' });
  const [v10, v20] = spec.meta.vlans; const lan = spec.meta.lan; const v30 = 30;
  const l3 = spec.devices.L3SW1; delete l3.svis; l3.ipRouting = false;
  spec.devices.SW1.stpPriority = 4096; // SW1 を根にしておく(輪は無いが、模擬の STP は L3SW1 が根のとき SW1 側の線を止めることがある)
  // VLAN 30 の PC5(SW2 だけ。トランクは 30 を通さないので、L3SW1 には届かない)
  const lan30 = `${spec.meta.block.split('.').slice(0, 2).join('.')}.${v30}`;
  spec.devices.SW2.vlans = [...spec.meta.vlans, v30];
  spec.devices.SW2.ifaces.push({ name: 'Gi1/0/3', mode: 'access', vlan: v30 });
  spec.devices.PC5 = { kind: 'host', ip: `${lan30}.${rng.rand(10, 200)}/24`, gateway: `${lan30}.1` };
  spec.links.push(['PC5', 'SW2:Gi1/0/3']);
  layoutWith(spec, { PC5: [700, 530], SW1: [300, 300], SW2: [700, 300] });
  const reqs = [{ id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }, { id: 2, kind: 'reach', from: 'PC3', to: 'PC4', roundTrip: true }, { id: 3, kind: 'reach', from: 'PC1', to: 'PC3', roundTrip: true }, { id: 4, kind: 'reach', from: 'PC1', to: 'PC5', expect: false }];
  const sol = `ip routing\ninterface vlan ${v10}\n ip address ${lan[v10]}.1/24\ninterface vlan ${v20}\n ip address ${lan[v20]}.1/24`;
  return configQ(rng, {
    spec, editable: ['L3SW1'], reqs,
    solution: [{ device: 'L3SW1', text: sol }],
    wrong: [[{ device: 'L3SW1', text: `interface vlan ${v10}\n ip address ${lan[v10]}.1/24\ninterface vlan ${v20}\n ip address ${lan[v20]}.1/24` }], [{ device: 'L3SW1', text: `ip routing\ninterface vlan ${v10}\n ip address ${lan[v10]}.1/24` }], [{ device: 'L3SW1', text: `ip routing\ninterface vlan ${v10}\n ip address ${lan[v10]}.2/24\ninterface vlan ${v20}\n ip address ${lan[v20]}.2/24` }]],
    text: `VLAN ${v10}(${lan[v10]}.0/24。PC1 は ${ipOf(spec.devices.PC1.ip)}、PC3 は ${ipOf(spec.devices.PC3.ip)})と VLAN ${v20}(${lan[v20]}.0/24。PC2 は ${ipOf(spec.devices.PC2.ip)}、PC4 は ${ipOf(spec.devices.PC4.ip)})の PC は、PC のゲートウェイを各網の .1 にしてあるが、L3SW1 にはまだ VLAN の IF(SVI)も経路の機能も無く、VLAN 間は届かない。L3SW1 を設定して VLAN ${v10} と ${v20} の間が届くようにせよ。VLAN ${v30}(PC5)は別の部署の閉じた網なので、つなげないこと。書き方: ip routing / interface vlan <番号> / ip address <アドレス>/<長さ>。`,
    why: `L3 スイッチで VLAN 間を結ぶには、ip routing で経路の機能を有効にし、VLAN ごとの IF(interface vlan)に、その網のゲートウェイのアドレス(PC に設定してある .1)を付ける。ip routing を忘れると SVI があっても転送しない。片方の VLAN の SVI だけでは、もう片方の返りが戻らない。アドレスが PC のゲートウェイと違う(.2 など)と、PC は .1 を ARP で探して見つからない。VLAN ${v30} の SVI を作らなければ閉じたまま(トランクも ${v30} を通していない)。`,
    firstStep: 'まず PC のゲートウェイのアドレスを図から読み、それを VLAN ごとの IF に付けると考える(経路の機能の有効化も忘れずに)', meta: { v10, v20 },
  });
}

// ================= Lv248・249 DHCP(config) =================
function dhcpRangeQ(rng) {
  const spec = sim.gen.serial(rng, { routers: rng.rand(1, 2), hostsOnLan1: rng.rand(1, 3), switches: true });
  const { lan1 } = spec.meta;
  const E = rng.pick([9, 19, 29, 49, 99]); // .1〜.E は配らない
  for (const h of Object.keys(spec.devices).filter((n) => n.startsWith('PC') && n !== 'PC2')) { spec.devices[h].dhcp = true; delete spec.devices[h].ip; } // ゲートウェイは spec に残す(模擬は DHCP でもらったゲートウェイを経路に使わない)。範囲のゲートウェイは lease の要件で確かめる
  const first = `${lan1}.${E + 1}`, count = 254 - E;
  const reqs = [{ id: 1, kind: 'lease', host: 'PC1', ip: first, gateway: `${lan1}.1` }, { id: 2, kind: 'lease', device: 'R1', pool: 'LAN1', count }, { id: 3, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }];
  const sol = `dhcp pool LAN1\n network ${lan1}.0/24\n gateway ${lan1}.1\ndhcp exclude ${lan1}.1 ${lan1}.${E}`;
  return configQ(rng, {
    spec, editable: ['R1'], reqs,
    solution: [{ device: 'R1', text: sol }],
    wrong: [[{ device: 'R1', text: `dhcp pool LAN1\n network ${lan1}.0/24\n gateway ${lan1}.1` }], [{ device: 'R1', text: `dhcp pool LAN1\n network ${lan1}.0/24\ndhcp exclude ${lan1}.1 ${lan1}.${E}` }], [{ device: 'R1', text: `dhcp pool LAN1\n network ${lan1}.0/24\n gateway ${lan1}.1\ndhcp exclude ${lan1}.1 ${lan1}.${E + 1}` }]],
    text: `LAN1(${lan1}.0/24)の PC はアドレスを DHCP でもらう設定だが、R1 に DHCP の範囲が無い。R1 に範囲 LAN1 を作り、PC にアドレスとデフォルトゲートウェイ(R1 の ${lan1}.1)を配れ。${lan1}.1〜${lan1}.${E} はサーバーや機器のために配らない(除外する)。書き方: dhcp pool LAN1 / network <網>/<長さ> / gateway <アドレス> / dhcp exclude <始め> <終わり>。`,
    why: `範囲 LAN1 に網 ${lan1}.0/24 とゲートウェイ ${lan1}.1 を書き、dhcp exclude で ${lan1}.1〜${lan1}.${E} を配らないようにする。すると最初に配るのは ${first}、配れる数は 254 − ${E} = ${count}。除外を忘れると .2 から配ってしまい、ゲートウェイを書かないと PC は R1 の先(PC2)に届かない。除外の終わりを 1 つ多くすると最初のアドレスがずれる。`,
    firstStep: 'まず範囲(pool)に網とゲートウェイを書き、配らないアドレスは別の行(dhcp exclude)で除く', meta: { E, hosts: Object.keys(spec.devices).filter((n) => n.startsWith('PC')).length },
  });
}
function dhcpRelayQ(rng) {
  const spec = sim.gen.serial(rng, { routers: 2, hostsOnLan1: rng.rand(1, 2), switches: true });
  const { lan1 } = spec.meta;
  const E = rng.pick([9, 19, 49]);
  for (const h of Object.keys(spec.devices).filter((n) => n.startsWith('PC') && n !== 'PC2')) { spec.devices[h].dhcp = true; delete spec.devices[h].ip; }
  spec.devices.R2.dhcp = { pools: [{ name: 'LAN1', network: `${lan1}.0/24`, gateway: `${lan1}.1`, exclude: [[`${lan1}.1`, `${lan1}.${E}`]] }] };
  const srv = ifIp(spec, 'R2', 'Gi0/0');
  const first = `${lan1}.${E + 1}`;
  const reqs = [{ id: 1, kind: 'lease', host: 'PC1', ip: first, gateway: `${lan1}.1` }, { id: 2, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }];
  return configQ(rng, {
    spec, editable: ['R1'], reqs,
    solution: [{ device: 'R1', text: `interface Gi0/0\n dhcp relay ${srv}` }],
    wrong: [[{ device: 'R1', text: `interface Gi0/1\n dhcp relay ${srv}` }], [{ device: 'R1', text: `interface Gi0/0\n dhcp relay ${lan1}.53` }]],
    text: `LAN1(${lan1}.0/24)の PC はアドレスを DHCP でもらう設定で、DHCP サーバーの役は R2(範囲 LAN1 は R2 に設定済み。R2 の R1 側のアドレスは ${srv})。しかし DHCP の要求はブロードキャストなので R1 を越えられず、PC はアドレスをもらえない。R1 に DHCP リレーを設定して、PC1 がアドレスをもらえるようにせよ。書き方: interface <IF> / dhcp relay <DHCP サーバーのアドレス>。`,
    why: `リレーは、PC の要求を受ける側の IF(R1 の LAN1 側 Gi0/0)に書き、転送先に DHCP サーバー(R2)のアドレス ${srv} を指定する。R1 がブロードキャストの要求をユニキャストで R2 へ届け、R2 は受けた IF の網(${lan1}.0/24)の範囲から ${first} を返す。LAN1 でない側の IF に書いても要求は来ない。存在しないアドレスへ送っても返事は無い。`,
    firstStep: 'まず DHCP の要求が届く IF(PC がつながる側)を図から選ぶ', meta: { E, srv },
  });
}

// ================= Lv250・251 標準 ACL の置き場所・書き方 =================
function aclTopo(rng) {
  const A = sim.gen.addresses(rng); const lanA = A.lan(), lanS = A.lan(), lanB = A.lan();
  const [a12, b12, nh1, nh2] = sim.gen.p2pIps(A.p2p());
  const srvOn = rng.pick(['R1', 'R2']);
  const used = new Set(); const host = (lan) => { let h; do { h = rng.rand(10, 200); } while (used.has(`${lan}.${h}`)); used.add(`${lan}.${h}`); return `${lan}.${h}`; };
  const spec = {
    seed: rng.rand(0, 2 ** 31), editable: [], requirements: [], meta: { lanA, lanS, lanB, srvOn, block: A.block },
    devices: {
      PC1: { kind: 'host', ip: `${host(lanA)}/24`, gateway: `${lanA}.1` }, PC3: { kind: 'host', ip: `${host(lanA)}/24`, gateway: `${lanA}.1` },
      SW1: { kind: 'switch' },
      R1: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: `${lanA}.1/24` }, { name: 'Gi0/1', ip: a12 }], routes: [] },
      R2: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: b12 }], routes: [{ prefix: `${lanA}.0/24`, via: nh1 }] },
      SRV1: { kind: 'server', ip: `${host(lanS)}/24`, gateway: `${lanS}.1`, listen: [{ proto: 'tcp', port: 443 }, { proto: 'tcp', port: 80 }] },
      PC2: { kind: 'host', ip: `${host(lanB)}/24`, gateway: `${lanB}.1` },
    },
    links: [['PC1', 'SW1:Gi1/0/1'], ['PC3', 'SW1:Gi1/0/2'], ['SW1:Gi1/0/24', 'R1:Gi0/0'], ['R1:Gi0/1', 'R2:Gi0/0']],
    layout: { pos: { PC1: [80, 180], PC3: [80, 420], SW1: [220, 300], R1: [400, 300], R2: [640, 300] } },
  };
  if (srvOn === 'R2') {
    spec.devices.R2.ifaces.push({ name: 'Gi0/1', ip: `${lanS}.1/24` }, { name: 'Gi0/2', ip: `${lanB}.1/24` });
    spec.devices.R1.routes.push({ prefix: `${lanS}.0/24`, via: nh2 }, { prefix: `${lanB}.0/24`, via: nh2 });
    spec.links.push(['R2:Gi0/1', 'SRV1'], ['R2:Gi0/2', 'PC2']);
    spec.layout.pos.SRV1 = [880, 170]; spec.layout.pos.PC2 = [880, 430];
  } else {
    spec.devices.R1.ifaces.push({ name: 'Gi0/2', ip: `${lanS}.1/24` });
    spec.devices.R2.ifaces.push({ name: 'Gi0/1', ip: `${lanB}.1/24` });
    spec.devices.R1.routes.push({ prefix: `${lanB}.0/24`, via: nh2 });
    spec.devices.R2.routes.push({ prefix: `${lanS}.0/24`, via: nh1 });
    spec.links.push(['R1:Gi0/2', 'SRV1'], ['R2:Gi0/1', 'PC2']);
    spec.layout.pos.SRV1 = [400, 110]; spec.layout.pos.PC2 = [880, 300];
  }
  return spec;
}
const srvIface = (spec) => (spec.meta.srvOn === 'R2' ? 'Gi0/1' : 'Gi0/2');
function aclPlaceQ(rng) {
  const spec = aclTopo(rng);
  const net = sim.build(spec);
  for (const [a, b] of [['PC1', 'SRV1'], ['PC3', 'SRV1'], ['PC1', 'PC2'], ['PC2', 'SRV1']]) if (!sim.reach(net, a, b).ok) throw new Error('Lv250: そろった状態で届かない');
  const kind = rng.next() < 0.6 ? 'standard' : 'extended';
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids, { net });
  const dev = kind === 'standard' ? spec.meta.srvOn : 'R1', port = kind === 'standard' ? srvIface(spec) : 'Gi0/0';
  const dir = kind === 'standard' ? 'out(送信)' : 'in(受信)';
  return {
    text: `PC1(${ipOf(spec.devices.PC1.ip)})から SRV1(${ipOf(spec.devices.SRV1.ip)})への通信だけを止め、ほかの通信(PC3 → SRV1、PC1 → PC2、PC2 → SRV1)には影響を出したくない。${kind === 'standard' ? '標準 ACL(送信元のアドレスだけで選ぶ)' : '拡張 ACL(送信元・宛先・ポートで選ぶ)'}を使う。置き場所の基本: 標準 ACL は宛先にいちばん近い IF の送信(out)、拡張 ACL は送信元にいちばん近い IF の受信(in)。この ACL を当てる IF をタップせよ(向きは ${dir})。`,
    answerKind: 'tap', tap: { mode: 'port' }, diagram, accept: { ids: [`${ids[dev]}:${port}`] }, sim: { spec },
    firstStep: kind === 'standard' ? 'まず SRV1 に直接つながるルーターの IF を探す(標準 ACL は送信元しか見ないので、宛先の近くでしか絞れない)' : 'まず PC1 がつながるルーターの IF を探す(拡張 ACL は宛先まで見られるので、入口で止めてもほかに影響が出ない)',
    explanation: `正解は ${dev} の ${port}(${dir})。${kind === 'standard' ? `標準 ACL は送信元(PC1)しか見ないので、PC1 の近く(R1 の Gi0/0 の in)に置くと PC1 → PC2 まで止まってしまう。SRV1 だけにつながる ${dev} の ${port} の out に置けば、そこを通るのは SRV1 宛だけなので、PC1 → SRV1 だけが止まる。` : `拡張 ACL は宛先(SRV1)も見られるので、PC1 の入口(R1 の Gi0/0 の in)で「PC1 から SRV1 宛」だけを捨てれば、PC1 → PC2 には影響が無く、不要なパケットを網の中へ運ばずに済む。`}`,
    meta: { kind, srvOn: spec.meta.srvOn },
  };
}
function verifyAclPlace(q) { // spec から「SRV1 に直接つながる IF」「PC1 の LAN の IF」を自分で探す
  const spec = q.sim.spec; const U = sim.util;
  const kind = /標準 ACL\(/.test(q.text) ? 'standard' : 'extended';
  const target = kind === 'standard' ? ipOf(spec.devices.SRV1.ip) : ipOf(spec.devices.PC1.ip);
  const hits = [];
  for (const [name, d] of Object.entries(spec.devices)) for (const f of d.ifaces || []) if (f.ip && U.inNet(target, ipOf(f.ip), Number(f.ip.split('/')[1]))) hits.push(`${idOfName(q, name)}:${f.name}`);
  if (hits.length !== 1 || hits[0] !== q.accept.ids[0]) throw new Error(`Lv250: IF が違う ${hits} / ${q.accept.ids[0]}`);
  // 標準 ACL のとき、その IF の先に SRV1 以外がいないこと(影響が出ない)
  if (kind === 'standard') { const [dev, port] = [nameOfId(q, hits[0].split(':')[0]), hits[0].split(':')[1]]; const l = spec.links.find((x) => x.includes(`${dev}:${port}`)); if (!l.includes('SRV1')) throw new Error('Lv250: SRV1 だけの線でない'); }
}
function aclWriteQ(rng) {
  const spec = aclTopo(rng);
  const dev = spec.meta.srvOn, port = srvIface(spec);
  const pc1 = ipOf(spec.devices.PC1.ip);
  const reqs = [{ id: 1, kind: 'reach', from: 'PC1', to: 'SRV1', proto: 'tcp', port: 443, expect: false }, { id: 2, kind: 'reach', from: 'PC3', to: 'SRV1', proto: 'tcp', port: 443, roundTrip: true }, { id: 3, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }, { id: 4, kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 443, roundTrip: true }];
  const sol = `acl A10 standard\n 10 deny host ${pc1}\n 20 permit any\ninterface ${port}\n acl A10 out`;
  return configQ(rng, {
    spec, editable: ['R1', 'R2'], reqs,
    solution: [{ device: dev, text: sol }],
    wrong: [[{ device: 'R1', text: `acl A10 standard\n 10 deny host ${pc1}\n 20 permit any\ninterface Gi0/0\n acl A10 in` }], [{ device: dev, text: `acl A10 standard\n 10 deny host ${pc1}\ninterface ${port}\n acl A10 out` }], [{ device: dev, text: `acl A10 standard\n 10 deny ${spec.meta.lanA}.0/24\n 20 permit any\ninterface ${port}\n acl A10 out` }]],
    text: `PC1(${pc1})から SRV1 への通信だけを止めたい。PC3 → SRV1、PC1 → PC2、PC2 → SRV1 は今までどおり届くこと。標準 ACL(送信元で選ぶ)を書いて適切な IF に当てよ。置く機器と IF は自分で選ぶ(R1・R2 のどちらにも書ける)。書き方: acl <名前> standard / <番号> deny|permit host <アドレス>|<網>/<長さ>|any / interface <IF> / acl <名前> in|out。`,
    why: `標準 ACL は送信元しか見ないので、SRV1 だけにつながる ${dev} の ${port} の送信(out)に当てる。PC1 を deny、最後に permit any(書かないと暗黙の拒否で全部止まり、PC3 や PC2 も届かなくなる)。PC1 の入口(R1 の Gi0/0 の in)に当てると PC1 → PC2 まで止まる。PC1 の網ごと deny すると PC3 も止まる。`,
    firstStep: 'まず「止めたい通信だけが通り、ほかは通らない IF」を探す(SRV1 の手前)。次に deny の行のあとに permit any を忘れない', meta: { srvOn: spec.meta.srvOn },
  });
}

// ================= Lv252 確かめる: traceroute(模擬ターミナル) =================
function traceCheckQ(rng) {
  const routers = 3;
  const spec = sim.gen.serial(rng, { routers, switches: true });
  const { lan1, lan2 } = spec.meta;
  const cause = rng.pick(['no-route-r2', 'no-route-r2', 'no-return-r2', 'no-arp-pc2']);
  let lastReply, why;
  const gi0 = (i) => ifIp(spec, `R${i}`, 'Gi0/0');
  if (cause === 'no-route-r2') { spec.devices.R2.routes = spec.devices.R2.routes.filter((r) => !r.prefix.startsWith(lan2)); lastReply = gi0(2); why = `1 番目 R1(${gi0(1)})、2 番目 R2(${gi0(2)})までは返事があり、3 番目から * になる。R2 に ${lan2}.0/24 への経路が無く、R2 で捨てられている。`; }
  else if (cause === 'no-return-r2') { spec.devices.R2.routes = spec.devices.R2.routes.filter((r) => !r.prefix.startsWith(lan1)); lastReply = gi0(1); why = `1 番目 R1(${gi0(1)})だけ返事があり、2 番目から先が * になる。行きのパケットは R2・R3 を越えて PC2 まで進むが、R2 に ${lan1}.0/24 への戻りの経路が無いので、R2 自身の返事も、その先からの返事も PC1 に戻れない。`; }
  else { spec.devices.PC2.ip = spec.devices.PC2.ip.replace(/\.(\d+)\/24$/, (m, h) => `.${(Number(h) % 200) + 30 === Number(h) ? Number(h) + 1 : (Number(h) % 200) + 30}/24`); spec.devices.R3.routes = spec.devices.R3.routes; const realPc2 = ipOf(spec.devices.PC2.ip); spec.meta.askIp = `${lan2}.${(Number(realPc2.split('.')[3]) + 7) % 200 + 20}`; lastReply = gi0(3); why = `1〜3 番目(R1・R2・R3)まで返事があり、そのあとが * になる。R3 までは届くが、R3 がその宛先のアドレスを ARP で探しても答えが無い(その番地に PC がいない)。`; }
  const askIp = spec.meta.askIp || ipOf(spec.devices.PC2.ip);
  const ids = nodeIds(rng, spec);
  const diagram = mkDiagram(spec, ids);
  const [out] = termRun(spec, 'PC1', [`traceroute ${askIp}`]);
  const hops = parseTrace(out); const last = hops.length ? hops[hops.length - 1].ip : null;
  if (last !== lastReply) throw new Error(`Lv252: 最後の返事が合わない ${last} / ${lastReply}\n${out}`);
  return {
    text: `PC1 から ${askIp}(PC2 の網の機器)へ ping が通らない。PC1 のターミナルで traceroute を打ち、最後に返事があった(アドレスが出た)行のアドレスを答えよ。そこまでは届いていて、その先に原因がある。`,
    diagram, terminal: { devices: ['PC1'], start: 'PC1' }, sim: { spec },
    ...textQ([field('ip', '最後に返事があったアドレス', 'ipv4', lastReply, '例: 10.0.12.2')]),
    firstStep: 'まず traceroute <宛先> を打ち、* * * になる直前の行を見る',
    explanation: `正解は ${lastReply}。${why}traceroute は途中のルーターの返事(時間超過)を順に見せるので、どこまで届いているかが分かる。`,
    meta: { cause },
  };
}
function verifyTraceCheck(q) {
  const ip = /から (\d+\.\d+\.\d+\.\d+)\(PC2 の網の機器\)へ/.exec(q.text)[1];
  const [out] = termRun(q.sim.spec, 'PC1', [`traceroute ${ip}`]);
  const hops = parseTrace(out);
  if (!hops.length) throw new Error('Lv252: 返事が 1 つも無い');
  if (hops[hops.length - 1].ip !== q.fields[0].accept[0]) throw new Error(`Lv252: 最後の返事が違う ${hops[hops.length - 1].ip}`);
  if (!/\*  \*  \*/.test(out)) throw new Error('Lv252: 途中で止まっていない');
  if (q.meta.cause === 'no-return-r2' && hops.length !== 1) throw new Error('Lv252: 戻りの経路が無いのに 2 行目以降に返事がある');
}

// ================= レベルの一覧 =================
const LEVELS = {
  192: gen('止めるポート', 'cl192-stp-alternate-v1', stpQ, verifyStp),
  193: gen('区間ごとの MAC と IP', 'cl193-mac-per-segment-v1', macQ, verifyMac),
  200: gen('スタティックルートを書く', 'cl200-static-route-v1', (rng) => routeQ(rng, 'static'), verifyConfig),
  201: gen('デフォルトルートを書く', 'cl201-default-route-v1', (rng) => routeQ(rng, 'default'), verifyConfig),
  215: gen('問い合わせの道具', 'cl215-nslookup-v1', dnsToolQ, verifyDnsTool),
  228: gen('traceroute を読む', 'cl228-traceroute-read-v1', traceReadQ, verifyTraceRead),
  241: gen('構成図: 通る機器を順に', 'cl241-path-order-v1', pathQ, verifyPath),
  242: gen('構成図: 止まる所', 'cl242-stop-where-v1', stopQ, verifyStop),
  243: gen('設定: 往復の静的経路', 'cl243-static-roundtrip-v1', roundTripQ, verifyConfig),
  244: gen('設定: VLAN を作る', 'cl244-vlan-create-v1', vlanCreateQ, verifyConfig),
  245: gen('構成図: 2 台にまたがる VLAN', 'cl245-vlan-span-v1', vlanSpanQ, verifyVlanSpan),
  246: gen('設定: トランク', 'cl246-trunk-v1', trunkQ, verifyConfig),
  247: gen('設定: L3 スイッチで VLAN 間', 'cl247-svi-v1', sviQ, verifyConfig),
  248: gen('設定: DHCP の範囲', 'cl248-dhcp-pool-v1', dhcpRangeQ, verifyConfig),
  249: gen('設定: DHCP リレー', 'cl249-dhcp-relay-v1', dhcpRelayQ, verifyConfig),
  250: gen('構成図: ACL を置く場所', 'cl250-acl-place-v1', aclPlaceQ, verifyAclPlace),
  251: gen('設定: 標準 ACL を書く', 'cl251-std-acl-v1', aclWriteQ, verifyConfig),
  252: gen('確かめる: traceroute', 'cl252-traceroute-check-v1', traceCheckQ, verifyTraceCheck),
};

module.exports = { LEVELS, _test: { nodeIds, mkDiagram, reqText, attachInet, aclTopo, vlanSpanSpec, parseTrace, routeTable } };
