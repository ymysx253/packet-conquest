'use strict';
// 初級(新しい番号 68〜158)の問題の、レベルならではの確かめ(2026-10-22。docs/questions/CL.md 第 5 章)。test/cl.js が読む。
// 形・verify・違う問題の数は test/cl.js がまとめて確かめる。ここでは次を確かめる:
//   - 初級の決まり(ヒント・解説・型の名前の番号)
//   - 表のレベルは、選択肢の並びを変えただけでない違う問題が 30 通り以上あること
//   - 境界の値が出ること、ありがちな間違いが正解にならないこと
//   - 使ってよいアドレス・ドメインの範囲だけを使っていること
const assert = require('assert');
const { LEVELS } = require('../server/questions/cl/levels-basic');
const { getClQuestion } = require('../server/questions/cl');
const { judge } = require('../server/questions/normalize');

const LVS = Object.keys(LEVELS).map(Number).sort((a, b) => a - b);
const gen = (lv, n, from = 1) => Array.from({ length: n }, (_, i) => getClQuestion({ level: lv, seed: from + i }));
const answerOf = (q) => (q.answerKind === 'text' ? q.fields[0].accept[0] : q.options[q.answerIndex]);
const textAll = (q) => [q.text, q.hint, q.explanation, ...(q.options || []), ...((q.table && q.table.rows) || []).flat()].join('\n');

// ---------- 作る行(一覧の担当 O・新規、構成図などを除く)がそろっていること ----------
const WANT = [68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 80, 81, 84, 95, 96, 97, 98, 99, 100, 101, 107, 109, 110, 112, 117, 118, 119, 120, 121, 122, 123,
  125, 126, 127, 128, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148];
assert.deepStrictEqual(LVS, WANT, '初級で作るレベルの並びが一覧と違う');
for (const lv of LVS) assert.ok(lv >= 68 && lv <= 148, `Lv${lv} は初級(構成図より前)の番号でない`);

// ---------- 初級の決まりと、使ってよい範囲 ----------
const okV4 = (a) => {
  const o = a.split('.').map(Number); if (o.length !== 4 || o.some((x) => !(x >= 0 && x <= 255))) return false;
  const n = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const inNet = (net, p) => { const m = net.split('.').map(Number); const nn = ((m[0] << 24) >>> 0) + (m[1] << 16) + (m[2] << 8) + m[3]; return p === 0 || (n >>> (32 - p)) === (nn >>> (32 - p)); };
  const isMask = (() => { const b = o.map((x) => x.toString(2).padStart(8, '0')).join(''); return /^1+0*$/.test(b); })();
  return isMask || [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['169.254.0.0', 16], ['127.0.0.0', 8], ['224.0.0.0', 4], ['0.0.0.0', 32], ['255.255.255.255', 32]].some(([net, p]) => inNet(net, p));
};
// 種別を問うレベル(クラス・プライベートかどうか)だけは、範囲の境界の例(172.15・172.32・192.169)を使ってよい(COMMON.md 第 7 章)
const EDGE_OK = new Set([95, 97]);
const isEdge = (a) => /^(172\.15|172\.32|192\.169)\./.test(a);
for (const lv of LVS) {
  for (const q of gen(lv, 400)) {
    const where = `Lv${lv} seed ${q.seed}`;
    assert.ok(typeof q.hint === 'string' && q.hint.trim().length >= 6, `${where}: ヒントがない`);
    assert.ok(q.explanation.trim().length >= 15, `${where}: 解説が短すぎる`);
    assert.ok(q.kind.startsWith(`cl${lv}-`), `${where}: 型の名前の番号が違う ${q.kind}`);
    assert.ok(q.meta, `${where}: meta がない`);
    const all = textAll(q);
    for (const a of all.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []) {
      assert.ok(okV4(a) || (EDGE_OK.has(lv) && isEdge(a)), `${where}: 使えない IPv4 アドレス ${a}`);
    }
    for (const d of all.match(/\b[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\b/g) || []) assert.ok(/\.example$/.test(d), `${where}: .example でない名前 ${d}`);
    for (const v6 of all.match(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/g) || []) {
      if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(v6)) continue; // MAC アドレス
      assert.ok(/^(2001:0?db8|fe80|ff02)/.test(v6) || /^::/.test(v6) || /^[01:]+$/.test(v6), `${where}: 文書用でない IPv6 ${v6}`);
    }
  }
}

