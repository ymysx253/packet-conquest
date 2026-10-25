'use strict';
// 模擬の本体(server/sim。docs/questions/SIM-API.md)の確かめ。答えは模擬と別の作り方(総当たり・素朴な BFS)で解き直す。
const assert = require('assert');
const sim = require('../server/sim');
const { makeRng } = require('../server/questions/rng');
const U = sim.util;

const rng = makeRng(20261025);
const ok = (r, msg) => assert.ok(r.ok, `${msg}: ${r.reason} ${r.detail} (${(r.path || []).join(' → ')})`);
const ng = (r, reason, msg) => { assert.ok(!r.ok, `${msg}: 届いてしまう ${(r.path || []).join(' → ')}`); if (reason) assert.ok(String(r.reason).includes(reason), `${msg}: 理由が ${r.reason}(${r.detail})。${reason} のはず`); };

// ---------- 1. 文法 ----------
{
  const spec = sim.gen.serial(makeRng(1), { routers: 2 });
  spec.editable = ['R1', 'PC1', 'SW1'];
  const net = sim.build(spec);
  let r = sim.applyConfig(net, 'R1', 'ip route 10.9.9.0/24 ' + net.devices.R1.ifaces[1].ip.replace(/\.\d+$/, '.2'));
  assert.ok(r.ok, JSON.stringify(r.errors));
  r = sim.applyConfig(net, 'R1', 'int Gi0/0\n ip address 10.1.1.1/24');
  assert.strictEqual(r.ok, false); assert.ok(/省略形/.test(r.errors[0].message), r.errors[0].message); assert.strictEqual(r.errors[0].line, 1);
  r = sim.applyConfig(net, 'R1', 'interface Gi0/5\n ip address 10.5.5.1 255.255.255.0\n shutdown\n no shutdown\nexit\nip route 0.0.0.0/0 Gi0/5\nfoo bar');
  assert.strictEqual(r.errors.length, 1); assert.strictEqual(r.errors[0].line, 7); assert.ok(/知らない/.test(r.errors[0].message));
  assert.strictEqual(net.devices.R1.ifByName['Gi0/5'].ip, '10.5.5.1'); assert.strictEqual(net.devices.R1.ifByName['Gi0/5'].len, 24); assert.strictEqual(net.devices.R1.ifByName['Gi0/5'].shutdown, false);
  assert.ok(net.devices.R1.routes.some((x) => x.prefix === '0.0.0.0/0' && x.via === 'Gi0/5'));
  r = sim.applyConfig(net, 'R1', 'no ip route 0.0.0.0/0'); assert.ok(r.ok); assert.ok(!net.devices.R1.routes.some((x) => x.prefix === '0.0.0.0/0'));
  r = sim.applyConfig(net, 'R1', 'ip address 1.2.3.4/24'); assert.ok(!r.ok, 'interface の外の ip address は誤り');
  r = sim.applyConfig(net, 'R1', 'ip route 10.9.9.0/24 10.0.0.1 300'); assert.ok(!r.ok, '優先度 300 は誤り');
  r = sim.applyConfig(net, 'R1', 'interface GigabitEthernet 0/0\n ip address 10.1.1.300/24'); assert.ok(!r.ok, '300 は誤り');
  r = sim.applyConfig(net, 'PC1', 'ip address 192.168.5.5/24\ngateway 192.168.5.1\ndns 192.168.5.53'); assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(net.devices.PC1.gateway, '192.168.5.1');
  r = sim.applyConfig(net, 'PC1', 'ip route 1.1.1.0/24 1.1.1.1'); assert.ok(!r.ok);
  r = sim.applyConfig(net, 'SW1', 'vlan 10,20\ninterface Gi1/0/1-2\n switchport mode access\n switchport access vlan 10\ninterface Gi1/0/24\n switchport mode trunk\n switchport trunk allowed vlan 10,20\n switchport trunk native vlan 99\nspanning-tree priority 4096');
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(net.devices.SW1.ifByName['Gi1/0/2'].vlan, 10); assert.deepStrictEqual([...net.devices.SW1.ifByName['Gi1/0/24'].allowed], [10, 20]); assert.strictEqual(net.devices.SW1.ifByName['Gi1/0/24'].native, 99); assert.strictEqual(net.devices.SW1.stpPriority, 4096);
  r = sim.applyConfig(net, 'SW1', 'spanning-tree priority 5000'); assert.ok(!r.ok);
  r = sim.applyConfig(net, 'SW1', 'ip route 1.1.1.0/24 1.1.1.1'); assert.ok(!r.ok, 'L2 スイッチに経路は書けない');
  r = sim.applyConfig(net, 'R1', 'acl A20 extended\n 10 permit tcp any host 192.0.2.10 eq 443\n 20 deny ip 10.1.1.0 0.0.0.255 any\n 30 permit ip any any\ninterface Gi0/0\n acl A20 in\nrouter ospf 1\n network 10.0.0.0/8 area 0\ndhcp pool LAN\n network 192.168.30.0/24\n gateway 192.168.30.1\ndhcp exclude 192.168.30.1 192.168.30.49\nnat source 10.1.1.0/24 interface Gi0/1 overload\nnat static tcp 10.1.1.20 443 203.0.113.2 443\ninterface Gi0/1\n nat outside\n vrrp 1 ip 10.0.0.254\n vrrp 1 priority 120\n no vrrp 1 preempt');
  assert.ok(r.ok, JSON.stringify(r.errors));
  const R1 = net.devices.R1;
  assert.strictEqual(R1.acls.A20.lines.length, 3); assert.strictEqual(R1.acls.A20.lines[1].src, '10.1.1.0/24'); assert.strictEqual(R1.ifByName['Gi0/0'].aclIn, 'A20');
  assert.deepStrictEqual(R1.ospf.networks, ['10.0.0.0/8']); assert.strictEqual(R1.dhcp.pools[0].gateway, '192.168.30.1'); assert.strictEqual(R1.nat.static[0].outsidePort, 443);
  assert.deepStrictEqual(R1.ifByName['Gi0/1'].vrrp[0], { group: 1, vip: '10.0.0.254', priority: 120, preempt: false });
  const cs = sim.checkSyntax(spec, 'R1', 'interface Gi0/0\n ip addres 1.1.1.1/24'); assert.ok(!cs.ok && cs.errors[0].line === 2);
  assert.ok(sim.runningConfig(net, 'R1').some((l) => /acl A20 extended/.test(l)));
  console.log('sim 1 文法 ok');
}

