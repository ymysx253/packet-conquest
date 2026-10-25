'use strict';
// L3 の模擬: 経路表(直結・静的・OSPF)、最長一致、ARP、パケットの旅(ACL・NAT・TTL・輪・往復・FW の状態)(docs/questions/SIM-API.md 第 3 章)。
// 決めたこと:
//   - OSPF のネイバー: 同じドメイン・同じ網に両方の IF があり、両方が OSPF に入れていて、エリア(と hello/dead/認証があればそれ)が同じ。コストは出ていく IF の ospfCost(無ければ 1)。
//     網へのメトリックは、その網を持つルーターまでのコスト + そのルーターのその IF のコスト。同じメトリックは両方残す(先頭を使う)。redistribute static は外部経路(メトリック 20、AD 110)
//   - 静的経路の via がアドレスなら、直結の網で引けるときだけ使う(引けない経路は経路表に載らない)
//   - ホストは「直結 + ゲートウェイへの既定経路」。VRRP の仮想アドレスは代表のルーターが答える
//   - 外の網(internet)は、自分の網のアドレス全部を持っていることにする(そこへ届けば外に出られた)
//   - 状態を見る FW(firewall)は、行きを通した通信の返りを覚えていて通す。ルーターの ACL は状態を見ない
//   - クラウドのサブネット: 自分の経路表(local / igw / natgw / peer:<名前>)で外や隣のサブネットへ送る。natgw の先からは、返りしか入れない
const U = require('./util');
const M = require('./model');
const L2 = require('./l2');

const AD = { C: 0, S: 1, O: 110 };

// ---------- 端点(IP を持つ口) ----------
function buildEndpoints(net, l2, leases) {
  const eps = [];
  for (const dev of Object.values(net.devices)) {
    for (const ifc of dev.ifaces) {
      if (ifc.shutdown) continue;
      const ip = leases[dev.name] && ifc.name === 'Eth0' ? leases[dev.name].ip : ifc.ip;
      const len = leases[dev.name] && ifc.name === 'Eth0' ? leases[dev.name].len : ifc.len;
      if (!ip) continue;
      const key = L2.keyOf(net, dev, ifc);
      const domain = l2.domainOf[key] || null;
      eps.push({ key, dev: dev.name, iface: ifc.name, ip, len, mac: ifc.mac || l2.endpointMac[key] || null, domain, virtual: false });
    }
  }
  return eps;
}
const effIp = (st, dev, ifc) => { const e = st.endpoints.find((x) => x.dev === dev.name && x.iface === ifc.name && !x.virtual); return e ? { ip: e.ip, len: e.len } : { ip: ifc.ip, len: ifc.len }; };

