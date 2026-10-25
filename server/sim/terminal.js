'use strict';
// 模擬ターミナル(docs/questions/SIM-API.md 第 7 章)。打った 1 行を読み、今の状態から出力を作る。外へは何もつながない。
// 出力はゲーム専用の短い形(英語の項目名 + 日本語)。本物の機器の出力は写さない。
// 決めたこと:
//   - ping は 4 回。届けば 4 回とも同じ結果(TTL は相手の初期値 − 通ったルーターの数、時間は 1 ホップ 1 ms)。届かなければ理由を 1 行
//   - 名前(PC2 など)は、機器の名前なら直接そのアドレスに、それ以外は自分の DNS サーバー(dns)の記録(A・CNAME)で引く
//   - configure の中の行はためておき、end で当てる(文法の誤りは行番号つきで返し、読めた行は当たる)。editable でない機器は configure を拒否
//   - hidden に入っている項目(routes・acl・nat・dhcp・ospf・ip)は show に出さない(SIM-API.md 第 7 章)
const U = require('./util');
const M = require('./model');

const HOST_CMDS = ['ipconfig', 'ip addr', 'ping', 'traceroute', 'tracert', 'arp -a', 'nslookup', 'route print', 'ip route', 'connect', 'help', 'exit'];
const RTR_CMDS = ['show ip route', 'show ip interface brief', 'show ip arp', 'show access-lists', 'show ip nat translations', 'show ip ospf neighbor', 'show vrrp', 'show ip dhcp binding', 'show running-config', 'ping', 'traceroute', 'configure', 'connect', 'help', 'exit'];
const SW_CMDS = ['show vlan', 'show interfaces trunk', 'show mac address-table', 'show spanning-tree', 'show etherchannel summary', 'show ip dhcp snooping', 'show running-config', 'show ip interface brief', 'configure', 'connect', 'help', 'exit'];
const cmdsFor = (dev) => (M.HOST_KINDS.has(dev.kind) ? HOST_CMDS : dev.kind === 'switch' ? SW_CMDS : dev.kind === 'l3switch' ? [...new Set([...RTR_CMDS, ...SW_CMDS])] : RTR_CMDS);

function session(spec, start, api) {
  const net = api.build(spec);
  const dev = start && net.devices[start] ? start : Object.keys(net.devices)[0];
  return { spec, net, api, device: dev, start: dev, mode: 'exec', cfgLines: [], history: [], count: 0 };
}

const pad = (s, n) => String(s).padEnd(n);
const hidden = (dev, k) => (dev.hidden || []).includes(k);

function resolveName(s, name) {
  const net = s.net, st = s.api.state(net);
  if (U.isIpv4(name)) return { ip: U.intToIp(U.ipToInt(name)), lines: [] };
  const d = net.devices[name] || net.devices[name.toUpperCase()];
  if (d) { const e = st.endpoints.find((x) => x.dev === d.name && !x.virtual); return e ? { ip: e.ip, lines: [] } : { ip: null, lines: [`${name} にアドレスが無い`] }; }
  const me = net.devices[s.device];
  if (!me.dns) return { ip: null, lines: [`${name} を引けない: DNS サーバーが設定されていない`] };
  const srv = Object.values(net.devices).find((x) => st.endpoints.some((e) => e.dev === x.name && e.ip === me.dns));
  if (!srv) return { ip: null, lines: [`DNS サーバー ${me.dns} に届かない`] };
  const r = s.api.reach(net, s.device, srv.name, { proto: 'udp', port: 53, roundTrip: true });
  if (!r.ok && !srv.listenAll && !srv.listen.some((l) => l.proto === 'udp' && l.port === 53)) return { ip: null, lines: [`DNS サーバー ${me.dns}(${srv.name})に届かない(${r.reason})`] };
  let cur = name.toLowerCase(); const lines = [];
  for (let i = 0; i < 8; i++) {
    const rec = srv.dnsRecords.find((x) => x.name === cur);
    if (!rec) return { ip: null, lines: lines.concat([`${cur}: 記録が無い(NXDOMAIN)`]) };
    if (rec.type === 'CNAME') { lines.push(`${cur}  CNAME  ${rec.value}(別名。本名は ${rec.value})`); cur = rec.value.toLowerCase(); continue; }
    lines.push(`${cur}  A  ${rec.value}`); return { ip: rec.value, lines };
  }
  return { ip: null, lines: lines.concat(['別名の連鎖が深すぎる']) };
}

