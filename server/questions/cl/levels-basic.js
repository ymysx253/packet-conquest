'use strict';
// 初級(新しい番号 68〜158。docs/LEVEL-LIST.md 第 3 章)の問題。担当: 初級。書き方は docs/questions/CL.md
// 作るのは一覧の「担当」が O で「今の問題」が空(新規)の行。「今の問題」が埋まっている行は levels-legacy.js の担当、
// 構成図・設定・模擬ターミナルの行(149〜158)は仕組みがまだ無いので作らない。
// 初級の決まり: 1 問 20〜40 秒。4 択と入力を混ぜる。ヒント(hint: 式や手順)と解説(explanation)を必ず付ける。
// 表の問題は「問い → 答え」の組(関係)から作る。正解は組にある答え、誤答は組に無い答えから選ぶので、正解が 2 つの並べ方は作れない。
// meta は確かめ用(何を問うたか)。verify が表から答えを引き直し、選択肢のうち正しいものが 1 つだけであることを確かめる。
// 生成の問題は verify が別の方法(2 進の文字列・BigInt・数え上げ)で解き直す。meta と accept は画面には送らない。
// 乱数は引数の rng(rng.js の makeRng)だけを使う。アドレスはプライベートと文書用の範囲(と種別を問う題材の境界の例)だけ。
const { loadFacts, choices, trueFalse } = require('./build');
const { normalize } = require('../normalize');

// ---------- 表の読み込み ----------
const ROW = new Map(); // '<表>/<id>' → 行(verify が引き直す)
function F(name) {
  const rows = loadFacts(`basic/${name}.json`);
  for (const r of rows) ROW.set(`${name}/${r.id}`, r);
  return rows;
}
const OSI = F('osi');
const TCPIP = F('tcpip');
const PROTO = F('protocols');
const DEV = F('layer-devices');
const DECAP = F('decap');
const TOPO = F('topology');
const SWITCHING = F('switching');
const CIDR = F('cidr');
const SPECIAL = F('special-addr');
const LINKLOCAL = F('linklocal');
const V6RULES = F('ipv6-rules');
const ARP = F('arp');
const CAST = F('cast');
const DROUTE = F('default-route');
const DHCP = F('dhcp');
const DNSREC = F('dns-records');
const METHODS = F('http-methods');
const METHOD_EX = F('http-methods-ex');
const STATUS = F('http-status');
const STATUS_CLASS = F('http-status-class');
const NAT = F('nat');
const CIA = F('cia');
const AUTHN = F('authn');
const MFA = F('mfa');
const ACLI = F('acl-implicit');
const CRYPTO = F('crypto');
const WBAND = F('wifi-band');
const WSTD = F('wifi-std');
const WSEC = F('wifi-sec');
const CABLE = F('cable');
const CABLE_FACTS = F('cable-facts');
const POE = F('poe');
const POE_FACTS = F('poe-facts');
const PING = F('ping-output');
const CLOUD = F('cloud');
const VIRT = F('virtual');
const VMC = F('vm-container');
const REMOTE = F('remote');
const REMOTE_EX = F('remote-ex');
const VDI = F('vdi');

const typed = (rows, t) => rows.filter((r) => r.attrs.type === t);
const uniq = (a) => [...new Set(a)];
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const TF_TEXT = (s) => `次の文は正しいですか。\n「${s}」`;
const kindOf = (lv, name) => `cl${lv}-${name}-v1`;
// 英数字で終わる名前のあとに助詞を続けるときは空白を 1 つ入れる(「TCP は」「IaaS の」)。日本語で終わる名前はそのまま
const w = (s) => (/[A-Za-z0-9]$/.test(s) ? `${s} ` : s);

// ---------- 関係(問い → 答え の組)から作る ----------
// also の組は「そうとも言える」答え(L3 スイッチは第 2 層でも働く など)。正解にも誤答にも使わない
const RELS = {};
function rel(name, pairs, also = []) {
  const m = new Map(); const a = new Map();
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(v); };
  for (const [k, v] of pairs) add(m, k, v);
  for (const [k, v] of also) add(a, k, v);
  const R = {
    name, keys: [...m.keys()], values: uniq(pairs.map((p) => p[1])),
    main: (k, v) => !!(m.get(k) && m.get(k).has(v)),
    has: (k, v) => R.main(k, v) || !!(a.get(k) && a.get(k).has(v)),
    of: (k) => [...(m.get(k) || [])],
  };
  if (RELS[name]) throw new Error(`関係 ${name} が 2 つあります`);
  RELS[name] = R;
  return R;
}
// key を問う n 択。正解は R にある答え、誤答は pool のうち R に無い答え
function relChoice(rng, R, { key, pool = R.values, n = 4, notKey = false } = {}) {
  const k = key !== undefined ? key : rng.pick(R.keys);
  if (notKey) pool = pool.filter((v) => v !== k); // 問いと同じものを誤答に出さない
  const corrects = R.of(k).filter((v) => pool.includes(v));
  must(corrects.length, `${R.name}: ${k} の答えが選択肢の候補にありません`);
  const correct = rng.pick(corrects);
  const c = choices(rng, correct, pool.filter((v) => !R.has(k, v)), n);
  return { ...c, key: k, correct, meta: { type: 'rel', rel: R.name, key: k } };
}
// ○×: R の組(○)か、R に無い組(×)。also の組は使わない
function relTf(rng, R, { key, pool = R.values, wantTrue } = {}) {
  const k = key !== undefined ? key : rng.pick(R.keys);
  const t = wantTrue !== undefined ? wantTrue : rng.next() < 0.5;
  const cand = t ? R.of(k).filter((v) => pool.includes(v)) : pool.filter((v) => !R.has(k, v));
  must(cand.length, `${R.name}: ${k} の ${t ? '○' : '×'} の文が作れません`);
  const v = rng.pick(cand);
  const tf = trueFalse('', t);
  return { options: tf.options, answerIndex: tf.answerIndex, key: k, val: v, isTrue: t, meta: { type: 'reltf', rel: R.name, key: k, val: v } };
}
// 表の 1 行の問いと答え(attrs.answer、誤答は attrs.wrongs。誤答はどれも正しくないことを人が確かめてある)
function qaChoice(rng, file, row, n = 4) {
  const c = choices(rng, row.attrs.answer, row.attrs.wrongs, n);
  return { ...c, text: row.ja, explanation: `正解は${/^「/.test(row.attrs.answer) ? row.attrs.answer : `「${row.attrs.answer}」`}。${row.attrs.why}`, meta: { type: 'qa', row: `${file}/${row.id}` } };
}
// 表の 1 行の ○×(attrs.true)
function rowTf(file, row) {
  const tf = trueFalse(row.ja, row.attrs.true);
  return { text: TF_TEXT(row.ja), options: tf.options, answerIndex: tf.answerIndex, explanation: `「${row.ja}」は${row.attrs.true ? '正しい' : '誤り'}。${row.attrs.why}`, meta: { type: 'tf', row: `${file}/${row.id}` } };
}
const tfWord = (t) => (t ? '正しい' : '誤り');

// 入力の問題(1 欄)。accept は normalize を通した正規形
function input(name, label, format, accept, fhint, extra = {}) {
  return { answerKind: 'text', fields: [{ name, label, format, hint: fhint, ...extra, accept: accept.map((a) => normalize(format, a, extra)) }], compare: 'ordered' };
}
// 並べ替え: 項目に 1 から番号を振って見せ、正しい順の番号を - でつないで入力する(devname の正規化で - と空白を除いて比べる)
const RANK = {}; // 並べ替えの種類 → (項目) → 順位
function orderQ(rng, rankKey, items, desc) {
  const rankOf = RANK[rankKey];
  let shown; let ans; let guard = 0;
  do {
    shown = rng.shuffle(items);
    const idx = shown.map((_, i) => i + 1);
    ans = idx.slice().sort((a, b) => (rankOf(shown[a - 1]) - rankOf(shown[b - 1])) * (desc ? -1 : 1)).join('-');
  } while (ans === shown.map((_, i) => i + 1).join('-') && guard++ < 20); // 見せた順がそのまま答えになる並びは避ける
  return {
    list: shown.map((x, i) => `${i + 1} ${x}`).join('\n'), answer: ans,
    ...input('order', '順番', 'devname', [ans], '番号を - でつなぐ'),
    meta: { type: 'order', rank: rankKey, labels: shown, desc },
  };
}
const ORDER_NOTE = '番号を、並べた順に - でつないで入力してください(空白で区切ってもよい)。';

// ---------- アドレスの道具(作る側。32 ビットの整数) ----------
const ip2n = (s) => s.split('.').reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0) >>> 0;
const n2ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskN = (p) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
const inNet = (ip, net, p) => ((ip2n(ip) & maskN(p)) >>> 0) === ip2n(net);
// 確かめる側の道具(別の方法: 2 進の文字列と BigInt)
const bitsOf = (s) => s.split('.').map((x) => Number(x).toString(2).padStart(8, '0')).join('');
const bigOf = (s) => s.split('.').reduce((a, x) => a * 256n + BigInt(x), 0n);
const ipOfBig = (b) => [24n, 16n, 8n, 0n].map((k) => String((b >> k) & 255n)).join('.');
const sameNetBits = (ip, net, p) => bitsOf(ip).slice(0, p) === bitsOf(net).slice(0, p);

const o8 = (rng) => rng.rand(0, 255);
function privAddr(rng, which = rng.rand(0, 2)) {
  if (which === 0) return `10.${o8(rng)}.${o8(rng)}.${rng.rand(1, 254)}`;
  if (which === 1) return `172.${rng.rand(16, 31)}.${o8(rng)}.${rng.rand(1, 254)}`;
  return `192.168.${o8(rng)}.${rng.rand(1, 254)}`;
}
const DOC_NETS = ['192.0.2', '198.51.100', '203.0.113'];
const docAddr = (rng) => `${rng.pick(DOC_NETS)}.${rng.rand(1, 254)}`;
const v6doc = (rng) => `2001:db8:${rng.rand(1, 0xffff).toString(16)}::${rng.rand(1, 0xffff).toString(16)}`;
const ZONES = ['shibuya', 'ueno', 'asakusa', 'kanda', 'nakano', 'ikebukuro', 'shinjuku', 'meguro', 'aoba', 'minato', 'sakura', 'kawagoe'];
const HOSTS = ['www', 'shop', 'blog', 'app', 'news', 'map', 'info', 'cafe'];
const zoneOf = (rng) => `${rng.pick(ZONES)}.example`;

// ========== 層(Lv68〜77) ==========
const osiRow = (n) => OSI.find((r) => r.attrs.no === n);
const osiNoOf = (name) => OSI.find((r) => r.ja === name).attrs.no;
const LAYER = (n) => `第 ${n} 層`;
const LAYER_FULL = (n) => `第 ${n} 層(${osiRow(n).ja})`;
const OSI_NAMES = OSI.map((r) => r.ja);
const OSI_LIST = '下から 物理(1)・データリンク(2)・ネットワーク(3)・トランスポート(4)・セッション(5)・プレゼンテーション(6)・アプリケーション(7)';
const R_OSI_NO = rel('osi-no-name', OSI.map((r) => [r.attrs.no, r.ja]));
const R_OSI_NAME = rel('osi-name-no', OSI.map((r) => [r.ja, LAYER(r.attrs.no)]));
const R_OSI_ROLE = rel('osi-role-name', OSI.map((r) => [r.attrs.role, r.ja]));
const R_OSI_EN = rel('osi-en-name', OSI.map((r) => [r.attrs.en, r.ja]));
RANK.osi = (name) => osiNoOf(name);