// ---------- 表のレベル: 選択肢の並びだけ違うものを除いても 30 通り以上 ----------
for (const lv of LVS.filter((x) => LEVELS[x].kind === '表')) {
  const seen = new Set();
  for (const q of gen(lv, 3000)) seen.add(JSON.stringify([q.text, (q.options || []).slice().sort(), q.table || null]));
  assert.ok(seen.size >= 30, `Lv${lv}(${LEVELS[lv].title}): 並びを除いた違う問題が ${seen.size} 通りしかない`);
}
// 表の誤答は正解にならない(verify は test/cl.js でも通すが、ここでは誤答をすべて選んで不正解になることも見る)
for (const lv of LVS) {
  for (const q of gen(lv, 300, 5000)) {
    if (q.answerKind === 'text') continue;
    q.options.forEach((_, i) => assert.strictEqual(judge(q, i), i === q.answerIndex, `Lv${lv} seed ${q.seed}: 選択肢 ${i} の判定`));
  }
}

// ---------- 並べ替え(Lv69・76・117): - でも空白でも、つながっていても同じ。逆の順は不正解 ----------
for (const lv of [69, 76, 117]) {
  let n = 0;
  for (const q of gen(lv, 600)) {
    if (q.answerKind !== 'text') continue;
    n++;
    const digits = q.fields[0].accept[0];
    assert.ok(/^\d+$/.test(digits), `Lv${lv}: 並べ替えの正解が数字の列でない ${digits}`);
    for (const form of [digits.split('').join('-'), digits.split('').join(' '), digits, digits.split('').join(' - ')]) assert.ok(judge(q, [form]), `Lv${lv}: 「${form}」が正解にならない`);
    assert.ok(!judge(q, [digits.split('').reverse().join('-')]), `Lv${lv}: 逆の順が正解になった`);
  }
  assert.ok(n >= 100, `Lv${lv}: 並べ替えの問題が少ない`);
}
// Lv69 の例(下から): 1 トランスポート 2 物理 3 ネットワーク 4 データリンク → 2-4-3-1
{
  const q = gen(69, 3000).find((x) => x.text.includes('下(第 1 層)から上へ') && x.text.includes('1 トランスポート層\n2 物理層\n3 ネットワーク層\n4 データリンク層'));
  assert.ok(q, 'Lv69: 一覧の例の並びが出ない');
  assert.ok(judge(q, ['2-4-3-1']), 'Lv69: 一覧の例 2-4-3-1 が正解にならない');
}

// ---------- Lv77: 受け取る側で最初に外すのはイーサネットヘッダ ----------
for (const q of gen(77, 2000)) {
  if (q.meta.type !== 'decap' || q.meta.form !== 'first' || q.meta.side !== 'recv') continue;
  assert.strictEqual(q.answerIndex === 0, q.meta.x === 'イーサネットヘッダ', `Lv77: ${q.text}`);
}

// ---------- Lv80: フルメッシュの線の数(3 台 = 3 本、4 台 = 6 本、n(n−1) は誤り) ----------
for (const q of gen(80, 3000).filter((x) => x.meta.type === 'mesh')) {
  const n = q.meta.n;
  assert.strictEqual(q.options[q.answerIndex], `${n * (n - 1) / 2} 本`);
  assert.ok(!q.options.includes(`${n * (n - 1)} 本`) || q.options[q.answerIndex] !== `${n * (n - 1)} 本`, 'Lv80: n(n−1) が正解になった');
}

// ---------- Lv84: 境界(/8・/32)と一覧の例(255.255.240.0 → 20)。±1 は不正解 ----------
{
  const qs = gen(84, 10000);
  const ps = new Set(qs.map((q) => q.meta.p));
  for (let p = 8; p <= 32; p++) assert.ok(ps.has(p), `Lv84: /${p} が出ない`);
  const ex = qs.find((q) => q.meta.mask === '255.255.240.0');
  assert.ok(ex && judge(ex, ['20']), 'Lv84: 255.255.240.0 → 20');
  for (const q of qs.slice(0, 500)) {
    assert.ok(judge(q, [String(q.meta.p)]) && judge(q, [`${q.meta.p}`]));
    assert.ok(!judge(q, [String(q.meta.p + 1)]) && !judge(q, [String(q.meta.p - 1)]), 'Lv84: ±1 が正解になった');
    assert.ok(!judge(q, [q.meta.mask]), 'Lv84: マスクをそのまま打って正解になった');
  }
}

