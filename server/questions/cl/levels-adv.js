'use strict';
// 上級(新しい番号 253〜319。docs/LEVEL-LIST.md 第 5 章)の問題。担当: 上級(Claude Opus 5.5、2026-10-22)。書き方は docs/questions/CL.md
// 作るのは一覧の「担当」が O の行のうち、構成図・設定・模擬ターミナルでないもの(仕組みがまだ無い 270・286・309・313 は作らない)。
// 上級はヒントなし(解説 explanation だけ)。表(FactBank)は server/questions/data/cl/adv/、テストは test/cl-adv.js。
// 生成のレベル(作り方「生」)は verify で、生成と別の方法(2 進の文字列・BigInt・URL の解決・角の点の総当たり など)で解き直す。
// meta は確かめ用の値(画面には送らない。world.js が送る項目を選ぶ)
const { loadFacts } = require('./build');

// ================= 共通の道具 =================
const F = (file) => loadFacts(`adv/${file}`);
const stmtRows = (rows, topic = null) => rows.filter((r) => typeof r.attrs.true === 'boolean' && (!topic || r.attrs.topic === topic));
const wa = (name) => (/[A-Za-z0-9)]$/.test(name) ? `${name} は、` : `${name}は、`); // 「SOA は、」「エッジポートは、」
const groupRows = (rows, group) => rows.filter((r) => r.attrs.group === group);
const numField = (name, label, value, hint, extra = {}) => ({ name, label, format: 'number', hint, accept: [String(value)], ...extra });
const textQ = (fields) => ({ answerKind: 'text', fields });

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
// 説明 → 名前(reverse なら 名前 → 説明)。同じ group の行から選ぶ。only で正解にする行を絞る
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
// 表のレベルの確かめ(生成と別に、表の行から正解が 1 つだけかを数え直す)
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
// 表のレベルを作る: types は (rng) → 問題 の配列。kindName は型の名前
function tableLevel(title, rows, kindName, types, extraVerify = null) {
  return {
    title, kind: '表', minDistinct: 20,
    make(rng) { const q = rng.pick(types)(rng); return { ...q, kind: kindName }; },
    verify(q) { verifyFacts(q, rows); if (extraVerify) extraVerify(q); },
  };
}

// ---------- IPv4 の道具(生成用は数、確かめ用は 2 進の文字列) ----------
const ip2n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const n2ip = (n) => [24, 16, 8, 0].map((b) => Math.floor(n / 2 ** b) % 256).join('.');
const blockSize = (len) => 2 ** (32 - len);
const netOf = (n, len) => n - (n % blockSize(len));
const inNet = (n, net, len) => netOf(n, len) === net;
const lenToMask = (len) => n2ip(2 ** 32 - blockSize(len));
const cidr = (net, len) => `${n2ip(net)}/${len}`;
const bin32 = (s) => s.split('.').map((x) => Number(x).toString(2).padStart(8, '0')).join('');
const binToIp = (b) => [0, 8, 16, 24].map((i) => parseInt(b.slice(i, i + 8), 2)).join('.');
const binIn = (ip, c) => { if (c === 'any') return true; const [a, l] = c.split('/'); return bin32(ip).slice(0, Number(l)) === bin32(a).slice(0, Number(l)); };

// ================= 表のレベル =================
const LAG = F('lag.json');
const LAG_MODE = LAG.filter((r) => r.attrs.kind === 'mode');
const EDGE = F('stp-edge.json');
const ASX = F('bgp-as.json');
const DNSR = F('dns-records.json');
const COOKIE = F('http-cookie.json');
const TLS = F('tls.json');
const CERT = F('cert-check.json');
const MAILF = F('mail-flow.json');
const MAILA = F('mail-auth.json');
const ACLP = F('acl-place.json');
const SFW = F('stateful-fw.json');
const L2S = F('l2-security.json');
const DSCP = F('qos-dscp.json');
const QUE = F('queuing.json');
const WAN = F('wan.json');
const CLINK = F('cloud-connect.json');
const LB = F('lb.json');
const ZT = F('zero-trust.json');

// Lv279 の「確かめる / 確かめない」の 4 択
function certItemQ(rng) {
  const items = CERT.filter((r) => r.attrs.kind === 'item');
  const wantCheck = rng.next() < 0.5;
  const ans = rng.pick(items.filter((r) => r.attrs.check === wantCheck));
  const others = rng.shuffle(items.filter((r) => r.attrs.check !== wantCheck)).slice(0, 3);
  const picked = rng.shuffle([ans, ...others]);
  return {
    text: `ブラウザが HTTPS のサーバーの証明書を確かめるとき、${wantCheck ? '確かめるもの' : '確かめないもの'}はどれか。`,
    options: picked.map((r) => r.ja), answerIndex: picked.indexOf(ans),
    explanation: [`正解は「${ans.ja}」。${ans.attrs.why}`, ...others.map((r) => `「${r.ja}」は${r.attrs.check ? '確かめる' : '確かめない'}。${r.attrs.why}`)].join('\n')
      + '\nブラウザが確かめるのは、有効期間・名前(SAN)が開いたホスト名と合うか・信頼する認証局までたどれるか・署名が正しいか。',
    meta: { type: 'certItem', wantCheck, ids: picked.map((r) => r.id) },
  };
}
function verifyCertItem(q) {
  if (q.meta.type !== 'certItem') return;
  const hits = q.options.map((o) => CERT.find((r) => r.ja === o).attrs.check === q.meta.wantCheck);
  if (hits.filter(Boolean).length !== 1 || !hits[q.answerIndex]) throw new Error('Lv279: 正解が 1 つに決まらない');
}

