'use strict';
// 構成を作る道具(docs/questions/SIM-API.md 第 6 章)。どれも「そろった(全部届く)」spec を返す。問題はそこから消す・壊す。
// 乱数は引数の rng(makeRng)だけ。アドレスは COMMON.md 第 7 章の範囲(10/8・172.16/12・192.168/16。外は 203.0.113/24・198.51.100/24)
// 決めたこと:
//   - 拠点の中は /16 を 1 つ切り出し(10.X.0.0/16 / 172.16+X.0.0/16 / 192.168.0.0/16)、LAN は .1〜.199 の /24、ルーター間は .250〜.254 の /30
//   - twoSites の外の網は 203.0.113.0/24。ISP というスイッチ(外の網の線)で R1・R2・INET(203.0.113.254)をつなぐ
//   - ホストの .10・.20・.30、ルーターの LAN 側は .1
const U = require('./util');

function addresses(rng) {
  const f = rng.pick(['10', '10', '172', '192']);
  const base = f === '10' ? `10.${rng.rand(1, 250)}` : f === '172' ? `172.${rng.rand(16, 31)}` : '192.168';
  let lanNo = 0, p2pNo = 0;
  return {
    base, block: `${base}.0.0/16`,
    lan: () => { lanNo += 1; const n = rng.rand(lanNo * 10, lanNo * 10 + 9); return `${base}.${n}`; },         // 'a.b.c'(/24 の頭 3 つ)
    p2p: () => { p2pNo += 1; return `${base}.${250 + Math.floor((p2pNo - 1) / 64)}.${((p2pNo - 1) % 64) * 4}`; }, // /30 の網のアドレス
    host: (lan3, h) => `${lan3}.${h}`,
  };
}
const cidr24 = (lan3, h) => `${lan3}.${h}/24`;
const p2pIps = (net30) => { const n = U.ipToInt(net30); return [`${U.intToIp(n + 1)}/30`, `${U.intToIp(n + 2)}/30`, U.intToIp(n + 1), U.intToIp(n + 2)]; };

// 直列: PC1(+PC3…) — SW1 — R1 — [R2 — R3] — SW2 — PC2
function serial(rng, opts = {}) {
  const routers = Math.min(3, Math.max(1, opts.routers || 1)), hostsOnLan1 = Math.min(5, Math.max(1, opts.hostsOnLan1 || 1));
  const switches = opts.switches !== false || hostsOnLan1 > 1; // LAN1 にホストが 2 台以上ならスイッチが要る
  const A = addresses(rng);
  const lan1 = A.lan(), lan2 = A.lan();
  const links = [];
  const dev = {};
  const hostIps = []; while (hostIps.length < hostsOnLan1) { const h = rng.rand(10, 200); if (!hostIps.includes(h)) hostIps.push(h); }
  dev.PC1 = { kind: 'host', ip: cidr24(lan1, hostIps[0]), gateway: `${lan1}.1`, ttl: rng.pick([64, 128]) };
  for (let i = 1; i < hostsOnLan1; i++) dev[`PC${i + 2}`] = { kind: 'host', ip: cidr24(lan1, hostIps[i]), gateway: `${lan1}.1` };
  dev.PC2 = { kind: 'host', ip: cidr24(lan2, rng.rand(10, 200)), gateway: `${lan2}.1`, ttl: rng.pick([64, 128]) };
  const p2ps = Array.from({ length: routers - 1 }, () => p2pIps(A.p2p()));
  for (let i = 0; i < routers; i++) {
    const name = `R${i + 1}`;
    const gi0 = i === 0 ? cidr24(lan1, 1) : p2ps[i - 1][1], gi1 = i === routers - 1 ? cidr24(lan2, 1) : p2ps[i][0];
    const routes = [];
    if (i > 0) routes.push({ prefix: `${lan1}.0/24`, via: p2ps[i - 1][2] });
    if (i < routers - 1) routes.push({ prefix: `${lan2}.0/24`, via: p2ps[i][3] });
    for (let j = 0; j < routers - 1; j++) { if (j < i - 1) routes.push({ prefix: `${U.intToIp(U.ipToInt(p2ps[j][2]) - 1)}/30`, via: p2ps[i - 1][2] }); if (j > i) routes.push({ prefix: `${U.intToIp(U.ipToInt(p2ps[j][2]) - 1)}/30`, via: p2ps[i][3] }); }
    dev[name] = { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: gi0 }, { name: 'Gi0/1', ip: gi1 }], routes };
    if (opts.ospf) { dev[name].routes = []; dev[name].ospf = { networks: [A.block], area: 0 }; }
    if (i < routers - 1) links.push([`${name}:Gi0/1`, `R${i + 2}:Gi0/0`]);
  }
  if (switches) {
    dev.SW1 = { kind: 'switch' }; dev.SW2 = { kind: 'switch' };
    links.push(['PC1', 'SW1:Gi1/0/1']); for (let i = 1; i < hostsOnLan1; i++) links.push([`PC${i + 2}`, `SW1:Gi1/0/${i + 1}`]);
    links.push(['SW1:Gi1/0/24', 'R1:Gi0/0'], [`R${routers}:Gi0/1`, 'SW2:Gi1/0/24'], ['PC2', 'SW2:Gi1/0/1']);
  } else { links.push(['PC1', 'R1:Gi0/0'], [`R${routers}:Gi0/1`, 'PC2']); }
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout: 'serial', meta: { lan1, lan2, block: A.block, routers, hostsOnLan1 } };
}