// ---------- 2. 経路(直結・静的・AD・最長一致・OSPF) ----------
{
  // 直列 3 台(静的)で全部届く。経路表の AD と最長一致
  for (let s = 1; s <= 30; s++) {
    const spec = sim.gen.serial(makeRng(s), { routers: 1 + (s % 3), hostsOnLan1: 1 + (s % 3), switches: s % 2 === 0 });
    const net = sim.build(spec);
    ok(sim.reach(net, 'PC1', 'PC2'), `serial seed ${s}`);
    ok(sim.reach(net, 'PC2', 'PC1'), `serial seed ${s} 逆`);
    if (spec.meta.hostsOnLan1 > 1) ok(sim.reach(net, 'PC3', 'PC2'), `serial seed ${s} PC3`);
  }
  // 最長一致と AD: /24 の静的(AD 1)と /16 の静的、さらに同じ /24 に AD 200 の経路
  const spec = sim.gen.serial(makeRng(5), { routers: 2 });
  const net = sim.build(spec);
  const r1 = net.devices.R1; const nh = r1.ifaces[1].ip.replace(/\.\d+$/, '.2');
  sim.applyConfig(net, 'R1', `ip route ${spec.meta.lan2.replace(/\.\d+$/, '')}.0.0/16 ${nh}\nip route ${spec.meta.lan2}.0/24 Gi0/0 200`);
  const st = sim.state(net);
  const rows = st.routes.R1.filter((r) => r.prefix === `${spec.meta.lan2}.0/24`);
  assert.strictEqual(rows.length, 1, '同じ宛先は AD の小さい方だけ'); assert.strictEqual(rows[0].via, nh); assert.strictEqual(rows[0].ad, 1);
  sim.applyConfig(net, 'R1', `no ip route ${spec.meta.lan2}.0/24 ${nh}`);
  const st2 = sim.state(net); const rows2 = st2.routes.R1.filter((r) => r.prefix === `${spec.meta.lan2}.0/24`);
  assert.strictEqual(rows2[0].ad, 200, 'AD 1 を消すと 200 の方が残る'); assert.strictEqual(rows2[0].via, null);
  // OSPF: 四角形の 2 本の道。別の作り方(全部の単純な道を列挙して最小のコスト)で解き直す
  const allPaths = (spec, from, to) => { // ルーターの図(辺 = /30 の線、コスト = 出る IF の ospfCost)
    const edges = []; for (const [a, b] of spec.links) { const [da, pa] = a.split(':'), [db, pb] = b.split(':'); const A = spec.devices[da], B = spec.devices[db]; if (A.kind !== 'router' || B.kind !== 'router') continue; const ca = A.ifaces.find((i) => i.name === pa).ospfCost || 1, cb = B.ifaces.find((i) => i.name === pb).ospfCost || 1; edges.push([da, db, ca]); edges.push([db, da, cb]); }
    const best = { cost: Infinity, path: null };
    const go = (cur, cost, path) => { if (cur === to) { if (cost < best.cost) { best.cost = cost; best.path = path; } return; } for (const [a, b, c] of edges) if (a === cur && !path.includes(b)) go(b, cost + c, path.concat(b)); };
    go(from, 0, [from]); return best;
  };
  for (let s = 1; s <= 40; s++) {
    const costs = [1, 2, 3, 4, 5].map(() => 1 + (makeRng(s * 7 + 1).rand(0, 4))).slice(0, 4);
    const spec = sim.gen.square(makeRng(s), { costs });
    const net = sim.build(spec);
    const r = sim.reach(net, 'PC1', 'PC2'); ok(r, `square seed ${s}`);
    const brute = allPaths(spec, 'R1', 'R4');
    const viaRouters = r.path.filter((n) => spec.devices[n].kind === 'router');
    const altCost = (p) => p.slice(0, -1).reduce((a, _, i) => a + 0, 0);
    void altCost;
    // 総当たりの最小コストの道と同じ(同点なら両方あり得るので、コストが同じかを見る)
    const costOf = (p) => { let c = 0; for (let i = 0; i + 1 < p.length; i++) { const [a, b] = spec.links.find(([x, y]) => (x.startsWith(`${p[i]}:`) && y.startsWith(`${p[i + 1]}:`)) || (y.startsWith(`${p[i]}:`) && x.startsWith(`${p[i + 1]}:`))); const me = a.startsWith(`${p[i]}:`) ? a : b; const [d, pn] = me.split(':'); c += spec.devices[d].ifaces.find((f) => f.name === pn).ospfCost || 1; } return c; };
    assert.strictEqual(costOf(viaRouters), brute.cost, `square seed ${s}: 最短でない ${viaRouters} (${costOf(viaRouters)} / ${brute.cost})`);
    // R2–R4 を切ると R3 回りで届く
    const st2 = sim.stateWith(net, { cut: [['R2:Gi0/1', 'R4:Gi0/1']] });
    const r2 = require('../server/sim/l3').reach(st2.net, st2, 'PC1', 'PC2', {});
    ok(r2, `square seed ${s} 切ったあと`); assert.ok(r2.path.includes('R3') && !r2.path.includes('R2'), `square seed ${s}: 切ったあとの道 ${r2.path}`);
    const fo = sim.check(net, [{ id: 1, kind: 'failover', cut: [['R2:Gi0/1', 'R4:Gi0/1']], then: { kind: 'reach', from: 'PC1', to: 'PC2' } }]);
    assert.ok(fo[0].ok, fo[0].detail);
  }
  // 三角形: OSPF のネイバーが 3 組、R1 → PC2 は直接の線(コスト同じなら)
  const tri = sim.build(sim.gen.triangle(makeRng(3), { costs: { r1r3: 1, r1r2: 1, r2r3: 1 } }));
  assert.strictEqual(sim.state(tri).ospfNeighbors.length, 3);
  assert.deepStrictEqual(sim.reach(tri, 'PC1', 'PC2').path, ['PC1', 'R1', 'R3', 'PC2']);
  const tri2 = sim.build(sim.gen.triangle(makeRng(3), { costs: { r1r3: 5, r1r2: 1, r2r3: 1 } }));
  assert.deepStrictEqual(sim.reach(tri2, 'PC1', 'PC2').path, ['PC1', 'R1', 'R2', 'R3', 'PC2']);
  // ネイバーにならない: エリアが違う
  const tri3spec = sim.gen.triangle(makeRng(3)); tri3spec.devices.R2.ospf.area = 1;
  const tri3 = sim.build(tri3spec); assert.strictEqual(sim.state(tri3).ospfNeighbors.length, 1, 'R2 とはネイバーにならない');
  // 経路の輪: R1 と R2 が互いに相手を次にする静的経路
  const loopSpec = sim.gen.serial(makeRng(9), { routers: 2 });
  loopSpec.devices.R2.routes = loopSpec.devices.R2.routes.map((r) => (r.prefix.startsWith(loopSpec.meta.lan2) ? r : r));
  const lnet = sim.build(loopSpec);
  sim.applyConfig(lnet, 'R2', `ip route ${loopSpec.meta.lan2}.0/24 ${lnet.devices.R1.ifaces[1].ip}`);
  lnet.devices.R2.ifByName['Gi0/1'].shutdown = true; sim.applyConfig(lnet, 'R2', '!');
  ng(sim.reach(lnet, 'PC1', 'PC2'), 'loop', '経路の輪');
  console.log('sim 2 経路 ok');
}

