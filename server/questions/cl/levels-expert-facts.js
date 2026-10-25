'use strict';
// 専門(新しい番号 320〜361)のうち、担当 O で仕組みの要らない「表」の 8 項目: 332 SDN・333 重ねる網・336 状態を見ない規則・339 CDN・341 自動化の性質・346 変更の手順・347 構成図・350 障害の初動。
// 作成: Claude Fable 5.1(2026-10-25)。書き方は docs/questions/CL.md。表(FactBank)は server/questions/data/cl/expert/<番号>-*.json、テストは test/cl-expert-facts.js
// 専門はヒントなし(解説 explanation だけ)。共通の道具は levels-fable-route.js と同じ考え方で、ここにコピーして持つ(ほかの levels-*.js から require しない)
//
// 要点:
//   表のレベルは、文(attrs.true / why)から「正しい/誤っているものはどれか」と ○×、用語(attrs.group / desc)から「説明 → 名前」「名前 → 説明」を作る。verify は表の行から正解が 1 つだけかを数え直す
//   336 だけ、表の文に加えて「規則表を読む」型を作る(ゲーム内の PC クラウドの規則: 状態を見ない規則(ネットワーク ACL)は番号順に照らし最初に合った行で決まる。行きを許しても返りは自動では通らない。返りの宛先ポートは送信側の一時ポート 1024〜65535)。
//   規則表の型は、返りのパケットを表の文字から独立に照らし直して確かめる
const { loadFacts } = require('./build');

// ================= 共通の道具 =================
const F = (file) => loadFacts(`expert/${file}`);
const stmtRows = (rows) => rows.filter((r) => typeof r.attrs.true === 'boolean');
const groupRows = (rows, group) => rows.filter((r) => r.attrs.group === group);
const wa = (name) => (/[A-Za-z0-9)]$/.test(name) ? `${name} は、` : `${name}は、`);

