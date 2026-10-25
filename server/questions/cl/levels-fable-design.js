'use strict';
// 設計の固定問題(新しい番号 328・329・351・352・353・361。docs/LEVEL-LIST.md 第 6 章)。担当: Claude Fable 5.1(2026-10-25)。
// 一覧の「担当」が F・O→F で、作り方が「固」(状況を読んで判断する問題を 1 問ずつ作り、答えと解説を確かめる)の行。書き方は docs/questions/CL.md。
// 問題の中身は server/questions/data/cl/fable-design/ の表(1 行 = 1 問。根拠 source・正解が 1 つに決まる理由 reason・checkedBy つき)。
// ここでは seed で 1 問を選び、選択肢の順を混ぜるだけ。verify は表を引き直して、正解の文字が選択肢に 1 つだけあり、その位置が answerIndex であることを確かめる。
// 専門(320〜361)はヒントなし(解説 explanation だけ)。1 レベル 15 問(LEVEL-LIST 第 11 章の指標)。
//
// 判断の土台にした決まり(問題文にも毎回書く):
//   BGP の経路の選び方(RFC 4271 9.1.2.2 の順を短くしたもの): LOCAL_PREF が大きい → AS パスが短い → MED が小さい(同じ隣の AS から受けた経路どうしだけ比べる)→ 先に覚えた方。LOCAL_PREF の既定は 100、自分の AS の中(iBGP)だけに伝わる
//   PC クラウド(levels-adv.js の 303〜306 と同じ): ピアリングで直接つないだ 2 つの仮想網だけが通信でき、たどって先へは行けない。ゲートウェイは「共用」の設定でピアリングの相手からも使える
//   ゼロトラスト(NIST SP 800-207): 場所で信用しない、資源ごと・セッションごとに人と端末の状態で許可、最小の権限、記録して見直す
const { loadFacts } = require('./build');

const CHECKED = 'Claude Fable 5.1 2026-10-25';

// 固定問題の表を読む。形(4 択・重複なし・根拠・理由)はここでも確かめ、壊れた行で出題しない
function loadFixed(file) {
  const rows = loadFacts(`fable-design/${file}`);
  const ids = new Set();
  for (const r of rows) {
    if (!r.id || ids.has(r.id)) throw new Error(`${file}: id が無いか重複 ${r.id}`);
    ids.add(r.id);
    if (r.checkedBy !== CHECKED) throw new Error(`${file} ${r.id}: checkedBy が違う`);
    if (typeof r.text !== 'string' || !r.text.trim()) throw new Error(`${file} ${r.id}: text が無い`);
    if (!Array.isArray(r.options) || r.options.length !== 4 || new Set(r.options).size !== 4) throw new Error(`${file} ${r.id}: 選択肢は重複なしの 4 個`);
    if (!Number.isInteger(r.answerIndex) || r.answerIndex < 0 || r.answerIndex > 3) throw new Error(`${file} ${r.id}: answerIndex`);
    if (typeof r.explanation !== 'string' || !r.explanation.trim()) throw new Error(`${file} ${r.id}: explanation が無い`);
    if (!r.reason || !r.reason.unique || !r.reason.wrongs) throw new Error(`${file} ${r.id}: reason(unique・wrongs)が無い`);
    if (typeof r.source !== 'string' || !r.source.trim()) throw new Error(`${file} ${r.id}: source が無い`);
    for (const t of [r.table, ...(r.tables || [])].filter(Boolean)) {
      if (!Array.isArray(t.headers) || !Array.isArray(t.rows) || t.rows.some((row) => row.length !== t.headers.length)) throw new Error(`${file} ${r.id}: 表の列数が合わない`);
    }
  }
  if (rows.length < 15) throw new Error(`${file}: 固定問題は 15 問以上(${rows.length})`);
  return rows;
}

// 1 レベル = 表 1 つ。make は seed で 1 問を選び、選択肢の順を混ぜる
function fixedLevel(title, file, kindName) {
  const rows = loadFixed(file);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    title, kind: '固', minDistinct: 15,
    make(rng) {
      const r = rng.pick(rows);
      const answer = r.options[r.answerIndex];
      const options = rng.shuffle(r.options);
      return {
        text: r.text,
        ...(r.table ? { table: r.table } : {}),
        ...(r.tables ? { tables: r.tables } : {}),
        options, answerIndex: options.indexOf(answer),
        explanation: r.explanation,
        kind: kindName,
        meta: { id: r.id, answer },
      };
    },
    verify(q) {
      const r = byId.get((q.meta || {}).id);
      if (!r) throw new Error(`${file}: 表に無い id ${(q.meta || {}).id}`);
      const answer = r.options[r.answerIndex];
      if (q.options.length !== 4 || q.options.slice().sort().join('\n') !== r.options.slice().sort().join('\n')) throw new Error(`${file} ${r.id}: 選択肢が表と違う`);
      if (q.options.filter((o) => o === answer).length !== 1) throw new Error(`${file} ${r.id}: 正解が 1 つに決まらない`);
      if (q.options[q.answerIndex] !== answer || q.meta.answer !== answer) throw new Error(`${file} ${r.id}: 正解の位置が違う`);
      if (q.text !== r.text || q.explanation !== r.explanation) throw new Error(`${file} ${r.id}: 本文か解説が表と違う`);
    },
  };
}

const FILES = {
  328: ['出ていく通信を寄せる', '328-bgp-outbound.json', 'cl328-bgp-outbound-v1'],
  329: ['入ってくる通信を寄せる', '329-bgp-inbound.json', 'cl329-bgp-inbound-v1'],
  351: ['ハイブリッド接続の設計', '351-hybrid-link.json', 'cl351-hybrid-link-v1'],
  352: ['仮想網を中継でつなぐ', '352-vnet-hub.json', 'cl352-vnet-hub-v1'],
  353: ['ゼロトラストの構成', '353-zero-trust-design.json', 'cl353-zero-trust-design-v1'],
  361: ['総合', '361-sogo.json', 'cl361-sogo-v1'],
};

const LEVELS = {};
for (const [lv, [title, file, kindName]] of Object.entries(FILES)) LEVELS[lv] = fixedLevel(title, file, kindName);

module.exports = { LEVELS, _test: { CHECKED, FILES, loadFixed } };
