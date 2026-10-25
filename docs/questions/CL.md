# 新しい番号の問題の作り方(CL)

作成: 2026-10-22。`docs/LEVEL-LIST.md`(学ぶ順に 1〜361 を振った一覧)の番号で問題を作るときの決まり。担当(サブエージェント)は、この文書と `COMMON.md` に従う。

## 1. 置き場所(担当ごとに分ける。同じファイルを 2 人で直さない)

| 段 | 番号 | 問題のファイル | 表のフォルダ | 担当のテスト |
|---|---|---|---|---|
| 入門 | 1〜67 | `server/questions/cl/levels-intro.js` | `server/questions/data/cl/intro/` | `test/cl-intro.js` |
| 初級 | 68〜158 | `server/questions/cl/levels-basic.js` | `server/questions/data/cl/basic/` | `test/cl-basic.js` |
| 中級 | 159〜252 | `server/questions/cl/levels-mid.js` | `server/questions/data/cl/mid/` | `test/cl-mid.js` |
| 上級 | 253〜319 | `server/questions/cl/levels-adv.js` | `server/questions/data/cl/adv/` | `test/cl-adv.js` |
| 前の生成器の口 | 一覧の「今の問題」列が埋まっているレベル | `server/questions/cl/levels-legacy.js` | なし | `test/cl-legacy.js` |
| Fable: 冗長と経路(束 A・B) | 255・256・259・260・262・263・266・268・269・327 | `server/questions/cl/levels-fable-route.js` | `server/questions/data/cl/fable-route/` | `test/cl-fable-route.js` |
| Fable: 診断と記録(束 C・D・F3 の一部) | 230・285・296・323・342・343・349 | `server/questions/cl/levels-fable-diag.js` | `server/questions/data/cl/fable-diag/` | `test/cl-fable-diag.js` |
| Fable: 設計の固定問題(束 E・F1・F2・F3 の一部) | 328・329・351・352・353・361 | `server/questions/cl/levels-fable-design.js` | `server/questions/data/cl/fable-design/` | `test/cl-fable-design.js` |
| 専門の O の行(生成・入力) | 320・321・334・335・337・338・340・348 | `server/questions/cl/levels-expert.js` | `server/questions/data/cl/expert/` | `test/cl-expert.js` |
| 専門の O の行(表) | 332・333・336・339・341・346・347・350 | `server/questions/cl/levels-expert-facts.js` | `server/questions/data/cl/expert/` | `test/cl-expert-facts.js` |

- 段の担当は、自分の段のうち一覧の「担当」が O(Opus)の行だけを作る。O→F(Fable が確かめる)と F(Fable)の行、構成図・設定・模擬ターミナルの行(仕組みがまだ無い)は作らない
- F・O→F の行は Fable 5.1 が作る(2026-10-25。上の 3 つのファイル。LEVEL-LIST 第 10 章 (b) の束で分けた)。構成図・設定・模擬ターミナルの行は仕組みができてから。固定(作り方「固」)は `kind: '固'`、1 レベル 15 問(第 11 章の指標)を表(1 行 = 1 問。根拠・正解が 1 つに決まる理由・checkedBy つき)に置き、seed で 1 問を選んで選択肢の順を混ぜる。「生+固」は数値・構成を生成し、状況の文と判断は固定(verify を必ず書く)。表・固定の行の checkedBy は「Claude Fable 5.1 2026-10-25」
- 前の生成器でまかなえる行(「今の問題」列が埋まっている行)は、段の担当は作らず、前の生成器の口の担当が作る
- 共通の道具は `server/questions/cl/build.js`(○×・n 択・表から作る)と `server/questions/rng.js`(乱数)。共通の道具に足りないものは自分の段のファイルの中に書く(共通のファイルは直さない)

## 2. 1 レベルの書き方

```js
const LEVELS = {
  12: {
    title: 'スイッチの役割',   // 一覧の「内容」
    kind: '表',               // 一覧の「作り方」: '生' | '表' | '生+固'
    make(rng, ctx) { return { text, options, answerIndex, explanation, card, kind: 'cl12-switch-role-v1' }; },
    verify(q) { /* 答えを別の方法で解き直して確かめる(生成のレベルは必ず書く)。合わなければ throw */ },
    minDistinct: 30,          // 違う問題が何通り作れるべきか(表は第 11 章の指標。生成は 1000)
  },
};
module.exports = { LEVELS };
```

## 3. 問題の形

- `text`: 問題文(日本語)。架空の値だけ。アドレスは 192.0.2.0/24・198.51.100.0/24・203.0.113.0/24・10.0.0.0/8・172.16.0.0/12・192.168.0.0/16 など文書用・プライベートの範囲。実在の企業・実在のサーバーのアドレス・本物に使える攻撃の手順は書かない
- 選ぶ問題: `options`(2〜4 個。重複なし)と `answerIndex`。○× は `options: ['○', '×']`(build.js の `trueFalse`)。3 択は 3 個
- 入力の問題: `answerKind: 'text'` と `fields`(`COMMON.md` 第 1 章。format・label・accept)。`accept` は正規形の正解(`normalize.js`)
- `explanation`: 答えたあとの解説(必ず。なぜその答えか、誤答のどこが違うか)
- `card`: 入門だけ。問題の前に見せる説明カード(2〜3 行。読めば解ける程度)
- `hint`: 初級だけ。ヒントボタンで見せる式や手順(例: /26 は 256 ÷ 4 = 64 個ずつ)
- `firstStep`: 中級だけ。ヒントの最初の 1 手
- 上級はヒントなし(解説だけ)
- `kind`: 型の名前(`cl<番号>-<短い名前>-v<版>`)。固定問題を DB に テンプレート id・seed・版 で残すときの id
- ヒントの決まり(`CURRICULUM.md` 第 7.5 節): ヒントを使った正解も 1 回に数える。ほかの人の拠点を攻めるときはヒントを出さない(出すかどうかは world.js が決める。問題の側は書いておくだけ)

## 4. 表(FactBank)

- 1 ファイル 1 つの話題。`{ "note": "…", "rows": [ { "id", "ja", "attrs": { … }, "source": "RFC 791 など", "checkedBy": "Claude Opus 5.5 2026-10-22" } ] }`
- `source`: 根拠(RFC・IEEE・IANA の番号、一般的な定義なら「一般的な定義」)。`checkedBy`: 確かめた者と日付。checkedBy の無い行は使わない
- 文章は自分の言葉で短く。教科書・試験の文を写さない
- 似ていて紛らわしいものを誤答に並べるのはよいが、正解が 2 つになる並べ方はしない(テストで確かめる)

## 5. 確かめ方(test/cl.js がまとめて行う)

- 全レベル: seed を変えて作り、形(問題文・選択肢の重複・answerIndex の範囲・解説)を確かめる。入力の問題は accept を `normalize.judge` に通して正解になるかを確かめる
- `verify` があれば全部の問題に通す(生成のレベルは必ず書く。1 万問)
- `minDistinct` だけ違う問題が作れるかを数える
- 担当のテスト(`test/cl-<段>.js`)は、そのレベルならではの確かめ(境界の値・紛らわしい選択肢が正解にならないこと など)を書く。test/cl.js が自動で読む
