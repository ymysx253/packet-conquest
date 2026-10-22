'use strict';
// 中級(新しい番号 159〜252。server/questions/cl/levels-mid.js)ならではの確かめ(2026-10-22)。test/cl.js が読む。
//   表: 行の形・出典・確認者、正解が 2 つにならないこと、違う問題(選択肢の並びを除く)が 20 通り以上、全行が出ること
//   生: 境界の値・同点の決め方・紛らわしい誤答が正解にならないこと・ありがちな間違いが accept に入らないこと
//   全部: 使えるアドレスの範囲・.example 以外のドメイン・禁止語(docs/questions/COMMON.md 第 7 章)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LEVELS: ALL, getClQuestion } = require('../server/questions/cl');
const { LEVELS, internals: I } = require('../server/questions/cl/levels-mid');
const { judge, normalize } = require('../server/questions/normalize');

const MID = Object.keys(LEVELS).map(Number);
for (const lv of MID) { assert.ok(lv >= 159 && lv <= 252, `Lv${lv} は中級の範囲外`); assert.strictEqual(ALL.get(lv).file, './levels-mid', `Lv${lv} が levels-mid から読まれていない`); }
const qs = (lv, n, from = 1) => Array.from({ length: n }, (_, i) => getClQuestion({ level: lv, seed: from + i }));
const N = 3000;

// ---------- 表のファイル ----------
const DIR = path.join(__dirname, '..', 'server', 'questions', 'data', 'cl', 'mid');
let rowCount = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  assert.ok(d.note && Array.isArray(d.rows) && d.rows.length, `${f}: note と rows が要る`);
  const ids = new Set(); const jas = new Set();
  for (const r of d.rows) {
    const w = `${f} ${r.id}`;
    assert.ok(r.id && !ids.has(r.id), `${w}: id が無いか重複`); ids.add(r.id);
    assert.ok(typeof r.ja === 'string' && r.ja.trim(), `${w}: ja が無い`);
    assert.ok(!jas.has(r.ja), `${w}: 同じ文の行が 2 つある`); jas.add(r.ja);
    assert.ok(typeof r.source === 'string' && r.source.trim(), `${w}: source(根拠)が無い`);
    assert.strictEqual(r.checkedBy, 'Claude Opus 5.5 2026-10-22', `${w}: checkedBy`);
    const a = r.attrs; assert.ok(a && ['d', 't', 'q', 'v'].includes(a.type), `${w}: 型`);
    if (a.type !== 'v') assert.ok(typeof a.why === 'string' && a.why.trim(), `${w}: why(解説)が無い`);
    if (a.type === 't') assert.strictEqual(typeof a.true, 'boolean', `${w}: ○× の true`);
    if (a.type === 'd') assert.ok(typeof a.term === 'string' && a.term, `${w}: term`);
    if (a.type === 'q') {
      assert.ok(Array.isArray(a.wrong) && a.wrong.length >= 2 && new Set(a.wrong).size === a.wrong.length, `${w}: 誤答が 2 つ以上・重複なし`);
      assert.ok(!a.wrong.includes(a.answer), `${w}: 誤答に正解が入っている`);
    }
    rowCount++;
  }
  const terms = new Set(d.rows.filter((r) => r.attrs.type === 'd').map((r) => r.attrs.term).concat(d.distractors || []));
  if (d.rows.some((r) => r.attrs.type === 'd')) assert.ok(terms.size >= 4, `${f}: 4 択の名前が 4 つ以上要る`);
  // ○× は正しい文と誤りの文の両方を置く(どちらかに偏ると答えを覚えられる)
  const tf = d.rows.filter((r) => r.attrs.type === 't');
  if (tf.length >= 6) assert.ok(tf.some((r) => r.attrs.true) && tf.some((r) => !r.attrs.true), `${f}: ○× が片方だけ`);
}

