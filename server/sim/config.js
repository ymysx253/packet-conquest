'use strict';
// 設定の文法(docs/questions/DIAGRAM-CONFIG.md 4.2)。ゲーム専用の簡略文法。1 行 = 1 つの指示。字の大小は区別しない。省略形(int など)は受けない。
// 決めたこと:
//   - 読めた行はそのまま当て、読めない行は errors に入れる(行番号・その行・理由)。当てる前に全部を読まない(途中の誤りのあとの行も当てる)
//   - 'interface Gi1/0/1-2' の範囲は、同じ塊の中の指示を全部のポートに当てる
//   - OSPF の hello/dead は IF の中で 'ospf hello 10' / 'ospf dead 40'(機器ごとに 1 組とみなす)。'router ospf 1' の中は 'network <網> area <n>' と 'redistribute static'
//   - FW: 'zone <名前> <IF>'(トップ)でゾーンに IF を入れ、'policy <from> <to> permit|deny [ip|tcp|udp|icmp] [eq <port>]'
//   - ホストは 'ip address'・'gateway'・'dns'・'dhcp'・'ipv6 address' だけ。ルーター・スイッチにホストの行(gateway など)は書けない
const U = require('./util');
const M = require('./model');

const ABBREV = { int: 'interface', conf: 'configure', sh: 'show', swi: 'switchport', shut: 'shutdown', addr: 'address', encap: 'encapsulation', 'spanning': 'spanning-tree', rout: 'router', desc: 'description', 'no' : null };
const isL2Dev = (d) => d.kind === 'switch' || d.kind === 'l3switch';
const isL3Dev = (d) => d.kind === 'router' || d.kind === 'l3switch' || d.kind === 'firewall';
const isHostDev = (d) => M.HOST_KINDS.has(d.kind);

function parseVlanList(s) {
  if (!s) return null;
  if (s.toLowerCase() === 'all') return 'all';
  const out = new Set();
  for (const part of s.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim()); if (!m) return null;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a; if (a < 1 || b > 4094 || b < a) return null;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return out;
}
function expandRange(name) { // 'Gi1/0/1-2' → ['Gi1/0/1', 'Gi1/0/2']
  const m = /^(.*?)(\d+)-(\d+)$/.exec(name);
  if (!m) { const c = U.canonIf(name); return c ? [c] : null; }
  const a = Number(m[2]), b = Number(m[3]); if (b < a || b - a > 47) return null;
  const out = []; for (let i = a; i <= b; i++) { const c = U.canonIf(`${m[1]}${i}`); if (!c) return null; out.push(c); }
  return out;
}
// 送信元・宛先の書き方: any / host A / A/len / A wildcard / A mask
function parseAddrSpec(tokens, i) {
  const t = tokens[i]; if (!t) return null;
  if (t === 'any') return { spec: 'any', used: 1 };
  if (t === 'host') { const ip = tokens[i + 1]; if (!ip || !U.isIpv4(ip)) return null; return { spec: `host ${ip}`, used: 2 }; }
  const c = U.parseCidr(t); if (c) return { spec: U.cidrOf(c.ip, c.len), used: 1 };
  if (U.isIpv4(t) && tokens[i + 1] && U.isIpv4(tokens[i + 1])) {
    const w = tokens[i + 1];
    const asMask = U.parseCidr(`${t} ${w}`); if (asMask) return { spec: U.cidrOf(asMask.ip, asMask.len), used: 2 };
    // ワイルドカード(0.0.0.255 など)
    const inv = U.intToIp(4294967295 - U.ipToInt(w)); const c2 = U.parseCidr(`${t} ${inv}`); if (c2) return { spec: U.cidrOf(c2.ip, c2.len), used: 2 };
    return null;
  }
  if (U.isIpv4(t)) return { spec: `host ${t}`, used: 1 };
  return null;
}

// 1 台に設定を当てる。返す { ok, errors: [{ line, text, message }] }
function apply(net, devName, text) {
  const dev = net.devices[devName];
  if (!dev) return { ok: false, errors: [{ line: 0, text: '', message: `機器 ${devName} が無い` }] };
  const errors = [];
  const ctx = { kind: null, ifaces: [], acl: null, pool: null };
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const err = (n, raw, message) => errors.push({ line: n, text: raw, message });
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('#')) return;
    const tokens = line.split(/\s+/);
    const w = tokens.map((t) => t.toLowerCase());
    const first = w[0] === 'no' ? w[1] : w[0];
    if (first in ABBREV && ABBREV[first]) return err(n, raw, `省略形は使えません。${ABBREV[first]} と書く`);
    try { applyLine(net, dev, ctx, tokens, w, raw, n, err); } catch (e) { err(n, raw, e.message); }
  });
  M.invalidate(net);
  return { ok: errors.length === 0, errors };
}

