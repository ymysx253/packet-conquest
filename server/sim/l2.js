'use strict';
// L2 の模擬: LACP の束、STP(根と止まるポート)、VLAN の範囲(ブロードキャストドメイン)、MAC アドレス表(docs/questions/SIM-API.md 第 3 章)。
// 決めたこと:
//   - 端点の鍵: ルーター・ホストの IF は 'R1:Gi0/0'、副 IF は 'R1:Gi0/0.10'、スイッチの VLAN(と SVI)は 'SW1#vlan10'。同じドメイン = 同じ鍵の集まり(union-find)
//   - アクセスポートの VLAN がそのスイッチに無ければ、そのポートは何も通さない。トランクのタグ付き VLAN は両側のスイッチに有ることが要る
//   - トランクどうしでネイティブ VLAN が違うと、その 2 つの VLAN がつながる(現実と同じ。問題では「食い違い」として使える)
//   - STP は全 VLAN 共通の 1 本(論理の線ごと。束は 1 本に数える)。ブリッジ ID = 優先度 + いちばん小さい MAC。線のコストは全部 4
//   - クラウドのサブネットは VLAN 1 のスイッチとして扱う(STP には入れない)
const U = require('./util');
const M = require('./model');

const isBridge = (dev) => dev.kind === 'switch' || dev.kind === 'l3switch' || dev.kind === 'cloud-subnet';
const vkey = (sw, v) => `${sw}#vlan${v}`;
const portActive = (net, dev, ifc) => !ifc.shutdown && !ifc.parent && !ifc.vlanId && M.linkUp(net, dev.name, ifc.name) && !!net.peer[U.ifKey(dev.name, ifc.name)];

// 端点の種類: スイッチのポート(swport)か、L3 の口(l3。副 IF の一覧つき)
function classify(net, dev, ifc) {
  if (isBridge(dev)) return { type: 'swport', dev, ifc, mode: ifc.mode || 'access', vlan: ifc.vlan || 1, allowed: ifc.allowed, native: ifc.native || 1 };
  const subs = dev.ifaces.filter((s) => s.parent === ifc.name && !s.shutdown).map((s) => ({ tag: s.tag, key: U.ifKey(dev.name, s.name) }));
  return { type: 'l3', dev, ifc, key: U.ifKey(dev.name, ifc.name), subs };
}
const trunkCarries = (e, t) => (e.allowed ? e.allowed.has(t) : true) && e.dev.vlans.has(t);
const accessOk = (e) => e.dev.vlans.has(e.vlan);

// LACP: スイッチごとの channel-group → 束になるか(254 と同じ規則: 両側に束の設定があり、少なくとも片方が active。on どうしも束)
function computeLag(net) {
  const lag = {}; const bundledPort = {}; // ifKey → 'sw:lag:id'
  for (const dev of Object.values(net.devices)) {
    if (!isBridge(dev)) continue;
    const groups = {};
    for (const ifc of dev.ifaces) if (ifc.channelGroup && portActive(net, dev, ifc)) (groups[ifc.channelGroup.id] = groups[ifc.channelGroup.id] || []).push(ifc);
    for (const [gid, ports] of Object.entries(groups)) {
      const peers = ports.map((p) => { const q = M.peerOf(net, dev.name, p.name); const pd = net.devices[q.dev]; const pi = pd.ifByName[q.iface]; return { q, pd, pi }; });
      const sameDev = peers.every((x) => x.pd.name === peers[0].pd.name);
      const ok = sameDev && peers.every(({ pi }) => pi.channelGroup && pi.channelGroup.id === peers[0].pi.channelGroup.id) && ports.every((p, i) => {
        const a = p.channelGroup.mode, b = peers[i].pi.channelGroup.mode;
        return (a === 'on' && b === 'on') || ((a === 'active' || a === 'passive') && (b === 'active' || b === 'passive') && (a === 'active' || b === 'active'));
      });
      lag[dev.name] = lag[dev.name] || {};
      lag[dev.name][gid] = { members: ports.map((p) => p.name), up: ok, peer: sameDev ? peers[0].pd.name : null };
      if (ok) for (const p of ports) bundledPort[U.ifKey(dev.name, p.name)] = `${dev.name}:lag:${gid}`;
    }
  }
  return { lag, bundledPort };
}

