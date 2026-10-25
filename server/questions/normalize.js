'use strict';
// 入力式の答えの正規化と判定(docs/questions/COMMON.md 第 3 章・第 4 章)。
//   normalize(format, s, opts) → 正規形の文字列。形式不備は null(例外にしない)。冪等
//   judge(q, inputs) / judgeChoice(q, choice) / judgeText(q, inputs)
// 正解側(accept)も同じ関数を通した正規形で持つ。判定は正規形どうしの比較。

const { v6Canonical } = require('./basics');
const VOCAB = require('./data/vocab.json');

// ---------- 共通の前処理 ----------
const FULL_TO_HALF = (s) => s
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角英数字・記号
  .replace(/　/g, ' ')
  .replace(/[．。]/g, '.').replace(/：/g, ':').replace(/／/g, '/').replace(/[－−ー]/g, '-').replace(/，、/g, ',');
function pre(s, { keepCase = false } = {}) {
  if (s === undefined || s === null) return null;
  let t = FULL_TO_HALF(String(s)).trim().replace(/\s+/g, ' ');
  if (!keepCase) t = t.toLowerCase();
  return t;
}
const stripAlias = (s) => pre(s).replace(/\s+/g, '').replace(/アドレス/g, '').replace(/[・･]/g, '');

// ---------- 個別の形式 ----------
const UNIT_WORDS = /(番目|個|台|本|行|回|バイト|ビット|秒|ミリ秒|ms|マイクロ秒|µs|us|byte|bytes|bit|bits|kbps|mbps|gbps|ms)$/;
function number(s, { decimal = false } = {}) {
  let t = pre(s); if (t === null) return null;
  t = t.replace(/,/g, '').replace(/\s+/g, '').replace(UNIT_WORDS, '').replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  if (!decimal && t.includes('.')) return null;
  if (t.includes('.')) { t = t.replace(/0+$/, '').replace(/\.$/, ''); }
  const neg = t.startsWith('-'); t = t.replace(/^-/, '').replace(/^0+(?=\d)/, '');
  return (neg && t !== '0' ? '-' : '') + t;
}
function ipv4(s) {
  const t = pre(s); if (t === null) return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t); if (!m) return null;
  const o = m.slice(1).map(Number); if (o.some((x) => x > 255)) return null;
  return o.join('.');
}
function maskToLen(mask) {
  const a = ipv4(mask); if (!a) return null;
  const n = a.split('.').reduce((acc, x) => ((acc << 8) | Number(x)) >>> 0, 0);
  const inv = (~n) >>> 0;
  if ((inv & (inv + 1)) !== 0) return null; // 連続 1 でない
  let len = 0; for (let i = 31; i >= 0 && (n >>> i) & 1; i--) len++;
  return len;
}
function prefixlen(s) {
  let t = pre(s); if (t === null) return null;
  t = t.replace(/^\//, '');
  if (/^\d{1,3}$/.test(t)) { const n = Number(t); return n <= 128 ? String(n) : null; }
  const len = maskToLen(t); return len === null ? null : String(len);
}
function ipv4cidr(s) {
  const t = pre(s); if (t === null) return null;
  let m = /^(\S+)\/(\d{1,2})$/.exec(t);
  if (m) { const a = ipv4(m[1]); const n = Number(m[2]); return a && n <= 32 ? `${a}/${n}` : null; }
  m = /^(\S+) (\S+)$/.exec(t);
  if (m) { const a = ipv4(m[1]); const len = maskToLen(m[2]); return a && len !== null ? `${a}/${len}` : null; }
  return null;
}
function ipv6(s) {
  const t = pre(s); if (t === null) return null;
  if (/[\[\]]/.test(t) || (t.match(/::/g) || []).length > 1 || !/^[0-9a-f:]+$/.test(t)) return null;
  let head = t, tail = '';
  if (t.includes('::')) [head, tail] = t.split('::');
  const hg = head ? head.split(':') : [], tg = tail ? tail.split(':') : [];
  if (hg.concat(tg).some((g) => g === '' || g.length > 4)) return null;
  if (!t.includes('::') && hg.length !== 8) return null;
  if (t.includes('::') && hg.length + tg.length > 7) return null;
  const groups = hg.map((g) => parseInt(g, 16)).concat(new Array(8 - hg.length - tg.length).fill(0), tg.map((g) => parseInt(g, 16)));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return v6Canonical(groups);
}
function ipv6cidr(s) {
  const t = pre(s); if (t === null) return null;
  const m = /^(\S+)\/(\d{1,3})$/.exec(t); if (!m) return null;
  const a = ipv6(m[1]); const n = Number(m[2]);
  return a && n <= 128 ? `${a}/${n}` : null;
}
function bin(s, { digits } = {}) {
  let t = pre(s); if (t === null) return null;
  t = t.replace(/[\s._]/g, '');
  if (!/^[01]+$/.test(t)) return null;
  if (digits) { if (t.length > digits) return null; return t.padStart(digits, '0'); }
  return t.replace(/^0+(?=[01])/, '');
}
function hex(s, { digits } = {}) {
  let t = pre(s); if (t === null) return null;
  t = t.replace(/^0x/, '').replace(/[\s._]/g, '');
  if (!/^[0-9a-f]+$/.test(t)) return null;
  if (digits) { if (t.length > digits) return null; return t.padStart(digits, '0'); }
  return t.replace(/^0+(?=[0-9a-f])/, '');
}
function mac(s) {
  let t = pre(s); if (t === null) return null;
  t = t.replace(/[\s:.\-]/g, '');
  if (!/^[0-9a-f]+$/.test(t) || (t.length !== 12 && t.length !== 6)) return null;
  return t.match(/.{2}/g).join(':');
}
function token(s, { vocab } = {}) {
  const table = VOCAB[vocab]; if (!table) return null;
  const key = stripAlias(s); if (!key) return null;
  for (const [id, aliases] of Object.entries(table)) {
    if (stripAlias(id) === key) return id;
    if (aliases.some((a) => stripAlias(a) === key)) return id;
  }
  return null;
}
const yesno = (s) => token(s, { vocab: 'yesno' });
function addrport(s) {
  const t = pre(s); if (t === null) return null;
  const m = /^(\S+):(\d{1,5})$/.exec(t); if (!m) return null;
  const a = ipv4(m[1]); const p = Number(m[2]);
  return a && p >= 1 && p <= 65535 ? `${a}:${p}` : null;
}
function ifname(s) {
  let t = pre(s); if (t === null) return null;
  t = t.replace(/\s+/g, '');
  let m = /^(gigabitethernet|gige|gi|g)(\d+(?:\/\d+)*)$/.exec(t); if (m) return `gi${m[2]}`;
  m = /^(fastethernet|fa|f)(\d+(?:\/\d+)*)$/.exec(t); if (m) return `fa${m[2]}`;
  m = /^(tengigabitethernet|te)(\d+(?:\/\d+)*)$/.exec(t); if (m) return `te${m[2]}`;
  m = /^(ethernet|eth|e)(\d+(?:\/\d+)*)$/.exec(t); if (m) return `eth${m[2]}`;
  m = /^(null|nu)(\d+)$/.exec(t); if (m) return `null${m[2]}`;
  m = /^(loopback|lo)(\d+)$/.exec(t); if (m) return `lo${m[2]}`;
  m = /^(vlan|vl)(\d+)$/.exec(t); if (m) return `vlan${m[2]}`;
  return null;
}
function devname(s) {
  const t = pre(s); if (t === null) return null;
  const d = t.replace(/[\s\-_]/g, '');
  return /^[a-z0-9]+$/.test(d) ? d : null;
}
function dnsname(s) {
  let t = pre(s); if (t === null) return null;
  t = t.replace(/\s+/g, '').replace(/\.$/, '');
  if (!t || t.split('.').some((l) => l === '') || !/^[a-z0-9.\-_]+$/.test(t)) return null;
  return t;
}
function aclverdict(s) {
  const t = pre(s); if (t === null) return null;
  const parts = t.replace(/\s+/g, ' ').split(' ').filter(Boolean);
  let action = null, num = null, implicit = false;
  const joined = parts.join('');
  if (/暗黙|implicit/.test(joined)) implicit = true;
  for (const p of parts) {
    const tk = token(p, { vocab: 'aclverdict' });
    if (tk === 'permit' || tk === 'deny') action = tk;
    else if (tk === 'implicit') implicit = true;
    else if (/^\d+$/.test(p)) num = String(Number(p));
  }
  if (implicit) return 'deny implicit';
  if (!action || num === null) return null;
  return `${action} ${num}`;
}
function prefixplan(s) {
  if (s === undefined || s === null) return null;
  const t = FULL_TO_HALF(String(s)).toLowerCase(); // 改行は行の区切りなので pre() で潰さない
  const lines = t.split(/[\n,;]+/).map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) return null;
    const name = devname(parts[0]); const c4 = ipv4cidr(parts[1]); const c6 = parts[2] !== undefined ? ipv6cidr(parts[2]) : undefined;
    if (!name || !c4 || c6 === null) return null;
    rows.push([name, c4].concat(c6 !== undefined ? [c6] : []).join(' '));
  }
  return rows.sort().join('\n');
}