function applyLine(net, dev, ctx, tokens, w, raw, n, err) {
  const neg = w[0] === 'no';
  const t = neg ? tokens.slice(1) : tokens; const lw = neg ? w.slice(1) : w;
  const bad = (m) => err(n, raw, m);
  const needIf = () => { if (ctx.kind !== 'iface' || !ctx.ifaces.length) { bad('interface の中で書く行です'); return false; } return true; };
  // 塊の中でトップの行(ip route・vlan など)を書いたら、塊を出てから当てる(exit を忘れても読める)
  const topLevel = ['vlan', 'router', 'zone', 'policy', 'hostname'].includes(lw[0]) || (lw[0] === 'ip' && (lw[1] === 'route' || lw[1] === 'routing')) || (lw[0] === 'ipv6' && lw[1] === 'route')
    || (lw[0] === 'dhcp' && (lw[1] === 'exclude' || lw[1] === 'pool' || (lw[1] === 'snooping' && lw[2] !== 'trust'))) || (lw[0] === 'spanning-tree' && lw[1] === 'priority')
    || (lw[0] === 'nat' && (lw[1] === 'source' || lw[1] === 'static')) || (lw[0] === 'acl' && (lw[2] === 'standard' || lw[2] === 'extended'));
  if (topLevel && !isHostDev(dev)) { ctx.kind = null; ctx.ifaces = []; ctx.acl = null; ctx.pool = null; }
  if (lw[0] === 'end') { ctx.kind = null; ctx.ifaces = []; ctx.acl = null; ctx.pool = null; return; }
  if (lw[0] === 'exit') { ctx.kind = null; ctx.ifaces = []; ctx.acl = null; ctx.pool = null; return; }
  if (lw[0] === 'description') return;
  // ---- ホスト ----
  if (isHostDev(dev)) {
    const ifc = dev.ifaces[0];
    if (lw[0] === 'ip' && lw[1] === 'address') { if (neg) { ifc.ip = null; ifc.len = null; return; } const c = U.parseCidr(t.slice(2).join(' ')); if (!c) return bad('アドレスの形が違います(例: 192.168.10.30/26)'); if (c.len < 1 || c.len > 30) return bad('ホストのプレフィックス長は /1〜/30'); ifc.ip = c.ip; ifc.len = c.len; dev.dhcpClient = false; return; }
    if (lw[0] === 'gateway') { if (neg) { dev.gateway = null; return; } if (!U.isIpv4(t[1])) return bad('ゲートウェイのアドレスの形が違います'); dev.gateway = U.intToIp(U.ipToInt(t[1])); return; }
    if (lw[0] === 'dns') { if (neg) { dev.dns = null; return; } if (!U.isIpv4(t[1])) return bad('DNS のアドレスの形が違います'); dev.dns = t[1]; return; }
    if (lw[0] === 'dhcp') { dev.dhcpClient = !neg; if (!neg) { ifc.ip = null; ifc.len = null; } return; }
    if (lw[0] === 'ipv6' && lw[1] === 'address') { ifc.ipv6 = neg ? null : t[2] || null; return; }
    if (lw[0] === 'ip' && lw[1] === 'route') return bad('ホストに経路は書けません(gateway を使う)');
    return bad(`知らないコマンドです: ${t[0]}(ホストに書けるのは ip address・gateway・dns・dhcp・ipv6 address)`);
  }
  if (dev.kind === 'cloud-subnet') return bad('クラウドのサブネットはここでは設定できません');
  // ---- 塊の始まり ----
  if (lw[0] === 'interface') {
    if (!t[1]) return bad('interface のあとに IF 名を書く');
    let names;
    if (lw[1] === 'vlan') { if (!isL2Dev(dev)) return bad('interface vlan はスイッチだけ'); if (!/^\d+$/.test(t[2] || '')) return bad('VLAN の番号を書く'); names = [`Vlan${Number(t[2])}`]; dev.vlans.add(Number(t[2])); }
    else { names = expandRange(t.slice(1).join('')); if (!names) return bad(`IF 名が読めません: ${t.slice(1).join(' ')}`); }
    const ifaces = names.map((nm) => M.getIface(dev, nm, true));
    if (neg) { for (const f of ifaces) if (f.parent || f.vlanId) { dev.ifaces = dev.ifaces.filter((x) => x !== f); delete dev.ifByName[f.name]; } return; }
    ctx.kind = 'iface'; ctx.ifaces = ifaces; ctx.acl = null; ctx.pool = null; return;
  }
  if (lw[0] === 'router') {
    if (lw[1] !== 'ospf') return bad('router のあとは ospf だけ(BGP は設定の問題に出しません)');
    if (!isL3Dev(dev)) return bad('OSPF はルーター・L3 スイッチだけ');
    if (neg) { dev.ospf = null; return; }
    if (!dev.ospf) dev.ospf = { process: Number(t[2]) || 1, area: 0, networks: [], hello: null, dead: null, auth: null };
    ctx.kind = 'ospf'; ctx.ifaces = []; return;
  }
  if (lw[0] === 'dhcp' && lw[1] === 'pool') {
    if (!t[2]) return bad('dhcp pool のあとに名前を書く');
    if (neg) { dev.dhcp.pools = dev.dhcp.pools.filter((p) => p.name.toLowerCase() !== lw[2]); return; }
    let pool = dev.dhcp.pools.find((p) => p.name.toLowerCase() === lw[2]);
    if (!pool) { pool = { name: t[2], network: null, gateway: null, dns: null, exclude: [] }; dev.dhcp.pools.push(pool); }
    ctx.kind = 'pool'; ctx.pool = pool; ctx.ifaces = []; return;
  }
  if (lw[0] === 'acl' && ctx.kind !== 'iface') {
    if (!t[1]) return bad('acl のあとに名前を書く');
    if (neg) { delete dev.acls[Object.keys(dev.acls).find((k) => k.toLowerCase() === lw[1]) || '']; return; }
    const type = lw[2]; if (type !== 'standard' && type !== 'extended') return bad('acl <名前> standard か extended と書く');
    const key = Object.keys(dev.acls).find((k) => k.toLowerCase() === lw[1]) || t[1];
    if (!dev.acls[key]) dev.acls[key] = { type, lines: [] };
    ctx.kind = 'acl'; ctx.acl = dev.acls[key]; ctx.ifaces = []; return;
  }
  // ---- 塊の中 ----
  if (ctx.kind === 'ospf' && (lw[0] === 'network' || lw[0] === 'redistribute' || lw[0] === 'passive-interface')) {
    if (lw[0] === 'network') {
      const c = U.parseCidr(t[1] + (t[2] && U.isIpv4(t[2]) && lw[3] === 'area' ? ` ${t[2]}` : ''));
      const areaIdx = lw.indexOf('area'); if (!c || areaIdx < 0 || !/^\d+$/.test(t[areaIdx + 1] || '')) return bad('network <網>/<長さ> area <番号> と書く');
      const cidr = U.cidrOf(c.ip, c.len);
      if (neg) { dev.ospf.networks = dev.ospf.networks.filter((x) => x !== cidr); return; }
      if (!dev.ospf.networks.includes(cidr)) dev.ospf.networks.push(cidr); dev.ospf.area = Number(t[areaIdx + 1]); return;
    }
    if (lw[0] === 'redistribute') { if (lw[1] !== 'static' && lw[1] !== 'connected') return bad('redistribute static か connected'); dev.ospf.redistribute = dev.ospf.redistribute || []; if (neg) dev.ospf.redistribute = dev.ospf.redistribute.filter((x) => x !== lw[1]); else if (!dev.ospf.redistribute.includes(lw[1])) dev.ospf.redistribute.push(lw[1]); return; }
    return;
  }
  if (ctx.kind === 'pool' && (lw[0] === 'network' || lw[0] === 'gateway' || lw[0] === 'dns')) {
    if (lw[0] === 'network') { const c = U.parseCidr(t.slice(1).join(' ')); if (!c) return bad('network <網>/<長さ> と書く'); ctx.pool.network = U.cidrOf(c.ip, c.len); return; }
    if (!U.isIpv4(t[1])) return bad(`${t[0]} のあとにアドレスを書く`);
    ctx.pool[lw[0]] = neg ? null : t[1]; return;
  }
  if (ctx.kind === 'acl' && /^\d+$/.test(lw[0])) {
    const seq = Number(t[0]);
    if (neg) { ctx.acl.lines = ctx.acl.lines.filter((l) => l.seq !== seq); return; }
    const action = lw[1]; if (action !== 'permit' && action !== 'deny') return bad('<番号> permit|deny … と書く');
    if (ctx.acl.type === 'standard') { const a = parseAddrSpec(t, 2); if (!a) return bad('標準 ACL は <番号> permit|deny <送信元> (any / host A / A/長さ / A ワイルドカード)'); upsertLine(ctx.acl, { seq, action, proto: 'ip', src: a.spec, dst: 'any', dport: null }); return; }
    const proto = lw[2]; if (!['ip', 'tcp', 'udp', 'icmp'].includes(proto)) return bad('拡張 ACL は <番号> permit|deny ip|tcp|udp|icmp <送信元> <宛先> [eq <ポート>]');
    const s = parseAddrSpec(t, 3); if (!s) return bad('送信元が読めません');
    const d = parseAddrSpec(t, 3 + s.used); if (!d) return bad('宛先が読めません');
    let dport = null; const k = 3 + s.used + d.used;
    if (t[k]) { if (lw[k] !== 'eq' || !/^\d+$/.test(t[k + 1] || '') || proto === 'ip' || proto === 'icmp') return bad('ポートは tcp/udp のときだけ eq <番号> と書く'); dport = Number(t[k + 1]); }
    upsertLine(ctx.acl, { seq, action, proto, src: s.spec, dst: d.spec, dport }); return;
  }
  if (ctx.kind === 'iface') return applyIfaceLine(net, dev, ctx, t, lw, neg, bad);
  // ---- トップ ----
  if (lw[0] === 'ip' && lw[1] === 'route') {
    if (!isL3Dev(dev)) return bad('静的経路はルーター・L3 スイッチだけ');
    let c = null, rest;
    if (t[3] && U.parseCidr(`${t[2]} ${t[3]}`) && !U.isIpv4(t[2] || '') === false && t[3].startsWith('255')) { c = U.parseCidr(`${t[2]} ${t[3]}`); rest = t.slice(4); } else { c = U.parseCidr(t[2] || ''); rest = t.slice(3); }
    if (!c) return bad('ip route <網>/<長さ> <次の相手 か IF> [優先度] と書く');
    const prefix = U.cidrOf(c.ip, c.len);
    if (neg) { dev.routes = dev.routes.filter((r) => !(U.cidrOf(U.parseCidr(r.prefix).ip, U.parseCidr(r.prefix).len) === prefix && (!rest[0] || String(r.via).toLowerCase() === rest[0].toLowerCase() || U.canonIf(r.via) === U.canonIf(rest[0])))); return; }
    const via = rest[0]; if (!via) return bad('次の相手(アドレスか IF)を書く');
    if (!U.isIpv4(via) && !(U.canonIf(via) && dev.ifByName[U.canonIf(via)])) return bad(`次の相手が読めません: ${via}`);
    const ad = rest[1] !== undefined ? Number(rest[1]) : 1; if (!(ad >= 1 && ad <= 255)) return bad('優先度は 1〜255');
    dev.routes = dev.routes.filter((r) => !(U.cidrOf(U.parseCidr(r.prefix).ip, U.parseCidr(r.prefix).len) === prefix && r.via === (U.isIpv4(via) ? U.intToIp(U.ipToInt(via)) : U.canonIf(via))));
    dev.routes.push({ prefix, via: U.isIpv4(via) ? U.intToIp(U.ipToInt(via)) : U.canonIf(via), ad }); return;
  }
  if (lw[0] === 'ipv6' && lw[1] === 'route') { if (!isL3Dev(dev)) return bad('IPv6 の経路はルーターだけ'); if (!t[2] || !t[3]) return bad('ipv6 route <網>/<長さ> <次の相手>'); if (neg) { dev.routes6 = dev.routes6.filter((r) => r.prefix.toLowerCase() !== lw[2]); return; } dev.routes6.push({ prefix: t[2], via: t[3] }); return; }
  if (lw[0] === 'ip' && lw[1] === 'routing') { if (dev.kind !== 'l3switch') return bad('ip routing は L3 スイッチだけ'); dev.ipRouting = !neg; return; }
  if (lw[0] === 'vlan') { if (!isL2Dev(dev)) return bad('vlan はスイッチだけ'); const l = parseVlanList(t[1]); if (!l || l === 'all') return bad('vlan <番号> と書く'); for (const v of l) { if (neg) dev.vlans.delete(v); else dev.vlans.add(v); } return; }
  if (lw[0] === 'dhcp' && lw[1] === 'exclude') { if (!U.isIpv4(t[2])) return bad('dhcp exclude <始め> [<終わり>]'); const range = [t[2], U.isIpv4(t[3] || '') ? t[3] : t[2]]; if (neg) dev.dhcp.exclude = dev.dhcp.exclude.filter((e) => e[0] !== range[0]); else dev.dhcp.exclude.push(range); return; }
  if (lw[0] === 'dhcp' && lw[1] === 'snooping') { if (!isL2Dev(dev)) return bad('dhcp snooping はスイッチだけ'); dev.dhcpSnooping = !neg; return; }
  if (lw[0] === 'spanning-tree' && lw[1] === 'priority') { if (!isL2Dev(dev)) return bad('spanning-tree priority はスイッチだけ'); const p = Number(t[2]); if (!(Number.isInteger(p) && p >= 0 && p <= 61440 && p % 4096 === 0)) return bad('優先度は 0〜61440 の 4096 の倍数'); dev.stpPriority = neg ? 32768 : p; return; }
  if (lw[0] === 'nat' && lw[1] === 'source') {
    if (!isL3Dev(dev)) return bad('NAT はルーター・FW だけ');
    const c = U.parseCidr(t[2] || ''); const ii = lw.indexOf('interface'); const ifn = ii > 0 ? U.canonIf(t[ii + 1] || '') : null;
    if (!c || !ifn || !dev.ifByName[ifn]) return bad('nat source <網>/<長さ> interface <外側の IF> [overload]');
    const rule = { src: U.cidrOf(c.ip, c.len), iface: ifn, overload: true };
    if (neg) { dev.nat.source = dev.nat.source.filter((r) => !(r.src === rule.src && r.iface === rule.iface)); return; }
    if (!dev.nat.source.some((r) => r.src === rule.src && r.iface === rule.iface)) dev.nat.source.push(rule); return;
  }
  if (lw[0] === 'nat' && lw[1] === 'static') {
    if (!isL3Dev(dev)) return bad('NAT はルーター・FW だけ');
    const proto = lw[2]; const ok = (proto === 'tcp' || proto === 'udp') && U.isIpv4(t[3] || '') && /^\d+$/.test(t[4] || '') && U.isIpv4(t[5] || '') && /^\d+$/.test(t[6] || '');
    if (!ok) return bad('nat static tcp|udp <内のアドレス> <内のポート> <外のアドレス> <外のポート>');
    const s = { proto, insideIp: t[3], insidePort: Number(t[4]), outsideIp: t[5], outsidePort: Number(t[6]) };
    if (neg) { dev.nat.static = dev.nat.static.filter((x) => !(x.proto === s.proto && x.outsideIp === s.outsideIp && x.outsidePort === s.outsidePort)); return; }
    dev.nat.static = dev.nat.static.filter((x) => !(x.proto === s.proto && x.outsideIp === s.outsideIp && x.outsidePort === s.outsidePort)); dev.nat.static.push(s); return;
  }
  if (lw[0] === 'zone') { if (dev.kind !== 'firewall') return bad('zone は FW だけ'); const z = t[1]; const ifs = t.slice(2).map(U.canonIf); if (!z || !ifs.length || ifs.some((x) => !x)) return bad('zone <名前> <IF>…'); if (neg) { delete dev.zones[z]; return; } dev.zones[z] = [...new Set([...(dev.zones[z] || []), ...ifs])]; for (const f of ifs) M.getIface(dev, f, true); return; }
  if (lw[0] === 'policy') {
    if (dev.kind !== 'firewall') return bad('policy は FW だけ');
    const [, from, to, act] = t; if (!from || !to || (act !== 'permit' && act !== 'deny')) return bad('policy <from> <to> permit|deny [ip|tcp|udp|icmp] [eq <ポート>]');
    const proto = lw[4] && ['ip', 'tcp', 'udp', 'icmp'].includes(lw[4]) ? lw[4] : 'ip'; const ei = lw.indexOf('eq'); const dport = ei > 0 ? Number(t[ei + 1]) : null;
    const p = { from, to, proto, dport, action: act };
    if (neg) { dev.policies = dev.policies.filter((x) => !(x.from === from && x.to === to && x.proto === proto && x.dport === dport)); return; }
    dev.policies.push(p); return;
  }
  if (lw[0] === 'hostname') return;
  return bad(`知らないコマンドです: ${t.slice(0, 2).join(' ')}`);
}
function upsertLine(acl, line) { acl.lines = acl.lines.filter((l) => l.seq !== line.seq); acl.lines.push(line); acl.lines.sort((a, b) => a.seq - b.seq); }

