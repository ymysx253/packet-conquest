'use strict';
// サービスの模擬: DHCP(配る範囲・除外・リレー)、VRRP(代表)、要件の確かめ(docs/questions/SIM-API.md 第 3・4 章)。
// 決めたこと:
//   - DHCP のサーバー探し: ホストと同じドメインに DHCP の範囲を持つ機器の IF があればそれ。無ければ、同じドメインのルーター IF の dhcpRelay の先(そのアドレスを持つ機器)。範囲は受けた IF の網で選ぶ
//   - 配る順はホスト名の順。範囲の先頭から、除外とゲートウェイを飛ばす。配れる数 = 範囲の中(網とブロードキャストを除く) − 除外 − ゲートウェイ
//   - VRRP の仮想 MAC は 00:00:5e:00:01:<グループ>(RFC 5798 の決まり)
const U = require('./util');
const M = require('./model');
const L2 = require('./l2');

function rangeIps(network) {
  const p = U.parseCidr(network); if (!p) return null;
  const net = U.netOf(U.ipToInt(p.ip), p.len), size = U.sizeOf(p.len);
  return { first: net + 1, last: net + size - 2, len: p.len, net };
}
const inRanges = (n, ranges) => ranges.some(([a, b]) => n >= U.ipToInt(a) && n <= U.ipToInt(b || a));

function computeDhcp(net, l2) {
  const leases = {}; const pools = {};
  const servers = Object.values(net.devices).filter((d) => d.dhcp.pools.length);
  const bind = {}; // server|pool → [ips]
  for (const srv of servers) {
    pools[srv.name] = srv.dhcp.pools.map((p) => {
      const r = rangeIps(p.network || '');
      const cands = [];
      if (r) for (let n = r.first; n <= r.last; n++) { const ip = U.intToIp(n); if (inRanges(n, p.exclude) || inRanges(n, srv.dhcp.exclude) || ip === p.gateway) continue; cands.push(ip); }
      return { name: p.name, network: p.network, gateway: p.gateway, dns: p.dns, cands, free: cands.length, first: cands[0] || null, bindings: [] };
    });
  }
  const clients = Object.values(net.devices).filter((d) => d.dhcpClient && M.HOST_KINDS.has(d.kind)).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const host of clients) {
    const key = U.ifKey(host.name, 'Eth0'); const did = l2.domainOf[key];
    if (!did) continue;
    const members = l2.domains.find((d) => d.id === did).members;
    let srv = null, viaIp = null;
    for (const s of servers) for (const ifc of s.ifaces) if (ifc.ip && members.includes(L2.keyOf(net, s, ifc))) { srv = s; viaIp = ifc.ip; break; }
    if (!srv) {
      for (const dev of Object.values(net.devices)) for (const ifc of dev.ifaces) {
        if (!ifc.dhcpRelay || !ifc.ip || !members.includes(L2.keyOf(net, dev, ifc))) continue;
        const target = servers.find((s) => s.ifaces.some((f) => f.ip === ifc.dhcpRelay));
        if (target) { srv = target; viaIp = ifc.ip; break; }
      }
    }
    if (!srv) continue;
    const pool = pools[srv.name].find((p) => { const r = rangeIps(p.network || ''); return r && U.inNet(viaIp, U.intToIp(r.net), r.len); });
    if (!pool) continue;
    const ip = pool.cands.find((c) => !pool.bindings.some((b) => b.ip === c));
    if (!ip) continue;
    const r = rangeIps(pool.network);
    pool.bindings.push({ ip, host: host.name, mac: host.ifaces[0].mac });
    pool.free = pool.cands.length - pool.bindings.length;
    leases[host.name] = { ip, len: r.len, gateway: pool.gateway, dns: pool.dns, server: srv.name, pool: pool.name };
  }
  for (const list of Object.values(pools)) for (const p of list) delete p.cands;
  return { leases, pools };
}

// VRRP の代表(down の機器は止まっているとみなす)。仮想の端点を st.endpoints に足す
function computeVrrp(net, st, down = []) {
  const groups = {};
  for (const dev of Object.values(net.devices)) {
    if (down.includes(dev.name)) continue;
    for (const ifc of dev.ifaces) {
      if (ifc.shutdown || !ifc.vrrp.length) continue;
      const ep = st.endpoints.find((e) => e.dev === dev.name && e.iface === ifc.name && !e.virtual);
      if (!ep || !ep.domain) continue;
      for (const v of ifc.vrrp) {
        if (!v.vip) continue;
        const k = `${ep.domain}|${v.group}`;
        (groups[k] = groups[k] || { group: v.group, vip: v.vip, domain: ep.domain, len: ep.len, members: [] }).members.push({ dev: dev.name, iface: ifc.name, ip: ep.ip, priority: ep.ip === v.vip ? 255 : v.priority, preempt: v.preempt });
      }
    }
  }
  const out = [];
  for (const g of Object.values(groups)) {
    const sorted = g.members.slice().sort((a, b) => b.priority - a.priority || U.ipToInt(b.ip) - U.ipToInt(a.ip));
    const master = sorted[0];
    out.push({ group: g.group, vip: g.vip, domain: g.domain, master: master.dev, masterIface: master.iface, backup: sorted[1] ? sorted[1].dev : null, members: sorted });
    st.endpoints.push({ key: `${master.dev}:${master.iface}#vrrp${g.group}`, dev: master.dev, iface: master.iface, ip: g.vip, len: g.len, mac: `00:00:5e:00:01:${g.group.toString(16).padStart(2, '0')}`, domain: g.domain, virtual: true, master: master.dev, masterIface: master.iface });
  }
  return out;
}