// Lv280 メールの流れ(並べ替えを 4 択で)
const KANA = ['ア', 'イ', 'ウ', 'エ'];
function mailFlowQ(rng) {
  const steps = MAILF.slice().sort((a, b) => a.attrs.order - b.attrs.order);
  const idx = rng.shuffle([0, 1, 2, 3, 4, 5]).slice(0, 4).sort((a, b) => a - b); // 起きる順の 4 つ
  const shown = rng.shuffle(idx); // 記号を付ける並び
  const label = new Map(shown.map((s, i) => [s, KANA[i]]));
  const correct = idx.map((s) => label.get(s)).join(' → ');
  const set = new Set([correct]);
  const perms = [];
  const permute = (arr, cur = []) => { if (!arr.length) { perms.push(cur); return; } arr.forEach((x, i) => permute(arr.filter((_, j) => j !== i), cur.concat(x))); };
  permute(KANA);
  // 近い誤り(となりを入れ替えたもの)を先に、足りなければほかの並び
  const corrArr = correct.split(' → ');
  const near = [0, 1, 2].map((i) => { const a = corrArr.slice(); [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a.join(' → '); });
  for (const s of rng.shuffle(near)) { if (set.size >= 3) break; set.add(s); }
  for (const p of rng.shuffle(perms)) { if (set.size >= 4) break; set.add(p.join(' → ')); }
  const options = rng.shuffle([...set]);
  return {
    text: 'メールが送信者から受信者に届くまでの次の出来事を、起きる順に並べたものはどれか。',
    table: { headers: ['記号', '出来事'], rows: shown.map((s, i) => [KANA[i], steps[s].ja]) },
    options, answerIndex: options.indexOf(correct),
    explanation: `正解は ${correct}。\n` + idx.map((s, i) => `${i + 1}. ${label.get(s)}: ${steps[s].ja}`).join('\n')
      + '\nメールソフトが送信サーバーに渡し(SMTP の 587 番など)、送信サーバーが宛先のドメインの MX を DNS で引いて、その受信サーバーへ SMTP(25 番)で送る。受信サーバーがメールボックスに入れ、受信者は IMAP か POP3 で取り出す。',
    meta: { type: 'order', idx, shown },
  };
}
function verifyMailFlow(q) {
  const order = new Map(MAILF.map((r) => [r.ja, r.attrs.order]));
  const rows = q.table.rows.slice().sort((a, b) => order.get(a[1]) - order.get(b[1]));
  const want = rows.map((r) => r[0]).join(' → ');
  if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error('Lv280: 並びの正解が合わない');
}

// Lv284 拡張 ACL の置き場所
function aclPlaceQ(rng) {
  const places = ACLP.filter((r) => r.attrs.kind === 'place');
  const ans = places.find((r) => r.attrs.ext);
  const options = rng.shuffle(places.map((r) => r.ja));
  return {
    text: '拡張 ACL(送信元・宛先・ポートを指定できる ACL)を置く場所として、基本とされるのはどこか。',
    options, answerIndex: options.indexOf(ans.ja),
    explanation: '正解は「送信元の近く」。拡張 ACL は宛先やポートまで細かく選べるので、送信元の近くで捨ててもほかの通信を巻き込まず、捨てる通信を遠くまで運ばずに済む。宛先の近くに置くのは、送信元しか見ない標準 ACL。真ん中や線の多いルーターという決まりは無い。',
    meta: { type: 'place' },
  };
}
// Lv293 DSCP
const PHB = DSCP.filter((r) => r.attrs.kind === 'phb');
const phbLabel = (r) => `${r.ja}(${r.attrs.value})`;
const dscpValueOf = (name) => { // 名前から値を式で出す(確かめ用。表を使わない)
  let m = /^AF(\d)(\d)$/.exec(name); if (m) return 8 * Number(m[1]) + 2 * Number(m[2]);
  m = /^CS(\d)/.exec(name); if (m) return 8 * Number(m[1]);
  if (name === 'EF') return 46; return null;
};
function dscpQ(rng) {
  const t = rng.pick(['use', 'use', 'name2val', 'val2name', 'drop']);
  if (t === 'use') {
    const use = rng.pick(['voice', 'netctl']);
    const ans = PHB.find((r) => r.attrs.use === use);
    const others = rng.shuffle(PHB.filter((r) => r !== ans && r.id !== 'd-cs7' && !(use === 'netctl' && r.id === 'd-ef'))).slice(0, 3);
    const picked = rng.shuffle([ans, ...others]);
    return {
      text: use === 'voice' ? '音声(電話)の通信によく付ける DSCP の印はどれか。' : '経路の手順など、ネットワークの制御の通信によく付ける DSCP の印はどれか。',
      options: picked.map(phbLabel), answerIndex: picked.indexOf(ans),
      explanation: use === 'voice'
        ? '正解は EF(46)。EF は待たせずに送る扱い(遅れと揺らぎを小さくする)のための印で、音声によく使う。AF4x はテレビ会議、CS5 は呼の制御、CS6 はネットワークの制御、CS0 は既定(特別扱いなし)によく使う。'
        : '正解は CS6(48)。ネットワークの制御(経路の手順など)には CS6 をよく使う。EF(46)は音声、CS5 は呼の制御、AF の印はデータのなかま分け、CS0 は既定。',
      meta: { type: 'dscpUse', use },
    };
  }
  if (t === 'name2val' || t === 'val2name') {
    const ans = rng.pick(PHB);
    const others = rng.shuffle(PHB.filter((r) => r !== ans)).slice(0, 3);
    const picked = rng.shuffle([ans, ...others]);
    const how = ans.attrs.cls ? `AF${ans.attrs.cls}${ans.attrs.drop} は 8 × ${ans.attrs.cls} + 2 × ${ans.attrs.drop} = ${ans.attrs.value}` : ans.id === 'd-ef' ? 'EF は 46(2 進 101110)' : `${ans.ja} は 8 × ${ans.attrs.cs} = ${ans.attrs.value}`;
    const expl = `正解は ${ans.ja} = ${ans.attrs.value}。${how}。AFxy の値は 8x + 2y、CSn の値は 8n、EF は 46。`;
    return t === 'name2val'
      ? { text: `DSCP の印 ${ans.ja} の値(10 進)はどれか。`, options: picked.map((r) => String(r.attrs.value)), answerIndex: picked.indexOf(ans), explanation: expl, meta: { type: 'dscpVal', name: ans.ja } }
      : { text: `DSCP の値 ${ans.attrs.value}(10 進)に当たる印はどれか。`, options: picked.map((r) => r.ja), answerIndex: picked.indexOf(ans), explanation: expl, meta: { type: 'dscpName', value: ans.attrs.value } };
  }
  const x = rng.rand(1, 4); const first = rng.next() < 0.5; // first: 先に捨てられやすい方
  const cls = PHB.filter((r) => r.attrs.cls === x);
  const ans = cls.find((r) => r.attrs.drop === (first ? 3 : 1));
  const options = rng.shuffle(cls.map((r) => r.ja));
  return {
    text: `同じ AF${x} のなかまの印のうち、混んで捨てるときに${first ? 'いちばん先に捨てられやすい' : 'いちばん捨てられにくい'}のはどれか。`,
    options, answerIndex: options.indexOf(ans.ja),
    explanation: `正解は ${ans.ja}。AFxy の y は捨てやすさで、1 がいちばん捨てにくく、3 がいちばん捨てやすい。x は列(クラス)の番号。`,
    meta: { type: 'dscpDrop', cls: x, first },
  };
}
function verifyDscp(q) {
  const m = q.meta;
  if (m.type === 'dscpVal') { if (Number(q.options[q.answerIndex]) !== dscpValueOf(m.name)) throw new Error('Lv293: 値が式と合わない'); }
  if (m.type === 'dscpName') { const hits = q.options.map((o) => dscpValueOf(o) === m.value); if (hits.filter(Boolean).length !== 1 || !hits[q.answerIndex]) throw new Error('Lv293: 名前が式と合わない'); }
  if (m.type === 'dscpUse') { const want = m.use === 'voice' ? 'EF(46)' : 'CS6(48)'; if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error('Lv293: 使いみちの答えが違う'); }
  if (m.type === 'dscpDrop') { const want = `AF${m.cls}${m.first ? 3 : 1}`; if (q.options[q.answerIndex] !== want) throw new Error('Lv293: 捨てやすさの答えが違う'); }
}

// ================= 生成のレベルの道具 =================
// ---------- Lv254 LACP の両端の設定 ----------
const MODE_LABEL = { active: 'active', passive: 'passive', off: 'なし' };
function lacpQ(rng) {
  const n = rng.rand(3, 4);
  const odd = rng.next() < 0.5;
  const ok = LAG_MODE.filter((r) => r.attrs.bundle), ng = LAG_MODE.filter((r) => !r.attrs.bundle);
  const bad = rng.rand(0, n - 1);
  const links = Array.from({ length: n }, (_, i) => (odd ? (i === bad ? rng.pick(ng) : rng.pick(ok)) : rng.pick(LAG_MODE)));
  const p1 = rng.rand(1, 20), p2 = rng.rand(1, 20);
  const table = { headers: ['線', 'SW1 のポート', 'SW1 の設定', 'SW2 のポート', 'SW2 の設定'], rows: links.map((r, i) => [`線 ${i + 1}`, `Gi0/${p1 + i}`, MODE_LABEL[r.attrs.a], `Gi0/${p2 + i}`, MODE_LABEL[r.attrs.b]]) };
  const lines = links.map((r, i) => `線 ${i + 1}: ${r.ja} → ${r.attrs.bundle ? '束に入る' : '束に入らない'}。${r.attrs.why}`).join('\n');
  const intro = `SW1 と SW2 の間に ${n} 本の線があり、両端のポートの LACP の設定は次の表のとおり(「なし」は束の設定をしていないポート)。`;
  if (odd) {
    const options = links.map((_, i) => `線 ${i + 1}`);
    return { text: `${intro}このうち LACP の束に入らない線が 1 本ある。どれか。`, table, options, answerIndex: bad, explanation: `正解は線 ${bad + 1}。\n${lines}\nLACP は、少なくとも片方が active(自分から知らせを送る)で、両方が束の設定をしていれば束になる。`, meta: { type: 'odd' } };
  }
  const cnt = links.filter((r) => r.attrs.bundle).length;
  return { text: `${intro}LACP の束に入る線は何本か。`, table, ...textQ([numField('count', '本数', cnt, '例: 2')]), explanation: `正解は ${cnt} 本。\n${lines}\nLACP は、少なくとも片方が active(自分から知らせを送る)で、両方が束の設定をしていれば束になる。passive どうしは、どちらも相手を待つだけなので束にならない。`, meta: { type: 'count' } };
}
function verifyLacp(q) {
  const back = { active: 'active', passive: 'passive', なし: 'off' };
  const ok = q.table.rows.map((r) => { const a = back[r[2]], b = back[r[4]]; return a !== 'off' && b !== 'off' && (a === 'active' || b === 'active'); });
  if (q.meta.type === 'odd') { if (ok.filter((x) => !x).length !== 1 || ok[q.answerIndex]) throw new Error('Lv254: 束に入らない線が 1 本に決まらない'); }
  else if (q.fields[0].accept[0] !== String(ok.filter(Boolean).length)) throw new Error('Lv254: 本数が違う');
}

// ---------- Lv261 OSPF のコスト ----------
const BWS = [10, 100, 1000, 2500, 10000, 25000, 40000, 100000]; // Mbps
const REFS = [100, 1000, 10000, 100000];
const fmtBw = (m) => (m < 1000 ? `${m} Mbps` : `${m / 1000} Gbps`);
const parseBw = (s) => { const m = /^([\d.]+) (Mbps|Gbps)$/.exec(s.trim()); return m[2] === 'Gbps' ? Math.round(parseFloat(m[1]) * 1000) : Number(m[1]); };
const ospfCost = (ref, bw) => Math.max(1, Math.floor(ref / bw));
const PATH_NAMES = ['経路 A', '経路 B', '経路 C'];
function ospfCostQ(rng) {
  const ref = rng.pick(REFS);
  const np = rng.rand(2, 3);
  const paths = Array.from({ length: np }, () => Array.from({ length: rng.rand(1, 4) }, () => rng.pick(BWS)));
  const costs = paths.map((p) => p.map((bw) => ospfCost(ref, bw)));
  const totals = costs.map((c) => c.reduce((a, b) => a + b, 0));
  const best = Math.min(...totals);
  const lan = `10.${rng.rand(1, 250)}.${rng.rand(0, 255)}.0/24`;
  const clamp = paths.some((p) => p.some((bw) => bw > ref));
  const frac = paths.some((p) => p.some((bw) => bw <= ref && ref % bw !== 0));
  return {
    text: `R1 から LAN-X(${lan})への経路の候補は次の表のとおり。表の帯域は、R1 から順に、パケットが出ていく IF の帯域(宛先の LAN につながる IF も含む)。OSPF の基準の帯域は ${fmtBw(ref)}。IF のコストは「基準の帯域 ÷ IF の帯域」の小数を切り捨て、1 より小さいときは 1 とする。R1 が LAN-X へ使う経路のコスト(合計)はいくつか。`,
    table: { headers: ['経路', '出ていく IF の帯域(通る順)'], rows: paths.map((p, i) => [PATH_NAMES[i], p.map(fmtBw).join(' → ')]) },
    ...textQ([numField('cost', 'コスト', best, '例: 12')]),
    explanation: `正解は ${best}。\n` + paths.map((p, i) => `${PATH_NAMES[i]}: ${p.map((bw, j) => `${fmtBw(bw)} → ${costs[i][j]}`).join('、')}、合計 ${totals[i]}`).join('\n')
      + `\nOSPF は合計のコストがいちばん小さい経路を使う。${clamp ? '基準の帯域より速い IF は、割ると 1 より小さくなるので 1 になる(速さの違いがコストに出ない)。' : ''}${frac ? '割り切れないときは小数を切り捨てる。' : ''}`,
    meta: { clamp, frac, ref },
  };
}
function verifyOspfCost(q) {
  const ref = BigInt(parseBw(/基準の帯域は ([\d.]+ [MG]bps)/.exec(q.text)[1]));
  let best = null;
  for (const row of q.table.rows) {
    let sum = 0n;
    for (const s of row[1].split('→')) { let c = ref / BigInt(parseBw(s)); if (c < 1n) c = 1n; sum += c; }
    if (best === null || sum < best) best = sum;
  }
  if (q.fields[0].accept[0] !== String(best)) throw new Error(`Lv261: コストが違う ${q.fields[0].accept[0]} / ${best}`);
}

// ---------- Lv264 ABR で集約 ----------
const POOLS = [{ base: '10.0.0.0', len: 8 }, { base: '172.16.0.0', len: 12 }, { base: '192.168.0.0', len: 16 }];
function summaryQ(rng) {
  const pool = rng.pick(POOLS);
  const L = rng.rand(Math.max(16, pool.len), 26);
  const S = ip2n(pool.base) + rng.rand(0, 2 ** (L - pool.len) - 1) * blockSize(L);
  let nets;
  const full = rng.next() < 0.4;
  if (full) { const m = rng.rand(1, 3); nets = Array.from({ length: 2 ** m }, (_, i) => [S + i * blockSize(L + m), L + m]); }
  else {
    const chooseIn = (net, len, depth) => {
      if (len >= 28 || depth >= 3 || rng.next() < 0.35) return [[net, len]];
      const h = blockSize(len + 1); const r = rng.next();
      if (r < 0.3) return chooseIn(net, len + 1, depth + 1);
      if (r < 0.6) return chooseIn(net + h, len + 1, depth + 1);
      return chooseIn(net, len + 1, depth + 1).concat(chooseIn(net + h, len + 1, depth + 1));
    };
    nets = chooseIn(S, L + 1, 0).concat(chooseIn(S + blockSize(L + 1), L + 1, 0));
    while (nets.length > 8) nets.splice(rng.rand(1, nets.length - 2), 1); // 両端(下の半分と上の半分の網)は残す
  }
  const sum = cidr(S, L);
  const last = n2ip(S + blockSize(L) - 1);
  return {
    text: 'ABR(エリア 0 とエリア 1 の境目のルーター)が、エリア 1 の次の網を、エリア 0 へ 1 つの経路にまとめて知らせる。次の網を全部含む、いちばん小さい(プレフィックス長がいちばん長い)まとめの経路はどれか。ネットワークアドレス/プレフィックス長で答える。',
    table: { headers: ['エリア 1 の網'], rows: nets.map(([n, l]) => [cidr(n, l)]) },
    ...textQ([{ name: 'summary', label: 'まとめの経路', format: 'ipv4cidr', hint: '例: 10.0.0.0/16', accept: [sum] }]),
    explanation: `正解は ${sum}。\n網の先頭と最後のアドレスを 2 進で並べると、上から ${L} ビットまでが全部同じで、${L + 1} ビット目で分かれる(下の半分と上の半分の両方に網がある)。だからまとめは /${L} で、範囲は ${n2ip(S)}〜${last}。`
      + (full ? '表の網はこの範囲をちょうど埋めている。' : 'この範囲には表に無いアドレスも入る。それでも全部を含む 1 つの経路はこれより小さくできない。'),
    meta: { full, L },
  };
}
function verifySummary(q) {
  const bins = q.table.rows.map(([c]) => { const [a, l] = c.split('/'); const b = bin32(a); return { lo: b.slice(0, +l).padEnd(32, '0'), hi: b.slice(0, +l).padEnd(32, '1'), l: +l }; });
  for (let i = 0; i < bins.length; i++) for (let j = i + 1; j < bins.length; j++) {
    if (!(bins[i].hi < bins[j].lo || bins[j].hi < bins[i].lo)) throw new Error('Lv264: 網が重なっている');
  }
  const all = bins.flatMap((b) => [b.lo, b.hi]);
  let k = 0; while (k < 32 && all.every((s) => s[k] === all[0][k])) k++;
  const want = `${binToIp(all[0].slice(0, k).padEnd(32, '0'))}/${k}`;
  if (q.fields[0].accept[0] !== want) throw new Error(`Lv264: まとめが違う ${q.fields[0].accept[0]} / ${want}`);
}

// ---------- Lv272 DNS のキャッシュの残り ----------
const TTLS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 86400];
const HOSTS = ['shop', 'news', 'blog', 'portal', 'api', 'learn', 'store', 'docs'];
function dnsTtlQ(rng) {
  const host = `www.${rng.pick(HOSTS)}.example`;
  const t = rng.pick(['basic', 'cname', 'refetch']);
  let events, ask, ans, why;
  if (t === 'basic') {
    const T = rng.pick(TTLS); const e = rng.next() < 0.15 ? T - 1 : rng.rand(1, T - 1);
    events = [[0, `権威サーバーから ${host} の A(TTL ${T} 秒)を受け取り、キャッシュに入れた`], [e, `PC1 が ${host} の A を問い合わせた`]];
    ask = 'A'; ans = T - e; why = `時刻 0 に TTL ${T} 秒で入れたので、時刻 ${e} の残りは ${T} − ${e} = ${ans} 秒。キャッシュ DNS サーバーは残りの秒数を TTL にして返す。`;
  } else if (t === 'cname') {
    let T1 = rng.pick(TTLS), T2 = rng.pick(TTLS); while (T2 === T1) T2 = rng.pick(TTLS);
    const e = rng.rand(1, Math.min(T1, T2) - 1);
    const target = `${rng.pick(HOSTS)}-${rng.rand(1, 9)}.cdn.example`;
    events = [[0, `権威サーバーから ${host} の CNAME(別名の先は ${target}、TTL ${T1} 秒)と、${target} の A(TTL ${T2} 秒)を受け取り、キャッシュに入れた`], [e, `PC1 が ${host} の A を問い合わせた`]];
    ask = rng.pick(['A', 'CNAME']); ans = (ask === 'A' ? T2 : T1) - e;
    why = `CNAME と A はそれぞれ自分の TTL で数える。時刻 ${e} の残りは、CNAME が ${T1} − ${e} = ${T1 - e} 秒、A が ${T2} − ${e} = ${T2 - e} 秒。問われているのは ${ask} なので ${ans} 秒。`;
  } else {
    const T = rng.pick(TTLS.filter((x) => x <= 3600)); const e1 = T + rng.rand(1, T); const e2 = e1 + rng.rand(1, T - 1);
    events = [[0, `権威サーバーから ${host} の A(TTL ${T} 秒)を受け取り、キャッシュに入れた`], [e1, `PC2 が ${host} の A を問い合わせた`], [e2, `PC3 が ${host} の A を問い合わせた`]];
    ask = 'A'; ans = T - (e2 - e1);
    why = `時刻 0 に入れた A は時刻 ${T} で期限が切れる。時刻 ${e1} の PC2 の問い合わせのときは切れているので、権威サーバーに聞き直し、時刻 ${e1} に TTL ${T} 秒で入れ直す。時刻 ${e2} の残りは ${T} − (${e2} − ${e1}) = ${ans} 秒。時刻 0 から数えて ${T} − ${e2} とするのは誤り(期限が切れて聞き直したことを見落としている)。`;
  }
  return {
    text: `キャッシュ DNS サーバーで起きたことは次の表のとおり(時刻は秒)。権威サーバーの設定は途中で変わらず、キャッシュはほかの理由では消えない。最後の問い合わせに、キャッシュ DNS サーバーが返す ${ask} の TTL は何秒か。`,
    table: { headers: ['時刻(秒)', '出来事'], rows: events.map(([tm, s]) => [String(tm), s]) },
    ...textQ([numField('ttl', 'TTL(秒)', ans, '例: 120')]),
    explanation: `正解は ${ans} 秒。${why}`,
    meta: { type: t, ask },
  };
}
function verifyDnsTtl(q) { // 期限の時刻を持つキャッシュとして、出来事を順にたどる
  const ask = /返す (A|CNAME) の TTL/.exec(q.text)[1];
  const cache = {}; const orig = {}; let last = null;
  for (const [tm, s] of q.table.rows) {
    const now = Number(tm);
    if (s.includes('受け取り')) {
      const c = /CNAME\(.*?TTL (\d+) 秒\)/.exec(s); if (c) { orig.CNAME = +c[1]; cache.CNAME = now + +c[1]; }
      const a = /の A\(TTL (\d+) 秒\)/.exec(s); if (a) { orig.A = +a[1]; cache.A = now + +a[1]; }
    } else {
      for (const k of Object.keys(cache)) if (now >= cache[k]) cache[k] = now + orig[k]; // 切れていれば聞き直す
      last = cache[ask] - now;
    }
  }
  if (q.fields[0].accept[0] !== String(last)) throw new Error(`Lv272: TTL が違う ${q.fields[0].accept[0]} / ${last}`);
}