// ---------- 3. ARP ----------
{
  const spec = sim.gen.serial(makeRng(11), { routers: 1 });
  spec.devices.PC1.gateway = `${spec.meta.lan1}.254`; // いない番地
  ng(sim.reach(sim.build(spec), 'PC1', 'PC2'), 'arp', 'いないゲートウェイ');
  const spec2 = sim.gen.serial(makeRng(11), { routers: 1, hostsOnLan1: 2 });
  spec2.devices.PC3.ip = spec2.devices.PC1.ip; // 重複
  const r = sim.reach(sim.build(spec2), 'PC2', 'PC1'); ng(r, 'dup', '重複アドレス');
  const net = sim.build(sim.gen.serial(makeRng(11), { routers: 1 }));
  const st = sim.state(net);
  assert.ok(st.arp.PC1.some((a) => a.ip === `${net.devices.R1.ifaces[0].ip}`), 'PC1 の ARP にゲートウェイ');
  assert.ok(st.arp.R1.some((a) => a.ip === net.devices.PC2.ifaces[0].ip), 'R1 の ARP に PC2');
  console.log('sim 3 ARP ok');
}

// ---------- 4. ACL と NAT ----------
{
  const spec = sim.gen.twoSites(makeRng(21));
  spec.editable = ['R1', 'R2'];
  const net = sim.build(spec);
  const hq = spec.meta.hq, br = spec.meta.br;
  const pc1 = spec.devices.PC1.ip.split('/')[0], srv = spec.devices.SRV1.ip.split('/')[0];
  // 標準 ACL は送信元だけ: PC1 を拒否、ほかは許可
  sim.applyConfig(net, 'R1', `acl A10 standard\n 10 deny host ${pc1}\n 20 permit any\ninterface Gi0/0\n acl A10 in`);
  ng(sim.reach(net, 'PC1', 'PC2'), 'acl-in', '標準 ACL で PC1 を止める');
  ok(sim.reach(net, 'SRV1', 'PC2'), 'SRV1 は通る');
  ng(sim.reach(net, 'PC2', 'PC1'), 'back:acl-in', 'ルーターの ACL は状態を見ないので、PC1 の返事が Gi0/0 の受信で止まる');
  ok(sim.reach(net, 'PC2', 'SRV1'), 'SRV1 への往復は通る');
  sim.applyConfig(net, 'R1', 'interface Gi0/0\n no acl A10 in');
  // 拡張 ACL: tcp 443 だけ許可、暗黙の拒否
  sim.applyConfig(net, 'R2', `acl A20 extended\n 10 permit tcp ${br}.0/24 host ${srv} eq 443\ninterface Gi0/0\n acl A20 in`);
  ok(sim.reach(net, 'PC2', 'SRV1', { proto: 'tcp', port: 443 }), '443 は通る');
  ng(sim.reach(net, 'PC2', 'SRV1', { proto: 'tcp', port: 22 }), 'acl-in', '22 は暗黙の拒否');
  ng(sim.reach(net, 'PC2', 'PC1'), 'acl-in', 'ping も暗黙の拒否');
  sim.applyConfig(net, 'R2', 'interface Gi0/0\n no acl A20 in');
  // 待ち受け: SRV1 は 443 と 22 だけ。80 は closed
  ng(sim.reach(net, 'PC2', 'SRV1', { proto: 'tcp', port: 80 }), 'closed', '待ち受けていないポート');
  // NAPT: 本社から外へ。INET への往復は NAT が無いと返りで止まり、NAT を入れると届く
  ng(sim.reach(net, 'PC1', 'INET'), 'back', 'NAT 無しでは返りが来ない');
  sim.applyConfig(net, 'R1', `interface Gi0/0\n nat inside\ninterface Gi0/1\n nat outside\nnat source ${hq}.0/24 interface Gi0/1 overload`);
  const r = sim.reach(net, 'PC1', 'INET', { proto: 'tcp', port: 443 }); ok(r, 'NAPT で外へ');
  assert.ok(r.nat.R1 && r.nat.R1[0].outIp === '203.0.113.1' && r.nat.R1[0].inIp === pc1, 'NAT の表に変換');
  // 受信 ACL は変換前(プライベート)、送信 ACL は変換後(グローバル)。285 の規則
  sim.applyConfig(net, 'R1', `acl OUT extended\n 10 permit ip host 203.0.113.1 any\ninterface Gi0/1\n acl OUT out`);
  ok(sim.reach(net, 'PC1', 'INET', { proto: 'tcp', port: 443 }), '送信 ACL は変換後のアドレスで照らす');
  sim.applyConfig(net, 'R1', `acl OUT2 extended\n 10 permit ip host ${pc1} any\ninterface Gi0/1\n acl OUT2 out`);
  ng(sim.reach(net, 'PC1', 'INET', { proto: 'tcp', port: 443 }), 'acl-out', '送信 ACL に変換前のアドレスを書くと合わない');
  sim.applyConfig(net, 'R1', 'interface Gi0/1\n no acl OUT2 out');
  // ポートフォワード: INET から 203.0.113.1:8443 → SRV1:443。受信 ACL は変換前(203.0.113.1:8443)で照らす
  sim.applyConfig(net, 'R1', `nat static tcp ${srv} 443 203.0.113.1 8443`);
  ok(sim.reach(net, 'INET', null, { proto: 'tcp', port: 8443, toIp: '203.0.113.1' }), 'ポートフォワードで届く');
  sim.applyConfig(net, 'R1', `acl IN extended\n 10 permit tcp any host 203.0.113.1 eq 8443\ninterface Gi0/1\n acl IN in`);
  ok(sim.reach(net, 'INET', null, { proto: 'tcp', port: 8443, toIp: '203.0.113.1' }), '受信 ACL は変換前(グローバル)で照らす');
  sim.applyConfig(net, 'R1', `acl IN2 extended\n 10 permit tcp any host ${srv} eq 443\ninterface Gi0/1\n acl IN2 in`);
  ng(sim.reach(net, 'INET', null, { proto: 'tcp', port: 8443, toIp: '203.0.113.1' }), 'acl-in', '受信 ACL に変換後のアドレスを書くと合わない');
  // FW のゾーンと状態
  const fspec = sim.gen.serial(makeRng(22), { routers: 1, switches: false });
  fspec.devices.R1.kind = 'firewall'; fspec.devices.R1.zones = { inside: ['Gi0/0'], outside: ['Gi0/1'] }; fspec.devices.R1.policies = [{ from: 'inside', to: 'outside', proto: 'tcp', dport: 443, action: 'permit' }];
  fspec.devices.PC2.kind = 'server'; fspec.devices.PC2.listen = [{ proto: 'tcp', port: 443 }, { proto: 'tcp', port: 22 }];
  const fnet = sim.build(fspec);
  ok(sim.reach(fnet, 'PC1', 'PC2', { proto: 'tcp', port: 443 }), 'FW の許可(返りは状態で通る)');
  ng(sim.reach(fnet, 'PC1', 'PC2', { proto: 'tcp', port: 22 }), 'fw-policy', 'FW に無いポート');
  ng(sim.reach(fnet, 'PC2', 'PC1', { proto: 'tcp', port: 443 }), 'fw-policy', '外から始める通信は通らない');
  console.log('sim 4 ACL と NAT ok');
}