// ---------- Lv95: クラスの境界 ----------
{
  const want = { 1: 'クラス A', 126: 'クラス A', 128: 'クラス B', 191: 'クラス B', 192: 'クラス C', 223: 'クラス C', 224: 'クラス D', 239: 'クラス D' };
  const qs = gen(95, 10000);
  for (const [first, cls] of Object.entries(want)) {
    const hit = qs.filter((q) => q.meta.first === Number(first));
    assert.ok(hit.length, `Lv95: 先頭 ${first} が出ない`);
    for (const q of hit) assert.strictEqual(q.options[q.answerIndex], cls, `Lv95: 先頭 ${first}`);
  }
  assert.ok(!qs.some((q) => q.meta.first === 127 || q.meta.first === 0), 'Lv95: 0・127 は出さない');
}

// ---------- Lv97: 範囲の境界(172.15 と 172.32 はプライベートでない、172.16 と 172.31 はプライベート) ----------
{
  const qs = gen(97, 5000);
  const ansPriv = qs.filter((q) => q.meta.want).map(answerOf);
  const ansNon = qs.filter((q) => !q.meta.want).map(answerOf);
  assert.ok(ansPriv.some((a) => a.startsWith('172.16.')) && ansPriv.some((a) => a.startsWith('172.31.')), 'Lv97: 172.16・172.31 がプライベートの正解に出ない');
  assert.ok(ansNon.some((a) => a.startsWith('172.15.')) && ansNon.some((a) => a.startsWith('172.32.')), 'Lv97: 172.15・172.32 が「でない」の正解に出ない');
  assert.ok(!ansPriv.some((a) => /^(172\.(15|32)|192\.169)\./.test(a)), 'Lv97: 境界の外がプライベートの正解になった');
}

// ---------- Lv98: 3 つの範囲の端。先頭のアドレスやブロードキャストの取り違えは不正解 ----------
{
  const qs = gen(98, 10000);
  const ends = { '10.0.0.0/8': '10.255.255.255', '172.16.0.0/12': '172.31.255.255', '192.168.0.0/16': '192.168.255.255' };
  for (const [blk, last] of Object.entries(ends)) {
    const hit = qs.filter((q) => `${q.meta.net}/${q.meta.p}` === blk);
    assert.ok(hit.length, `Lv98: ${blk} が出ない`);
    for (const q of hit) { assert.ok(judge(q, [last]), `Lv98: ${blk} → ${last}`); assert.ok(!judge(q, [q.meta.net])); }
  }
  for (const q of qs.slice(0, 1000)) {
    const [a, b] = q.meta.net.split('.').map(Number);
    assert.ok(!judge(q, [`${a}.${b + 2 ** (16 - q.meta.p)}.0.0`]), 'Lv98: 次のブロックの先頭が正解になった');
  }
}

// ---------- Lv99: 自動で付くアドレスを選ぶ問題は、169.254 がちょうど 1 つ ----------
for (const q of gen(99, 2000).filter((x) => x.meta.type === 'apipa')) {
  assert.strictEqual(q.options.filter((o) => o.startsWith('169.254.')).length, 1, `Lv99: ${q.options}`);
}

// ---------- Lv101: :: が 2 つある書き方は必ず ×、:: 1 つで作った書き方は必ず ○ ----------
{
  let two = 0; let one = 0;
  for (const q of gen(101, 5000)) {
    if (q.meta.type !== 'v6valid') continue;
    const n = (q.meta.s.match(/::/g) || []).length;
    if (n >= 2) { two++; assert.strictEqual(q.answerIndex, 1, `Lv101: ${q.meta.s}`); } else { one++; assert.strictEqual(q.answerIndex, 0, `Lv101: ${q.meta.s}`); }
  }
  assert.ok(two > 100 && one > 100, `Lv101: 正しい書き方 ${one}・誤り ${two} の偏り`);
  const same = gen(101, 5000).filter((q) => q.meta.type === 'v6same');
  assert.ok(same.some((q) => q.answerIndex === 0) && same.some((q) => q.answerIndex === 1), 'Lv101: 同じアドレスか の ○ と × が両方出ない');
}

// ---------- Lv110: デフォルトルートが無く、どれにも合わないときは「捨てる」 ----------
{
  const qs = gen(110, 5000).filter((q) => q.meta.type === 'droute');
  assert.ok(qs.some((q) => answerOf(q) === '送り先が無いので捨てる'), 'Lv110: 捨てる問題が出ない');
  for (const q of qs) if (q.meta.rows.some(([n]) => n === '0.0.0.0/0')) assert.notStrictEqual(answerOf(q), '送り先が無いので捨てる', 'Lv110: デフォルトルートがあるのに捨てた');
}

