'use strict';
// Lv21〜30(VLSM)の生成問題を別実装で解き直して検証する(docs/questions/COMMON.md 第 8 章、design-11-50.md 第 2.3 節)。
// 生成器は 2 の冪の計算と整列の切り上げで置くが、ここでは「要件を大きい順に並べ、2 の冪に倍々で切り上げ、
// 親のアドレスを先頭から 1 つずつ走査して置く」素朴な方法と、全アドレスの列挙(占有表)で確かめる。
const assert = require('assert');
const vlsm = require('../server/questions/vlsm');
const { make, build, RANGE, VERSION } = vlsm;
const { makeRng } = require('../server/questions/rng');
const { normalize, judge } = require('../server/questions/normalize');
const { NODES } = require('../server/map/tokyo');

// ---------- 別実装の部品 ----------
const parseIp = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const toIp = (n) => [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
const sizeOfP = (p) => 2 ** (32 - p);
const pOfSize = (size) => { let p = 32, s = 1; while (s < size) { s *= 2; p--; } assert.strictEqual(s, size, '2 の冪'); return p; };
// 必要台数 + 2 が収まるブロック: 4 から倍々にする
function naiveBlock(hosts) { let size = 4; while (size - 2 < hosts) size *= 2; return size; }
// 占有表(親のアドレス 1 つにつき 1 要素)。全アドレスの列挙で重なりと親の範囲を確かめる
function occupancy(parent) { return { net: parent.net, size: sizeOfP(parent.p), used: new Uint8Array(sizeOfP(parent.p)) }; }
function markAll(occ, net, size) {
  for (let a = net; a < net + size; a++) {
    const i = a - occ.net;
    assert.ok(i >= 0 && i < occ.size, `親の外: ${toIp(a)}`);
    assert.strictEqual(occ.used[i], 0, `重なり: ${toIp(a)}`);
    occ.used[i] = 1;
  }
}
const isFree = (occ, net, size) => { for (let a = net; a < net + size; a++) { const i = a - occ.net; if (i < 0 || i >= occ.size || occ.used[i]) return false; } return true; };
// 先頭から 1 アドレスずつ走査し、size の倍数で空いている最初の位置を返す(無ければ null)
function scanFirstFit(occ, size, from = occ.net) {
  for (let a = from; a + size <= occ.net + occ.size; a++) if (a % size === 0 && isFree(occ, a, size)) return a;
  return null;
}
// 大きい順(同サイズは書かれた順)に先頭から詰める
function naiveDescending(parent, regions) {
  const occ = occupancy(parent);
  const sized = regions.map((r, idx) => ({ ...r, size: naiveBlock(r.hosts), idx })).sort((a, b) => b.size - a.size || a.idx - b.idx);
  let cursor = parent.net;
  for (const r of sized) {
    const net = scanFirstFit(occ, r.size, cursor);
    assert.notStrictEqual(net, null, '親に収まる');
    assert.strictEqual(net, cursor, '隙間なく並ぶ');
    markAll(occ, net, r.size); r.net = net; r.p = pOfSize(r.size); cursor = net + r.size;
  }
  return { sized, occ, end: cursor };
}
// 空き [start, end) を貪欲に分解: 大きいサイズから試して、整列し収まる最大のものを取る
function naiveFree(start, end) {
  const out = [];
  let cur = start;
  while (cur < end) {
    let size = 2 ** 31;
    while (size > 1 && (cur % size !== 0 || cur + size > end)) size /= 2;
    out.push({ net: cur, size, p: pOfSize(size) }); cur += size;
  }
  return out;
}
const bin32 = (n) => n.toString(2).padStart(32, '0');
// 2 進文字列の共通接頭辞で集約
function naiveSummary(aNet, aP, bNet, bP) {
  const a = bin32(aNet), b = bin32(bNet);
  let p = 0; while (p < Math.min(aP, bP) && a[p] === b[p]) p++;
  return { net: parseInt(a.slice(0, p).padEnd(32, '0'), 2), p };
}
const inRange = (net, size, a) => a >= net && a < net + size;
const SAFE = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]];
const isSafeIp = (s) => SAFE.some(([n, p]) => Math.floor(parseIp(s) / sizeOfP(p)) === Math.floor(parseIp(n) / sizeOfP(p)));
const cidrStr = (net, p) => `${toIp(net)}/${p}`;
const sortedAccepts = (q) => q.fields.map((f) => f.accept[0]).sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------- 1 万件 ----------
let n = 0;
const seenTypes = new Set();
const perLevel = {};
const marks = { tie: 0, noTie: 0, fit: 0, noFit: 0, engulf0: 0, engulfSome: 0, trap: 0, plan: 0, free: 0, twoNew: 0 };
for (let i = 0; i < 10000; i++) {
  const level = RANGE[0] + (i % (RANGE[1] - RANGE[0] + 1));
  const node = NODES[i % NODES.length];
  const rng = makeRng(i);
  const q = make(level, node, rng);
  seenTypes.add(q.type);
  perLevel[level] = (perLevel[level] || 0) + 1;

  // 形(COMMON.md 第 1 章)
  assert.strictEqual(q.level, level);
  assert.strictEqual(q.answerKind, 'text', q.type);
  assert.match(q.templateId, /^vlsm-[a-z0-9-]+-v1$/);
  assert.strictEqual(q.templateId, `${q.type}-v1`);
  assert.strictEqual(q.seed, makeRng(i).seed, 'seed は rng の seed');
  assert.strictEqual(q.generatorVersion, VERSION);
  assert.ok(typeof q.defenseNote === 'string' && q.defenseNote.trim().length > 0, 'defenseNote 必須');
  assert.ok(q.text && q.explanation && q.meta && q.table, q.type);
  assert.ok(Array.isArray(q.fields) && q.fields.length >= 1 && q.fields.length <= 6, `欄数は 6 まで: ${q.type} ${q.fields.length}`);
  assert.strictEqual(new Set(q.fields.map((f) => f.name)).size, q.fields.length, '欄の name が重複しない');
  assert.ok(!q.compare || q.compare === 'set' || q.compare === 'ordered');
  if (q.compare === 'set') assert.strictEqual(new Set(q.fields.map((f) => f.format)).size, 1, 'set の欄は同じ format');
  for (const f of q.fields) {
    assert.ok(f.label && f.format && f.hint, 'label / format / hint');
    assert.ok(Array.isArray(f.accept) && f.accept.length >= 1);
    for (const a of f.accept) assert.strictEqual(normalize(f.format, a, f), a, `accept は正規形: ${f.format} ${a}`);
    if (f.format === 'number') assert.match(f.accept[0], /^\d+$/, '数は桁区切りなし');
    if (f.format === 'ipv4' || f.format === 'ipv4cidr') assert.ok(!f.accept.includes(normalize(f.format, f.hint.replace(/^例: /, ''), f)), 'hint(文書用アドレス)が答えと一致しない');
  }
  // 正規化・判定を通す: 正解(そのまま / 全角 / 順を入れ替え)が正解になり、ずらしたものが不正解になる
  const inputs = q.fields.map((f) => f.accept[0]);
  assert.ok(judge(q, inputs), `正解が正解になる: ${q.type}`);
  assert.ok(judge(q, inputs.map((s) => s.replace(/[0-9./]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)))), '全角でも正解');
  if (q.compare === 'set' && q.fields.length >= 2) assert.ok(judge(q, inputs.slice().reverse()), 'set は順を入れ替えても正解');
  if (q.fields.length >= 2 && !q.compare && new Set(inputs).size === inputs.length && q.fields[0].format === q.fields[1].format) assert.ok(!judge(q, [inputs[1], inputs[0], ...inputs.slice(2)]), 'ordered は順を入れ替えると不正解');
  assert.ok(!judge(q, inputs.map(() => '')), '空欄は不正解');
  // 本文の約束(答えの形に関わる規約を毎回書く)
  assert.ok(/大きい順|書かれた順|先頭の整列位置/.test(q.text), '並べ方の規則');
  assert.ok(/ネットワークアドレスとブロードキャスト/.test(q.text), '+2 の約束');
  assert.ok(/ルータのインターフェース/.test(q.text) || q.type === 'vlsm-summary', 'ルータ IF の約束');
  // 安全規則: 本文・表・解説・defenseNote・ラベル・hint に出る IPv4 がすべて許可範囲
  const texts = [q.text, q.explanation, q.defenseNote, JSON.stringify(q.table), ...q.fields.map((f) => f.label + ' ' + f.hint)].join('\n');
  for (const ip of texts.match(/\d{1,3}(?:\.\d{1,3}){3}/g) || []) assert.ok(isSafeIp(ip), `安全範囲外のアドレス ${ip}(${q.type})`);
  assert.ok(!/\bexample\.com\b|\.co\.jp\b/.test(texts));

  // 親は拠点のブロックの中(p ≥ 拠点)か、拠点を含む上位ブロック
  const m = q.meta;
  const parent = m.parent;
  assert.ok(parent.p >= 16 && parent.p <= 23, `親は /16〜/23: /${parent.p}`);
  const nodeSize = (node.span || 65534) + 2;
  if (sizeOfP(parent.p) <= nodeSize) assert.ok(parent.net >= node.base && parent.net + sizeOfP(parent.p) <= node.base + nodeSize, '親は拠点のブロックの中');
  else assert.ok(parent.net <= node.base && node.base + nodeSize <= parent.net + sizeOfP(parent.p), '親は拠点を含む');
  assert.strictEqual(parent.net % sizeOfP(parent.p), 0, '親は整列している');
  assert.ok(isSafeIp(toIp(parent.net)));

  // ---------- レベルごとに解き直す ----------
  switch (q.type) {
    case 'vlsm-prefix': {
      const { sized } = naiveDescending(parent, m.regions);
      assert.ok(same(sortedAccepts(q), sized.map((r) => String(r.p)).sort()));
      // ありがちな間違い: +2 を忘れる、2 の冪への切り上げを忘れる(どちらも値が変わる区画があるときだけ)
      const noPlus2 = m.regions.map((r) => { let s = 4; while (s < r.hosts) s *= 2; return String(pOfSize(s)); }).sort();
      const noRound = m.regions.map((r) => { let s = 4; while (s * 2 <= r.hosts + 2) s *= 2; return String(pOfSize(s)); }).sort();
      const want = sortedAccepts(q);
      if (!same(noPlus2, want)) assert.ok(!judge(q, noPlus2), '+2 忘れは不正解');
      if (!same(noRound, want)) assert.ok(!judge(q, noRound), '切り上げ忘れは不正解');
      assert.ok(m.regions.every((r) => r.hosts >= 5 && r.hosts <= 500) && m.regions.length === 3);
      break;
    }
    case 'vlsm-cidr3':
    case 'vlsm-cidr4': {
      const { sized } = naiveDescending(parent, m.regions);
      assert.ok(same(sortedAccepts(q), sized.map((r) => cidrStr(r.net, r.p)).sort()));
      assert.strictEqual(m.regions.length, q.type === 'vlsm-cidr3' ? 3 : 4);
      for (const r of sized) assert.ok(r.size - 2 >= r.hosts, 'ホスト数を満たす');
      // ありがちな間違い: 小さい順に置く(サイズが全部同じなら同じ配置になるので除く)
      if (new Set(sized.map((r) => r.size)).size > 1) {
        const asc = sized.slice().sort((a, b) => a.size - b.size); let cur = parent.net; const wrong = asc.map((r) => { const c = cidrStr(cur, r.p); cur += r.size; return c; });
        assert.ok(!judge(q, wrong), '小さい順の配置は不正解');
      }
      // +2 忘れで 1 区画が 1 段小さくなるとき、その配置は不正解
      const shrink = sized.findIndex((r) => { let s = 4; while (s < r.hosts) s *= 2; return s !== r.size; });
      if (shrink >= 0) {
        const alt = sized.map((r, k) => ({ ...r, size: k === shrink ? r.size / 2 : r.size })).sort((a, b) => b.size - a.size || a.idx - b.idx);
        let cur = parent.net; const wrong = alt.map((r) => { const c = cidrStr(cur, pOfSize(r.size)); cur += r.size; return c; });
        assert.ok(!judge(q, wrong), '+2 忘れの配置は不正解');
      }
      if (q.type === 'vlsm-cidr4') { if (new Set(sized.map((r) => r.size)).size < 4) marks.tie++; else marks.noTie++; }
      break;
    }
    case 'vlsm-range': {
      const { sized, occ } = naiveDescending(parent, m.regions);
      const r = sized[m.k - 1];
      assert.strictEqual(new Set(sized.map((x) => x.size)).size, sized.length, 'k 番目が一意になるよう同サイズなし');
      const [first, last, unused] = q.fields.map((f) => f.accept[0]);
      assert.strictEqual(first, toIp(r.net + 1));
      assert.strictEqual(last, toIp(r.net + r.size - 2));
      assert.strictEqual(Number(unused), occ.used.reduce((s, u) => s + (1 - u), 0), '未使用数は占有表の空き数');
      assert.ok(!judge(q, [toIp(r.net), toIp(r.net + r.size - 1), unused]), 'ネットワーク/ブロードキャストを両端にするのは不正解');
      assert.ok(q.fields[2].format === 'number' && !q.compare);
      break;
    }
    case 'vlsm-free':
    case 'vlsm-total-free': {
      const all = q.type === 'vlsm-free' ? m.regions : [...m.regions, ...Array.from({ length: m.links }, () => ({ hosts: 2 }))];
      const { occ, end } = naiveDescending(parent, all);
      const free = naiveFree(end, parent.net + sizeOfP(parent.p));
      assert.ok(same(sortedAccepts(q), free.map((f) => cidrStr(f.net, f.p)).sort()));
      assert.ok(free.length >= 2 && free.length <= (q.type === 'vlsm-free' ? 4 : 6), `未使用ブロックの個数 ${free.length}`);
      assert.ok(q.text.includes(`(${free.length} 個)`), '個数を本文に書く');
      // 空きブロックの全アドレスが占有表の空きと一致し、隣どうしが結合できない(最少個数)
      const occ2 = occupancy(parent); occ2.used.set(occ.used);
      for (const f of free) { assert.ok(isFree(occ2, f.net, f.size)); markAll(occ2, f.net, f.size); }
      assert.ok(occ2.used.every((u) => u === 1), '空きを使い切る');
      for (let k = 1; k < free.length; k++) assert.ok(free[k].size !== free[k - 1].size || (free[k - 1].net / free[k - 1].size) % 2 === 1, '結合できる隣はない');
      if (q.type === 'vlsm-total-free') { marks.free++; assert.ok(m.links >= 1 && m.links <= 3 && m.regions.length >= 4 && m.regions.length <= 6); }
      break;
    }
    case 'vlsm-fit': {
      const total = m.regions.reduce((s, r) => s + naiveBlock(r.hosts), 0);
      const S = sizeOfP(parent.p);
      const fits = total <= S;
      let minSize = 1; while (minSize < total) minSize *= 2;
      const [yn, shortage, minP] = q.fields.map((f) => f.accept[0]);
      assert.strictEqual(yn, fits ? 'yes' : 'no');
      assert.strictEqual(Number(shortage), fits ? 0 : total - S);
      assert.strictEqual(Number(minP), pOfSize(minSize));
      if (fits) naiveDescending(parent, m.regions); // 実際に置けることを列挙で確認
      else assert.throws(() => naiveDescending(parent, m.regions), '収まらないなら素朴な配置も失敗する');
      // 最小の親に置けば必ず収まる
      naiveDescending({ net: 0, p: pOfSize(minSize) }, m.regions);
      assert.ok(judge(q, ['○', String(shortage), `/${minP}`]) === fits || judge(q, ['×', String(shortage), `/${minP}`]) === !fits);
      if (fits) marks.fit++; else marks.noFit++;
      assert.ok(m.regions.length >= 4 && m.regions.length <= 6);
      break;
    }
    case 'vlsm-inorder': {
      const occ = occupancy(parent);
      let cursor = parent.net, skipped = 0; const placed = [];
      for (const r of m.regions) {
        const size = naiveBlock(r.hosts);
        const net = scanFirstFit(occ, size, cursor);
        assert.notStrictEqual(net, null);
        skipped += net - cursor; markAll(occ, net, size); placed.push(cidrStr(net, pOfSize(size))); cursor = net + size;
      }
      assert.ok(skipped > 0, '無駄が出る順');
      assert.deepStrictEqual(q.fields.map((f) => f.accept[0]), [...placed, String(skipped)]);
      assert.ok(!q.compare, 'ordered');
      // ありがちな間違い: 大きい順に置いた配置(無駄 0)
      const { sized } = naiveDescending(parent, m.regions);
      assert.ok(!judge(q, [...sized.map((r) => cidrStr(r.net, r.p)), '0']), '大きい順の配置は不正解');
      assert.ok(m.regions.length >= 3 && m.regions.length <= 4 && parent.p >= 21 && parent.p <= 23);
      break;
    }
    case 'vlsm-summary': {
      const { sized } = naiveDescending(parent, m.regions);
      const a = sized.find((r) => r.idx === m.pair[0]), b = sized.find((r) => r.idx === m.pair[1]);
      const s = naiveSummary(a.net, a.p, b.net, b.p);
      const sSize = sizeOfP(s.p);
      assert.strictEqual(q.fields[0].accept[0], cidrStr(s.net, s.p));
      // 全アドレスを列挙して包含を数える
      let engulfed = 0;
      for (const r of sized) {
        if (r === a || r === b) continue;
        let inside = 0; for (let x = r.net; x < r.net + r.size; x++) if (inRange(s.net, sSize, x)) inside++;
        assert.ok(inside === 0 || inside === r.size, '区画は集約に全部入るか全部外か');
        if (inside) engulfed++;
      }
      assert.strictEqual(Number(q.fields[1].accept[0]), engulfed);
      // 1 ビット長い(両方を含まない)と 1 ビット短い集約は不正解
      assert.ok(!judge(q, [cidrStr(s.net, s.p + 1), String(engulfed)]));
      assert.ok(!judge(q, [cidrStr(s.net - (s.net % sizeOfP(s.p - 1)), s.p - 1), String(engulfed)]));
      // 2 区画自身が集約に入る
      for (const r of [a, b]) for (let x = r.net; x < r.net + r.size; x += r.size - 1) assert.ok(inRange(s.net, sSize, x));
      if (engulfed === 0) marks.engulf0++; else marks.engulfSome++;
      assert.ok(q.table.rows.length === m.regions.length && q.table.headers.length === 3);
      break;
    }
    case 'vlsm-add': {
      const occ = occupancy(parent);
      for (const e of m.existing) markAll(occ, e.net, sizeOfP(e.p));
      const answers = [];
      let trap = false;
      for (const r of m.requests) {
        const size = naiveBlock(r.hosts);
        // 素朴な読み: 最初の空きの先頭を整列させた位置
        let first = parent.net; while (first < occ.net + occ.size && occ.used[first - occ.net]) first++;
        const naive = Math.ceil(first / size) * size;
        const net = scanFirstFit(occ, size);
        assert.notStrictEqual(net, null, '置ける');
        if (naive !== net) trap = true;
        markAll(occ, net, size); answers.push(cidrStr(net, pOfSize(size)));
      }
      assert.deepStrictEqual(q.fields.map((f) => f.accept[0]), answers);
      assert.ok(trap, '少なくとも 1 件は最初の空きに素朴に置くと間違う');
      marks.trap++;
      if (m.requests.length === 2) marks.twoNew++;
      // 既存は非連続(隙間がある)
      const ex = m.existing.slice().sort((a, b) => a.net - b.net);
      assert.ok(ex.some((e, k) => k > 0 && ex[k - 1].net + sizeOfP(ex[k - 1].p) < e.net) || ex[0].net > parent.net, '既存の間に隙間');
      assert.ok(m.existing.length >= 2 && m.existing.length <= 3 && m.requests.length >= 1 && m.requests.length <= 2);
      break;
    }
    case 'vlsm-total-plan': {
      const all = [...m.regions, ...Array.from({ length: m.links }, () => ({ hosts: 2, link: true }))];
      const { sized } = naiveDescending(parent, all);
      assert.ok(same(sortedAccepts(q), sized.map((r) => cidrStr(r.net, r.p)).sort()));
      assert.strictEqual(sized.filter((r) => r.link).length, m.links);
      for (const r of sized) if (r.link) assert.strictEqual(r.p, 30, 'リンクは /30');
      assert.ok(sized.slice(-m.links).every((r) => r.link), 'リンクは最後に並ぶ');
      assert.ok(q.fields.length === m.regions.length + m.links && q.fields.length <= 6);
      // /31 をリンクに使うのは不正解
      const wrong = sized.map((r) => (r.link ? cidrStr(r.net, 31) : cidrStr(r.net, r.p)));
      assert.ok(!judge(q, wrong));
      marks.plan++;
      break;
    }
    default: assert.fail('未知の type ' + q.type);
  }
  n++;
}
assert.deepStrictEqual([...seenTypes].sort(), ['vlsm-add', 'vlsm-cidr3', 'vlsm-cidr4', 'vlsm-fit', 'vlsm-free', 'vlsm-inorder', 'vlsm-prefix', 'vlsm-range', 'vlsm-summary', 'vlsm-total-free', 'vlsm-total-plan'], '全種類が出る');
for (let lv = RANGE[0]; lv <= RANGE[1]; lv++) assert.ok(perLevel[lv] >= 1000, `Lv${lv} は 1,000 件以上: ${perLevel[lv]}`);
assert.ok(marks.tie >= 300 && marks.noTie >= 300, `Lv23 同サイズあり/なしが両方出る ${marks.tie}/${marks.noTie}`);
assert.ok(marks.fit >= 300 && marks.noFit >= 300, `Lv26 収まる/収まらないが両方出る ${marks.fit}/${marks.noFit}`);
assert.ok(marks.engulf0 >= 200 && marks.engulfSome >= 200, `Lv28 巻き込み 0/あり が両方出る ${marks.engulf0}/${marks.engulfSome}`);
assert.strictEqual(marks.trap, perLevel[29], 'Lv29 は全件に罠がある');
assert.ok(marks.twoNew >= 200, 'Lv29 新規 2 件も出る');
assert.ok(marks.plan >= 300 && marks.free >= 300, `Lv30 配置/未使用が両方出る ${marks.plan}/${marks.free}`);