// 文の 4 択: 正しいもの(または誤っているもの)を 1 つ選ぶ。正解 1 つ + 反対の文 3 つ
function stmtQ(rng, rows, subject) {
  const wantTrue = rng.next() < 0.5;
  const right = rows.filter((r) => r.attrs.true === wantTrue);
  const wrong = rows.filter((r) => r.attrs.true !== wantTrue);
  if (!right.length || wrong.length < 3) throw new Error(`${subject}: 文が足りません`);
  const ans = rng.pick(right);
  const others = rng.shuffle(wrong).slice(0, 3);
  const picked = rng.shuffle([ans, ...others]);
  const explanation = [`正解は「${ans.ja}」(${wantTrue ? '正しい文' : '誤っている文'})。${ans.attrs.why}`,
    ...others.map((r) => `「${r.ja}」は${r.attrs.true ? '正しい' : '誤り'}。${r.attrs.why}`)].join('\n');
  return { text: `${subject}について、${wantTrue ? '正しい' : '誤っている'}ものはどれか。`, options: picked.map((r) => r.ja), answerIndex: picked.indexOf(ans), explanation, meta: { type: 'stmt', wantTrue, ids: picked.map((r) => r.id) } };
}
// ○×: 文が正しいか
function tfQ(rng, rows) {
  const r = rng.pick(rows);
  return { text: `次の文は正しいか。\n「${r.ja}」`, options: ['○', '×'], answerIndex: r.attrs.true ? 0 : 1, explanation: `${r.attrs.true ? '正しい(○)' : '誤り(×)'}。${r.attrs.why}`, meta: { type: 'tf', id: r.id } };
}
// 説明 → 名前(reverse なら 名前 → 説明)。同じ group の行から選ぶ
function termQ(rng, rows, group, { only = null, reverse = false } = {}) {
  const pool = groupRows(rows, group);
  const ans = rng.pick(only ? pool.filter((r) => only.includes(r.id)) : pool);
  const others = rng.shuffle(pool.filter((r) => r !== ans)).slice(0, 3);
  if (others.length < 2) throw new Error(`${group}: 用語が足りません`);
  const picked = rng.shuffle([ans, ...others]);
  const explanation = [`正解は「${reverse ? ans.attrs.desc : ans.ja}」。${wa(ans.ja)}${ans.attrs.desc}。`, ...others.map((r) => `${wa(r.ja)}${r.attrs.desc}。`)].join('\n');
  return reverse
    ? { text: `「${ans.ja}」の説明として正しいものはどれか。`, options: picked.map((r) => r.attrs.desc), answerIndex: picked.indexOf(ans), explanation, meta: { type: 'termRev', group, ids: picked.map((r) => r.id), ans: ans.id } }
    : { text: `次の説明に当たるものはどれか。\n「${ans.attrs.desc}」`, options: picked.map((r) => r.ja), answerIndex: picked.indexOf(ans), explanation, meta: { type: 'term', group, ids: picked.map((r) => r.id), ans: ans.id } };
}
// 表のレベルの確かめ(表の行から正解が 1 つだけかを数え直す)
function verifyFacts(q, rows) {
  const m = q.meta || {};
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (m.type === 'stmt') {
    const hits = q.options.map((o) => { const r = rows.find((x) => x.ja === o); if (!r) throw new Error(`表に無い文: ${o}`); return r.attrs.true === m.wantTrue; });
    if (hits.filter(Boolean).length !== 1 || !hits[q.answerIndex]) throw new Error(`正解が 1 つに決まらない: ${q.text}`);
  } else if (m.type === 'tf') {
    const r = byId.get(m.id); if ((r.attrs.true ? 0 : 1) !== q.answerIndex) throw new Error('○× の答えが表と合わない');
  } else if (m.type === 'term' || m.type === 'termRev') {
    const pool = groupRows(rows, m.group);
    const want = byId.get(m.ans);
    const hits = q.options.map((o) => (m.type === 'term' ? pool.filter((r) => r.ja === o) : pool.filter((r) => r.attrs.desc === o)));
    if (hits.some((h) => h.length !== 1)) throw new Error('選択肢が表の 1 行に決まらない');
    if (hits.filter((h) => h[0] === want).length !== 1 || hits[q.answerIndex][0] !== want) throw new Error('正解の位置が違う');
    if (m.type === 'term' && !q.text.includes(want.attrs.desc)) throw new Error('説明が正解の行のものでない');
  }
}
// 表のレベルを作る: types は (rng) → 問題 の配列。extraVerify は表の文以外の型の確かめ
function tableLevel(title, rows, kindName, types, extraVerify = null) {
  return {
    title, kind: '表', minDistinct: 20,
    make(rng) { const q = rng.pick(types)(rng); return { ...q, kind: kindName }; },
    verify(q) { verifyFacts(q, rows); if (extraVerify) extraVerify(q); },
  };
}
// 文 + 用語のふつうの組み合わせ(文の 4 択を 2 回入れて文を多めに出す)
const usual = (rows, subject, group) => [(r) => stmtQ(r, stmtRows(rows), subject), (r) => stmtQ(r, stmtRows(rows), subject), (r) => tfQ(r, stmtRows(rows)), (r) => termQ(r, rows, group), (r) => termQ(r, rows, group, { reverse: true })];

// ================= 表 =================
const SDN = F('332-sdn.json');
const OVER = F('333-overlay.json');
const STATELESS = F('336-stateless.json');
const CDN = F('339-cdn.json');
const AUTO = F('341-automation.json');
const CHANGE = F('346-change.json');
const DIAGRAM = F('347-diagram.json');
const INCIDENT = F('350-incident.json');