// OSI の層の名前・番号・役割(lo〜hi の層を問う)
function osiLayerQ(rng, lo, hi) {
  const n = rng.rand(lo, hi); const row = osiRow(n);
  const form = rng.pick(['no', 'count', 'name', 'role', 'en', 'tf']);
  let q;
  if (form === 'no' || form === 'count') {
    q = relChoice(rng, R_OSI_NO, { key: n, pool: OSI_NAMES });
    q.text = form === 'no' ? `OSI 参照モデルの第 ${n} 層は?` : (lo === 1 ? `OSI 参照モデルで、下から ${n} 番目の層は?` : `OSI 参照モデルで、上から ${8 - n} 番目の層は?`);
  } else if (form === 'name') {
    q = relChoice(rng, R_OSI_NAME, { key: row.ja, pool: OSI.map((r) => LAYER(r.attrs.no)) });
    q.text = `${row.ja}は、OSI 参照モデルの第何層?`;
  } else if (form === 'role') {
    q = relChoice(rng, R_OSI_ROLE, { key: row.attrs.role, pool: OSI_NAMES });
    q.text = `次の役割を受け持つのは、OSI 参照モデルのどの層?\n「${row.attrs.role}」`;
  } else if (form === 'en') {
    q = relChoice(rng, R_OSI_EN, { key: row.attrs.en, pool: OSI_NAMES });
    q.text = `OSI 参照モデルの ${row.attrs.en} 層は、日本語で何と呼ぶ?`;
  } else {
    q = relTf(rng, R_OSI_NO, { key: n, pool: OSI_NAMES });
    q.text = TF_TEXT(`OSI 参照モデルの第 ${n} 層は、${q.val}である`);
  }
  const wrongNote = form === 'tf' && !q.isTrue ? `${q.val}は第 ${osiNoOf(q.val)} 層。` : '';
  q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : ''}第 ${n} 層は${row.ja}(${row.attrs.role})。${wrongNote}OSI 参照モデルは${OSI_LIST}。`;
  return q;
}

// ---------- TCP/IP ----------
const tcpipLabel = (r) => (r.attrs.alt ? `${r.ja}(${r.attrs.alt})` : r.ja);
const tcpipById = (id) => TCPIP.find((r) => r.id === id);
const TCPIP_LABELS = TCPIP.map(tcpipLabel);
const NOT_TCPIP = ['セッション層', 'プレゼンテーション層'];
const osiRange = (r) => (r.attrs.osi.length === 1 ? `第 ${r.attrs.osi[0]} 層` : `第 ${r.attrs.osi[0]}〜${r.attrs.osi[r.attrs.osi.length - 1]} 層`);
const R_TCPIP_ORDER = rel('tcpip-order', TCPIP.map((r) => [r.attrs.order, tcpipLabel(r)]));
const R_TCPIP_ROLE = rel('tcpip-role', TCPIP.map((r) => [r.attrs.role, tcpipLabel(r)]));
const R_PROTO_TCPIP = rel('proto-tcpip', PROTO.map((p) => [p.ja, tcpipLabel(tcpipById(p.attrs.tcpip))]));
const R_OSI_TCPIP = rel('osi-tcpip', TCPIP.flatMap((r) => r.attrs.osi.map((n) => [n, tcpipLabel(r)])));
const RANGE_POOL = uniq(TCPIP.map(osiRange).concat(['第 2〜3 層', '第 4〜5 層', '第 6〜7 層']));
const R_TCPIP_RANGE = rel('tcpip-osirange', TCPIP.map((r) => [tcpipLabel(r), osiRange(r)]));
const R_RANGE_TCPIP = rel('osirange-tcpip', TCPIP.map((r) => [osiRange(r), tcpipLabel(r)]));
const TCPIP_LIST = 'TCP/IP は下から リンク(OSI 1〜2)・インターネット(3)・トランスポート(4)・アプリケーション(5〜7)';

// ---------- 層と機器 ----------
const LOOK = { none: 'なにも見ず、受けた信号をそのまま中継する', mac: '宛先の MAC アドレスを見て、転送先を決める', ip: '宛先の IP アドレスを見て、転送先を決める' };
const DEV_LAYERS = [1, 2, 3, 4, 7].map(LAYER);
const R_DEV_LAYER = rel('dev-layer', DEV.map((d) => [d.ja, LAYER(d.attrs.layer)]), DEV.flatMap((d) => (d.attrs.also || []).map((n) => [d.ja, LAYER(n)])));
const R_LAYER_DEV = rel('layer-dev', DEV.map((d) => [LAYER(d.attrs.layer), d.ja]), DEV.flatMap((d) => (d.attrs.also || []).map((n) => [LAYER(n), d.ja])));
const R_LOOK_DEV = rel('look-dev', DEV.map((d) => [LOOK[d.attrs.looks], d.ja]), DEV.flatMap((d) => (d.attrs.alsoLooks || []).map((l) => [LOOK[l], d.ja])));
const devRow = (name) => DEV.find((d) => d.ja === name);

// ---------- プロトコルと層 ----------
const PROTO_NAMES = PROTO.map((p) => p.ja);
const PROTO_LAYERS = [1, 2, 3, 4, 7].map(LAYER_FULL);
const R_PROTO_OSI = rel('proto-osi', PROTO.map((p) => [p.ja, LAYER_FULL(p.attrs.osi)]));
const R_OSI_PROTO = rel('osi-proto', PROTO.map((p) => [LAYER_FULL(p.attrs.osi), p.ja]));
const protoRow = (name) => PROTO.find((p) => p.ja === name);

// ---------- データのまとまり ----------
const PDUS = OSI.filter((r) => r.attrs.pdu).map((r) => r.attrs.pdu).concat(['メッセージ']);
const R_LAYER_PDU = rel('layer-pdu', OSI.filter((r) => r.attrs.pdu).map((r) => [LAYER_FULL(r.attrs.no), r.attrs.pdu]));
const R_PDU_LAYER = rel('pdu-layer', OSI.filter((r) => r.attrs.pdu).map((r) => [r.attrs.pdu, LAYER_FULL(r.attrs.no)]));
// プロトコル → まとまり(UDP の「データグラム」は IP にも使う呼び名なので出さない。ICMP は IP の中身なので出さない)
const R_PROTO_PDU = rel('proto-pdu', PROTO.filter((p) => [2, 3, 4].includes(p.attrs.osi) && !['udp', 'icmp'].includes(p.id)).map((p) => [p.ja, osiRow(p.attrs.osi).attrs.pdu]));
const R_DEV_PDU = rel('dev-pdu', DEV.map((d) => [d.ja, osiRow(d.attrs.layer).attrs.pdu]), DEV.flatMap((d) => (d.attrs.also || []).map((n) => [d.ja, osiRow(n).attrs.pdu])));

// ---------- カプセル化 ----------
const HEADERS = PROTO.filter((p) => p.attrs.header);
const DATA_LABEL = 'アプリのデータ';
const headerOsi = (label) => (label === DATA_LABEL ? 7 : HEADERS.find((p) => p.attrs.header === label).attrs.osi);
RANK.encap = headerOsi;
const hdr = (id) => PROTO.find((p) => p.id === id).attrs.header;

const LEVELS = {
  // ---------- Lv68 OSI の下 4 層の名前 ----------
  68: {
    title: 'OSI の下 4 層の名前', kind: '表', minDistinct: 30,
    make(rng) {
      const q = osiLayerQ(rng, 1, 4);
      return { ...q, hint: '下から 1 物理・2 データリンク・3 ネットワーク・4 トランスポート', kind: kindOf(68, 'osi-lower') };
    },
    verify: checkMeta,
  },
  // ---------- Lv69 OSI の下 4 層の順番(並べ替え) ----------
  69: {
    title: 'OSI の下 4 層の順番', kind: '表', minDistinct: 30,
    make(rng) {
      const desc = rng.next() < 0.4;
      const o = orderQ(rng, 'osi', OSI.filter((r) => r.attrs.no <= 4).map((r) => r.ja), desc);
      const want = o.answer.split('-').map((i) => o.meta.labels[Number(i) - 1]).join(' → ');
      return {
        text: `OSI 参照モデルの次の 4 つの層を、${desc ? '上(第 4 層)から下へ' : '下(第 1 層)から上へ'}並べてください。${ORDER_NOTE}\n${o.list}`,
        answerKind: o.answerKind, fields: o.fields, compare: o.compare, meta: o.meta,
        hint: '線(物理)→ 隣(データリンク)→ 網(ネットワーク)→ 端から端(トランスポート)',
        explanation: `${desc ? '上から' : '下から'} ${want}。答えは ${o.answer}。下から 物理(1)・データリンク(2)・ネットワーク(3)・トランスポート(4)。`,
        kind: kindOf(69, 'osi-order'),
      };
    },
    verify: checkMeta,
  },
  // ---------- Lv70 OSI の上 3 層 ----------
  70: {
    title: 'OSI の上 3 層', kind: '表', minDistinct: 30,
    make(rng) {
      const q = osiLayerQ(rng, 5, 7);
      return { ...q, hint: '5 セッション・6 プレゼンテーション・7 アプリケーション(いちばん上が 7)', kind: kindOf(70, 'osi-upper') };
    },
    verify: checkMeta,
  },
  // ---------- Lv71 TCP/IP の 4 階層 ----------
  71: {
    title: 'TCP/IP の 4 階層', kind: '表', minDistinct: 30,
    make(rng) {
      const form = rng.pick(['order', 'proto', 'proto', 'osi', 'role', 'not']);
      let q;
      if (form === 'order') {
        const k = rng.rand(1, 4);
        q = relChoice(rng, R_TCPIP_ORDER, { key: k, pool: TCPIP_LABELS.concat(NOT_TCPIP) });
        q.text = `TCP/IP の 4 階層で、下から ${k} 番目の層は?`;
      } else if (form === 'proto') {
        const p = rng.pick(PROTO);
        q = relChoice(rng, R_PROTO_TCPIP, { key: p.ja, pool: TCPIP_LABELS });
        q.text = `${w(p.ja)}が働くのは、TCP/IP の 4 階層のどの層?`;
      } else if (form === 'osi') {
        const n = rng.rand(1, 7);
        q = relChoice(rng, R_OSI_TCPIP, { key: n, pool: TCPIP_LABELS });
        q.text = `OSI 参照モデルの第 ${n} 層(${osiRow(n).ja})にあたる、TCP/IP の層は?`;
      } else if (form === 'role') {
        const r = rng.pick(TCPIP);
        q = relChoice(rng, R_TCPIP_ROLE, { key: r.attrs.role, pool: TCPIP_LABELS });
        q.text = `次の役割を受け持つのは、TCP/IP のどの層?\n「${r.attrs.role}」`;
      } else {
        const odd = rng.pick(NOT_TCPIP);
        const three = rng.shuffle(TCPIP_LABELS).slice(0, 3);
        const options = rng.shuffle(three.concat([odd]));
        q = { options, answerIndex: options.indexOf(odd), meta: { type: 'not-tcpip' } };
        q.text = 'TCP/IP の 4 階層に「無い」層は?';
      }
      q.explanation = `${form === 'not' ? `${q.options[q.answerIndex]}は OSI 参照モデルの層で、TCP/IP ではアプリケーション層にまとめられている。` : `正解は「${q.options[q.answerIndex]}」。`}${TCPIP_LIST}。IP・ICMP はインターネット層、TCP・UDP はトランスポート層、HTTP・DNS などはアプリケーション層。`;
      return { ...q, hint: '下から リンク・インターネット・トランスポート・アプリケーション', kind: kindOf(71, 'tcpip-layers') };
    },
    verify(q) { if (q.meta.type === 'not-tcpip') { const bad = q.options.filter((o) => !TCPIP_LABELS.includes(o)); must(bad.length === 1 && bad[0] === q.options[q.answerIndex], 'Lv71: TCP/IP に無い層が 1 つでない'); } else checkMeta(q); },
  },
  // ---------- Lv72 TCP/IP と OSI の対応 ----------
  72: {
    title: 'TCP/IP と OSI の対応', kind: '表', minDistinct: 30,
    make(rng) {
      const form = rng.pick(['range', 'range', 'back', 'tf']);
      const r = rng.pick(TCPIP);
      let q;
      if (form === 'range') {
        q = relChoice(rng, R_TCPIP_RANGE, { key: tcpipLabel(r), pool: RANGE_POOL });
        q.text = `TCP/IP の${tcpipLabel(r)}は、OSI 参照モデルのどこにあたる?`;
      } else if (form === 'back') {
        q = relChoice(rng, R_RANGE_TCPIP, { key: osiRange(r), pool: TCPIP_LABELS });
        q.text = `OSI 参照モデルの${osiRange(r)}(${r.attrs.osi.map((n) => osiRow(n).ja).join('・')})にあたる、TCP/IP の層は?`;
      } else {
        q = relTf(rng, R_TCPIP_RANGE, { key: tcpipLabel(r), pool: RANGE_POOL });
        q.text = TF_TEXT(`TCP/IP の${tcpipLabel(r)}は、OSI 参照モデルの${q.val}にあたる`);
      }
      q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : ''}TCP/IP の${tcpipLabel(r)}は OSI の${osiRange(r)}にあたる。${TCPIP_LIST}。OSI の上 3 層は TCP/IP のアプリケーション層 1 つにまとめられている。`;
      return { ...q, hint: 'リンク = OSI 1〜2、インターネット = 3、トランスポート = 4、アプリケーション = 5〜7(上 3 層を 1 つにまとめた)', kind: kindOf(72, 'tcpip-osi') };
    },
    verify: checkMeta,
  },
  // ---------- Lv73 層と機器 ----------
  73: {
    title: '層と機器', kind: '表', minDistinct: 30,
    make(rng) {
      const form = rng.pick(['dev', 'dev', 'layer', 'look', 'tf']);
      let q; let d;
      if (form === 'dev') {
        d = rng.pick(DEV);
        q = relChoice(rng, R_DEV_LAYER, { key: d.ja, pool: DEV_LAYERS });
        q.text = `${d.ja}が主に働くのは、OSI 参照モデルの第何層?`;
      } else if (form === 'layer') {
        const n = rng.pick([1, 2, 3]);
        q = relChoice(rng, R_LAYER_DEV, { key: LAYER(n), pool: DEV.map((x) => x.ja) });
        d = devRow(q.correct);
        q.text = `OSI 参照モデルの第 ${n} 層で主に働く機器は?`;
      } else if (form === 'look') {
        const look = rng.pick(Object.keys(LOOK));
        q = relChoice(rng, R_LOOK_DEV, { key: LOOK[look], pool: DEV.map((x) => x.ja) });
        d = devRow(q.correct);
        q.text = `${LOOK[look]}のは、どの機器?`;
      } else {
        d = rng.pick(DEV);
        q = relTf(rng, R_DEV_LAYER, { key: d.ja, pool: DEV_LAYERS.slice(0, 4) });
        q.text = TF_TEXT(`${d.ja}が主に働くのは、OSI 参照モデルの${q.val}である`);
      }
      const others = q.options.filter((o) => DEV.some((x) => x.ja === o) && o !== d.ja).map((o) => `${o}は第 ${devRow(o).attrs.layer} 層`);
      q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : ''}${d.ja}は主に第 ${d.attrs.layer} 層で働く(${LOOK[d.attrs.looks]})。${others.length ? `${others.join('、')}。` : ''}ハブ・リピーターは第 1 層、スイッチ・ブリッジは第 2 層、ルーターは第 3 層。`;
      return { ...q, hint: 'ハブ・リピーターは第 1 層、スイッチ・ブリッジは第 2 層(MAC を見る)、ルーターは第 3 層(IP を見る)', kind: kindOf(73, 'layer-device') };
    },
    verify: checkMeta,
  },
  // ---------- Lv74 層とプロトコル ----------
  74: {
    title: '層とプロトコル', kind: '表', minDistinct: 30,
    make(rng) {
      const form = rng.pick(['proto', 'proto', 'layer', 'tf']);
      let q; let p;
      if (form === 'proto') {
        p = rng.pick(PROTO);
        q = relChoice(rng, R_PROTO_OSI, { key: p.ja, pool: PROTO_LAYERS });
        q.text = `${w(p.ja)}は、OSI 参照モデルのどの層のプロトコル?`;
      } else if (form === 'layer') {
        const n = rng.pick([2, 3, 4, 7]);
        q = relChoice(rng, R_OSI_PROTO, { key: LAYER_FULL(n), pool: PROTO_NAMES });
        p = protoRow(q.correct);
        q.text = `OSI 参照モデルの${LAYER_FULL(n)}のプロトコルは?`;
      } else {
        p = rng.pick(PROTO);
        q = relTf(rng, R_PROTO_OSI, { key: p.ja, pool: [2, 3, 4, 7].map(LAYER_FULL) });
        q.text = TF_TEXT(`${w(p.ja)}は、OSI 参照モデルの${q.val}のプロトコルである`);
      }
      const others = q.options.filter((o) => PROTO_NAMES.includes(o) && o !== p.ja).map((o) => `${w(o)}は第 ${protoRow(o).attrs.osi} 層`);
      q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : ''}${w(p.ja)}は${LAYER_FULL(p.attrs.osi)}のプロトコル。${others.length ? `${others.join('、')}。` : ''}イーサネットは 2、IP・ICMP は 3、TCP・UDP は 4、HTTP・DNS などは 7。`;
      return { ...q, hint: 'イーサネット 2、IP・ICMP 3、TCP・UDP 4、HTTP・DNS など 7', kind: kindOf(74, 'layer-protocol') };
    },
    verify: checkMeta,
  },
  // ---------- Lv75 層ごとのデータの呼び名 ----------
  75: {
    title: '層ごとのデータの呼び名', kind: '表', minDistinct: 30,
    make(rng) {
      const form = rng.pick(['layer', 'pdu', 'proto', 'dev', 'tf']);
      let q;
      if (form === 'layer') {
        const n = rng.rand(1, 4);
        q = relChoice(rng, R_LAYER_PDU, { key: LAYER_FULL(n), pool: PDUS });
        q.text = `OSI 参照モデルの${LAYER_FULL(n)}で扱うデータのまとまりの呼び名は?${n === 4 ? '(TCP の場合)' : ''}`;
      } else if (form === 'pdu') {
        const pdu = rng.pick(R_PDU_LAYER.keys);
        q = relChoice(rng, R_PDU_LAYER, { key: pdu, pool: OSI.filter((r) => r.attrs.pdu).map((r) => LAYER_FULL(r.attrs.no)) });
        q.text = `「${pdu}」は、OSI 参照モデルのどの層のデータのまとまり?`;
      } else if (form === 'proto') {
        const p = rng.pick(R_PROTO_PDU.keys);
        q = relChoice(rng, R_PROTO_PDU, { key: p, pool: PDUS });
        q.text = `${w(p)}がやりとりするデータのまとまりの呼び名は?`;
      } else if (form === 'dev') {
        const d = rng.pick(DEV.filter((x) => x.attrs.layer >= 2 && !x.attrs.also));
        q = relChoice(rng, R_DEV_PDU, { key: d.ja, pool: PDUS });
        q.text = `${d.ja}が転送するときに扱うデータのまとまりは?`;
      } else {
        const n = rng.rand(1, 4);
        q = relTf(rng, R_LAYER_PDU, { key: LAYER_FULL(n), pool: PDUS.slice(0, 4) });
        q.text = TF_TEXT(`OSI 参照モデルの${LAYER_FULL(n)}のデータのまとまりは「${q.val}」と呼ぶ`);
      }
      q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}第 1 層はビット、第 2 層(イーサネットなど)はフレーム、第 3 層(IP)はパケット、第 4 層(TCP)はセグメント。スイッチはフレームを、ルーターはパケットを転送する。`;
      return { ...q, hint: '1 ビット、2 フレーム、3 パケット、4 セグメント(TCP)', kind: kindOf(75, 'pdu-name') };
    },
    verify: checkMeta,
  },
  // ---------- Lv76 カプセル化の順番(並べ替え) ----------
  76: {
    title: 'カプセル化の順番', kind: '表', minDistinct: 30,
    make(rng) {
      const l4 = rng.pick(['tcp', 'udp']);
      const withData = rng.next() < 0.5;
      const items = [hdr(l4), hdr('ipv4'), hdr('ethernet')].concat(withData ? [DATA_LABEL] : []);
      const form = rng.pick(['send', 'recv']);
      // 送る側: 内側(上の層)から外側へ = 層の番号の大きい順。受け取る側: 外側(下の層)から = 小さい順
      const o = orderQ(rng, 'encap', items, form === 'send');
      const ask = withData
        ? (form === 'send' ? '送る側で包まれたデータを、内側(中心)から外側へ順に並べてください。' : '受け取ったフレームを、外側(先頭)から内側へ順に並べてください。')
        : (form === 'send' ? '送る側で、ヘッダが付けられる順に並べてください。' : '受け取る側で、ヘッダが外される順に並べてください。');
      const want = o.answer.split('-').map((i) => o.meta.labels[Number(i) - 1]).join(' → ');
      return {
        text: `${l4.toUpperCase()} を使ってアプリのデータを送る。次の ${items.length} つを、${ask}${ORDER_NOTE}\n${o.list}`,
        answerKind: o.answerKind, fields: o.fields, compare: o.compare, meta: o.meta,
        hint: '送る側は上の層から順に外側へ包む(TCP・UDP → IP → イーサネット)。受け取る側はその逆',
        explanation: `${want}。答えは ${o.answer}。送る側は上の層(第 4 層の ${hdr(l4)})から順に付け、いちばん外側が第 2 層のイーサネットヘッダになる。受け取る側は外側から外す。`,
        kind: kindOf(76, 'encap-order'),
      };
    },
    verify: checkMeta,
  },
  // ---------- Lv77 受け取る側(○×) ----------
  77: {
    title: '受け取る側', kind: '表', minDistinct: 30,
    make(rng) {
      const form = rng.pick(['row', 'pair', 'pair', 'first']);
      if (form === 'row') return { ...rowTf('decap', rng.pick(DECAP)), hint: '包んだ逆の順に開ける: いちばん外のイーサネットから外す', kind: kindOf(77, 'decap') };
      const l4 = rng.pick(['tcp', 'udp']);
      const hs = [hdr('ethernet'), hdr('ipv4'), hdr(l4)];
      let stmt; let truth; let meta;
      if (form === 'pair') {
        const [a, b] = rng.shuffle(hs).slice(0, 2);
        const side = rng.pick(['recv', 'send']);
        stmt = side === 'recv' ? `受け取る側では、${a}を ${b}より先に外す` : `送る側では、${a}を ${b}より先に付ける`;
        truth = side === 'recv' ? headerOsi(a) < headerOsi(b) : headerOsi(a) > headerOsi(b);
        meta = { type: 'decap', form: 'pair', side, a, b };
      } else {
        const x = rng.pick(hs);
        const side = rng.pick(['recv', 'send']);
        stmt = side === 'recv' ? `${l4.toUpperCase()} の通信で、受け取る側が最初に外すのは${x}である` : `${l4.toUpperCase()} の通信で、送る側が最初に付けるのは${x}である`;
        truth = side === 'recv' ? x === hdr('ethernet') : x === hdr(l4);
        meta = { type: 'decap', form: 'first', side, x, l4: hdr(l4) };
      }
      const tf = trueFalse(stmt, truth);
      return {
        text: TF_TEXT(stmt), options: tf.options, answerIndex: tf.answerIndex, meta,
        hint: '包んだ逆の順に開ける: いちばん外のイーサネットから外す',
        explanation: `${tfWord(truth)}。送る側は ${hdr(l4)} → IP ヘッダ → イーサネットヘッダ の順に付け(上の層から外側へ)、受け取る側はその逆に イーサネットヘッダ → IP ヘッダ → ${hdr(l4)} の順に外す。`,
        kind: kindOf(77, 'decap'),
      };
    },
    verify(q) {
      if (q.meta.type !== 'decap') return checkMeta(q);
      const m = q.meta; let truth;
      // 別の引き方: 外側からの並び(受け取る側で外す順)を表から作り、位置で比べる
      const outer = [hdr('ethernet'), hdr('ipv4')];
      const pos = (h) => (outer.includes(h) ? outer.indexOf(h) : 2);
      if (m.form === 'pair') truth = m.side === 'recv' ? pos(m.a) < pos(m.b) : pos(m.a) > pos(m.b);
      else truth = m.side === 'recv' ? pos(m.x) === 0 : pos(m.x) === 2 && m.x === m.l4;
      must(q.answerIndex === (truth ? 0 : 1), `Lv77: ○× が合わない ${JSON.stringify(m)}`);
    },
  },
};

// ========== つなぎ方・交換(Lv80・81) ==========
const TOPO_NAMES = uniq(TOPO.map((r) => r.attrs.topo));
const R_TOPO = rel('topo', TOPO.map((r) => [r.ja, r.attrs.topo]));
const R_TOPO_DESC = rel('topo-desc', TOPO.map((r) => [r.attrs.topo, r.ja]));
const SW_NAME = { circuit: '回線交換', packet: 'パケット交換' };
const R_SW = rel('switching', SWITCHING.map((r) => [r.ja, SW_NAME[r.attrs.kind]]));
const R_SW_DESC = rel('switching-desc', SWITCHING.map((r) => [SW_NAME[r.attrs.kind], r.ja]));

LEVELS[80] = {
  title: 'つなぎ方の形', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['desc', 'desc', 'name', 'mesh']);
    const hint = 'スター = 中心に集まる、バス = 1 本の幹線、リング = 輪、メッシュ = 網の目、ツリー = 枝分かれ。フルメッシュの線の数は n(n−1)÷2';
    if (form === 'mesh') {
      const n = rng.rand(3, 12); const ans = n * (n - 1) / 2;
      const c = choices(rng, `${ans} 本`, uniq([n * (n - 1), n, n - 1, (n - 1) * (n - 2) / 2, n * n, 2 * n].filter((x) => x !== ans && x > 0)).map((x) => `${x} 本`));
      return {
        text: `${n} 台の機器を、どの 2 台の間にも直接の線があるようにつなぐ(フルメッシュ)。線は何本要る?`, ...c,
        meta: { type: 'mesh', n }, hint,
        explanation: `${n} 台から 2 台を選ぶ組の数だけ線が要る。${n} × ${n - 1} ÷ 2 = ${ans} 本(${n} × ${n - 1} だけだと、同じ線を両側から 2 回数えている)。`,
        kind: kindOf(80, 'topology'),
      };
    }
    let q;
    if (form === 'desc') {
      q = relChoice(rng, R_TOPO, { pool: TOPO_NAMES });
      q.text = `次のつなぎ方の形の名前は?\n「${q.key}」`;
    } else {
      q = relChoice(rng, R_TOPO_DESC, { pool: TOPO.map((r) => r.ja) });
      q.text = `${q.key}の説明に当たるのは?`;
    }
    q.explanation = `${form === 'desc' ? `「${q.key}」は${q.correct}。` : `${q.key}は「${q.correct}」。`}スター = 中心の 1 台に集まる、バス = 1 本の幹線、リング = 輪、メッシュ = 網の目、ツリー = 枝分かれ。`;
    return { ...q, hint, kind: kindOf(80, 'topology') };
  },
  verify(q) {
    if (q.meta.type !== 'mesh') return checkMeta(q);
    let lines = 0; for (let a = 0; a < q.meta.n; a++) for (let b = a + 1; b < q.meta.n; b++) lines++; // 組を数え上げる
    must(q.options[q.answerIndex] === `${lines} 本`, `Lv80: フルメッシュ ${q.meta.n} 台の線の数が合わない`);
    must(q.options.filter((o) => o === `${lines} 本`).length === 1, 'Lv80: 正解が 2 つ');
  },
};

LEVELS[81] = {
  title: '回線交換とパケット交換', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['which', 'which', 'desc', 'tf']);
    let q;
    if (form === 'which') {
      q = relChoice(rng, R_SW, { n: 2 });
      q.text = `次の説明に当たるのは、回線交換とパケット交換のどちら?\n「${q.key}」`;
    } else if (form === 'desc') {
      q = relChoice(rng, R_SW_DESC);
      q.text = `${q.key}に当てはまるのは?`;
    } else {
      q = relTf(rng, R_SW, {});
      q.text = TF_TEXT(`「${q.key}」のは、${q.val}の特徴である`);
    }
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}回線交換は、通信の間ずっと相手までの回線を占める(電話)。パケット交換は、データを小分けにして宛先を付け、1 本の回線を多くの通信で分け合う(インターネット)。`;
    return { ...q, hint: '電話は回線交換(道を占める)、データはパケット交換(小分けにして回線を分け合う)', kind: kindOf(81, 'switching') };
  },
  verify: checkMeta,
};

