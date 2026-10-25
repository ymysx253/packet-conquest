'use strict';
// 画面に送る図(docs/questions/SIM-API.md 第 5 章)。型ごとの座標の表で置き、無い名前は列(BFS の段)で並べる。正解の情報は含めない。
// 決めたこと:
//   - viewBox は 1000 × 600。機器の記号の半径は 26 とみなし、ポートの丸は相手の方へ 34 の所に置く
//   - 線の文字(label)は、両端が同じ網のアドレスを持つときだけその網(/30 など)。スイッチとホストの線には書かない
//   - note(そばに書く文字)は showIps のとき IF のアドレス(ホストはアドレスとゲートウェイ)。hidden の項目(routes など)は図には出ない(そもそも図に経路は無い)
const U = require('./util');
const L2 = require('./l2');

const W = 1000, H = 600;
const LAYOUTS = {
  serial: { PC1: [80, 300], PC3: [80, 150], PC4: [80, 450], PC5: [160, 110], PC6: [160, 490], SW1: [230, 300], R1: [390, 300], R2: [540, 300], R3: [690, 300], SW2: [840, 300], PC2: [930, 300] },
  triangle: { PC1: [130, 420], R1: [300, 300], R2: [500, 110], R3: [700, 300], PC2: [870, 420], SW1: [210, 360], SW2: [790, 360] },
  square: { PC1: [70, 300], SW1: [160, 300], R1: [280, 300], R2: [500, 110], R3: [500, 490], R4: [720, 300], SW2: [840, 300], PC2: [930, 300] },
  'two-sites': { PC1: [70, 170], SRV1: [70, 430], SW1: [200, 300], R1: [340, 300], FW1: [420, 300], ISP: [500, 300], INET: [500, 110], R2: [660, 300], SW2: [800, 300], PC2: [930, 300], SRV2: [930, 430] },
  'two-switches': { PC1: [90, 150], PC2: [90, 450], SW1: [300, 300], SW2: [700, 300], PC3: [910, 150], PC4: [910, 450], L3SW1: [500, 110], R1: [500, 110] },
  cloud: { INET: [500, 60], IGW: [300, 170], NATGW: [700, 170], 'SUB-A': [240, 320], 'SUB-B': [500, 320], 'SUB-C': [760, 320], VM1: [240, 500], VM2: [500, 500], VM3: [760, 500] },
};
const KIND_OF = { router: 'router', switch: 'switch', l3switch: 'l3switch', host: 'host', server: 'server', firewall: 'firewall', internet: 'internet', 'cloud-subnet': 'cloud', 'cloud-gw': 'gateway', dhcp: 'server' };

// 座標が無い機器を BFS の段で並べる(左から)
function autoLayout(net, pos) {
  const names = Object.keys(net.devices).filter((n) => !pos[n]);
  if (!names.length) return pos;
  const adj = {}; for (const l of net.links) { (adj[l.a.dev] = adj[l.a.dev] || []).push(l.b.dev); (adj[l.b.dev] = adj[l.b.dev] || []).push(l.a.dev); }
  const level = {}; const start = Object.keys(net.devices).find((n) => net.devices[n].kind === 'host') || Object.keys(net.devices)[0];
  const q = [start]; level[start] = 0;
  while (q.length) { const c = q.shift(); for (const n of adj[c] || []) if (level[n] === undefined) { level[n] = level[c] + 1; q.push(n); } }
  for (const n of Object.keys(net.devices)) if (level[n] === undefined) level[n] = 0;
  const cols = {}; for (const n of names) (cols[level[n]] = cols[level[n]] || []).push(n);
  const keys = Object.keys(cols).map(Number).sort((a, b) => a - b);
  keys.forEach((k, i) => { const col = cols[k]; const x = 80 + ((W - 160) * (keys.length === 1 ? 0.5 : i / (keys.length - 1))); col.forEach((n, j) => { pos[n] = [Math.round(x), Math.round(80 + ((H - 160) * (col.length === 1 ? 0.5 : j / (col.length - 1))))]; }); });
  return pos;
}