// 要件の確かめ。helpers: { reach(from, to, opts), stateWith({ down, cut }) → st, net }
function check(net, st, reqs, helpers) {
  const out = [];
  for (const r of reqs || []) {
    let ok = false, detail = '';
    try {
      switch (r.kind) {
        case 'reach': {
          const res = helpers.reach(r.from, r.to, { proto: r.proto || 'icmp', port: r.port, roundTrip: r.roundTrip !== false, toIp: r.toIp });
          const expect = r.expect !== false;
          ok = res.ok === expect; detail = res.ok ? `${r.from} → ${r.to}: 届く(${res.path.join(' → ')})` : `${r.from} → ${r.to}: 届かない(${res.reason}: ${res.detail})`;
          break;
        }
        case 'route': {
          const p = U.parseCidr(r.prefix); const prefix = p ? U.cidrOf(p.ip, p.len) : r.prefix;
          const rows = (st.routes[r.device] || []).filter((x) => x.prefix === prefix);
          const hit = rows.find((x) => (r.via === undefined || x.via === r.via) && (r.iface === undefined || x.iface === U.canonIf(r.iface)) && (r.proto === undefined || x.proto === r.proto));
          ok = !!hit; detail = hit ? `${r.device}: ${prefix} → ${hit.via || hit.iface}` : `${r.device}: ${prefix} の行が${rows.length ? '違う' : '無い'}`;
          break;
        }
        case 'lease': {
          if (r.host) { const l = st.dhcp.leases[r.host]; ok = !!l && (r.ip === undefined || l.ip === r.ip) && (r.gateway === undefined || l.gateway === r.gateway); detail = l ? `${r.host} は ${l.ip}(ゲートウェイ ${l.gateway})をもらう` : `${r.host} はアドレスをもらえない`; }
          else { const pool = (st.dhcp.pools[r.device] || []).find((p) => p.name === r.pool); ok = !!pool && (r.count === undefined || pool.free + pool.bindings.length === r.count); detail = pool ? `${r.pool}: 配れる数 ${pool.free + pool.bindings.length}` : `${r.pool} が無い`; }
          break;
        }
        case 'master': {
          const s2 = r.down && r.down.length ? helpers.stateWith({ down: r.down }) : st;
          const g = s2.vrrp.find((x) => x.vip === r.vip);
          ok = !!g && g.master === r.device; detail = g ? `${r.vip} の代表は ${g.master}` : `${r.vip} の VRRP が無い`;
          break;
        }
        case 'failover': {
          const s2 = helpers.stateWith({ cut: r.cut || [], down: r.down || [] });
          const sub = check(s2.net, s2, [{ ...r.then, id: r.id }], { ...helpers, reach: (f, t, o) => helpers.reachIn(s2, f, t, o), stateWith: helpers.stateWith })[0];
          ok = sub.ok; detail = `切ったあと: ${sub.detail}`;
          break;
        }
        case 'vlan': {
          const dev = net.devices[r.device]; const ifc = dev && dev.ifByName[U.canonIf(r.port)];
          ok = !!ifc && (ifc.mode || 'access') === 'access' && (ifc.vlan || 1) === Number(r.vlan) && dev.vlans.has(Number(r.vlan)) && !ifc.shutdown;
          detail = ifc ? `${r.device} ${ifc.name}: ${ifc.mode || 'access'} VLAN ${ifc.vlan || 1}${dev.vlans.has(Number(r.vlan)) ? '' : '(VLAN が無い)'}` : `${r.device} に ${r.port} が無い`;
          break;
        }
        case 'trunk': {
          const dev = net.devices[r.device]; const ifc = dev && dev.ifByName[U.canonIf(r.port)];
          const carries = (v) => !!ifc && ifc.mode === 'trunk' && (ifc.allowed ? ifc.allowed.has(Number(v)) : true) && dev.vlans.has(Number(v));
          ok = !!ifc && ifc.mode === 'trunk' && (r.allowed || []).every(carries) && (r.native === undefined || ifc.native === Number(r.native)) && !ifc.shutdown;
          detail = ifc ? `${r.device} ${ifc.name}: ${ifc.mode}${ifc.allowed ? ` 許可 ${[...ifc.allowed].join(',')}` : ''}` : `${r.device} に ${r.port} が無い`;
          break;
        }
        case 'path': {
          const res = helpers.reach(r.from, r.to, { proto: r.proto || 'icmp', port: r.port, roundTrip: false });
          const got = res.path.slice(1, -1).filter((n) => r.via.includes(n) || !L2.isBridge(net.devices[n]));
          ok = res.ok && got.length === r.via.length && got.every((n, i) => n === r.via[i]);
          detail = res.ok ? `通る順 ${res.path.join(' → ')}` : `届かない(${res.reason})`;
          break;
        }
        case 'state': {
          let v = net.devices[r.device]; for (const k of String(r.path).split('.')) v = v === undefined || v === null ? undefined : v[k];
          ok = v === r.equals; detail = `${r.device}.${r.path} = ${JSON.stringify(v)}`;
          break;
        }
        default: detail = `知らない要件 ${r.kind}`;
      }
    } catch (e) { ok = false; detail = `確かめられない: ${e.message}`; }
    out.push({ id: r.id, ok, detail });
  }
  return out;
}

module.exports = { computeDhcp, computeVrrp, check, rangeIps };