// ========== アドレス(Lv84・95〜101) ==========
LEVELS[84] = {
  title: 'マスク → プレフィックス長', kind: '生', minDistinct: 1000,
  make(rng) {
    const p = rng.rand(8, 32);
    const mask = n2ip(maskN(p));
    const addr = privAddr(rng);
    const octs = mask.split('.').map(Number);
    const ones = octs.map((x) => x.toString(2).split('').filter((b) => b === '1').length);
    return {
      text: `IPv4 アドレス ${addr}、サブネットマスク ${mask} を「${addr}/n」の形で書くとき、n はいくつ?`,
      ...input('prefix', 'n(プレフィックス長)', 'number', [String(p)], '数だけ(/ は付けない)'),
      meta: { type: 'mask2len', mask, p },
      hint: '区切りごとの 1 の数を足す: 255 = 8、254 = 7、252 = 6、248 = 5、240 = 4、224 = 3、192 = 2、128 = 1、0 = 0',
      explanation: `${mask} の区切りごとの 1 の数は ${ones.join(' + ')} = ${p}。だから /${p}(2 進: ${octs.map((x) => x.toString(2).padStart(8, '0')).join('.')})。`,
      kind: kindOf(84, 'mask-to-len'),
    };
  },
  verify(q) {
    const b = bitsOf(q.meta.mask);
    must(/^1*0*$/.test(b), `Lv84: マスクが 1 の続きでない ${q.meta.mask}`);
    const n = b.indexOf('0') === -1 ? 32 : b.indexOf('0');
    must(q.fields[0].accept[0] === String(n), `Lv84: ${q.meta.mask} は /${n}`);
  },
};

const CLASS_OPTS = ['クラス A', 'クラス B', 'クラス C', 'クラス D'];
const classOf = (first) => (first <= 126 ? 'クラス A' : first <= 191 ? 'クラス B' : first <= 223 ? 'クラス C' : 'クラス D');
LEVELS[95] = {
  title: 'クラス A・B・C', kind: '生', minDistinct: 1000,
  make(rng) {
    const form = rng.pick(['dec', 'bin', 'addr']);
    let first; let text; let addr = null;
    if (form === 'addr') {
      const pick = rng.rand(0, 6);
      addr = pick === 0 ? `10.${o8(rng)}.${o8(rng)}.${rng.rand(1, 254)}` : pick === 1 ? `172.${rng.rand(16, 31)}.${o8(rng)}.${rng.rand(1, 254)}`
        : pick === 2 ? `169.254.${rng.rand(1, 254)}.${o8(rng)}` : pick === 3 ? `192.168.${o8(rng)}.${rng.rand(1, 254)}`
          : pick === 4 ? docAddr(rng) : pick === 5 ? `${rng.rand(224, 239)}.${o8(rng)}.${o8(rng)}.${o8(rng)}` : `${rng.pick(['172.15', '172.32', '192.169'])}.${o8(rng)}.${rng.rand(1, 254)}`;
      first = Number(addr.split('.')[0]);
      text = `IPv4 アドレス ${addr} は、クラスで分けるとどれ?`;
    } else {
      const edges = [1, 10, 126, 128, 191, 192, 223, 224, 239];
      first = rng.next() < 0.3 ? rng.pick(edges) : rng.pick([rng.rand(1, 126), rng.rand(128, 239)]);
      text = form === 'dec'
        ? `先頭の区切りが ${first} の IPv4 アドレス(${first}.×.×.×)は、クラスで分けるとどれ?`
        : `先頭の 8 ビットが ${first.toString(2).padStart(8, '0')} の IPv4 アドレスは、クラスで分けるとどれ?`;
    }
    const ans = classOf(first);
    const options = rng.shuffle(CLASS_OPTS);
    return {
      text, options, answerIndex: options.indexOf(ans), meta: { type: 'class', first },
      hint: '先頭の数 1〜126 は A、128〜191 は B、192〜223 は C、224〜239 は D。2 進なら先頭が 0 → A、10 → B、110 → C、1110 → D',
      explanation: `先頭の区切りは ${first}(2 進 ${first.toString(2).padStart(8, '0')})なので${ans}。A は 1〜126(先頭 0)、B は 128〜191(10)、C は 192〜223(110)、D は 224〜239(1110)。`,
      kind: kindOf(95, 'addr-class'),
    };
  },
  verify(q) {
    const b = q.meta.first.toString(2).padStart(8, '0');
    must(q.meta.first !== 0 && q.meta.first !== 127 && q.meta.first < 240, `Lv95: 出さない先頭 ${q.meta.first}`);
    const want = b[0] === '0' ? 'クラス A' : b.startsWith('10') ? 'クラス B' : b.startsWith('110') ? 'クラス C' : 'クラス D';
    must(q.options[q.answerIndex] === want, `Lv95: ${q.meta.first} は ${want}`);
  },
};

LEVELS[96] = {
  title: 'CIDR', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = 'CIDR = クラスにしばられず、/n で好きな所で区切る(/n = 先頭 n ビットがネットワーク部)';
    const form = rng.pick(['row', 'row', 'len', 'part', 'count']);
    if (form === 'row') return { ...rowTf('cidr', rng.pick(CIDR)), hint, kind: kindOf(96, 'cidr') };
    const p = rng.pick([9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30]);
    const net = n2ip((ip2n(privAddr(rng, p >= 16 ? rng.rand(0, 2) : 0)) & maskN(p)) >>> 0);
    let stmt; let truth; let claim;
    if (form === 'len') {
      truth = rng.next() < 0.5;
      stmt = truth ? `CIDR なら、${net}/${p} のように、/8・/16・/24 以外の長さでも区切れる` : `CIDR でも、${net}/${p} のような /8・/16・/24 以外の長さでは区切れない`;
      claim = truth ? 'can' : 'cannot';
    } else if (form === 'part') {
      truth = rng.next() < 0.5;
      claim = truth ? 'network' : 'host';
      stmt = `${net}/${p} の「/${p}」は、先頭から ${p} ビットが${truth ? 'ネットワーク部' : 'ホスト部'}であることを表す`;
    } else {
      truth = rng.next() < 0.5;
      const host = truth ? 32 - p : rng.pick([p, 32 - p + 1, 32 - p - 1].filter((x) => x !== 32 - p && x > 0));
      claim = host;
      stmt = `${net}/${p} では、ネットワーク部が ${p} ビット、ホスト部が ${host} ビットである`;
    }
    const tf = trueFalse(stmt, truth);
    return {
      text: TF_TEXT(stmt), options: tf.options, answerIndex: tf.answerIndex, meta: { type: 'cidrgen', form, p, claim }, hint,
      explanation: `${tfWord(truth)}。CIDR では /n で区切りを決め、先頭 n ビットがネットワーク部、残りの 32 − n ビットがホスト部。/${p} ならネットワーク部 ${p} ビット、ホスト部 ${32 - p} ビット。/8・/16・/24 に限るのはクラスの考え方。`,
      kind: kindOf(96, 'cidr'),
    };
  },
  verify(q) {
    if (q.meta.type !== 'cidrgen') return checkMeta(q);
    const { form, p, claim } = q.meta;
    const truth = form === 'len' ? claim === 'can' : form === 'part' ? claim === 'network' : claim + p === 32;
    must(q.answerIndex === (truth ? 0 : 1), `Lv96: ○× が合わない ${JSON.stringify(q.meta)}`);
  },
};

// プライベートかどうか(作る側は 32 ビット整数で、確かめる側は BigInt の範囲で)
const PRIV = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]];
const isPrivate = (a) => PRIV.some(([n, p]) => inNet(a, n, p));
function nonPrivAddr(rng) {
  const k = rng.rand(0, 5);
  if (k === 0) return `172.15.${o8(rng)}.${rng.rand(1, 254)}`;
  if (k === 1) return `172.32.${o8(rng)}.${rng.rand(1, 254)}`;
  if (k === 2) return `192.169.${o8(rng)}.${rng.rand(1, 254)}`;
  if (k === 3) return `169.254.${rng.rand(1, 254)}.${o8(rng)}`;
  if (k === 4) return `127.0.0.${rng.rand(1, 254)}`;
  return docAddr(rng);
}
function privEdge(rng) { // 範囲の端に近いプライベート(172.16・172.31 など)
  const k = rng.rand(0, 3);
  if (k === 0) return `172.16.${o8(rng)}.${rng.rand(1, 254)}`;
  if (k === 1) return `172.31.${o8(rng)}.${rng.rand(1, 254)}`;
  return privAddr(rng);
}
const addrKind = (a) => (isPrivate(a) ? 'プライベート' : a.startsWith('169.254.') ? 'リンクローカル(自動で付く)' : a.startsWith('127.') ? 'ループバック(自分自身)'
  : DOC_NETS.some((d) => a.startsWith(`${d}.`)) ? '文書用' : 'プライベートの範囲の外(グローバル)');
LEVELS[97] = {
  title: 'プライベートの範囲', kind: '生', minDistinct: 1000,
  make(rng) {
    const want = rng.next() < 0.6; // true: プライベートを選ぶ、false: プライベートでないものを選ぶ
    const set = new Set();
    const correct = want ? privEdge(rng) : nonPrivAddr(rng);
    set.add(correct);
    let guard = 0;
    while (set.size < 4 && guard++ < 50) set.add(want ? nonPrivAddr(rng) : privEdge(rng));
    const options = rng.shuffle([...set]);
    return {
      text: want ? 'プライベートアドレスはどれ?' : 'プライベートアドレス「ではない」のはどれ?',
      options, answerIndex: options.indexOf(correct), meta: { type: 'private', want },
      hint: '10.0.0.0/8、172.16.0.0/12(172.16〜172.31)、192.168.0.0/16',
      explanation: `正解は ${correct}。${options.map((o) => `${o} は${addrKind(o)}`).join('、')}。プライベートは 10.0.0.0/8、172.16.0.0〜172.31.255.255、192.168.0.0/16 の 3 つだけ。`,
      kind: kindOf(97, 'private-range'),
    };
  },
  verify(q) {
    const ranges = [['10.0.0.0', '10.255.255.255'], ['172.16.0.0', '172.31.255.255'], ['192.168.0.0', '192.168.255.255']].map(([a, b]) => [bigOf(a), bigOf(b)]);
    const priv = (a) => ranges.some(([lo, hi]) => bigOf(a) >= lo && bigOf(a) <= hi);
    const hits = q.options.filter((o) => priv(o) === q.meta.want);
    must(hits.length === 1 && hits[0] === q.options[q.answerIndex], `Lv97: 正解が 1 つでない ${q.options}`);
  },
};

LEVELS[98] = {
  title: '範囲の端', kind: '生', minDistinct: 1000,
  make(rng) {
    let net; let p; let label = '';
    if (rng.next() < 0.25) {
      [net, p] = rng.pick(PRIV); label = 'プライベートアドレスの範囲 ';
    } else {
      // プライベートの範囲の中の、2 区切り目で切れるブロック(/8〜/16)
      const fam = rng.next() < 0.85 ? 0 : 1;
      p = fam === 0 ? rng.rand(9, 16) : rng.rand(12, 16);
      const base = fam === 0 ? ip2n('10.0.0.0') : ip2n('172.16.0.0');
      const span = fam === 0 ? 2 ** (p - 8) : 2 ** (p - 12);
      net = n2ip((base + rng.rand(0, span - 1) * 2 ** (32 - p)) >>> 0);
    }
    const last = n2ip((ip2n(net) + 2 ** (32 - p) - 1) >>> 0);
    const ask = rng.pick([`${label}${net}/${p} の最後のアドレスは?`, `${label}${net}/${p} に入るアドレスのうち、いちばん大きいアドレスは?`, `${label}${net}/${p} の範囲は、${net} から何まで?`]);
    const width = 2 ** (16 - p);
    return {
      text: ask, ...input('last', '最後のアドレス', 'ipv4', [last], 'a.b.c.d の形'),
      meta: { type: 'rangeend', net, p },
      hint: '/n の幅は 2 区切り目で 2^(16−n)(/12 なら 16)。最後 = 先頭 + 幅 − 1、3・4 区切り目は 255',
      explanation: `/${p} は 2 区切り目で幅 ${width}(2^(16 − ${p}))。2 区切り目は ${net.split('.')[1]} から ${Number(net.split('.')[1]) + width - 1} まで、3・4 区切り目は 255 まで。だから最後は ${last}。`,
      kind: kindOf(98, 'range-end'),
    };
  },
  verify(q) {
    const { net, p } = q.meta;
    must(PRIV.some(([n, pp]) => p >= pp && sameNetBits(net, n, pp)), `Lv98: プライベートの外 ${net}/${p}`);
    must(/^0*$/.test(bitsOf(net).slice(p)), `Lv98: ${net}/${p} がブロックの先頭でない`);
    const last = ipOfBig(bigOf(net) + (1n << BigInt(32 - p)) - 1n);
    must(q.fields[0].accept[0] === last, `Lv98: ${net}/${p} の最後は ${last}`);
  },
};