// ---------- 経路表 ----------
// IF の線が生きているか: 線が切れている(cut)・相手の IF が止まっている(down)なら、その IF の直結の経路は消える(現実のリンクダウンと同じ。予備の経路 failover の判定に要る)。
// 線をつないでいない IF(spec に link が無い)は、その先に小さな網があるとみなして生きている扱い
function linkOk(net, dev, ifc) {
  if (!ifc || ifc.vlanId) return true;
  const phys = ifc.parent ? dev.ifByName[ifc.parent] : ifc;
  if (!phys || phys.shutdown) return false;
  const key = U.ifKey(dev.name, phys.name);
  const peerKey = net.peer[key]; if (!peerKey) return true;
  if (!M.linkUp(net, dev.name, phys.name)) return false;
  const [pd, pi] = peerKey.split(':'); const peer = net.devices[pd] && net.devices[pd].ifByName[pi];
  return !!peer && !peer.shutdown;
}
function connectedRoutes(net, st, dev) {
  const out = [];
  for (const e of st.endpoints) if (e.dev === dev.name && !e.virtual && e.domain && linkOk(net, dev, dev.ifByName[e.iface])) out.push({ prefix: U.cidrOf(e.ip, e.len), via: null, iface: e.iface, proto: 'C', ad: 0, metric: 0 });
  return out;
}
function staticRoutes(net, st, dev, conn) {
  const out = [];
  for (const r of dev.routes) {
    const p = U.parseCidr(r.prefix); if (!p) continue;
    const prefix = U.cidrOf(p.ip, p.len);
    if (U.isIpv4(r.via)) {
      const c = bestMatch(conn, r.via); if (!c) continue;
      out.push({ prefix, via: r.via, iface: c.iface, proto: 'S', ad: r.ad, metric: 0 });
    } else { const n = U.canonIf(r.via); if (!n || !dev.ifByName[n]) continue; out.push({ prefix, via: null, iface: n, proto: 'S', ad: r.ad, metric: 0 }); }
  }
  return out;
}
// OSPF: 参加 IF、ネイバー、最短の道
function ospfParticipants(net, st) {
  const parts = []; // { dev, iface, ip, len, cost, domain, area }
  for (const dev of Object.values(net.devices)) {
    if (!dev.ospf || !M.routesPackets(dev)) continue;
    for (const e of st.endpoints) {
      if (e.dev !== dev.name || e.virtual) continue;
      const inNet = dev.ospf.networks.some((n) => { const p = U.parseCidr(n); return p && U.inNet(e.ip, p.ip, p.len); });
      if (!inNet) continue;
      parts.push({ dev: dev.name, iface: e.iface, ip: e.ip, len: e.len, cost: dev.ifByName[e.iface].ospfCost || 1, domain: e.domain, area: dev.ospf.area });
    }
  }
  return parts;
}
function ospfNeighbors(net, parts) {
  const nbrs = []; // { a: part, b: part }
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i], b = parts[j];
    if (a.dev === b.dev || !a.domain || a.domain !== b.domain) continue;
    if (a.len !== b.len || !U.inNet(a.ip, b.ip, a.len)) continue;
    const oa = net.devices[a.dev].ospf, ob = net.devices[b.dev].ospf;
    if (String(a.area) !== String(b.area)) continue;
    if ((oa.hello || ob.hello) && oa.hello !== ob.hello) continue;
    if ((oa.dead || ob.dead) && oa.dead !== ob.dead) continue;
    if ((oa.auth || ob.auth) && oa.auth !== ob.auth) continue;
    nbrs.push({ a, b });
  }
  return nbrs;
}
function ospfRoutes(net, st) {
  const parts = ospfParticipants(net, st);
  const nbrs = ospfNeighbors(net, parts);
  st.ospf = { parts, nbrs };
  const routers = [...new Set(parts.map((p) => p.dev))];
  const out = {};
  for (const r of routers) {
    // Dijkstra: dist[dev], first hop(隣の端点)
    const dist = { [r]: 0 }; const first = {}; const done = new Set();
    for (;;) {
      let cur = null; for (const d of routers) if (!done.has(d) && dist[d] !== undefined && (cur === null || dist[d] < dist[cur])) cur = d;
      if (cur === null) break; done.add(cur);
      for (const n of nbrs) for (const [me, other] of [[n.a, n.b], [n.b, n.a]]) {
        if (me.dev !== cur) continue;
        const nd = dist[cur] + me.cost;
        if (dist[other.dev] === undefined || nd < dist[other.dev]) { dist[other.dev] = nd; first[other.dev] = cur === r ? { via: other.ip, iface: me.iface } : first[cur]; }
      }
    }
    const routes = [];
    const own = new Set(parts.filter((p) => p.dev === r).map((p) => U.cidrOf(p.ip, p.len)));
    for (const p of parts) {
      if (p.dev === r || dist[p.dev] === undefined) continue;
      const prefix = U.cidrOf(p.ip, p.len); if (own.has(prefix)) continue;
      routes.push({ prefix, via: first[p.dev].via, iface: first[p.dev].iface, proto: 'O', ad: 110, metric: dist[p.dev] + p.cost });
    }
    // 再配送(static → 外部経路。メトリック 20)
    for (const d of routers) {
      const o = net.devices[d].ospf; if (d === r || dist[d] === undefined || !o.redistribute) continue;
      if (o.redistribute.includes('static')) for (const sr of net.devices[d].routes) { const pc = U.parseCidr(sr.prefix); if (pc) routes.push({ prefix: U.cidrOf(pc.ip, pc.len), via: first[d].via, iface: first[d].iface, proto: 'O', ad: 110, metric: 20, external: true }); }
    }
    out[r] = routes;
  }
  return out;
}
// 同じ宛先は AD の小さい方、次にメトリックの小さい方だけ残す(同じなら両方)
function mergeRoutes(list) {
  const by = {};
  for (const r of list) (by[r.prefix] = by[r.prefix] || []).push(r);
  const out = [];
  for (const rs of Object.values(by)) {
    const minAd = Math.min(...rs.map((r) => r.ad)); const a = rs.filter((r) => r.ad === minAd);
    const minM = Math.min(...a.map((r) => r.metric)); out.push(...a.filter((r) => r.metric === minM));
  }
  return out.sort((x, y) => Number(y.prefix.split('/')[1]) - Number(x.prefix.split('/')[1]) || (x.prefix < y.prefix ? -1 : 1));
}
function computeRoutes(net, st) {
  const routes = {};
  const ospf = ospfRoutes(net, st);
  for (const dev of Object.values(net.devices)) {
    const conn = connectedRoutes(net, st, dev);
    if (M.routesPackets(dev) || dev.kind === 'l3switch') {
      routes[dev.name] = mergeRoutes(conn.concat(staticRoutes(net, st, dev, conn), ospf[dev.name] || []));
    } else {
      const list = conn.slice();
      const lease = st.dhcp && st.dhcp.leases ? st.dhcp.leases[dev.name] : null;
      const gw = (lease && lease.gateway) || dev.gateway; // DHCP でもらったゲートウェイを使う(無ければ手で付けたもの)
      if (gw && conn.length) { const c = bestMatch(conn, gw); if (c) list.push({ prefix: '0.0.0.0/0', via: gw, iface: c.iface, proto: 'S', ad: 1, metric: 0 }); }
      routes[dev.name] = mergeRoutes(list);
    }
  }
  return routes;
}
function bestMatch(routes, ip) {
  let best = null;
  for (const r of routes) { const [n, l] = r.prefix.split('/'); if (U.inNet(ip, n, Number(l)) && (!best || Number(l) > Number(best.prefix.split('/')[1]))) best = r; }
  return best;
}
const lookup = (st, dev, ip) => { const rs = st.routes[dev] || []; const b = bestMatch(rs, ip); return b ? rs.filter((r) => r.prefix === b.prefix) : []; };