// 三角形: R1–R2–R3 と R1–R3。PC1 は R1 の下、PC2 は R3 の下。OSPF(コストは opts.costs = { r1r2, r2r3, r1r3 })
function triangle(rng, opts = {}) {
  const A = addresses(rng); const lan1 = A.lan(), lan2 = A.lan();
  const [a12, b12, , ] = p2pIps(A.p2p()), [a23, b23] = p2pIps(A.p2p()), [a13, b13] = p2pIps(A.p2p());
  const c = { r1r2: 1, r2r3: 1, r1r3: 1, ...(opts.costs || {}) };
  const dev = {
    PC1: { kind: 'host', ip: cidr24(lan1, rng.rand(10, 200)), gateway: `${lan1}.1` },
    PC2: { kind: 'host', ip: cidr24(lan2, rng.rand(10, 200)), gateway: `${lan2}.1` },
    R1: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(lan1, 1) }, { name: 'Gi0/1', ip: a12, ospfCost: c.r1r2 }, { name: 'Gi0/2', ip: a13, ospfCost: c.r1r3 }], ospf: { networks: [A.block], area: 0 } },
    R2: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: b12, ospfCost: c.r1r2 }, { name: 'Gi0/1', ip: a23, ospfCost: c.r2r3 }], ospf: { networks: [A.block], area: 0 } },
    R3: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(lan2, 1) }, { name: 'Gi0/1', ip: b23, ospfCost: c.r2r3 }, { name: 'Gi0/2', ip: b13, ospfCost: c.r1r3 }], ospf: { networks: [A.block], area: 0 } },
  };
  const links = [['PC1', 'R1:Gi0/0'], ['R1:Gi0/1', 'R2:Gi0/0'], ['R2:Gi0/1', 'R3:Gi0/1'], ['R1:Gi0/2', 'R3:Gi0/2'], ['R3:Gi0/0', 'PC2']];
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout: 'triangle', meta: { lan1, lan2, block: A.block, costs: c } };
}