const FORMATS = { number, ipv4, ipv4cidr, ipv6, ipv6cidr, prefixlen, bin, hex, mac, yesno, token, addrport, ifname, devname, dnsname, aclverdict, prefixplan };

function normalize(format, s, opts = {}) {
  const f = FORMATS[format];
  if (!f) return null;
  try { return f(s, opts); } catch { return null; }
}

// ---------- 判定 ----------
function judgeChoice(q, choice) { return Number.isInteger(choice) && choice === q.answerIndex; }
const VERIFIERS = {}; // 名前 → (args, normalizedInputs) => boolean。Lv99 の plan-verifier などを後で登録する
function registerVerifier(name, fn) { VERIFIERS[name] = fn; }
function judgeText(q, inputs) {
  const fields = Array.isArray(q.fields) ? q.fields : [];
  if (!Array.isArray(inputs) || inputs.length !== fields.length || !fields.length) return false;
  const norm = fields.map((f, i) => normalize(f.format, inputs[i], f));
  if (norm.some((x) => x === null)) return false;
  if (q.verifier && VERIFIERS[q.verifier.name]) return !!VERIFIERS[q.verifier.name](q.verifier.args, norm, q);
  if (q.compare === 'set') {
    const want = fields.map((f) => f.accept[0]).sort(); const got = norm.slice().sort();
    return want.length === got.length && want.every((v, i) => v === got[i]);
  }
  return fields.every((f, i) => (f.accept || []).includes(norm[i]));
}
// ---------- 構成図のタップと設定の判定(docs/questions/SIM-API.md 第 5 章。2026-10-25) ----------
const TAP_ONE = new Set(['one', 'port', 'link']); // 1 つだけ選ぶ形
const TAP_MAX = 12, TAP_ID_MAX = 64;
const CFG_DEVICES_MAX = 8, CFG_LINES_MAX = 40, CFG_LINE_CHARS_MAX = 120;
// タップ: answer は { ids }。one/port/link は 1 つが同じ、many は集合が同じ(重複なし)、order は列が同じ
function judgeTap(q, answer) {
  const ids = answer && Array.isArray(answer.ids) ? answer.ids : null;
  const want = q.accept && Array.isArray(q.accept.ids) ? q.accept.ids : null;
  if (!ids || !want || !ids.length || !want.length || ids.length > TAP_MAX || ids.some((x) => typeof x !== 'string' || !x || x.length > TAP_ID_MAX)) return false;
  const mode = (q.tap && q.tap.mode) || 'one';
  if (TAP_ONE.has(mode)) return ids.length === 1 && want.length === 1 && ids[0] === want[0];
  if (mode === 'order') return ids.length === want.length && ids.every((x, i) => x === want[i]);
  const a = [...new Set(ids)].sort(), b = [...new Set(want)].sort();
  return a.length === ids.length && a.length === b.length && a.every((x, i) => x === b[i]);
}
// 設定: answer は { configs: [{ device, text }] }。形と上限(1 台 40 行・1 行 120 字・editable の機器だけ)を見てから、模擬(server/sim)で要件を判定する。
// 返すのは { correct, failed(満たさなかった要件 id), errors([{ device, line, message }]) }
function judgeConfigDetail(q, answer) {
  const bad = (message) => ({ correct: false, failed: [], errors: [{ device: null, line: 0, message }] });
  const configs = answer && Array.isArray(answer.configs) ? answer.configs : null;
  if (!configs || !configs.length || configs.length > CFG_DEVICES_MAX) return bad('答えの形が違います');
  const spec = q.sim && q.sim.spec;
  if (!spec) return bad('この問題には構成がありません');
  const editable = Array.isArray(q.editable) ? q.editable : (spec.editable || []);
  const errors = [];
  for (const c of configs) {
    if (!c || typeof c.device !== 'string' || typeof c.text !== 'string') return bad('答えの形が違います');
    if (!editable.includes(c.device)) { errors.push({ device: c.device, line: 0, message: `${c.device} は設定できません(設定できるのは ${editable.join('・') || 'なし'})` }); continue; }
    const lines = c.text.replace(/\r/g, '').split('\n');
    if (lines.length > CFG_LINES_MAX) errors.push({ device: c.device, line: 0, message: `1 台 ${CFG_LINES_MAX} 行まで` });
    const long = lines.findIndex((l) => l.length > CFG_LINE_CHARS_MAX);
    if (long >= 0) errors.push({ device: c.device, line: long + 1, message: `1 行 ${CFG_LINE_CHARS_MAX} 字まで` });
  }
  if (errors.length) return { correct: false, failed: [], errors };
  const sim = require('../sim'); // util.js がこのファイルを読むので、ここで遅く読む(循環を避ける)
  const withReqs = Array.isArray(spec.requirements) && spec.requirements.length ? spec : { ...spec, requirements: (q.sim.requirements || []) };
  const r = sim.judgeConfig(withReqs, configs);
  return { correct: !!r.ok, failed: r.failed || [], errors: (r.errors || []).map((e) => ({ device: e.device || null, line: e.line || 0, message: e.message })) };
}
function judge(q, answer) {
  if (q.answerKind === 'text') return judgeText(q, answer);
  if (q.answerKind === 'tap') return judgeTap(q, answer);
  if (q.answerKind === 'config') return judgeConfigDetail(q, answer).correct;
  return judgeChoice(q, answer);
}
// 判定と、その理由(設定の問題だけ failed・errors が入る。ほかは空)。world.js と cl-preview.js はこちらを使う
function judgeDetail(q, answer) {
  if (q.answerKind === 'config') return judgeConfigDetail(q, answer);
  return { correct: judge(q, answer), failed: [], errors: [] };
}

module.exports = { normalize, judge, judgeDetail, judgeTap, judgeChoice, judgeText, registerVerifier, FORMATS, VOCAB, TAP_MAX, TAP_ID_MAX, CFG_DEVICES_MAX, CFG_LINES_MAX, CFG_LINE_CHARS_MAX };