// ---------- Lv273・274 ポートフォワード ----------
const PF_SERVICES = [
  ['TCP', 443, 443], ['TCP', 80, 80], ['TCP', 8080, 80], ['TCP', 8443, 443], ['TCP', 2222, 22], ['TCP', 10022, 22],
  ['TCP', 25, 25], ['TCP', 587, 587], ['TCP', 993, 993], ['UDP', 51820, 51820], ['UDP', 1194, 1194], ['UDP', 5060, 5060], ['UDP', 443, 443], ['UDP', 10053, 53],
];
const INSIDE = ['192.168.1', '192.168.10', '10.0.0', '10.10.20', '172.16.5'];
function portForwardSetup(rng) {
  const e1 = `203.0.113.${rng.rand(2, 250)}`;
  let e2 = null; if (rng.next() < 0.5) { do { e2 = `203.0.113.${rng.rand(2, 250)}`; } while (e2 === e1); }
  const exts = e2 ? [e1, e2] : [e1];
  const inside = rng.pick(INSIDE);
  const usedHosts = new Set();
  const host = () => { let h; do { h = rng.rand(2, 250); } while (usedHosts.has(h)); usedHosts.add(h); return `${inside}.${h}`; };
  const rules = []; const keys = new Set();
  const add = (ext, svc, intAddr = host(), intPort = svc[2]) => { const k = `${ext}|${svc[1]}|${svc[0]}`; if (keys.has(k)) return false; keys.add(k); rules.push({ ext, proto: svc[0], extPort: svc[1], int: intAddr, intPort }); return true; };
  const tsvc = rng.pick(PF_SERVICES);
  const tExt = rng.pick(exts);
  add(tExt, tsvc);
  const target = rules[0];
  // 紛らわしい行: 同じポートで手順が違う / 同じポートと手順で外側のアドレスが違う
  const twin = PF_SERVICES.find((s) => s[1] === tsvc[1] && s[0] !== tsvc[0]);
  if (twin && rng.next() < 0.7) add(tExt, twin);
  else add(tExt, [tsvc[0] === 'TCP' ? 'UDP' : 'TCP', tsvc[1], tsvc[2]]);
  if (e2) add(tExt === e1 ? e2 : e1, tsvc);
  const n = rng.rand(4, 5);
  let guard = 0;
  while (rules.length < n && guard++ < 50) add(rng.pick(exts), rng.pick(PF_SERVICES));
  const client = `198.51.100.${rng.rand(2, 250)}`; const sport = rng.rand(49152, 65535);
  return {
    rules: rng.shuffle(rules), target, client, sport,
    table: { headers: ['外側のアドレス', '外のポート', '手順', '内のアドレス', '内のポート'], rows: [] },
    packet: `${target.proto} ${client}:${sport} → ${target.ext}:${target.extPort}`,
  };
}
function pfTable(s) { return { headers: s.table.headers, rows: s.rules.map((r) => [r.ext, String(r.extPort), r.proto, r.int, String(r.intPort)]) }; }
function pfFind(q) { // 確かめ用: 表と問題文のパケットから、合う行を探し直す
  const m = /(TCP|UDP) ([\d.]+):(\d+) → ([\d.]+):(\d+)/.exec(q.text);
  const hits = q.table.rows.filter((r) => r[0] === m[4] && r[1] === m[5] && r[2] === m[1]);
  if (hits.length !== 1) throw new Error('ポートフォワードの合う行が 1 つでない');
  return { row: hits[0], client: m[2], sport: m[3], ext: m[4], extPort: m[5] };
}
function portFwdQ(rng) {
  const s = portForwardSetup(rng); const t = s.target;
  const ans = `${t.int}:${t.intPort}`;
  const near = s.rules.filter((r) => r !== t && r.extPort === t.extPort);
  return {
    text: `ルーター R1 のポートフォワード(外から来た通信を内のサーバーへ送る、決まった変換)の設定は次の表のとおり。外から次のパケットが R1 に届いた。\n${s.packet}\nR1 が変換したあとの、このパケットの宛先(アドレス:ポート)は?`,
    table: pfTable(s),
    ...textQ([{ name: 'dst', label: '宛先(アドレス:ポート)', format: 'addrport', hint: '例: 192.168.1.10:80', accept: [ans] }]),
    explanation: `正解は ${ans}。宛先 ${t.ext}:${t.extPort}・${t.proto} の 3 つが合う行は「${t.ext} ${t.extPort} ${t.proto} → ${t.int} ${t.intPort}」だけ。宛先をその行の内のアドレスとポートに書き換える。送信元 ${s.client}:${s.sport} は変えない。`
      + (near.length ? `\n同じポート ${t.extPort} の行でも、${near.map((r) => (r.proto !== t.proto ? `手順が ${r.proto} の行` : `外側のアドレスが ${r.ext} の行`)).join('、')}には合わない。` : ''),
    meta: { near: near.length },
  };
}
function verifyPortFwd(q) { const f = pfFind(q); if (q.fields[0].accept[0] !== `${f.row[3]}:${f.row[4]}`) throw new Error('Lv273: 宛先が違う'); }
function portFwdReturnQ(rng) {
  const s = portForwardSetup(rng); const t = s.target;
  const ask = rng.next() < 0.65 ? 'src' : 'dst';
  const ans = ask === 'src' ? `${t.ext}:${t.extPort}` : `${s.client}:${s.sport}`;
  return {
    text: `ルーター R1 のポートフォワード(外から来た通信を内のサーバーへ送る、決まった変換)の設定は次の表のとおり。外から次のパケットが R1 に届き、内のサーバーへ送られた。\n${s.packet}\nサーバーがこのパケットに返事を返した。返事が R1 で変換されて外へ出るときの、${ask === 'src' ? '送信元' : '宛先'}(アドレス:ポート)は?`,
    table: pfTable(s),
    ...textQ([{ name: ask, label: `${ask === 'src' ? '送信元' : '宛先'}(アドレス:ポート)`, format: 'addrport', hint: '例: 203.0.113.1:443', accept: [ans] }]),
    explanation: `正解は ${ans}。行きは、宛先 ${t.ext}:${t.extPort} を ${t.int}:${t.intPort} に書き換えた。返事はその逆で、サーバーが送る「${t.int}:${t.intPort} → ${s.client}:${s.sport}」の送信元を ${t.ext}:${t.extPort} に戻して外へ出す。宛先 ${s.client}:${s.sport} は行きの送信元のままで、書き換えない。`
      + (ask === 'src' ? `内のアドレス ${t.int}:${t.intPort} のまま出ると、相手は自分が送った宛先からの返事だと分からない。` : `宛先を ${t.ext}:${t.extPort} と答えるのは、送信元と取り違えている。`),
    meta: { ask },
  };
}
function verifyPortFwdReturn(q) {
  const f = pfFind(q);
  const want = q.meta.ask === 'src' ? `${f.ext}:${f.extPort}` : `${f.client}:${f.sport}`;
  if (q.fields[0].accept[0] !== want) throw new Error('Lv274: 返りのアドレスが違う');
}

// ---------- Lv275 HTTP の転送 ----------
const SITES = [['shop.example', 'www.shop.example'], ['news.example', 'www.news.example'], ['portal.example', 'm.portal.example'], ['learn.example', 'www.learn.example']];
const PATHS = ['/', '/sale', '/sale/', '/top', '/ja/', '/ja/top', '/item/12', '/item/34', '/new', '/campaign', '/login', '/home', '/guide'];
const REDIRECTS = [301, 302, 307, 308];
function redirectQ(rng) {
  const site = rng.pick(SITES);
  const url = (u) => `${u.scheme}://${u.host}${u.path}`;
  const visited = new Set();
  let cur = { scheme: rng.pick(['http', 'https']), host: rng.pick(site), path: rng.pick(PATHS) };
  const start = url(cur); visited.add(start);
  const k = rng.rand(1, 3);
  const hops = [];
  for (let i = 0; i < k; i++) {
    let next = null, loc = null, kind = null;
    for (let tries = 0; tries < 30 && !next; tries++) {
      const opts = [];
      if (cur.scheme === 'http') opts.push('https');
      opts.push('host', 'path', 'path', 'abs');
      kind = rng.pick(opts);
      let n;
      if (kind === 'https') n = { ...cur, scheme: 'https' };
      else if (kind === 'host') n = { ...cur, host: site.find((h) => h !== cur.host) };
      else if (kind === 'path') n = { ...cur, path: rng.pick(PATHS) };
      else n = { scheme: 'https', host: rng.pick(site), path: rng.pick(PATHS) };
      if (visited.has(url(n))) continue;
      next = n; loc = kind === 'path' ? n.path : url(n);
    }
    if (!next) break;
    hops.push({ from: url(cur), status: rng.pick(REDIRECTS), loc, kind, to: url(next) });
    visited.add(url(next)); cur = next;
  }
  const final = url(cur);
  const rows = hops.map((h) => [h.from, String(h.status), h.loc]);
  rows.push([final, '200', '—']);
  // 紛らわしい行: たどり着かない URL(転送するもの・200 を返すもの)
  const extra = [];
  for (let tries = 0; tries < 40 && extra.length < 2; tries++) {
    const u = url({ scheme: rng.pick(['http', 'https']), host: rng.pick(site), path: rng.pick(PATHS) });
    if (visited.has(u) || extra.some((e) => e[0] === u)) continue;
    if (rng.next() < 0.5) extra.push([u, '200', '—']); else extra.push([u, String(rng.pick(REDIRECTS)), final]);
  }
  rows.push(...extra);
  const lastHop = hops[hops.length - 1];
  const cands = rows.map((r) => r[0]).filter((u) => u !== final);
  if (lastHop && lastHop.kind === 'path') { // パスだけの Location を、別のホストで読んでしまう誤り
    const other = site.find((h) => h !== cur.host); const wrong = `${cur.scheme}://${other}${cur.path}`;
    if (!cands.includes(wrong)) cands.push(wrong);
  }
  const options = rng.shuffle([final, ...rng.shuffle(cands).slice(0, 3)]);
  return {
    text: `ブラウザで ${start} を開いた。サーバーの応答は次の表のとおり(リクエストの URL ごとの応答)。ブラウザが転送をたどって最後に表示する(200 が返る)ページの URL はどれか。`,
    table: { headers: ['リクエストの URL', '状態', 'Location'], rows: rng.shuffle(rows) },
    options, answerIndex: options.indexOf(final),
    explanation: `正解は ${final}。\n` + hops.map((h) => `${h.from} → ${h.status}、Location: ${h.loc}${h.kind === 'path' ? '(/ で始まるので、今のスキームとホストのまま、パスだけを置き換える)' : ''} → ${h.to}`).join('\n')
      + `\n${final} は 200 を返すので、ここで止まる。301・302・307・308 はどれも Location の URL へ転送する(違いは、恒久か一時か、メソッドを変えてよいか)。表のほかの行には、この道筋ではたどり着かない。`,
    meta: { k: hops.length, pathHop: hops.some((h) => h.kind === 'path') },
  };
}
function verifyRedirect(q) { // URL の解決は WHATWG の URL に任せて、たどり直す
  const map = new Map(q.table.rows.map((r) => [new URL(r[0]).href, r]));
  let cur = new URL(/ブラウザで (\S+) を開いた/.exec(q.text)[1]).href;
  for (let i = 0; i < 10; i++) {
    const r = map.get(cur); if (!r) throw new Error(`Lv275: 表に無い URL ${cur}`);
    if (r[1] === '200') break;
    cur = new URL(r[2], cur).href;
  }
  if (new URL(q.options[q.answerIndex]).href !== cur) throw new Error(`Lv275: 最後の URL が違う ${cur}`);
  if (q.options.filter((o) => new URL(o).href === cur).length !== 1) throw new Error('Lv275: 正解と同じ URL が 2 つある');
}