// 四角形(2 本の道): R1–R2–R4 と R1–R3–R4。opts.costs = [r1r2, r2r4, r1r3, r3r4](既定 1,1,1,2 → R2 回りが短い)
function square(rng, opts = {}) {
  const A = addresses(rng); const lan1 = A.lan(), lan2 = A.lan();
  const costs = opts.costs || [1, 1, 1, 2];
  const [a12, b12] = p2pIps(A.p2p()), [a24, b24] = p2pIps(A.p2p()), [a13, b13] = p2pIps(A.p2p()), [a34, b34] = p2pIps(A.p2p());
  const o = { networks: [A.block], area: 0 };
  const dev = {
    PC1: { kind: 'host', ip: cidr24(lan1, rng.rand(10, 200)), gateway: `${lan1}.1` },
    PC2: { kind: 'host', ip: cidr24(lan2, rng.rand(10, 200)), gateway: `${lan2}.1` },
    R1: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(lan1, 1) }, { name: 'Gi0/1', ip: a12, ospfCost: costs[0] }, { name: 'Gi0/2', ip: a13, ospfCost: costs[2] }], ospf: o },
    R2: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: b12, ospfCost: costs[0] }, { name: 'Gi0/1', ip: a24, ospfCost: costs[1] }], ospf: o },
    R3: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: b13, ospfCost: costs[2] }, { name: 'Gi0/1', ip: a34, ospfCost: costs[3] }], ospf: o },
    R4: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(lan2, 1) }, { name: 'Gi0/1', ip: b24, ospfCost: costs[1] }, { name: 'Gi0/2', ip: b34, ospfCost: costs[3] }], ospf: o },
  };
  const links = [['PC1', 'R1:Gi0/0'], ['R1:Gi0/1', 'R2:Gi0/0'], ['R2:Gi0/1', 'R4:Gi0/1'], ['R1:Gi0/2', 'R3:Gi0/0'], ['R3:Gi0/1', 'R4:Gi0/2'], ['R4:Gi0/0', 'PC2']];
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout: 'square', meta: { lan1, lan2, block: A.block, costs } };
}

// 2 拠点: 本社(PC1・SRV1・SW1・R1)— 外の網(ISP・INET)— 支社(R2・SW2・PC2)
function twoSites(rng, opts = {}) {
  const A = addresses(rng); const hq = A.lan(), br = A.lan();
  const srvPort = opts.srvPort || 443;
  const dev = {
    PC1: { kind: 'host', ip: cidr24(hq, rng.rand(10, 99)), gateway: `${hq}.1` },
    SRV1: { kind: 'server', ip: cidr24(hq, rng.rand(100, 200)), gateway: `${hq}.1`, listen: [{ proto: 'tcp', port: srvPort }, { proto: 'tcp', port: 22 }] },
    SW1: { kind: 'switch' },
    R1: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(hq, 1) }, { name: 'Gi0/1', ip: '203.0.113.1/24' }], routes: [{ prefix: `${br}.0/24`, via: '203.0.113.2' }, { prefix: '0.0.0.0/0', via: '203.0.113.254' }] },
    ISP: { kind: 'switch' },
    INET: { kind: 'internet', ip: '203.0.113.254/24' },
    R2: { kind: 'router', ifaces: [{ name: 'Gi0/0', ip: cidr24(br, 1) }, { name: 'Gi0/1', ip: '203.0.113.2/24' }], routes: [{ prefix: `${hq}.0/24`, via: '203.0.113.1' }, { prefix: '0.0.0.0/0', via: '203.0.113.254' }] },
    SW2: { kind: 'switch' },
    PC2: { kind: 'host', ip: cidr24(br, rng.rand(10, 200)), gateway: `${br}.1` },
  };
  const links = [['PC1', 'SW1:Gi1/0/1'], ['SRV1', 'SW1:Gi1/0/2'], ['SW1:Gi1/0/24', 'R1:Gi0/0'], ['R1:Gi0/1', 'ISP:Gi1/0/1'], ['INET', 'ISP:Gi1/0/3'], ['R2:Gi0/1', 'ISP:Gi1/0/2'], ['R2:Gi0/0', 'SW2:Gi1/0/24'], ['PC2', 'SW2:Gi1/0/1']];
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout: 'two-sites', meta: { hq, br, block: A.block, srvPort } };
}