// ---------- ARP ----------
function ownersOf(st, ip) { return st.endpoints.filter((e) => e.ip === ip); }
function resolve(st, dev, ifaceName, ip) {
  const self = st.endpoints.find((e) => e.dev === dev && e.iface === ifaceName && !e.virtual);
  const domain = self ? self.domain : null;
  if (!domain) return { kind: 'arp', detail: `${dev} の ${ifaceName} がどこにもつながっていない` };
  const cands = st.endpoints.filter((e) => e.domain === domain && e.ip === ip && e.dev !== dev);
  if (!cands.length) {
    const elsewhere = st.endpoints.find((e) => e.ip === ip && e.dev !== dev);
    return { kind: 'arp', detail: elsewhere ? `${ip} は同じ VLAN・網にいない(${elsewhere.dev} にあるが、${dev} の ${ifaceName} からは届かない)` : `${ip} という機器がいない(ARP に答えがない)` };
  }
  const real = cands.filter((e) => !e.virtual);
  if (real.length > 1) return { kind: 'dup', detail: `${ip} を ${real.map((e) => e.dev).join('・')} が同時に持っている(重複)` };
  return { kind: 'ok', ep: cands.find((e) => e.virtual) || cands[0] };
}
function arpTables(net, st) {
  const t = {};
  for (const dev of Object.values(net.devices)) {
    const rows = [];
    for (const e of st.endpoints) {
      if (e.dev !== dev.name || e.virtual || !e.domain) continue;
      for (const o of st.endpoints) if (o.domain === e.domain && o.dev !== dev.name && !o.virtual && o.len === e.len && U.inNet(o.ip, e.ip, e.len)) rows.push({ ip: o.ip, mac: o.mac, iface: e.iface });
    }
    t[dev.name] = rows;
  }
  return t;
}