// ---------- Lv277 HTTP のキャッシュの期限 ----------
const MAXAGES = [60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200, 86400];
function httpCacheQ(rng) {
  const t = rng.pick(['basic', 'age', 'smax', 'expires']);
  const M = rng.pick(MAXAGES);
  let a = 0; const rows = []; let note = '';
  if (t === 'age' || (t === 'smax' && rng.next() < 0.5)) a = rng.rand(1, M - 2);
  if (t === 'basic' || t === 'age') rows.push(['Cache-Control', `max-age=${M}`]);
  if (t === 'smax') {
    let S = rng.pick(MAXAGES); while (S === M) S = rng.pick(MAXAGES);
    rows.push(['Cache-Control', `max-age=${M}, s-maxage=${S}`]);
    note = `s-maxage=${S} は共有のキャッシュ(途中のキャッシュサーバー)だけが使う指定で、ブラウザのキャッシュは max-age を使う。`;
  }
  if (t === 'expires') {
    const base = Date.UTC(2026, 9, rng.rand(1, 28), rng.rand(0, 22), rng.rand(0, 59), rng.rand(0, 59));
    let X = rng.pick(MAXAGES); while (X === M) X = rng.pick(MAXAGES);
    rows.push(['Date', new Date(base).toUTCString()], ['Expires', new Date(base + X * 1000).toUTCString()], ['Cache-Control', `max-age=${M}`]);
    note = `Expires(Date の ${X} 秒後)もあるが、max-age があればそちらを使う。`;
  }
  if (a) rows.push(['Age', String(a)]);
  const e = rng.rand(1, M - a - 1);
  const ans = M - a - e;
  return {
    text: `ブラウザ(その利用者だけのキャッシュ)が、次のヘッダの付いた応答を受け取り、キャッシュに入れた。時計はそろっていて、伝わる時間は 0 とする。受け取ってから ${e} 秒たった今、このキャッシュはあと何秒、サーバーに確かめずに使えるか。`,
    table: { headers: ['ヘッダ', '値'], rows: rng.shuffle(rows) },
    ...textQ([numField('remain', '残り(秒)', ans, '例: 300')]),
    explanation: `正解は ${ans} 秒。新しさの期限は max-age の ${M} 秒。${note}`
      + (a ? `Age: ${a} は、途中のキャッシュにすでに ${a} 秒置かれていたという意味なので、受け取った時点で ${a} 秒たっている。` : '')
      + (a ? `今の年齢は ${a} + ${e} = ${a + e} 秒なので` : `今の年齢は受け取ってからの ${e} 秒なので`) + `、残りは ${M} − ${a + e} = ${ans} 秒。`,
    meta: { type: t, age: a },
  };
}
function verifyHttpCache(q) { // RFC 9111 4.2 の式(年齢 = 受け取ったときの年齢 + 置いてからの時間)で数え直す
  const h = Object.fromEntries(q.table.rows.map(([k, v]) => [k, v]));
  const cc = h['Cache-Control'] || '';
  const ma = /(?:^|,\s*)max-age=(\d+)/.exec(cc); // s-maxage はブラウザでは使わない
  const lifetime = ma ? Number(ma[1]) : (Date.parse(h.Expires) - Date.parse(h.Date)) / 1000;
  const apparent = 0; // 伝わる時間 0・時計がそろう → Date と受け取った時刻の差は Age に含まれる
  const initialAge = Math.max(apparent, Number(h.Age || 0));
  const resident = Number(/受け取ってから (\d+) 秒/.exec(q.text)[1]);
  const want = lifetime - (initialAge + resident);
  if (want <= 0 || q.fields[0].accept[0] !== String(want)) throw new Error(`Lv277: 残りが違う ${q.fields[0].accept[0]} / ${want}`);
}

// ---------- Lv283・287 拡張 ACL(規則の形と照らし方) ----------
const TCP_PORTS = [22, 25, 80, 110, 143, 443];
const UDP_PORTS = [53, 123, 161, 514];
function aclUniverse(rng) {
  const X = rng.rand(1, 250);
  const lans = [1, 2, 3, 4].map((k) => [ip2n(`10.${X}.${k}.0`), 24]);
  const sup = [ip2n(`10.${X}.0.0`), 16];
  const pcs = lans.map(([n]) => n + rng.rand(2, 254));
  const srvNets = [[ip2n('192.0.2.0'), 24], [ip2n('198.51.100.0'), 24]];
  const servers = srvNets.flatMap(([n]) => [n + 10 * rng.rand(1, 12), n + 10 * rng.rand(13, 25)]);
  return { X, lans, sup, pcs, srvNets, servers };
}
const ANY = [0, 0];
function randRule(rng, U) {
  const pr = rng.next(); const proto = pr < 0.25 ? 'ip' : pr < 0.75 ? 'tcp' : 'udp';
  const sr = rng.next();
  const src = sr < 0.2 ? ANY : sr < 0.55 ? rng.pick(U.lans) : sr < 0.7 ? U.sup : [rng.pick(U.pcs), 32];
  const dr = rng.next();
  const dst = dr < 0.25 ? ANY : dr < 0.55 ? rng.pick(U.srvNets) : [rng.pick(U.servers), 32];
  const port = proto === 'ip' ? null : rng.next() < 0.75 ? rng.pick(proto === 'tcp' ? TCP_PORTS : UDP_PORTS) : null;
  return { act: rng.next() < 0.5 ? 'permit' : 'deny', proto, src, dst, port };
}
function randPacket(rng, U, rules) {
  const pr = rng.next(); const proto = pr < 0.55 ? 'tcp' : pr < 0.85 ? 'udp' : 'icmp';
  const hostRules = rules.filter((r) => r.src[1] === 32);
  const src = hostRules.length && rng.next() < 0.3 ? rng.pick(hostRules).src[0] : rng.pick(U.lans)[0] + rng.rand(2, 254);
  const dst = rng.pick(U.servers);
  const used = rules.filter((r) => r.proto === proto && r.port != null).map((r) => r.port);
  const port = proto === 'icmp' ? null : used.length && rng.next() < 0.6 ? rng.pick(used) : rng.pick(proto === 'tcp' ? TCP_PORTS : UDP_PORTS);
  return { proto, src, dst, port };
}
const ruleMatch = (r, p) => (r.proto === 'ip' || r.proto === p.proto) && inNet(p.src, r.src[0], r.src[1]) && inNet(p.dst, r.dst[0], r.dst[1]) && (r.proto === 'ip' || r.port == null || r.port === p.port);
const fmtAddr = ([n, l]) => (l === 0 ? 'any' : cidr(n, l));
const fmtPort = (r) => (r.proto === 'ip' ? '—' : r.port == null ? 'すべて' : String(r.port));
const aclTable = (rules) => ({ headers: ['行', '動作', '手順', '送信元', '宛先', '宛先ポート'], rows: rules.map((r, i) => [String((i + 1) * 10), r.act, r.proto, fmtAddr(r.src), fmtAddr(r.dst), fmtPort(r)]) });
const fmtPacket = (p) => (p.proto === 'icmp' ? `ICMP(ping) ${n2ip(p.src)} → ${n2ip(p.dst)}` : `${p.proto.toUpperCase()} ${n2ip(p.src)}:${50000 + (p.src % 9973)} → ${n2ip(p.dst)}:${p.port}`);
function whyNot(r, p) {
  if (!(r.proto === 'ip' || r.proto === p.proto)) return `手順が ${r.proto} なので ${p.proto.toUpperCase()} には合わない`;
  if (!inNet(p.src, r.src[0], r.src[1])) return `送信元 ${fmtAddr(r.src)} に ${n2ip(p.src)} が入らない`;
  if (!inNet(p.dst, r.dst[0], r.dst[1])) return `宛先 ${fmtAddr(r.dst)} に ${n2ip(p.dst)} が入らない`;
  return `宛先ポートが ${r.port} で ${p.port} と違う`;
}
function aclReadQ(rng) {
  const U = aclUniverse(rng);
  const n = rng.rand(4, 5);
  const target = rng.rand(0, n); // n は暗黙の拒否
  let rules, pkt, res;
  for (let tries = 0; tries < 3000; tries++) {
    rules = Array.from({ length: n }, () => randRule(rng, U));
    pkt = randPacket(rng, U, rules);
    res = rules.findIndex((r) => ruleMatch(r, pkt)); if (res < 0) res = n;
    if (res === target) break;
  }
  const ans = res === n ? 'deny implicit' : `${rules[res].act} ${(res + 1) * 10}`;
  const steps = [];
  for (let i = 0; i < Math.min(res + 1, n); i++) steps.push(`${(i + 1) * 10} 行: ${i === res ? `全部合うので、この行の ${rules[i].act} で決まる` : whyNot(rules[i], pkt)}`);
  if (res === n) steps.push('どの行にも合わないので、最後の暗黙の拒否で捨てる');
  return {
    text: `ルーター R1 の IF に、受信の向きで次の拡張 ACL を当てている。次のパケットが届いたとき、どの行で決まり、どうなるか。「動作 行の番号」で答える(どの行にも合わないときは deny implicit)。\nパケット: ${fmtPacket(pkt)}`,
    table: aclTable(rules),
    ...textQ([{ name: 'verdict', label: '結果', format: 'aclverdict', hint: '例: permit 10 / deny 20 / deny implicit', accept: [ans] }]),
    explanation: `正解は ${ans}。ACL は上の行から順に照らし、最初に全部(手順・送信元・宛先・宛先ポート)が合った行で決まる。手順が ip の行は TCP・UDP・ICMP のどれにも合う。\n${steps.join('\n')}`,
    meta: { res, n, icmp: pkt.proto === 'icmp' },
  };
}
// 確かめ用: 表の文字を 2 進の文字列で照らし直す
function parseAclRows(q) { return q.table.rows.map((r) => ({ line: Number(r[0]), act: r[1], proto: r[2], src: r[3], dst: r[4], port: r[5] })); }
function binRuleMatch(r, p) {
  if (!(r.proto === 'ip' || r.proto === p.proto)) return false;
  if (!binIn(p.src, r.src) || !binIn(p.dst, r.dst)) return false;
  if (r.proto === 'ip' || r.port === 'すべて') return true;
  return String(p.port) === r.port;
}
function verifyAclRead(q) {
  const m = /パケット: (?:(TCP|UDP) ([\d.]+):\d+ → ([\d.]+):(\d+)|ICMP\(ping\) ([\d.]+) → ([\d.]+))/.exec(q.text);
  const p = m[1] ? { proto: m[1].toLowerCase(), src: m[2], dst: m[3], port: Number(m[4]) } : { proto: 'icmp', src: m[5], dst: m[6], port: null };
  const hit = parseAclRows(q).find((r) => binRuleMatch(r, p));
  const want = hit ? `${hit.act} ${hit.line}` : 'deny implicit';
  if (q.fields[0].accept[0] !== want) throw new Error(`Lv283: 結果が違う ${q.fields[0].accept[0]} / ${want}`);
}

