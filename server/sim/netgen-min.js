'use strict';
// 最小の構成生成(NetGen 最小版。LEVELS.md 第 6 章 #9、COMMON.md 第 9 章、design-11-50.md 4.3)。
// 直列トポロジだけを作る:  PC1(+PC3…) — SW1 — R1 — [R2 — R3] — SW2 — PC2
//   - LAN は /24 が 2 つ(SW1 側と SW2 側)、ルータ間は /30。ルータの LAN 側 IF は .1
//   - 各ルータは両方の LAN への経路を持つ(直接接続か、隣のルータを次ホップにした静的経路)
//   - ARP 表(ホスト・ルータ IF)と MAC アドレス表(スイッチ)は収束済みの状態で作る
//   - MAC はローカル管理 02:00:00:xx:xx:xx か、RFC 7042 の文書用 00:00:5e:00:53:xx(構成ごとにどちらか)
// 後で本物の NetGen に置き換える前提なので小さく保つ。依存は引数の rng(makeRng)だけ。Math.random は使わない。
//
// API
//   generate(rng, opts) → net      乱数で spec を作って build する
//     opts: { routers: 1〜3, hostsOnLan1: 1〜5(PC1 を含む SW1 側のホスト数), base, span(拠点の範囲。無ければ 10.0.0.0/8 の中), macStyle: 'local' | 'doc' }
//   build(spec) → net              明示した spec から構成を組む(検証テストが設計書の例題と同じ値で作るのに使う)
//     spec: { lans: [{ net:'10.1.1.0', len:24 }, { net:'10.1.2.0', len:24 }], links: [{ net:'10.0.12.0', len:30 }, …](routers − 1 本),
//             routers: [{ macs: ['02:…'(Gi0/0), '02:…'(Gi0/1)] }, …], hosts: [{ name:'PC1', lan:0, host:10, mac, ttl:64 }, { name:'PC2', lan:1, host:20, mac, ttl:128 }, …] }
//   net の形
//     segments: { lan1: { id, kind:'lan', net, len, switch:'SW1' }, link1: { kind:'p2p', … }, lan2 }、segmentOrder: ['lan1', 'link1', …, 'lan2']
//     devices: { PC1: { name, kind:'host', ttl, ifaces:[iface], arp:[{ ip, mac }] }, R1: { kind:'router', ifaces:[Gi0/0, Gi0/1], routes:[{ prefix, len, nextHop|null, iface }], arp }, SW1: { kind:'switch', segment, macTable:[{ mac, port }] } }
//     iface: { device, name, ip, len, mac, segment, gateway?(ホストのみ), attach: { device, port }(つながっている相手) }
//     hosts: ['PC1', 'PC2', 'PC3'…]、routers: ['R1', …]、switches: ['SW1', 'SW2']、macStyle

const ipToInt = (s) => s.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskOf = (len) => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
const netOf = (ip, len) => (ipToInt(ip) & maskOf(len)) >>> 0;
const inSubnet = (ip, net, len) => netOf(ip, len) === netOf(net, len);
const hex2 = (b) => b.toString(16).padStart(2, '0');

// 拠点の範囲から /22 を 1 つ切り出す(LAN 2 つ + リンク用の /24 を入れる)。拠点が小さい・安全範囲外なら 10.0.0.0/8 の中から
const FAMILIES = [[0x0a000000, 8], [0xac100000, 12], [0xc0a80000, 16]];
function blockFor(rng, opts) {
  const base = (opts.base >>> 0) || 0, span = opts.span || 0;
  const inFamily = FAMILIES.some(([start, p]) => ((base & maskOf(p)) >>> 0) === start && (((base + span) >>> 0) & maskOf(p)) >>> 0 === start);
  if (inFamily && span + 1 >= 1024) {
    const first = Math.ceil(base / 1024) * 1024, last = Math.floor((base + span + 1) / 1024) * 1024 - 1024;
    if (last >= first) return (first + 1024 * rng.rand(0, (last - first) / 1024)) >>> 0;
  }
  return (0x0a000000 + 1024 * rng.rand(0, 16383)) >>> 0; // 10.0.0.0/8 の中の /22
}