// ---------- ACL ----------
const wildToLen = (w) => { const n = U.ipToInt(w); let l = 32; while (l > 0 && (n & (1 << (32 - l))) >>> 0) l--; return l; };
function matchAddr(spec, ip) {
  if (!spec || spec === 'any') return true;
  const m = /^host (\S+)$/.exec(spec); if (m) return m[1] === ip;
  const p = U.parseCidr(spec); if (p) return U.inNet(ip, p.ip, p.len);
  return spec === ip;
}
function aclMatch(acl, pkt) {
  for (const l of acl.lines) {
    if (acl.type === 'standard') { if (matchAddr(l.src, pkt.src)) return l; continue; }
    if (!(l.proto === 'ip' || l.proto === pkt.proto)) continue;
    if (!matchAddr(l.src, pkt.src) || !matchAddr(l.dst, pkt.dst)) continue;
    if (l.dport !== null && l.proto !== 'ip' && l.dport !== pkt.dport) continue;
    return l;
  }
  return null;
}
const aclPermits = (acl, pkt) => { const l = aclMatch(acl, pkt); return { ok: !!l && l.action === 'permit', line: l }; };

// ---------- パケットの旅 ----------
// 外の網は、自分の網のうち、ほかの機器が持っていないアドレス全部を持っていることにする
const PRIVATE_SUBNET_OWN = (dev, st, ip) => dev.kind === 'internet' && !st.endpoints.some((e) => e.ip === ip && e.dev !== dev.name) && st.endpoints.some((e) => e.dev === dev.name && U.inNet(ip, e.ip, e.len));
function owns(st, dev, ip) { return st.endpoints.some((e) => e.dev === dev.name && e.ip === ip && (!e.virtual || e.master === dev.name)) || PRIVATE_SUBNET_OWN(dev, st, ip); }
const listens = (dev, proto, port) => dev.listenAll || proto === 'icmp' || dev.listen.some((l) => l.proto === proto && l.port === port);
const zoneOf = (dev, ifName) => Object.keys(dev.zones).find((z) => dev.zones[z].includes(ifName)) || null;

function newCtx() { return { nat: {}, fw: {}, cloudNat: [] }; }