// ---------- Lv99 自動で付くアドレス ----------
const R_USE_RANGE = rel('use-range', SPECIAL.filter((r) => r.attrs.kind === 'range').map((r) => [r.attrs.use, r.attrs.addr]));
const R_RANGE_USE = rel('range-use', SPECIAL.filter((r) => r.attrs.kind === 'range').map((r) => [r.attrs.addr, r.attrs.use]));
const LL = SPECIAL.find((r) => r.id === 'linklocal');
LEVELS[99] = {
  title: '自動で付くアドレス', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '169.254 で始まる = DHCP から借りられず、自分で付けた印';
    const form = rng.pick(['row', 'row', 'range', 'use', 'pick', 'pick']);
    if (form === 'row') return { ...rowTf('linklocal', rng.pick(LINKLOCAL)), hint, kind: kindOf(99, 'link-local') };
    let q;
    if (form === 'range') {
      q = relChoice(rng, R_USE_RANGE, { key: LL.attrs.use });
      q.text = 'DHCP サーバーから IP アドレスを借りられないとき、PC が自分で付けるアドレスの範囲は?';
    } else if (form === 'use') {
      q = relChoice(rng, R_RANGE_USE, { key: LL.attrs.addr });
      q.text = '169.254.0.0/16 は、何に使うアドレスの範囲?';
    } else {
      const ll = `169.254.${rng.rand(1, 254)}.${o8(rng)}`;
      const set = new Set([ll]);
      while (set.size < 4) set.add(rng.pick([privAddr(rng), privAddr(rng), '127.0.0.1', docAddr(rng)]));
      const options = rng.shuffle([...set]);
      q = { options, answerIndex: options.indexOf(ll), meta: { type: 'apipa' } };
      q.text = 'PC の IPv4 アドレスを見た。DHCP サーバーから借りられず、PC が自分で付けたと考えられるのはどれ?';
    }
    q.explanation = `正解は「${q.options[q.answerIndex]}」。DHCP から借りられないとき、PC は 169.254.0.0/16(リンクローカル)の中から自分でアドレスを付ける。この範囲は同じ LAN の中だけで使え、ルーターの先へは届かない。127 は自分自身、10・172.16〜31・192.168 はプライベート。`;
    return { ...q, hint, kind: kindOf(99, 'link-local') };
  },
  verify(q) {
    if (q.meta.type !== 'apipa') return checkMeta(q);
    const hits = q.options.filter((o) => bitsOf(o).startsWith(bitsOf('169.254.0.0').slice(0, 16)));
    must(hits.length === 1 && hits[0] === q.options[q.answerIndex], 'Lv99: 169.254 が 1 つでない');
  },
};

// ---------- Lv100 特別な宛先 ----------
const SP_SHOW = (r) => (r.id === 'mcast' ? '224.0.0.0〜239.255.255.255' : r.attrs.addr);
const SP100 = SPECIAL.filter((r) => ['bcast', 'loop', 'this', 'mcast'].includes(r.id));
const R_USE_ADDR = rel('use-addr', SP100.map((r) => [r.attrs.use, SP_SHOW(r)]));
const R_ADDR_USE = rel('addr-use', SP100.map((r) => [SP_SHOW(r), r.attrs.use]));
LEVELS[100] = {
  title: '特別な宛先', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['addr', 'addr', 'use', 'tf', 'loop', 'router']);
    let q;
    if (form === 'addr') {
      q = relChoice(rng, R_USE_ADDR);
      q.text = `次の使い道のアドレスは?\n「${q.key}」`;
    } else if (form === 'use') {
      q = relChoice(rng, R_ADDR_USE);
      q.text = `${q.key} は、何に使うアドレス?`;
    } else if (form === 'tf') {
      q = relTf(rng, R_ADDR_USE);
      q.text = TF_TEXT(`${q.key} は、「${q.val}」アドレスである`);
    } else if (form === 'loop') {
      const a = `127.${o8(rng)}.${o8(rng)}.${rng.rand(1, 254)}`;
      const options = rng.shuffle(SP100.map((r) => r.attrs.use));
      q = { options, answerIndex: options.indexOf(SPECIAL.find((r) => r.id === 'loop').attrs.use), meta: { type: 'loop127', a } };
      q.text = `宛先 ${a} のパケットは、どう扱われる?`;
    } else {
      const fwd = rng.next() < 0.5;
      const stmt = fwd ? 'ルーターは、255.255.255.255 宛のパケットを別の網へ送る' : 'ルーターは、255.255.255.255 宛のパケットを別の網へ送らない';
      const tf = trueFalse(stmt, !fwd);
      q = { text: TF_TEXT(stmt), options: tf.options, answerIndex: tf.answerIndex, meta: { type: 'bcastfwd', fwd } };
    }
    q.explanation = `${q.options[q.answerIndex] === '○' || q.options[q.answerIndex] === '×' ? `${tfWord(q.answerIndex === 0)}。` : `正解は「${q.options[q.answerIndex]}」。`}255.255.255.255 は同じ LAN の全員宛(ルーターは先へ送らない)、127.0.0.0/8(127.0.0.1 など)は自分自身、0.0.0.0 はアドレスがまだ無い機器の送信元、224〜239 で始まるのはグループ宛(マルチキャスト)。`;
    return { ...q, hint: '全部 1(255.255.255.255)= 同じ LAN の全員、127 = 自分自身、0.0.0.0 = まだアドレスが無い、224〜239 = グループ宛', kind: kindOf(100, 'special-dest') };
  },
  verify(q) {
    if (q.meta.type === 'loop127') {
      must(bitsOf(q.meta.a).startsWith('01111111'), 'Lv100: 127/8 でない');
      must(q.options[q.answerIndex] === SPECIAL.find((r) => r.id === 'loop').attrs.use, 'Lv100: ループバックの答えが違う');
    } else if (q.meta.type === 'bcastfwd') {
      must(q.answerIndex === (q.meta.fwd ? 1 : 0), 'Lv100: ブロードキャストの転送の ○× が違う');
    } else checkMeta(q);
  },
};

// ---------- Lv101 :: の決まり ----------
// 8 つのグループ(数)を作る。0 の並びを 2 か所(長さ 2 以上と 1 以上)持たせることもある
function v6Groups(rng, twoRuns) {
  const g = [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0];
  const nz = () => (rng.next() < 0.3 ? rng.rand(1, 0xfff) * 16 : rng.rand(1, 0xffff)); // 末尾が 0 のグループも混ぜる
  for (let i = 2; i < 8; i++) g[i] = nz();
  // 0 の並び: 位置 2〜7 の中に、長さ 2〜3 を 1 か所(twoRuns ならもう 1 か所、間を空けて)
  const len1 = rng.rand(2, 3); const s1 = rng.rand(2, 8 - len1);
  for (let i = s1; i < s1 + len1; i++) g[i] = 0;
  let run2 = null;
  if (twoRuns) {
    const free = [];
    for (let s = 2; s < 8; s++) for (let L = 1; L <= 2 && s + L <= 8; L++) {
      const ok = [...Array(L).keys()].every((k) => Math.abs(s + k - s1) > 0 && (s + k < s1 - 1 || s + k > s1 + len1));
      if (ok) free.push([s, L]);
    }
    if (free.length) { run2 = rng.pick(free); for (let i = run2[0]; i < run2[0] + run2[1]; i++) g[i] = 0; }
  }
  return { g, run1: [s1, len1], run2 };
}
const hx = (n) => n.toString(16);
const fullV6 = (g) => g.map((x) => x.toString(16).padStart(4, '0')).join(':');
function compressAt(g, s, L) { // グループ s から L 個を :: にした書き方
  const left = g.slice(0, s).map(hx).join(':'); const right = g.slice(s + L).map(hx).join(':');
  return `${left}::${right}`;
}
// 確かめる側の展開(:: が 2 つ以上なら null)
function expandV6(s) {
  if ((s.match(/::/g) || []).length > 1) return null;
  const [h, t] = s.includes('::') ? s.split('::') : [s, null];
  const hs = h ? h.split(':') : []; const ts = t ? t.split(':') : [];
  if (t === null && hs.length !== 8) return null;
  const fill = t === null ? 0 : 8 - hs.length - ts.length;
  if (fill < 1 && t !== null) return null;
  const all = hs.concat(Array(fill).fill('0'), ts);
  if (all.length !== 8 || all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => parseInt(x, 16));
}
LEVELS[101] = {
  title: ':: の決まり', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = ':: は 0 のグループの並びを 1 か所だけまとめる。各グループで省けるのは先頭の 0 だけ';
    const form = rng.pick(['row', 'row', 'valid', 'same']);
    if (form === 'row') return { ...rowTf('ipv6-rules', rng.pick(V6RULES)), hint, kind: kindOf(101, 'v6-double-colon') };
    let stmt; let truth; let meta; let why;
    if (form === 'valid') {
      truth = rng.next() < 0.5;
      const { g, run1, run2 } = v6Groups(rng, !truth);
      let s;
      if (truth || !run2) { s = compressAt(g, run1[0], run1[1]); truth = true; why = `:: は 1 か所だけなので正しい書き方(元は ${fullV6(g)})。`; } else {
        // 2 か所を両方 :: にした(誤り)
        const [a, b] = run1[0] < run2[0] ? [run1, run2] : [run2, run1];
        s = `${g.slice(0, a[0]).map(hx).join(':')}::${g.slice(a[0] + a[1], b[0]).map(hx).join(':')}::${g.slice(b[0] + b[1]).map(hx).join(':')}`;
        why = ':: が 2 か所あり、それぞれ何グループの 0 なのか決まらない。';
      }
      stmt = `「${s}」は、IPv6 アドレスの正しい書き方である`;
      meta = { type: 'v6valid', s };
    } else {
      const { g, run1 } = v6Groups(rng, false);
      const full = fullV6(g);
      truth = rng.next() < 0.5;
      let s = compressAt(g, run1[0], run1[1]);
      if (!truth) {
        const tz = g.map((x, i) => i).filter((i) => g[i] !== 0 && g[i] % 16 === 0);
        if (tz.length && rng.next() < 0.6) { // 末尾の 0 を省いた(誤り)
          const i = rng.pick(tz); const g2 = g.slice(); g2[i] = parseInt(hx(g[i]).replace(/0+$/, ''), 16);
          s = compressAt(g2, run1[0], run1[1]); why = `グループ ${hx(g[i])} の末尾の 0 を省くと別の値(${hx(g2[i])})になる。省けるのは先頭の 0 だけ。`;
        } else { // 0 でないグループを :: に含めた(誤り)
          const s1 = run1[0] > 2 ? run1[0] - 1 : run1[0]; const L = run1[1] + 1;
          s = compressAt(g, s1, L); why = ':: に 0 でないグループまで含めてしまっている。:: が表すのは 0 のグループだけ。';
        }
      } else why = '0 の並びを :: にまとめ、各グループの先頭の 0 を省いた同じアドレス。';
      stmt = `「${full}」と「${s}」は同じアドレスである`;
      meta = { type: 'v6same', full, s };
    }
    const tf = trueFalse(stmt, truth);
    return { text: TF_TEXT(stmt), options: tf.options, answerIndex: tf.answerIndex, meta, hint, explanation: `${tfWord(truth)}。${why}`, kind: kindOf(101, 'v6-double-colon') };
  },
  verify(q) {
    if (q.meta.type === 'v6valid') must(q.answerIndex === (expandV6(q.meta.s) ? 0 : 1), `Lv101: ${q.meta.s} の正しさが違う`);
    else if (q.meta.type === 'v6same') {
      const a = expandV6(q.meta.full); const b = expandV6(q.meta.s);
      must(a && b, `Lv101: 読めない ${q.meta.s}`);
      must(q.answerIndex === (a.every((x, i) => x === b[i]) ? 0 : 1), `Lv101: ${q.meta.full} と ${q.meta.s}`);
    } else checkMeta(q);
  },
};

// ========== 届け方・経路(Lv107〜112) ==========
const ARP_ROLES = typed(ARP, 'role');
const R_ROLE_NAME = rel('arp-role-name', ARP_ROLES.map((r) => [r.attrs.role, r.ja]));
const R_NAME_ROLE = rel('arp-name-role', ARP_ROLES.map((r) => [r.ja, r.attrs.role]));
LEVELS[107] = {
  title: 'ARP の役割', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['role', 'name', 'qa', 'qa', 'qa']);
    let q;
    if (form === 'qa') q = qaChoice(rng, 'arp', rng.pick(typed(ARP, 'qa')));
    else {
      const R = form === 'role' ? R_ROLE_NAME : R_NAME_ROLE;
      q = relChoice(rng, R);
      q.text = form === 'role' ? `次のしくみの名前は?\n「${q.key}」` : `${w(q.key)}の役割は?`;
      const name = form === 'role' ? q.correct : q.key;
      q.explanation = `${w(name)}は「${R_NAME_ROLE.of(name)[0]}」しくみ。ARP = IP から MAC、DNS = 名前から IP、DHCP = 設定を配る、ICMP = 届かない知らせや ping。`;
    }
    return { ...q, hint: 'ARP は「この IP アドレスの機器は、MAC を教えて」と同じ LAN の全員に聞く', kind: kindOf(107, 'arp-role') };
  },
  verify: checkMeta,
};

const CAST_KINDS = typed(CAST, 'kind');
const CAST_NAMES = CAST_KINDS.map((r) => r.ja);
const R_CAST_DESC = rel('cast-desc-name', CAST_KINDS.map((r) => [r.attrs.desc, r.ja]));
const R_CAST_NAME = rel('cast-name-desc', CAST_KINDS.map((r) => [r.ja, r.attrs.desc]));
const R_CAST_EX = rel('cast-ex', typed(CAST, 'ex').map((r) => [r.ja, r.attrs.answer]));
LEVELS[109] = {
  title: '届け方の 3 種類', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['desc', 'name', 'ex', 'ex', 'ex', 'tf']);
    let q;
    if (form === 'desc') { q = relChoice(rng, R_CAST_DESC, { pool: CAST_NAMES }); q.text = `次の届け方の名前は?\n「${q.key}」`; } else if (form === 'name') { q = relChoice(rng, R_CAST_NAME); q.text = `${w(q.key)}の説明は?`; } else if (form === 'ex') { q = relChoice(rng, R_CAST_EX, { pool: CAST_NAMES }); q.text = `次の通信の届け方は?\n「${q.key}」`; } else { q = relTf(rng, R_CAST_EX, { pool: CAST_NAMES }); q.text = TF_TEXT(`「${q.key}」の届け方は、${q.val}である`); }
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。「${q.key}」は${R_CAST_EX.of(q.key)[0]}。` : `正解は「${q.options[q.answerIndex]}」。`}ユニキャスト = 決まった 1 台、ブロードキャスト = 同じ LAN の全員(IPv4 の 255.255.255.255、MAC の ff:ff:ff:ff:ff:ff)、マルチキャスト = 参加したグループ(IPv4 の 224〜239、IPv6 の ff で始まるもの)、エニーキャスト = 同じアドレスのうちいちばん近い 1 台。IPv6 にはブロードキャストが無い。`;
    return { ...q, hint: '1 台 = ユニキャスト、全員 = ブロードキャスト、決めたグループ = マルチキャスト、いちばん近い 1 台 = エニーキャスト', kind: kindOf(109, 'cast-type') };
  },
  verify: checkMeta,
};

const DROP = '送り先が無いので捨てる';
LEVELS[110] = {
  title: 'デフォルトルート', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '/0 はどの宛先にも合う。ほかに合う行が無いときの行き先';
    const form = rng.pick(['qa', 'qa', 'tf', 'table', 'table']);
    if (form === 'qa') return { ...qaChoice(rng, 'default-route', rng.pick(typed(DROUTE, 'qa'))), hint, kind: kindOf(110, 'default-route') };
    if (form === 'tf') return { ...rowTf('default-route', rng.pick(typed(DROUTE, 'tf'))), hint, kind: kindOf(110, 'default-route') };
    // 小さな経路表: 0.0.0.0/0(無いこともある)と、ほかに 1〜2 行
    const hops = rng.shuffle(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
    const withDefault = rng.next() < 0.8;
    const specifics = [];
    const nets = rng.shuffle([`172.${rng.rand(16, 31)}.${o8(rng)}.0/24`, `192.168.${o8(rng)}.0/24`, `10.${rng.rand(10, 250)}.0.0/16`]);
    const k = rng.rand(1, 2);
    for (let i = 0; i < k; i++) specifics.push([nets[i], hops[i + 1]]);
    const rows = rng.shuffle(specifics.concat(withDefault ? [['0.0.0.0/0', hops[0]]] : []));
    const inside = rng.next() < 0.3;
    let dst;
    if (inside) { const [n, p] = specifics[0][0].split('/'); dst = n2ip((ip2n(n) + rng.rand(1, 2 ** (32 - Number(p)) - 2)) >>> 0); } else dst = docAddr(rng);
    const hit = specifics.find(([np]) => { const [n, p] = np.split('/'); return inNet(dst, n, Number(p)); });
    const correct = hit ? hit[1] : withDefault ? hops[0] : DROP;
    // 選択肢: 表に出ている送り先・「捨てる」・表に無い送り先 1 つ
    const c = choices(rng, correct, uniq(rows.map((r) => r[1]).concat([DROP, hops[3]])), Math.min(4, uniq(rows.map((r) => r[1]).concat([DROP, hops[3]])).length));
    const opts = c.options;
    return {
      text: `ルーターの経路表が次のとき、宛先 ${dst} のパケットはどこへ送られる?`,
      table: { headers: ['宛先', '次の送り先'], rows }, options: opts, answerIndex: opts.indexOf(correct),
      meta: { type: 'droute', dst, rows }, hint,
      explanation: hit ? `${dst} は ${hit[0]} の行に合うので ${hit[1]} へ送る(0.0.0.0/0 より長く合う行が先)。`
        : withDefault ? `${dst} はほかの行に合わないので、どの宛先にも合う 0.0.0.0/0(デフォルトルート)の ${hops[0]} へ送る。`
          : `${dst} はどの行にも合わず、デフォルトルート(0.0.0.0/0)も無いので、送り先が無く捨てる。`,
      kind: kindOf(110, 'default-route'),
    };
  },
  verify(q) {
    if (q.meta.type !== 'droute') return checkMeta(q);
    // 別の引き方: 2 進の文字列で、合う行のうち /n がいちばん長い行
    let best = null;
    for (const [np, hop] of q.meta.rows) { const [n, p] = np.split('/'); if (sameNetBits(q.meta.dst, n, Number(p)) && (!best || Number(p) > best.p)) best = { p: Number(p), hop }; }
    const want = best ? best.hop : DROP;
    must(q.options[q.answerIndex] === want && q.options.filter((o) => o === want).length === 1, `Lv110: ${q.meta.dst} は ${want}`);
  },
};

