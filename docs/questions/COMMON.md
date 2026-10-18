# 問題の共通仕様(Lv11 以上)

作成: 2026-10-18 / 対象: `design-11-50.md` 旧第 0 章「共通の約束」と `design-51-100.md` 旧第 1 章「共通の仕様」を 1 つに統合したもの

2 人の担当が同時に書いた共通部分を突き合わせ、**名前を 1 つに決め、両方にしかない項目は両方取り込み、矛盾する規則は推奨と理由を書いた**。どうしても決められないものは第 10 章に回してある。レベルごとの題材・例題は各設計書にあり、本書は「入力式の問題を同じ口で扱うための土台」だけを書く。コードはまだ変えていない。

守ること(`CLAUDE.md`、`LEVELS.md` 第 1 章・第 5 章): 難しさは問われる知識の難しさだけ。答えはサーバーだけが持つ。計算で決まる答えはプログラムで生成し、別実装で解き直す検証テストを付ける。

---

## 0. 統合にあたっての決定(両設計書の差異の一覧)

| 項目 | design-11-50 | design-51-100 | 決定 | 理由 |
|---|---|---|---|---|
| 入力の種類を表す項目名 | `kind` | `format` | **`format`** | `kind` は DB の `nodes.kind` / `regions.kind` と `answerKind` で既に別の意味に使われている。`format` は「表記の形」という意味がそのまま |
| 入力欄の持ち方 | `fields: [{ name, label, kind, accept }]`(複数欄) | `format` / `inputHint` / `accept` を問題の直下に 1 つ | **`fields` 配列に統一**(1 欄でも長さ 1 の配列) | 11〜50 は複数欄が前提(Lv14・18・49 など)。形を 1 つにすると `world.answer` と判定器が 1 本で済む |
| 入力欄の例示 | (なし) | `inputHint` | **`fields[].hint`** | 欄ごとに違う例示が要る(Lv16 の「何番目」と「CIDR」) |
| 複数欄の比較 | `compare: 'ordered' / 'set'` | (なし。`prefixplan` が欄内で集合比較) | **`compare`** を取り込む。`prefixplan` も残す | VLSM(21〜30)は同サイズ区画の入替を許す必要がある |
| 制約で判定する問題 | (なし) | `verifier` | **`verifier`** を取り込む | Lv99 の計画問題は正解が複数あり、列挙できない |
| 整数の format 名 | `int` | `number` | **`number`** | Lv47 は小数 1 桁(10.8 ms)を答えさせるので「整数」の名は合わない |
| 整数の単位語 | 末尾の単位語(番目・個・台 …)を除く | 単位付きは不正解 | **除く(推奨)** | 問題文が単位を指定するので単位は知識でない。「1556番目」と打つのは自然。換算はしないので、違う単位で書けば値が合わず不正解になる |
| CIDR の format 名 | `cidr4` / `cidr6` | `ipv4cidr` / `ipv6cidr` | **`ipv4cidr` / `ipv6cidr`** | `ipv4` / `ipv6` の名前と並ぶ(ipv4 + cidr と読める) |
| 語彙入力の format 名 | `term` | `token` | **`token`** | `term` は技術用語マスター `terms.json` と混同する。語彙表は `vocab.json` に分ける |
| 語彙表のファイル | `data/facts/terms-vocab.json` | `data/vocab.json` | **`server/questions/data/vocab.json`**(語彙 id ごとの表を 1 ファイルに) | 語彙表は判定器が読むもので FactBank(出題の知識カード)とは役割が違う |
| FactBank の置き方 | `data/facts/` にファイルを分ける(`v4-ranges.json` …) | `data/facts.json` 1 つ | **`server/questions/data/facts/` に表ごとのファイル** | 表ごとに人が確認する(`checkedBy`)ので、ファイル単位で確認と差分が追える |
| 判定器のファイル名 | `judge.js` | `normalize.js` | **`normalize.js`**(`normalize` と `judge` の両方を持つ) | 中身の大半は正規化。テスト名 `test/normalize.js` と揃う |
| MAC アドレスの安全範囲 | ローカル管理(第 2 桁 2/6/a/e)+ RFC 7042 の文書用 `00:00:5e:00:53:xx` | `02:` 始まりのローカル管理のみ | **両方を許可する(推奨)**。既定はローカル管理、文書用は EUI-64 の「0 → 1」の例にだけ使う | ローカル管理だけだと U/L ビットの反転が常に 1 → 0 になり、Lv34 の知識が半分しか問えない。文書用範囲は実在ベンダーの OUI ではない。採否は第 10 章 4 |
| MAC の正規形 | 区切りなし 12 桁(`00005e00537a`) | (なし) | **`:` 区切り小文字(`00:00:5e:00:53:7a`)** | 正解の表示に `accept[0]` を使う(第 2 章)ので、読める形にしておく。比較は正規化後なので判定は同じ |
| ドメインの接尾辞 | ゲーム内専用(未指定) | `.example`(RFC 2606) | **`.example`(推奨)** | 実在しないことが規格で保証され、安全リンタの許可リストが 1 行で済む。採否は第 10 章 5 |
| 生成器の呼び方 | `make(level, base, rng)` | `make(level, node, rng)` | **`make(level, node, rng)`** | 61〜70 は拠点名からホスト名を作る(`www.shibuya.example`)。`base` / `span` は `node` から取る |
| 版の持ち方 | 「版」 | 定数 `VERSION = '2026.10'` | 各生成器ファイルの定数 **`VERSION`**、問題には **`generatorVersion`** | DB.md 3.4 の項目名に合わせる |
| シミュレータの最小版 | `server/sim/netgen-min.js`、`forward.js` | `netgen-min.js`、`forward-min.js` | **`netgen-min.js` / `forward-min.js`** | 「最小版」であることを名前で揃える。本物(#9・#10)ができたら置き換える |

---

## 1. 問題オブジェクトの拡張

既存(`subnet.js` / `basics.js`)は `{ text, options(4), answerIndex, explanation, table?, meta, type, level }` で、`world.answer` は `choice === pend.answerIndex` だけを判定する。Lv11 以上は入力式が大半なので、`DB.md` 3.4 の `answerKind` に合わせて次を足す(`LEVELS.md` 第 6 章 #1・#2)。

```
{
  // 既存
  text, table?, explanation, meta, type, level,
  // 共通で足すもの
  tables?,                       // 表が 2 つ以上のとき [{ title, headers, rows }, …]
  defenseNote,                   // 守る側の一文(必須。空は安全リンタで弾く)
  templateId, seed, generatorVersion,
  answerKind: 'choice' | 'text',
  // choice のとき(既存どおり)
  options, answerIndex,
  // text のとき
  fields: [ { name, label, format, hint?, digits?, vocab?, accept: [正規形…] }, … ],
  compare?: 'ordered' | 'set',   // 省略は ordered
  verifier?: { name, args }      // 制約で判定する問題だけ(Lv99)
}
```

| 項目 | 配信 | 内容 |
|---|---|---|
| `text` | する | 本文。N 番目の数え方(1 始まり)・単位・規約など、答えの形に関わる約束は本文に毎回書く |
| `table` / `tables` | する | 表。1 つなら既存の `table = { headers, rows }`。2 つ以上なら `tables = [{ title, headers, rows }, …]`(`LEVELS.md` 第 6 章 #3 の小拡張。画面は両方を描く) |
| `answerKind` | する | `choice`(4 択)/ `text`(入力)。`command` / `config` はフェーズ 3 以降(DB.md 3.4) |
| `options` | する | 4 択の選択肢(choice のとき) |
| `answerIndex` | **しない** | 正解の番号(choice のとき)。結果と一緒に返す |
| `fields[].name` | する | 欄の識別子(`network`、`broadcast`、`count` …)。解答メッセージの並びはこの順 |
| `fields[].label` | する | 欄の見出し(「ネットワークアドレス」「大きい方から 1 番目」) |
| `fields[].format` | する | 入力の種類(第 3 章の表)。画面は placeholder と IME の初期状態(半角)を決めるのに使うだけ |
| `fields[].hint` | する | 欄の例示(「例: 10.0.1.0/24」)。答えそのものを示唆しない定型文に限る |
| `fields[].digits` | する | `bin` / `hex` で桁数を指定するとき(「8 桁で」)。無ければ先頭 0 の有無を同一視 |
| `fields[].vocab` | する | `token` で使う語彙表の id(`v4-kind`、`diag-cause`、`switch-action` …) |
| `fields[].accept` | **しない** | 正規化済みの正解の配列。どれかに一致すれば正解。`accept[0]` が結果画面に出す正解(正規形) |
| `compare` | する | `ordered`(欄ごとに照合)/ `set`(同じ format の欄を多重集合として照合。VLSM だけ) |
| `verifier` | **しない** | 正解との一致ではなく制約で判定する問題の判定器名と引数(第 4 章) |
| `explanation` | する(結果と一緒に) | 解説。よくある間違いを示してよい |
| `defenseNote` | する(結果と一緒に) | 「守る側ならどう使うか」の一文(第 6 章・`LEVELS.md` 第 6 章 #8。攻守同重) |
| `templateId` / `seed` / `generatorVersion` | **しない** | 固定問題の保存に使う(第 5 章)。`provisional` の判定にも使わない |
| `type` | **しない** | 生成器の種類の短い名前(既存。検証テストの `switch (q.type)` が使う) |
| `meta` | **しない** | 検証テストが使う真の値(パラメータと中間値)。既存どおり |

### 1.1 `world.ask` / `world.answer` の変更点

- `world.ask` の payload(いまは `{ t: 'question', qid, nodeId, mode, level, provisional, text, options, table }`)に `answerKind` / `tables` / `fields`(`name` / `label` / `format` / `hint` / `digits` / `vocab` だけ)/ `compare` を足す
- `pending` に `fields`(accept 込み)/ `compare` / `verifier` / `defenseNote` を持たせる
- `world.answer` は `answerKind === 'text'` なら第 4 章の判定を行う。不正解時の待ち時間倍増(SECURITY.md F4)と最短解答時間(F6)はそのまま
- 結果 `{ t: 'result', qid, correct, answerIndex, answers, explanation, defenseNote, outcome, cooldownUntil, cooldownMs }`。`answers` は欄ごとの `accept[0]`(入力式のとき)。`defenseNote` を新たに返す
- 解答メッセージは `{ t: 'answer', qid, choice }`(既存)と `{ t: 'answer', qid, inputs: [文字列, …] }`(入力式)の 2 形。`server/index.js` の検査(F3)は `inputs` が配列で長さ 12 以下、各要素が文字列で 200 文字以下(`prefixplan` の欄だけ 1,000 文字以下)でなければ黙って捨てる。欄の数が `fields.length` と違うものも捨てる

---

## 2. 入力欄の仕様(画面)

- 欄は `fields` の数だけ縦に並べ、各欄に `label` と placeholder(`hint`)を出す。1 欄のときは 1 行のテキスト入力 1 つ
- **Enter で送信**(複数欄では最後の欄の Enter、または送信ボタン)。送信ボタンも置く(スマートフォン用)
- **Tab 補完なし、候補ボタンなし**(コマンド式ではないが「選ばせない」方針を揃える。`token` の語彙だけ補完を付けるかは第 10 章 6)
- 空文字・空白のみの欄があるときは送らない(全欄が埋まるまで送信ボタンを無効にする)
- 1 問につき送信は 1 回(`qid` で束ねる。再送は「この問題はもう終わっています」)。送信後は欄を無効化する
- 入力の長さは欄ごとに 200 文字まで。`prefixplan` は複数行(改行区切り)を 1 つの文字列として送り 1,000 文字まで
- 結果(正誤・正解・解説・defenseNote)は 4 択と同じ枠に出す。正解の表示は欄ごとの `accept[0]`(正規形)。`compare: 'set'` の問題は欄のラベルを「大きい方から 1 番目・2 番目 …」にして区画名を併記する案がある(第 10 章 8)
- 文字種の案内文を欄の下に固定で出す: 「半角で入力。IPv6 の省略形、先頭の 0、大文字小文字は自動でそろえます」
- 形式が違う入力(IP の桁数が足りない等)も**そのまま不正解**にする(再入力を許すと総当たりができる。SECURITY.md の「画面は信用しない」原則)。形式エラーだけ 1 回再入力を許すかは第 10 章 3

---

## 3. 正規化の規則(`normalize(format, s, opts)`)

サーバー側の関数。判定の前に**正解側にも同じ関数を通す**(`accept` の全要素は正規形であることをテストで確認する)。

**共通の前処理**(すべての format): 前後の空白を除く → 全角英数字・全角記号(`．：／－，`、全角空白)を半角に → 連続する空白を 1 つに → 小文字化(数字だけの format と `yesno` 以外)。

| format | 正規形 | 規則 | 受け付ける例(→ 正規形) | 形式不備(そのまま不正解) |
|---|---|---|---|---|
| `number` | 10 進(整数、または小数の末尾 0 を除いたもの) | 桁区切り `,` と全角数字を除く。先頭 `+` と先頭 0 は無視。末尾の単位語(番目・個・台・本・行・回・バイト・ビット・秒・ミリ秒・ms・マイクロ秒・µs・us)を除く。小数は問題文が許すときだけ(Lv47)。換算はしない | `１,５５６番目` → `1556`、`10.80` → `10.8` | 数でない、小数を許さない問題で小数 |
| `ipv4` | `a.b.c.d` | 4 オクテット、各 0〜255、各オクテットの先頭 0 を除く | `０１０.０７７.２００.０` → `10.77.200.0`、`010.000.001.001` → `10.0.1.1` | 3 オクテット、256 以上 |
| `ipv4cidr` | `ipv4/0〜32` | アドレス部は `ipv4`、`/` は `／` も可。`10.0.1.0 255.255.255.0` の形も受けてプレフィックス長に変換。**アドレス部はネットワークアドレスに切り詰めない**(入力と正解を同じ規則で比べるので `10.0.1.5/24` は `10.0.0.0/24` と同一視せず不正解) | `１０.0.0.0／２４` → `10.0.0.0/24` | `/` のみ、マスクが連続 1 でない |
| `ipv6` | RFC 5952 の正規形 | `::` を展開して 8 グループに → 最長のゼロ連続 1 か所を `::`(同じ長さなら先頭側)、先頭ゼロ省略、小文字。既存 `basics.v6Canonical` を使う。末尾の `/n` は別 format | `2001:0DB8:0:0:0:0:0:1` → `2001:db8::1` | `::` が 2 か所、グループ 9 個以上、`[]` 付き |
| `ipv6cidr` | `ipv6/0〜128` | アドレス部は `ipv6`。切り詰めない(同上) | `2001:DB8:5C7E:9000::/52` → `2001:db8:5c7e:9000::/52` | |
| `prefixlen` | `21`(数字だけ) | `/21`、`21`、`／21` を同一視。ドット表記のマスク(`255.255.248.0`)も連続ビットなら同一視 | `/21` = `21` = `255.255.248.0` → `21` | `255.255.247.0`(連続ビットでない) |
| `bin` | 0/1 の列 | 空白・`.`・`_` を除く。`digits` が無ければ先頭 0 を除く(`0` は `0`)。`digits` があればその桁数に 0 埋めし、長いものは不備 | `1011 0010` → `10110010` | 0/1 以外、`digits` より長い |
| `hex` | 小文字の 16 進 | `0x` を除き小文字化。先頭 0 は `bin` と同じ扱い | `0xE5` → `e5` | 16 進でない |
| `mac` | `xx:xx:xx:xx:xx:xx`(小文字) | `:` `-` `.` 空白を除いて 12 桁(OUI・機器識別部は 6 桁)の 16 進にし、2 桁ずつ `:` で区切る | `00-00-5E-00-53-7A` = `0000.5e00.537a` → `00:00:5e:00:53:7a` | 6 桁・12 桁以外 |
| `yesno` | `yes` / `no` | `○ ◯ 〇 はい yes y する 転送する 使える 収まる` → `yes`。`× ✕ ✗ いいえ no n しない 転送しない 使えない 収まらない` → `no`。問題ごとの動詞は語彙表 `yesno` に足す | `○` → `yes`、`転送しない` → `no` | 表にない語 |
| `token` | 語彙 id(英字) | `vocab.json` の `fields[].vocab` で指す表で、別名(日本語・英語・略称・表記ゆれ)→ id に正規化。空白・全角半角・「アドレス」の有無を無視 | `APIPA`、`link-local`、`リンクローカルアドレス` → `v4-linklocal`;`全ポート`、`フラッディング`、`flood` → `flood`;`逆引き`、`PTR` → `dns` | 語彙表に無い語 |
| `addrport` | `ipv4:1〜65535` | `ipv4` + `:`(`：` も可)+ ポート。IPv4 のみ(IPv6 の addr:port は 51〜100 の範囲では出ない) | `２０３.0.113.10：51002` → `203.0.113.10:51002` | ポート 0、`:` なし |
| `ifname` | 短い小文字(`gi0/1`、`gi1/0/24`、`eth0`、`null0`) | `GigabitEthernet0/1` / `Gi0/1` / `gi 0/1` / `g0/1` → `gi0/1`。`Ethernet0` / `Eth0` → `eth0`。`Null0` / `null 0` → `null0` | `GigabitEthernet 1/0/24` → `gi1/0/24` | 番号が無い |
| `devname` | 小文字、記号なし | 表に書いた機器名(R1、SW1、PC2 …)を小文字化し、ハイフン・空白を除く | `pc-2`、`PC 2` → `pc2` | |
| `dnsname` | 小文字、末尾 `.` なし | 小文字化、末尾の `.` を除く。`in-addr.arpa` / `ip6.arpa` のラベルの全角 `.` も半角に | `23.7.0.10.in-addr.arpa.` → `23.7.0.10.in-addr.arpa` | ラベルが空 |
| `aclverdict` | `permit 10` / `deny 20` / `deny implicit` | 2 トークン「動作 行番号」。順不同(`10 permit` ≡ `permit 10`)。`許可` → `permit`、`拒否` → `deny`、`暗黙`・`暗黙の拒否`・`implicit` → `implicit`。`deny` だけで行番号なしは不正解(行番号を問う知識なので)。Lv96 は行番号部分だけを問う(`fields[].digits` ではなく本文で指定) | `拒否 10` → `deny 10` | 行番号も implicit も無い |
| `prefixplan` | 行の集合 | 改行・`,`・`;` で分けた各行を `名前 ipv4cidr [ipv6cidr]` として読む。名前は `devname` の規則、各欄はそれぞれの規則。順序は無視して**集合**として比較 | | 行数が要件の拠点数と違う、1 行の欄数が違う |

- `normalize` は冪等(`normalize(f, normalize(f, x)) === normalize(f, x)`)。形式不備は `null` を返し、判定器はそれを不正解にする(例外にしない)
- 語彙表 `vocab.json` の形: `{ "<vocab id>": { "<token>": ["別名", …], … } }`。語彙 id の例: `v4-kind`(Lv31・38〜40)、`v6-kind`(Lv33・39・40)、`diag-cause`(Lv98。`mask / gateway / duplicate / route / ttl / acl / nat / dns`)、`switch-action`(Lv100。`flood / drop`)、`yesno`、`aclverdict`(動作と implicit の別名)。別名 → id の全数を `test/normalize.js` で確認する

---

## 4. 複数欄の判定(`judge(q, inputs)`)

- `answerKind === 'choice'`: `choice === answerIndex`(既存どおり)
- `answerKind === 'text'`、`compare: 'ordered'`(既定): 欄 `i` ごとに `normalize(fields[i].format, inputs[i], fields[i])` が `fields[i].accept` のどれかに一致。**全欄一致で正解**(部分点は作らない。突破は正解 1 回の原則。欄数の上限は第 10 章 2)
- `compare: 'set'`: 全欄が同じ format であることが前提。入力の正規形の多重集合と、各欄の `accept[0]` の多重集合が一致すれば正解(VLSM で同サイズ区画の入替を許す)。欄の数と各欄のサイズは要件から決まるので、入れ替えても一意に照合できる
- `verifier` があるとき: 一致ではなく `verifiers[verifier.name](verifier.args, 正規化済み inputs)` の真偽で判定する(Lv99 の `plan-verifier`: 重ならない・親に収まる・各要件を満たす・/64 が親 /48 内で重複しない)。`accept[0]` には正準解を置き、結果画面の正解表示に使う。採否は第 10 章 9
- 1 つでも形式不備(`null`)の欄があれば不正解。再入力は許さない(第 2 章)
- 不正解のときの効果は 4 択と同じ(F4 の待ち時間倍増)。正解のときは `apply`(既存)

---

## 5. seed 付き乱数と固定テンプレートの保存の形

### 5.1 用語

- **生成器**: パラメータと seed から**計算**で答えが決まる。別実装で再計算して検証
- **固定テンプレート**: 文章の型は固定で、差し込む値(サービス名・番号・アドレス)を FactBank から seed で選ぶ。答えは表の値。表は人が一度確認し、テストは表照合と誤答の非重複
- **シナリオ生成器**: 架空の構成を作り、既知の誤りを 1 つ注入し(plant-then-perturb)、シミュレータで真実を計算し、独立の検証器で一意性を確認してから保存(`LEVELS.md` 第 5 章)
- どれも (templateId, seed, generatorVersion) で保存する点は同じ

### 5.2 乱数

- `server/questions/rng.js` の **`makeRng(seed)`**(mulberry32。32 ビットの決定的 PRNG)が `{ rand(a, b), pick(arr), shuffle(arr), next() }` を返す。既存 `subnet.js` の `rand / pick / shuffle` と同じ呼び方
- Lv11 以上の生成器は `rng` を引数で受け取り、**`Math.random` を直接使わない**。これで (templateId, seed, generatorVersion) から同じ問題が再現できる(`LEVELS.md` 第 5 章 seed 方式、`DB.md` 3.4)
- 既存 Lv1〜10 は `Math.random` のまま(その場生成)。`makeRng` に揃えるかは第 10 章 7

### 5.3 生成器の形

- 各生成器モジュールは **`make(level, node, rng)`** を公開する(`node` から `base` / `span` / `name` を使う)。問題に `templateId`(例: `napt-add-v1`、`v4-special-behavior-v1`。`<題材>-v<版>`)、`seed`、`generatorVersion`(ファイル先頭の定数 `VERSION = '2026.10'`)を入れる
- `server/questions/index.js` の `getQuestion({ level, node, seed })`: `seed` が無ければ乱数で作り、作った seed も `q.seed` に残す(その場生成でも再現できる)。レベル → 生成器の対応は `BY_LEVEL` 1 か所。`MAX_IMPLEMENTED` を段ごとに上げる
- 固定テンプレートの FactBank は `server/questions/data/facts/<表名>.json`。各行に `id`・`ja`・`attrs`(属性)・`levelHint`・`checkedBy`(確認者と日付)を持たせ、**`checkedBy` が空の行は本番の生成に使わない**(テストで assert)。ポート番号・AD 値・DHCP の順序など**変わらない事実**だけを置き、時とともに変わる概念は置かない

### 5.4 保存の形(`DB.md` 3.4 `questions` との整合)

- 保存するスナップショットは `rendered`(= 配信する項目。`text` / `table` / `tables` / `answerKind` / `options` / `fields` の `name・label・format・hint・digits・vocab` / `compare`)と `answer`、`explanation`、`defenseNote`。版が変わっても同じ問題を再現するため
- `answer` の形: 4 択は `{ index }`、入力式は `{ fields: [{ name, accept }], compare?, verifier? }`。DB.md 3.4 の例にある `answer.accept` は 1 欄のときの `fields[0].accept` の写しとして残す(既存の例と後方互換)。**`fields` / `compare` / `verifier` / `tables` は DB.md 3.4 への追記が要る**(本書では DB.md を変えていない)
- 拠点 × レベルで `status: "active"` はつねに 1 つ。クリアで `cleared` にして次の seed を生成、期限で `expired`(既存の決定)
- 生成・検証は手元/CI のスクリプト(`npm.cmd run questions:gen`、`tools/questions-gen.js`)で行い、保存前に安全リンタを通す。App Service 上では回さない
- 計算生成の問題はその場生成でも正確さは保てる。`DESIGN.md` 3.5(固定問題は拠点に紐づき、クリアまで同じ問題)に従って保存するか、「seed だけ保存し本文は再生成」で済ませるかは第 10 章 1

---

## 6. 誤答(ダミー)と解説・defenseNote の共通規則

### 6.1 4 択の誤答

- 正解と**値として**重複しないこと(文字列ではなく `normalize` 後の値で比較)。`buildOptions` の流儀を踏襲し、候補が足りないときの filler も正解と異なることを確認する
- 「ありがちな間違い」から作る: 境界の取り違え(ブロードキャスト ↔ ネットワーク、最初 ↔ 最後)、プレフィックス ±1、0 始まり ↔ 1 始まり、ビット反転忘れ、反転するビットの位置違い(0x02 ↔ 0x01 / 0x80)、ff:fe の挿入位置違い、10 進 ↔ 16 進の読み違い、オクテット境界で丸める誤り、×8 忘れ、+1 し忘れ(seq/ack)、「ルータが転送する」の有無で対立する文
- 固定テンプレートの誤答は同じ表の別行から取り、正解行と属性が異なることをテストする
- 入力式が主のレベルでも誤答の作り方を書くのは、**(a) 判定器ができるまでの暫定 4 択配信**(第 10 章 10)と **(b) 解説で「よくある間違い」を示す**ため。入力式では `accept` に「ありがちな間違い」が**入らない**ことをテストする

### 6.2 解説と defenseNote

- `explanation` は計算の筋道を書く(既存どおり)。誤答の由来(よくある間違い)を添えてよい
- `defenseNote` は「守る側ならどう使うか」の一文で、**必須**(空は安全リンタで弾く。`LEVELS.md` 第 6 章 #8 攻守同重)。結果と一緒に配信する
- 計算・規則の問題では守る側の視点が薄くなるため、**段ごとの定型 + パラメータ差し込み**を許す(11〜50 の定型は `design-11-50.md` 第 0 章)。Lv11〜40 で省略を許すかは第 10 章 11

---

## 7. 安全規則(`LEVELS.md` 第 5 章「安全面」の具体化)

| 対象 | 使ってよい範囲 |
|---|---|
| IPv4 内側 | `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` |
| IPv4 外側・文書用 | `192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24` |
| IPv4 特殊(31〜40 の題材として) | `127.0.0.0/8`、`169.254.0.0/16`、`224.0.0.0/4`、`255.255.255.255`、`0.0.0.0`。境界の例(`172.32.0.1` など)は種別判定の題材に限る |
| IPv6 | `2001:db8::/32`(文書用)、`fd00::/8`、`fe80::/10`、`ff02::/16`(リンクローカルマルチキャスト)、`::`、`::1` |
| MAC | 既定は**ローカル管理**(第 2 桁が 2・6・a・e。`02:…`)。EUI-64 の「0 → 1」の例には RFC 7042 の**文書用ユニキャスト** `00:00:5e:00:53:00`〜`00:00:5e:00:53:ff`(推奨。採否は第 10 章 4)。ブロードキャスト `ff:ff:ff:ff:ff:ff` は Lv101 以降 |
| AS 番号 | プライベート `64512〜65534` |
| ドメイン | `.example`(RFC 2606 予約。推奨。第 10 章 5)。ホスト名は拠点名のローマ字 + 役割(`www.shibuya.example`) |
| 機器名・IF 名 | `devices.json` の付け方(R1、SW1、FW1、PC1、L3SW1、IF は Gi0/0・Gi1/0/1・Eth0・Null0)。メーカーは架空の「PC ネットワークス」 |
| ベンダー固有の名称 | 標準名を併記する(`terms.json`。例: AD 値 = Cisco 社の「管理距離」、一般名「経路の優先度」) |

- 本文・解説・defenseNote・誤答・表・hint は**安全リンタ**(`LEVELS.md` 第 6 章 #7。`server/questions/lint.js` + `banned.json`)を通す: 使えるアドレス範囲以外のアドレス、`.example` 以外のドメイン、禁止語(実在製品名・マルウェア名・攻撃ツール名・走査系コマンド名)を弾く。`defenseNote` が空でないことも検査する
- 攻撃手法の名前・手順は書かない。問題は「構成を読んだ結果」を答えにするだけで、本物に使える手順は生成しない

---

## 8. 検証テストの流儀(`test/check.js` / `test/basics.js` と同じ)

- 生成器とは**別の実装**で答えを解き直し `assert` で一致を確認する。生成器が 32 ビット整数演算なら、検証器は **2 進文字列・BigInt・素朴な線形走査・全アドレスの列挙・逐次シミュレーション**を使う
- 4 択: 選択肢 4 つが重複しない(`normalize` 後の値で比較)、`answerIndex` が範囲内、誤答が正解と値として同じでない
- 入力: `accept` の全要素が `normalize` の不動点(正規形)である。「ありがちな間違い」が `accept` に**入らない**。`fields.length` と `name` の重複なし。`compare: 'set'` の欄はすべて同じ format
- 件数: 計算生成は固定 seed 列で **1 万件/生成器**(CI の再現性のため seed は `i` から決める)。FactBank 由来のテンプレートは**全数**(表の全行 × 問いの型)。境界値は各設計書の段ごとに明記したものを必ず含める(`meta` に印を付け比率を assert する流儀。例: Lv71 の `meta.trap`)
- `text`・`explanation`・`defenseNote`・`table` / `tables`・`hint`・`options` の全文を安全リンタに通す
- 全種類(`q.type`)が出ることを `seenTypes` で確認(既存と同じ)。各レベルに生成器が 1 つ以上あること
- `test/rng.js`: 同じ seed で同じ列、違う seed で違う列
- `test/normalize.js`: 下の表(全数)+ 語彙表の別名 → id の全数 + 冪等性(ランダム 1 万件)+ 形式不備が `null` を返す
- `npm.cmd test` に追加する

### 8.1 正規化テストの既知例(全数で入れる)

| format | 入力 | 期待 |
|---|---|---|
| number | `１,５５６番目` | `1556` |
| number | `+120`、`120 µs` | `120` |
| number | `10.80`(小数可の問題) | `10.8` |
| number | `12 秒`(小数不可の問題で `1.5`) | `12` / 不備 |
| ipv4 | `０１０.０７７.２００.０` | `10.77.200.0` |
| ipv4 | `10.77.200` / `10.77.200.256` | 不備 |
| ipv4cidr | `１０.0.0.0／２４`、`10.0.0.0 255.255.255.0` | `10.0.0.0/24` |
| ipv4cidr | `10.0.0.5/24` | `10.0.0.5/24`(正解 `10.0.0.0/24` と一致せず不正解) |
| ipv6 | `2001:0DB8:0000:0000:0200:5EFF:FE00:537A` | `2001:db8::200:5eff:fe00:537a` |
| ipv6 | `fe80:0:0:0:0:0:0:1` | `fe80::1` |
| ipv6 | `2001:db8::1::2`、`[2001:db8::1]` | 不備 |
| ipv6cidr | `2001:DB8:5C7E:9000::/52` | `2001:db8:5c7e:9000::/52` |
| prefixlen | `/21`、`21`、`／21`、`255.255.248.0` | `21` |
| prefixlen | `255.255.247.0` | 不備 |
| bin | `1011 0010`、`1011_0010` | `10110010` |
| bin | `0000110110111000`(digits 16) | `0000110110111000` |
| hex | `0xE5`、`E5` | `e5` |
| mac | `00-00-5E-00-53-7A`、`0000.5e00.537a` | `00:00:5e:00:53:7a` |
| mac | `00:00:5E`(OUI) | `00:00:5e` |
| yesno | `○`、`はい`、`転送する` / `×`、`いいえ`、`転送しない` | `yes` / `no` |
| token(v4-kind) | `APIPA`、`link-local`、`リンクローカルアドレス` | `v4-linklocal` |
| token(switch-action) | `全ポート`、`フラッディング`、`flood` | `flood` |
| token(diag-cause) | `逆引き`、`PTR`、`DNS` | `dns` |
| addrport | `２０３.0.113.10：51002` | `203.0.113.10:51002` |
| addrport | `203.0.113.10:0`、`203.0.113.10` | 不備 |
| ifname | `GigabitEthernet0/1`、`Gi 0/1`、`g0/1` | `gi0/1` |
| ifname | `Null 0` | `null0` |
| devname | `pc-2`、`PC 2` | `pc2` |
| dnsname | `23.7.0.10.IN-ADDR.ARPA.` | `23.7.0.10.in-addr.arpa` |
| aclverdict | `10 permit`、`許可 10` | `permit 10` |
| aclverdict | `暗黙の拒否`、`deny implicit` | `deny implicit` |
| aclverdict | `deny` | 不備 |
| prefixplan | 行の順を入れ替えたもの | 同じ集合 |

---

## 9. 共通部品のファイル一覧

| ファイル | 主な関数・中身 | 役割 | `LEVELS.md` 第 6 章 |
|---|---|---|---|
| `server/questions/rng.js` | `makeRng(seed)` → `{ rand, pick, shuffle, next }`(mulberry32) | seed 付き乱数 | #11 |
| `server/questions/normalize.js` | `normalize(format, s, opts)`、`judge(q, inputs)`(`judgeChoice` / `judgeText` / `verifiers`)、語彙表の読み込み | 正規化と判定(11〜50 の設計書で `judge.js` と呼んでいたもの) | #2 |
| `server/questions/data/vocab.json` | 語彙 id ごとの `token → 別名[]`(`v4-kind`、`v6-kind`、`diag-cause`、`switch-action`、`yesno`、`aclverdict`) | `token` / `yesno` / `aclverdict` の別名表 | #2 |
| `server/questions/data/facts/*.json` | FactBank(`v4-ranges`、`v6-special`、`v4-behavior`、`v6-behavior`、`layers`、`tcp-udp`、`ports`、`handshake`、`dhcp`、`dns-rrtype`、`dns-recursion`、`ad-default`、`acl-direction` …)。行に `id / ja / attrs / levelHint / checkedBy` | 固定テンプレートの知識カード | #11 |
| `server/questions/facts.js` | `makeFact(templateId, rng)`(行 + 文型から 4 択・入力を描く) | 固定テンプレートの描画 | #11 |
| `server/questions/lint.js` + `data/banned.json` | `lint(q)`: アドレス範囲・ドメイン・禁止語・defenseNote 非空 | 安全リンタ | #7 |
| `server/questions/index.js` | `getQuestion({ level, node, seed })`、`BY_LEVEL`(レベル → 生成器モジュール)、`MAX_IMPLEMENTED` | 取得口の拡張 | #1 |
| `server/world.js` | `ask` の payload 拡張、`pending` の拡張、`answer` の choice / text 両対応、結果に `defenseNote` / `answers` | 判定の接続 | #1 #2 |
| `server/index.js` | `answer` メッセージの `inputs` の形の検査 | F3 | — |
| `public/app.js` / `style.css` | 複数欄の入力 UI、`tables` の描画 | 画面 | #3 |
| `server/sim/netgen-min.js` / `server/sim/forward-min.js` | 最小 NetGen(直列トポロジ・セグメント・ホスト・ルータ・ACL・NAT・DNS 断片)と最小シミュレータ(同一サブネット判定・ARP・最長一致転送・TTL・ACL・NAT・逆引き照合) | 41〜50・91〜98 の土台 | #9 #10 |
| `tools/questions-gen.js` | `npm.cmd run questions:gen`: 一括生成 → 検証 → リンタ → `questions` へ保存 | 固定化 | #5 #11 #13 |
| `test/rng.js`、`test/normalize.js`、`test/lint.js` | 同 seed 同列 / 第 8.1 節の全数 + 冪等性 / 禁止例を弾く | 検証 | — |

レベルごとの生成器ファイル(`calc.js`、`vlsm.js`、`kinds.js`、`hops.js`、`transport.js`、`dhcpdns.js`、`routing.js`、`aclnat.js`、`diagnose.js`、`l2switch.js`)と各テストは、各設計書の一覧(`design-11-50.md` 第 5 章、`design-51-100.md` 第 8 章 (a))を見る。

---

## 10. 決めてもらうこと(共通部分に関わるもの)

両設計書の「迷った点」のうち、共通仕様に関わるものだけ。全レベルの一覧は `README.md` にある。

1. **その場生成か保存か**(11-50 #12、51-100 #13): 11〜30・51〜90 の計算生成は正確さの点ではその場生成で動く。`DESIGN.md` 3.5「拠点に紐づき、クリアまで同じ問題」に従うなら (a) seed だけ保存し本文は再生成(軽い)か、(b) DB.md 3.4 どおり `rendered` も保存(版が変わっても再現)か。`LEVELS.md` 未決 #8(本数・更新間隔・拠点専用か共有か)と一緒に決めたい。推奨: 11 以上は一律 (b)。固定問題を学習上の「解き直し」にできる
2. **複数欄の答え**(11-50 #2、51-100 #4): 全欄一致で正解 1 回とした。欄が 9 つの Lv49・50 では厳しいので欄数を 6 までに抑えるか、全欄一致を貫くか。51〜100 は「1 問 1 答」に分けた(71 は IF、72 は next-hop)が、`next-hop IF` のように 2 要素を 1 行で入力させる案もある。推奨: `fields` 配列は共通に持ち、欄数の上限 6 を目安にする。51〜100 の 1 欄構成はそのまま
3. **形式エラーの再入力**(51-100 #16): 形式が違う入力も不正解とした(再入力を許すと総当たりができる)。形式エラーだけ 1 回再入力を許すか。SECURITY.md「画面は信用しない」と F4 との整合を見て決める。推奨: 許さない(待ち時間 4 秒で足りる)
4. **文書用 MAC `00:00:5e:00:53:xx` の採用**(11-50 #6): ローカル管理だけでは EUI-64 の反転が常に 1 → 0 になる。RFC 7042 の文書用範囲を使えば 0 → 1 の例も安全に作れる。採用するなら安全リンタの許可範囲に加える。推奨: 採用
5. **ドメインの接尾辞**(51-100 #9): `.example`(RFC 2606)か、`LEVELS.md` の「ゲーム内専用の接尾辞」を別に決める(例 `.pcq`)か。安全リンタの許可リストと合わせて 1 つに。推奨: `.example`
6. **語彙入力(`token`)の扱い**(11-50 #5、51-100 #7): Lv31・33 の種別名、Lv98 の原因の分類語を入力にすると表記ゆれが多い。語彙表で受ける案(本書の `token`)と 4 択に落とす案。語彙表で受けるなら Tab 補完(語彙だけ)を入力欄に付けてよいか(「コマンドを選ぶボタンは作らない」との兼ね合い)。推奨: `token` + 語彙表、補完なし
7. **既存 Lv1〜10 の乱数**(51-100 #14): `Math.random` のまま(その場生成)か、`makeRng(seed)` に揃えるか。揃えるなら `subnet.js` / `basics.js` の `rand / pick / shuffle` を引数で受け取る小改修が要る。推奨: 1 の結論に合わせる(保存するなら揃える)
8. **VLSM の同サイズ区画の入替許容**(11-50 #13): `compare: 'set'` で許したが、区画名ごとに欄を出すと「営業の欄に支店の CIDR を書いた」が正解になり違和感がある。欄のラベルを「大きい方から 1 番目・2 番目 …」にして区画名を併記する案。推奨: ラベル案を採る
9. **Lv99 の採点(`verifier`)**(51-100 #11): 正準解を `accept` に置きつつ制約充足で別解も正解にする(本書の `verifier`)。「正準解のみ正解」なら実装は軽いが正しい計画を不正解にする。推奨: `verifier` を採る(共通部品として他の計画問題にも使える)
10. **入力式ができるまでの暫定配信**(11-50 #1): 土台(第 9 章)の実装前は Lv11 以上を (a) いまどおり Lv10 相当で出す、(b) 各設計書の「誤答の作り方」で同じ題材を 4 択で出す。(b) は知識は同じで形式だけ暫定。推奨: 土台を先に作り (a) のままにする(暫定 4 択は捨てる仕事になる)
11. **defenseNote の定型化**(11-50 #14): 計算問題で「守る側」の注記を段ごとの定型 + パラメータ差し込みにした。攻守同重の趣旨に足りるか、Lv11〜40 では省略可とするか。推奨: 必須のまま定型を許す(リンタの検査を単純に保てる)