// 論理の線(スイッチどうし。束は 1 本): [{ id, a: { sw, ports }, b: { sw, ports } }]
function logicalLinks(net, bundledPort) {
  const out = []; const seen = new Set();
  for (const dev of Object.values(net.devices)) {
    if (!isBridge(dev) || dev.kind === 'cloud-subnet') continue;
    for (const ifc of dev.ifaces) {
      if (!portActive(net, dev, ifc)) continue;
      const q = M.peerOf(net, dev.name, ifc.name); const pd = net.devices[q.dev];
      if (!isBridge(pd) || pd.kind === 'cloud-subnet' || pd.ifByName[q.iface].shutdown) continue;
      const ka = bundledPort[U.ifKey(dev.name, ifc.name)] || U.ifKey(dev.name, ifc.name);
      const kb = bundledPort[U.ifKey(q.dev, q.iface)] || U.ifKey(q.dev, q.iface);
      const id = [ka, kb].sort().join('|'); if (seen.has(id)) continue; seen.add(id);
      const portsOf = (k, d, p) => (k.includes(':lag:') ? Object.values(d.ifByName).filter((x) => x.channelGroup && `${d.name}:lag:${x.channelGroup.id}` === k).map((x) => x.name) : [p]);
      out.push({ id, a: { sw: dev.name, ports: portsOf(ka, dev, ifc.name), key: ka }, b: { sw: q.dev, ports: portsOf(kb, pd, q.iface), key: kb } });
    }
  }
  return out;
}

// STP: 根・ルートポート・指定ポート・代替ポート。返す: { root, bridges: { sw: { bid, cost, ports: { port: role } } }, blocked: Set(ifKey) }
function computeStp(net, links) {
  const bridges = Object.values(net.devices).filter((d) => isBridge(d) && d.kind !== 'cloud-subnet');
  const macOf = (d) => d.ifaces.filter((i) => i.mac).map((i) => i.mac).sort()[0] || '02:00:00:00:00:00';
  const bid = {}; for (const d of bridges) bid[d.name] = `${String(d.stpPriority).padStart(5, '0')}.${macOf(d)}`;
  const res = { root: null, bridges: {}, blocked: new Set() };
  if (!bridges.length) return res;
  const root = bridges.map((d) => d.name).sort((a, b) => (bid[a] < bid[b] ? -1 : 1))[0];
  res.root = root;
  // 根からのコスト(Dijkstra。コストは全部 4)
  const cost = {}; for (const d of bridges) cost[d.name] = Infinity; cost[root] = 0;
  const done = new Set();
  for (;;) {
    let cur = null; for (const d of bridges) if (!done.has(d.name) && cost[d.name] < Infinity && (cur === null || cost[d.name] < cost[cur] || (cost[d.name] === cost[cur] && bid[d.name] < bid[cur]))) cur = d.name;
    if (cur === null) break; done.add(cur);
    for (const l of links) for (const [me, other] of [[l.a, l.b], [l.b, l.a]]) if (me.sw === cur && cost[cur] + 4 < cost[other.sw]) cost[other.sw] = cost[cur] + 4;
  }
  for (const d of bridges) res.bridges[d.name] = { bid: bid[d.name], cost: cost[d.name], ports: {} };
  const minPort = (ports) => ports.slice().sort()[0];
  // ルートポート: (相手の根コスト + 4, 相手のブリッジ ID, 相手のポート名) がいちばん小さい線
  const rootLink = {};
  for (const d of bridges) {
    if (d.name === root) continue;
    let best = null;
    for (const l of links) for (const [me, other] of [[l.a, l.b], [l.b, l.a]]) {
      if (me.sw !== d.name || cost[other.sw] === Infinity) continue;
      const k = [cost[other.sw] + 4, bid[other.sw], minPort(other.ports), minPort(me.ports)];
      if (!best || k.join('|') < best.k.join('|') || (k[0] < best.k[0])) best = { k, l, me };
    }
    if (best) rootLink[d.name] = best;
  }
  for (const l of links) {
    const ends = [l.a, l.b];
    const key = (e) => [cost[e.sw], bid[e.sw], minPort(e.ports)];
    const ka = key(l.a), kb = key(l.b);
    const desig = (ka[0] < kb[0] || (ka[0] === kb[0] && (ka[1] < kb[1] || (ka[1] === kb[1] && ka[2] <= kb[2])))) ? l.a : l.b;
    for (const e of ends) {
      const isRoot = rootLink[e.sw] && rootLink[e.sw].l === l && rootLink[e.sw].me === e;
      const role = e.sw === root ? 'designated' : isRoot ? 'root' : e === desig ? 'designated' : 'alternate';
      for (const p of e.ports) { res.bridges[e.sw].ports[p] = role; if (role === 'alternate') res.blocked.add(U.ifKey(e.sw, p)); }
    }
  }
  for (const d of bridges) for (const ifc of d.ifaces) if (portActive(net, d, ifc) && !res.bridges[d.name].ports[ifc.name]) res.bridges[d.name].ports[ifc.name] = 'designated';
  return res;
}