LEVELS[112] = {
  title: 'TTL', kind: '生', minDistinct: 1000,
  make(rng) {
    const form = rng.pick(['after', 'count', 'drop']);
    const T = form === 'drop' ? rng.rand(1, 30) : (rng.next() < 0.7 ? rng.pick([64, 128, 255]) : rng.rand(31, 250));
    const src = privAddr(rng); const dst = docAddr(rng);
    let text; let ans; let expl;
    if (form === 'after') {
      const k = rng.rand(1, 30);
      text = `${src} から ${dst} へ、TTL ${T} でパケットを送った。ルーターを ${k} 台通って宛先に届いたとき、TTL はいくつ?`;
      ans = T - k; expl = `ルーター 1 台で 1 減るので ${T} − ${k} = ${ans}。`;
    } else if (form === 'count') {
      const k = rng.rand(1, 30);
      text = `${dst} から届いたパケットの TTL は ${T - k} だった。送った側が TTL ${T} で送っていたなら、途中で通ったルーターは何台?`;
      ans = k; expl = `1 台で 1 減るので、減った分がルーターの台数。${T} − ${T - k} = ${k} 台。`;
    } else {
      const more = rng.rand(1, 10);
      text = `${src} から ${dst} までの間に、ルーターが ${T + more} 台並んでいる。TTL ${T} で送ったパケットは、何台目のルーターで捨てられる?(ルーターは TTL を 1 減らし、0 になったら捨てる)`;
      ans = T; expl = `1 台目で ${T - 1}、2 台目で ${T - 2} …と減り、${T} 台目で 0 になって捨てられる。宛先には届かない。`;
    }
    return {
      text, ...input('ttl', form === 'after' ? 'TTL' : form === 'count' ? 'ルーターの台数' : '何台目', 'number', [String(ans)], '数だけ'),
      meta: { type: 'ttl', form, T, ans, text },
      hint: 'ルーターを 1 台通るたびに TTL が 1 減る。0 になったルーターで捨てる',
      explanation: expl, kind: kindOf(112, 'ttl'),
    };
  },
  verify(q) {
    const nums = q.meta.text.match(/\d+/g).map(Number);
    const { form, T } = q.meta;
    let want;
    if (form === 'after') { const k = Number(/ルーターを (\d+) 台/.exec(q.meta.text)[1]); let t = T; for (let i = 0; i < k; i++) t--; want = t; } else if (form === 'count') { const got = Number(/TTL は (\d+) だった/.exec(q.meta.text)[1]); let t = T; let n = 0; while (t > got) { t--; n++; } want = n; } else { const routers = Number(/ルーターが (\d+) 台/.exec(q.meta.text)[1]); let t = T; let at = null; for (let i = 1; i <= routers; i++) { t--; if (t === 0) { at = i; break; } } want = at; }
    must(nums.length && want !== null && q.fields[0].accept[0] === String(want), `Lv112: ${q.meta.text} の答えは ${want}`);
  },
};

// ========== サービス(Lv117〜123) ==========
const DHCP_BY_STEP = (s) => DHCP.find((r) => r.attrs.step === s);
const DHCP_NAMES = DHCP.map((r) => r.ja);
const FROM = { client: 'クライアント(アドレスを借りる PC)', server: 'DHCP サーバー' };
const R_DHCP_STEP = rel('dhcp-step', DHCP.map((r) => [r.attrs.step, r.ja]));
const R_DHCP_FROM = rel('dhcp-from', DHCP.map((r) => [r.ja, FROM[r.attrs.from]]));
const R_DHCP_NEXT = rel('dhcp-next', DHCP.filter((r) => r.attrs.step < 4).map((r) => [r.ja, DHCP_BY_STEP(r.attrs.step + 1).ja]));
const R_DHCP_MEAN = rel('dhcp-meaning', DHCP.map((r) => [r.attrs.meaning, r.ja]));
RANK.dhcp = (name) => DHCP.find((r) => r.ja === name).attrs.step;
const DHCP_FLOW = 'Discover(探す)→ Offer(申し出)→ Request(頼む)→ Ack(承認)';
LEVELS[117] = {
  title: 'DHCP の 4 手順', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '探す(Discover)→ 申し出(Offer)→ 頼む(Request)→ 承認(Ack)';
    const form = rng.pick(['order', 'order', 'step', 'from', 'next', 'mean']);
    if (form === 'order') {
      const o = orderQ(rng, 'dhcp', DHCP_NAMES, false);
      return {
        text: `PC が DHCP で IP アドレスを借りるときのメッセージを、送られる順に並べてください。${ORDER_NOTE}\n${o.list}`,
        answerKind: o.answerKind, fields: o.fields, compare: o.compare, meta: o.meta, hint,
        explanation: `${DHCP_FLOW}。答えは ${o.answer}。`, kind: kindOf(117, 'dhcp-dora'),
      };
    }
    let q;
    if (form === 'step') { const s = rng.rand(1, 4); q = relChoice(rng, R_DHCP_STEP, { key: s }); q.text = `DHCP でアドレスを借りるとき、${s} 番目に送られるメッセージは?`; } else if (form === 'from') { q = relChoice(rng, R_DHCP_FROM, { n: 2 }); q.text = `${q.key} を送るのは?`; } else if (form === 'next') { q = relChoice(rng, R_DHCP_NEXT, { pool: DHCP_NAMES, n: 3, notKey: true }); q.text = `DHCP で、${q.key} の次に送られるメッセージは?`; } else { q = relChoice(rng, R_DHCP_MEAN, { pool: DHCP_NAMES }); q.text = `DHCP で「${q.key}」メッセージは?`; }
    q.explanation = `正解は「${q.options[q.answerIndex]}」。${DHCP_FLOW}。Discover と Request は PC(クライアント)が、Offer と Ack は DHCP サーバーが送る。`;
    return { ...q, hint, kind: kindOf(117, 'dhcp-dora') };
  },
  verify: checkMeta,
};

const DNS_TYPES = DNSREC.map((r) => r.ja);
const R_DNS_DESC = rel('dns-desc-type', DNSREC.map((r) => [r.attrs.desc, r.ja]));
const R_DNS_VALUE = rel('dns-type-value', DNSREC.map((r) => [r.ja, r.attrs.value]));
// 値の形の選択肢は、互いにはっきり違う A・AAAA・CNAME・MX のものだけ(NS・PTR の値も「名前」なので紛らわしい)
const DNS_VALUE_POOL = DNSREC.filter((r) => ['A', 'AAAA', 'CNAME', 'MX'].includes(r.ja)).map((r) => r.attrs.value);
const DNS_NOTE = 'A は IPv4 アドレス、AAAA は IPv6 アドレス、CNAME は別名に対する正式名、MX はメールを受け取るサーバー、NS はそのドメインの DNS サーバー、PTR は逆引き(アドレス → 名前)。';
function dnsQ(rng, focus, lv) {
  const form = rng.pick(['desc', 'value', 'ex', 'ex']);
  let q;
  if (form === 'desc') {
    const t = rng.pick(focus);
    q = relChoice(rng, R_DNS_DESC, { key: DNSREC.find((r) => r.ja === t).attrs.desc, pool: DNS_TYPES });
    q.text = `DNS で「${q.key}」を表すレコードは?`;
  } else if (form === 'value') {
    q = relChoice(rng, R_DNS_VALUE, { key: rng.pick(focus), pool: DNS_VALUE_POOL });
    q.text = `DNS の ${q.key} レコードが示す値は?`;
  } else {
    const t = rng.pick(focus); const zone = zoneOf(rng); const host = `${rng.pick(HOSTS)}.${zone}`;
    let text;
    if (t === 'A') text = `DNS で ${host} を引くと ${docAddr(rng)} が返ってきた。この答えのレコードの種類は?`;
    else if (t === 'AAAA') text = `DNS で ${host} を引くと ${v6doc(rng)} が返ってきた。この答えのレコードの種類は?`;
    else if (t === 'MX') text = `「${zone} 宛のメールは mail${rng.rand(1, 9)}.${zone} が受け取る」と示す DNS のレコードは?`;
    else text = `「${host} は、${rng.pick(['web', 'srv', 'front'])}${rng.rand(1, 9)}.${zone} の別名」と示す DNS のレコードは?`;
    const c = choices(rng, t, DNS_TYPES.filter((x) => x !== t));
    q = { ...c, text, meta: { type: 'dnsex', t, text } };
  }
  q.explanation = `正解は「${q.options[q.answerIndex]}」。${DNS_NOTE}`;
  return { ...q, hint: lv === 118 ? 'A は IPv4、AAAA は IPv6(IPv4 の 4 倍の長さなので A を 4 つ)' : 'CNAME は別名 → 正式名、MX はメールの届け先のサーバー', kind: kindOf(lv, lv === 118 ? 'dns-a-aaaa' : 'dns-cname-mx') };
}
function dnsVerify(q) {
  if (q.meta.type !== 'dnsex') return checkMeta(q);
  const t = q.meta.text;
  const want = /別名/.test(t) ? 'CNAME' : /メール/.test(t) ? 'MX' : /返ってきた/.test(t) ? (/ 2001:db8:[0-9a-f:]+ が/.test(t) ? 'AAAA' : 'A') : null;
  must(want && q.options[q.answerIndex] === want && q.options.filter((o) => o === want).length === 1, `Lv118/119: ${t} は ${want}`);
}
LEVELS[118] = { title: 'DNS の A と AAAA', kind: '表', minDistinct: 30, make: (rng) => dnsQ(rng, ['A', 'AAAA'], 118), verify: dnsVerify };
LEVELS[119] = { title: 'DNS の CNAME と MX', kind: '表', minDistinct: 30, make: (rng) => dnsQ(rng, ['CNAME', 'MX'], 119), verify: dnsVerify };

const METHOD_NAMES = METHODS.map((r) => r.ja);
const R_M_DESC = rel('method-desc', METHODS.map((r) => [r.attrs.desc, r.ja]));
const R_M_NAME = rel('method-name', METHODS.map((r) => [r.ja, r.attrs.desc]));
const R_M_EX = rel('method-ex', METHOD_EX.map((r) => [r.ja, r.attrs.answer]));
LEVELS[120] = {
  title: 'HTTP のメソッド', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['desc', 'name', 'ex', 'ex']);
    let q;
    if (form === 'desc') { q = relChoice(rng, R_M_DESC, { pool: METHOD_NAMES }); q.text = `HTTP で「${q.key}」ときのメソッドは?`; } else if (form === 'name') { q = relChoice(rng, R_M_NAME); q.text = `HTTP の ${q.key} メソッドの使い道は?`; } else { q = relChoice(rng, R_M_EX, { pool: METHOD_NAMES }); q.text = `次の場面で、ブラウザ(アプリ)がサーバーに送る HTTP のメソッドは?\n「${q.key}」`; }
    q.explanation = `正解は「${q.options[q.answerIndex]}」。GET = 取りにいく、POST = 内容を送って処理してもらう、PUT = 置き換える、DELETE = 消す、HEAD = ヘッダーだけ受け取る。`;
    return { ...q, hint: 'GET は取る、POST は送る、PUT は置き換える、DELETE は消す、HEAD はヘッダーだけ', kind: kindOf(120, 'http-method') };
  },
  verify: checkMeta,
};