// ================= Lv336 規則表を読む(状態を見ない規則の返り) =================
// 規則の行: { act: '許可'|'拒否', proto: 'TCP'|'UDP'|'すべて', src: 'any'|cidr, ports: 'すべて'|'n'|'a〜b' }
const bin32 = (s) => s.split('.').map((x) => Number(x).toString(2).padStart(8, '0')).join('');
const binIn = (ip, c) => { if (c === 'any') return true; const [a, l] = c.split('/'); return bin32(ip).slice(0, Number(l)) === bin32(a).slice(0, Number(l)); };
const portIn = (p, spec) => { if (spec === 'すべて') return true; const m = /^(\d+)〜(\d+)$/.exec(spec); if (m) return p >= Number(m[1]) && p <= Number(m[2]); return p === Number(spec); };
const ruleHit = (r, pkt) => (r.proto === 'すべて' || r.proto === pkt.proto) && binIn(pkt.src, r.src) && portIn(pkt.dport, r.ports);
const ruleText = (r) => `${r.act} ${r.proto} 送信元 ${r.src} 宛先ポート ${r.ports}`;
const parseRuleText = (s) => { const m = /^(許可|拒否) (TCP|UDP|すべて) 送信元 (\S+) 宛先ポート (\S+)$/.exec(s); if (!m) throw new Error(`規則が読めない: ${s}`); return { act: m[1], proto: m[2], src: m[3], ports: m[4] }; };
const RULE_INTRO = 'ゲーム内の PC クラウドのネットワーク ACL(状態を見ない規則)は、サブネットに入る向きのパケットを番号の順に照らし、最初に合った行で通す・捨てるが決まる(合う行が無ければ最後の * で捨てる)。行きを許しても返りは自動では通らない。PC が外のサーバーへつなぐとき、PC 側のポートは一時ポート(1024〜65535)なので、返りの宛先ポートはそこになる。';
function ruleSetup(rng) {
  const X = rng.rand(1, 250), Y = rng.rand(0, 255);
  const pcNet = `10.${X}.${Y}.0/24`; const pc = `10.${X}.${Y}.${rng.rand(2, 254)}`;
  const extBase = rng.pick(['198.51.100', '203.0.113']); const otherBase = extBase === '198.51.100' ? '203.0.113' : '198.51.100';
  const ext = `${extBase}.${rng.rand(2, 250)}`; const extNet = `${extBase}.0/24`; const otherNet = `${otherBase}.0/24`;
  const P = rng.pick([443, 80, 22, 25]); const E = rng.rand(49152, 65535);
  const pkt = { proto: 'TCP', src: ext, dport: E };
  return { pcNet, pc, ext, extNet, otherNet, P, E, pkt };
}
// 返りは通るか(○×)。許可の行の有無・送信元の網違い・上の拒否の行で、通る/通らないを作り分ける
function rulePassQ(rng) {
  const s = ruleSetup(rng);
  const shape = rng.pick(['allow', 'allow', 'none', 'wrong-net', 'wrong-port', 'deny-first']);
  const rules = [];
  rules.push({ act: '許可', proto: 'TCP', src: 'any', ports: String(s.P) }); // 外から始める通信の行(返りには合わない)
  if (shape === 'deny-first') rules.push({ act: '拒否', proto: 'TCP', src: `${s.ext}/32`, ports: '1024〜65535' });
  if (shape === 'allow' || shape === 'deny-first') rules.push({ act: '許可', proto: 'TCP', src: rng.next() < 0.5 ? s.extNet : 'any', ports: '1024〜65535' });
  if (shape === 'wrong-net') rules.push({ act: '許可', proto: 'TCP', src: s.otherNet, ports: '1024〜65535' });
  if (shape === 'wrong-port') rules.push({ act: '許可', proto: 'TCP', src: s.extNet, ports: String(s.P) === '443' ? '80' : '443' });
  if (rng.next() < 0.5) rules.push({ act: '許可', proto: 'UDP', src: 'any', ports: '53' });
  const hitIdx = rules.findIndex((r) => ruleHit(r, s.pkt));
  const pass = hitIdx >= 0 && rules[hitIdx].act === '許可';
  const table = { headers: ['番号', '動作', '手順', '送信元', '宛先ポート'], rows: rules.map((r, i) => [String((i + 1) * 100), r.act, r.proto, r.src, r.ports]).concat([['*', '拒否', 'すべて', 'any', 'すべて']]) };
  const steps = rules.map((r, i) => `${(i + 1) * 100}: ${ruleHit(r, s.pkt) ? `合う → ${r.act}` : (r.proto !== 'TCP' && r.proto !== 'すべて' ? '手順が違う' : !binIn(s.pkt.src, r.src) ? `送信元 ${r.src} に ${s.ext} が入らない` : `宛先ポート ${r.ports} に ${s.E} が入らない`)}`);
  const upto = hitIdx >= 0 ? steps.slice(0, hitIdx + 1) : steps.concat(['*: 合う行が無いので捨てる']);
  return {
    text: `${RULE_INTRO}\nサブネット ${s.pcNet} に入る向きの規則は表のとおり。PC1(${s.pc})が外のサーバー ${s.ext} のポート ${s.P} へ TCP でつなぎ、PC1 側のポートは ${s.E} だった。サーバーからの返り(TCP ${s.ext}:${s.P} → ${s.pc}:${s.E})は、この規則を通るか。`,
    table, options: ['○', '×'], answerIndex: pass ? 0 : 1,
    explanation: `${pass ? '通る(○)' : '通らない(×)'}。返りのパケットは手順 TCP・送信元 ${s.ext}・宛先ポート ${s.E}(一時ポート)。上から照らすと:\n${upto.join('\n')}` + (pass ? '' : `\n返りを通すには、送信元 ${s.extNet}(か any)・宛先ポート 1024〜65535 を許可する行を、拒否の行より上に足す。`),
    meta: { type: 'rulePass', shape, pass },
  };
}
// 通すために足す行はどれか(4 択)。許可の行が無い表に、最後の拒否の前に 1 行足す
function ruleAddQ(rng) {
  const s = ruleSetup(rng);
  const rules = [{ act: '許可', proto: 'TCP', src: 'any', ports: String(s.P) }];
  if (rng.next() < 0.5) rules.push({ act: '許可', proto: 'UDP', src: 'any', ports: '53' });
  if (rng.next() < 0.4) rules.push({ act: '許可', proto: 'TCP', src: s.otherNet, ports: '1024〜65535' }); // 別の網あての行(わな)
  const correct = { act: '許可', proto: 'TCP', src: rng.next() < 0.5 ? s.extNet : 'any', ports: '1024〜65535' };
  const wrongs = rng.shuffle([
    { act: '許可', proto: 'TCP', src: s.extNet, ports: String(s.P) },
    { act: '許可', proto: 'UDP', src: s.extNet, ports: '1024〜65535' },
    { act: '許可', proto: 'TCP', src: s.pcNet, ports: '1024〜65535' },
    { act: '許可', proto: 'TCP', src: 'any', ports: '1〜1023' },
  ]).slice(0, 3);
  const options = rng.shuffle([correct, ...wrongs].map(ruleText));
  const table = { headers: ['番号', '動作', '手順', '送信元', '宛先ポート'], rows: rules.map((r, i) => [String((i + 1) * 100), r.act, r.proto, r.src, r.ports]).concat([['*', '拒否', 'すべて', 'any', 'すべて']]) };
  const why = (r) => (r.ports === String(s.P) ? `宛先ポート ${s.P} は、外から ${s.P} へ始める通信の行。返りの宛先は一時ポート ${s.E} なので合わない` : r.proto === 'UDP' ? '手順が UDP で、TCP の返りには合わない' : r.src === s.pcNet ? `送信元が PC の網 ${s.pcNet} で、サーバー ${s.ext} からの返りには合わない` : '宛先ポート 1〜1023 に一時ポートは入らない');
  return {
    text: `${RULE_INTRO}\nサブネット ${s.pcNet} に入る向きの規則は表のとおりで、PC1(${s.pc})から外のサーバー ${s.ext} のポート ${s.P} への TCP の返り(PC1 側のポートは ${s.E})が捨てられている。最後の * の行の前に 1 行足して返りを通すなら、どの行か。`,
    table, options, answerIndex: options.indexOf(ruleText(correct)),
    explanation: `正解は「${ruleText(correct)}」。返りは手順 TCP・送信元 ${s.ext}・宛先ポート ${s.E}(一時ポート)なので、送信元 ${correct.src}・宛先ポート 1024〜65535 の許可の行に合う。\n` + wrongs.map((r) => `「${ruleText(r)}」は、${why(r)}。`).join('\n'),
    meta: { type: 'ruleAdd', trap: rules.some((r) => r.src === s.otherNet) },
  };
}
// 確かめ用: 表の文字と問題文のパケットから、独立に照らし直す
function verifyRule(q) {
  const m = q.meta || {};
  if (m.type !== 'rulePass' && m.type !== 'ruleAdd') return;
  const pk = /TCP ([\d.]+):(\d+) → ([\d.]+):(\d+)/.exec(q.text) || (() => { const a = /外のサーバー ([\d.]+) のポート (\d+) への TCP の返り\(PC1 側のポートは (\d+)\)/.exec(q.text); return a && [null, a[1], a[2], null, a[3]]; })();
  if (!pk) throw new Error('Lv336: 問題文のパケットが読めない');
  const pkt = { proto: 'TCP', src: pk[1], dport: Number(pk[4]) };
  const rows = q.table.rows.filter((r) => r[0] !== '*').map((r) => ({ act: r[1], proto: r[2], src: r[3], ports: r[4] }));
  const evalRules = (rs) => { const h = rs.find((r) => ruleHit(r, pkt)); return !!h && h.act === '許可'; };
  if (m.type === 'rulePass') { if (q.answerIndex !== (evalRules(rows) ? 0 : 1)) throw new Error('Lv336: 返りの判定が違う'); return; }
  if (evalRules(rows)) throw new Error('Lv336: 足す前から通っている');
  const ok = q.options.map((o) => evalRules(rows.concat([parseRuleText(o)])));
  if (ok.filter(Boolean).length !== 1 || !ok[q.answerIndex]) throw new Error('Lv336: 足す行が 1 つに決まらない');
}

