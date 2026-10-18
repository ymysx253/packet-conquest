'use strict';
// Lv51〜60(transport.js)の検証。生成器とは別の実装(表の読み直し、逐次シミュレーション、線形走査)で答えを解き直す。
// 固定 seed 列(seed = i)で 1 万件、FactBank は全行 × 問いの型を全数。docs/questions/COMMON.md 第 8 章の流儀。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../server/questions/transport');
const { make, RANGE, VERSION, BY_LEVEL, FACTS, internals: I } = T;
const { makeRng } = require('../server/questions/rng');
const { normalize, judge } = require('../server/questions/normalize');
const { NODES } = require('../server/map/tokyo');

// ---------- 安全規則(COMMON 第 7 章)の簡易リンタ ----------
const ALLOWED_V4 = [[10, 0, 0, 0, 8], [172, 16, 0, 0, 12], [192, 168, 0, 0, 16], [192, 0, 2, 0, 24], [198, 51, 100, 0, 24], [203, 0, 113, 0, 24]];
const ipNum = (a, b, c, d) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
function v4Allowed(s) {
  const o = s.split('.').map(Number); const n = ipNum(...o);
  return ALLOWED_V4.some(([a, b, c, d, p]) => (n >>> (32 - p)) === (ipNum(a, b, c, d) >>> (32 - p)));
}
const BANNED = ['Cisco', 'Juniper', 'Windows', 'Linux', 'nmap', 'hping', 'Wireshark', 'tcpdump', 'netcat', 'metasploit', 'Google', 'Amazon', 'Microsoft'];
function allStrings(q) {
  const out = [q.text, q.explanation, q.defenseNote];
  if (q.options) out.push(...q.options);
  if (q.fields) for (const f of q.fields) out.push(f.label, f.hint || '');
  for (const t of [q.table].concat(q.tables || []).filter(Boolean)) { out.push(...(t.headers || []), t.title || ''); for (const r of t.rows) out.push(...r); }
  return out.filter((s) => s !== undefined && s !== null).map(String);
}
function lint(q) {
  assert.ok(typeof q.defenseNote === 'string' && q.defenseNote.trim(), `${q.type}: defenseNote が空`);
  for (const s of allStrings(q)) {
    for (const m of s.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || []) assert.ok(v4Allowed(m), `${q.type}: 範囲外のアドレス ${m} in ${s}`);
    for (const m of s.match(/[a-z0-9-]+\.(com|net|org|jp|io|co)\b/gi) || []) assert.fail(`${q.type}: .example 以外のドメイン ${m}`);
    for (const w of BANNED) assert.ok(!s.includes(w), `${q.type}: 禁止語 ${w} in ${s}`);
  }
}

// ---------- 共通の形の検査 ----------
function checkShape(q, level) {
  assert.strictEqual(q.level, level);
  assert.ok(q.templateId && /^[a-z0-9-]+-v\d+$/.test(q.templateId), `templateId の形 ${q.templateId}`);
  assert.ok(Number.isInteger(q.seed), 'seed');
  assert.strictEqual(q.generatorVersion, VERSION);
  assert.ok(q.type && q.meta && q.text && q.explanation, q.type);
  assert.ok(q.answerKind === 'choice' || q.answerKind === 'text');
  if (q.answerKind === 'choice') {
    assert.strictEqual(q.options.length, 4, q.type);
    assert.strictEqual(new Set(q.options.map((o) => String(o).trim())).size, 4, `${q.type}: 選択肢が重複 ${q.options}`);
    assert.ok(q.answerIndex >= 0 && q.answerIndex < 4);
    assert.ok(judge(q, q.answerIndex) && !judge(q, (q.answerIndex + 1) % 4));
  } else {
    assert.ok(Array.isArray(q.fields) && q.fields.length >= 1 && q.fields.length <= 6);
    assert.strictEqual(new Set(q.fields.map((f) => f.name)).size, q.fields.length, 'name の重複なし');
    for (const f of q.fields) {
      assert.ok(f.label && f.format && Array.isArray(f.accept) && f.accept.length >= 1, `${q.type}: fields`);
      for (const a of f.accept) assert.strictEqual(normalize(f.format, a, f), a, `${q.type}: accept が正規形でない ${a}`);
    }
    assert.ok(judge(q, q.fields.map((f) => f.accept[0])), `${q.type}: 正解で judge が真`);
    assert.ok(!judge(q, q.fields.map(() => 'ほげ')), '形式不備は不正解');
  }
  lint(q);
}
const notAccepted = (q, wrongs) => { const acc = q.fields[0].accept; for (const w of wrongs) if (String(w) !== acc[0]) assert.ok(!acc.includes(normalize(q.fields[0].format, String(w))), `${q.type}: ありがちな間違い ${w} が accept に入っている`); };
const rowById = (rows, id) => rows.find((r) => r.id === id);