function diagram(net, { nodeIds = {}, showIps = true, showPorts = true, hidePorts = [] } = {}) {
  let pos = {}; let w = W, h = H;
  if (net.layout && typeof net.layout === 'object') { pos = { ...(net.layout.pos || {}) }; w = net.layout.w || W; h = net.layout.h || H; }
  else if (net.layout && LAYOUTS[net.layout]) pos = { ...LAYOUTS[net.layout] };
  for (const k of Object.keys(pos)) if (!net.devices[k]) delete pos[k];
  autoLayout(net, pos);
  const idOf = (n) => nodeIds[n] || n;
  const nodes = Object.values(net.devices).map((d) => {
    const [x, y] = pos[d.name];
    let note = null;
    if (showIps) {
      const hide = d.hidden || [];
      if (d.kind === 'host' || d.kind === 'server' || d.kind === 'internet') { const f = d.ifaces[0]; note = [f && f.ip ? `${f.ip}/${f.len}` : (d.dhcpClient ? 'DHCP' : ''), d.gateway && !hide.includes('gateway') ? `GW ${d.gateway}` : ''].filter(Boolean).join('\n') || null; }
      else if (d.kind === 'cloud-subnet') note = d.cidr;
      // ルーターなどの IF のアドレスは各ポートの note に置く(SIM-API.md 第 9 章。機器の下にまとめると文字が重なる)。副 IF と SVI は機器の note に残す
      else if (!hide.includes('ip')) note = d.ifaces.filter((f) => f.ip && (f.parent || f.vlanId)).map((f) => `${f.name} ${f.ip}/${f.len}`).join('\n') || null;
    }
    const ports = [];
    if (showPorts && !(d.kind === 'host' || d.kind === 'server' || d.kind === 'internet' || d.kind === 'cloud-gw')) {
      const hideIp = !showIps || (d.hidden || []).includes('ip');
      for (const l of net.links) for (const [me, other] of [[l.a, l.b], [l.b, l.a]]) {
        if (me.dev !== d.name || hidePorts.includes(`${d.name}:${me.iface}`)) continue;
        const [ox, oy] = pos[other.dev]; const dx = ox - x, dy = oy - y; const len = Math.hypot(dx, dy) || 1;
        const f = d.ifByName[me.iface];
        ports.push({ id: `${idOf(d.name)}:${me.iface}`, name: me.iface, x: Math.round(x + (dx / len) * 34), y: Math.round(y + (dy / len) * 34), note: !hideIp && f && f.ip ? `${f.ip}/${f.len}` : null });
      }
    }
    return { id: idOf(d.name), name: d.name, kind: KIND_OF[d.kind] || d.kind, x, y, note, ports };
  });
  const links = net.links.map((l, i) => {
    const da = net.devices[l.a.dev], db = net.devices[l.b.dev];
    const fa = da.ifByName[l.a.iface], fb = db.ifByName[l.b.iface];
    let label = null;
    if (fa && fb && fa.ip && fb.ip && fa.len === fb.len && U.inNet(fa.ip, fb.ip, fa.len) && !(da.hidden || []).includes('ip') && !(db.hidden || []).includes('ip')) label = U.cidrOf(fa.ip, fa.len);
    const trunk = (fa && fa.mode === 'trunk') || (fb && fb.mode === 'trunk');
    const hostEnd = (d) => d.kind === 'host' || d.kind === 'server' || d.kind === 'internet';
    return { id: `l${U.hash32(`${net.seed}|${i}`).toString(16).slice(0, 6)}`, a: { node: idOf(l.a.dev), port: hostEnd(da) ? null : l.a.iface }, b: { node: idOf(l.b.dev), port: hostEnd(db) ? null : l.b.iface }, label, style: trunk ? 'bold' : l.up ? 'solid' : 'dash' };
  });
  const groups = [];
  if (net.layout === 'two-sites') { groups.push({ id: 'g-hq', label: '本社', nodes: ['PC1', 'SRV1', 'SW1', 'R1', 'FW1'].filter((n) => net.devices[n]).map(idOf) }); groups.push({ id: 'g-br', label: '支社', nodes: ['R2', 'SW2', 'PC2', 'SRV2'].filter((n) => net.devices[n]).map(idOf) }); }
  if (net.layout === 'cloud') groups.push({ id: 'g-vnet', label: '仮想網', nodes: Object.keys(net.devices).filter((n) => n.startsWith('SUB-') || n.startsWith('VM')).map(idOf) });
  return { w, h, nodes, links, groups };
}

module.exports = { diagram, LAYOUTS, W, H };