function applyIfaceLine(net, dev, ctx, t, lw, neg, bad) {
  const each = (fn) => ctx.ifaces.forEach(fn);
  if (lw[0] === 'ip' && lw[1] === 'address') {
    if (neg) { each((f) => { f.ip = null; f.len = null; }); return; }
    const c = U.parseCidr(t.slice(2).join(' ')); if (!c) return bad('ip address <アドレス>/<長さ>(か <アドレス> <マスク>)と書く');
    if (ctx.ifaces.length > 1) return bad('同じアドレスを複数の IF に付けられません');
    if (isL2Dev(dev) && dev.kind === 'switch' && !ctx.ifaces[0].vlanId) return bad('L2 スイッチのポートにアドレスは付けられません(interface vlan に付ける)');
    if ((dev.kind === 'l3switch') && !ctx.ifaces[0].vlanId && (ctx.ifaces[0].mode)) return bad('L3 スイッチのポートにアドレスを付けるなら、まず switchport をやめる(no switchport)');
    each((f) => { f.ip = c.ip; f.len = c.len; }); return;
  }
  if (lw[0] === 'ipv6' && lw[1] === 'address') { each((f) => { f.ipv6 = neg ? null : t[2] || null; }); return; }
  if (lw[0] === 'shutdown') { each((f) => { f.shutdown = !neg; }); return; }
  if (lw[0] === 'switchport' && lw[1] === undefined) { if (dev.kind !== 'l3switch') return bad('no switchport は L3 スイッチだけ'); each((f) => { f.mode = neg ? null : 'access'; }); return; }
  if (lw[0] === 'encapsulation') { if (lw[1] !== 'dot1q' || !/^\d+$/.test(t[2] || '')) return bad('encapsulation dot1q <VLAN 番号>'); if (ctx.ifaces.some((f) => !f.parent)) return bad('encapsulation は副 IF(Gi0/0.10 など)の中で書く'); each((f) => { f.tag = Number(t[2]); }); return; }
  if (lw[0] === 'ospf') {
    if (!isL3Dev(dev)) return bad('ospf はルーター・L3 スイッチだけ');
    if (lw[1] === 'cost') { const c = Number(t[2]); if (!(c >= 1 && c <= 65535)) return bad('ospf cost 1〜65535'); each((f) => { f.ospfCost = neg ? null : c; }); return; }
    if (lw[1] === 'hello' || lw[1] === 'dead') { const v = Number(t[2]); if (!(v >= 1)) return bad(`ospf ${lw[1]} <秒>`); if (!dev.ospf) dev.ospf = { process: 1, area: 0, networks: [], hello: null, dead: null, auth: null }; dev.ospf[lw[1]] = neg ? null : v; return; }
    return bad('ospf cost / ospf hello / ospf dead');
  }
  if (lw[0] === 'dhcp' && lw[1] === 'relay') { if (!isL3Dev(dev)) return bad('dhcp relay はルーター・L3 スイッチだけ'); if (!neg && !U.isIpv4(t[2])) return bad('dhcp relay <DHCP サーバーのアドレス>'); each((f) => { f.dhcpRelay = neg ? null : t[2]; }); return; }
  if (lw[0] === 'dhcp' && lw[1] === 'snooping' && lw[2] === 'trust') { if (!isL2Dev(dev)) return bad('dhcp snooping trust はスイッチだけ'); each((f) => { f.snoopingTrust = !neg; }); return; }
  if (lw[0] === 'acl') {
    const key = Object.keys(dev.acls).find((k) => k.toLowerCase() === lw[1]); const dir = lw[2];
    if (!key) return bad(`ACL ${t[1]} がまだ無い(先に acl ${t[1]} standard|extended で作る)`);
    if (dir !== 'in' && dir !== 'out') return bad('acl <名前> in|out');
    each((f) => { if (dir === 'in') f.aclIn = neg ? null : key; else f.aclOut = neg ? null : key; }); return;
  }
  if (lw[0] === 'nat') { if (!isL3Dev(dev)) return bad('nat はルーター・FW だけ'); if (lw[1] !== 'inside' && lw[1] !== 'outside') return bad('nat inside|outside'); each((f) => { f.natSide = neg ? null : lw[1]; const list = dev.nat[lw[1]]; if (neg) dev.nat[lw[1]] = list.filter((x) => x !== f.name); else if (!list.includes(f.name)) list.push(f.name); }); return; }
  if (lw[0] === 'vrrp') {
    if (!isL3Dev(dev)) return bad('vrrp はルーター・L3 スイッチだけ');
    const g = Number(t[1]); if (!(g >= 1 && g <= 255)) return bad('vrrp <グループ 1〜255> ip|priority|preempt …');
    each((f) => {
      let e = f.vrrp.find((x) => x.group === g);
      if (neg && lw[2] === undefined) { f.vrrp = f.vrrp.filter((x) => x.group !== g); return; }
      if (!e) { e = { group: g, vip: null, priority: 100, preempt: true }; f.vrrp.push(e); }
      if (lw[2] === 'ip') { if (!neg && !U.isIpv4(t[3])) throw new Error('vrrp <グループ> ip <仮想アドレス>'); e.vip = neg ? null : t[3]; }
      else if (lw[2] === 'priority') { const p = Number(t[3]); if (!neg && !(p >= 1 && p <= 254)) throw new Error('priority は 1〜254'); e.priority = neg ? 100 : p; }
      else if (lw[2] === 'preempt') e.preempt = !neg;
      else throw new Error('vrrp <グループ> ip|priority|preempt');
    }); return;
  }
  if (lw[0] === 'switchport') {
    if (!isL2Dev(dev)) return bad('switchport はスイッチだけ');
    if (lw[1] === 'mode') { if (lw[2] !== 'access' && lw[2] !== 'trunk') return bad('switchport mode access|trunk'); each((f) => { f.mode = lw[2]; }); return; }
    if (lw[1] === 'access' && lw[2] === 'vlan') { const v = Number(t[3]); if (!(v >= 1 && v <= 4094)) return bad('switchport access vlan <1〜4094>'); each((f) => { f.vlan = neg ? 1 : v; }); return; }
    if (lw[1] === 'trunk' && lw[2] === 'allowed' && lw[3] === 'vlan') {
      const op = ['add', 'remove', 'except'].includes(lw[4]) ? lw[4] : null; const list = parseVlanList(t[op ? 5 : 4]);
      if (!list) return bad('switchport trunk allowed vlan [add|remove] <10,20 か 10-20 か all>');
      each((f) => {
        if (neg || list === 'all') { f.allowed = null; return; }
        if (op === 'add') { f.allowed = new Set([...(f.allowed || []), ...list]); }
        else if (op === 'remove') { f.allowed = new Set([...(f.allowed || [...dev.vlans])].filter((v) => !list.has(v))); }
        else f.allowed = new Set(list);
      }); return;
    }
    if (lw[1] === 'trunk' && lw[2] === 'native' && lw[3] === 'vlan') { const v = Number(t[4]); if (!(v >= 1 && v <= 4094)) return bad('switchport trunk native vlan <番号>'); each((f) => { f.native = neg ? 1 : v; }); return; }
    return bad('switchport mode / access vlan / trunk allowed vlan / trunk native vlan');
  }
  if (lw[0] === 'spanning-tree') { if (!isL2Dev(dev)) return bad('spanning-tree はスイッチだけ'); if (lw[1] === 'edge' || lw[1] === 'portfast') { each((f) => { f.edge = !neg; }); return; } return bad('ポートの中では spanning-tree edge'); }
  if (lw[0] === 'channel-group') { if (!isL2Dev(dev)) return bad('channel-group はスイッチだけ'); const g = Number(t[1]); const mode = lw[2] === 'mode' ? lw[3] : null; if (neg) { each((f) => { f.channelGroup = null; }); return; } if (!(g >= 1 && g <= 64) || !['active', 'passive', 'on'].includes(mode)) return bad('channel-group <番号> mode active|passive|on'); each((f) => { f.channelGroup = { id: g, mode }; }); return; }
  if (lw[0] === 'ip' && lw[1] === 'route') return bad('ip route は interface の外(トップ)で書く');
  return bad(`知らないコマンドです: ${t.slice(0, 2).join(' ')}(interface の中)`);
}