const STATUS_NAMES = STATUS.map((r) => r.ja);
const R_S_DESC = rel('status-desc', STATUS.map((r) => [r.attrs.desc, r.ja]));
const R_S_CODE = rel('status-code', STATUS.map((r) => [r.ja, r.attrs.desc]));
const classLabel = (d) => STATUS_CLASS.find((c) => c.attrs.digit === d).ja;
const CLASS_LABELS = STATUS_CLASS.map((c) => c.ja);
const R_S_CLASS = rel('status-class', STATUS.map((r) => [String(r.attrs.code), classLabel(Math.floor(r.attrs.code / 100))]));
const R_CLASS_S = rel('class-status', STATUS.map((r) => [classLabel(Math.floor(r.attrs.code / 100)), r.ja]));
const CLASS_NOTE = '1xx 情報、2xx 成功、3xx 転送(別の場所を見る)、4xx 頼む側の誤り、5xx サーバー側の誤り。';
LEVELS[121] = {
  title: 'HTTP のステータスコード', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['desc', 'desc', 'code']);
    let q;
    if (form === 'desc') { q = relChoice(rng, R_S_DESC, { pool: STATUS_NAMES }); q.text = `HTTP で「${q.key}」ときに返るステータスコードは?`; } else { q = relChoice(rng, R_S_CODE); q.text = `HTTP のステータスコード ${q.key} の意味は?`; }
    const row = STATUS.find((r) => r.ja === (form === 'desc' ? q.correct : q.key));
    q.explanation = `${row.ja} は「${row.attrs.desc}」。${CLASS_NOTE}`;
    return { ...q, hint: '200 成功、301・302 移動、401 認証が要る、403 権限が無い、404 無い、500 サーバーの誤り、503 今は使えない', kind: kindOf(121, 'http-status') };
  },
  verify: checkMeta,
};
LEVELS[122] = {
  title: 'ステータスコードの種類', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['class', 'class', 'which', 'tf']);
    let q;
    if (form === 'class') { q = relChoice(rng, R_S_CLASS, { pool: CLASS_LABELS }); q.text = `HTTP のステータスコード ${q.key} は、どの種類?`; } else if (form === 'which') { q = relChoice(rng, R_CLASS_S, { key: rng.pick(R_CLASS_S.keys), pool: STATUS_NAMES }); q.text = `HTTP のステータスコードのうち、「${q.key}」を表すのは?`; } else { q = relTf(rng, R_S_CLASS, { pool: CLASS_LABELS }); q.text = TF_TEXT(`HTTP のステータスコード ${q.key} は「${q.val}」を表す`); }
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}百の位で種類が決まる: ${CLASS_NOTE}`;
    return { ...q, hint: '百の位で決まる: 1xx 情報、2xx 成功、3xx 転送、4xx 頼み方(クライアント)の誤り、5xx サーバーの誤り', kind: kindOf(122, 'http-status-class') };
  },
  verify(q) {
    checkMeta(q);
    // 別の引き方: 百の位の数で種類を引き直す
    const m = q.meta;
    if (m.rel === 'status-class') {
      const want = STATUS_CLASS.find((c) => c.attrs.digit === Math.floor(Number(m.key) / 100)).ja;
      if (m.type === 'rel') must(q.options[q.answerIndex] === want, `Lv122: ${m.key} は ${want}`);
      else must(q.answerIndex === (m.val === want ? 0 : 1), `Lv122: ${m.key} の ○×`);
    }
  },
};

LEVELS[123] = {
  title: 'NAT の役割', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '外へ出るときに送信元のアドレスを書き換え、戻りは宛先を元に戻す。NAPT はポート番号も';
    const row = rng.pick(NAT);
    const q = row.attrs.type === 'qa' ? qaChoice(rng, 'nat', row) : rowTf('nat', row);
    return { ...q, hint, kind: kindOf(123, 'nat-role') };
  },
  verify: checkMeta,
};

// ========== セキュリティ(Lv125〜131) ==========
function defExQ(rng, rows, relPrefix, names, n) {
  // 定義・場面の表から: 説明 → 名前、名前 → 説明、場面 → 名前、場面の ○×
  const R = RELS[`${relPrefix}-desc`]; const Rn = RELS[`${relPrefix}-name`]; const Rx = RELS[`${relPrefix}-ex`];
  const form = rng.pick(['desc', 'name', 'ex', 'ex', 'tf']);
  let q;
  if (form === 'desc') { q = relChoice(rng, R, { pool: names, n }); q.text = /こと$/.test(q.key) ? `「${q.key}」を何という?` : `「${q.key}」ことを何という?`; } else if (form === 'name') { q = relChoice(rng, Rn, { key: rng.pick(names.filter((x) => Rn.keys.includes(x))), n }); q.text = `${w(q.key)}とは?`; } else if (form === 'ex') { q = relChoice(rng, Rx, { pool: names, n }); q.text = `次のことに主に関わるのは?\n「${q.key}」`; } else { q = relTf(rng, Rx, { pool: Rx.values }); q.text = TF_TEXT(`「${q.key}」は、主に${q.val}に関わることである`); }
  return { q, form };
}
const CIA_DEF = typed(CIA, 'def');
rel('cia-desc', CIA_DEF.map((r) => [r.attrs.desc, r.ja]));
rel('cia-name', CIA_DEF.map((r) => [r.ja, r.attrs.desc]));
rel('cia-ex', typed(CIA, 'ex').map((r) => [r.ja, r.attrs.answer]));
LEVELS[125] = {
  title: '機密性・完全性・可用性', kind: '表', minDistinct: 30,
  make(rng) {
    const { q, form } = defExQ(rng, CIA, 'cia', CIA_DEF.map((r) => r.ja), 3);
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}機密性 = 見てよい人だけが見られる(漏れない)、完全性 = 正しく書き換えられていない、可用性 = 使いたいときに使える(止まらない)。`;
    return { ...q, hint: '機密性 = 見られない、完全性 = 変わらない、可用性 = 使える', kind: kindOf(125, 'cia') };
  },
  verify: checkMeta,
};
const AUTHN_DEF = typed(AUTHN, 'def');
rel('authn-desc', AUTHN_DEF.map((r) => [r.attrs.desc, r.ja]));
rel('authn-name', AUTHN_DEF.map((r) => [r.ja, r.attrs.desc]));
rel('authn-ex', typed(AUTHN, 'ex').map((r) => [r.ja, r.attrs.answer]));
LEVELS[126] = {
  title: '認証と認可', kind: '表', minDistinct: 30,
  make(rng) {
    const { q, form } = defExQ(rng, AUTHN, 'authn', AUTHN_DEF.map((r) => r.ja), 4);
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}認証 = 本人かどうかを確かめる、認可 = 確かめた相手に何をしてよいかを許す、アカウンティング = だれが何をしたかの記録、暗号化 = 読めない形に変える。`;
    return { ...q, hint: '認証 = 誰か(本人か)、認可 = 何をしてよいか、記録 = 何をしたか', kind: kindOf(126, 'authn-authz') };
  },
  verify: checkMeta,
};

const FACTOR_LABEL = { 知識: '知識(知っていること)', 所持: '所持(持っているもの)', 生体: '生体(本人の体の特徴)' };
const R_MFA = rel('mfa-factor', MFA.map((r) => [r.ja, FACTOR_LABEL[r.attrs.factor]]));
const mfaFactor = (name) => MFA.find((r) => r.ja === name).attrs.factor;
LEVELS[127] = {
  title: '多要素認証', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '知っている(パスワード)・持っている(スマホ・カード)・本人の体(指紋・顔)のうち、違う種類を 2 つ以上';
    const form = rng.pick(['multi', 'multi', 'single', 'factor']);
    if (form === 'factor') {
      const q = relChoice(rng, R_MFA, { n: 3 });
      q.text = `認証に使う「${q.key}」は、どの要素?`;
      q.explanation = `「${q.key}」は${q.correct}。知識 = パスワード・暗証番号など、所持 = スマホ・IC カードなど、生体 = 指紋・顔など。`;
      return { ...q, hint, kind: kindOf(127, 'mfa') };
    }
    const byF = (f) => MFA.filter((r) => r.attrs.factor === f).map((r) => r.ja);
    const fs = Object.keys(FACTOR_LABEL);
    const pairOf = (same) => {
      const order = (p) => p.sort((x, y) => MFA.findIndex((r) => r.ja === x) - MFA.findIndex((r) => r.ja === y)); // 同じ組を別の並びで出さない
      if (same) { const f = rng.pick(fs); const [a, b] = rng.shuffle(byF(f)); return order([a, b]); }
      const [f1, f2] = rng.shuffle(fs); return order([rng.pick(byF(f1)), rng.pick(byF(f2))]);
    };
    const want = form === 'multi'; // true: 多要素のものを選ぶ
    const label = (p) => p.join(' + ');
    const correct = label(pairOf(!want));
    const set = new Set([correct]); let guard = 0;
    while (set.size < 4 && guard++ < 50) set.add(label(pairOf(want)));
    const options = rng.shuffle([...set]);
    return {
      text: want ? '多要素認証になっているのはどれ?' : '多要素認証に「なっていない」のはどれ?',
      options, answerIndex: options.indexOf(correct), meta: { type: 'mfa', want }, hint,
      explanation: `正解は「${correct}」。${options.map((o) => `${o} は ${o.split(' + ').map(mfaFactor).join(' と ')}`).join('、')}。違う種類の要素を 2 つ以上組み合わせたものが多要素。同じ種類を 2 つ重ねても多要素にはならない。`,
      kind: kindOf(127, 'mfa'),
    };
  },
  verify(q) {
    if (q.meta.type !== 'mfa') return checkMeta(q);
    const multi = (o) => new Set(o.split(' + ').map(mfaFactor)).size >= 2;
    const hits = q.options.filter((o) => multi(o) === q.meta.want);
    must(hits.length === 1 && hits[0] === q.options[q.answerIndex], `Lv127: 正解が 1 つでない ${q.options}`);
  },
};

LEVELS[128] = {
  title: '暗黙の拒否', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '上から順に見て、最初に合った行で決まる。どれにも合わなければ、最後の見えない「すべて拒否」';
    if (rng.next() < 0.45) return { ...rowTf('acl-implicit', rng.pick(ACLI)), hint, kind: kindOf(128, 'implicit-deny') };
    // 1〜2 行の ACL と送信元。「通る」「捨てられる」の文
    const nets = rng.shuffle([`192.168.${o8(rng)}.0/24`, `10.${o8(rng)}.0.0/16`, `172.${rng.rand(16, 31)}.${o8(rng)}.0/24`]);
    const lines = [[10, rng.pick(['permit', 'deny']), nets[0]]];
    if (rng.next() < 0.5) lines.push([20, rng.pick(['permit', 'deny']), nets[1]]);
    const pickIn = rng.next() < 0.35; // 多くは、どの行にも合わない(暗黙の拒否に当たる)送信元
    const [n0, p0] = (pickIn ? rng.pick(lines)[2] : nets[2]).split('/');
    const src = n2ip((ip2n(n0) + rng.rand(1, 2 ** (32 - Number(p0)) - 2)) >>> 0);
    const hit = lines.find(([, , np]) => { const [n, p] = np.split('/'); return inNet(src, n, Number(p)); });
    const pass = hit ? hit[1] === 'permit' : false;
    const sayPass = rng.next() < 0.5;
    const stmt = `この ACL で、送信元 ${src} のパケットは${sayPass ? '通る' : '捨てられる'}`;
    const truth = sayPass === pass;
    const tf = trueFalse(stmt, truth);
    return {
      text: `ACL が次の ${lines.length} 行だけのとき、次の文は正しいですか。\n「${stmt}」`,
      table: { headers: ['行', '動作', '送信元'], rows: lines.map(([n, a, np]) => [String(n), a, np]) },
      options: tf.options, answerIndex: tf.answerIndex, meta: { type: 'aclgen', src, lines, sayPass }, hint,
      explanation: `${tfWord(truth)}。${hit ? `${src} は行 ${hit[0]}(${hit[1]} ${hit[2]})に合うので${hit[1] === 'permit' ? '通る' : '捨てられる'}。` : `${src} はどの行にも合わないので、最後の見えない「すべて拒否」(暗黙の拒否)で捨てられる。`}`,
      kind: kindOf(128, 'implicit-deny'),
    };
  },
  verify(q) {
    if (q.meta.type !== 'aclgen') return checkMeta(q);
    let pass = false; // どれにも合わなければ拒否
    for (const [, a, np] of q.meta.lines) { const [n, p] = np.split('/'); if (sameNetBits(q.meta.src, n, Number(p))) { pass = a === 'permit'; break; } }
    must(q.answerIndex === (q.meta.sayPass === pass ? 0 : 1), `Lv128: ${q.meta.src} の ○×`);
  },
};

function cryptoRowQ(rng, lv) {
  const rows = CRYPTO.filter((r) => r.attrs.level === lv);
  const row = rng.pick(rows);
  return row.attrs.type === 'qa' ? qaChoice(rng, 'crypto', row) : rowTf('crypto', row);
}
LEVELS[130] = {
  title: '共通鍵', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '同じ鍵 = 共通鍵(例 AES)、対の 2 つの鍵 = 公開鍵(例 RSA)。共通鍵で n 人なら n(n−1)÷2 個';
    if (rng.next() < 0.6) return { ...cryptoRowQ(rng, 130), hint, kind: kindOf(130, 'symmetric') };
    const n = rng.rand(3, 20); const pub = rng.next() < 0.35;
    const ans = pub ? 2 * n : n * (n - 1) / 2;
    const cands = uniq([n * (n - 1) / 2, n * (n - 1), 2 * n, n, n * n, n + 1, 4 * n].filter((x) => x !== ans && x > 0));
    const c = choices(rng, `${ans} 個`, cands.map((x) => `${x} 個`));
    return {
      text: pub ? `${n} 人が、公開鍵と秘密鍵の組を 1 人 1 組ずつ持つ。鍵は全部で何個?` : `${n} 人のうちのどの 2 人も、ほかの人に読まれないように共通鍵暗号でやりとりしたい。2 人ごとに別の鍵を使うと、鍵は全部で何個要る?`,
      ...c, meta: { type: 'keycount', n, pub }, hint,
      explanation: pub ? `1 人が公開鍵と秘密鍵の 2 個を持つので ${n} × 2 = ${ans} 個。` : `2 人の組ごとに 1 個なので、組の数 ${n} × ${n - 1} ÷ 2 = ${ans} 個(公開鍵暗号なら 1 人 2 個で ${2 * n} 個で済む)。`,
      kind: kindOf(130, 'symmetric'),
    };
  },
  verify(q) {
    if (q.meta.type !== 'keycount') return checkMeta(q);
    const { n, pub } = q.meta;
    let want = 0;
    if (pub) for (let i = 0; i < n; i++) want += 2; else for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) want++;
    must(q.options[q.answerIndex] === `${want} 個` && q.options.filter((o) => o === `${want} 個`).length === 1, `Lv130: ${n} 人の鍵は ${want}`);
  },
};
const PEOPLE = ['A さん', 'B さん', 'C さん', 'D さん', 'E さん'];
const PK_ACTS = {
  enc: { ask: (x, y) => `${x}が${y}に、秘密のデータを公開鍵暗号で送る。${x}が暗号化に使う鍵は?`, owner: 'y', key: '公開鍵', why: '受け取る人の公開鍵で暗号化すれば、対の秘密鍵を持つ受け取る人だけが戻せる。' },
  dec: { ask: (x, y) => `${x}が${y}の公開鍵で暗号化したデータを送った。${y}が元に戻す(復号する)ときに使う鍵は?`, owner: 'y', key: '秘密鍵', why: '公開鍵で暗号化したものは、対の秘密鍵でしか戻せない。' },
  sign: { ask: (x, y) => `${x}が${y}に送る文書に電子署名を付ける。署名を作るのに使う鍵は?`, owner: 'x', key: '秘密鍵', why: '署名は送る人だけが持つ秘密鍵で作る。だから本人が作ったとわかる。' },
  check: { ask: (x, y) => `${y}が、${x}から届いた文書の電子署名を確かめる。使う鍵は?`, owner: 'x', key: '公開鍵', why: '署名した人の公開鍵で確かめる。公開鍵はだれでも手に入るので、だれでも確かめられる。' },
};
LEVELS[131] = {
  title: '公開鍵', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '受け取る人の公開鍵で閉じ、受け取る人の秘密鍵で開く。署名は送る人の秘密鍵で作り、送る人の公開鍵で確かめる';
    if (rng.next() < 0.35) return { ...cryptoRowQ(rng, 131), hint, kind: kindOf(131, 'public-key') };
    const [x, y] = rng.shuffle(PEOPLE).slice(0, 2);
    const act = rng.pick(Object.keys(PK_ACTS)); const a = PK_ACTS[act];
    const correct = `${a.owner === 'x' ? x : y}の${a.key}`;
    const options = rng.shuffle([`${x}の公開鍵`, `${x}の秘密鍵`, `${y}の公開鍵`, `${y}の秘密鍵`]);
    return { text: a.ask(x, y), options, answerIndex: options.indexOf(correct), meta: { type: 'pk', act, x, y }, hint, explanation: `正解は「${correct}」。${a.why}`, kind: kindOf(131, 'public-key') };
  },
  verify(q) {
    if (q.meta.type !== 'pk') return checkMeta(q);
    // 別の引き方: 「秘密にする向き(暗号)は受け取る人の鍵、本人の証明(署名)は送る人の鍵。閉じるのと確かめるのは公開鍵」
    const { act, x, y } = q.meta;
    const owner = act === 'enc' || act === 'dec' ? y : x;
    const kind = act === 'enc' || act === 'check' ? '公開鍵' : '秘密鍵';
    must(q.options[q.answerIndex] === `${owner}の${kind}`, `Lv131: ${act} は ${owner}の${kind}`);
  },
};

// ========== 無線・ケーブル(Lv132〜136) ==========
const BANDS = ['2.4 GHz', '5 GHz', '6 GHz'];
LEVELS[132] = {
  title: '無線の周波数帯', kind: '表', minDistinct: 30,
  make(rng) {
    const row = rng.pick(WBAND);
    const hint = '2.4 GHz は遠くまで届くが混みやすい(電子レンジ・Bluetooth と同じ)。5・6 GHz は速く空いている。11b・g は 2.4、11a・ac は 5、6E は 6';
    if (rng.next() < 0.5) {
      const options = rng.shuffle(BANDS);
      return { text: `無線 LAN の周波数帯で、${row.ja}`, options, answerIndex: options.indexOf(row.attrs.answer), meta: { type: 'band', row: row.id }, hint, explanation: `正解は ${row.attrs.answer}。${row.attrs.why}`, kind: kindOf(132, 'wifi-band') };
    }
    const band = rng.pick(BANDS); const truth = band === row.attrs.answer;
    const stmt = row.attrs.stmt.replace('{band}', band);
    const tf = trueFalse(stmt, truth);
    return { text: TF_TEXT(stmt), options: tf.options, answerIndex: tf.answerIndex, meta: { type: 'bandtf', row: row.id, band }, hint, explanation: `${tfWord(truth)}。答えは ${row.attrs.answer}。${row.attrs.why}`, kind: kindOf(132, 'wifi-band') };
  },
  verify(q) {
    const row = ROW.get(`wifi-band/${q.meta.row}`);
    if (q.meta.type === 'band') must(q.options[q.answerIndex] === row.attrs.answer && BANDS.includes(row.attrs.answer), `Lv132: ${row.id}`);
    else must(q.answerIndex === (q.meta.band === row.attrs.answer ? 0 : 1), `Lv132: ${row.id} の ○×`);
  },
};

const R_STD_NAME = rel('wifi-std-name', WSTD.map((r) => [r.ja, r.attrs.name]));
const R_NAME_STD = rel('wifi-name-std', WSTD.map((r) => [r.attrs.name, r.ja]));
const R_STD_NEXT = rel('wifi-next', WSTD.filter((r) => r.attrs.gen < 7).map((r) => [r.attrs.name, WSTD.find((s) => s.attrs.gen === r.attrs.gen + 1).attrs.name]));
const R_STD_PREV = rel('wifi-prev', WSTD.filter((r) => r.attrs.gen > 4).map((r) => [r.attrs.name, WSTD.find((s) => s.attrs.gen === r.attrs.gen - 1).attrs.name]));
LEVELS[133] = {
  title: '無線の規格名', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['name', 'std', 'tf', 'tf', 'next', 'prev']);
    let q;
    if (form === 'name') { q = relChoice(rng, R_STD_NAME); q.text = `${q.key} の呼び名は?`; } else if (form === 'std') { q = relChoice(rng, R_NAME_STD); q.text = `${q.key} は、どの規格の呼び名?`; } else if (form === 'tf') { q = relTf(rng, R_STD_NAME); q.text = TF_TEXT(`${q.key} は ${q.val} と呼ばれる`); } else if (form === 'next') { q = relChoice(rng, R_STD_NEXT, { pool: WSTD.map((r) => r.attrs.name), n: 3, notKey: true }); q.text = `${q.key} の 1 つ新しい世代は?`; } else { q = relChoice(rng, R_STD_PREV, { pool: WSTD.map((r) => r.attrs.name), n: 3, notKey: true }); q.text = `${q.key} の 1 つ前の世代は?`; }
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}802.11n = Wi-Fi 4、802.11ac = Wi-Fi 5、802.11ax = Wi-Fi 6、802.11be = Wi-Fi 7(数が大きいほど新しい)。`;
    return { ...q, hint: '802.11n = Wi-Fi 4、ac = 5、ax = 6、be = 7', kind: kindOf(133, 'wifi-standard') };
  },
  verify: checkMeta,
};