// ---------- 安全の簡易リンタ ----------
const ALLOW_DOTTED = new Set(['0.0.0.0', '255.255.255.255']);
for (let p = 0; p <= 32; p++) ALLOW_DOTTED.add([24, 16, 8, 0].map((s) => ((~(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0) >>> 0) >>> s) & 255).join('.')); // ワイルドカード
const BANNED = ['Cisco', 'Juniper', 'Windows', 'Linux', 'nmap', 'Wireshark', 'tcpdump', 'netcat', 'metasploit', 'Google', 'Amazon', 'Microsoft', 'AWS', 'Azure', 'Docker', 'VMware', 'Kubernetes'];
function strings(q) {
  const out = [q.text, q.explanation, q.firstStep].concat(q.options || []);
  for (const t of [q.table].concat(q.tables || []).filter(Boolean)) { out.push(...t.headers, t.title || ''); for (const r of t.rows) out.push(...r); }
  if (q.fields) for (const f of q.fields) out.push(f.label, f.hint || '');
  return out.map(String);
}
function lint(q, where) {
  for (const s of strings(q)) {
    for (const m of s.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || []) assert.ok(ALLOW_DOTTED.has(m) || I.allowed(m.split('.').reduce((a, x) => a * 256 + Number(x), 0)), `${where}: 範囲外のアドレス ${m}`);
    for (const m of s.match(/(?<![:0-9a-f])[0-9a-f]{2}(:[0-9a-f]{2}){5}(?![:0-9a-f])/gi) || []) assert.ok(/^[0-9a-f][26ae]:/i.test(m) || /^00:00:5e:00:53:/i.test(m), `${where}: 安全でない MAC ${m}`);
    for (const m of s.match(/\b2001:[0-9a-f:]+/gi) || []) assert.ok(/^2001:db8:/i.test(m), `${where}: 文書用でない IPv6 ${m}`);
    for (const m of s.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|jp|io|co|info|biz)\b/gi) || []) assert.fail(`${where}: .example 以外のドメイン ${m}`);
    for (const w of BANNED) assert.ok(!s.includes(w), `${where}: 禁止語 ${w}`);
  }
}

// ---------- 全レベル: リンタと、ヒントは firstStep だけ ----------
for (const lv of MID) {
  for (const q of qs(lv, LEVELS[lv].kind === '生' ? 1500 : 400)) {
    const where = `Lv${lv} seed ${q.seed}`;
    lint(q, where);
    assert.ok(typeof q.firstStep === 'string' && q.firstStep.startsWith('まず'), `${where}: firstStep は「まず …」の 1 手`);
    assert.ok(q.hint === undefined && q.card === undefined, `${where}: 中級は hint・card を出さない`);
  }
}

// ---------- 表のレベル: 違う問題(選択肢の並びを除く)20 通り以上、全行が出る ----------
const TABLE = MID.filter((lv) => LEVELS[lv].kind === '表');
for (const lv of TABLE) {
  const seen = new Set(); const rows = new Set(); let file = null;
  for (const q of qs(lv, N)) {
    seen.add(JSON.stringify([q.text, q.options ? q.options.slice().sort() : q.fields.map((f) => f.accept[0])]));
    if (q.meta && q.meta.rowId) { rows.add(q.meta.rowId); file = q.meta.file; }
  }
  assert.ok(seen.size >= 20, `Lv${lv}: 選択肢の並びを除くと ${seen.size} 通りしかない`);
  const bk = Object.values(I.B).find((b) => b.file === file);
  if (bk) { const want = I.askRows(bk).map((r) => r.id); for (const id of want) assert.ok(rows.has(id), `Lv${lv}: 行 ${id} が ${N} 問で 1 度も出ない`); }
}

// ---------- 生のレベル ----------
const count = (arr, f) => arr.filter(f).length;
const ans = (q) => (q.fields ? q.fields[0].accept[0] : q.options[q.answerIndex]);