// ---------- Lv112: TTL(一覧の例 64 − 3 = 61)。±1 は不正解 ----------
for (const q of gen(112, 3000)) {
  const a = Number(answerOf(q));
  assert.ok(!judge(q, [String(a + 1)]) && !judge(q, [String(a - 1)]), `Lv112: ±1 が正解 ${q.text}`);
  if (q.meta.form === 'drop') assert.strictEqual(a, q.meta.T, 'Lv112: TTL T は T 台目で捨てる');
}
assert.ok(gen(112, 10000).some((q) => /TTL 64 で/.test(q.text) && /ルーターを 3 台/.test(q.text) && judge(q, ['61'])), 'Lv112: 一覧の例(64 で 3 台 → 61)が出ない');

// ---------- Lv127: 多要素の選択肢は、同じ組を並びを変えて出さない ----------
for (const q of gen(127, 2000).filter((x) => x.meta.type === 'mfa')) {
  const keys = q.options.map((o) => o.split(' + ').slice().sort().join('+'));
  assert.strictEqual(new Set(keys).size, keys.length, `Lv127: 同じ組が 2 つ ${q.options}`);
}

// ---------- Lv130: 共通鍵の数 n(n−1)/2(一覧の決まり)。n(n−1) は正解にならない ----------
for (const q of gen(130, 3000).filter((x) => x.meta.type === 'keycount' && !x.meta.pub)) {
  const n = q.meta.n;
  assert.strictEqual(answerOf(q), `${n * (n - 1) / 2} 個`);
}

// ---------- Lv138: 損失(一覧の例 送信 4・受信 3 → 25)。受信の割合(75)は不正解 ----------
{
  const qs = gen(138, 10000);
  const ex = qs.find((q) => q.meta.n === 4 && q.meta.r === 3 && q.meta.askPct);
  assert.ok(ex && judge(ex, ['25']), 'Lv138: 4 送って 3 受けたら 25 %');
  for (const q of qs.filter((x) => x.meta.askPct && x.meta.r !== x.meta.n / 2)) assert.ok(!judge(q, [String((q.meta.r * 100) / q.meta.n)]), 'Lv138: 受信の割合が正解になった');
}

// ---------- Lv139・140: 読む行の値が正解で、ほかの行の値は不正解 ----------
for (const lv of [139, 140]) {
  const label = lv === 139 ? 'デフォルト ゲートウェイ' : 'DNS サーバー';
  for (const q of gen(lv, 2000)) {
    const want = q.table.rows.find(([k]) => k === label)[1];
    assert.strictEqual(answerOf(q), want, `Lv${lv}: ${want}`);
    for (const [k, v] of q.table.rows) {
      if (v === want || !/^\d/.test(v)) continue;
      if (q.answerKind === 'text') assert.ok(!judge(q, [v]), `Lv${lv}: ${k} の値が正解になった`);
    }
  }
}

// ---------- Lv141・142: 一覧の例(100 MB・100 Mbps → 8 秒、80 % → 10 秒)。×8 忘れは不正解 ----------
{
  const t141 = gen(141, 10000);
  assert.ok(t141.some((q) => q.meta.mb === 100 && q.meta.mbps === 100 && judge(q, ['8'])), 'Lv141: 100 MB・100 Mbps → 8 秒が出ない');
  for (const q of t141) { const forget = (q.meta.mb / q.meta.mbps); if (forget !== Number(answerOf(q))) assert.ok(!judge(q, [String(forget)])); }
  const t142 = gen(142, 10000);
  assert.ok(t142.some((q) => q.meta.mb === 100 && q.meta.mbps === 100 && q.meta.ratio === 80 && judge(q, ['10'])), 'Lv142: 80 % → 10 秒が出ない');
  for (const q of t142) { const noRatio = (q.meta.mb * 8) / q.meta.mbps; if (noRatio !== Number(answerOf(q))) assert.ok(!judge(q, [String(noRatio)]), 'Lv142: 割合を忘れた答えが正解'); }
}

// ---------- Lv135: 1000BASE-T は「いちばん下」を問わない(カテゴリ 5 と 5e で意見が分かれる) ----------
for (const q of gen(135, 2000)) if (q.meta.type === 'catlow') assert.notStrictEqual(q.meta.std, '1000t');

console.log(`cl-basic ok: ${LVS.length} levels`);