const SEC_NAMES = WSEC.map((r) => r.ja);
const secOrder = (name) => WSEC.find((r) => r.ja === name).attrs.order;
const R_SEC_CIPHER = rel('wifi-sec-cipher', WSEC.map((r) => [r.ja, r.attrs.cipher]));
const R_SEC_NTH = rel('wifi-sec-nth', WSEC.map((r) => [r.attrs.order, r.ja]));
LEVELS[134] = {
  title: '無線の暗号化', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '古い順に WEP → WPA → WPA2 → WPA3(数字が大きいほど新しい)。WEP は今は使わない';
    const form = rng.pick(['newest', 'newest', 'oldest', 'nth', 'cipher', 'tf', 'sae']);
    let q;
    if (form === 'newest' || form === 'oldest') {
      const set = rng.next() < 0.5 ? SEC_NAMES : rng.shuffle(SEC_NAMES).slice(0, 3);
      const best = set.slice().sort((a, b) => (secOrder(a) - secOrder(b)) * (form === 'newest' ? -1 : 1))[0];
      const options = rng.shuffle(set);
      q = { options, answerIndex: options.indexOf(best), meta: { type: 'secage', form } };
      q.text = form === 'newest' ? '無線 LAN の暗号化の方式で、次のうちいちばん新しいのは?' : '無線 LAN の暗号化の方式で、次のうちいちばん古く、今は使うべきでないのは?';
    } else if (form === 'nth') {
      const k = rng.rand(1, 4); q = relChoice(rng, R_SEC_NTH, { key: k }); q.text = `無線 LAN の暗号化の方式を古い順に並べたとき、${k} 番目は?`;
    } else if (form === 'cipher') {
      q = relChoice(rng, R_SEC_CIPHER, { key: rng.pick(['WEP', 'WPA', 'WPA2']), pool: ['RC4', 'TKIP', 'AES(CCMP)'], n: 3 }); q.text = `${q.key} で主に使われる暗号の方式は?`;
    } else if (form === 'tf') {
      const [a, b] = rng.shuffle(SEC_NAMES).slice(0, 2);
      const truth = secOrder(a) > secOrder(b); const stmt = `${a} は ${b} より新しい方式である`; const tf = trueFalse(stmt, truth);
      q = { text: TF_TEXT(stmt), options: tf.options, answerIndex: tf.answerIndex, meta: { type: 'secnewer', a, b } };
    } else {
      const options = rng.shuffle(SEC_NAMES);
      q = { text: 'パスワードを総当たりで推測されにくい鍵の交換(SAE)を取り入れたのは?', options, answerIndex: options.indexOf('WPA3'), meta: { type: 'sae' } };
    }
    q.explanation = `${q.options[q.answerIndex] === '○' || q.options[q.answerIndex] === '×' ? `${tfWord(q.answerIndex === 0)}。` : `正解は「${q.options[q.answerIndex]}」。`}古い順に WEP(RC4。すぐ破られるので使わない)→ WPA(TKIP)→ WPA2(AES)→ WPA3(SAE で推測に強い)。`;
    return { ...q, hint, kind: kindOf(134, 'wifi-security') };
  },
  verify(q) {
    const m = q.meta;
    if (m.type === 'secage') { const ords = q.options.map(secOrder); const want = m.form === 'newest' ? Math.max(...ords) : Math.min(...ords); must(secOrder(q.options[q.answerIndex]) === want, 'Lv134: 新しさ'); } else if (m.type === 'secnewer') must(q.answerIndex === (secOrder(m.a) > secOrder(m.b) ? 0 : 1), 'Lv134: ○×'); else if (m.type === 'sae') must(WSEC.find((r) => r.ja === q.options[q.answerIndex]).attrs.sae === true && WSEC.filter((r) => r.attrs.sae).length === 1, 'Lv134: SAE'); else checkMeta(q);
  },
};

const CATS = ['3', '5', '5e', '6', '6A', '8'];
const CAT_LABEL = (c) => `カテゴリ ${c}`;
// カテゴリで使える規格(長さ)。1000BASE-T とカテゴリ 5 は意見が分かれるので問いに使わない
const CAT_CAN = { '3': ['10t'], '5e': ['10t', '100tx', '1000t'], '6A': ['10t', '100tx', '1000t', '10gt'], '8': ['10t', '100tx', '1000t', '10gt', '40gt'] };
const cableRow = (id) => CABLE.find((r) => r.id === id);
LEVELS[135] = {
  title: 'LAN ケーブルのカテゴリ', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '5e は 1000BASE-T、6A は 10GBASE-T を 100 m で。40GBASE-T はカテゴリ 8 で 30 m。より対線は 100 m まで';
    const form = rng.pick(['lowest', 'lowest', 'fastest', 'tf']);
    if (form === 'tf') return { ...rowTf('cable-facts', rng.pick(CABLE_FACTS)), hint, kind: kindOf(135, 'cable-category') };
    if (form === 'lowest') {
      const row = rng.pick(CABLE.filter((r) => r.attrs.cat));
      const c = choices(rng, CAT_LABEL(row.attrs.cat), CATS.filter((x) => x !== row.attrs.cat).map(CAT_LABEL));
      return { text: `${row.ja} を ${row.attrs.len} m で使えるカテゴリのうち、いちばん下(低い)のものは?`, ...c, meta: { type: 'catlow', std: row.id }, hint, explanation: `${row.ja} は${CAT_LABEL(row.attrs.cat)}から使える(${row.attrs.len} m まで)。10BASE-T はカテゴリ 3、100BASE-TX は 5、10GBASE-T は 6A、40GBASE-T は 8(30 m)。それより上のカテゴリでも使えるが、いちばん下ではない。`, kind: kindOf(135, 'cable-category') };
    }
    const cat = rng.pick(Object.keys(CAT_CAN));
    const can = CAT_CAN[cat];
    const best = can.slice().sort((a, b) => cableRow(b).attrs.mbps - cableRow(a).attrs.mbps)[0];
    const len = cat === '8' ? 30 : 100;
    const c = choices(rng, cableRow(best).ja, CABLE.filter((r) => r.id !== best).map((r) => r.ja));
    return { text: `次のうち、${CAT_LABEL(cat)} のケーブルで ${len} m まで使える、いちばん速い規格は?`, ...c, meta: { type: 'catfast', cat }, hint, explanation: `${CAT_LABEL(cat)} で使えるのは ${can.map((id) => cableRow(id).ja).join('・')}。そのうちいちばん速いのは ${cableRow(best).ja}。`, kind: kindOf(135, 'cable-category') };
  },
  verify(q) {
    const m = q.meta;
    if (m.type === 'catlow') {
      const row = cableRow(m.std); const lowest = CATS.find((c) => (CAT_CAN[c] || []).includes(m.std) || c === row.attrs.cat);
      must(q.options[q.answerIndex] === CAT_LABEL(lowest) && lowest === row.attrs.cat, `Lv135: ${row.ja} のいちばん下は ${lowest}`);
    } else if (m.type === 'catfast') {
      const ok = q.options.filter((o) => CAT_CAN[m.cat].includes(CABLE.find((r) => r.ja === o).id));
      const fastest = ok.sort((a, b) => CABLE.find((r) => r.ja === b).attrs.mbps - CABLE.find((r) => r.ja === a).attrs.mbps)[0];
      must(q.options[q.answerIndex] === fastest, `Lv135: カテゴリ ${m.cat} でいちばん速いのは ${fastest}`);
    } else checkMeta(q);
  },
};

const R_POE_NICK = rel('poe-nick', POE.map((r) => [r.ja, r.attrs.nick]));
const R_NICK_POE = rel('poe-nick-std', POE.map((r) => [r.attrs.nick, r.ja]));
const R_POE_WATT = rel('poe-watt', POE.map((r) => [r.ja, `${r.attrs.watt} W`]));
LEVELS[136] = {
  title: 'PoE', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = 'PoE は LAN ケーブルで電気も送る。802.3af(PoE)15.4 W、802.3at(PoE+)30 W、802.3bt タイプ 4 は 90 W(どれも給電側の 1 ポートあたり)';
    const form = rng.pick(['row', 'row', 'row', 'nick', 'std', 'watt', 'tfw', 'tfn']);
    if (form === 'row') return { ...rowTf('poe-facts', rng.pick(POE_FACTS)), hint, kind: kindOf(136, 'poe') };
    let q;
    if (form === 'nick') { q = relChoice(rng, R_POE_NICK, { n: 3 }); q.text = `${q.key} の呼び名は?`; } else if (form === 'std') { q = relChoice(rng, R_NICK_POE, { n: 3 }); q.text = `「${q.key}」と呼ばれる規格は?`; } else if (form === 'watt') { q = relChoice(rng, R_POE_WATT, { n: 3 }); q.text = `${q.key} で、給電側(スイッチなど)が 1 ポートあたりに送れる最大の電力は?`; } else if (form === 'tfw') { q = relTf(rng, R_POE_WATT); q.text = TF_TEXT(`${q.key} の給電側の最大電力は、1 ポートあたり ${q.val} である`); } else { q = relTf(rng, R_POE_NICK); q.text = TF_TEXT(`${q.key} は「${q.val}」と呼ばれる`); }
    q.explanation = `${form.startsWith('tf') ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}802.3af = PoE(15.4 W)、802.3at = PoE+(30 W)、802.3bt タイプ 4 = PoE++(90 W)。電力は給電側の 1 ポートあたりの最大。`;
    return { ...q, hint, kind: kindOf(136, 'poe') };
  },
  verify: checkMeta,
};

// ========== 確かめる・速さ(Lv137〜142) ==========
const PING_MEANINGS = PING.map((r) => r.attrs.meaning);
// 出力の行の印(解説に出す文字と、確かめに使う形)
const PING_SIG = {
  reply: { text: 'Reply from 宛先: bytes=…', re: /^Reply from [\d.]+: bytes=/ },
  timeout: { text: 'Request timed out.', re: /^Request timed out\.$/ },
  'host-unreach': { text: 'Destination host unreachable.', re: /Destination host unreachable/ },
  'net-unreach': { text: 'Destination net unreachable.', re: /Destination net unreachable/ },
  ttl: { text: 'TTL expired in transit.', re: /TTL expired in transit/ },
  noname: { text: 'could not find host', re: /could not find host/ },
};
LEVELS[137] = {
  title: 'ping の結果の種類', kind: '表', minDistinct: 30,
  make(rng) {
    const row = rng.pick(PING);
    const dst = rng.next() < 0.5 ? docAddr(rng) : privAddr(rng);
    const gw = rng.next() < 0.5 ? `192.168.${o8(rng)}.1` : `10.${o8(rng)}.${o8(rng)}.1`;
    const name = `${rng.pick(HOSTS)}.${zoneOf(rng)}`;
    const ttl = rng.rand(40, 64);
    const line = () => row.attrs.line.replace('{ip}', dst).replace('{gw}', gw).replace('{name}', name).replace('{ms}', String(rng.rand(1, 40))).replace('{ttl}', String(ttl));
    const rows = row.id === 'noname' ? [[line()]] : [[`Pinging ${dst} with 32 bytes of data:`]].concat([1, 2, 3, 4].map(() => [line()]));
    const c = choices(rng, row.attrs.meaning, PING_MEANINGS.filter((m) => m !== row.attrs.meaning));
    return {
      text: `PC で ping を打つと、次のように表示された。わかることは?`, table: { headers: ['ping の出力'], rows }, ...c,
      meta: { type: 'ping', row: row.id },
      hint: 'Reply from 宛先 = 返事が来た、timed out = 返事が来ない、unreachable = 届けられないという知らせ、TTL expired = 途中で TTL が切れた、could not find host = 名前が引けない',
      explanation: `正解は「${row.attrs.meaning}」。出力の「${PING_SIG[row.id].text}」がその印。Reply from 宛先 は届いて返事が戻った、Request timed out は返事そのものが来ない、Destination host / net unreachable は「届けられない」という返事が来た、TTL expired は途中で TTL が 0 になった、could not find host は名前から IP アドレスを引けなかった。`,
      kind: kindOf(137, 'ping-result'),
    };
  },
  verify(q) {
    const row = ROW.get(`ping-output/${q.meta.row}`);
    must(q.options[q.answerIndex] === row.attrs.meaning && q.options.filter((o) => o === row.attrs.meaning).length === 1, `Lv137: ${row.id}`);
    // 出力の行が、その種類の印を持っていること
    must(q.table.rows.some(([l]) => PING_SIG[row.id].re.test(l)), `Lv137: 出力に ${row.id} の印が無い`);
    for (const [id, s] of Object.entries(PING_SIG)) if (id !== row.id) must(!q.table.rows.some(([l]) => s.re.test(l)), `Lv137: 出力に別の種類 ${id} の印がある`);
  },
};

LEVELS[138] = {
  title: 'ping の損失', kind: '生', minDistinct: 1000,
  make(rng) {
    const n = rng.pick([4, 5, 10, 20, 25, 50, 100]);
    const step = 100 / n; // 1 個の損失が何 % か
    const lost = rng.rand(0, n); const r = n - lost; const pct = lost * step;
    const dst = rng.next() < 0.5 ? docAddr(rng) : privAddr(rng);
    const askPct = rng.next() < 0.65;
    return {
      text: askPct
        ? `${dst} に ping を ${n} 回送った。結果は「送信 = ${n}、受信 = ${r}」だった。損失は何 %?`
        : `${dst} に ping を ${n} 回送ったところ、損失は ${pct} % だった。返事(受信)はいくつ?`,
      ...input(askPct ? 'loss' : 'recv', askPct ? '損失(%)' : '受信の数', 'number', [String(askPct ? pct : r)], '数だけ'),
      meta: { type: 'loss', n, r, askPct },
      hint: '損失 % = (送信 − 受信)÷ 送信 × 100',
      explanation: askPct ? `失われたのは ${n} − ${r} = ${lost} 個。${lost} ÷ ${n} × 100 = ${pct} %。` : `失われたのは ${n} × ${pct} ÷ 100 = ${lost} 個。受信は ${n} − ${lost} = ${r}。`,
      kind: kindOf(138, 'ping-loss'),
    };
  },
  verify(q) {
    const { n, r, askPct } = q.meta;
    // 別の方法: 1 回ずつ数え、割合は 分数を約分せず 100 倍して割り切れるか確かめる
    let lost = 0; for (let i = 0; i < n; i++) if (i >= r) lost++;
    must((lost * 100) % n === 0, `Lv138: 割り切れない ${n} ${r}`);
    const want = askPct ? (lost * 100) / n : n - lost;
    must(q.fields[0].accept[0] === String(want), `Lv138: 答えは ${want}`);
  },
};

// ipconfig の出力(架空の PC。Windows の表示の形に似せた抜き出し)
function ipconfigOut(rng, all) {
  const pre = rng.pick(['192.168', '10', '172']);
  const net = pre === '192.168' ? `192.168.${o8(rng)}` : pre === '10' ? `10.${o8(rng)}.${o8(rng)}` : `172.${rng.rand(16, 31)}.${o8(rng)}`;
  const hosts = rng.shuffle([...Array(250).keys()].map((i) => i + 2).filter((h) => h !== 53)).slice(0, 4); // .53 は DNS サーバーに使う
  const gw = `${net}.${rng.pick([1, 254, hosts[0]])}`;
  let ip = `${net}.${hosts[1]}`; if (ip === gw) ip = `${net}.${hosts[2]}`;
  const dhcp = rng.next() < 0.5 ? gw : `${net}.${hosts[3] === Number(ip.split('.')[3]) ? hosts[2] : hosts[3]}`;
  const dns1 = rng.next() < 0.5 ? `${net}.53` : docAddr(rng);
  let dns2 = rng.next() < 0.5 ? docAddr(rng) : null;
  if (dns2 === dns1) dns2 = null;
  const ll = `fe80::${rng.rand(1, 0xffff).toString(16)}:${rng.rand(1, 0xffff).toString(16)}%${rng.rand(2, 20)}`;
  const mac = ['02', ...[...Array(5)].map(() => o8(rng).toString(16).padStart(2, '0'))].join('-').toUpperCase();
  const rows = [];
  if (all) rows.push(['物理アドレス', mac], ['DHCP 有効', 'はい']);
  rows.push(['リンクローカル IPv6 アドレス', ll], ['IPv4 アドレス', ip], ['サブネット マスク', '255.255.255.0'], ['デフォルト ゲートウェイ', gw]);
  if (all) { rows.push(['DHCP サーバー', dhcp], ['DNS サーバー', dns1]); if (dns2) rows.push(['', dns2]); }
  return { rows, ip, gw, dhcp, dns1, dns2, ll };
}
function readOutQ(rng, lv, all, field) {
  const o = ipconfigOut(rng, all);
  const correct = o[field];
  // 誤答は出力に出ているほかの値(物理アドレスと「はい」は除く)
  const pool = uniq(o.rows.map((r) => r[1]).filter((v) => v !== correct && v !== 'はい' && !/^[0-9A-F]{2}-/.test(v)));
  const ask = field === 'gw' ? 'この PC のデフォルトゲートウェイ(別の網へ送るときに渡すルーター)は?' : 'この PC が名前を調べるときに最初に問い合わせる DNS サーバーは?';
  const base = {
    table: { headers: ['項目', '値'], rows: o.rows }, meta: { type: 'ipconfig', field, rows: o.rows },
    hint: field === 'gw' ? '「デフォルト ゲートウェイ」の行を読む' : '「DNS サーバー」の行を読む(2 つあれば上の行が先に使われる)',
    explanation: field === 'gw'
      ? `「デフォルト ゲートウェイ」の行の ${o.gw} が答え。IPv4 アドレスの行は自分自身、サブネット マスクは網の大きさ、リンクローカル IPv6 アドレスは同じリンクの中だけで使うアドレス。`
      : `「DNS サーバー」の行の ${o.dns1} が答え${o.dns2 ? `(その下の ${o.dns2} は 2 つ目で、1 つ目が答えないときに使う)` : ''}。デフォルト ゲートウェイや DHCP サーバーとは別の項目。`,
    kind: kindOf(lv, field === 'gw' ? 'read-gateway' : 'read-dns'),
  };
  const text = `${all ? 'ipconfig /all' : 'ipconfig'} の出力(抜き出し)が次のとき、${ask}`;
  if (rng.next() < 0.4) return { text, ...base, ...input(field, field === 'gw' ? 'デフォルトゲートウェイ' : 'DNS サーバー', 'ipv4', [correct], 'a.b.c.d の形') };
  const c = choices(rng, correct, pool);
  return { text, ...base, ...c };
}
function readOutVerify(q) {
  const label = q.meta.field === 'gw' ? 'デフォルト ゲートウェイ' : 'DNS サーバー';
  const want = q.meta.rows.find(([k]) => k === label)[1];
  if (q.answerKind === 'text') must(q.fields[0].accept[0] === want, `読む: ${want}`);
  else must(q.options[q.answerIndex] === want && q.options.filter((x) => x === want).length === 1, `読む: ${want}`);
}
LEVELS[139] = { title: '設定の出力: ゲートウェイ', kind: '生', minDistinct: 1000, make: (rng) => readOutQ(rng, 139, rng.next() < 0.3, 'gw'), verify: readOutVerify };
LEVELS[140] = { title: '設定の出力: DNS', kind: '生', minDistinct: 1000, make: (rng) => readOutQ(rng, 140, true, 'dns1'), verify: readOutVerify };

