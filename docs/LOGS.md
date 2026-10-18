# ログ(イベント記録)の DB 設計

作成: 2026-10-18。`docs/DB.md` 3.6 の「仮の形」だった `events` コンテナーを、何を・いつ・どの形で残し、どう読むかまで決める。
コンテナーの一覧と Cosmos DB の構成は `DB.md`、不正の検知と調査の要件は `SECURITY.md`(T8・T13・第 4 章)、ランキング・休眠・引っ越し・チーム・地域の支配は `DESIGN.md` 第 3.1・3.11・14 章、管理画面は第 12 章、規模の考え方は第 13 章。

いまの `world.addLog`(メモリの 60 件、画面に流す日本語の文)はそのまま **画面の活動ログ** として残す。ここで決めるのは、それとは別の **構造化した出来事の記録**(DB に残し、集計と調査に使う)である。

---

## 1. 目的

| 目的 | 使い方 | 必要な出来事 |
|---|---|---|
| 週間ランキングの裏付け(SECURITY.md T13) | `players.weekPoints` は正解のたびに加算している集計値。これを **奪取の記録の合計と突き合わせ**、合わないプレイヤー・受け渡しの往復・交代制の 24 時間稼働を見つけ、異常はランキングから外して人が確認する | capture、answer、resume / leave |
| 支配率の推移(DESIGN.md 第 14.2 節) | 区・市・都道府県・国の支配者が日ごとにどう動いたか。イベントや称号の判定、宣伝用の「今週の勢力図」 | control、control.daily(1 日 1 回の断面) |
| 不正の検知と調査(SECURITY.md 第 4 章、T8) | 最短解答時間、正答率、解答間隔の分布、連続稼働、同じ接続元どうしの受け渡し、新規作成の連打 | answer、capture、join、limit |
| 学習記録 | プレイヤーごとの正答率、レベル別(題材別)の成績、平均解答秒。将来は「苦手な領域」を本人に見せる | answer、`players.stats`(集計値) |
| 運用の監視 | 1 日の参加・解答・エラー・制限の件数、RU の見積もりの根拠、休眠の回収の件数 | すべて(kind ごとの件数) |
| 問い合わせ対応 | 「拠点が消えた」「チームから抜けていた」「復帰コードが使えない」に、本人の履歴を時系列で見て答える | プレイヤー別の履歴(全種類) |

残さないもの: 問題の本文・選択肢・正解(`questions` と生成器で再現できる。答えを DB に散らさない)、名前などの自由入力(`players` にある)、生の IP アドレス(第 3.4 節)。

---

## 2. 出来事の種類(kind)

### 2.1 量の見積もりの前提

「プレイヤー 100 人・1,000 人・1 万人」は **1 日に遊ぶ人数(DAU)** とする。1 人が 1 日に行う操作の目安(いまの遊び方から。運用で実測して差し替える):

| 操作 | 1 人 1 日 | 根拠 |
|---|---|---|
| 解答 | 60 問(正解 40・不正解 20) | 1 回 30 秒前後 × 30 分の滞在。不正解率 1/3 |
| 接続(復帰)・切断 | 各 2 回 | 朝と夜 |
| 新規参加 | 0.1 回(DAU の 1 割が新規) | |
| 侵入(回数制の途中) | 20 回 | 正解 40 のうち攻撃 28 回。本数の平均 2〜3 なので突破前の侵入が多い |
| 奪取・到達 | 8 回 | |
| 強化 | 12 回 | |
| 引っ越し・チーム操作・再発行 | 合わせて 0.2 回 | 1 日 1 回の上限、たまにしか起きない |
| 制限・エラー | 合わせて 0.2 回 | |

合計はおよそ **1 人 1 日 100 件**。したがって 1 日の件数は DAU × 100(100 人 → 1 万件、1,000 人 → 10 万件、1 万人 → 100 万件)。

### 2.2 一覧

`持つ項目` は共通項目(第 3.1 節: id、type、day、at、kind、playerId、teamId、src、ttl)に加えて持つもの。`detail` の中身はここに書いた項目に限り、増やすときはこの表に足す。