// ---------- 別実装の解き直し(type ごと) ----------
const HAS = { tcp: (r) => r.attrs.tcp && !r.attrs.udp, udp: (r) => !r.attrs.tcp && r.attrs.udp, both: (r) => r.attrs.tcp && r.attrs.udp };
const RANGE_NAME = (n) => (n <= 1023 ? 'ウェルノウンポート' : n <= 49151 ? '登録済みポート' : '動的・プライベートポート(エフェメラル)');
const HS = { 1: ['SYN', 'client'], 2: ['SYN+ACK', 'server'], 3: ['ACK', 'client'] };
const parseAp = (s) => { const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(s); return { ip: m[1], port: Number(m[2]) }; };

function verify(q) {
  const m = q.meta;
  const ans = q.answerKind === 'choice' ? q.options[q.answerIndex] : q.fields[0].accept[0];
  switch (q.type) {
    case 'tcpudp': {
      const row = rowById(FACTS.tcpUdp, m.rowId);
      assert.strictEqual(ans, row.ja); assert.ok(HAS[m.kind](row), '正解行は問いの型を満たす');
      for (const o of q.options) if (o !== ans) { const r = FACTS.tcpUdp.find((x) => x.ja === o); assert.ok(r && !HAS[m.kind](r), `誤答 ${o} は問いの型を満たさない行`); }
      assert.ok(q.text.includes(m.kind === 'tcp' ? 'TCP にはあって' : m.kind === 'udp' ? 'UDP にはあって' : '両方'));
      break;
    }
    case 'portof': {
      const row = rowById(FACTS.ports, m.rowId);
      assert.strictEqual(ans, String(row.attrs.port));
      assert.ok(!/\d/.test(q.text), `本文に数字が漏れている: ${q.text}`);
      assert.ok(q.text.includes(row.attrs.transport.toUpperCase()) && q.text.includes(row.attrs.service));
      if (row.attrs.ask) assert.ok(q.text.includes(row.attrs.ask));
      break;
    }
    case 'serviceof': {
      const row = rowById(FACTS.ports, m.rowId);
      assert.strictEqual(ans, row.attrs.label); assert.ok(q.text.includes(String(row.attrs.port)));
      for (const o of q.options) if (o !== ans) { const r = FACTS.ports.find((x) => x.attrs.label === o); assert.ok(r && r.attrs.port !== row.attrs.port, `誤答 ${o} は別のポートの行`); }
      break;
    }
    case 'portrange': assert.strictEqual(ans, RANGE_NAME(m.n)); assert.ok(q.text.includes(String(m.n))); break;
    case 'handshake': {
      const [flags, sender] = HS[m.attrs.step];
      if (m.kind === 'flag') assert.strictEqual(ans, flags);
      else if (m.kind === 'sender') assert.strictEqual(ans, `${sender === 'client' ? 'クライアント' : 'サーバー'}が ${flags} を送る`);
      else assert.strictEqual(ans, `${m.attrs.step} 段目`);
      break;
    }
    case 'ephemeral': {
      const n = Number(ans); assert.ok(n >= 49152 && n <= 65535);
      for (const o of q.options) if (o !== ans) { const w = Number(o); assert.ok(w >= 1 && w < 1024, `誤答 ${o} は 1024 未満`); }
      break;
    }
    case 'hsseq': {
      const { a, b, ask } = m; assert.ok(a >= 1e6 && a <= 2e9 && b >= 1e6 && b <= 2e9 && Math.abs(a - b) >= 2);
      // 別実装: 段ごとに (seq, ack) を順に進める
      const syn = { seq: a }; const synack = { seq: b, ack: syn.seq + 1 }; const ack = { seq: synack.ack, ack: synack.seq + 1 };
      const want = { 'synack-seq': synack.seq, 'synack-ack': synack.ack, 'ack-seq': ack.seq, 'ack-ack': ack.ack }[ask];
      assert.strictEqual(ans, String(want));
      notAccepted(q, [a, b, a + 1, b + 1, a - 1, b - 1].filter((x) => x !== want)); // +1 忘れ・取り違え
      assert.ok(q.text.includes(a.toLocaleString('ja-JP')) && q.text.includes(b.toLocaleString('ja-JP')));
      break;
    }
    case 'dataack': {
      const { s, lens, ask, k } = m; assert.ok(lens.length >= 1 && lens.length <= 3 && lens.every((l) => l >= 1 && l <= 1460));
      let cum = s; for (let i = 0; i < k; i++) cum += lens[i];
      assert.ok(cum < 2 ** 32, '折り返しなし');
      if (ask === 'seq') assert.strictEqual(k, lens.length);
      assert.strictEqual(ans, String(cum));
      const total = lens.reduce((x, y) => x + y, 0);
      notAccepted(q, [cum - 1, cum + 1, s, s + total - (k < lens.length ? 0 : lens[lens.length - 1]), total, s + lens[k - 1]].filter((x) => x !== cum));
      break;
    }
    case 'fivetuple': {
      // 表から読み直す(meta は使わない): (プロトコル, {端点 A, 端点 B}) の集合の大きさ
      const pk = q.table.rows.map((r) => ({ proto: r[1], src: r[2], dst: r[3] }));
      assert.ok(pk.length >= 5 && pk.length <= 7);
      const keys = new Set(pk.map((p) => `${p.proto}|${[p.src, p.dst].sort().join('|')}`));
      assert.strictEqual(ans, String(keys.size));
      assert.ok(keys.size >= 3 && keys.size <= 5);
      const dup = pk.some((p, i) => pk.some((o, j) => j !== i && o.proto === p.proto && o.src === p.src && o.dst === p.dst));
      const rev = pk.some((p, i) => pk.some((o, j) => j !== i && o.proto === p.proto && o.src === p.dst && o.dst === p.src));
      const proto = pk.some((p, i) => pk.some((o, j) => j !== i && o.proto !== p.proto && o.src === p.src));
      const sameIp = pk.some((p, i) => pk.some((o, j) => j !== i && parseAp(o.src).ip === parseAp(p.src).ip && parseAp(o.src).port !== parseAp(p.src).port));
      assert.ok(dup && rev && proto && sameIp, '重複・復路・別プロトコル・同 IP 別ポートが含まれる');
      notAccepted(q, [pk.length, pk.length - 1, pk.length - 2, 1].filter((x) => x !== keys.size));
      break;
    }
    case 'naptadd': case 'naptcollide': {
      // 表から読み直す: 同じプロトコルの内側グローバルのポートを使用中として、新規ポートから 1 ずつ上げて最初の空き
      const rows = q.table.rows.map((r) => ({ proto: r[0], local: parseAp(r[1]), global: parseAp(r[2]) }));
      const f = m.flow; const used = new Set(rows.filter((r) => r.proto === f.proto).map((r) => r.global.port));
      let p = f.port; while (used.has(p)) p++;
      assert.strictEqual(ans, `${m.global}:${p}`);
      assert.ok(rows.every((r) => r.global.ip === m.global));
      assert.ok(f.port >= 49152 && f.port <= 65535 && p <= 65535);
      for (let x = f.port; x < p; x++) assert.ok(used.has(x), '途中はすべて使用中'); assert.ok(!used.has(p), '付け替え後は未使用');
      if (q.type === 'naptadd') assert.strictEqual(p, f.port, 'Lv58 は衝突しない');
      else { assert.ok(p > f.port, 'Lv59 は必ず衝突'); assert.strictEqual(m.chain, p - f.port); }
      notAccepted(q, [`${f.host}:${f.port}`, `${m.global}:${f.port}`, `${m.global}:${p + 1}`, `${m.global}:${p - 1}`, f.outside, `${f.host}:${p}`]);
      assert.ok(q.text.includes(`${f.host}:${f.port}`) && q.text.includes(f.outside) && q.text.includes('1 ずつ上げて最初の空き'));
      break;
    }
    case 'naptmulti': {
      // 表 2 つから読み直し、順に適用する逐次シミュレーション
      const rows = q.tables[0].rows.map((r) => ({ proto: r[0], global: parseAp(r[2]) }));
      const flows = q.tables[1].rows.map((r) => ({ proto: r[1], local: parseAp(r[2]) }));
      assert.ok(flows.length >= 2 && flows.length <= 3);
      const used = { TCP: new Set(), UDP: new Set() }; for (const r of rows) used[r.proto].add(r.global.port);
      const got = [];
      let crossProto = false, chain = false;
      for (const f of flows) {
        const other = f.proto === 'TCP' ? 'UDP' : 'TCP';
        if (used[other].has(f.local.port)) crossProto = true;
        if (got.some((g, i) => flows[i].proto === f.proto && g === f.local.port)) chain = true;
        let p = f.local.port; while (used[f.proto].has(p)) p++;
        used[f.proto].add(p); got.push(p);
      }
      assert.deepStrictEqual(got, m.assigned, '全行一致');
      assert.strictEqual(ans, `${m.global}:${got[got.length - 1]}`);
      assert.ok(crossProto, '別プロトコル同番号(衝突しない)のケースが含まれる');
      assert.ok(chain, '前の新規行と衝突するケースが含まれる');
      const last = flows[flows.length - 1];
      notAccepted(q, [`${last.local.ip}:${last.local.port}`, `${m.global}:${got[got.length - 1] + 1}`, ...(got[got.length - 1] !== last.local.port ? [`${m.global}:${last.local.port}`] : [])]);
      assert.ok(q.text.includes('TCP と UDP のポートは別々'));
      break;
    }
    default: assert.fail('未知の type ' + q.type);
  }
}