// 同じ seed なら同じ問題、違う seed なら(ほぼ)違う問題
{
  const a = make(23, NODES[1], makeRng(42)), b = make(23, NODES[1], makeRng(42)), c = make(23, NODES[1], makeRng(43));
  assert.deepStrictEqual(a, b, '同じ seed で再現できる');
  assert.notDeepStrictEqual(a.fields.map((f) => f.accept), c.fields.map((f) => f.accept));
}

// ---------- 設計書(design-11-50.md 第 2.4 節)の例題を同じ値で作る ----------
const P = (s) => { const [a, p] = s.split('/'); return { net: parseIp(a), p: Number(p), size: sizeOfP(Number(p)) }; };
const R = (...pairs) => pairs.map(([name, hosts]) => ({ name, hosts }));
const accepts = (q) => q.fields.map((f) => f.accept[0]);
// Lv21 例題 1・2
assert.deepStrictEqual(accepts(build(21, { parent: P('192.168.8.0/22'), regions: R(['営業', 120], ['開発', 60], ['サーバー', 25]) })), ['25', '26', '27']);
assert.deepStrictEqual(accepts(build(21, { parent: P('10.3.0.0/16'), regions: R(['A', 500], ['B', 200], ['C', 1000]) })), ['22', '23', '24']);
// Lv22 例題 1・2
assert.deepStrictEqual(accepts(build(22, { parent: P('172.16.40.0/22'), regions: R(['A', 200], ['B', 50], ['C', 20]) })), ['172.16.40.0/24', '172.16.41.0/26', '172.16.41.64/27']);
assert.deepStrictEqual(accepts(build(22, { parent: P('10.9.0.0/20'), regions: R(['A', 1500], ['B', 300], ['C', 100]) })), ['10.9.0.0/21', '10.9.8.0/23', '10.9.10.0/25']);
// Lv23 例題 1・2
const ex23 = { parent: P('192.168.64.0/23'), regions: R(['本社', 100], ['支店', 100], ['工場', 40], ['管理', 10]) };
assert.deepStrictEqual(accepts(build(23, ex23)), ['192.168.64.0/25', '192.168.64.128/25', '192.168.65.0/26', '192.168.65.64/28']);
const ex23b = { parent: P('10.120.0.0/19'), regions: R(['A', 2000], ['B', 900], ['C', 400], ['D', 60]) };
assert.deepStrictEqual(accepts(build(23, ex23b)), ['10.120.0.0/21', '10.120.8.0/22', '10.120.12.0/23', '10.120.14.0/26']);
// Lv24 例題 1・2
const ex24 = { parent: P('172.16.0.0/22'), regions: R(['A', 300], ['B', 120], ['C', 50], ['D', 20], ['E', 6]), k: 3 };
assert.deepStrictEqual(accepts(build(24, ex24)), ['172.16.2.129', '172.16.2.190', '280']);
assert.deepStrictEqual(accepts(build(24, { parent: P('10.44.16.0/21'), regions: R(['A', 600], ['B', 250], ['C', 100], ['D', 30]), k: 2 })), ['10.44.20.1', '10.44.20.254', '608']);
// Lv25 例題 1・2
assert.deepStrictEqual(accepts(build(25, { parent: ex24.parent, regions: ex24.regions })), ['172.16.2.232/29', '172.16.2.240/28', '172.16.3.0/24']);
assert.deepStrictEqual(accepts(build(25, { parent: P('192.168.200.0/24'), regions: R(['A', 60], ['B', 25], ['C', 10]) })), ['192.168.200.112/28', '192.168.200.128/25']);
// Lv26 例題 1・2
assert.deepStrictEqual(accepts(build(26, { parent: P('10.0.0.0/22'), regions: R(['A', 500], ['B', 500], ['C', 200], ['D', 100], ['E', 30]) })), ['no', '416', '21']);
assert.deepStrictEqual(accepts(build(26, { parent: P('10.0.0.0/21'), regions: R(['A', 1000], ['B', 400], ['C', 400], ['D', 120], ['E', 60], ['F', 10]) })), ['no', '208', '20']);
// Lv27 例題 1・2
assert.deepStrictEqual(accepts(build(27, { parent: P('10.70.0.0/22'), regions: R(['総務', 20], ['開発', 200], ['来客', 50]) })), ['10.70.0.0/27', '10.70.1.0/24', '10.70.2.0/26', '224']);
assert.deepStrictEqual(accepts(build(27, { parent: P('192.168.16.0/23'), regions: R(['受付', 10], ['倉庫', 30], ['営業', 100], ['開発', 250]) })), ['192.168.16.0/28', '192.168.16.32/27', '192.168.16.128/25', '192.168.17.0/24', '80']);
// Lv28 例題 1(本社と支店: 添字 0, 1)・例題 2(B と C: 添字 1, 2)
assert.deepStrictEqual(accepts(build(28, { ...ex23, pair: [0, 1] })), ['192.168.64.0/24', '0']);
assert.deepStrictEqual(accepts(build(28, { ...ex23b, pair: [1, 2] })), ['10.120.8.0/21', '1']);
// Lv29 例題 1・2
assert.deepStrictEqual(accepts(build(29, { parent: P('172.16.8.0/22'), existing: [{ name: 'A', net: parseIp('172.16.8.0'), p: 24 }, { name: 'B', net: parseIp('172.16.9.128'), p: 25 }, { name: 'C', net: parseIp('172.16.10.0'), p: 26 }], requests: R(['新規 A', 100]) })), ['172.16.9.0/25']);
assert.deepStrictEqual(accepts(build(29, { parent: P('10.200.0.0/16'), existing: [{ name: 'A', net: parseIp('10.200.0.0'), p: 17 }, { name: 'B', net: parseIp('10.200.128.0'), p: 19 }, { name: 'C', net: parseIp('10.200.176.0'), p: 20 }], requests: R(['新規 A', 5000], ['新規 B', 1000]) })), ['10.200.192.0/19', '10.200.160.0/22']);
// Lv30 例題 1(配置と未使用の両方)・例題 2
const ex30 = { parent: P('10.30.0.0/21'), regions: R(['本社 LAN', 500], ['支店 LAN', 200], ['無線', 100], ['サーバー', 60], ['来客', 30], ['管理', 20]), links: 2 };
assert.deepStrictEqual(accepts(build(30, { ...ex30, form: 'plan' })), ['10.30.0.0/23', '10.30.2.0/24', '10.30.3.0/25', '10.30.3.128/26', '10.30.3.192/27', '10.30.3.224/27', '10.30.4.0/30', '10.30.4.4/30']);
assert.deepStrictEqual(accepts(build(30, { ...ex30, form: 'free' })), ['10.30.4.8/29', '10.30.4.16/28', '10.30.4.32/27', '10.30.4.64/26', '10.30.4.128/25', '10.30.5.0/24', '10.30.6.0/23']);
const ex30b = { parent: P('192.168.40.0/23'), regions: R(['開発', 120], ['営業', 60], ['総務', 25], ['サーバー', 12]), links: 1 };
assert.deepStrictEqual(accepts(build(30, { ...ex30b, form: 'plan' })), ['192.168.40.0/25', '192.168.40.128/26', '192.168.40.192/27', '192.168.40.224/28', '192.168.40.240/30']);
assert.deepStrictEqual(accepts(build(30, { ...ex30b, form: 'free' })), ['192.168.40.244/30', '192.168.40.248/29', '192.168.41.0/24']);

console.log('vlsm ok:', n, 'questions,', seenTypes.size, 'types,', Object.entries(perLevel).map(([lv, c]) => `Lv${lv}=${c}`).join(' '), JSON.stringify(marks));
