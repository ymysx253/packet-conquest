'use strict';
// レベル別の問題の一覧 docs/LEVEL-TABLE.md を作る(2026-10-23 ユーザー依頼: 問題の内容一覧をレベルごとに分ける)。
// 元は docs/LEVEL-LIST.md(項目 1〜361 の表)と server/questions/cl/level100.json(1〜100 のレベルへの詰め方)。
// 「状態」は問題ができているか(server/questions/cl に登録されているか)。LEVEL-LIST.md・level100.json・問題を変えたら流し直す
// 使い方: node tools/build-level-table.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs/LEVEL-TABLE.md');
const { L100, LEVELS } = require(path.join(ROOT, 'server/questions/cl'));

// LEVEL-LIST.md の項目の行(| 項目 | 内容 | 例 | 答え方 | ヒント | 今の問題 | 元 | 試験 | 作り方 | 担当 |)
const rows = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'docs/LEVEL-LIST.md'), 'utf8').split('\n')) {
  const m = /^\| (\d+) \|(.*)\|\s*$/.exec(l);
  if (!m) continue;
  const c = m[2].split('|').map((x) => x.trim());
  if (c.length < 9 || rows.has(Number(m[1]))) continue;
  rows.set(Number(m[1]), { title: c[0], example: c[1], how: c[2], hint: c[3], exam: c[6], make: c[7], who: c[8] });
}

const STAGE_ORDER = ['入門', '初級', '中級', '上級', '専門'];
const EXAM = { 入門: 'IT パスポート', 初級: '基本情報', 中級: '応用情報・CCNA', 上級: 'ネットワークスペシャリスト・CCNA の上', 専門: 'ネットワークスペシャリストの午後' };
const HINT = { 入門: '説明カード(いつも出す)', 初級: 'ヒントボタン(式や手順)', 中級: 'ヒントは最初の 1 手', 上級: 'ヒントなし(解説だけ)', 専門: 'ヒントなし(解説だけ)' };
const status = (n) => (LEVELS.has(n) ? 'できた' : rows.get(n) && /F/.test(rows.get(n).who) ? 'Fable' : /構成図|設定|ターミナル/.test(((rows.get(n) || {}).how || '') + ((rows.get(n) || {}).title || '')) ? '仕組み待ち' : 'まだ');

const out = [];
out.push('# レベル別の問題の一覧(1〜100)');
out.push('');
out.push(`作成: ${new Date().toISOString().slice(0, 10)}。**この文書は \`node tools/build-level-table.js\` が \`docs/LEVEL-LIST.md\` と \`server/questions/cl/level100.json\` から作る。直接書き換えない**(直すなら元を直して流し直す)。`);
out.push('');
out.push('- レベルは 1〜100(2026-10-23 ユーザー決定)。1 レベルに LEVEL-LIST の項目が 3〜5 つ入り、問題は同じレベルの中で項目が入れ替わって出る');
out.push('- 90〜100 は神レベル(試験の外の上級者向け)。特別な場所に置く(置く場所はあとで決める)');
out.push('- 列: **項目** = LEVEL-LIST の項目番号 / **答え方** = ○×・3 択・4 択・入力・表を読む・並べ替え・構成図・設定・模擬ターミナル / **作り方** = 生(計算・模擬で生成)・表(用語の表から)・固(固定)/ **担当** = O(Opus)・O→F(Opus が作り Fable が確かめる)・F(Fable)/ **状態** = できた・まだ・仕組み待ち(構成図・設定・模擬ターミナルの仕組みが要る)・Fable(Fable に頼む)');
out.push('');

// 段ごとのまとめ
out.push('## まとめ');
out.push('');
out.push('| 段 | レベル | 試験の目安 | ヒント | 項目 | できた | 問題のあるレベル |');
out.push('|---|---|---|---|---|---|---|');
for (const st of STAGE_ORDER) {
  const [lo, hi] = L100.bands[st];
  let items = 0, done = 0, lvReady = 0;
  for (let lv = lo; lv <= hi; lv++) { const e = L100.levels[lv]; items += e.items.length; const d = e.items.filter((n) => LEVELS.has(n)).length; done += d; if (d) lvReady++; }
  out.push(`| ${st} | ${lo}〜${hi} | ${EXAM[st]} | ${HINT[st]} | ${items} | ${done} | ${lvReady}/${hi - lo + 1} |`);
}
out.push('| 神 | 90〜100 | 試験の外 | — | — | — | — |');
out.push('');

for (const st of STAGE_ORDER) {
  const [lo, hi] = L100.bands[st];
  out.push(`## ${st}(Lv${lo}〜${hi})`);
  out.push('');
  out.push(`試験の目安: ${EXAM[st]}。${HINT[st]}。`);
  out.push('');
  for (let lv = lo; lv <= hi; lv++) {
    const e = L100.levels[lv];
    const d = e.items.filter((n) => LEVELS.has(n)).length;
    out.push(`### Lv${lv}(${e.items.length} 項目、できた ${d})`);
    out.push('');
    out.push('| 項目 | 内容 | 問題の例 | 答え方 | ヒント | 試験 | 作り方 | 担当 | 状態 |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    for (const n of e.items) {
      const r = rows.get(n) || {};
      out.push(`| ${n} | ${r.title || ''} | ${r.example || ''} | ${r.how || ''} | ${r.hint || ''} | ${r.exam || ''} | ${r.make || ''} | ${r.who || ''} | ${status(n)} |`);
    }
    out.push('');
  }
}
out.push('## 神(Lv90〜100)');
out.push('');
out.push('試験の範囲を超える上級者向け。特別な場所に置く(置く場所はあとで決める)。中身の方向(案): 断片的な記録やパケットの一覧からの推理、複数拠点・クラウドにまたがる障害を模擬ターミナルで調べて直す、プロトコルの細かい動きを追う、条件つきで最も良い設計を組む。守る側・調べる側に寄せ、ゲーム内の架空のネットワークだけで動かす(本物に使える攻撃の手順は入れない)。作るのは Fable。');
out.push('');

fs.writeFileSync(OUT, out.join('\n'));
console.log(`docs/LEVEL-TABLE.md を書いた(項目 ${rows.size}、レベル 1〜89 + 神)`);