// ---------- 1 万件(seed = i)。各レベル 1,000 件 ----------
assert.ok(!fs.readFileSync(path.join(__dirname, '../server/questions/transport.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).some((l) => l.includes('Math.random')), 'Math.random を使わない(コメント以外)');
let n = 0;
const seenTypes = new Set(), seenTemplates = new Set();
const marks = { portrangeBoundary: new Set(), hsAsk: new Set(), dataN: new Set(), dataAsk: new Set(), ftConn: new Set(), addTrap: 0, collideChain: new Set(), multiVariant: new Set(), hsKind: new Set(), tcpudpKind: new Set() };
for (let i = 0; i < 10000; i++) {
  const level = RANGE[0] + (i % 10);
  const node = NODES[i % NODES.length];
  const q = make(level, node, makeRng(i));
  assert.strictEqual(q.seed, makeRng(i).seed);
  assert.deepStrictEqual(make(level, node, makeRng(i)), q, '同じ seed で同じ問題');
  checkShape(q, level);
  verify(q);
  seenTypes.add(q.type); seenTemplates.add(q.templateId);
  if (q.type === 'portrange' && [1023, 1024, 49151, 49152].includes(q.meta.n)) marks.portrangeBoundary.add(q.meta.n);
  if (q.type === 'hsseq') marks.hsAsk.add(q.meta.ask);
  if (q.type === 'dataack') { marks.dataN.add(q.meta.lens.length); marks.dataAsk.add(q.meta.ask); }
  if (q.type === 'fivetuple') marks.ftConn.add(q.meta.nConn);
  if (q.type === 'naptadd' && q.meta.trap === 'local-only') marks.addTrap++;
  if (q.type === 'naptcollide') marks.collideChain.add(q.meta.chain);
  if (q.type === 'naptmulti') marks.multiVariant.add(q.meta.variant);
  if (q.type === 'handshake') marks.hsKind.add(q.meta.kind);
  if (q.type === 'tcpudp') marks.tcpudpKind.add(q.meta.kind);
  n++;
}
assert.deepStrictEqual([...seenTypes].sort(), ['dataack', 'ephemeral', 'fivetuple', 'handshake', 'hsseq', 'naptadd', 'naptcollide', 'naptmulti', 'portof', 'portrange', 'serviceof', 'tcpudp'], '全種類が出る');
assert.strictEqual(seenTemplates.size, 12);
for (let lv = RANGE[0]; lv <= RANGE[1]; lv++) assert.ok(BY_LEVEL[lv] && BY_LEVEL[lv].length >= 1, `Lv${lv} に生成器がある`);
assert.strictEqual(marks.portrangeBoundary.size, 4, '区分の境界値 4 つが出る');
assert.strictEqual(marks.hsAsk.size, 4); assert.deepStrictEqual([...marks.dataN].sort(), [1, 2, 3]); assert.strictEqual(marks.dataAsk.size, 2);
assert.deepStrictEqual([...marks.ftConn].sort(), [3, 4, 5]);
assert.ok(marks.addTrap >= 50, 'Lv58 の「ローカル列にだけある番号」が出る');
assert.ok(marks.collideChain.has(1) && marks.collideChain.has(2), 'Lv59 の連続使用(p, p+1 → p+2)が出る');
assert.deepStrictEqual([...marks.multiVariant].sort(), ['chain-last', 'two', 'udp-last']);
assert.strictEqual(marks.hsKind.size, 3); assert.strictEqual(marks.tcpudpKind.size, 3);

// ---------- FactBank: 全行 × 問いの型を全数 ----------
for (const [name, rows] of Object.entries(FACTS)) for (const r of rows) assert.ok(r.id && r.ja && r.attrs && r.levelHint && r.checkedBy, `${name}: 行 ${r.id} の項目`);
let facts = 0;
const rng0 = () => makeRng(12345);
for (const row of FACTS.tcpUdp) for (const kind of Object.keys(HAS)) { if (!HAS[kind](row)) continue; const q = I.tcpUdpFact(I.DEFAULT_NODE, rng0(), { row, kind }); q.level = 51; q.seed = 0; q.generatorVersion = VERSION; checkShape(q, 51); verify(q); facts++; }
assert.strictEqual(FACTS.tcpUdp.length, 12);
for (const row of FACTS.ports) {
  let q = I.portOfService(I.DEFAULT_NODE, rng0(), { row }); q.level = 52; q.seed = 0; q.generatorVersion = VERSION; checkShape(q, 52); verify(q); facts++;
  q = I.serviceOfPort(I.DEFAULT_NODE, rng0(), { row }); q.level = 53; q.seed = 0; q.generatorVersion = VERSION; checkShape(q, 53); verify(q); facts++;
}
assert.strictEqual(FACTS.ports.length, 10);
assert.strictEqual(new Set(FACTS.ports.map((r) => r.attrs.label)).size, 10, '選択肢の名前が重複しない');
for (const row of FACTS.handshake) for (const kind of ['flag', 'sender', 'step']) { const q = I.handshakeFact(I.DEFAULT_NODE, rng0(), { row, kind }); q.level = 54; q.seed = 0; q.generatorVersion = VERSION; checkShape(q, 54); verify(q); facts++; }
assert.strictEqual(FACTS.handshake.length, 3);
for (const nn of [0, 1023, 1024, 49151, 49152, 65535]) { const q = I.portRange(I.DEFAULT_NODE, rng0(), { n: nn }); q.level = 53; q.seed = 0; q.generatorVersion = VERSION; checkShape(q, 53); verify(q); }

// ---------- 設計書 2.2 の例題と同じ値で作れる ----------
{
  const q = I.handshakeSeq(I.DEFAULT_NODE, rng0(), { a: 2000000, b: 5000000, ask: 'synack-ack' });
  assert.deepStrictEqual(q.fields[0].accept, ['2000001']); assert.ok(q.text.includes('2,000,000') && q.text.includes('5,000,000'));
}
{
  const q = I.dataAck(I.DEFAULT_NODE, rng0(), { s: 20001, lens: [1460, 1460, 300], ask: 'ack', k: 3 });
  assert.deepStrictEqual(q.fields[0].accept, ['23221']);
}
{
  const global = '203.0.113.10';
  const rows = [
    { proto: 'TCP', host: '10.0.5.11', lport: 51000, gport: 51000, outside: '198.51.100.7:443' },
    { proto: 'TCP', host: '10.0.5.12', lport: 51001, gport: 51001, outside: '198.51.100.7:80' },
    { proto: 'TCP', host: '10.0.5.14', lport: 40022, gport: 40022, outside: '198.51.100.9:53' },
  ];
  const q = I.naptCollide(I.DEFAULT_NODE, rng0(), { global, rows, spare: ['10.0.5.23'], flow: { proto: 'TCP', host: '10.0.5.23', port: 51000, outside: '198.51.100.80:443' } });
  assert.deepStrictEqual(q.fields[0].accept, ['203.0.113.10:51002']);
  assert.ok(judge(q, ['２０３.0.113.10：51002']) && !judge(q, ['203.0.113.10:51000']) && !judge(q, ['10.0.5.23:51000']));
  q.level = 59; q.seed = 0; q.generatorVersion = VERSION; q.meta.chain = 2; checkShape(q, 59);
}
assert.strictEqual(I.firstFree(new Set([5, 6, 8]), 5), 7);

console.log('transport ok:', n, 'questions,', seenTypes.size, 'types,', facts, 'fact rows x kinds');