// スイッチ 2 台 + トランク。VLAN 10・20 の PC が両方に。VLAN 間は L3SW1(SVI)か R1 の副 IF(opts.l3 = 'l3sw' | 'subif')
function twoSwitches(rng, opts = {}) {
  const A = addresses(rng); const vl = opts.vlans || [10, 20]; const l3 = opts.l3 || 'l3sw';
  const lan = {}; for (const v of vl) lan[v] = `${A.base}.${v}`;
  const dev = {
    SW1: { kind: 'switch', vlans: vl, ifaces: [{ name: 'Gi1/0/1', mode: 'access', vlan: vl[0] }, { name: 'Gi1/0/2', mode: 'access', vlan: vl[1] }, { name: 'Gi1/0/23', mode: 'trunk', allowed: vl, native: 1 }, { name: 'Gi1/0/24', mode: 'trunk', allowed: vl, native: 1 }] },
    SW2: { kind: 'switch', vlans: vl, ifaces: [{ name: 'Gi1/0/1', mode: 'access', vlan: vl[0] }, { name: 'Gi1/0/2', mode: 'access', vlan: vl[1] }, { name: 'Gi1/0/24', mode: 'trunk', allowed: vl, native: 1 }] },
    PC1: { kind: 'host', ip: cidr24(lan[vl[0]], rng.rand(10, 99)), gateway: `${lan[vl[0]]}.1` },
    PC2: { kind: 'host', ip: cidr24(lan[vl[1]], rng.rand(10, 99)), gateway: `${lan[vl[1]]}.1` },
    PC3: { kind: 'host', ip: cidr24(lan[vl[0]], rng.rand(100, 200)), gateway: `${lan[vl[0]]}.1` },
    PC4: { kind: 'host', ip: cidr24(lan[vl[1]], rng.rand(100, 200)), gateway: `${lan[vl[1]]}.1` },
  };
  const links = [['PC1', 'SW1:Gi1/0/1'], ['PC2', 'SW1:Gi1/0/2'], ['SW1:Gi1/0/24', 'SW2:Gi1/0/24'], ['PC3', 'SW2:Gi1/0/1'], ['PC4', 'SW2:Gi1/0/2']];
  if (l3 === 'l3sw') {
    dev.L3SW1 = { kind: 'l3switch', ipRouting: true, vlans: vl, ifaces: [{ name: 'Gi1/0/1', mode: 'trunk', allowed: vl, native: 1 }], svis: vl.map((v) => ({ vlan: v, ip: cidr24(lan[v], 1) })) };
    links.push(['SW1:Gi1/0/23', 'L3SW1:Gi1/0/1']);
  } else {
    dev.R1 = { kind: 'router', ifaces: [{ name: 'Gi0/0', sub: vl.map((v) => ({ tag: v, ip: cidr24(lan[v], 1) })) }] };
    links.push(['SW1:Gi1/0/23', 'R1:Gi0/0']);
  }
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout: 'two-switches', meta: { vlans: vl, lan, block: A.block, l3 } };
}

// PC クラウド: 公開(SUB-A)・非公開(SUB-B)・隔離(SUB-C)のサブネットと VM、外の網
function cloud(rng, opts = {}) {
  const X = rng.rand(1, 250); const vnet = `10.${X}.0.0/16`;
  const sub = (i) => `10.${X}.${i}.0/24`;
  const dev = {
    INET: { kind: 'internet', ip: '198.51.100.1/24' },
    IGW: { kind: 'cloud-gw' }, NATGW: { kind: 'cloud-gw' },
    'SUB-A': { kind: 'cloud-subnet', cidr: sub(1), routeTable: [{ prefix: vnet, target: 'local' }, { prefix: '0.0.0.0/0', target: 'igw' }] },
    'SUB-B': { kind: 'cloud-subnet', cidr: sub(2), routeTable: [{ prefix: vnet, target: 'local' }, { prefix: '0.0.0.0/0', target: 'natgw' }] },
    'SUB-C': { kind: 'cloud-subnet', cidr: sub(3), routeTable: [{ prefix: vnet, target: 'local' }] },
    VM1: { kind: 'server', ip: `10.${X}.1.${rng.rand(10, 200)}/24`, gateway: `10.${X}.1.1`, listen: [{ proto: 'tcp', port: 443 }] },
    VM2: { kind: 'host', ip: `10.${X}.2.${rng.rand(10, 200)}/24`, gateway: `10.${X}.2.1` },
    VM3: { kind: 'host', ip: `10.${X}.3.${rng.rand(10, 200)}/24`, gateway: `10.${X}.3.1` },
  };
  const links = [['VM1', 'SUB-A:Gi1/0/1'], ['VM2', 'SUB-B:Gi1/0/1'], ['VM3', 'SUB-C:Gi1/0/1']];
  if (opts.isolatedPrivate) dev['SUB-C'].routeTable = [{ prefix: vnet, target: 'local' }, { prefix: '0.0.0.0/0', target: 'natgw' }];
  return { seed: rng.rand(0, 2 ** 31), devices: dev, links, editable: [], requirements: [], layout: 'cloud', meta: { vnet, X } };
}

module.exports = { addresses, serial, triangle, square, twoSites, twoSwitches, cloud, cidr24, p2pIps };