// 1 方向の旅。返す: { delivered, path, hops, stoppedAt, reason, detail, pkt(届いたときの中身), dstDev }
function walk(net, st, startDev, pkt0, ctx) {
  const pkt = { ...pkt0 };
  const path = [startDev]; const hopsOut = [];
  let cur = startDev, inIf = null, hops = 0; const seen = new Set();
  const stop = (reason, detail) => ({ delivered: false, path, hops: hopsOut, stoppedAt: cur, reason, detail: detail || '', pkt });
  for (;;) {
    const dev = net.devices[cur];
    if (!dev) return stop('no-device');
    const originating = cur === startDev && inIf === null;
    // クラウドのサブネットに外(INET)から入る
    if (!originating && dev.kind === 'cloud-subnet' && inIf === '(cloud)') { /* 下で扱う */ }
    if (!originating && !M.routesPackets(dev) && owns(st, dev, pkt.dst)) { // ルーターは ACL と NAT のあとで見る(下)
      const open = listens(dev, pkt.proto, pkt.dport);
      return { delivered: true, open, path, hops: hopsOut, stoppedAt: cur, reason: open ? null : 'closed', detail: open ? '' : `${cur} はそのポート(${pkt.proto} ${pkt.dport})で待ち受けていない`, pkt, dstDev: cur };
    }
    let outIf = null, nh = null;
    if (!M.routesPackets(dev)) {
      if (!originating) return stop('not-for-me', `${cur} は自分宛でないパケットを転送しない`);
      const self = st.endpoints.find((e) => e.dev === cur && !e.virtual);
      if (!self) return stop('no-ip', `${cur} にアドレスが無い`);
      if (!pkt.src) pkt.src = self.ip;
      if (dev.kind === 'internet') { // 外の網からクラウドのサブネットへ
        const sub = Object.values(net.devices).find((d) => d.kind === 'cloud-subnet' && d.cidr && U.inNet(pkt.dst, ...d.cidr.split('/').map((x, i) => (i ? Number(x) : x))));
        if (sub) { const r = cloudInbound(net, st, sub, pkt, ctx); if (!r.ok) return stop(r.reason, r.detail); path.push(sub.name); cur = sub.name; inIf = '(cloud)'; continue; }
      }
      if (owns(st, dev, pkt.dst)) return { delivered: true, open: true, path, hops: hopsOut, stoppedAt: cur, reason: null, detail: '', pkt, dstDev: cur };
      const rs = lookup(st, cur, pkt.dst);
      if (!rs.length) return stop('no-gateway', `${cur} に ${pkt.dst} への道(デフォルトゲートウェイ)が無い`);
      outIf = rs[0].iface; nh = rs[0].via || pkt.dst;
    } else {
      const inIface = inIf && inIf !== '(cloud)' ? dev.ifByName[inIf] : null;
      if (inIface) {
        if (inIface.aclIn && dev.acls[inIface.aclIn]) { const r = aclPermits(dev.acls[inIface.aclIn], pkt); if (!r.ok) return stop('acl-in', `${cur} の ${inIf} の受信 ACL ${inIface.aclIn} ${r.line ? `${r.line.seq} 行` : '暗黙の拒否'}で捨てた`); }
        if (inIface.natSide === 'outside') natInbound(dev, pkt, ctx);
      }
      if (!originating && owns(st, dev, pkt.dst)) { const open = listens(dev, pkt.proto, pkt.dport); return { delivered: true, open, path, hops: hopsOut, stoppedAt: cur, reason: open ? null : 'closed', detail: open ? '' : `${cur} は ${pkt.proto} ${pkt.dport} で待ち受けていない`, pkt, dstDev: cur }; }
      if (inIface) { pkt.ttl -= 1; if (pkt.ttl <= 0) return stop('ttl', `${cur} で TTL が 0 になった`); }
      if (dev.kind === 'cloud-subnet') {
        const r = cloudForward(net, st, dev, pkt, ctx, originating || inIf === '(cloud)');
        if (!r.ok) return stop(r.reason, r.detail);
        if (r.deliverTo) { path.push(r.deliverTo); cur = r.deliverTo; inIf = r.inIf || '(cloud)'; if (r.cloudHop) continue; continue; }
        outIf = r.outIf; nh = r.nh;
      } else {
        const rs = lookup(st, cur, pkt.dst);
        if (!rs.length) return stop('no-route', `${cur} の経路表に ${pkt.dst} に合う行が無い`);
        outIf = rs[0].iface; nh = rs[0].via || pkt.dst;
        if (originating) { const self = st.endpoints.find((e) => e.dev === cur && e.iface === outIf && !e.virtual); if (!pkt.src && self) pkt.src = self.ip; }
        const outIface = dev.ifByName[outIf];
        const inSideOk = originating || (inIface && inIface.natSide === 'inside');
        if (outIface.natSide === 'outside' && inSideOk) natOutbound(dev, outIface, st, pkt, ctx);
        if (dev.kind === 'firewall' && inIface) {
          const fz = zoneOf(dev, inIf), tz = zoneOf(dev, outIf);
          const sess = (ctx.fw[cur] = ctx.fw[cur] || []);
          const back = sess.find((s) => s.proto === pkt.proto && s.src === pkt.dst && s.dst === pkt.src && s.sport === pkt.dport && s.dport === pkt.sport);
          if (!back) {
            const pol = dev.policies.find((p) => p.from === fz && p.to === tz && (p.proto === 'ip' || p.proto === pkt.proto) && (p.dport === null || p.dport === pkt.dport));
            if (!pol || pol.action !== 'permit') return stop('fw-policy', `${cur} のポリシー(${fz || '?'} → ${tz || '?'})で捨てた`);
            sess.push({ proto: pkt.proto, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport });
          }
        }
        if (outIface.aclOut && dev.acls[outIface.aclOut]) { const r = aclPermits(dev.acls[outIface.aclOut], pkt); if (!r.ok) return stop('acl-out', `${cur} の ${outIf} の送信 ACL ${outIface.aclOut} ${r.line ? `${r.line.seq} 行` : '暗黙の拒否'}で捨てた`); }
      }
    }
    // ARP → 次の機器
    const res = resolve(st, cur, outIf, nh);
    if (res.kind !== 'ok') return stop(res.kind, res.detail);
    const key = `${cur}|${outIf}|${pkt.dst}`; if (seen.has(key)) return stop('loop', `${cur} から同じ道を 2 度通った(経路の輪)`); seen.add(key);
    hops += 1; if (hops > 32) return stop('loop', '32 ホップを超えた(経路の輪)');
    const nextDev = res.ep.virtual ? res.ep.master : res.ep.dev;
    const epKey = res.ep.virtual ? U.ifKey(res.ep.master, res.ep.masterIface) : res.ep.key;
    const sws = (L2.l2path(net, st.l2, L2.keyOf(net, dev, dev.ifByName[outIf]), epKey) || []).filter((s) => s !== cur && s !== nextDev);
    for (const s of sws) if (path[path.length - 1] !== s) path.push(s);
    path.push(nextDev);
    const nextIface = res.ep.virtual ? res.ep.masterIface : res.ep.iface;
    const arrivedIp = st.endpoints.find((e) => e.dev === nextDev && e.iface === nextIface && !e.virtual);
    if (M.routesPackets(net.devices[nextDev]) && !owns(st, net.devices[nextDev], pkt.dst)) hopsOut.push({ n: hopsOut.length + 1, ip: arrivedIp ? arrivedIp.ip : nh, device: nextDev });
    cur = nextDev; inIf = nextIface;
  }
}
// NAT(外側 IF で受けたパケット): 静的の宛先の書き換え、NAPT の返りの戻し
function natInbound(dev, pkt, ctx) {
  const s = dev.nat.static.find((x) => x.proto === pkt.proto && x.outsideIp === pkt.dst && (x.outsidePort === null || x.outsidePort === pkt.dport));
  if (s) { pkt.dst = s.insideIp; if (s.insidePort !== null && s.outsidePort !== null) pkt.dport = s.insidePort; pkt.natIn = `${dev.name}:static`; return; }
  const tab = ctx.nat[dev.name] || [];
  const e = tab.find((x) => x.proto === pkt.proto && x.outIp === pkt.dst && x.outPort === pkt.dport);
  if (e) { pkt.dst = e.inIp; pkt.dport = e.inPort; pkt.natIn = `${dev.name}:napt`; }
}
// NAT(内側から外側へ出るパケット): 静的の送信元の書き換え、NAPT
function natOutbound(dev, outIface, st, pkt, ctx) {
  const s = dev.nat.static.find((x) => x.proto === pkt.proto && x.insideIp === pkt.src && (x.insidePort === null || x.insidePort === pkt.sport));
  if (s) { pkt.src = s.outsideIp; if (s.insidePort !== null && s.outsidePort !== null) pkt.sport = s.outsidePort; pkt.natOut = `${dev.name}:static`; return; }
  const rule = dev.nat.source.find((r) => { const p = U.parseCidr(r.src); return p && U.inNet(pkt.src, p.ip, p.len) && r.iface === outIface.name; });
  if (!rule) return;
  const out = effIp(st, dev, outIface).ip; if (!out) return;
  const tab = (ctx.nat[dev.name] = ctx.nat[dev.name] || []);
  let port = pkt.sport || 0;
  while (tab.some((x) => x.proto === pkt.proto && x.outIp === out && x.outPort === port && !(x.inIp === pkt.src && x.inPort === pkt.sport))) port += 1;
  if (!tab.some((x) => x.inIp === pkt.src && x.inPort === pkt.sport && x.proto === pkt.proto)) tab.push({ proto: pkt.proto, inIp: pkt.src, inPort: pkt.sport, outIp: out, outPort: port });
  pkt.src = out; pkt.sport = port; pkt.natOut = `${dev.name}:napt`;
}
// クラウドのサブネット(ゲートウェイ役)からの転送
function cloudForward(net, st, sub, pkt, ctx, fromInside) {
  const inLocal = U.inNet(pkt.dst, ...sub.cidr.split('/').map((x, i) => (i ? Number(x) : x)));
  if (inLocal) { const gw = sub.ifByName.Vlan1; return { ok: true, outIf: gw.name, nh: pkt.dst }; }
  let best = null;
  for (const r of sub.routeTable) { const p = U.parseCidr(r.prefix); if (p && U.inNet(pkt.dst, p.ip, p.len) && (!best || p.len > best.len)) best = { ...r, len: p.len }; }
  if (!best) return { ok: false, reason: 'no-route', detail: `${sub.name} の経路表に ${pkt.dst} に合う行が無い` };
  const target = String(best.target);
  if (target === 'local' || target.startsWith('peer:')) {
    const other = Object.values(net.devices).find((d) => d.kind === 'cloud-subnet' && d !== sub && U.inNet(pkt.dst, ...d.cidr.split('/').map((x, i) => (i ? Number(x) : x))));
    if (!other) return { ok: false, reason: 'no-route', detail: `${pkt.dst} のサブネットが無い` };
    if (target.startsWith('peer:') && !(target.slice(5) === other.name || (other.peerGroup && target.slice(5) === other.peerGroup))) return { ok: false, reason: 'no-route', detail: `ピアリングの行き先 ${target.slice(5)} に ${other.name} は含まれない` };
    return { ok: true, deliverTo: other.name, inIf: '(cloud)', cloudHop: true };
  }
  const inet = Object.values(net.devices).find((d) => d.kind === 'internet');
  if (target === 'igw' || target === 'natgw') {
    if (!inet) return { ok: false, reason: 'no-route', detail: '外の網が無い' };
    if (target === 'natgw') ctx.cloudNat.push({ sub: sub.name, src: pkt.src, dst: pkt.dst, proto: pkt.proto, sport: pkt.sport, dport: pkt.dport });
    pkt.cloudOut = target;
    return { ok: true, deliverTo: inet.name, inIf: 'Eth0' };
  }
  return { ok: false, reason: 'no-route', detail: `行き先 ${target} が読めない` };
}
// 外からクラウドのサブネットへ入れるか
function cloudInbound(net, st, sub, pkt, ctx) {
  const def = sub.routeTable.map((r) => ({ ...r, p: U.parseCidr(r.prefix) })).filter((r) => r.p && U.inNet(pkt.src, r.p.ip, r.p.len)).sort((a, b) => b.p.len - a.p.len)[0];
  if (def && def.target === 'igw') return { ok: true };
  const back = ctx.cloudNat.find((s) => s.sub === sub.name && s.dst === pkt.src && s.src === pkt.dst && s.proto === pkt.proto && s.dport === pkt.sport && s.sport === pkt.dport);
  if (back) return { ok: true };
  return { ok: false, reason: def && def.target === 'natgw' ? 'natgw' : 'no-igw', detail: def && def.target === 'natgw' ? `${sub.name} は NAT ゲートウェイ経由(非公開)なので、外から始める通信は入れない` : `${sub.name} はインターネットゲートウェイへの経路が無く、外から入れない` };
}