{ // 166: ○ も × も出る。「並んでいるが区切りをまたぐ」組は必ず ×
  const a = qs(166, N);
  assert.ok(count(a, (q) => q.answerIndex === 0) > N * 0.25 && count(a, (q) => q.answerIndex === 1) > N * 0.4, 'Lv166: ○× の偏り');
  for (const q of a.filter((x) => x.meta.variant === 'odd')) assert.strictEqual(q.answerIndex, 1, 'Lv166: 区切りをまたぐ組が ○ になった');
  assert.ok(count(a, (q) => q.meta.variant === 'odd') > N * 0.2, 'Lv166: 区切りをまたぐ組が少ない');
}
{ // 180: U/L ビットの反転を忘れた答えは accept に入らない。0→1(文書用 00:)と 1→0(ローカル管理)の両方が出る
  const a = qs(180, N);
  for (const q of a) {
    const o = q.meta.mac.split(':');
    const noflip = q.meta.prefix.concat([`${o[0]}${o[1]}`, `${o[2]}ff`, `fe${o[3]}`, `${o[4]}${o[5]}`]).join(':');
    assert.ok(!q.fields[0].accept.includes(normalize('ipv6', noflip)), 'Lv180: 反転忘れが正解になる');
    const full = normalize('ipv6', q.fields[0].accept[0]); assert.ok(judge(q, [full.toUpperCase()]), 'Lv180: 大文字でも正解');
  }
  assert.ok(a.some((q) => q.meta.mac.startsWith('00:00:5e')) && a.some((q) => /^.[26ae]/.test(q.meta.mac)), 'Lv180: 0→1 と 1→0 の両方');
}
{ // 183: 宛先が表にある/無い/表が空の 3 つが出る。宛先が無いとき「宛先のポートだけ」は誤答に並ぶが正解ではない
  const a = qs(183, N);
  const known = a.filter((q) => q.meta.table.some((r) => r[0] === q.meta.pcs[q.meta.d].mac));
  assert.ok(known.length > N * 0.2 && known.length < N * 0.5, 'Lv183: 宛先が表にある問題の割合');
  assert.ok(a.some((q) => !q.tables[1]), 'Lv183: 表が空の問題が出ない');
  for (const q of a.filter((x) => !known.includes(x))) {
    const dOnly = `Gi0/${q.meta.pcs[q.meta.d].port}`;
    assert.ok(q.options.includes(dOnly) && ans(q) !== dOnly, 'Lv183: 宛先のポートだけが正解になった');
  }
}
{ // 184: 宛先まで数えた数(ありがちな間違い)と違う問題が多く出る
  const a = qs(184, N);
  assert.ok(count(a, (q) => q.meta.trap !== Number(ans(q))) > N * 0.5, 'Lv184: 宛先を数える間違いと区別できる問題が少ない');
  for (const q of a) assert.ok(!q.fields[0].accept.includes(String(q.meta.trap)) || q.meta.trap === Number(ans(q)), 'Lv184');
}
{ // 185: 同じサブネット・境目のすぐ外・離れた宛先が出る。外の宛先の答えは必ずゲートウェイ
  const a = qs(185, N);
  const n4 = (s) => s.split('.').reduce((x, y) => x * 256 + Number(y), 0);
  const near = (q) => { const m = 2 ** (32 - q.meta.p); const net = Math.floor(n4(q.meta.pc) / m) * m; const d = n4(q.meta.dst); return Math.floor(d / m) * m !== net && d > net - m && d < net + 2 * m; };
  assert.ok(count(a, (q) => ans(q) === q.meta.dst) > N * 0.25, 'Lv185: 同じサブネットが少ない');
  assert.ok(count(a, near) > N * 0.1, 'Lv185: 境目のすぐ外が少ない');
  for (const q of a) if (ans(q) !== q.meta.dst) assert.strictEqual(ans(q), q.meta.gw, 'Lv185');
}
{ // 187: その VLAN を通さないトランクがある問題が出る(全部のトランクに出す誤りと区別)
  const a = qs(187, N);
  assert.ok(count(a, (q) => q.meta.cfg.some((c) => c.trunk && !c.allow.includes(q.meta.V))) > N * 0.3, 'Lv187: 通さないトランクが少ない');
}
{ // 191: 同点は MAC で決まる。MAC がいちばん小さいスイッチでも、優先度が大きければルートにならない
  const a = qs(191, N);
  assert.ok(count(a, (q) => q.meta.tie) > N * 0.35, 'Lv191: 同じ優先度の問題が少ない');
  const minMac = (q) => q.meta.sw.slice().sort((x, y) => (x.mac < y.mac ? -1 : 1))[0].name.toLowerCase();
  assert.ok(count(a, (q) => minMac(q) !== ans(q)) > N * 0.2, 'Lv191: MAC だけで選ぶ間違いと区別できる問題が少ない');
  assert.ok(judge(a[0], [a[0].fields[0].accept[0].toUpperCase()]), 'Lv191: SW1 の大文字でも正解');
}
{ // 195・196: 8 の倍数に切り下げる MTU、最後の断片に入りきる境目、分けない(1 個)が出る。オフセットをバイトで答えると誤り
  const a = qs(195, N);
  assert.ok(count(a, (q) => ans(q) === '1') > 0, 'Lv195: 分けない問題が出ない');
  assert.ok(count(a, (q) => Number(ans(q)) !== Math.ceil(q.meta.D / (q.meta.M - 20))) > 0, 'Lv195: 8 の倍数の切り下げが効く問題が出ない');
  assert.ok(count(a, (q) => { const per = Math.floor((q.meta.M - 20) / 8) * 8; return Number(ans(q)) !== Math.ceil(q.meta.D / per); }) > 0, 'Lv195: 最後の断片に入りきる境目が出ない');
  assert.strictEqual(I.fragSim(1500, 3000).length, 3, 'Lv195 例: 3,000 バイト・MTU 1,500 → 3 個');
  assert.deepStrictEqual(I.fragSim(1006, 1970), [984, 986], 'Lv195 例: 最後の断片は 8 の倍数でなくてよい');
  for (const q of qs(196, N)) { const per = Math.floor((q.meta.M - 20) / 8) * 8; assert.ok(!q.fields[0].accept.includes(String((q.meta.k - 1) * per)), 'Lv196: バイトの値が正解になる'); }
}
{ // 197: メトリックの数がいちばん小さい候補が正解でない問題が出る。198: RIP のホップ数の方が小さくても OSPF を選ぶ
  const a = qs(197, N);
  assert.ok(count(a, (q) => { const r = q.table.rows; const lowM = r.reduce((x, y) => (Number(y[3]) < Number(x[3]) ? y : x)); return lowM[4] !== ans(q); }) > N * 0.2, 'Lv197: メトリックで選ぶ間違いと区別できる問題が少ない');
  const b = qs(198, N).filter((q) => q.meta.withRip);
  assert.ok(b.length > N * 0.3, 'Lv198: RIP の候補がある問題が少ない');
  for (const q of b) { const rip = q.table.rows.find((r) => r[1] === 'RIP'); assert.ok(rip[4] !== ans(q), 'Lv198: RIP が選ばれた'); }
  assert.ok(b.some((q) => { const rip = q.table.rows.find((r) => r[1] === 'RIP'); const chosen = q.table.rows.find((r) => r[4] === ans(q)); return Number(rip[3]) < Number(chosen[3]); }), 'Lv198');
}
{ // 199: いちばん長い一致の行が、ほかに当てはまる行より AD 値が大きい問題(AD で選ぶ間違い)と、長いが当てはまらない行が出る
  const a = qs(199, N);
  const inB = (d, n, p) => I.bits(d).slice(0, p) === I.bits(n).slice(0, p);
  assert.ok(count(a, (q) => { const m = q.table.rows.filter((r) => inB(q.meta.dst, ...r[0].split('/').map((x, i) => (i ? Number(x) : x)))); const best = m.find((r) => r[4] === ans(q)); return m.some((r) => Number(r[2]) < Number(best[2])); }) > N * 0.3, 'Lv199: AD で選ぶ間違いと区別できる問題が少ない');
  assert.ok(count(a, (q) => q.table.rows.some((r) => !inB(q.meta.dst, r[0].split('/')[0], Number(r[0].split('/')[1])))) > N * 0.5, 'Lv199: 当てはまらない長い行が少ない');
}
{ // 211: 除外がプールからはみ出す・プールの外だけ、が出る。両端の数え忘れ(1 少ない)は正解にならない
  const a = qs(211, N);
  assert.ok(count(a, (q) => q.meta.ex.some((e) => (e[0] < q.meta.a && e[1] >= q.meta.a) || (e[1] > q.meta.b && e[0] <= q.meta.b))) > 0, 'Lv211: はみ出す除外が出ない');
  assert.ok(count(a, (q) => q.meta.ex.some((e) => e[1] < q.meta.a || e[0] > q.meta.b)) > 0, 'Lv211: プールの外の除外が出ない');
  const q0 = a[0]; assert.ok(!judge(q0, [String(Number(ans(q0)) - 1)]), 'Lv211');
}
{ // 212: 予約の機器・予約の無い機器の両方。似た MAC(1 文字違い)の機器に予約のアドレスを渡さない
  const a = qs(212, N);
  const res = a.filter((q) => q.meta.res.some((r) => r.mac === q.meta.mac));
  assert.ok(res.length > N * 0.3 && res.length < N * 0.7, 'Lv212: 予約の割合');
  const like = a.filter((q) => !res.includes(q) && q.meta.res.some((r) => r.mac.slice(0, -1) === q.meta.mac.slice(0, -1)));
  assert.ok(like.length > N * 0.2, 'Lv212: 似た MAC の問題が少ない');
  for (const q of like) for (const r of q.meta.res) assert.ok(ans(q) !== `${q.meta.base.split('.').slice(0, 3).join('.')}.${r.h}`, 'Lv212: 似た MAC に予約のアドレスを渡した');
}
{ // 214: CNAME 1 段・2 段、直接の A、MX が出る
  const a = qs(214, N);
  for (const v of ['cname', 'direct', 'mx']) assert.ok(count(a, (q) => q.meta.variant === v) > N * 0.1, `Lv214: ${v} が少ない`);
  assert.ok(count(a, (q) => q.meta.chain) > N * 0.1, 'Lv214: CNAME 2 段が少ない');
}
{ // 221: 暗黙の拒否・各行が出る。入力の書き方の揺れも正解になる
  const a = qs(221, N);
  assert.ok(count(a, (q) => ans(q) === 'deny implicit') > N * 0.1, 'Lv221: 暗黙の拒否が少ない');
  for (const n of [10, 20, 30]) assert.ok(count(a, (q) => ans(q).endsWith(` ${n}`)) > N * 0.1, `Lv221: 行 ${n} が少ない`);
  const q = a.find((x) => ans(x) !== 'deny implicit'); const [act, n] = ans(q).split(' ');
  assert.ok(judge(q, [`${n} ${act === 'permit' ? '許可' : '拒否'}`]), 'Lv221: 「20 許可」の形');
  assert.ok(!judge(q, [act]), 'Lv221: 行番号なしは誤り');
  // 例: 10 deny 10.1.1.0 0.0.0.255、20 permit 10.1.0.0 0.0.255.255
  const ex = [['10', 'deny', '10.1.1.0 0.0.0.255'], ['20', 'permit', '10.1.0.0 0.0.255.255']];
  assert.deepStrictEqual(['10.1.1.5', '10.1.2.5', '10.2.0.5'].map((s) => I.evalAclBits(ex, s)), ['deny 10', 'permit 20', 'deny implicit'], 'Lv222 の例');
}
{ // 222: 通る数 0〜3 が出る
  const a = qs(222, N); for (const n of ['0', '1', '2', '3']) assert.ok(a.some((q) => ans(q) === n), `Lv222: ${n} 個の問題が出ない`);
}
{ // 223: 正解が範囲の両端の問題が出る。誤答に境目のすぐ外が並ぶ
  const a = qs(223, N);
  assert.ok(count(a, (q) => ans(q) === q.meta.start) > 0, 'Lv223: 先頭が正解の問題が出ない');
  assert.ok(count(a, (q) => q.options.some((o, i) => i !== q.answerIndex && I.bits(o).slice(0, 16) === I.bits(q.meta.start).slice(0, 16))) > N * 0.5, 'Lv223: 近い誤答が少ない');
}
{ // 234: 1 番目と最後のサブネットが出る
  const a = qs(234, N);
  assert.ok(a.some((q) => q.meta.N === 1) && a.some((q) => q.meta.N === 2 ** (q.meta.c - q.meta.p)), 'Lv234: 両端の番号が出ない');
}
{ // 239: コンテナの内側のアドレスと、機械のアドレス + コンテナのポートは正解にならない
  for (const q of qs(239, N)) {
    const r = q.table.rows.find((x) => x[0] === q.meta.name);
    assert.ok(!judge(q, [`${r[1]}:${r[2]}`]), 'Lv239: 内側のアドレスが正解になる');
    if (r[2] !== r[3]) assert.ok(!judge(q, [`${q.meta.host}:${r[2]}`]), 'Lv239: コンテナのポートが正解になる');
  }
}
{ // 229: ボトムアップとトップダウンの両方。「2-4-3-1」「2 4 3 1」の書き方も正解
  const a = qs(229, 400);
  assert.ok(a.some((q) => q.meta.up) && a.some((q) => !q.meta.up), 'Lv229: 両方の向き');
  const q = a[0]; const s = q.fields[0].accept[0].split('');
  assert.ok(judge(q, [s.join('-')]) && judge(q, [s.join(' ')]), 'Lv229: 書き方の揺れ');
  assert.ok(!judge(q, [s.slice().reverse().join('-')]), 'Lv229: 逆の順が正解になる');
}
{ // 217: 4 つの問いの型が出る。219: 送り手・受け手の名前が入れ替わる
  const a = qs(217, 400); for (const t of ['num2name', 'name2num', 'heaviest', 'compare']) assert.ok(a.some((q) => q.meta.t === t), `Lv217: ${t}`);
  const b = qs(219, 400); assert.ok(new Set(b.map((q) => q.meta.S + q.meta.R)).size >= 10, 'Lv219: 名前の組が少ない');
  for (const q of b) assert.ok(!/\{[SR]\}/.test(strings(q).join('')), 'Lv219: 置き換え忘れ');
}
{ // 188・189・238: 番号を変える問いと表の行の両方が出る
  for (const lv of [188, 189, 238]) { const a = qs(lv, 400); assert.ok(a.some((q) => q.meta.rowId) && a.some((q) => !q.meta.rowId), `Lv${lv}: 2 つの作り方`); }
  const a = qs(188, 1000).filter((q) => !q.meta.rowId);
  assert.ok(a.some((q) => q.meta.N === q.meta.V) && a.some((q) => q.meta.N !== q.meta.V), 'Lv188: ネイティブと同じ・違う VLAN');
}

console.log(`cl-mid ok: ${MID.length} levels(生 ${MID.filter((l) => LEVELS[l].kind === '生').length}・表 ${TABLE.length})、表の行 ${rowCount}`);