function pingOut(s, target) {
  const { ip, lines } = resolveName(s, target);
  if (!ip) return lines.join('\n');
  const net = s.net; const st = s.api.state(net);
  const r = s.api.reach(net, s.device, null, { proto: 'icmp', toIp: ip, roundTrip: true });
  const out = lines.concat([`ping ${ip}: 4 回送信`]);
  if (r.ok) {
    const dstDev = net.devices[r.path[r.path.length - 1]]; const routers = r.path.filter((n) => M.routesPackets(net.devices[n])).length;
    const ttl = Math.max(1, (dstDev.ttl || 64) - routers); const ms = Math.max(1, r.path.length - 1);
    for (let i = 0; i < 4; i++) out.push(` 応答 ${ip}: TTL=${ttl} 時間=${ms} ms`);
    out.push(`4 回送信、4 回応答、0% 失われた`);
  } else {
    const why = r.reason === 'closed' ? '相手は届いたがポートが閉じている' : `${r.stoppedAt || s.device} で止まった(${r.reason}: ${r.detail})`;
    for (let i = 0; i < 4; i++) out.push(` 宛先 ${ip} に届かない`);
    out.push(`4 回送信、0 回応答、100% 失われた。${why}`);
  }
  void st;
  return out.join('\n');
}
function traceOut(s, target) {
  const { ip, lines } = resolveName(s, target);
  if (!ip) return lines.join('\n');
  const t = s.api.trace(s.net, s.device, ip);
  const out = lines.concat([`traceroute ${ip}(最大 30 ホップ)`]);
  t.hops.forEach((h, i) => out.push(h.reply ? ` ${pad(h.n, 2)} ${pad(h.ip, 16)} ${i + 1} ms` : ` ${pad(h.n, 2)} *  *  *`));
  if (!t.reached && !/^back:/.test(t.reason || '')) out.push(` ${pad(t.hops.length + 1, 2)} *  *  *   (ここから先に進めない: ${t.stoppedAt} で ${t.reason}。${t.detail})`);
  if (!t.reached && /^back:/.test(t.reason || '')) out.push(` (宛先までは進んだが、返事が戻らない: ${t.reason.slice(5)})`);
  return out.join('\n');
}