// Lv287 用: 規則の範囲を箱(手順 × 送信元 × 宛先 × ポート)とみて、前の行の箱を引き算する(生成の側の方法)
const PROTOS = ['tcp', 'udp', 'icmp'];
const ruleBox = (r) => ({ protos: r.proto === 'ip' ? PROTOS.slice() : [r.proto], src: r.src, dst: r.dst, ports: r.proto === 'ip' || r.port == null ? { exc: [] } : { inc: [r.port] } });
const pfxInter = (a, b) => { const [na, la] = a, [nb, lb] = b; if (la >= lb) return inNet(na, nb, lb) ? a : null; return inNet(nb, na, la) ? b : null; };
function pfxMinus(a, b) { // a − b(プレフィックスの差。いくつかのプレフィックスになる)
  const i = pfxInter(a, b); if (!i) return [a]; if (i === a || (i[0] === a[0] && i[1] === a[1])) return [];
  const out = []; let [n, l] = a; const [bn, bl] = b;
  while (l < bl) { const h = blockSize(l + 1); if (inNet(bn, n, l + 1)) { out.push([n + h, l + 1]); } else { out.push([n, l + 1]); n += h; } l++; }
  return out;
}
const portsInter = (a, b) => {
  if (a.inc && b.inc) return { inc: a.inc.filter((x) => b.inc.includes(x)) };
  if (a.inc) return { inc: a.inc.filter((x) => !b.exc.includes(x)) };
  if (b.inc) return { inc: b.inc.filter((x) => !a.exc.includes(x)) };
  return { exc: [...new Set(a.exc.concat(b.exc))] };
};
const portsMinus = (a, b) => {
  if (a.inc && b.inc) return { inc: a.inc.filter((x) => !b.inc.includes(x)) };
  if (a.inc) return { inc: a.inc.filter((x) => b.exc.includes(x)) };
  if (b.inc) return { exc: [...new Set(a.exc.concat(b.inc))] };
  return { inc: b.exc.filter((x) => !a.exc.includes(x)) };
};
const portsEmpty = (p) => p.inc && p.inc.length === 0;
function boxMinus(A, B) {
  const pi = A.protos.filter((x) => B.protos.includes(x)); const si = pfxInter(A.src, B.src); const di = pfxInter(A.dst, B.dst); const qi = portsInter(A.ports, B.ports);
  if (!pi.length || !si || !di || portsEmpty(qi)) return [A];
  const out = [];
  const pm = A.protos.filter((x) => !B.protos.includes(x)); if (pm.length) out.push({ ...A, protos: pm });
  for (const s of pfxMinus(A.src, B.src)) out.push({ ...A, protos: pi, src: s });
  for (const d of pfxMinus(A.dst, B.dst)) out.push({ ...A, protos: pi, src: si, dst: d });
  const qm = portsMinus(A.ports, B.ports); if (!portsEmpty(qm)) out.push({ protos: pi, src: si, dst: di, ports: qm });
  return out;
}
// ICMP にはポートが無いので、ポートの指定がある箱(TCP・UDP だけ)とは分けて考える。ICMP の箱は手順の次元だけで決まる
function coveredBy(rule, earlier) {
  let rest = [ruleBox(rule)];
  for (const e of earlier) { rest = rest.flatMap((b) => boxMinus(b, ruleBox(e))); if (!rest.length) return true; }
  return false;
}
function narrowRule(rng, r, U) {
  const proto = r.proto === 'ip' ? rng.pick(['ip', 'tcp', 'udp']) : r.proto;
  const sub = (p, kind) => {
    if (p[1] === 0) return kind === 'src' ? rng.pick([ANY, rng.pick(U.lans), U.sup, [rng.pick(U.pcs), 32]]) : rng.pick([ANY, rng.pick(U.srvNets), [rng.pick(U.servers), 32]]);
    if (p[1] === 16) return rng.pick([p, rng.pick(U.lans), [rng.pick(U.pcs), 32]]);
    if (p[1] === 24) { const inside = (kind === 'src' ? U.pcs : U.servers).filter((h) => inNet(h, p[0], 24)); return rng.next() < 0.5 || !inside.length ? p : [rng.pick(inside), 32]; }
    return p;
  };
  let port = null;
  if (proto !== 'ip') port = r.proto === proto && r.port != null ? r.port : rng.next() < 0.7 ? rng.pick(proto === 'tcp' ? TCP_PORTS : UDP_PORTS) : null;
  return { act: r.act === 'permit' ? 'deny' : 'permit', proto, src: sub(r.src, 'src'), dst: sub(r.dst, 'dst'), port };
}
function aclShadowQ(rng) {
  const U = aclUniverse(rng);
  const n = 5;
  for (;;) {
    const rules = Array.from({ length: n }, () => randRule(rng, U));
    const j = rng.rand(1, n - 1);
    let cover;
    if (j >= 2 && rng.next() < 0.2) { // 2 つの行で半分ずつ覆う
      const P = rng.next() < 0.5 ? rng.pick(U.lans) : U.sup;
      const base = randRule(rng, U); base.src = P;
      const [i1, i2] = rng.shuffle(Array.from({ length: j }, (_, k) => k)).slice(0, 2).sort((a, b) => a - b);
      const wide = { ...base, act: base.act === 'permit' ? 'deny' : 'permit', proto: rng.next() < 0.5 ? 'ip' : base.proto };
      if (wide.proto === 'ip') wide.port = null; else if (rng.next() < 0.4) wide.port = null;
      if (rng.next() < 0.3) wide.dst = ANY;
      const halves = rng.shuffle([[P[0], P[1] + 1], [P[0] + blockSize(P[1] + 1), P[1] + 1]]);
      rules[i1] = { ...wide, src: halves[0] }; rules[i2] = { ...wide, src: halves[1] }; rules[j] = base;
      cover = [i1, i2];
    } else {
      const i = rng.rand(0, j - 1);
      rules[j] = narrowRule(rng, rules[i], U);
      cover = [i];
    }
    const covered = rules.map((r, k) => k > 0 && coveredBy(r, rules.slice(0, k)));
    if (covered.filter(Boolean).length !== 1 || !covered[j]) continue;
    if (cover.some((c) => rules[c].act === rules[j].act)) continue;
    const ln = (k) => (k + 1) * 10;
    const desc = (r) => `${r.act} ${r.proto} ${fmtAddr(r.src)} → ${fmtAddr(r.dst)}${r.proto === 'ip' ? '' : ` ポート ${fmtPort(r)}`}`;
    return {
      text: '次の拡張 ACL(受信の向き)には、それより前の行にすべて含まれてしまい、どのパケットにも当てはまらない行が 1 つある。その行の番号は?',
      table: aclTable(rules),
      ...textQ([numField('line', '行の番号', ln(j), '例: 30')]),
      explanation: `正解は ${ln(j)} 行(${desc(rules[j])})。`
        + (cover.length === 1
          ? `${ln(j)} 行に合うパケットは、どれも先に ${ln(cover[0])} 行(${desc(rules[cover[0]])})に合う。`
          : `${ln(j)} 行の送信元 ${fmtAddr(rules[j].src)} は、${ln(cover[0])} 行と ${ln(cover[1])} 行の送信元(半分ずつ)で全部覆われ、ほかの項目もその 2 行が含んでいる。`)
        + `ACL は最初に合った行で決まるので、${ln(j)} 行に届くパケットは無く、書いた人のねらい(${rules[j].act})は働かない。直すなら、${ln(j)} 行を${cover.length === 1 ? ` ${ln(cover[0])} 行` : 'それらの行'}より上に置く。`,
      meta: { union: cover.length === 2, j },
    };
  }
}
function verifyAclShadow(q) { // 角の点(各プレフィックスの先頭と、その次のアドレス)を総当たりして、届く点の無い行を数える
  const rules = parseAclRows(q).map((r) => {
    const pb = (c) => (c === 'any' ? '' : bin32(c.split('/')[0]).slice(0, Number(c.split('/')[1])));
    return { ...r, sb: pb(r.src), db: pb(r.dst) };
  });
  const pts = (key) => { // 2 進の文字列の点
    const s = new Set(['0'.repeat(32)]);
    for (const r of rules) { const b = r[key]; if (!b) continue; s.add(b.padEnd(32, '0')); const hi = parseInt(b.padEnd(32, '1'), 2) + 1; if (hi < 2 ** 32) s.add(hi.toString(2).padStart(32, '0')); }
    return [...s];
  };
  const srcs = pts('sb'), dsts = pts('db');
  const ports = [...new Set(rules.filter((r) => /^\d+$/.test(r.port)).map((r) => Number(r.port)).concat([1]))];
  const hit = (r, proto, s, d, port) => (r.proto === 'ip' || r.proto === proto) && s.startsWith(r.sb) && d.startsWith(r.db) && (r.proto === 'ip' || r.port === 'すべて' || r.port === String(port));
  const dead = [];
  rules.forEach((r, k) => {
    const before = rules.slice(0, k);
    let reachable = false;
    const ss = srcs.filter((s) => s.startsWith(r.sb)), ds = dsts.filter((d) => d.startsWith(r.db));
    for (const proto of PROTOS) {
      if (reachable || !(r.proto === 'ip' || r.proto === proto)) continue;
      const ps = proto === 'icmp' ? [null] : ports.filter((p) => r.proto === 'ip' || r.port === 'すべて' || r.port === String(p));
      for (const s of ss) { if (reachable) break; for (const d of ds) { if (reachable) break; for (const port of ps) {
        if (hit(r, proto, s, d, port) && !before.some((e) => hit(e, proto, s, d, port))) { reachable = true; break; }
      } } }
    }
    if (!reachable) dead.push(r.line);
  });
  if (dead.length !== 1 || q.fields[0].accept[0] !== String(dead[0])) throw new Error(`Lv287: 届かない行が ${dead.join(',')}`);
}