// ---------- 5. L2 ----------
{
  for (const l3 of ['l3sw', 'subif']) {
    const spec = sim.gen.twoSwitches(makeRng(31), { l3 });
    const net = sim.build(spec);
    ok(sim.reach(net, 'PC1', 'PC3'), `${l3}: 同じ VLAN をまたいで`); ok(sim.reach(net, 'PC1', 'PC2'), `${l3}: VLAN 間`); ok(sim.reach(net, 'PC2', 'PC4'), `${l3}: VLAN 20`);
    assert.ok(sim.reach(net, 'PC1', 'PC3').path.join() === 'PC1,SW1,SW2,PC3', `${l3}: L2 の道 ${sim.reach(net, 'PC1', 'PC3').path}`);
    // トランクから VLAN 20 を外すと、PC2 → PC4 は届かず PC1 → PC3 は届く
    const n2 = sim.clone(net); sim.applyConfig(n2, 'SW1', 'interface Gi1/0/24\n switchport trunk allowed vlan 10');
    ok(sim.reach(n2, 'PC1', 'PC3'), `${l3}: VLAN 10 はまだ通る`); ng(sim.reach(n2, 'PC2', 'PC4'), 'arp', `${l3}: VLAN 20 はトランクを通れない`);
    // ポートの VLAN が違うとゲートウェイに届かない
    const n3 = sim.clone(net); sim.applyConfig(n3, 'SW1', 'interface Gi1/0/1\n switchport access vlan 20');
    ng(sim.reach(n3, 'PC1', 'PC2'), 'arp', `${l3}: VLAN 違いの PC1 はゲートウェイに届かない`);
    // VLAN が作られていないアクセスポートは通さない
    const n4 = sim.clone(net); sim.applyConfig(n4, 'SW2', 'no vlan 10');
    ng(sim.reach(n4, 'PC1', 'PC3'), 'arp', `${l3}: SW2 に VLAN 10 が無い`);
    const st = sim.state(net);
    assert.ok(st.macTables.SW1.some((r) => r.vlan === 10 && r.port === 'Gi1/0/24'), 'SW1 の MAC 表に SW2 側の PC3');
    assert.ok(st.macTables.SW1.some((r) => r.vlan === 10 && r.port === 'Gi1/0/1'), 'SW1 の MAC 表に PC1');
    const dom10 = st.domains.find((d) => d.members.includes('PC1:Eth0')); assert.ok(dom10.members.includes('PC3:Eth0') && !dom10.members.includes('PC2:Eth0'), 'ドメイン');
  }
  // STP: 2 台を 2 本でつなぐと片方が代替。優先度を下げたスイッチが根
  const spec = { devices: { SW1: { kind: 'switch' }, SW2: { kind: 'switch' }, PC1: { kind: 'host', ip: '10.1.1.10/24' }, PC2: { kind: 'host', ip: '10.1.1.20/24' } }, links: [['PC1', 'SW1:Gi1/0/1'], ['PC2', 'SW2:Gi1/0/1'], ['SW1:Gi1/0/23', 'SW2:Gi1/0/23'], ['SW1:Gi1/0/24', 'SW2:Gi1/0/24']] };
  const net = sim.build(spec); const st = sim.state(net);
  const roles = Object.values(st.stp.bridges).flatMap((b) => Object.values(b.ports));
  assert.strictEqual(roles.filter((r) => r === 'alternate').length, 1, `代替は 1 つ: ${JSON.stringify(st.stp)}`);
  ok(sim.reach(net, 'PC1', 'PC2'), 'STP で輪を切っても届く');
  sim.applyConfig(net, 'SW2', 'spanning-tree priority 4096'); assert.strictEqual(sim.state(net).stp.root, 'SW2');
  sim.applyConfig(net, 'SW1', 'spanning-tree priority 0'); assert.strictEqual(sim.state(net).stp.root, 'SW1');
  // LACP: 束になれば代替は無い。passive どうしは束にならず片方が代替
  const lag = (a, b) => { const s = sim.util.clone(spec); s.devices.SW1.ifaces = [{ name: 'Gi1/0/23', channelGroup: { id: 1, mode: a } }, { name: 'Gi1/0/24', channelGroup: { id: 1, mode: a } }]; s.devices.SW2.ifaces = [{ name: 'Gi1/0/23', channelGroup: { id: 1, mode: b } }, { name: 'Gi1/0/24', channelGroup: { id: 1, mode: b } }]; return sim.state(sim.build(s)); };
  assert.strictEqual(lag('active', 'passive').lag.SW1[1].up, true); assert.strictEqual(lag('active', 'active').lag.SW1[1].up, true); assert.strictEqual(lag('passive', 'passive').lag.SW1[1].up, false); assert.strictEqual(lag('on', 'on').lag.SW1[1].up, true);
  assert.strictEqual(Object.values(lag('active', 'passive').stp.bridges).flatMap((b) => Object.values(b.ports)).filter((r) => r === 'alternate').length, 0, '束なら代替なし');
  assert.strictEqual(Object.values(lag('passive', 'passive').stp.bridges).flatMap((b) => Object.values(b.ports)).filter((r) => r === 'alternate').length, 1, '束にならなければ 1 本止まる');
  console.log('sim 5 L2 ok');
}