// ブロードキャストドメイン(union-find)
function computeDomains(net, blocked) {
  const parent = {};
  const find = (x) => { parent[x] = parent[x] || x; while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const touch = (k) => find(k);
  // すべての L3 の口と SVI を点として登録(つながっていなくても 1 つのドメイン)
  for (const dev of Object.values(net.devices)) for (const ifc of dev.ifaces) {
    if (ifc.shutdown) continue;
    if (ifc.vlanId) { if (dev.vlans.has(ifc.vlanId) || dev.kind === 'cloud-subnet') touch(vkey(dev.name, ifc.vlanId)); }
    else if (!isBridge(dev)) touch(U.ifKey(dev.name, ifc.name));
  }
  for (const l of net.links) {
    if (!l.up) continue;
    const da = net.devices[l.a.dev], db = net.devices[l.b.dev];
    const ia = da.ifByName[l.a.iface], ib = db.ifByName[l.b.iface];
    if (ia.shutdown || ib.shutdown) continue;
    if (blocked.has(U.ifKey(da.name, ia.name)) || blocked.has(U.ifKey(db.name, ib.name))) continue;
    const A = classify(net, da, ia), B = classify(net, db, ib);
    const join = (x, y) => {
      if (x.type === 'swport' && y.type === 'l3') {
        if (x.mode === 'access') { if (accessOk(x)) union(vkey(x.dev.name, x.vlan), y.key); }
        else { if (x.dev.vlans.has(x.native)) union(vkey(x.dev.name, x.native), y.key); for (const s of y.subs) if (trunkCarries(x, s.tag) && s.tag !== x.native) union(vkey(x.dev.name, s.tag), s.key); }
      } else if (x.type === 'swport' && y.type === 'swport') {
        if (x.mode === 'access' && y.mode === 'access') { if (accessOk(x) && accessOk(y)) union(vkey(x.dev.name, x.vlan), vkey(y.dev.name, y.vlan)); }
        else if (x.mode === 'access') { if (accessOk(x) && y.dev.vlans.has(y.native)) union(vkey(x.dev.name, x.vlan), vkey(y.dev.name, y.native)); }
        else if (y.mode === 'access') { if (accessOk(y) && x.dev.vlans.has(x.native)) union(vkey(y.dev.name, y.vlan), vkey(x.dev.name, x.native)); }
        else {
          if (x.dev.vlans.has(x.native) && y.dev.vlans.has(y.native)) union(vkey(x.dev.name, x.native), vkey(y.dev.name, y.native));
          const tags = new Set([...x.dev.vlans, ...y.dev.vlans]);
          for (const t of tags) if (t !== x.native && t !== y.native && trunkCarries(x, t) && trunkCarries(y, t)) union(vkey(x.dev.name, t), vkey(y.dev.name, t));
        }
      } else if (x.type === 'l3' && y.type === 'l3') {
        union(x.key, y.key);
        for (const s of x.subs) { const t = y.subs.find((u) => u.tag === s.tag); if (t) union(s.key, t.key); }
      }
    };
    if (A.type === 'l3' && B.type === 'swport') join(B, A); else join(A, B);
  }
  const groups = {};
  for (const k of Object.keys(parent)) (groups[find(k)] = groups[find(k)] || []).push(k);
  const domains = Object.values(groups).map((members, i) => ({ id: `D${i + 1}`, members: members.sort() }));
  const domainOf = {}; for (const d of domains) for (const m of d.members) domainOf[m] = d.id;
  return { domains, domainOf };
}

// ある端点の鍵(L3 の口 → ドメインの鍵)
function keyOf(net, dev, ifc) {
  if (ifc.vlanId) return vkey(dev.name, ifc.vlanId);
  return U.ifKey(dev.name, ifc.name);
}

// スイッチ S のポート p が(ドメイン D で)つながる先を BFS で集める。返す: { endpoints: [key], switches: [name] }(行きの順)
function walkFromPort(net, l2, sw, port, domainId, visited = new Set()) {
  const out = { endpoints: [], switches: [] };
  const start = net.peer[U.ifKey(sw, port)]; if (!start) return out;
  const queue = [start];
  while (queue.length) {
    const k = queue.shift(); if (visited.has(k)) continue; visited.add(k);
    const [dn, pn] = k.split(':'); const dev = net.devices[dn]; const ifc = dev.ifByName[pn];
    if (!ifc || ifc.shutdown) continue;
    if (!isBridge(dev)) {
      const keys = [U.ifKey(dn, pn), ...dev.ifaces.filter((s) => s.parent === pn).map((s) => U.ifKey(dn, s.name))];
      for (const key of keys) if (l2.domainOf[key] === domainId) out.endpoints.push(key);
      continue;
    }
    if (l2.blocked.has(k)) continue;
    // このスイッチがドメインに属する VLAN を 1 つでも持つなら中を通る
    const myVlans = [...dev.vlans].filter((v) => l2.domainOf[vkey(dn, v)] === domainId);
    if (!myVlans.length) continue;
    out.switches.push(dn);
    for (const v of myVlans) if (dev.ifByName[`Vlan${v}`]) out.endpoints.push(vkey(dn, v));
    for (const o of dev.ifaces) {
      if (o.name === pn || !portActive(net, dev, o) || l2.blocked.has(U.ifKey(dn, o.name))) continue;
      const carries = o.mode === 'trunk' ? myVlans.some((v) => trunkCarries({ dev, allowed: o.allowed }, v) || v === o.native) : myVlans.includes(o.vlan || 1);
      if (carries) queue.push(net.peer[U.ifKey(dn, o.name)]);
    }
  }
  return out;
}

// MAC アドレス表: スイッチごと [{ vlan, mac, port }]
function computeMacTables(net, l2, endpointMac) {
  const tables = {};
  for (const dev of Object.values(net.devices)) {
    if (!isBridge(dev) || dev.kind === 'cloud-subnet') continue;
    const rows = [];
    for (const v of dev.vlans) {
      const did = l2.domainOf[vkey(dev.name, v)]; if (!did) continue;
      for (const ifc of dev.ifaces) {
        if (!portActive(net, dev, ifc) || l2.blocked.has(U.ifKey(dev.name, ifc.name))) continue;
        const carries = ifc.mode === 'trunk' ? (trunkCarries({ dev, allowed: ifc.allowed }, v) || v === ifc.native) : (ifc.vlan || 1) === v;
        if (!carries) continue;
        const w = walkFromPort(net, l2, dev.name, ifc.name, did);
        for (const key of w.endpoints) if (endpointMac[key] && !rows.some((r) => r.mac === endpointMac[key] && r.vlan === v)) rows.push({ vlan: v, mac: endpointMac[key], port: ifc.name });
      }
    }
    tables[dev.name] = rows.sort((a, b) => a.vlan - b.vlan || (a.port < b.port ? -1 : 1));
  }
  return tables;
}

// 端点 from から端点 to までに通るスイッチの列(同じドメインの中。無ければ null)
function l2path(net, l2, fromKey, toKey) {
  const did = l2.domainOf[fromKey]; if (!did || l2.domainOf[toKey] !== did) return null;
  const [fd, fi] = fromKey.split(':'); const [fdev, fport] = [fd, fi ? fi.split('.')[0] : null];
  if (!fport) { // SVI から: スイッチ自身が始点
    return [fd.split('#')[0]];
  }
  // BFS で (ポート鍵, 経路) を追う
  const start = net.peer[U.ifKey(fdev, fport)]; if (!start) return null;
  const queue = [[start, []]]; const seen = new Set();
  while (queue.length) {
    const [k, path] = queue.shift(); if (seen.has(k)) continue; seen.add(k);
    const [dn, pn] = k.split(':'); const dev = net.devices[dn];
    if (!isBridge(dev)) { if (dn === toKey.split(':')[0] && toKey.split(':')[1] && toKey.split(':')[1].split('.')[0] === pn) return path; continue; }
    if (toKey === `${dn}#vlan${toKey.split('#vlan')[1]}` && toKey.startsWith(`${dn}#`)) return path.concat(dn);
    const myVlans = [...dev.vlans].filter((v) => l2.domainOf[vkey(dn, v)] === did);
    if (!myVlans.length) continue;
    for (const o of dev.ifaces) {
      if (o.name === pn || !portActive(net, dev, o) || l2.blocked.has(U.ifKey(dn, o.name))) continue;
      const carries = o.mode === 'trunk' ? myVlans.some((v) => trunkCarries({ dev, allowed: o.allowed }, v) || v === o.native) : myVlans.includes(o.vlan || 1);
      if (carries) queue.push([net.peer[U.ifKey(dn, o.name)], path.concat(dn)]);
    }
  }
  return null;
}

function computeL2(net) {
  const { lag, bundledPort } = computeLag(net);
  const links = logicalLinks(net, bundledPort);
  const stp = computeStp(net, links);
  const { domains, domainOf } = computeDomains(net, stp.blocked);
  const l2 = { lag, stp, blocked: stp.blocked, domains, domainOf, keyOf: (dev, ifc) => keyOf(net, dev, ifc) };
  const endpointMac = {};
  for (const dev of Object.values(net.devices)) for (const ifc of dev.ifaces) if (ifc.mac && !ifc.vlanId) endpointMac[U.ifKey(dev.name, ifc.name)] = ifc.mac;
  for (const dev of Object.values(net.devices)) for (const ifc of dev.ifaces) if (ifc.vlanId) endpointMac[vkey(dev.name, ifc.vlanId)] = dev.ifaces.filter((i) => i.mac).map((i) => i.mac).sort()[0] || null;
  l2.macTables = computeMacTables(net, l2, endpointMac);
  l2.endpointMac = endpointMac;
  // VLAN ごとのポート(show vlan 用)
  l2.vlans = {};
  for (const dev of Object.values(net.devices)) {
    if (!isBridge(dev)) continue;
    const v = {};
    for (const id of [...dev.vlans].sort((a, b) => a - b)) v[id] = { ports: dev.ifaces.filter((i) => !i.vlanId && !i.parent && (i.mode || 'access') === 'access' && (i.vlan || 1) === id).map((i) => i.name), trunks: dev.ifaces.filter((i) => i.mode === 'trunk' && (trunkCarries({ dev, allowed: i.allowed }, id) || i.native === id)).map((i) => i.name) };
    l2.vlans[dev.name] = v;
  }
  return l2;
}

module.exports = { computeL2, walkFromPort, l2path, keyOf, vkey, isBridge, portActive };
