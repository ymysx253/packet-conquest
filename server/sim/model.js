'use strict';
// 構成(spec。docs/questions/SIM-API.md 第 2 章)を、模擬が扱う形(net)にする。spec は壊さない(deep copy)。
// 決めたこと(SIM-API.md に無かった細部):
//   - 副 IF は 'Gi0/0.10' という名前の別の iface として持つ(parent と tag を付ける)。SVI は 'Vlan10' という名前の iface(vlanId を付ける)
//   - スイッチのポートは、spec に無くてもリンクに出てくれば作る(既定はアクセス VLAN 1)。ルーターの IF も同様(アドレス無し)
//   - ホスト・サーバー・外の網(internet)は IF 1 つ('Eth0')。クラウドのサブネット(cloud-subnet)は、VM をつなぐスイッチ兼ゲートウェイ(.1)として扱う
//   - MAC は spec に無ければ seed・機器名・IF 名から決める(ローカル管理 02:…)
const U = require('./util');

const L3_KINDS = new Set(['router', 'l3switch', 'firewall']);
const HOST_KINDS = new Set(['host', 'server', 'internet']);
const KINDS = new Set(['router', 'switch', 'l3switch', 'host', 'server', 'firewall', 'internet', 'cloud-subnet', 'dhcp', 'cloud-gw']); // cloud-gw は図に見せるだけの口(IGW・NAT ゲートウェイ。線をつながない)

function makeIface(dev, name, extra = {}) {
  return {
    dev: dev.name, name, ip: null, len: null, ipv6: null, shutdown: false, ospfCost: null, aclIn: null, aclOut: null, natSide: null, dhcpRelay: null,
    vrrp: [], mode: null, vlan: null, allowed: null, native: 1, edge: false, channelGroup: null, snoopingTrust: false, mac: null, parent: null, tag: null, vlanId: null, ...extra,
  };
}
function setIp(ifc, cidr) {
  if (cidr === null || cidr === undefined) { ifc.ip = null; ifc.len = null; return true; }
  const p = typeof cidr === 'string' ? U.parseCidr(cidr) : cidr;
  if (!p) return false;
  ifc.ip = p.ip; ifc.len = p.len; return true;
}
const addIface = (dev, name, extra) => { const ifc = makeIface(dev, name, extra); dev.ifaces.push(ifc); dev.ifByName[name] = ifc; return ifc; };
const getIface = (dev, name, create = false) => {
  const n = U.canonIf(name);
  if (!n) return null;
  if (dev.ifByName[n]) return dev.ifByName[n];
  if (!create) return null;
  const m = /^(.*)\.(\d+)$/.exec(n);
  if (m) { const parent = getIface(dev, m[1], true); if (!parent) return null; return addIface(dev, n, { parent: parent.name, tag: Number(m[2]) }); }
  if (/^Vlan\d+$/.test(n)) return addIface(dev, n, { vlanId: Number(n.slice(4)) });
  return addIface(dev, n, dev.kind === 'switch' || dev.kind === 'l3switch' ? { mode: 'access', vlan: 1 } : {});
};