// ---------- 6. サービス ----------
{
  // DHCP: 範囲・除外・ゲートウェイ、最初のアドレスと配れる数、リレー
  const spec = sim.gen.serial(makeRng(41), { routers: 2, hostsOnLan1: 3 });
  const lan1 = spec.meta.lan1;
  for (const h of ['PC1', 'PC3', 'PC4']) { spec.devices[h].dhcp = true; delete spec.devices[h].ip; }
  spec.devices.R1.dhcp = { pools: [{ name: 'LAN1', network: `${lan1}.0/24`, gateway: `${lan1}.1`, dns: `${lan1}.53`, exclude: [[`${lan1}.1`, `${lan1}.49`]] }] };
  const net = sim.build(spec); const st = sim.state(net);
  assert.strictEqual(st.dhcp.leases.PC1.ip, `${lan1}.50`); assert.strictEqual(st.dhcp.leases.PC3.ip, `${lan1}.51`); assert.strictEqual(st.dhcp.leases.PC4.ip, `${lan1}.52`);
  assert.strictEqual(st.dhcp.pools.R1[0].free + st.dhcp.pools.R1[0].bindings.length, 254 - 49, '配れる数 = 254 − 除外 49(ゲートウェイは除外の中)');
  ok(sim.reach(net, 'PC1', 'PC2'), 'DHCP でもらったアドレスで届く');
  const chk = sim.check(net, [{ id: 1, kind: 'lease', host: 'PC1', ip: `${lan1}.50` }, { id: 2, kind: 'lease', device: 'R1', pool: 'LAN1', count: 205 }]);
  assert.ok(chk.every((c) => c.ok), JSON.stringify(chk));
  // 除外無しでゲートウェイだけ: 配れる数 253、最初は .2
  const s2 = sim.util.clone(spec); s2.devices.R1.dhcp.pools[0].exclude = [];
  const st2 = sim.state(sim.build(s2)); assert.strictEqual(st2.dhcp.leases.PC1.ip, `${lan1}.2`); assert.strictEqual(st2.dhcp.pools.R1[0].free + 3, 253);
  // リレー: 範囲は R2 に、R1 の Gi0/0 で relay
  const s3 = sim.util.clone(spec); s3.devices.R2.dhcp = s3.devices.R1.dhcp; delete s3.devices.R1.dhcp;
  s3.devices.R1.ifaces[0].dhcpRelay = s3.devices.R2.ifaces[0].ip.split('/')[0];
  const st3 = sim.state(sim.build(s3)); assert.strictEqual(st3.dhcp.leases.PC1 && st3.dhcp.leases.PC1.server, 'R2', 'リレーで R2 からもらう'); assert.strictEqual(st3.dhcp.leases.PC1.ip, `${lan1}.50`);
  const s4 = sim.util.clone(s3); delete s4.devices.R1.ifaces[0].dhcpRelay; assert.strictEqual(sim.state(sim.build(s4)).dhcp.leases.PC1, undefined, 'リレーが無ければもらえない');
  // VRRP
  const v = sim.gen.serial(makeRng(42), { routers: 1 }); const L = v.meta.lan1;
  const L2n = v.meta.lan2;
  v.devices.R2 = { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: `${L}.2/24`, vrrp: { group: 1, vip: `${L}.254`, priority: 90 } }, { name: 'Gi0/1', ip: `${L2n}.2/24`, vrrp: { group: 2, vip: `${L2n}.254`, priority: 90 } }] };
  v.devices.R1.ifaces[0].vrrp = { group: 1, vip: `${L}.254`, priority: 120 }; v.devices.R1.ifaces[1].vrrp = { group: 2, vip: `${L2n}.254`, priority: 120 };
  v.devices.PC1.gateway = `${L}.254`; v.devices.PC2.gateway = `${L2n}.254`; v.links.push(['R2:Gi0/0', 'SW1:Gi1/0/23'], ['R2:Gi0/1', 'SW2:Gi1/0/23']);
  v.devices.R2.routes = [];
  const vnet = sim.build(v); const vst = sim.state(vnet);
  assert.strictEqual(vst.vrrp[0].master, 'R1'); assert.strictEqual(vst.vrrp[0].backup, 'R2');
  ok(sim.reach(vnet, 'PC1', 'PC2'), '仮想アドレスのゲートウェイで届く'); assert.ok(sim.reach(vnet, 'PC1', 'PC2').path.includes('R1'));
  const m = sim.check(vnet, [{ id: 1, kind: 'master', vip: `${L}.254`, device: 'R1' }, { id: 2, kind: 'master', vip: `${L}.254`, device: 'R2', down: ['R1'] }]);
  assert.ok(m.every((c) => c.ok), JSON.stringify(m));
  const downSt = sim.stateWith(vnet, { down: ['R1'] }); assert.strictEqual(downSt.vrrp[0].master, 'R2');
  const r2 = require('../server/sim/l3').reach(downSt.net, downSt, 'PC1', 'PC2', {}); ok(r2, 'R1 が止まっても R2 経由で届く'); assert.ok(r2.path.includes('R2'));
  console.log('sim 6 サービス ok');
}