function showIpRoute(s, dev) {
  const st = s.api.state(s.net); const rs = st.routes[dev.name] || [];
  if (hidden(dev, 'routes')) return '経路表を見せられません';
  const out = ['経路表(C = 直結、S = 静的、O = OSPF。[優先度/メトリック])'];
  for (const r of rs) out.push(r.proto === 'C' ? ` C  ${pad(r.prefix, 20)} 直結  ${r.iface}` : ` ${r.proto}  ${pad(r.prefix, 20)} [${r.ad}/${r.metric}] 次 ${r.via || '—'}  ${r.iface}`);
  if (rs.length <= 0) out.push(' (経路が無い)');
  return out.join('\n');
}
function showIfBrief(s, dev) {
  const out = [`${pad('IF', 12)} ${pad('アドレス', 20)} 状態`];
  for (const f of dev.ifaces) { const up = !f.shutdown && (f.vlanId || f.parent || M.linkUp(s.net, dev.name, f.name) || false); out.push(`${pad(f.name, 12)} ${pad(f.ip && !hidden(dev, 'ip') ? `${f.ip}/${f.len}` : '—', 20)} ${f.shutdown ? 'admin down(止めてある)' : up ? 'up' : 'down(線が無い)'}`); }
  return out.join('\n');
}
function showArp(s, dev) { const st = s.api.state(s.net); const rows = st.arp[dev.name] || []; return [`${pad('アドレス', 18)} ${pad('MAC', 20)} IF`, ...rows.map((r) => `${pad(r.ip, 18)} ${pad(r.mac || '—', 20)} ${r.iface}`), rows.length ? '' : '(なし)'].join('\n').trim(); }
function showAcl(dev) { if (hidden(dev, 'acl')) return 'ACL を見せられません'; const out = []; for (const [n, a] of Object.entries(dev.acls)) { out.push(`acl ${n} ${a.type}`); for (const l of a.lines) out.push(a.type === 'standard' ? ` ${l.seq} ${l.action} ${l.src}` : ` ${l.seq} ${l.action} ${l.proto} ${l.src} ${l.dst}${l.dport !== null ? ` eq ${l.dport}` : ''}`); } return out.length ? out.join('\n') : 'ACL は無い'; }
function showNat(s, dev) {
  if (hidden(dev, 'nat')) return 'NAT を見せられません';
  const out = [];
  for (const x of dev.nat.static) out.push(` 静的 ${x.proto} 内 ${x.insideIp}:${x.insidePort} ⇄ 外 ${x.outsideIp}:${x.outsidePort}`);
  for (const r of dev.nat.source) out.push(` NAPT ${r.src} → ${r.iface} のアドレス(ポートは付け替え)`);
  out.push(` 内側 IF: ${dev.nat.inside.join(' ') || '—'} / 外側 IF: ${dev.nat.outside.join(' ') || '—'}`);
  return out.join('\n');
}
function showOspf(s, dev) { const st = s.api.state(s.net); if (hidden(dev, 'ospf')) return 'OSPF を見せられません'; const ns = st.ospfNeighbors.filter((n) => n.a === dev.name || n.b === dev.name).map((n) => (n.a === dev.name ? `${n.b}(${n.bIp})` : `${n.a}(${n.aIp})`)); return ns.length ? ['OSPF のネイバー:', ...ns.map((x) => ` ${x}  FULL`)].join('\n') : 'OSPF のネイバーはいない'; }
function showVrrp(s, dev) { const st = s.api.state(s.net); const gs = st.vrrp.filter((g) => g.members.some((m) => m.dev === dev.name)); return gs.length ? gs.map((g) => { const me = g.members.find((m) => m.dev === dev.name); return `グループ ${g.group} 仮想 ${g.vip}: 自分は ${g.master === dev.name ? '代表(マスター)' : 'バックアップ'}(優先度 ${me.priority})。代表は ${g.master}`; }).join('\n') : 'VRRP は無い'; }
function showDhcp(s, dev) { const st = s.api.state(s.net); if (hidden(dev, 'dhcp')) return 'DHCP を見せられません'; const ps = st.dhcp.pools[dev.name] || []; return ps.length ? ps.map((p) => `${p.name}(${p.network}): 配った ${p.bindings.map((b) => `${b.ip} → ${b.host}`).join('、') || 'なし'}。残り ${p.free}`).join('\n') : 'DHCP の範囲は無い'; }
function showVlan(s, dev) { const st = s.api.state(s.net); const v = st.vlans[dev.name] || {}; return [`${pad('VLAN', 6)} ポート`, ...Object.entries(v).map(([id, x]) => `${pad(id, 6)} ${x.ports.join(' ') || '—'}`)].join('\n'); }
function showTrunk(s, dev) { const rows = dev.ifaces.filter((f) => f.mode === 'trunk'); return rows.length ? [`${pad('ポート', 10)} ${pad('ネイティブ', 10)} 許可 VLAN`, ...rows.map((f) => `${pad(f.name, 10)} ${pad(f.native, 10)} ${f.allowed ? [...f.allowed].sort((a, b) => a - b).join(',') : 'all'}`)].join('\n') : 'トランクは無い'; }
function showMac(s, dev) { const st = s.api.state(s.net); const rows = st.macTables[dev.name] || []; return [`${pad('VLAN', 6)} ${pad('MAC', 20)} ポート`, ...rows.map((r) => `${pad(r.vlan, 6)} ${pad(r.mac, 20)} ${r.port}`), rows.length ? '' : '(なし)'].join('\n').trim(); }
function showStp(s, dev) { const st = s.api.state(s.net); const b = st.stp.bridges[dev.name]; if (!b) return 'STP の情報は無い'; const out = [`ルートブリッジ: ${st.stp.root}${st.stp.root === dev.name ? '(このスイッチ)' : ''}。自分のブリッジ ID ${b.bid}、根までのコスト ${b.cost}`]; for (const [p, role] of Object.entries(b.ports)) out.push(` ${pad(p, 10)} ${role === 'alternate' ? '代替(止めている)' : role === 'root' ? 'ルート(転送)' : '指定(転送)'}`); return out.join('\n'); }
function showLag(s, dev) { const st = s.api.state(s.net); const g = st.lag[dev.name] || {}; const ks = Object.keys(g); return ks.length ? ks.map((id) => `束 ${id}: ${g[id].members.join(' ')} → ${g[id].up ? '束になっている' : '束になっていない(相手の設定が合わない)'}`).join('\n') : '束は無い'; }
function showSnoop(dev) { return `DHCP スヌーピング: ${dev.dhcpSnooping ? '有効' : '無効'}。信頼するポート: ${dev.ifaces.filter((f) => f.snoopingTrust).map((f) => f.name).join(' ') || '—'}`; }
function ipconfig(s, dev) {
  const st = s.api.state(s.net); const e = st.endpoints.find((x) => x.dev === dev.name && !x.virtual); const f = dev.ifaces[0]; const lease = st.dhcp.leases[dev.name];
  return [`IPv4 アドレス: ${e ? `${e.ip}/${e.len}` : dev.dhcpClient ? '(DHCP からもらえていない)' : '(なし)'}${lease ? '(DHCP でもらった)' : ''}`, `デフォルトゲートウェイ: ${lease ? lease.gateway : dev.gateway || '(なし)'}`, `DNS サーバー: ${lease ? lease.dns || '(なし)' : dev.dns || '(なし)'}`, `MAC アドレス: ${f.mac}`, f.ipv6 ? `IPv6 アドレス: ${f.ipv6}` : null].filter(Boolean).join('\n');
}
function hostRoutes(s, dev) { const st = s.api.state(s.net); return (st.routes[dev.name] || []).map((r) => `${pad(r.prefix, 20)} ${r.via ? `ゲートウェイ ${r.via}` : '直結'}`).join('\n') || '(なし)'; }