// ================= レベルの一覧 =================
const LEVELS = {
  332: tableLevel('SDN', SDN, 'cl332-sdn-v1', usual(SDN, 'SDN(制御と転送を分ける網)', 'sdn')),
  333: tableLevel('重ねる網', OVER, 'cl333-overlay-v1', usual(OVER, 'オーバーレイの網(VXLAN・GRE)', 'ov')),
  336: tableLevel('状態を見ない規則', STATELESS, 'cl336-stateless-rule-v1', [(r) => stmtQ(r, stmtRows(STATELESS), '状態を見る規則と見ない規則'), (r) => tfQ(r, stmtRows(STATELESS)), (r) => termQ(r, STATELESS, 'rule'), rulePassQ, rulePassQ, ruleAddQ, ruleAddQ], verifyRule),
  339: tableLevel('CDN', CDN, 'cl339-cdn-v1', usual(CDN, 'CDN(内容を近くの写しから返す仕組み)', 'cdn')),
  341: tableLevel('自動化の性質', AUTO, 'cl341-automation-v1', usual(AUTO, '設定の自動化', 'auto')),
  346: tableLevel('変更の手順', CHANGE, 'cl346-change-procedure-v1', usual(CHANGE, 'ネットワークの変更の手順', 'chg')),
  347: tableLevel('構成図', DIAGRAM, 'cl347-diagram-v1', usual(DIAGRAM, '構成図(物理と論理)', 'dia')),
  350: tableLevel('障害の初動', INCIDENT, 'cl350-incident-v1', usual(INCIDENT, '障害の初動', 'inc')),
};

module.exports = { LEVELS, _test: { ruleHit, parseRuleText, portIn, binIn, BANKS: { 332: SDN, 333: OVER, 336: STATELESS, 339: CDN, 341: AUTO, 346: CHANGE, 347: DIAGRAM, 350: INCIDENT } } };
