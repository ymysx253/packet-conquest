'use strict';
// 模擬の本体の口(docs/questions/SIM-API.md 第 3 章)。構成(spec)を build し、状態を計算し、届くかを確かめ、設定を当て、要件を判定し、ターミナルと図を出す。
// 外へは何もつながない。打った字は読むだけ。乱数は gen に渡す rng だけ(Math.random は使わない)
const U = require('./util');
const M = require('./model');
const L2 = require('./l2');
const L3 = require('./l3');
const S = require('./services');
const C = require('./config');
const T = require('./terminal');
const D = require('./diagram');
const G = require('./netgen');

// Set を含む構造の写し(_state は写さない)
function deepClone(x) {
  if (x instanceof Set) return new Set([...x]);
  if (Array.isArray(x)) return x.map(deepClone);
  if (x && typeof x === 'object') { const o = {}; for (const [k, v] of Object.entries(x)) { if (k === '_state') continue; o[k] = deepClone(v); } return o; }
  return x;
}
const build = (spec) => M.build(spec);
const clone = (net) => { const c = deepClone(net); c._state = null; return c; };

// 状態の計算(キャッシュ。設定を当てると消える)
function state(net) {
  if (net._state) return net._state;
  const l2 = L2.computeL2(net);
  const dhcp = S.computeDhcp(net, l2);
  const st = { net, l2, dhcp, endpoints: L3.buildEndpoints(net, l2, dhcp.leases) };
  st.vrrp = S.computeVrrp(net, st);
  st.routes = L3.computeRoutes(net, st);
  st.arp = L3.arpTables(net, st);
  st.macTables = l2.macTables; st.stp = l2.stp; st.lag = l2.lag; st.domains = l2.domains; st.vlans = l2.vlans;
  st.ospfNeighbors = (st.ospf ? st.ospf.nbrs : []).map((n) => ({ a: n.a.dev, aIp: n.a.ip, b: n.b.dev, bIp: n.b.ip }));
  net._state = st;
  return st;
}
// 機器を止めた・線を切った状態(写しの上で)
function stateWith(net, { down = [], cut = [] } = {}) {
  const c = clone(net);
  for (const name of down) { const d = c.devices[name]; if (d) for (const f of d.ifaces) f.shutdown = true; }
  for (const pair of cut) {
    const ends = pair.map((e) => { const [dn, pn] = String(e).split(':'); const d = c.devices[dn]; if (!d) return null; return pn ? `${dn}:${U.canonIf(pn)}` : `${dn}:${d.ifaces[0].name}`; });
    for (const l of c.links) { const ka = `${l.a.dev}:${l.a.iface}`, kb = `${l.b.dev}:${l.b.iface}`; if ((ka === ends[0] && kb === ends[1]) || (ka === ends[1] && kb === ends[0])) l.up = false; }
  }
  return state(c);
}
const reach = (net, from, to, opts) => L3.reach(net, state(net), from, to, opts);
const trace = (net, from, toIp) => L3.trace(net, state(net), from, toIp);
function check(net, reqs) {
  const st = state(net);
  const helpers = { reach: (f, t, o) => L3.reach(net, st, f, t, o), reachIn: (s2, f, t, o) => L3.reach(s2.net, s2, f, t, o), stateWith: (o) => stateWith(net, o) };
  return S.check(net, st, reqs, helpers);
}
const applyConfig = (net, dev, text) => C.apply(net, dev, text);
const checkSyntax = (spec, dev, text) => C.apply(build(spec), dev, text);
const LINE_LIMIT = 40, CHAR_LIMIT = 120;
// 設定を当てて要件を判定(configs: [{ device, text }])
function judgeConfig(spec, configs) {
  const net = build(spec);
  const errors = [];
  for (const c of configs || []) {
    const dev = c && c.device;
    if (!net.devices[dev]) { errors.push({ device: dev, line: 0, message: `機器 ${dev} が無い` }); continue; }
    if (!net.editable.includes(dev)) { errors.push({ device: dev, line: 0, message: `${dev} は設定できません(設定できるのは ${net.editable.join('・') || 'なし'})` }); continue; }
    const lines = String(c.text || '').replace(/\r/g, '').split('\n');
    if (lines.length > LINE_LIMIT) { errors.push({ device: dev, line: 0, message: `1 台 ${LINE_LIMIT} 行まで` }); continue; }
    const long = lines.findIndex((l) => l.length > CHAR_LIMIT); if (long >= 0) { errors.push({ device: dev, line: long + 1, message: `1 行 ${CHAR_LIMIT} 字まで` }); continue; }
    const r = C.apply(net, dev, c.text);
    for (const e of r.errors) errors.push({ device: dev, ...e });
  }
  const results = check(net, net.requirements);
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  return { ok: errors.length === 0 && failed.length === 0, failed, errors, results, net };
}

const session = (spec, start) => T.session(spec, start, { build, state, reach, trace, applyConfig, runningConfig: C.runningConfig });
const exec = (s, line) => T.exec(s, line);
const completions = (s, partial) => T.completions(s, partial);
const diagram = (spec, opts) => D.diagram(build(spec), opts || {});
const runningConfig = (net, dev, opts) => C.runningConfig(net, dev, opts);

module.exports = { build, clone, state, stateWith, applyConfig, checkSyntax, reach, trace, check, judgeConfig, session, exec, completions, diagram, runningConfig, gen: G, util: U, deepClone };