function exec(s, lineRaw) {
  s.count += 1;
  const line = String(lineRaw || '').trim();
  if (line) s.history.push(line);
  const dev = s.net.devices[s.device];
  if (s.mode === 'config') {
    if (/^end$/i.test(line)) {
      const r = s.api.applyConfig(s.net, s.device, s.cfgLines.join('\n'));
      s.mode = 'exec'; s.cfgLines = [];
      return r.ok ? '設定を当てました' : `設定を当てましたが、読めない行がありました:\n${r.errors.map((e) => ` 行 ${e.line}: ${e.text} — ${e.message}`).join('\n')}`;
    }
    s.cfgLines.push(line);
    if (s.cfgLines.length > 40) { s.mode = 'exec'; s.cfgLines = []; return '1 回の設定は 40 行まで。やり直してください'; }
    return `${s.device}(config)# ${line}`;
  }
  const w = line.split(/\s+/); const lw = w.map((x) => x.toLowerCase()); const cmd = lw.join(' ');
  if (!line) return '';
  if (lw[0] === 'help' || lw[0] === '?') return `使えるコマンド: ${cmdsFor(dev).join(' / ')}`;
  if (lw[0] === 'connect') { const n = w[1]; const d = n && (s.net.devices[n] || s.net.devices[n.toUpperCase()]); if (!d) return `機器 ${n || ''} が無い(${Object.keys(s.net.devices).join('・')})`; s.device = d.name; return `${d.name} につなぎました(${d.kind})`; }
  if (lw[0] === 'exit') { s.device = s.start; return `${s.start} に戻りました`; }
  if (['int', 'sh', 'conf', 'tr'].includes(lw[0])) return `省略形は使えません(${lw[0] === 'sh' ? 'show' : lw[0] === 'conf' ? 'configure' : lw[0] === 'tr' ? 'traceroute' : 'interface'} と書く。Tab で補えます)`;
  if (lw[0] === 'configure') { if (!s.net.editable.includes(s.device)) return 'この機器は設定できません'; s.mode = 'config'; s.cfgLines = []; return `${s.device} の設定を始めます。1 行ずつ打ち、end で当てます`; }
  if (lw[0] === 'ping') return w[1] ? pingOut(s, w[1]) : 'ping <アドレスか名前>';
  if (lw[0] === 'traceroute' || lw[0] === 'tracert') return w[1] ? traceOut(s, w[1]) : 'traceroute <アドレスか名前>';
  if (M.HOST_KINDS.has(dev.kind)) {
    if (cmd === 'ipconfig' || cmd === 'ip addr' || cmd === 'ifconfig') return ipconfig(s, dev);
    if (cmd === 'arp -a' || cmd === 'ip neigh') return showArp(s, dev);
    if (cmd === 'route print' || cmd === 'ip route') return hostRoutes(s, dev);
    if (lw[0] === 'nslookup' || lw[0] === 'dig') { if (!w[1]) return 'nslookup <名前>'; const r = resolveName(s, w[1]); return r.lines.concat(r.ip && !r.lines.length ? [`${w[1]}  A  ${r.ip}`] : []).join('\n') || `${w[1]} → ${r.ip}`; }
    return `知らないコマンドです。help で一覧`;
  }
  if (lw[0] === 'show') {
    const rest = lw.slice(1).join(' ');
    const isL3 = dev.kind !== 'switch'; const isSw = dev.kind === 'switch' || dev.kind === 'l3switch';
    if (rest === 'running-config') return s.api.runningConfig(s.net, dev.name, { hide: dev.hidden || [] }).join('\n') || '(設定なし)';
    if (rest === 'ip interface brief') return showIfBrief(s, dev);
    if (isL3 && rest === 'ip route') return showIpRoute(s, dev);
    if (isL3 && rest === 'ip arp') return showArp(s, dev);
    if (isL3 && rest === 'access-lists') return showAcl(dev);
    if (isL3 && rest === 'ip nat translations') return showNat(s, dev);
    if (isL3 && rest === 'ip ospf neighbor') return showOspf(s, dev);
    if (isL3 && rest === 'vrrp') return showVrrp(s, dev);
    if (isL3 && rest === 'ip dhcp binding') return showDhcp(s, dev);
    if (isSw && rest === 'vlan') return showVlan(s, dev);
    if (isSw && rest === 'interfaces trunk') return showTrunk(s, dev);
    if (isSw && rest === 'mac address-table') return showMac(s, dev);
    if (isSw && rest === 'spanning-tree') return showStp(s, dev);
    if (isSw && rest === 'etherchannel summary') return showLag(s, dev);
    if (isSw && rest === 'ip dhcp snooping') return showSnoop(dev);
    return `show のあとが読めません。help で一覧`;
  }
  return `知らないコマンドです。help で一覧`;
}

// Tab 補完: コマンドの語・IF 名・機器名だけ(アドレスは補わない)
function completions(s, partial) {
  const dev = s.net.devices[s.device];
  const p = String(partial || '');
  const words = new Set();
  if (s.mode === 'config') { for (const w of ['interface', 'ip address', 'ip route', 'no', 'shutdown', 'no shutdown', 'switchport mode', 'switchport access vlan', 'switchport trunk allowed vlan', 'switchport trunk native vlan', 'vlan', 'router ospf', 'network', 'acl', 'nat', 'vrrp', 'dhcp pool', 'dhcp relay', 'dhcp exclude', 'spanning-tree', 'channel-group', 'ospf cost', 'encapsulation dot1q', 'gateway', 'dns', 'end', 'exit']) words.add(w); }
  else for (const w of cmdsFor(dev)) words.add(w);
  for (const f of dev.ifaces) words.add(f.name);
  for (const n of Object.keys(s.net.devices)) words.add(n);
  const low = p.toLowerCase();
  return [...words].filter((w) => w.toLowerCase().startsWith(low) && w.toLowerCase() !== low).sort();
}

module.exports = { session, exec, completions, cmdsFor };