// 転送時間。速さは Mbps(1 Mbps = 10^6 ビット/秒)、大きさは MB か GB(1 MB = 10^6 バイト、1 GB = 10^9 バイト)
const SPEEDS = [10, 20, 25, 40, 50, 80, 100, 200, 250, 400, 500, 1000, 2000, 10000];
const speedText = (m) => (m >= 1000 && m % 1000 === 0 ? `${m / 1000} Gbps` : `${m} Mbps`);
const sizeText = (mb) => (mb >= 1000 && mb % 1000 === 0 ? `${mb / 1000} GB` : `${mb} MB`);
function transferQ(rng, lv, withRatio) {
  let mbps; let mb; let t; let ratio = 100; let guard = 0;
  do {
    mbps = rng.pick(SPEEDS); ratio = withRatio ? rng.pick([10, 20, 25, 40, 50, 60, 75, 80, 90]) : 100;
    t = rng.rand(1, 300);
    mb = (t * mbps * ratio) / 100 / 8; // 秒 × 使える速さ(Mbps)÷ 8 = MB
  } while ((!Number.isInteger(mb) || mb < 1 || mb > 100000) && guard++ < 200);
  if (!Number.isInteger(mb) || mb < 1) { mbps = 100; ratio = withRatio ? 80 : 100; t = 10; mb = withRatio ? 100 : 125; }
  const eff = (mbps * ratio) / 100;
  return {
    text: `${sizeText(mb)} のファイルを ${speedText(mbps)} の回線で送る。${withRatio ? `伝送効率(回線の速さのうち実際に使える割合)は ${ratio} % とする。` : ''}何秒かかる?(1 MB = 10^6 バイト、1 GB = 10^9 バイト、1 Mbps = 10^6 ビット/秒、1 Gbps = 10^9 ビット/秒。ほかの遅れは考えない)`,
    ...input('sec', '秒', 'number', [String(t)], '数だけ'),
    meta: { type: 'xfer', mb, mbps, ratio },
    hint: withRatio ? '使える速さ = 回線の速さ × 割合。時間 = ビット ÷ 使える速さ' : 'バイト × 8 = ビット。ビット ÷ 速さ(ビット/秒)= 秒',
    explanation: `${sizeText(mb)} = ${mb} × 10^6 バイト = ${mb * 8} × 10^6 ビット。${withRatio ? `使える速さは ${mbps} × ${ratio} % = ${eff} × 10^6 ビット/秒。` : `速さは ${mbps} × 10^6 ビット/秒。`}${mb * 8} ÷ ${eff} = ${t} 秒。`,
    kind: kindOf(lv, withRatio ? 'transfer-efficiency' : 'transfer-time'),
  };
}
function transferVerify(q) {
  const { mb, mbps, ratio } = q.meta;
  const bits = BigInt(mb) * 1000000n * 8n; const bps100 = BigInt(mbps) * 1000000n * BigInt(ratio); // 使える速さ × 100
  must((bits * 100n) % bps100 === 0n, `転送時間が割り切れない ${mb} ${mbps} ${ratio}`);
  must(q.fields[0].accept[0] === String((bits * 100n) / bps100), '転送時間が合わない');
}
LEVELS[141] = { title: '転送時間', kind: '生', minDistinct: 1000, make: (rng) => transferQ(rng, 141, false), verify: transferVerify };
LEVELS[142] = { title: '使える割合を入れた転送時間', kind: '生', minDistinct: 1000, make: (rng) => transferQ(rng, 142, true), verify: transferVerify };

// ========== クラウド・仮想化・リモート(Lv143〜148) ==========
const MODELS = typed(CLOUD, 'model');
const MODEL_NAMES = MODELS.map((r) => r.ja);
const LAYERS_C = typed(CLOUD, 'layer');
const R_MODEL_DESC = rel('cloud-desc-model', MODELS.map((r) => [r.attrs.desc, r.ja]));
const R_MODEL_NAME = rel('cloud-model-desc', MODELS.map((r) => [r.ja, r.attrs.desc]));
const R_MODEL_EX = rel('cloud-ex', typed(CLOUD, 'ex').map((r) => [r.ja, r.attrs.answer]));
const WIDTH = { IaaS: 'いちばん広い', SaaS: 'いちばん狭い' };
const R_MODEL_WIDTH = rel('cloud-width', Object.entries(WIDTH).map(([m, w]) => [w, m]));
const USER = '使う側(借りた人)'; const PROV = 'クラウド事業者';
const R_WHO = rel('cloud-who', MODEL_NAMES.flatMap((m) => LAYERS_C.map((l) => [`${m}|${l.ja}`, l.attrs.user.includes(m) ? USER : PROV])));
const R_USER_LAYER = rel('cloud-user-layer', MODEL_NAMES.flatMap((m) => LAYERS_C.filter((l) => l.attrs.user.includes(m)).map((l) => [m, l.ja])));
const R_PROV_LAYER = rel('cloud-prov-layer', MODEL_NAMES.flatMap((m) => LAYERS_C.filter((l) => !l.attrs.user.includes(m)).map((l) => [m, l.ja])));
const CLOUD_NOTE = 'IaaS は機械(仮想マシン・ネットワーク)だけを借り、OS から上は使う側が管理する。PaaS は OS と実行環境まで事業者が用意し、使う側はアプリを載せる。SaaS はアプリまで事業者が用意する。利用者の ID と権限の設定は、どの形でも使う側の仕事。';
LEVELS[143] = {
  title: 'IaaS・PaaS・SaaS', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['desc', 'name', 'ex', 'ex', 'width', 'tf']);
    let q;
    if (form === 'desc') { q = relChoice(rng, R_MODEL_DESC, { n: 3 }); q.text = `次の使い方に当たるのは?\n「${q.key}」`; } else if (form === 'name') { q = relChoice(rng, R_MODEL_NAME, { n: 3 }); q.text = `${w(q.key)}の説明は?`; } else if (form === 'ex') { q = relChoice(rng, R_MODEL_EX, { pool: MODEL_NAMES, n: 3 }); q.text = `次の使い方は、IaaS・PaaS・SaaS のどれ?\n「${q.key}」`; } else if (form === 'width') { q = relChoice(rng, R_MODEL_WIDTH, { pool: MODEL_NAMES, n: 3 }); q.text = `IaaS・PaaS・SaaS のうち、使う側が自分で管理する範囲が${q.key}のは?`; } else {
      const k = rng.pick(R_WHO.keys); const [m, l] = k.split('|'); const who = rng.pick([USER, PROV]);
      const truth = R_WHO.main(k, who); const stmt = `${m} では、「${l}」を${who === USER ? '使う側' : 'クラウド事業者'}が管理する`;
      const tf = trueFalse(stmt, truth);
      q = { text: TF_TEXT(stmt), options: tf.options, answerIndex: tf.answerIndex, meta: { type: 'reltf', rel: 'cloud-who', key: k, val: who } };
    }
    q.explanation = `${form === 'tf' ? `${tfWord(q.answerIndex === 0)}。` : `正解は「${q.options[q.answerIndex]}」。`}${CLOUD_NOTE}`;
    return { ...q, hint: 'IaaS は機械だけ借りる(OS から自分)、PaaS は土台まで借りる(アプリを載せる)、SaaS はアプリまで借りる', kind: kindOf(143, 'iaas-paas-saas') };
  },
  verify: checkMeta,
};
LEVELS[144] = {
  title: '責任の分け方', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['who', 'who', 'user', 'prov']);
    let q;
    if (form === 'who') { const k = rng.pick(R_WHO.keys); q = relChoice(rng, R_WHO, { key: k, n: 2 }); const [m, l] = k.split('|'); q.text = `${m} を使うとき、「${l}」を管理するのは?`; } else if (form === 'user') { const m = rng.pick(MODEL_NAMES); q = relChoice(rng, R_USER_LAYER, { key: m, pool: LAYERS_C.map((l) => l.ja) }); q.text = `${m} を使うとき、使う側(借りた人)が管理するものは?`; } else { const m = rng.pick(['IaaS', 'PaaS']); q = relChoice(rng, R_PROV_LAYER, { key: m, pool: LAYERS_C.map((l) => l.ja), n: m === 'PaaS' ? 3 : 4 }); q.text = `${m} を使うとき、クラウド事業者が管理するものは?`; }
    q.explanation = `正解は「${q.options[q.answerIndex]}」。借りた範囲より下(建物・機械・ハイパーバイザーなど)は事業者、上は使う側。${CLOUD_NOTE}`;
    return { ...q, hint: '借りた範囲より下は事業者、上は使う側。ID と権限の設定はどれでも使う側', kind: kindOf(144, 'shared-responsibility') };
  },
  verify: checkMeta,
};

const VIRT_NAMES = VIRT.map((r) => r.ja);
const R_V_DESC = rel('virt-desc', VIRT.map((r) => [r.attrs.desc, r.ja]));
const R_V_NAME = rel('virt-name', VIRT.map((r) => [r.ja, r.attrs.desc]));
LEVELS[145] = {
  title: '仮想マシンとハイパーバイザー', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['desc', 'desc', 'name', 'tf']);
    let q;
    if (form === 'desc') { q = relChoice(rng, R_V_DESC, { pool: VIRT_NAMES }); q.text = `次のものを何という?\n「${q.key}」`; } else if (form === 'name') { q = relChoice(rng, R_V_NAME); q.text = `${w(q.key)}の説明は?`; } else { q = relTf(rng, R_V_DESC, { pool: VIRT_NAMES }); q.text = TF_TEXT(`「${q.key}」を、${w(q.val)}という`); }
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}ハイパーバイザーは物理の機械の上で仮想マシンを分けて動かす土台。仮想マシンの中の OS がゲスト OS、物理の機械に入っている OS がホスト OS。コンテナは土台の OS を共有する別のしくみ。`;
    return { ...q, hint: 'ハイパーバイザー = 仮想マシンを動かす土台。仮想マシンの中の OS = ゲスト OS', kind: kindOf(145, 'hypervisor') };
  },
  verify: checkMeta,
};
const VMC_NAME = { vm: '仮想マシン', container: 'コンテナ' };
const R_VMC = rel('vm-container', VMC.map((r) => [r.ja, VMC_NAME[r.attrs.kind]]));
const R_VMC_DESC = rel('vm-container-desc', VMC.map((r) => [VMC_NAME[r.attrs.kind], r.ja]));
LEVELS[146] = {
  title: '仮想マシンとコンテナ', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['which', 'which', 'desc', 'tf']);
    let q;
    if (form === 'which') { q = relChoice(rng, R_VMC, { n: 2 }); q.text = `次の説明に当たるのは、仮想マシンとコンテナのどちら?\n「${q.key}」`; } else if (form === 'desc') { q = relChoice(rng, R_VMC_DESC); q.text = `${q.key}に当てはまるのは?`; } else { q = relTf(rng, R_VMC); q.text = TF_TEXT(`「${q.key}」のは、${q.val}の特徴である`); }
    q.explanation = `${form === 'tf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}仮想マシンはハイパーバイザーの上で OS ごと動く(違う種類の OS も動かせる)。コンテナは土台の OS を共有し、アプリと部品だけを分けるので軽く速く起動する。`;
    return { ...q, hint: '仮想マシンは OS ごと持つ、コンテナは土台の OS を共有して軽い', kind: kindOf(146, 'vm-container') };
  },
  verify: checkMeta,
};
const REMOTE_NAMES = REMOTE.map((r) => r.ja);
const R_R_DESC = rel('remote-desc', REMOTE.map((r) => [r.attrs.desc, r.ja]));
const R_R_NAME = rel('remote-name', REMOTE.map((r) => [r.ja, r.attrs.desc]));
const R_R_EX = rel('remote-ex', REMOTE_EX.map((r) => [r.ja, r.attrs.answer]));
LEVELS[147] = {
  title: '遠くの画面を操作する', kind: '表', minDistinct: 30,
  make(rng) {
    const form = rng.pick(['desc', 'name', 'ex', 'ex']);
    let q;
    if (form === 'desc') { q = relChoice(rng, R_R_DESC, { pool: REMOTE_NAMES }); q.text = `次のしくみを何という?\n「${q.key}」`; } else if (form === 'name') { q = relChoice(rng, R_R_NAME); q.text = `${w(q.key)}の説明は?`; } else { q = relChoice(rng, R_R_EX, { pool: REMOTE_NAMES }); q.text = `次の使い方に当たるしくみは?\n「${q.key}」`; }
    q.explanation = `正解は「${q.options[q.answerIndex]}」。リモートデスクトップ = 離れた PC の画面を手元で操作、SSH = 暗号化してコマンドで操作、Telnet = 暗号化しない(今は避ける)、VPN = 社内の網につながる暗号化した通り道、FTP = ファイルを送り受けする。`;
    return { ...q, hint: 'リモートデスクトップ = 画面を操作、SSH = 暗号化してコマンド、VPN = 社内の網につながる道', kind: kindOf(147, 'remote-access') };
  },
  verify: checkMeta,
};
const VDI_TERMS = typed(VDI, 'term');
const R_VDI_DESC = rel('vdi-desc', VDI_TERMS.map((r) => [r.attrs.desc, r.ja]));
const R_VDI_NAME = rel('vdi-name', VDI_TERMS.map((r) => [r.ja, r.attrs.desc]));
LEVELS[148] = {
  title: '仮想デスクトップ', kind: '表', minDistinct: 30,
  make(rng) {
    const hint = '仮想デスクトップは、デスクトップがサーバー側で動き、手元には画面だけが届く';
    const form = rng.pick(['desc', 'name', 'tf', 'tf', 'termtf']);
    if (form === 'tf') return { ...rowTf('vdi', rng.pick(typed(VDI, 'tf'))), hint, kind: kindOf(148, 'vdi') };
    let q;
    if (form === 'desc') { q = relChoice(rng, R_VDI_DESC); q.text = `次のものを何という?\n「${q.key}」`; } else if (form === 'name') { q = relChoice(rng, R_VDI_NAME); q.text = `${w(q.key)}の説明は?`; } else { q = relTf(rng, R_VDI_DESC); q.text = TF_TEXT(`「${q.key}」ものを、${w(q.val)}という`); }
    q.explanation = `${form === 'termtf' ? `${tfWord(q.isTrue)}。` : `正解は「${q.options[q.answerIndex]}」。`}仮想デスクトップ(VDI)はデスクトップをサーバー側の仮想マシンで動かし、手元には画面だけを届ける。手元の端末を表示と入力だけにしたものがシンクライアント、手元にアプリもデータも持つのがファットクライアント、仮想デスクトップをクラウドのサービスとして借りるのが DaaS。`;
    return { ...q, hint, kind: kindOf(148, 'vdi') };
  },
  verify: checkMeta,
};

// ---------- 表の問題の確かめ(meta から表を引き直す) ----------
function checkMeta(q) {
  const m = q.meta;
  must(m && m.type, `meta がない: ${q.text}`);
  if (m.type === 'rel') {
    const R = RELS[m.rel];
    const ok = q.options.filter((o) => R.has(m.key, o));
    must(ok.length === 1 && ok[0] === q.options[q.answerIndex] && R.main(m.key, ok[0]), `${m.rel}: 正解が 1 つでない(${m.key} → ${q.options.join(' / ')})`);
  } else if (m.type === 'reltf') {
    const R = RELS[m.rel];
    must(R.main(m.key, m.val) === R.has(m.key, m.val), `${m.rel}: ○× に「そうとも言える」組を使った`);
    must(q.options.join() === '○,×' && q.answerIndex === (R.main(m.key, m.val) ? 0 : 1), `${m.rel}: ○× が合わない(${m.key} / ${m.val})`);
  } else if (m.type === 'qa') {
    const row = ROW.get(m.row);
    must(q.options[q.answerIndex] === row.attrs.answer, `${m.row}: 正解が違う`);
    must(q.options.every((o) => o === row.attrs.answer || row.attrs.wrongs.includes(o)), `${m.row}: 表に無い誤答`);
    must(!row.attrs.wrongs.includes(row.attrs.answer), `${m.row}: 誤答に正解が入っている`);
  } else if (m.type === 'tf') {
    const row = ROW.get(m.row);
    must(typeof row.attrs.true === 'boolean' && q.answerIndex === (row.attrs.true ? 0 : 1), `${m.row}: ○× が合わない`);
  } else if (m.type === 'order') {
    const ranks = m.labels.map(RANK[m.rank]);
    must(new Set(ranks).size === ranks.length, `並べ替え ${m.rank}: 同じ順位がある`);
    const idx = m.labels.map((_, i) => i + 1).sort((a, b) => (ranks[a - 1] - ranks[b - 1]) * (m.desc ? -1 : 1));
    must(q.fields[0].accept[0] === normalize('devname', idx.join(' ')), `並べ替え ${m.rank}: 答えが違う`);
    must(q.fields[0].accept[0] !== m.labels.map((_, i) => i + 1).join(''), `並べ替え ${m.rank}: 見せた順がそのまま答え`);
  } else throw new Error(`知らない meta: ${m.type}`);
}

module.exports = { LEVELS, RELS, ROW };