// ---------- 7. ターミナル ----------
{
  const spec = sim.gen.serial(makeRng(51), { routers: 2 }); spec.editable = ['R1'];
  spec.devices.SRV1 = { kind: 'server', ip: `${spec.meta.lan1}.53/24`, gateway: `${spec.meta.lan1}.1`, listen: [{ proto: 'udp', port: 53 }], dnsRecords: [{ name: 'www.corp.example', type: 'CNAME', value: 'web.corp.example' }, { name: 'web.corp.example', type: 'A', value: spec.devices.PC2.ip.split('/')[0] }] };
  spec.links.push(['SRV1', 'SW1:Gi1/0/9']); spec.devices.PC1.dns = `${spec.meta.lan1}.53`;
  const s = sim.session(spec, 'PC1');
  assert.ok(/IPv4 アドレス: /.test(sim.exec(s, 'ipconfig')));
  const p = sim.exec(s, 'ping PC2'); assert.ok(/4 回応答/.test(p), p); assert.ok(/TTL=\d+/.test(p));
  const t = sim.exec(s, 'traceroute PC2'); assert.ok(t.split('\n').length >= 4 && /R?\d/.test(t), t);
  const ns = sim.exec(s, 'nslookup www.corp.example'); assert.ok(/CNAME/.test(ns) && /A/.test(ns), ns);
  assert.ok(/省略形/.test(sim.exec(s, 'sh ip route')));
  assert.ok(/R1 につなぎました/.test(sim.exec(s, 'connect R1')));
  assert.ok(/直結/.test(sim.exec(s, 'show ip route')));
  assert.ok(/up/.test(sim.exec(s, 'show ip interface brief')));
  sim.exec(s, 'connect R2'); assert.ok(/設定できません/.test(sim.exec(s, 'configure')));
  sim.exec(s, 'connect R1'); assert.ok(/設定を始めます/.test(sim.exec(s, 'configure')));
  sim.exec(s, 'ip route 10.99.0.0/16 Gi0/1'); const e = sim.exec(s, 'end'); assert.ok(/設定を当てました/.test(e), e);
  assert.ok(/10\.99\.0\.0\/16/.test(sim.exec(s, 'show ip route')));
  sim.exec(s, 'configure'); sim.exec(s, 'int Gi0/0'); const e2 = sim.exec(s, 'end'); assert.ok(/省略形/.test(e2), e2);
  sim.exec(s, 'connect SW1'); assert.ok(/VLAN/.test(sim.exec(s, 'show vlan'))); assert.ok(/02:/.test(sim.exec(s, 'show mac address-table'))); assert.ok(/ルートブリッジ/.test(sim.exec(s, 'show spanning-tree')));
  assert.deepStrictEqual(sim.completions(s, 'show m'), ['show mac address-table']);
  assert.ok(sim.completions(s, 'Gi1/0/2').includes('Gi1/0/24'));
  assert.ok(!sim.completions(s, '').some((w) => /^\d+\.\d+\.\d+/.test(w)), 'アドレスは補わない');
  // 止まる ping の理由
  const s2 = sim.session(spec, 'PC2'); const spec2 = sim.util.clone(spec); spec2.devices.R2.routes = []; const s3 = sim.session(spec2, 'PC1');
  assert.ok(/届かない/.test(sim.exec(s3, 'ping PC2')) && /no-route|経路/.test(sim.exec(s3, 'ping PC2')));
  assert.ok(/\*  \*  \*/.test(sim.exec(s3, 'traceroute PC2')));
  void s2;
  console.log('sim 7 ターミナル ok');
}