// 届くか(往復)。opts: { proto, port, roundTrip, toIp, sport }
function reach(net, st, from, to, opts = {}) {
  const ctx = newCtx();
  const proto = opts.proto || 'icmp';
  const fromDev = net.devices[from]; if (!fromDev) return { ok: false, reason: 'no-device', detail: `${from} が無い`, path: [] };
  let dstIp = opts.toIp || null;
  if (!dstIp) { const td = net.devices[to]; if (!td) return { ok: false, reason: 'no-device', detail: `${to} が無い`, path: [from] }; const e = st.endpoints.find((x) => x.dev === to && !x.virtual); if (!e) return { ok: false, reason: 'no-ip', detail: `${to} にアドレスが無い`, path: [from] }; dstIp = e.ip; }
  const pkt = { src: null, dst: dstIp, proto, sport: opts.sport || 50000 + (U.hash32(`${from}${to}`) % 10000), dport: proto === 'icmp' ? 0 : (opts.port || 80), ttl: fromDev.ttl || 64 };
  const go = walk(net, st, from, pkt, ctx);
  const out = { ok: false, path: go.path, hops: go.hops, stoppedAt: go.stoppedAt, reason: go.reason, detail: go.detail, dstIp, back: null };
  if (!go.delivered) return out;
  if (!go.open) { out.reason = 'closed'; out.detail = go.detail; return out; }
  if (opts.roundTrip === false) { out.ok = true; return out; }
  const dstDev = net.devices[go.dstDev];
  const back = walk(net, st, go.dstDev, { src: go.pkt.dst, dst: go.pkt.src, proto, sport: go.pkt.dport, dport: go.pkt.sport, ttl: dstDev.ttl || 64 }, ctx);
  out.back = { path: back.path, stoppedAt: back.stoppedAt, reason: back.reason, detail: back.detail };
  if (!back.delivered || back.dstDev !== from) { out.reason = `back:${back.reason || 'wrong-device'}`; out.detail = back.detail || `返りが ${back.dstDev || back.stoppedAt} に届いた(${from} ではない)`; out.stoppedAt = back.stoppedAt; return out; }
  out.ok = true; out.nat = ctx.nat;
  return out;
}
function trace(net, st, from, toIp) {
  const ctx = newCtx();
  const fromDev = net.devices[from]; if (!fromDev) return { hops: [], reached: false, reason: 'no-device' };
  const go = walk(net, st, from, { src: null, dst: toIp, proto: 'icmp', sport: 0, dport: 0, ttl: 64 }, ctx);
  const hops = go.hops.slice();
  if (go.delivered) hops.push({ n: hops.length + 1, ip: toIp, device: go.dstDev });
  // 各ホップの返事(時間超過・応答)が送り元まで戻れるか。戻れないホップは * になる
  const srcIp = go.pkt.src;
  for (const h of hops) {
    const back = srcIp ? walk(net, st, h.device, { src: h.ip, dst: srcIp, proto: 'icmp', sport: 0, dport: 0, ttl: 64 }, newCtx()) : { delivered: false };
    h.reply = !!back.delivered && back.dstDev === from;
    if (!h.reply) h.replyReason = back.reason || 'no-src';
  }
  const last = hops[hops.length - 1];
  const reached = go.delivered && !!last && last.reply;
  return { hops, reached, reason: go.delivered && !reached ? `back:${last.replyReason}` : go.reason, detail: go.detail, path: go.path, stoppedAt: go.stoppedAt };
}

module.exports = { AD, buildEndpoints, computeRoutes, lookup, bestMatch, resolve, arpTables, aclMatch, aclPermits, matchAddr, reach, trace, walk, newCtx, owns, listens, effIp, ospfParticipants };