| kind | いつ記録するか(`world.js` の場所) | 持つ項目(共通以外) | 100 人 | 1,000 人 | 1 万人 | TTL |
|---|---|---|---|---|---|---|
| `join` | 新規参加(`join` で token が無い、または見つからないとき。`spawnHome` 成功後) | nodeId(自分の拠点)、regionId、detail: { startNodeId, name } | 10 | 100 | 1,000 | 365 日 |
| `resume` | 復帰(`join` で token が一致したとき) | detail: { renamed: 名前を変えたか } | 200 | 2,000 | 20,000 | 90 日 |
| `leave` | 切断(`disconnect`) | detail: { sec: 接続していた秒数 } | 200 | 2,000 | 20,000 | 90 日 |
| `answer` | 解答のたび(`answer`。正解・不正解とも) | nodeId、regionId、level、ok(正誤)、sec(出題から解答までの秒)、detail: { mode: attack / fortify, qkind: 生成器の種類, wrongStreak, cooldownMs, provisional } | 6,000 | 60,000 | 600,000 | **30 日**(第 8 章 #2) |
| `intrude` | 攻撃で正解したが回数に達していない(`apply`) | nodeId、regionId、level、detail: { progress, hits, key: 進捗の鍵(自分かチーム) } | 2,000 | 20,000 | 200,000 | 90 日 |
| `capture` | 回数に達して占領・奪取(`apply`) | nodeId、regionId、level、detail: { prevOwner, prevTeam, gained(得点), hits, defenseBefore } | 800 | 8,000 | 80,000 | 365 日 |
| `fortify` | 強化(`apply`) | nodeId、regionId、level(強化後の出題レベル)、detail: { defense } | 1,200 | 12,000 | 120,000 | 90 日 |
| `move` | 引っ越し(`move`) | nodeId(新しい自分の拠点)、regionId、detail: { from: 前の開始地点, to: 新しい開始地点, oldHomeId } | 5 | 50 | 500 | 365 日 |
| `team.create` | チーム作成(`createTeam`) | teamId、detail: { name, maxMembers } | 2 | 20 | 200 | 365 日 |
| `team.join` | チーム参加(`joinTeam`) | teamId、detail: { memberCount } | 5 | 50 | 500 | 365 日 |
| `team.leave` | チーム脱退(`leaveTeam`) | teamId、detail: { memberCount, newOwnerId, deleted: 最後の 1 人で消えたか } | 3 | 30 | 300 | 365 日 |
| `team.style` | 見た目の変更(`styleTeam`) | teamId、detail: { style, icon } | 2 | 20 | 200 | 90 日 |
| `control` | 地域の支配者が変わった(`saveControl` で before と違うとき) | regionId、detail: { tier, before, after(プレイヤー id かチーム id), total, count } | 10 | 100 | 1,000 | 365 日 |
| `control.daily` | 1 日 1 回、日本時間 0 時の断面(第 5.2 節。playerId は無し) | regionId、detail: { tier, controller, total, counts(上位 3 つ) } | 60 | 60 | 60 | **無期限**(`ttl: -1`) |
| `reclaim` | 休眠の回収(`reclaimIdle`。回収された人 1 人につき 1 件。playerId は回収された人) | detail: { name, nodesFreed, homeDeleted, lastSeen, lastSeenUp } | 5 | 50 | 500 | 365 日 |
| `rekey` | 復帰コードの再発行(`rekey`) | なし(新旧のコードは書かない) | 2 | 20 | 200 | 365 日 |
| `limit` | 制限に引っかかった。`rule` で区別: `create` / `resume`(接続元の回数制限。`index.js` の `limiter.take`)、`flood`(1 接続 20 件/秒を超えて切断。F3)、`origin`(Origin 検査で拒否。F1。`verifyClient` なので playerId は無い)、`fast`(最短解答時間 1 秒未満で拒否。F6。`world.answer`、playerId あり) | detail: { rule, label, ms(fast のとき出題からの経過) } | 20 | 200 | 2,000 | 90 日 |
| `error` | 操作が例外で終わった(`index.js` の `chain` の catch。ゲームの規則による拒否 — 「待ってください」など — は含めず、想定外の例外だけ) | detail: { op: メッセージ種別, message(先頭 200 文字) } | 10 | 100 | 1,000 | 30 日 |
| (予約)`notice` / `traceback` / `abuse` | フェーズ 2(通知・逆探知・異常の印)。`DB.md` 3.6 の名前を残す。形は実装時に | | | | | |

件数の合計: **100 人 ≈ 1 万件/日、1,000 人 ≈ 10 万件/日、1 万人 ≈ 100 万件/日**。`answer` が 6 割を占める。

---

## 3. ドキュメントの形

### 3.1 `events` コンテナー

パーティションキーは **`/day` のまま**(既に本番にこのキーで作成済み。`DB.md` 第 10 章)。理由: 読み方がほぼ「ある日の」「ここ 7 日の」なので、日で切れば単一パーティションか、日の一覧を `ARRAY_CONTAINS` で渡す狙い撃ちの問い合わせになる(第 5 章)。1 日 1 論理パーティションになるが、論理パーティションの上限 20 GB に対して 1 万人でも 1 日 0.5 GB(第 4 章)なので届かない。

```json
{
  "id": "1760796000123-a3f9",
  "type": "event",
  "day": "2026-10-18",
  "at": 1760796000123,
  "kind": "capture",
  "playerId": "6d1e2f3a4b5c",
  "teamId": "9c8b7a6f5e4d",
  "nodeId": "st-002915",
  "regionId": "tokyo-chiyoda",
  "level": 6,
  "src": "4f1c9e2b7a8d0356",
  "detail": { "prevOwner": "0a1b2c3d4e5f", "prevTeam": null, "gained": 6, "hits": 9, "defenseBefore": 2 },
  "ttl": 31536000
}
```

| 項目 | 内容 |
|---|---|
| `id` | `${at}-${乱数 4 桁 hex}`。同じミリ秒でも衝突しない。パーティション(`day`)の中で一意ならよい。`control.daily` だけは `ctl-${day}-${regionId}` にして同じ日に 2 回走っても上書きになるようにする |
| `type` | つねに `"event"`(`DB.md` 第 3 章の約束) |
| `day` | **日本時間の日付** `"YYYY-MM-DD"`。`weekKeyOf` と同じ計算: `new Date(at + 9 * 3600 * 1000).toISOString().slice(0, 10)`。サーバーの時刻帯(Azure は UTC)に依存しない |
| `at` | Unix ミリ秒(数値)。文字列の日時は使わない |
| `kind` | 第 2.2 節の名前。`.` で区切った階層(`team.join`) |
| `playerId` | 行った人。無ければ省く(`limit`、`control.daily`) |
| `teamId` | その時点の所属チーム。無ければ省く(突破回数と支配はチーム単位なので、あとで集計できるよう毎回写す) |
| `nodeId` / `regionId` | 対象の拠点と、その拠点の区・市(`node.region`)。地域の集計を拠点から引き直さずに済ませる |
| `level` | 出題レベル(answer / intrude / capture / fortify) |
| `ok` / `sec` | `answer` だけ。正誤と、出題から解答までの秒(小数 1 桁)。問い合わせで使うので `detail` の外に置く |
| `src` | 接続元のハッシュ(第 3.4 節)。join / resume / limit / capture / answer に付ける |
| `detail` | 種類ごとの追加項目(第 2.2 節)。**インデックスから外す**(第 4.2 節)ので、ここに入れた項目は絞り込みに使えない。絞り込みに使うものは上に出す |
| `ttl` | 秒。種類ごとに決める(第 3.3 節)。無期限は `-1` |

**持たないもの**: 名前(`join` / `reclaim` の detail だけ例外。回収で `players` から消えるため、問い合わせ対応に必要)、問題の本文・選択肢・正解の番号、復帰コード、生の IP。`test/world.js` で「events に `answerIndex`・`token` が含まれない」を検査する(第 7.6 節)。

### 3.2 `players.stats`(学習記録の集計値。`DB.md` 3.3 の「将来: stats」)

出来事を毎回集計し直さず、プレイヤー ドキュメントに集計値を持つ(第 13 章の `score` / `nodesOwned` と同じ考え)。粒度は第 8 章 #4 で決める。案:

```json
"stats": {
  "answers": 312, "correct": 240, "minSec": 2.1,
  "byLevel": { "1": { "n": 40, "ok": 38, "secSum": 412.5 }, "7": { "n": 12, "ok": 7, "secSum": 301.0 } },
  "updatedAt": 1760796000123
}
```

- 更新は `answer()` の中でメモリ上の `p.stats` に加算する。保存は **すでに起きている `persistPlayer` に乗せる**(不正解・強化・奪取・切断で保存される。侵入だけの正解では保存されないが、次の保存で追いつく)。追加の書き込みは増えない
- `byLevel` の鍵は出題レベル。Lv1〜10 は題材が 1 対 1 なので、そのまま題材別の成績になる。Lv11 以上が増えたら 100 ごとの領域(`LEVELS.md`)でまとめた `byBand` を足す
- `events` の `answer` を間引く・短い TTL にする場合も、学習記録はここに全件ぶん残る

### 3.3 TTL の設定

Cosmos DB の TTL は「コンテナーの既定(`defaultTtl`)」と「ドキュメントの `ttl`」の 2 段。`defaultTtl` が未設定(null)だとドキュメントの `ttl` も無視されるので、コンテナー側は必ず設定する。

| 設定 | 値 | 意味 |
|---|---|---|
| コンテナー `defaultTtl` | **7776000**(90 日) | `ttl` を持たないドキュメントは 90 日で消える(書き忘れの安全弁)。`DB.md` 第 4 章の「events 90 日」と一致 |
| ドキュメント `ttl` | 種類ごと(第 2.2 節) | 30 日 = 2592000、90 日 = 7776000、365 日 = 31536000、無期限 = -1 |

削除は Cosmos が余った RU で裏で行う(費用ゼロ、アプリの処理なし)。保持期間の数字は第 8 章 #1 で決める。

### 3.4 接続元(IP)の扱い

目的は「同じ接続元どうしの受け渡し」「新規作成の連打」を見ること(T8・T13)。個人を特定する必要はないので **生の IP は保存しない**。

- `src` = `SHA-256(LOG_SALT + day + ip)` の先頭 16 桁(hex)。**塩は日替わり**(`day` を混ぜる)なので、同じ日の中では同じ接続元が同じ値になり、日をまたいだ追跡はできない
- `LOG_SALT` は環境変数(App Service のアプリ設定)。未設定なら起動時の乱数(再起動で変わり、同じ日でも値が揃わなくなる。手元はそれでよい)
- 復帰コードと同じく、`src` は配信しない(`pub` 系に含めない)
- 調査で生の IP が必要になる場面(悪質な接続元の遮断)は Azure 側のアクセスログで見る。ゲームの DB には置かない
- 第 8 章 #3 で「保存しない / 日替わりハッシュ / 日替わりでない(週単位の)ハッシュ」を決める

---

## 4. 費用と性能

### 4.1 書き込み

1 件は 0.4〜0.6 KB。インデックスを絞れば(第 4.2 節)1 件 **約 5 RU**、既定のインデックス(全項目)なら 7〜10 RU。ここでは 7 RU で見積もる。ピークは「夜の 3 時間に 1 日の半分が集まる」とする。

| DAU | 件/日 | RU/日 | 平均 RU/s | ピーク RU/s | 保存量/日 | 90 日の保存量 |
|---|---|---|---|---|---|---|
| 100 人 | 1 万 | 7 万 | 0.8 | 3 | 5 MB | 0.5 GB |
| 1,000 人 | 10 万 | 70 万 | 8 | 32 | 50 MB | 4.5 GB |
| 1 万人 | 100 万 | 700 万 | 81 | 320 | 500 MB | 45 GB |

無料枠(共有 1000 RU/s、25 GB)との関係:

- **100 人・1,000 人は余裕で収まる**。ゲーム本体の書き込み(正解 1 回で拠点 + プレイヤーの upsert ≈ 20〜25 RU)に対して、ログは 1 件 7 RU の上乗せ
- **1 万人は収まらない**。ログだけでピーク 320 RU/s、保存量 45 GB。しかもゲーム本体の書き込みがその時点で平均 170・ピーク 700 RU/s ほどになり、ログを足すと 1000 を超える。1 万人は `DESIGN.md` 第 10 章の段階 C(収益化)の規模なので、**無料枠に収める前提を外し、スループットを上げる**のが本筋。それでもログは次の手で軽くしておく

### 4.2 収めるための手(効く順)

| 手 | 効果 | いつ入れるか |
|---|---|---|
| インデックスを絞る: `/day`、`/kind`、`/playerId`、`/teamId`、`/nodeId`、`/regionId`、`/at`、`/level`、`/ok`、`/sec`、`/src` だけ含め、`/detail/*` と残り(`/*`)を除外 | 書き込み 7〜10 RU → 約 5 RU。保存量も減る | **最初から**(コンテナー作成時。あとからでも変えられる) |
| `answer` の TTL を短く(30 日)。他は 90〜365 日 | 保存量の 6 割を占める answer を早く回収。1,000 人で 90 日 4.5 GB → 2.1 GB | 最初から |
| `answer` の間引き: 不正解・`sec` が 3 秒未満・待ち時間中の試行は全件、正解は 1/10 だけ残す。学習記録は `players.stats` で全件ぶん持つ | answer が 1/3 以下に。1 万人で 60 万 → 20 万件/日 | DAU 3,000 を超えたら(第 8 章 #2) |
| 時間ごとの集計だけ残す: `answer.hourly`(プレイヤー × 時間で n / ok / secSum / minSec)を 1 時間に 1 件 | answer が 1 人 1 日 数件に。分布の調査はできるが 1 問ごとの再現はできない | 間引きでも足りないとき |
| まとめ書き: 1〜2 秒バッファして `appendEvents` で一括(SDK の bulk) | **RU は減らない**(RU は件数で決まる)。要求回数と待ち時間が減り、ゲームの処理を遅らせない | 最初から(実装の形として) |
| 書き込みの優先度を下げる: Cosmos の優先度ベースの実行(`priorityLevel: Low`)をログの書き込みに付ける | 上限に当たったときログだけ 429 になり、ゲームの保存が守られる | 1,000 人を超えたら(SDK の対応を確認してから) |

### 4.3 読み取り

集計の問い合わせ(第 5 章)は 1 日分の単一パーティションなら数 RU〜数十 RU。1 万件の日を `GROUP BY` で集計しても 100 RU 前後。管理画面と日次の集計は人が操作するか 1 日 1 回なので、RU の主役にはならない。**ゲームの 1 操作ごとに events を読まない**(`DB.md` 第 2 章の原則)。

---

## 5. 読み方(集計)

共通の原則: **`day` で絞る**。1 日なら `WHERE c.day = @day`(単一パーティション)、複数日なら `WHERE ARRAY_CONTAINS(@days, c.day)`(Cosmos は該当パーティションだけに問い合わせを送る)。`day` を付けない問い合わせは全パーティションに扇状に広がって高いので、管理画面でも必ず期間を付ける。

### 5.1 週間ランキングの裏付け(T13)

週の 7 日(`weekKeyOf` の月曜から)を `@days` に渡し、奪取の得点を人ごとに足して `players.weekPoints` と比べる。

```sql
SELECT c.playerId, COUNT(1) AS captures, SUM(c.detail.gained) AS pts
FROM c WHERE ARRAY_CONTAINS(@days, c.day) AND c.kind = "capture"
GROUP BY c.playerId
```

- `pts` と `weekPoints` が合わない → 保存の失敗か不正。印を付けて人が見る(`detail.gained` は `detail` の中なので集計はできるが絞り込みには使わない)
- 受け渡しの往復: 同じ日の `capture` を `(detail.prevOwner, playerId)` の組で数え、A→B と B→A の両方が多い組を出す。さらに両者の `src` が同じなら T8 の多重アカウントの疑い
- 交代制の 24 時間稼働: 第 5.4 節の連続稼働

### 5.2 区・市の支配の推移(1 日 1 回の断面)

支配の変化そのものは `control` で全部残るが、推移を描くには「毎日 0 時の状態」があると楽なので、**日本時間 0 時に全地域の断面を `control.daily` として events に書く**(`regions` の中に履歴の配列を足す案は、ドキュメントが際限なく育つのでやめる)。

- 書くもの: `regions` の区・市(tier 6)、都道府県(tier 5)、国(tier 3)。東京だけなら約 60 件/日、日本全体で約 1,800 件/日。`ttl: -1`(消さない。1 年で東京 2 万件、日本 65 万件 ≈ 300 MB)
- 走らせ方: `index.js` の 1 分ごとの `tick` で、`day` が前回と変わっていたら 1 回だけ `world.snapshotControl()` を呼ぶ。id を `ctl-${day}-${regionId}` にして upsert するので、再起動で 2 回走っても二重にならない
- 読み方: ある区の 30 日 → `WHERE ARRAY_CONTAINS(@days, c.day) AND c.kind = "control.daily" AND c.regionId = @r`。ある日の全体 → `WHERE c.day = @day AND c.kind = "control.daily"`(単一パーティション)

### 5.3 プレイヤーの学習記録

- 本人に見せる成績は `players.stats`(第 3.2 節)から。events は読まない
- 詳しい調査(「Lv7 で間違い続けている」)は `WHERE ARRAY_CONTAINS(@days, c.day) AND c.kind = "answer" AND c.playerId = @p ORDER BY c.at DESC`。`answer` の TTL(30 日)を超えた分は `stats` だけが残る

### 5.4 不正検知で使う問い合わせ(SECURITY.md 第 4 章)

| 見るもの | 問い合わせ(いずれも `c.day = @day`) | 判断の目安(運用で調整) |
|---|---|---|
| 最短解答時間 | `SELECT TOP 100 c.playerId, c.sec, c.level FROM c WHERE c.day = @day AND c.kind = "answer" AND c.ok = true ORDER BY c.sec ASC` | F6(1 秒未満は拒否。2026-10-18 済)の直上、1.0〜2.0 秒に張り付いて Lv4 以上を正解し続ける人。あわせて `kind = "limit" AND c.detail.rule = "fast"` が 1 日 50 件を超える人(拒まれても機械的に送り続けている) |
| 正答率と件数 | `SELECT c.playerId, COUNT(1) AS n, SUM(c.ok ? 1 : 0) AS ok, AVG(c.sec) AS sec FROM c WHERE c.day = @day AND c.kind = "answer" GROUP BY c.playerId` | 1 日 500 問超、正答率 98% 超、平均 3 秒未満が重なる人 |
| 連続稼働 | `SELECT c.playerId, MIN(c.at) AS first, MAX(c.at) AS last, COUNT(1) AS n FROM c WHERE c.day = @day AND c.kind = "answer" GROUP BY c.playerId`。疑わしい人だけ `at` の一覧を取り、1 時間ごとの件数に落とす | 18 時間以上、どの時間帯も途切れず解答。前後の日とつなげて 2 日以上続く |
| 同じ接続元 | `SELECT c.src, COUNT(1) AS n FROM c WHERE c.day = @day AND c.kind = "join" GROUP BY c.src` | 1 日 5 人以上を作った接続元。その人たちの `capture` の相手が互いなら受け渡し(第 5.1 節) |
| 制限の多発 | `SELECT c.src, c.detail.rule, COUNT(1) FROM c WHERE c.day = @day AND c.kind = "limit" GROUP BY c.src, c.detail.rule` | 新規作成の制限に 1 日 20 回以上当たる接続元 |

検知の結果は events ではなく **`players.flags`**(`DB.md` 3.3 の「将来: flags」。`{ kind, at, note, by }` の配列)に書き、ランキングの問い合わせ(`topPlayers`)で `flags` が付いた人を外す。自動で付けるのはフェーズ 2(SECURITY.md 第 7 章)、それまでは管理者が手で付ける。

---

## 6. 管理画面(DESIGN.md 第 12 章)から見るもの

管理画面はフェーズ 2(公開ベータの前)に別の App Service で作る。それまではデータ エクスプローラーで第 5 章の SQL をそのまま打つ。管理画面に載せる画面と、使う問い合わせ:

| 画面 | 中身 | 問い合わせ |
|---|---|---|
| 直近の出来事 | 今日(と昨日)の出来事を新しい順に 200 件。kind で絞れる | `eventsByDay(day, { kind, limit: 200 })` |
| プレイヤー別の履歴 | id か名前で引き、ここ 7〜30 日の出来事を時系列で。`players` の現在値(score、weekPoints、team、stats、flags)を上に出す | `eventsOfPlayer(playerId, days)` |
| 異常の一覧 | 第 5.4 節の 5 つの問い合わせを 1 日 1 回回し、目安を超えた人・接続元を表にする。行から「印を付ける」「ランキングから外す」へ | 第 5.4 節 |
| ランキングの照合 | 今週の `players.weekPoints` 上位 50 人と第 5.1 節の合計を並べ、差がある行を色で出す | 第 5.1 節 |
| 支配の推移 | 区・市を選び、`control.daily` の 30 日を支配者の色の帯で | 第 5.2 節 |
| 監視 | kind ごとの件数(今日・昨日・7 日平均)、`error` と `limit` の一覧、休眠の回収数。RU と保存量はポータルのメトリクスへのリンク | `SELECT c.kind, COUNT(1) FROM c WHERE c.day = @day GROUP BY c.kind` |

管理画面も **DB に書くのはサーバー(管理 API)だけ**。`flags` の付け外しと拠点の回収は管理 API を通し、その操作自体を `kind: "admin.flag"` などで events に残す(形は管理画面の設計時に)。

---

## 7. 実装の手順

**実装状況(2026-10-18): 済。** 7.1〜7.5 と 7.8 の 1〜5 はコードに入った(`server/events.js`、`server/store.js` / `store-cosmos.js`、`server/world.js`、`server/index.js`)。テストは 7.6 の 1〜8 が `test/events.js`・`test/world.js`・`test/cosmos.js` にある(9 の `test/abuse.js` への追加は未)。7.7 のポータル設定(本番 `events` の TTL とインデックス)は次の配置時に行う(`DB.md` 第 10 章)。残りは 6(管理画面、フェーズ 2)。

設計からずらした点:
- `makeEvent` は `ip` を受け取って `src` に変え、`ip` 自体は捨てる(呼び出し側が生の IP を書いてしまう事故を防ぐ)。関数名は `srcOf` ではなく `hashSrc(ip, day)`
- `World` は `new World({ store, events })` で `EventLog` を受け取る(省略時は何もしない `noopEvents()`)。`world.js` 自身は `EventLog` を作らない
- 7.4 の `expected` ヘルパーは入れていない(`world.js` の大きな書き換えになるため)。代わりに `index.js` の `isUnexpected(e)` が「素の `Error`(規則による拒否)」以外 — `TypeError` などの別クラス、`code` を持つ SDK やネットワークの例外、`expected: false` と明示したもの — だけを `error` として記録する。将来 `expected: true` を付ければそのまま除外される
- `control.daily` の走らせ方: `world.tick()` が日本時間の日付を前回(`meta` の `clock.day` に保存)と比べ、変わっていれば `snapshotControl()` を 1 回呼ぶ。`clock.day` を保存するので 0 時をまたいだ再起動でも断面を落とさない
- `answer` の `detail` に `answerKind`(choice / text)を足した(入力式が同日に入ったため)。`sec` は小数 1 桁
- `players.stats` に `byBand`(100 ごとの領域。鍵は 100 の位、`"0"` = Lv1〜99)を最初から持つ。`minSec` は正解した解答の最短秒

以下は実装前の計画(入れた順番と場所の記録として残す)。

### 7.1 `server/events.js`(新しいファイル)

- `dayOf(at)`: 日本時間の `"YYYY-MM-DD"`(`weekKeyOf` と同じ計算。`world.js` から移して両方で使う)
- `TTL_BY_KIND`: 第 2.2 節の表。無いものは `undefined`(コンテナー既定の 90 日)
- `srcOf(ip, day)`: 第 3.4 節のハッシュ
- `makeEvent(kind, fields)`: `id`、`type`、`day`、`at`、`ttl` を埋め、`undefined` の項目を落として返す
- `class EventLog { constructor(store) ... add(kind, fields) ... flush() }`: `add` は同期でバッファに積むだけ(戻り値なし)。1 秒ごと、または 50 件たまったら `store.appendEvents(docs)` を呼ぶ。**失敗は `console.error` だけ**で捨てる(再試行しない。ログのためにゲームを止めない・メモリを膨らませない)。バッファの上限 5,000 件、超えたら古いものから捨てて件数を 1 回だけ警告
- プロセス終了時(`SIGTERM`)に 1 回 `flush` を試みる(App Service の再起動で直前の数秒を失わないため。間に合わなければ諦める)

### 7.2 保存口(`server/store.js` / `server/store-cosmos.js`)

| メソッド | メモリ版 | Cosmos 版 |
|---|---|---|
| `appendEvent(doc)` | `this.events.push({ ...doc })`。上限 10,000 件で古いものを捨てる | `events.items.upsert(doc)` |
| `appendEvents(docs)` | 同上をまとめて | 10 件ずつ `Promise.all` で upsert(`seedNodes` と同じ形)。件数が増えたら SDK の bulk(`items.bulk` / `executeBulkOperations`)に替える |
| `eventsByDay(day, { kind, playerId, nodeId, regionId, since, limit = 200 })` | 配列を filter して `at` の降順 | `WHERE c.day = @day` + 指定された条件、`ORDER BY c.at DESC`、`OFFSET 0 LIMIT @limit`。`options.partitionKey = day` |
| `eventsOfPlayer(playerId, days)` | 同上 | `WHERE ARRAY_CONTAINS(@days, c.day) AND c.playerId = @p ORDER BY c.at DESC` |
| `countEventsByKind(day)` | 集計 | `SELECT c.kind, COUNT(1) AS n FROM c WHERE c.day = @day GROUP BY c.kind` |

`CONTAINERS` に `{ id: 'events', partitionKey: { paths: ['/day'] }, defaultTtl: 7776000, indexingPolicy: {...第 4.2 節} }` を足す。**`createIfNotExists` は既にあるコンテナーの設定を変えない**ので、本番の `events`(データ エクスプローラーから作成済み)の TTL とインデックスは第 7.7 節の手順でポータルから設定する。

### 7.3 `world.js` の呼び出し場所

`World` に `this.events = new EventLog(store)` を持たせ、`this.events.add(kind, {...})` を次の場所に 1 行ずつ足す。すべて `await` しない(同期で積むだけ)。

| 場所 | kind | 補足 |
|---|---|---|
| `join`: 復帰で `p` が見つかった直後 | `resume` | `ws.ip` を `src` に。`index.js` から `join(ws, ...)` に ip を渡すか、`ws.ip` を読む |
| `join`: `spawnHome` 成功後 | `join` | `nodeId` = 自分の拠点、`regionId` = その区 |
| `disconnect` | `leave` | `sec` は `now() - p.connectedAt`。`connectedAt` を `join` で付ける(保存しない項目なので `persistPlayer` の分割代入で除く) |
| `ask` | (記録しない) | `p.pending.askedAt` は F6(最短解答時間)で既に入っている(2026-10-18 済)。`answer` の `sec` にそのまま使う |
| `answer`: 最短解答時間で拒んだとき(`now() - pend.askedAt < minAnswerMs` の `throw` の前) | `limit`(rule: fast) | `detail.ms` に経過ミリ秒。問題は残るので同じ `qid` で何度も当たる人はボットの疑い(第 5.4 節) |
| `answer`: 正誤が決まった直後 | `answer` | `ok`、`sec = (now() - pend.askedAt) / 1000`、`level = pend.level`、`detail.mode = pend.mode`、`detail.qkind` は生成器が返す種類(`getQuestion` の戻りに `kind` を足す。いまは無い)。`players.stats` の加算もここ |
| `apply`: 強化 | `fortify` | `level` は強化後の攻め手の出題レベル |
| `apply`: 回数未達 | `intrude` | `detail.key = attackKey(p)` |
| `apply`: 占領 | `capture` | `prev` が居れば `prevOwner` と `prevTeam`。`gained` は加算した値 |
| `move` | `move` | 成功後(`spawnHome` のあと) |
| `createTeam` / `joinTeam` / `leaveTeam` / `styleTeam` | `team.*` | 保存が成功したあと |
| `saveControl`: `before !== controller` のとき | `control` | すでに `addLog` している分岐 |
| `reclaimIdle`: `deletePlayer` のあと | `reclaim` | `playerId = doc.id`、`detail.name = doc.name` |
| `rekey` | `rekey` | |
| (新規)`snapshotControl()` | `control.daily` | `store.loadRegions()` から tier 3・5・6 の `control` を写す。`index.js` の `tick` から日付が変わったときに呼ぶ |

### 7.4 `index.js`

- `limiter.take` が理由を返したとき: `world.events.add('limit', { src: srcOf(ws.ip, day), detail: { rule, label } })` を `throw` の前に
- トークン バケットで `ws.close(1008)` する直前に `limit`(rule: flood、`playerId` は `ws.player` があれば)。`verifyClient` で Origin を拒んだときに `limit`(rule: origin、`detail.origin` は先頭 100 文字、`src` は `clientIp(req)` から)。どちらも 1 接続につき 1 件まで(連打で events が膨らまないよう、同じ接続・同じ理由は 2 回目から記録しない)
- `chain` の `catch`: `e.expected` が立っていない例外(= ゲームの規則による拒否ではない)だけ `error` を記録する。規則による拒否は `world.js` の `throw new Error(...)` を小さなヘルパー(`reject(msg)` が `expected: true` を付ける)に替えて区別する。これを入れるまでは `error` を記録しない(規則の拒否が 1 日数千件になり無駄)

### 7.5 失敗してもゲームを止めない

- `add` は同期で例外を出さない(項目の検査で落ちそうなものは `try` で囲んで捨てる)
- `flush` の失敗は `console.error('ログの保存に失敗:', e.message)` だけ。次の flush で新しい分だけ送る
- `events` コンテナーが無い・権限が無い環境でも、ゲームの `join` / `answer` は通る(`test/world.js` で `appendEvents` が reject する保存口を渡して確認)

### 7.6 テストの観点(`test/world.js` に足す。接続レベルの `limit` は `test/abuse.js`、Cosmos は `test/cosmos.js`)

1. 新規参加で `join`、復帰で `resume`、切断で `leave` が 1 件ずつ積まれ、`day` が日本時間の日付であること(`at` を UTC 15:30 にして翌日の `day` になるのを確かめる)
2. 不正解で `answer`(`ok: false`、`cooldownMs` が倍増の値)、正解で `answer` + `intrude` または `capture`。`capture.detail.gained` が `weekPoints` の増分と一致
3. events を JSON にして `answerIndex`、`token`、生の IP(テストで渡した文字列)が**含まれない**こと。`src` が 16 桁の hex であること
4. 同じ ip と day で `src` が同じ、day が変わると違うこと
5. `appendEvents` が reject する保存口でも `join` / `answer` が成功し、`console.error` が 1 回呼ばれること
6. `snapshotControl` を同じ日に 2 回呼んでも `control.daily` が地域ごとに 1 件(id が同じで upsert)
7. `players.stats` が `answer` のたびに加算され、`persistPlayer` で保存されること
8. Cosmos: `pc-test` に `events` を作り、`appendEvents` → `eventsByDay` → `eventsOfPlayer` が返ること、`ttl` が入っていること(実際の削除は待たない)
9. `test/abuse.js`: 連打で切断されたとき `limit`(flood)が 1 件だけ、Origin 偽装の拒否で `limit`(origin)が 1 件、`minAnswerMs` を既定にして速すぎる解答で `limit`(fast)が積まれ `answer` は積まれないこと(メモリ版の `store.events` を `/healthz` か検査用の口から読む)

### 7.7 コンテナーの TTL とインデックス(ポータルの手順とテンプレート)

ポータル(本番 `packet-conquest` の `events` は作成済みなので、こちらで設定する):

1. Azure ポータル → Cosmos DB アカウント `packet-conquest` → データ エクスプローラー → `packet-conquest` → `events` → **Scale & Settings**(または Settings)
2. **Time to Live** を「On」にし、秒に **7776000** を入れる(「On (no default)」は `ttl` の無いドキュメントが消えないので使わない)
3. 同じ画面の **Indexing Policy** を次の内容に置き換えて Save

```json
{
  "indexingMode": "consistent",
  "automatic": true,
  "includedPaths": [
    { "path": "/day/?" }, { "path": "/kind/?" }, { "path": "/at/?" },
    { "path": "/playerId/?" }, { "path": "/teamId/?" }, { "path": "/nodeId/?" }, { "path": "/regionId/?" },
    { "path": "/level/?" }, { "path": "/ok/?" }, { "path": "/sec/?" }, { "path": "/src/?" }
  ],
  "excludedPaths": [ { "path": "/*" } ],
  "compositeIndexes": [
    [ { "path": "/day", "order": "ascending" }, { "path": "/kind", "order": "ascending" }, { "path": "/at", "order": "descending" } ],
    [ { "path": "/playerId", "order": "ascending" }, { "path": "/at", "order": "descending" } ]
  ]
}
```

複合インデックスは `DB.md` 第 4 章の「events の (day, kind)」を `ORDER BY c.at DESC` 付きに具体化したもの。

テンプレート `infra/cosmos-database.json` への追加案(新しい環境を作るとき用。`meta` の次に足す。`teams` と `sessions` も同じ要領で):

```json
{
  "type": "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers",
  "apiVersion": "2024-05-15",
  "name": "[format('{0}/events', variables('db'))]",
  "dependsOn": [ "[resourceId('Microsoft.DocumentDB/databaseAccounts/sqlDatabases', parameters('accountName'), parameters('databaseName'))]" ],
  "properties": {
    "resource": {
      "id": "events",
      "partitionKey": { "paths": [ "/day" ], "kind": "Hash" },
      "defaultTtl": 7776000,
      "indexingPolicy": { "…上と同じ…": "" }
    }
  }
}
```

### 7.8 順番

1. `events.js`(dayOf / makeEvent / EventLog)とメモリ版の保存口、テスト 1〜5・7 — ゲームの動きは変えないので先に入れられる
2. `world.js` の呼び出し(第 7.3 節)、`pending.askedAt`、`players.stats`
3. Cosmos 版の保存口、ポータルで TTL とインデックス、`test/cosmos.js`
4. `snapshotControl` と `tick` からの呼び出し
5. `index.js` の `limit`、`expected` の区別と `error`
6. 管理画面(フェーズ 2)で第 6 章の問い合わせを載せる

---

## 8. 決めたこと(2026-10-18 推奨どおりに決定)

すべて推奨どおりに決まり、同日に実装した(第 7 章)。

1. **保持期間**: answer・error 30 日 / resume・leave・fortify・intrude・team.style・limit 90 日 / join・capture・move・team.create・team.join・team.leave・control・reclaim・rekey 365 日 / control.daily 無期限。コンテナー既定は 90 日(`server/events.js` の `TTL_BY_KIND`、`store-cosmos.js` の `defaultTtl`)。利用規約・プライバシーポリシー(段階 B)に「ログの保存期間」として書く数字でもある
2. **`answer` は全件残す**(a)。DAU 3,000 を目安に (b)(不正解・速すぎる解答・待ち時間中は全件、正解は 1/10)へ。学習記録は `players.stats` に全件ぶん残るので、間引いても本人向けの成績は欠けない
3. **IP は日替わりの塩でハッシュ**(b)。`src = SHA-256(LOG_SALT + day + ip)` の先頭 16 桁。`LOG_SALT` は App Service のアプリ設定に入れる(`DEPLOY.md` 第 2 章)。未設定なら起動時の乱数(手元用)
4. **学習記録はレベルごと + 領域**: `players.stats.byLevel`(鍵は出題レベル)と `byBand`(鍵は 100 の位。`"0"` = Lv1〜99)を最初から持つ。保存は既存の `persistPlayer` に乗せる(追加の書き込みなし)
5. **パーティションキーは `/day` のまま**(作成済み、1 日 20 GB まで届かない)
6. **`intrude` / `capture` / `fortify` は `answer` と別の kind**(正解 1 回で 2 件。answer を間引いても奪取の記録は全件・長期で残る)
7. **`error` は「規則による拒否」と区別できる範囲だけ記録する**: `world.js` の規則による拒否は素の `Error` なので記録せず、別クラスの例外・`code` を持つ例外・`expected: false` の例外だけを `error` にする(`index.js` の `isUnexpected`)。`reject()` ヘルパーによる全面的な区別は入れない
8. **`control.daily` は東京だけで開始**(tier 6 の区・市 + tier 5 の東京都 + tier 3 の日本 = 52 件/日)。日本全体(約 1,800 件/日)になったときに tier 5・3 だけに絞るかを改めて決める

---

## 9. DB.md への反映案(2026-10-18 に書き写し済み。10 はポータル設定のあとに記録する)

1. **3.6 `events`**: 「仮の形」を本文書への参照に置き換える。`kind` の一覧(第 2.2 節)、共通項目(第 3.1 節)、`ttl` は種類ごと、`src` は日替わりハッシュ。予約の `notice` / `traceback` / `abuse` はそのまま残す
2. **3.6 の「週間ランキングと支配率はここから集計して結果を players か別の小さなドキュメントに書く」**: 実装は逆で、`players.weekPoints` と `regions.control` は操作のたびにサーバーが更新する集計値、`events` は**裏付けと推移**(第 5.1・5.2 節)。この文に直す
3. **3.3 `players`**: 「将来: stats、flags」を具体化。`stats` の形(第 3.2 節)、`flags` の形(`[{ kind, at, note, by }]`。第 5.4 節)、`connectedAt` は保存しない項目として `persistPlayer` の除外一覧に加える
4. **第 2 章のコンテナー表 `events` の行**: 「通知・逆探知・ログ・週間集計の元データ。TTL あり」→「出来事の記録(`docs/LOGS.md`)。既定 TTL 90 日、種類ごとに 30 日〜無期限。1 日に DAU × 100 件」。作る時期を「フェーズ 2」から「フェーズ 1 手順 9〜10(作成済み。設定は LOGS.md 7.7)」に
5. **第 4 章 インデックスと TTL**: `events` のインデックス ポリシー(第 7.7 節)と、複合インデックス `(day, kind, at desc)`・`(playerId, at desc)` を具体化。「TTL: events(90 日)」を「既定 90 日、ドキュメントの `ttl` で種類ごとに上書き」に
6. **第 6 章 環境変数**: `LOG_SALT`(接続元ハッシュの塩。未設定なら起動時の乱数)を追加
7. **第 7 章 未決 #3**(学習記録の粒度と保存の頻度)を本文書の第 8 章 #4 へ参照で寄せる
8. **第 8 章 実装**: `store.js` のメソッド一覧コメント(`appendEvent` / `appendEvents` / `eventsByDay` / `eventsOfPlayer` / `countEventsByKind`)を追記
9. **第 9 章**: 「4 つのコンテナー」はテンプレートに `meta` が入って 5 つになっている。`events`(と `teams` / `sessions`)の追加案(第 7.7 節)を反映したら数を直す
10. **第 10 章**: `events` の TTL とインデックスをポータルで設定した日付を記録に足す