// ---------- Lv289 ゾーン ----------
function zoneQ(rng) {
  for (;;) {
    const X = rng.rand(1, 250), Y = rng.rand(1, 250);
    const zones = { 内: [ip2n(`10.${X}.0.0`), 16], DMZ: [ip2n(`172.16.${Y}.0`), 24] };
    const web = ip2n(`172.16.${Y}.10`), mail = ip2n(`172.16.${Y}.25`), dns = ip2n(`172.16.${Y}.53`), db = ip2n(`10.${X}.5.20`);
    const pcs = [1, 2, 3].map(() => ip2n(`10.${X}.${rng.rand(1, 4)}.${rng.rand(2, 254)}`));
    const outs = [`198.51.100.${rng.rand(2, 250)}`, `203.0.113.${rng.rand(2, 250)}`].map(ip2n);
    const outNet = [ip2n('203.0.113.0'), 24];
    const pool = [
      { from: '内', to: '外', dst: ANY, svc: ['tcp', 443], act: '許可' },
      { from: '内', to: '外', dst: ANY, svc: ['tcp', 80], act: '許可' },
      { from: '外', to: 'DMZ', dst: [web, 32], svc: ['tcp', 443], act: '許可' },
      { from: '外', to: 'DMZ', dst: [web, 32], svc: ['tcp', 80], act: '許可' },
      { from: '外', to: 'DMZ', dst: [mail, 32], svc: ['tcp', 25], act: '許可' },
      { from: 'DMZ', to: '内', dst: [db, 32], svc: ['tcp', 5432], act: '許可' },
      { from: '内', to: 'DMZ', dst: ANY, svc: ['tcp', 22], act: '許可' },
      { from: '内', to: 'DMZ', dst: [dns, 32], svc: ['udp', 53], act: '許可' },
      { from: 'DMZ', to: '外', dst: ANY, svc: ['tcp', 25], act: '許可' },
      { from: 'DMZ', to: '外', dst: ANY, svc: ['udp', 53], act: '許可' },
      { from: '外', to: 'DMZ', dst: ANY, svc: ['tcp', 22], act: '拒否' },
      { from: '外', to: '内', dst: ANY, svc: null, act: '拒否' },
    ];
    const rules = rng.shuffle(pool).slice(0, rng.rand(6, 8));
    if (rng.next() < 0.6) { // 先に書いた拒否の行で止まる場合
      const at = rng.rand(0, rules.length); rules.splice(at, 0, { from: '内', to: '外', dst: outNet, svc: ['tcp', 443], act: '拒否' });
    }
    const zoneOf = (ip) => (inNet(ip, ...zones.内) ? '内' : inNet(ip, ...zones.DMZ) ? 'DMZ' : '外');
    const hostsOf = { 内: [...pcs, db], DMZ: [web, mail, dns], 外: outs };
    const svcs = [['tcp', 443], ['tcp', 80], ['tcp', 25], ['tcp', 22], ['udp', 53], ['tcp', 5432], ['udp', 123]];
    const judge = (p) => { const fz = zoneOf(p.src), tz = zoneOf(p.dst); const k = rules.findIndex((r) => r.from === fz && r.to === tz && inNet(p.dst, ...r.dst) && (!r.svc || (r.svc[0] === p.proto && r.svc[1] === p.port))); return { pass: k >= 0 && rules[k].act === '許可', k, fz, tz }; };
    const cand = new Map();
    for (let i = 0; i < 60; i++) {
      const fz = rng.pick(['内', 'DMZ', '外']); let tz; do { tz = rng.pick(['内', 'DMZ', '外']); } while (tz === fz);
      const [proto, port] = rng.pick(svcs);
      const p = { proto, port, src: rng.pick(hostsOf[fz]), dst: rng.pick(hostsOf[tz]) };
      const s = `${proto.toUpperCase()} ${n2ip(p.src)} → ${n2ip(p.dst)}:${port}`;
      if (!cand.has(s)) cand.set(s, { ...p, ...judge(p), s });
    }
    const mode = rng.next() < 0.5 ? 'pass' : 'drop';
    const yes = [...cand.values()].filter((c) => c.pass === (mode === 'pass'));
    const no = [...cand.values()].filter((c) => c.pass !== (mode === 'pass'));
    if (!yes.length || no.length < 3) continue;
    const ans = rng.pick(yes); const picked = rng.shuffle([ans, ...rng.shuffle(no).slice(0, 3)]);
    const svcLabel = (r) => (r.svc ? `${r.svc[0].toUpperCase()} ${r.svc[1]}` : 'すべて');
    const explain = (c) => `${c.s}: ${c.fz} → ${c.tz}。${c.k >= 0 ? `「${c.fz} → ${c.tz}・${fmtAddr(rules[c.k].dst)}・${svcLabel(rules[c.k])}・${rules[c.k].act}」の行に合うので${c.pass ? '通る' : '捨てる'}` : '合う行が無いので捨てる'}。`;
    return {
      text: `FW のゾーンと規則は次の表のとおり。FW は規則を上から照らし、送信元と宛先のゾーン・宛先・サービスが合う最初の行の動作に従う。合う行が無ければ捨てる。返りの通信は FW が覚えていて通すので、新しく始める通信だけを考える。次のうち、FW を${mode === 'pass' ? '通る' : '通らない'}のはどれか。`,
      tables: [
        { title: 'ゾーン', headers: ['ゾーン', '網'], rows: [['内', cidr(...zones.内)], ['DMZ', cidr(...zones.DMZ)], ['外', '上のどれにも当たらないアドレス']] },
        { title: '規則', headers: ['送信元ゾーン', '宛先ゾーン', '宛先', 'サービス', '動作'], rows: rules.map((r) => [r.from, r.to, fmtAddr(r.dst), svcLabel(r), r.act]) },
      ],
      options: picked.map((c) => c.s), answerIndex: picked.indexOf(ans),
      explanation: `正解は ${ans.s}。\n${picked.map(explain).join('\n')}`,
      meta: { mode, denyFirst: rules.some((r) => r.dst === outNet) },
    };
  }
}
function verifyZone(q) {
  const [zt, rt] = q.tables;
  const zoneNet = Object.fromEntries(zt.rows.filter((r) => r[0] !== '外').map((r) => [r[0], r[1]]));
  const zoneOf = (ip) => Object.keys(zoneNet).find((z) => binIn(ip, zoneNet[z])) || '外';
  const res = q.options.map((o) => {
    const m = /(TCP|UDP) ([\d.]+) → ([\d.]+):(\d+)/.exec(o);
    const fz = zoneOf(m[2]), tz = zoneOf(m[3]);
    const hit = rt.rows.find((r) => r[0] === fz && r[1] === tz && binIn(m[3], r[2]) && (r[3] === 'すべて' || r[3] === `${m[1]} ${m[4]}`));
    return !!hit && hit[4] === '許可';
  });
  const want = q.meta.mode === 'pass';
  if (res.filter((x) => x === want).length !== 1 || res[q.answerIndex] !== want) throw new Error('Lv289: 正解が 1 つに決まらない');
}

// ---------- Lv295 表から原因(設定違い) ----------
const CAUSES = { ip: 'IP アドレス(この LAN の網に入っていない)', mask: 'サブネットマスク(プレフィックス長)', gw: 'デフォルトゲートウェイ', dup: 'IP アドレス(ほかの機器と同じ)' };
function hostConfigQ(rng) {
  const len = rng.pick([22, 23, 24, 25, 26, 27]);
  const base = rng.pick([() => ip2n(`10.${rng.rand(0, 255)}.${rng.rand(0, 255)}.0`), () => ip2n(`192.168.${rng.rand(0, 255)}.0`), () => ip2n(`172.${rng.rand(16, 31)}.${rng.rand(0, 255)}.0`)])();
  const net = netOf(base + rng.rand(0, 255), len); const size = blockSize(len);
  const usable = () => net + rng.rand(1, size - 2);
  const router = rng.next() < 0.6 ? net + 1 : net + size - 2;
  const used = new Set([router]); const fresh = () => { let a; do { a = usable(); } while (used.has(a)); used.add(a); return a; };
  const printer = fresh(), pc2 = fresh();
  const pc1 = { ip: fresh(), len, gw: router };
  const cause = rng.pick(Object.keys(CAUSES));
  if (cause === 'gw') pc1.gw = fresh();
  if (cause === 'mask') { let l; do { l = len + rng.pick([-2, -1, 1, 2]); } while (l === len); pc1.len = l; }
  if (cause === 'ip') { // となりの網(同じ /16 の中に収める。プライベートの範囲から出さない)
    let other = rng.next() < 0.5 ? net - size : net + size;
    if (netOf(other, 16) !== netOf(net, 16)) other = other === net - size ? net + size : net - size;
    pc1.ip = other + rng.rand(1, size - 2);
  }
  if (cause === 'dup') pc1.ip = rng.pick([printer, pc2]);
  const mk = (l) => `${lenToMask(l)}(/${l})`;
  const hostsRows = rng.shuffle([['プリンター', n2ip(printer), mk(len), n2ip(router)], ['PC2', n2ip(pc2), mk(len), n2ip(router)], ['PC1', n2ip(pc1.ip), mk(pc1.len), n2ip(pc1.gw)]]);
  const keys = Object.keys(CAUSES);
  const options = rng.shuffle(keys.map((k) => CAUSES[k]));
  const range = `${n2ip(net + 1)}〜${n2ip(net + size - 2)}`;
  const why = {
    gw: `PC1 のデフォルトゲートウェイ ${n2ip(pc1.gw)} は、ルーター R1 の Gi0/1 のアドレス ${n2ip(router)} と違う。同じ網の中のアドレスなので一見正しそうだが、そこにルーターはいない。`,
    mask: `この LAN は /${len}(${lenToMask(len)})だが、PC1 だけ /${pc1.len} になっている。アドレスとゲートウェイは合っている。`,
    ip: `この LAN(${cidr(net, len)})で使えるのは ${range}。PC1 の ${n2ip(pc1.ip)} はこの範囲の外(となりの網)なので、ゲートウェイ ${n2ip(router)} と同じ網にならない。`,
    dup: `PC1 の ${n2ip(pc1.ip)} は、${pc1.ip === printer ? 'プリンター' : 'PC2'} と同じアドレス。マスクとゲートウェイは合っている。`,
  }[cause];
  return {
    text: 'この LAN の機器は、ルーター R1 の Gi0/1(この LAN のデフォルトゲートウェイ)と同じ網の設定にそろえる決まり。PC1 の設定に、決まりに合わない項目が 1 つある。表を見て、それはどれか。',
    table: { headers: ['機器', 'IP アドレス', 'サブネットマスク', 'デフォルトゲートウェイ'], rows: [['R1 の Gi0/1', n2ip(router), mk(len), '—'], ...hostsRows] },
    options, answerIndex: options.indexOf(CAUSES[cause]),
    explanation: `正解は「${CAUSES[cause]}」。${why}\nR1 の Gi0/1 は ${n2ip(router)}/${len} なので、この LAN は ${cidr(net, len)}(使えるのは ${range})。ほかの項目は R1 とそろっている。`,
    meta: { cause },
  };
}
function verifyHostConfig(q) {
  const rows = q.table.rows; const r1 = rows[0]; const pc1 = rows.find((r) => r[0] === 'PC1');
  const lanLen = Number(/\/(\d+)/.exec(r1[2])[1]); const pcLen = Number(/\/(\d+)/.exec(pc1[2])[1]);
  const lan = `${r1[1]}/${lanLen}`;
  const flags = {
    ip: !binIn(pc1[1], lan),
    mask: pcLen !== lanLen,
    gw: pc1[3] !== r1[1],
    dup: rows.filter((r) => r !== pc1).some((r) => r[1] === pc1[1]),
  };
  const bad = Object.keys(flags).filter((k) => flags[k]);
  if (bad.length !== 1 || q.options[q.answerIndex] !== CAUSES[bad[0]]) throw new Error(`Lv295: 原因が 1 つに決まらない ${bad}`);
  // マスクの誤りのとき、マスクを /lanLen と見ればアドレスは網に入っていること
  if (!binIn(pc1[1], lan) && bad[0] !== 'ip') throw new Error('Lv295: 原因が重なる');
}

