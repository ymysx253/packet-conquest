'use strict';
// 模擬の小道具: アドレスの計算と IF 名の正規形(docs/questions/SIM-API.md)。外へは何もつながない。
const { normalize } = require('../questions/normalize');

const ipToInt = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intToIp = (n) => [24, 16, 8, 0].map((b) => Math.floor(n / 2 ** b) % 256).join('.');
const sizeOf = (len) => 2 ** (32 - len);
const netOf = (n, len) => n - (n % sizeOf(len));
const inNet = (ip, net, len) => netOf(ipToInt(ip), len) === netOf(ipToInt(net), len);
const isIpv4 = (s) => normalize('ipv4', s) !== null;
// 'a.b.c.d/len' か 'a.b.c.d mask' → { ip, len }。読めなければ null
function parseCidr(s) {
  const c = normalize('ipv4cidr', s);
  if (!c) return null;
  const [ip, len] = c.split('/');
  return { ip, len: Number(len) };
}
const cidrOf = (ip, len) => `${intToIp(netOf(ipToInt(ip), len))}/${len}`;
const bcastOf = (ip, len) => intToIp(netOf(ipToInt(ip), len) + sizeOf(len) - 1);
const isPrivate = (ip) => inNet(ip, '10.0.0.0', 8) || inNet(ip, '172.16.0.0', 12) || inNet(ip, '192.168.0.0', 16);

// IF 名の正規形(見せる形)。'gigabitethernet0/1'・'gi 0/1'・'g0/1' → 'Gi0/0'。副 IF 'Gi0/0.10' も読む。読めなければ null
const DISPLAY = { gi: 'Gi', fa: 'Fa', te: 'Te', eth: 'Eth', null: 'Null', lo: 'Lo', vlan: 'Vlan' };
function canonIf(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  const m = /^(.*?)\.(\d+)$/.exec(t);
  const base = normalize('ifname', m ? m[1] : t);
  if (!base) return null;
  const k = /^[a-z]+/.exec(base)[0];
  const disp = (DISPLAY[k] || k) + base.slice(k.length);
  return m ? `${disp}.${Number(m[2])}` : disp;
}
const ifKey = (dev, name) => `${dev}:${name}`;

// 小さい決定的な乱数(MAC や id を spec の中身から決めるため。rng が無いときだけ使う)
function hash32(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
const hex2 = (n) => (n & 255).toString(16).padStart(2, '0');
function macFrom(seedStr) { const h = hash32(seedStr), g = hash32(`${seedStr}#2`); return `02:00:${hex2(h >>> 24)}:${hex2(h >>> 16)}:${hex2(g >>> 8)}:${hex2(g)}`; }

const clone = (x) => JSON.parse(JSON.stringify(x));

module.exports = { ipToInt, intToIp, sizeOf, netOf, inNet, isIpv4, parseCidr, cidrOf, bcastOf, isPrivate, canonIf, ifKey, hash32, macFrom, clone };