// ---------- 8. 図と判定 ----------
{
  const spec = sim.gen.serial(makeRng(61), { routers: 3 });
  const ids = {}; Object.keys(spec.devices).forEach((n, i) => { ids[n] = `n${(i * 7919 + 13).toString(16)}`; });
  const d = sim.diagram(spec, { nodeIds: ids });
  assert.strictEqual(d.nodes.length, Object.keys(spec.devices).length);
  for (const n of d.nodes) { assert.ok(Object.values(ids).includes(n.id)); assert.deepStrictEqual(Object.keys(n).sort(), ['id', 'kind', 'name', 'note', 'ports', 'x', 'y']); }
  for (const l of d.links) assert.ok(Object.values(ids).includes(l.a.node) && Object.values(ids).includes(l.b.node));
  const json = JSON.stringify(d); assert.ok(!/requirements|editable|routes/.test(json), '図に正解の情報が無い');
  const d2 = sim.diagram(sim.gen.cloud(makeRng(1))); assert.ok(d2.groups.length === 1 && d2.nodes.every((n) => n.x >= 0 && n.x <= d2.w));
  // judgeConfig: 243 往復の静的経路(R1・R3 の経路を消して書かせる)
  const q = sim.gen.serial(makeRng(62), { routers: 3, switches: false });
  const lan1 = q.meta.lan1, lan2 = q.meta.lan2;
  q.devices.R1.routes = q.devices.R1.routes.filter((r) => !r.prefix.startsWith(lan2)); q.devices.R3.routes = q.devices.R3.routes.filter((r) => !r.prefix.startsWith(lan1));
  q.editable = ['R1', 'R3']; q.requirements = [{ id: 1, kind: 'reach', from: 'PC1', to: 'PC2', roundTrip: true }];
  assert.ok(!sim.check(sim.build(q), q.requirements)[0].ok, '消した状態では届かない');
  const nh1 = q.devices.R2.ifaces[0].ip.split('/')[0], nh3 = q.devices.R2.ifaces[1].ip.split('/')[0];
  const good = sim.judgeConfig(q, [{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh1}` }, { device: 'R3', text: `ip route ${lan1}.0/24 ${nh3}` }]);
  assert.ok(good.ok, JSON.stringify({ failed: good.failed, errors: good.errors, results: good.results }));
  const half = sim.judgeConfig(q, [{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh1}` }]); assert.ok(!half.ok && half.failed.includes(1), '片方だけでは往復しない');
  const wrongDev = sim.judgeConfig(q, [{ device: 'R2', text: 'ip route 0.0.0.0/0 Null0' }]); assert.ok(!wrongDev.ok && wrongDev.errors[0].message.includes('設定できません'));
  const syntax = sim.judgeConfig(q, [{ device: 'R1', text: `ip rout ${lan2}.0/24 ${nh1}` }]); assert.ok(!syntax.ok && syntax.errors.length === 1 && syntax.errors[0].line === 1);
  // 性能: build + check を 300 回
  const t0 = Date.now(); for (let i = 0; i < 300; i++) sim.judgeConfig(q, [{ device: 'R1', text: `ip route ${lan2}.0/24 ${nh1}` }, { device: 'R3', text: `ip route ${lan1}.0/24 ${nh3}` }]);
  const per = (Date.now() - t0) / 300;
  console.log(`sim 8 図と判定 ok(build + 設定 + 判定 1 回 ${per.toFixed(2)} ms)`);
  assert.ok(per < 20, `遅すぎる ${per} ms`);
}
// ---------- 9. 要件のほかの種類とクラウド ----------
{
  const spec = sim.gen.twoSwitches(makeRng(71), { l3: 'l3sw' });
  const net = sim.build(spec);
  const rs = sim.check(net, [
    { id: 1, kind: 'vlan', device: 'SW1', port: 'Gi1/0/1', vlan: 10 }, { id: 2, kind: 'vlan', device: 'SW1', port: 'Gi1/0/1', vlan: 20 },
    { id: 3, kind: 'trunk', device: 'SW1', port: 'Gi1/0/24', allowed: [10, 20] }, { id: 4, kind: 'trunk', device: 'SW1', port: 'Gi1/0/24', allowed: [10, 30] },
    { id: 5, kind: 'path', from: 'PC1', to: 'PC2', via: ['L3SW1'] }, { id: 6, kind: 'route', device: 'L3SW1', prefix: `${spec.meta.lan[10]}.0/24`, proto: 'C' },
    { id: 7, kind: 'reach', from: 'PC1', to: 'PC4', expect: false },
  ]);
  assert.deepStrictEqual(rs.map((r) => r.ok), [true, false, true, false, true, true, false], JSON.stringify(rs));
  const sq = sim.build(sim.gen.square(makeRng(72)));
  assert.ok(sim.check(sq, [{ id: 1, kind: 'path', from: 'PC1', to: 'PC2', via: ['R1', 'R2', 'R4'] }])[0].ok);
  assert.ok(!sim.check(sq, [{ id: 1, kind: 'path', from: 'PC1', to: 'PC2', via: ['R1', 'R3', 'R4'] }])[0].ok);
  const c = sim.build(sim.gen.cloud(makeRng(73)));
  ok(sim.reach(c, 'VM1', 'VM2'), 'ピアリング(local)'); ok(sim.reach(c, 'INET', 'VM1', { proto: 'tcp', port: 443 }), '公開のサブネットへ外から');
  ng(sim.reach(c, 'INET', 'VM2'), 'natgw', '非公開へ外から'); ok(sim.reach(c, 'VM2', 'INET'), '非公開から外へ'); ng(sim.reach(c, 'VM3', 'INET'), 'no-route', '隔離');
  const cs = sim.gen.cloud(makeRng(73)); cs.devices['SUB-B'].routeTable = cs.devices['SUB-B'].routeTable.filter((r) => r.target === 'local');
  ng(sim.reach(sim.build(cs), 'VM2', 'INET'), 'no-route', '0.0.0.0/0 を消すと外へ出られない(354)');
  const before = JSON.stringify(spec); sim.checkSyntax(spec, 'SW1', 'vlan 30'); assert.strictEqual(JSON.stringify(spec), before, 'checkSyntax は spec を変えない');
  console.log('sim 9 要件とクラウド ok');
}
console.log('sim ok');