// ---------- Lv300〜302 稼働率 ----------
const AV2 = Array.from({ length: 20 }, (_, i) => (0.8 + i * 0.01).toFixed(2)); // 0.80〜0.99
const AV3 = ['0.995', '0.998', '0.999'];
const AVS = ['0.6', '0.7', '0.8', '0.9', '0.95', '0.99'];
// 小数の文字列を BigInt の分数(分子, 小数の桁数)で扱う
const dec = (s) => { const [i, f = ''] = s.split('.'); return { n: BigInt(i + f), d: f.length }; };
const dMul = (a, b) => ({ n: a.n * b.n, d: a.d + b.d });
const dOneMinus = (a) => ({ n: 10n ** BigInt(a.d) - a.n, d: a.d });
const dStr = (a) => { const s = a.n.toString().padStart(a.d + 1, '0'); let r = a.d ? `${s.slice(0, s.length - a.d)}.${s.slice(s.length - a.d)}` : s; if (r.includes('.')) r = r.replace(/0+$/, '').replace(/\.$/, ''); return r; };
const dSer = (xs) => xs.reduce(dMul);
const dPar = (xs) => dOneMinus(xs.map(dOneMinus).reduce(dMul));
const NAMES = ['A', 'B', 'C', 'D'];
function availFields(v) { return textQ([numField('avail', '稼働率', v, '例: 0.9801', { decimal: true })]); }
const availText = (body) => `${body}装置はそれぞれ関係なく故障する。システム全体の稼働率を、0〜1 の小数で答えよ(四捨五入せず、割り切れるところまで書く)。`;
const availTable = (vals) => ({ headers: ['装置', '稼働率'], rows: vals.map((v, i) => [NAMES[i], v]) });
function availSeriesQ(rng) {
  const k = rng.rand(2, 3);
  const vals = Array.from({ length: k }, () => (k === 2 && rng.next() < 0.25 ? rng.pick(AV3) : rng.pick(AV2)));
  const r = dStr(dSer(vals.map(dec)));
  return {
    text: availText(`装置 ${NAMES.slice(0, k).join('・')} を直列につないだシステムがある(稼働率は表のとおり)。`), table: availTable(vals), ...availFields(r),
    explanation: `正解は ${r}。直列はすべての装置が動いているときだけ動くので、稼働率を掛け合わせる: ${vals.join(' × ')} = ${r}。`,
    meta: { struct: 'S', k },
  };
}
function availParallelQ(rng) {
  const k = rng.rand(2, 3);
  const vals = Array.from({ length: k }, () => (k === 2 && rng.next() < 0.25 ? rng.pick(AV3) : rng.pick(AV2)));
  const r = dStr(dPar(vals.map(dec)));
  return {
    text: availText(`装置 ${NAMES.slice(0, k).join('・')} を並列につないだシステムがある(稼働率は表のとおり)。`), table: availTable(vals), ...availFields(r),
    explanation: `正解は ${r}。並列はどれか 1 台でも動いていれば動くので、「全部が止まる」確率を 1 から引く: 1 − ${vals.map((v) => `(1 − ${v})`).join(' × ')} = 1 − ${dStr(vals.map(dec).map(dOneMinus).reduce(dMul))} = ${r}。`,
    meta: { struct: 'P', k },
  };
}
function availMixedQ(rng) {
  const st = rng.pick(['PS', 'SP', 'PP', 'PofS']);
  const big = st === 'PP' || st === 'PofS';
  const k = st === 'PS' || st === 'SP' ? 3 : 4;
  const vals = Array.from({ length: k }, () => (big ? rng.pick(AVS) : rng.pick(AV2)));
  const v = vals.map(dec);
  let res, body, how;
  if (st === 'PS') { const p = dPar([v[0], v[1]]); res = dMul(p, v[2]); body = 'A と B を並列にし、それに C を直列につないだ'; how = `A と B の並列: 1 − (1 − ${vals[0]}) × (1 − ${vals[1]}) = ${dStr(p)}。それに C を直列: ${dStr(p)} × ${vals[2]} = ${dStr(res)}。`; }
  else if (st === 'SP') { const p = dPar([v[1], v[2]]); res = dMul(v[0], p); body = 'A に、B と C を並列にしたものを直列につないだ'; how = `B と C の並列: 1 − (1 − ${vals[1]}) × (1 − ${vals[2]}) = ${dStr(p)}。A と直列: ${vals[0]} × ${dStr(p)} = ${dStr(res)}。`; }
  else if (st === 'PP') { const p1 = dPar([v[0], v[1]]), p2 = dPar([v[2], v[3]]); res = dMul(p1, p2); body = 'A と B を並列にしたものと、C と D を並列にしたものを直列につないだ'; how = `A と B の並列 = ${dStr(p1)}、C と D の並列 = ${dStr(p2)}。直列: ${dStr(p1)} × ${dStr(p2)} = ${dStr(res)}。`; }
  else { const s1 = dMul(v[0], v[1]), s2 = dMul(v[2], v[3]); res = dPar([s1, s2]); body = 'A と B を直列にした道と、C と D を直列にした道を並列につないだ'; how = `A と B の直列 = ${vals[0]} × ${vals[1]} = ${dStr(s1)}、C と D の直列 = ${vals[2]} × ${vals[3]} = ${dStr(s2)}。2 本の道の並列: 1 − (1 − ${dStr(s1)}) × (1 − ${dStr(s2)}) = ${dStr(res)}。`; }
  const r = dStr(res);
  return {
    text: availText(`装置 ${NAMES.slice(0, k).join('・')}(稼働率は表のとおり)で、${body}システムがある。`), table: availTable(vals), ...availFields(r),
    explanation: `正解は ${r}。内側の組から順に計算する。${how}直列は掛け合わせ、並列は 1 から「全部止まる確率」を引く。`,
    meta: { struct: st, k },
  };
}
function verifyAvail(q) { // 1000 分の 1 を単位にした分数で解き直し、浮動小数でも近いかを見る
  const vals = q.table.rows.map((r) => r[1]);
  const D = 1000n;
  const fr = (s) => BigInt(Math.round(Number(s) * 1000)); // 3 桁までの値なので 1000 倍で整数
  const xs = vals.map((s) => ({ n: fr(s), d: D }));
  const mul = (a, b) => ({ n: a.n * b.n, d: a.d * b.d });
  const om = (a) => ({ n: a.d - a.n, d: a.d });
  const par = (arr) => om(arr.map(om).reduce(mul)); const ser = (arr) => arr.reduce(mul);
  const st = q.meta.struct;
  const exact = st === 'S' ? ser(xs) : st === 'P' ? par(xs) : st === 'PS' ? mul(par([xs[0], xs[1]]), xs[2]) : st === 'SP' ? mul(xs[0], par([xs[1], xs[2]])) : st === 'PP' ? mul(par([xs[0], xs[1]]), par([xs[2], xs[3]])) : par([mul(xs[0], xs[1]), mul(xs[2], xs[3])]);
  const acc = q.fields[0].accept[0]; const [ai, af = ''] = acc.split('.');
  const an = BigInt(ai + af), ad = 10n ** BigInt(af.length);
  if (an * exact.d !== exact.n * ad) throw new Error(`Lv${q.level}: 稼働率が違う ${acc}`);
  const fl = { S: (a) => a.reduce((x, y) => x * y, 1), P: (a) => 1 - a.reduce((x, y) => x * (1 - y), 1) };
  const nv = vals.map(Number);
  const approx = st === 'S' ? fl.S(nv) : st === 'P' ? fl.P(nv) : st === 'PS' ? fl.P(nv.slice(0, 2)) * nv[2] : st === 'SP' ? nv[0] * fl.P(nv.slice(1)) : st === 'PP' ? fl.P(nv.slice(0, 2)) * fl.P(nv.slice(2)) : fl.P([nv[0] * nv[1], nv[2] * nv[3]]);
  if (Math.abs(approx - Number(acc)) > 1e-9) throw new Error(`Lv${q.level}: 浮動小数の計算と合わない`);
  if (!(Number(acc) > 0 && Number(acc) < 1)) throw new Error(`Lv${q.level}: 稼働率が 0〜1 の外`);
}

// ---------- Lv303 仮想網のピアリング ----------
const VN = ['A', 'B', 'C', 'D', 'E', 'F'].map((x) => `仮想網 ${x}`);
function peeringQ(rng) {
  for (;;) {
    const n = rng.rand(5, 6);
    const names = VN.slice(0, n);
    const octs = rng.shuffle(Array.from({ length: 200 }, (_, i) => i + 10)).slice(0, n);
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
    const edges = rng.shuffle(pairs).slice(0, rng.rand(n - 1, n + 1)).map(([i, j]) => ({ a: i, b: j, ok: rng.next() < 0.8 }));
    const x = rng.rand(0, n - 1);
    const direct = new Set(edges.filter((e) => e.ok && (e.a === x || e.b === x)).map((e) => (e.a === x ? e.b : e.a)));
    const pending = new Set(edges.filter((e) => !e.ok && (e.a === x || e.b === x)).map((e) => (e.a === x ? e.b : e.a)));
    const two = new Set(); for (const d of direct) for (const e of edges) if (e.ok && (e.a === d || e.b === d)) { const o = e.a === d ? e.b : e.a; if (o !== x && !direct.has(o)) two.add(o); }
    const variant = rng.next() < 0.55 ? 'pick' : 'count';
    const addr = (i) => `${names[i]}(10.${octs[i]}.0.0/16)`;
    const table = { headers: ['仮想網', '仮想網', '状態'], rows: rng.shuffle(edges).map((e) => [addr(e.a), addr(e.b), e.ok ? '有効' : '承認待ち']) };
    const intro = `PC クラウドの仮想網(かっこはアドレス)のピアリングは次の表のとおり。PC クラウドでは、ピアリングで直接つないだ 2 つの仮想網の間だけで通信でき、つながりをたどって先の仮想網へは行けない。状態が「承認待ち」のピアリングはまだ使えない。`;
    const why = `${names[x]} と有効なピアリングで直接つながっているのは ${direct.size ? [...direct].map((i) => names[i]).join('・') : '無い'}。`
      + (two.size ? `${[...two].map((i) => names[i]).join('・')} は、つながりをたどれば行けそうに見えるが、PC クラウドではたどれないので通信できない。` : '')
      + (pending.size ? `${[...pending].map((i) => names[i]).join('・')} とのピアリングは承認待ちなので、まだ使えない。` : '');
    if (variant === 'count') {
      return { text: `${intro}${names[x]} と通信できる仮想網はいくつか。`, table, ...textQ([numField('count', '数', direct.size, '例: 2')]), explanation: `正解は ${direct.size}。${why}`, meta: { variant, two: two.size, pending: pending.size } };
    }
    const nonDirect = names.map((_, i) => i).filter((i) => i !== x && !direct.has(i));
    if (!direct.size || nonDirect.length < 3) continue;
    const traps = rng.shuffle([...two, ...pending]); const rest = rng.shuffle(nonDirect.filter((i) => !two.has(i) && !pending.has(i)));
    const wrong = [...new Set(traps.concat(rest))].slice(0, 3);
    const ans = rng.pick([...direct]);
    const picked = rng.shuffle([ans, ...wrong]);
    return { text: `${intro}${names[x]} と通信できる仮想網はどれか。`, table, options: picked.map((i) => names[i]), answerIndex: picked.indexOf(ans), explanation: `正解は ${names[ans]}。${why}`, meta: { variant, two: wrong.filter((i) => two.has(i)).length, pending: wrong.filter((i) => pending.has(i)).length } };
  }
}
function verifyPeering(q) {
  const x = /(仮想網 [A-F]) と通信できる/.exec(q.text)[1];
  const nm = (c) => c.split(String.fromCharCode(40))[0]; // かっこの前が名前
  const peers = new Set(); for (const [a, b, s] of q.table.rows) { if (s !== '有効') continue; if (nm(a) === x) peers.add(nm(b)); if (nm(b) === x) peers.add(nm(a)); }
  if (q.answerKind === 'text') { if (q.fields[0].accept[0] !== String(peers.size)) throw new Error('Lv303: 数が違う'); return; }
  const hits = q.options.map((o) => peers.has(o));
  if (hits.filter(Boolean).length !== 1 || !hits[q.answerIndex]) throw new Error('Lv303: 正解が 1 つに決まらない');
}

// ---------- Lv304 クラウドの経路表 ----------
const TG = { local: '中(この仮想網の中)', nat: 'NAT ゲートウェイ', vpn: '社内への VPN', dx: '専用線(本社)', peer: 'ピアリング(仮想網 B)' };
function cloudRouteQ(rng) {
  const [A, B, D] = rng.shuffle(Array.from({ length: 200 }, (_, i) => i + 10)).slice(0, 3);
  const C = rng.rand(0, 255);
  const routes = [
    { net: ip2n(`10.${A}.0.0`), len: 16, tg: 'local' },
    { net: 0, len: 0, tg: 'nat' },
    { net: ip2n(`10.${B}.0.0`), len: 16, tg: 'vpn' },
    { net: ip2n(`10.${B}.${C}.0`), len: 24, tg: 'dx' },
    { net: ip2n(`10.${D}.0.0`), len: 16, tg: 'peer' },
  ];
  if (rng.next() < 0.4) routes.push({ net: ip2n('172.16.0.0'), len: 12, tg: 'vpn' });
  const kind = rng.pick(['local', 'nat', 'vpn', 'vpn', 'dx', 'dx', 'peer', 'edge']);
  let ip;
  const C2 = (C + rng.pick([1, 255])) % 256; // /24 のとなり(VPN 側)
  if (kind === 'local') ip = ip2n(`10.${A}.${rng.rand(0, 255)}.${rng.rand(1, 254)}`);
  else if (kind === 'nat') ip = ip2n(rng.pick([`198.51.100.${rng.rand(1, 254)}`, `203.0.113.${rng.rand(1, 254)}`, `192.0.2.${rng.rand(1, 254)}`]));
  else if (kind === 'vpn') ip = routes.length > 5 && rng.next() < 0.4 ? ip2n(`172.${rng.rand(16, 31)}.${rng.rand(0, 255)}.${rng.rand(1, 254)}`) : ip2n(`10.${B}.${C2}.${rng.rand(1, 254)}`);
  else if (kind === 'dx') ip = ip2n(`10.${B}.${C}.${rng.rand(1, 254)}`);
  else if (kind === 'peer') ip = ip2n(`10.${D}.${rng.rand(0, 255)}.${rng.rand(1, 254)}`);
  else ip = ip2n(`10.${B}.${C}.${rng.pick([1, 254])}`); // /24 の両端に近いホスト
  const hits = routes.filter((r) => inNet(ip, r.net, r.len)).sort((a, b) => b.len - a.len);
  const best = hits[0];
  const present = [...new Set(routes.map((r) => r.tg))];
  const options = rng.shuffle([best.tg, ...rng.shuffle(present.filter((t) => t !== best.tg)).slice(0, 3)]).map((t) => TG[t]);
  return {
    text: `PC クラウドの非公開のサブネットに付けた経路表は次のとおり。${n2ip(ip)} 宛のパケットはどこへ送られるか。`,
    table: { headers: ['宛先', '行き先'], rows: rng.shuffle(routes).map((r) => [cidr(r.net, r.len), TG[r.tg]]) },
    options, answerIndex: options.indexOf(TG[best.tg]),
    explanation: `正解は「${TG[best.tg]}」。${n2ip(ip)} に一致する行は ${hits.map((r) => cidr(r.net, r.len)).join('・')}。経路表は宛先にいちばん長く一致する行(プレフィックス長がいちばん長い行)を使うので、/${best.len} の ${cidr(best.net, best.len)} の行で決まる。`
      + (hits.length > 1 ? `0.0.0.0/0 などの短い行は、ほかに合う行が無いときだけ使う。` : ''),
    meta: { tg: best.tg, hits: hits.length },
  };
}
function verifyCloudRoute(q) {
  const ip = /([\d.]+) 宛のパケット/.exec(q.text)[1];
  let best = null, bl = -1;
  for (const [c, tg] of q.table.rows) { const l = Number(c.split('/')[1]); if (binIn(ip, c) && l > bl) { best = tg; bl = l; } }
  if (q.options[q.answerIndex] !== best || q.options.filter((o) => o === best).length !== 1) throw new Error('Lv304: 行き先が違う');
}