// 今の設定の文字(show running-config と、問題に見せる configView 用)
function runningConfig(net, devName, { hide = [] } = {}) {
  const dev = net.devices[devName]; if (!dev) return [];
  const out = [];
  if (M.HOST_KINDS.has(dev.kind)) {
    const f = dev.ifaces[0];
    if (dev.dhcpClient) out.push('dhcp'); else if (f.ip) out.push(`ip address ${f.ip}/${f.len}`);
    if (dev.gateway) out.push(`gateway ${dev.gateway}`); if (dev.dns) out.push(`dns ${dev.dns}`); if (f.ipv6) out.push(`ipv6 address ${f.ipv6}`);
    return out;
  }
  if (dev.kind === 'l3switch' && dev.ipRouting) out.push('ip routing');
  if (isL2Dev(dev)) { const vs = [...dev.vlans].filter((v) => v !== 1).sort((a, b) => a - b); if (vs.length) out.push(`vlan ${vs.join(',')}`); if (dev.stpPriority !== 32768) out.push(`spanning-tree priority ${dev.stpPriority}`); if (dev.dhcpSnooping) out.push('dhcp snooping'); }
  for (const f of dev.ifaces) {
    const lines = [];
    if (f.ip) lines.push(`ip address ${f.ip}/${f.len}`); if (f.ipv6) lines.push(`ipv6 address ${f.ipv6}`);
    if (f.parent && f.tag) lines.unshift(`encapsulation dot1q ${f.tag}`);
    if (f.shutdown) lines.push('shutdown');
    if (f.mode === 'trunk') { lines.push('switchport mode trunk'); if (f.allowed) lines.push(`switchport trunk allowed vlan ${[...f.allowed].sort((a, b) => a - b).join(',')}`); if (f.native !== 1) lines.push(`switchport trunk native vlan ${f.native}`); }
    else if (f.mode === 'access' && isL2Dev(dev)) { lines.push('switchport mode access'); if ((f.vlan || 1) !== 1) lines.push(`switchport access vlan ${f.vlan}`); }
    if (f.edge) lines.push('spanning-tree edge'); if (f.channelGroup) lines.push(`channel-group ${f.channelGroup.id} mode ${f.channelGroup.mode}`); if (f.snoopingTrust) lines.push('dhcp snooping trust');
    if (f.ospfCost) lines.push(`ospf cost ${f.ospfCost}`); if (f.dhcpRelay) lines.push(`dhcp relay ${f.dhcpRelay}`);
    if (f.aclIn && !hide.includes('acl')) lines.push(`acl ${f.aclIn} in`); if (f.aclOut && !hide.includes('acl')) lines.push(`acl ${f.aclOut} out`);
    if (f.natSide && !hide.includes('nat')) lines.push(`nat ${f.natSide}`);
    for (const v of f.vrrp) { if (v.vip) lines.push(`vrrp ${v.group} ip ${v.vip}`); if (v.priority !== 100) lines.push(`vrrp ${v.group} priority ${v.priority}`); if (!v.preempt) lines.push(`no vrrp ${v.group} preempt`); }
    if (lines.length || !isL2Dev(dev) || f.vlanId) { out.push(`interface ${f.name}`); for (const l of lines) out.push(` ${l}`); }
  }
  if (!hide.includes('routes')) for (const r of dev.routes) out.push(`ip route ${r.prefix} ${r.via}${r.ad !== 1 ? ` ${r.ad}` : ''}`);
  for (const r of dev.routes6) out.push(`ipv6 route ${r.prefix} ${r.via}`);
  if (dev.ospf && !hide.includes('ospf')) { out.push(`router ospf ${dev.ospf.process}`); for (const n of dev.ospf.networks) out.push(` network ${n} area ${dev.ospf.area}`); for (const x of dev.ospf.redistribute || []) out.push(` redistribute ${x}`); }
  if (!hide.includes('acl')) for (const [name, a] of Object.entries(dev.acls)) { out.push(`acl ${name} ${a.type}`); for (const l of a.lines) out.push(a.type === 'standard' ? ` ${l.seq} ${l.action} ${l.src}` : ` ${l.seq} ${l.action} ${l.proto} ${l.src} ${l.dst}${l.dport !== null ? ` eq ${l.dport}` : ''}`); }
  if (!hide.includes('nat')) { for (const s of dev.nat.source) out.push(`nat source ${s.src} interface ${s.iface} overload`); for (const s of dev.nat.static) out.push(`nat static ${s.proto} ${s.insideIp} ${s.insidePort} ${s.outsideIp} ${s.outsidePort}`); }
  if (!hide.includes('dhcp')) { for (const p of dev.dhcp.pools) { out.push(`dhcp pool ${p.name}`); if (p.network) out.push(` network ${p.network}`); if (p.gateway) out.push(` gateway ${p.gateway}`); if (p.dns) out.push(` dns ${p.dns}`); } for (const e of dev.dhcp.exclude) out.push(`dhcp exclude ${e[0]} ${e[1]}`); }
  for (const [z, ifs] of Object.entries(dev.zones)) out.push(`zone ${z} ${ifs.join(' ')}`);
  for (const p of dev.policies) out.push(`policy ${p.from} ${p.to} ${p.action} ${p.proto}${p.dport !== null ? ` eq ${p.dport}` : ''}`);
  return out;
}

module.exports = { apply, runningConfig, parseVlanList, expandRange, parseAddrSpec };