function buildDevice(name, d, seed) {
  const kind = d.kind || 'host';
  if (!KINDS.has(kind)) throw new Error(`${name}: 知らない機器の種類 ${kind}`);
  const dev = {
    name, kind, ifaces: [], ifByName: {}, routes: [], routes6: [], ospf: null, acls: {}, nat: { inside: [], outside: [], source: [], static: [] },
    dhcp: { pools: [], exclude: [] }, vlans: new Set([1]), stpPriority: 32768, ipRouting: kind === 'router' || kind === 'firewall', dhcpSnooping: false,
    zones: {}, policies: [], listen: [], listenAll: kind === 'internet', ttl: d.ttl || 64, gateway: null, dns: null, dhcpClient: false, routeTable: null, cidr: null, hidden: [],
    dnsRecords: (d.dnsRecords || []).map((r) => ({ name: String(r.name).toLowerCase(), type: (r.type || 'A').toUpperCase(), value: String(r.value) })), // DNS サーバー役(nslookup 用。A と CNAME)
  };
  if (HOST_KINDS.has(kind)) {
    const ifc = addIface(dev, 'Eth0');
    if (d.ip && !setIp(ifc, d.ip)) throw new Error(`${name}: アドレスが読めない ${d.ip}`);
    if (d.ipv6) ifc.ipv6 = d.ipv6;
    if (d.mac) ifc.mac = d.mac;
    dev.gateway = d.gateway || null; dev.dns = d.dns || null; dev.dhcpClient = !!d.dhcp;
    dev.listen = (d.listen || []).map((l) => ({ proto: l.proto, port: Number(l.port) }));
    if (kind === 'internet') { dev.listenAll = true; dev.ipRouting = false; }
  } else if (kind === 'cloud-subnet') {
    const p = U.parseCidr(d.cidr || d.ip); if (!p) throw new Error(`${name}: サブネットの範囲が読めない`);
    dev.cidr = `${U.intToIp(U.netOf(U.ipToInt(p.ip), p.len))}/${p.len}`;
    const gw = addIface(dev, 'Vlan1', { vlanId: 1 });
    setIp(gw, `${U.intToIp(U.netOf(U.ipToInt(p.ip), p.len) + 1)}/${p.len}`);
    dev.routeTable = (d.routeTable || []).map((r) => ({ prefix: r.prefix, target: r.target }));
    dev.ipRouting = true;
  } else {
    for (const i of d.ifaces || []) {
      const n = U.canonIf(i.name); if (!n) throw new Error(`${name}: IF 名が読めない ${i.name}`);
      const ifc = getIface(dev, n, true);
      if (i.ip !== undefined && !setIp(ifc, i.ip)) throw new Error(`${name} ${n}: アドレスが読めない ${i.ip}`);
      for (const k of ['ipv6', 'shutdown', 'ospfCost', 'aclIn', 'aclOut', 'natSide', 'dhcpRelay', 'edge', 'snoopingTrust', 'mac']) if (i[k] !== undefined) ifc[k] = i[k];
      if (i.mode) ifc.mode = i.mode;
      if (i.vlan !== undefined) ifc.vlan = Number(i.vlan);
      if (i.allowed) ifc.allowed = new Set(i.allowed.map(Number));
      if (i.native !== undefined) ifc.native = Number(i.native);
      if (i.channelGroup) ifc.channelGroup = { id: Number(i.channelGroup.id), mode: i.channelGroup.mode || 'on' };
      if (i.vrrp) ifc.vrrp = (Array.isArray(i.vrrp) ? i.vrrp : [i.vrrp]).map((v) => ({ group: Number(v.group || 1), vip: v.vip, priority: v.priority === undefined ? 100 : Number(v.priority), preempt: v.preempt === undefined ? true : !!v.preempt }));
      for (const s of i.sub || []) { const sub = getIface(dev, `${n}.${s.tag}`, true); if (s.ip && !setIp(sub, s.ip)) throw new Error(`${name} ${n}.${s.tag}: アドレスが読めない`); }
    }
    for (const s of d.svis || []) { const svi = getIface(dev, `Vlan${s.vlan}`, true); if (s.ip && !setIp(svi, s.ip)) throw new Error(`${name} Vlan${s.vlan}: アドレスが読めない`); dev.vlans.add(Number(s.vlan)); }
    for (const v of d.vlans || []) dev.vlans.add(Number(v));
    for (const ifc of dev.ifaces) if (ifc.vlan) dev.vlans.add(ifc.vlan);
    if (d.stpPriority !== undefined) dev.stpPriority = Number(d.stpPriority);
    if (d.ipRouting !== undefined) dev.ipRouting = !!d.ipRouting;
    if (d.dhcpSnooping !== undefined) dev.dhcpSnooping = !!d.dhcpSnooping;
    dev.routes = (d.routes || []).map((r) => ({ prefix: r.prefix, via: r.via, ad: r.ad === undefined ? 1 : Number(r.ad) }));
    dev.routes6 = (d.routes6 || []).map((r) => ({ prefix: r.prefix, via: r.via }));
    if (d.ospf) dev.ospf = { process: d.ospf.process || 1, area: d.ospf.area === undefined ? 0 : d.ospf.area, networks: (d.ospf.networks || []).slice(), hello: d.ospf.hello || null, dead: d.ospf.dead || null, auth: d.ospf.auth || null };
    for (const [an, a] of Object.entries(d.acls || {})) dev.acls[an] = { type: a.type || 'standard', lines: (a.lines || []).map((l) => ({ seq: Number(l.seq), action: l.action, proto: l.proto || 'ip', src: l.src || 'any', dst: l.dst || 'any', dport: l.dport === undefined ? null : Number(l.dport) })).sort((x, y) => x.seq - y.seq) };
    if (d.nat) {
      dev.nat.inside = (d.nat.inside || []).map(U.canonIf); dev.nat.outside = (d.nat.outside || []).map(U.canonIf);
      dev.nat.source = (d.nat.source || []).map((s) => ({ src: s.src, iface: U.canonIf(s.iface), overload: s.overload !== false }));
      dev.nat.static = (d.nat.static || []).map((s) => ({ proto: s.proto || 'tcp', insideIp: s.insideIp, insidePort: s.insidePort === undefined ? null : Number(s.insidePort), outsideIp: s.outsideIp, outsidePort: s.outsidePort === undefined ? null : Number(s.outsidePort) }));
      for (const n of dev.nat.inside) { const f = getIface(dev, n, true); f.natSide = 'inside'; }
      for (const n of dev.nat.outside) { const f = getIface(dev, n, true); f.natSide = 'outside'; }
    }
    if (d.dhcp) {
      dev.dhcp.pools = (d.dhcp.pools || []).map((p) => ({ name: p.name, network: p.network || null, gateway: p.gateway || null, dns: p.dns || null, exclude: (p.exclude || []).map((e) => (Array.isArray(e) ? e.slice() : [e, e])) }));
      dev.dhcp.exclude = (d.dhcp.exclude || []).map((e) => (Array.isArray(e) ? e.slice() : [e, e]));
    }
    if (d.zones) for (const [z, ifs] of Object.entries(d.zones)) dev.zones[z] = ifs.map(U.canonIf);
    dev.policies = (d.policies || []).map((p) => ({ from: p.from, to: p.to, proto: p.proto || 'ip', dport: p.dport === undefined ? null : Number(p.dport), action: p.action || 'permit' }));
    dev.listen = (d.listen || []).map((l) => ({ proto: l.proto, port: Number(l.port) }));
  }
  for (const ifc of dev.ifaces) if (!ifc.mac && !ifc.parent && !ifc.vlanId) ifc.mac = U.macFrom(`${seed}|${name}|${ifc.name}`);
  return dev;
}