// ---------- Lv307 VXLAN と MTU ----------
function vxlanQ(rng) {
  const v6 = rng.next() < 0.3; const vlan = rng.next() < 0.3;
  const over = (v6 ? 70 : 50) + (vlan ? 4 : 0); // 生成の側はまとめた値を使う(確かめは部品を足し直す)
  const t = rng.pick(['inner', 'inner', 'mss', 'underlay']);
  const parts = `VXLAN で包むと、中のイーサネットのフレーム(ヘッダ 14 バイト${vlan ? '・VLAN タグ 4 バイト' : ''}込み)の外側に、VXLAN のヘッダ 8 バイト・UDP 8 バイト・外側の ${v6 ? 'IPv6 40' : 'IPv4 20'} バイトが付く(外側のイーサネットのヘッダは下の網の MTU に数えない)。`;
  let text, ans, how;
  if (t === 'underlay') {
    const M = rng.next() < 0.4 ? rng.pick([1500, 9000, 1450, 1400]) : rng.rand(1280, 9000);
    ans = M + over;
    text = `${parts}中の網の機器の MTU を ${M} バイトにしたい。下の網(VXLAN を運ぶ網)の MTU は、少なくとも何バイト要るか。`;
    how = `中の IP パケット ${M} に、包む分 ${over} を足して ${ans}。`;
  } else {
    const U = rng.next() < 0.3 ? rng.pick([1500, 1550, 1600, 9000, 9216]) : rng.rand(1400, 9216);
    const inner = U - over;
    if (t === 'inner') { ans = inner; text = `${parts}下の網(VXLAN を運ぶ網)の MTU は ${U} バイト。中の網の機器の MTU は最大で何バイトにできるか。`; how = `${U} − ${over} = ${ans}。`; }
    else { ans = inner - 40; text = `${parts}下の網(VXLAN を運ぶ網)の MTU は ${U} バイト。中の網の MTU を最大にしたとき、中の網の PC が IPv4 で使う TCP の MSS は何バイトか(IP と TCP のヘッダはどちらも 20 バイトで、オプションは無い)。`; how = `中の MTU は ${U} − ${over} = ${inner}。MSS は MTU から IP と TCP のヘッダ 40 を引いて ${inner} − 40 = ${ans}。`; }
  }
  return {
    text, ...textQ([numField('bytes', 'バイト', ans, '例: 1450')]),
    explanation: `正解は ${ans}。包む分は 14${vlan ? ' + 4' : ''} + 8 + 8 + ${v6 ? 40 : 20} = ${over} バイト(中のイーサネットのヘッダは、外から見ると運ぶ中身に入る)。${how}`,
    meta: { t, v6, vlan },
  };
}
function verifyVxlan(q) { // 問題文の部品の数を読み直して足す
  const s = q.text;
  const sum = 14 + (s.includes('VLAN タグ 4 バイト') ? 4 : 0) + 8 + 8 + (s.includes('IPv6 40') ? 40 : 20);
  let want;
  if (q.meta.t === 'underlay') want = Number(/MTU を (\d+) バイトにしたい/.exec(s)[1]) + sum;
  else { const U = Number(/MTU は (\d+) バイト/.exec(s)[1]); want = U - sum - (q.meta.t === 'mss' ? 40 : 0); }
  if (q.fields[0].accept[0] !== String(want)) throw new Error(`Lv307: 値が違う ${want}`);
}

// ================= レベルの一覧 =================
const gen = (title, kindName, make, verify) => ({ title, kind: '生', minDistinct: 1000, make(rng) { return { ...make(rng), kind: kindName }; }, verify });

const LEVELS = {
  253: tableLevel('線を束ねる', LAG, 'cl253-lag-v1', [(r) => stmtQ(r, stmtRows(LAG), '複数の線を 1 本に束ねること(リンク集約)')]),
  254: { title: '束ねる交渉', kind: '表', minDistinct: 20, make(rng) { return { ...lacpQ(rng), kind: 'cl254-lacp-mode-v1' }; }, verify: verifyLacp },
  258: tableLevel('端のポート', EDGE, 'cl258-edge-port-v1', [(r) => stmtQ(r, stmtRows(EDGE), 'STP のエッジポートと BPDU ガード'), (r) => termQ(r, EDGE, 'guard'), (r) => termQ(r, EDGE, 'guard', { only: ['t-edge'] })]),
  261: gen('OSPF のコスト', 'cl261-ospf-cost-v1', ospfCostQ, verifyOspfCost),
  264: gen('ABR で集約', 'cl264-abr-summary-v1', summaryQ, verifySummary),
  267: tableLevel('AS', ASX, 'cl267-as-v1', [(r) => stmtQ(r, stmtRows(ASX), 'AS と BGP'), (r) => termQ(r, ASX, 'as'), (r) => termQ(r, ASX, 'as', { reverse: true })]),
  271: tableLevel('DNS の委任', DNSR, 'cl271-dns-delegation-v1', [(r) => stmtQ(r, stmtRows(DNSR), 'DNS の委任とレコード'), (r) => termQ(r, DNSR, 'rr', { only: ['rr-ns'] }), (r) => termQ(r, DNSR, 'rr')]),
  272: gen('キャッシュの残り', 'cl272-dns-ttl-v1', dnsTtlQ, verifyDnsTtl),
  273: gen('ポートフォワード', 'cl273-port-forward-v1', portFwdQ, verifyPortFwd),
  274: gen('行きと帰り', 'cl274-port-forward-return-v1', portFwdReturnQ, verifyPortFwdReturn),
  275: gen('HTTP の転送', 'cl275-http-redirect-v1', redirectQ, verifyRedirect),
  276: tableLevel('Cookie', COOKIE, 'cl276-cookie-v1', [(r) => stmtQ(r, stmtRows(COOKIE), 'HTTP の Cookie'), (r) => termQ(r, COOKIE, 'header'), (r) => termQ(r, COOKIE, 'header', { only: ['h-cookie'] }), (r) => termQ(r, COOKIE, 'attr')]),
  277: gen('キャッシュの期限', 'cl277-http-cache-v1', httpCacheQ, verifyHttpCache),
  278: tableLevel('TLS のやりとり', TLS, 'cl278-tls-handshake-v1', [(r) => stmtQ(r, stmtRows(TLS), 'TLS のハンドシェイク'), (r) => termQ(r, TLS, 'msg'), (r) => termQ(r, TLS, 'msg', { only: ['m-ch'] })]),
  279: tableLevel('証明書を確かめる', CERT, 'cl279-cert-check-v1', [certItemQ, certItemQ, (r) => tfQ(r, stmtRows(CERT))], verifyCertItem),
  280: tableLevel('メールの流れ', MAILF, 'cl280-mail-flow-v1', [mailFlowQ], verifyMailFlow),
  281: tableLevel('SPF', MAILA, 'cl281-spf-v1', [(r) => stmtQ(r, stmtRows(MAILA, 'spf'), 'SPF'), (r) => termQ(r, MAILA, 'auth', { only: ['ma-spf'] }), (r) => termQ(r, MAILA, 'auth', { only: ['ma-spf'], reverse: true })]),
  282: tableLevel('DKIM', MAILA, 'cl282-dkim-v1', [(r) => stmtQ(r, stmtRows(MAILA, 'dkim'), 'DKIM'), (r) => termQ(r, MAILA, 'auth', { only: ['ma-dkim'] }), (r) => termQ(r, MAILA, 'auth', { only: ['ma-dkim'], reverse: true })]),
  283: gen('拡張 ACL を読む', 'cl283-ext-acl-v1', aclReadQ, verifyAclRead),
  284: tableLevel('拡張 ACL の置き場所', ACLP, 'cl284-acl-place-v1', [(r) => stmtQ(r, stmtRows(ACLP), 'ACL の置き場所と照らし方'), (r) => stmtQ(r, stmtRows(ACLP), 'ACL の置き場所と照らし方'), aclPlaceQ]),
  287: gen('ACL の誤りを見つける', 'cl287-acl-shadow-v1', aclShadowQ, verifyAclShadow),
  288: tableLevel('状態を見る FW', SFW, 'cl288-stateful-fw-v1', [(r) => stmtQ(r, stmtRows(SFW), 'FW の通し方'), (r) => termQ(r, SFW, 'fw', { only: ['fw-stateful'] }), (r) => termQ(r, SFW, 'fw', { only: ['fw-stateful', 'fw-static'] })]),
  289: gen('ゾーン', 'cl289-zone-fw-v1', zoneQ, verifyZone),
  290: tableLevel('DHCP の監視', L2S, 'cl290-dhcp-snooping-v1', [(r) => stmtQ(r, stmtRows(L2S, 'snoop'), 'DHCP スヌーピング'), (r) => termQ(r, L2S, 'l2sec', { only: ['l2-snoop'] }), (r) => termQ(r, L2S, 'l2sec', { only: ['l2-snoop'], reverse: true })]),
  291: tableLevel('ARP の検査', L2S, 'cl291-arp-inspection-v1', [(r) => stmtQ(r, stmtRows(L2S, 'dai'), 'ARP の検査(ダイナミック ARP インスペクション)'), (r) => termQ(r, L2S, 'l2sec', { only: ['l2-dai'] }), (r) => termQ(r, L2S, 'l2sec', { only: ['l2-dai'], reverse: true })]),
  292: tableLevel('802.1X', L2S, 'cl292-dot1x-v1', [(r) => stmtQ(r, stmtRows(L2S, 'dot1x'), '802.1X の認証'), (r) => termQ(r, L2S, 'role'), (r) => termQ(r, L2S, 'role', { reverse: true })]),
  293: tableLevel('QoS の印', DSCP, 'cl293-dscp-v1', [dscpQ, dscpQ, (r) => stmtQ(r, stmtRows(DSCP), 'DSCP の印')], verifyDscp),
  294: tableLevel('待ち行列', QUE, 'cl294-queuing-v1', [(r) => stmtQ(r, stmtRows(QUE), '待ち行列と速さの抑え方'), (r) => termQ(r, QUE, 'sched'), (r) => termQ(r, QUE, 'rate'), (r) => termQ(r, QUE, 'sched', { only: ['q-pq'] })]),
  295: gen('表から原因(設定違い)', 'cl295-host-config-v1', hostConfigQ, verifyHostConfig),
  299: tableLevel('WAN の種類', WAN, 'cl299-wan-v1', [(r) => stmtQ(r, stmtRows(WAN), '拠点をつなぐ WAN のサービス'), (r) => termQ(r, WAN, 'wan'), (r) => termQ(r, WAN, 'wan', { reverse: true })]),
  300: gen('稼働率: 直列', 'cl300-avail-series-v1', availSeriesQ, verifyAvail),
  301: gen('稼働率: 並列', 'cl301-avail-parallel-v1', availParallelQ, verifyAvail),
  302: gen('稼働率: 組み合わせ', 'cl302-avail-mixed-v1', availMixedQ, verifyAvail),
  303: gen('仮想網のピアリング', 'cl303-vnet-peering-v1', peeringQ, verifyPeering),
  304: gen('クラウドの経路表', 'cl304-cloud-route-v1', cloudRouteQ, verifyCloudRoute),
  305: tableLevel('専用線と VPN', CLINK, 'cl305-cloud-link-v1', [(r) => stmtQ(r, stmtRows(CLINK), 'クラウドと社内のつなぎ方'), (r) => termQ(r, CLINK, 'link'), (r) => termQ(r, CLINK, 'link', { only: ['cl-leased'] })]),
  306: tableLevel('負荷分散の層', LB, 'cl306-lb-layer-v1', [(r) => stmtQ(r, stmtRows(LB), '負荷分散'), (r) => termQ(r, LB, 'lb'), (r) => termQ(r, LB, 'lb', { only: ['lb-l7', 'lb-l4'] })]),
  307: gen('VXLAN と MTU', 'cl307-vxlan-mtu-v1', vxlanQ, verifyVxlan),
  308: tableLevel('ゼロトラストの考え方', ZT, 'cl308-zero-trust-v1', [(r) => stmtQ(r, stmtRows(ZT), 'ゼロトラストの考え方')]),
};

module.exports = { LEVELS, _test: { coveredBy, ruleMatch, ospfCost, dStr, dPar, dSer, dec, CAUSES, TG } };