function macGen(style, rng, used) {
  for (let guard = 0; guard < 1000; guard++) {
    const m = style === 'doc'
      ? `00:00:5e:00:53:${hex2(rng.rand(0, 255))}`
      : `02:00:00:${hex2(rng.rand(0, 255))}:${hex2(rng.rand(0, 255))}:${hex2(rng.rand(0, 255))}`;
    if (!used.has(m)) { used.add(m); return m; }
  }
  throw new Error('MAC を割り当てられません');
}
function distinctHosts(rng, n, lo, hi) { const s = new Set(); while (s.size < n) s.add(rng.rand(lo, hi)); return [...s]; }

const TTLS = [64, 128, 255];
function generate(rng, opts = {}) {
  const routers = Math.min(3, Math.max(1, opts.routers || 1));
  const hostsOnLan1 = Math.min(5, Math.max(1, opts.hostsOnLan1 || 1));
  const macStyle = opts.macStyle || (rng.next() < 0.5 ? 'local' : 'doc');
  const block = blockFor(rng, opts);
  const perm = rng.shuffle([0, 1, 2, 3]); // /22 の中の 4 つの /24 を LAN1・LAN2・リンク用に割り当てる
  const lans = [{ net: intToIp(block + 256 * perm[0]), len: 24 }, { net: intToIp(block + 256 * perm[1]), len: 24 }];
  const links = Array.from({ length: routers - 1 }, (_, i) => ({ net: intToIp(block + 256 * perm[2] + 4 * i), len: 30 }));
  const used = new Set();
  const rs = Array.from({ length: routers }, () => ({ macs: [macGen(macStyle, rng, used), macGen(macStyle, rng, used)] }));
  const h1 = distinctHosts(rng, hostsOnLan1, 10, 250), h2 = rng.rand(10, 250);
  const ttl1 = rng.pick(TTLS); let ttl2 = rng.pick(TTLS); while (ttl2 === ttl1) ttl2 = rng.pick(TTLS); // 往復で TTL を見分けられるよう両端は別の初期値
  const hosts = [{ name: 'PC1', lan: 0, host: h1[0], mac: macGen(macStyle, rng, used), ttl: ttl1 }, { name: 'PC2', lan: 1, host: h2, mac: macGen(macStyle, rng, used), ttl: ttl2 }];
  for (let i = 1; i < hostsOnLan1; i++) hosts.push({ name: `PC${i + 2}`, lan: 0, host: h1[i], mac: macGen(macStyle, rng, used), ttl: rng.pick(TTLS) });
  return build({ lans, links, routers: rs, hosts, macStyle });
}