// 'dev' か 'dev:port' → { dev, iface }
function parseEnd(net, s) {
  const [dn, pn] = String(s).split(':');
  const dev = net.devices[dn]; if (!dev) throw new Error(`リンクの端 ${s}: 機器 ${dn} が無い`);
  if (pn === undefined) {
    if (dev.ifaces.length === 1 || HOST_KINDS.has(dev.kind)) return { dev: dn, iface: dev.ifaces[0].name };
    throw new Error(`リンクの端 ${s}: ポートを書く`);
  }
  const ifc = getIface(dev, pn, true); if (!ifc) throw new Error(`リンクの端 ${s}: IF 名が読めない`);
  if (dev.kind === 'cloud-subnet') { ifc.mode = 'access'; ifc.vlan = 1; }
  return { dev: dn, iface: ifc.name };
}

function build(spec) {
  const s = U.clone(spec);
  const seed = s.seed === undefined ? U.hash32(JSON.stringify(Object.keys(s.devices || {}))) : s.seed;
  const net = { spec: U.clone(spec), seed, devices: {}, links: [], peer: {}, editable: (s.editable || []).slice(), requirements: s.requirements || [], hidden: s.hidden || {}, layout: s.layout || null, _state: null };
  for (const [name, d] of Object.entries(s.devices || {})) net.devices[name] = buildDevice(name, d, seed);
  for (const [name, h] of Object.entries(net.hidden)) if (net.devices[name]) net.devices[name].hidden = h.slice();
  (s.links || []).forEach((l, i) => {
    const a = parseEnd(net, l[0]), b = parseEnd(net, l[1]);
    const ka = U.ifKey(a.dev, a.iface), kb = U.ifKey(b.dev, b.iface);
    if (net.peer[ka] || net.peer[kb]) throw new Error(`リンク ${i + 1}: 同じポートに 2 本`);
    net.peer[ka] = kb; net.peer[kb] = ka;
    net.links.push({ id: `L${i + 1}`, a, b, up: true });
  });
  for (const dev of Object.values(net.devices)) for (const ifc of dev.ifaces) if (ifc.parent) { const p = dev.ifByName[ifc.parent]; if (p && p.mac && !ifc.mac) ifc.mac = p.mac; }
  return net;
}

const invalidate = (net) => { net._state = null; };
const isL3 = (dev) => L3_KINDS.has(dev.kind) || (dev.kind === 'l3switch') || dev.kind === 'cloud-subnet';
const routesPackets = (dev) => (dev.kind === 'router' || dev.kind === 'firewall' || dev.kind === 'cloud-subnet' || (dev.kind === 'l3switch' && dev.ipRouting));
const peerOf = (net, dev, iface) => { const k = net.peer[U.ifKey(dev, iface)]; if (!k) return null; const [d, i] = k.split(':'); return { dev: d, iface: i }; };
const linkUp = (net, dev, iface) => { const k = U.ifKey(dev, iface); const l = net.links.find((x) => U.ifKey(x.a.dev, x.a.iface) === k || U.ifKey(x.b.dev, x.b.iface) === k); return !!l && l.up; };

module.exports = { build, getIface, addIface, setIp, invalidate, isL3, routesPackets, peerOf, linkUp, HOST_KINDS, L3_KINDS };