function build(spec) {
  const n = spec.routers.length;
  if (n < 1 || spec.lans.length !== 2 || spec.links.length !== n - 1) throw new Error('spec の形が違います(ルータ n 台、LAN 2 つ、リンク n−1 本)');
  const net = { segments: {}, segmentOrder: [], devices: {}, hosts: [], routers: [], switches: ['SW1', 'SW2'], macStyle: spec.macStyle || 'local' };
  const addSeg = (id, kind, s, sw) => { net.segments[id] = { id, kind, net: intToIp(netOf(s.net, s.len)), len: s.len, switch: sw || null }; net.segmentOrder.push(id); };
  addSeg('lan1', 'lan', spec.lans[0], 'SW1');
  spec.links.forEach((l, i) => addSeg(`link${i + 1}`, 'p2p', l, null));
  addSeg('lan2', 'lan', spec.lans[1], 'SW2');
  const segIp = (id, host) => intToIp((ipToInt(net.segments[id].net) + host) >>> 0);
  const iface = (device, name, segment, host, mac, extra = {}) => ({ device, name, ip: segIp(segment, host), len: net.segments[segment].len, mac, segment, ...extra });

  // スイッチ
  for (const [sw, seg] of [['SW1', 'lan1'], ['SW2', 'lan2']]) net.devices[sw] = { name: sw, kind: 'switch', segment: seg, macTable: [] };
  // ルータ: R_i の Gi0/0 は PC1 側、Gi0/1 は PC2 側
  for (let i = 0; i < n; i++) {
    const name = `R${i + 1}`;
    const segIn = i === 0 ? 'lan1' : `link${i}`, segOut = i === n - 1 ? 'lan2' : `link${i + 1}`;
    const gi0 = iface(name, 'Gi0/0', segIn, i === 0 ? 1 : 2, spec.routers[i].macs[0], { attach: i === 0 ? { device: 'SW1', port: 'Gi1/0/24' } : { device: `R${i}`, port: 'Gi0/1' } });
    const gi1 = iface(name, 'Gi0/1', segOut, i === n - 1 ? 1 : 1, spec.routers[i].macs[1], { attach: i === n - 1 ? { device: 'SW2', port: 'Gi1/0/24' } : { device: `R${i + 2}`, port: 'Gi0/0' } });
    net.devices[name] = { name, kind: 'router', ifaces: [gi0, gi1], routes: [], arp: [] };
    net.routers.push(name);
  }
  // ホスト: LAN ごとにスイッチのポート Gi1/0/1, 2, … を順に
  const portNo = { lan1: 0, lan2: 0 };
  for (const h of spec.hosts) {
    const seg = h.lan === 0 ? 'lan1' : 'lan2', sw = net.segments[seg].switch;
    portNo[seg] += 1;
    const ifc = iface(h.name, 'Eth0', seg, h.host, h.mac, { gateway: segIp(seg, 1), attach: { device: sw, port: `Gi1/0/${portNo[seg]}` } });
    net.devices[h.name] = { name: h.name, kind: 'host', ttl: h.ttl, ifaces: [ifc], arp: [] };
    net.hosts.push(h.name);
  }
  // 経路: 直接接続はそのまま、それ以外は PC1 側なら Gi0/0 の先、PC2 側なら Gi0/1 の先のルータを次ホップに
  const order = net.segmentOrder;
  for (let i = 0; i < n; i++) {
    const r = net.devices[`R${i + 1}`];
    const [gi0, gi1] = r.ifaces;
    const myIn = order.indexOf(gi0.segment);
    for (const segId of order) {
      const s = net.segments[segId];
      const route = { prefix: s.net, len: s.len, nextHop: null, iface: null };
      if (segId === gi0.segment) route.iface = gi0.name;
      else if (segId === gi1.segment) route.iface = gi1.name;
      else if (order.indexOf(segId) < myIn) { route.iface = gi0.name; route.nextHop = net.devices[`R${i}`].ifaces[1].ip; }
      else { route.iface = gi1.name; route.nextHop = net.devices[`R${i + 2}`].ifaces[0].ip; }
      r.routes.push(route);
    }
  }
  // 収束済みの ARP 表(同じセグメントの全 IF)と MAC アドレス表(スイッチにつながる全 IF)
  const all = allIfaces(net);
  for (const d of Object.values(net.devices)) {
    if (d.kind === 'switch') { d.macTable = all.filter((f) => f.segment === d.segment).map((f) => ({ mac: f.mac, port: f.attach.port })); continue; }
    for (const mine of d.ifaces) for (const f of all) if (f.segment === mine.segment && f.device !== d.name) d.arp.push({ ip: f.ip, mac: f.mac });
  }
  return net;
}

function allIfaces(net) { return Object.values(net.devices).filter((d) => d.ifaces).flatMap((d) => d.ifaces); }

module.exports = { generate, build, allIfaces, ipToInt, intToIp, maskOf, netOf, inSubnet, blockFor, TTLS };
