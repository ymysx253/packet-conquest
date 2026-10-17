# データベース構成(Azure Cosmos DB)

作成: 2026-10-17。保存口の実装(フェーズ 1 手順 5)と、以後のコンテナー追加の基準。
設計上の決定は `DESIGN.md` 第 4 章、項目の由来は各章を参照。

---

## 1. アカウントの設定

アカウント名: **`packet-conquest`**(2026-10-17 作成済み)。下の表は推奨の設定で、作成時に決めていない項目はポータルで確認し、違っていれば合わせる(容量モードと無料枠の割引は作成後に変えられないので最初に確認する)。

| 項目 | 推奨 | 理由 |
|---|---|---|
| API | NoSQL | JSON ドキュメントをそのまま保存 |
| リージョン | Japan East | App Service と同じ |
| 容量モード | プロビジョニング済みスループット + 無料枠の割引 | 1000 RU/s と 25 GB が無料(サブスクリプションに 1 アカウント)。サーバーレスには無料枠がない |
| 合計アカウント スループットの上限 | 1000 RU/s | 無料枠を超える請求を防ぐ安全装置。必要になったら上げる |
| geo 冗長・マルチリージョン書き込み・可用性ゾーン | すべてオフ | 段階 C(収益化)で再検討 |
| バックアップ | 定期(既定)または連続 7 日 | どちらも無料枠内 |
| ネットワーク | いまはすべて許可。公開前に App Service からだけに絞る | |

接続文字列・鍵はリポジトリに置かない。App Service のアプリ設定(環境変数 `COSMOS_CONNECTION_STRING`)に入れる。手元は Cosmos DB エミュレーターか、同じ環境変数で本番と別のデータベース名(`pc-dev`)を使う。将来は Managed Identity に切り替える。

---

## 2. データベースとコンテナー

データベース名: **`packet-conquest`**(手元の確認用は `pc-dev`)。
スループットは **データベース レベルで共有 1000 RU/s**(コンテナーごとに割り当てると最小 400 RU/s × 本数で無料枠を超える)。

| コンテナー | パーティションキー | 中身 | 作る時期 | 想定サイズ |
|---|---|---|---|---|
| `regions` | `/parent` | 地域マスター(宇宙 → 天体 → 大陸 → 国 → 地方 → 州 → 市区)。派生値つき | 手順 5 | 数百〜数千件 |
| `nodes` | 階層キー `[/country, /region]` | 拠点(マスター + ゲーム状態を一体で)。プレイヤーの拠点も同じコンテナー。世界に広げたときに国 → 地域の 2 段で分かれる | 手順 5 | 東京 715 + プレイヤー数。日本全体で数万件 |
| `players` | `/id` | プレイヤー(復帰コード、累計点、所属) | 手順 5 | プレイヤー数 |
| `questions` | `/nodeId` | 固定問題(Lv11 以上の一部)。拠点 × レベルで active を 1 つ | フェーズ 2 | 拠点数 × 数件 |
| `sessions` | `/playerId` | 長丁場シナリオの途中経過(再開用)。TTL あり | フェーズ 2〜3 | 同時プレイ数 |
| `events` | `/day` | 通知・逆探知・ログ・週間集計の元データ。TTL あり | フェーズ 2 | 多い(TTL で回収) |
| `sponsors` | `/id` | スポンサー(店・施設)と掲載条件 | 段階 C | 少ない |
| `terms` / `devices` | `/category` / `/id` | 技術用語マスター・機器種別マスター(いまは JSON ファイル。問題生成を DB 駆動にするときに移す) | 必要になったら | 数十〜数百件 |

読み方の基本: 起動時に `regions` と `nodes` を全件読み、以後はメモリで持ち、変更のたびに該当ドキュメントだけ書き戻す(`server/store.js` の `saveNode` / `savePlayer`)。クエリは管理と集計に限り、ゲームの 1 操作ごとに DB を読まない。

---

## 3. ドキュメントの形

すべてのドキュメントに `id`(文字列、コンテナー内で一意)と `type`(コンテナー名の単数形)を持たせる。日時は Unix ミリ秒(数値)。文字列の日付は使わない。

### 3.1 `regions`(`server/map/data/regions.json` + 派生値。`load.js` の `regionDocs()` が作る)

```json
{
  "id": "tokyo-chiyoda",
  "type": "region",
  "name": "千代田区",
  "nameEn": "Chiyoda",
  "kind": "city",
  "tier": 6,
  "kindLabel": "市・区・郡(拠点が属する最下層)",
  "localKind": "区",
  "code": "JP-13-13101",
  "country": "japan",
  "parent": "tokyo",
  "path": ["universe", "earth", "asia", "japan", "kanto", "tokyo", "tokyo-chiyoda"],
  "depth": 6,
  "status": "public",
  "nodeFile": null,
  "center": { "lat": 35.68442, "lon": 139.76035 },
  "bbox": { "minLat": 35.6735, "maxLat": 35.6984, "minLon": 139.7447, "maxLon": 139.7731 },
  "nodeCount": 8,
  "levels": { "1": 1, "2": 1, "3": 2, "4": 2, "5": 2 },
  "level": null
}
```

- `kind` と `tier`: universe 0 / body 1 / continent 2 / country 3 / region 4 / state 5 / city 6 / district 7。親は自分より浅い段
- `level`: 地域そのものを拠点として出すときの基礎レベル。国は 777(決定)。他は未決のため null
- 派生値(center、bbox、nodeCount、levels)は保存時に計算して入れる。拠点が増えたら再計算

### 3.2 `nodes`(拠点マスター + ゲーム状態。`load.js` の NODES と `world.js` の `masterToNode` / `spawnHome`)

```json
{
  "id": "st-002915",
  "type": "node",
  "name": "東京駅",
  "genre": "station",
  "alias": null,
  "kind": "HUB",
  "kindLabel": "駅・交通",
  "area": "千代田区",
  "country": "japan",
  "region": "tokyo-chiyoda",
  "lat": 35.68123,
  "lon": 139.76712,
  "location": { "type": "Point", "coordinates": [139.76712, 35.68123] },
  "level": 4,
  "value": 4,
  "hackable": true,
  "lines": ["東日本旅客鉄道 東海道線", "東京地下鉄 3号線丸ノ内線"],
  "tags": [],
  "subnet": "10.0.16.0/20",
  "base": 167776256,
  "span": 4094,
  "status": "public",
  "isPlayerNode": false,
  "registeredBy": null,
  "owner": null,
  "defense": 0,
  "protectedUntil": 0,
  "sponsorId": null,
  "createdAt": 1760670000000,
  "updatedAt": 1760670000000
}
```

- **マスターの項目**(登録・審査で決まる): name、genre、kind、area、country(地域マスターから引く。パーティションキーの 1 段目)、region、lat、lon、level、value、hackable、lines、alias、status、registeredBy、sponsorId
- **ゲーム状態の項目**(遊びで変わる): owner、defense、protectedUntil、updatedAt。`value` は基礎点で、画面に出す点数は `value + defense`
- `location` は Cosmos DB の地理空間クエリ用(GeoJSON Point は経度・緯度の順)。lat / lon と二重に持つ
- プレイヤーの拠点は `id` が `home-` で始まり、`isPlayerNode: true`、`kind: "HOME"`、`region` は開始地点の区(いまは `area` に「東京駅周辺」。region は `tokyo-chiyoda` にする)、`subnet` は 172.16.0.0/12 の /24、`span: 254`
- `status`: public(地図に出る)/ pending(審査中)/ hidden(非公開)。public 以外は配信しない
- 将来の項目(フェーズ 2): `traps`(設置したトラップ。配信は所有者だけ)、`questionLevel`(固定問題の現在レベル)

### 3.3 `players`(`world.js` の `join`。保存時は ws / online / pending / cooldownUntil を除く)

```json
{
  "id": "6d1e2f3a4b5c",
  "type": "player",
  "token": "a1b95fd6da0e",
  "name": "たろう",
  "color": "#E60012",
  "points": 12,
  "homeNodeId": "home-7f8e9d0c1b2a",
  "team": null,
  "sponsorId": null,
  "createdAt": 1760670000000,
  "lastSeen": 1760673600000
}
```

- `token` は復帰コード(持っていれば本人)。将来ログインを入れたら `login: { provider, subject }` を足し、token は補助にする
- `team` は陣営の予約。`sponsorId` はスポンサー拠点への所属(8.16)
- 累計点 `points` は奪取時点の点(強化込み)の合計。現在の点数は nodes から集計する(保存しない)
- 将来: `stats`(題材ごとの正答率。学習記録)、`flags`(異常検知の印)

### 3.4 `questions`(固定問題。`LEVELS.md` 第 5 章の seed 方式)

```json
{
  "id": "q-st-002915-120-000003",
  "type": "question",
  "nodeId": "st-002915",
  "level": 120,
  "templateId": "route-longest-match-v1",
  "seed": 918273645,
  "generatorVersion": "2026.10",
  "status": "active",
  "rendered": {
    "text": "次の経路表を持つルータに 10.4.17.9 宛のパケットが届いた。転送先は？",
    "table": { "headers": ["宛先ネットワーク", "ネクストホップ"], "rows": [["0.0.0.0/0", "10.0.0.1"], ["10.4.0.0/16", "10.0.0.2"]] },
    "answerKind": "choice",
    "options": ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]
  },
  "answer": { "index": 1, "accept": ["10.0.0.2"] },
  "explanation": "…",
  "defenseNote": "…",
  "createdAt": 1760670000000,
  "expiresAt": 1761274800000,
  "clearedBy": null,
  "clearedAt": null
}
```

- 拠点 × レベルで `status: "active"` はつねに 1 つ。クリアで `cleared` にして次の seed を生成、期限で `expired`
- `rendered`(本文・表・選択肢)と `answer` を保存するのは、生成器の版が変わっても同じ問題を再現するため。クライアントには `rendered` だけ送る
- `answerKind`: choice(4 択)/ text(入力式。`accept` に正規化済みの正解を複数)/ command / config(フェーズ 3 以降)

### 3.5 `sessions`(長丁場シナリオの途中経過。フェーズ 2〜3)

`{ id, type: "session", playerId, questionId, nodeId, state: {...シナリオの進行}, startedAt, updatedAt, ttl }`。`ttl` で自動削除(例: 7 日)。

### 3.6 `events`(通知・ログ・集計の元。フェーズ 2)

`{ id, type: "event", day: "2026-10-17", kind: "capture" | "fortify" | "traceback" | "notice" | "abuse", playerId, nodeId, detail, at, ttl }`。週間ランキングと支配率はここから集計して結果を `players` か別の小さなドキュメントに書く。

### 3.7 `sponsors`(段階 C)

`{ id, type: "sponsor", name, displayName, logo, link, plan, startAt, endAt, billingStatus, nodeIds: [], memberCount, status }`。拠点側は `sponsorId` で参照。`DESIGN.md` 3.8。

### 3.8 `terms` / `devices`

`server/questions/data/terms.json` と `devices.json` の 1 行がそのまま 1 ドキュメント。いまはファイルのまま使い、問題生成を DB 駆動にするときに移す。

---

## 4. インデックスと TTL

- 既定のインデックス(全項目)で始める。書き込みが増えたら `nodes` の `lines`、`questions` の `rendered` を除外して RU を節約する
- 地理空間クエリを使う `nodes` は、インデックス ポリシーで `/location/?` に `Point` の空間インデックスを追加する(`regions` の `center` も同様)
- TTL: `sessions`(7 日)、`events`(90 日)。それ以外は無期限
- 複合インデックス(集計用、必要になったら): `nodes` の `(region, owner)`、`events` の `(day, kind)`

---

## 5. 運用の決めごと

- **書き込みはサーバーだけ**。画面から DB に触らない(SECURITY.md の原則)
- 変更は該当ドキュメントの上書き(`upsert`)。衝突は 1 台運用のうちは起きない。複数台(フェーズ 4)では `_etag` の楽観的ロックを使う
- 一括処理(駅の取り込み、問題の生成と検証、地域の追加)はローカルのスクリプトで行い、本番サーバーでは回さない(`DESIGN.md` 第 12 章)
- 手元の確認は Cosmos DB エミュレーター、または本番アカウントの別データベース `pc-dev`。本番のデータベースに手元から書かない
- 無料枠の監視: ポータルのメトリクスで RU 消費と保存量を月 1 回見る。合計スループットの上限 1000 RU/s は超えない

---

## 6. 環境変数(手順 5 で `server/store.js` が読む)

| 変数 | 内容 | 未設定のとき |
|---|---|---|
| `COSMOS_CONNECTION_STRING` | 接続文字列 | メモリ版で動く(保存しない) |
| `COSMOS_DATABASE` | データベース名(`packet-conquest` / `pc-dev`) | `packet-conquest` |
| `COSMOS_SEED` | `1` なら起動時に `nodes` が空のとき拠点マスターを流し込む | `1` |

---

## 7. 未決

1. (決定 2026-10-17)`nodes` は階層パーティションキー `[/country, /region]`。国ごとにコンテナーは分けない
2. `questions` の有効期限の長さ、拠点 × レベルの本数(`DESIGN.md` 3.5)
3. 学習記録(`players.stats`)の粒度と保存の頻度
4. Managed Identity への切り替え時期

**パーティションキーについて(2026-10-17 補足)**: `/region` は区・市ごとに分かれる(東京だけで 50 の値)ので 1 つの箱にはならない。ただしパーティションキーはコンテナー作成後に変えられないため、`nodes` は最初から階層パーティションキー `[/country, /region]` で作る。拠点ドキュメントには `country` を持たせる(地域マスターの `country` を保存時に写す)。`regions` は `/parent` のままでよい(件数が少ない)。

**2026-10-17 追記(DESIGN.md 第 13 章)**: 全件を起動時に読まない。拠点に `tile`(緯度 0.025° × 経度 0.03° の格子の id、例 `t:1427:4659`)を持たせ、`country` + `tile IN (...)` で画面に見えている範囲だけ読む。`tile` にはインデックスを残す。プレイヤー ドキュメントに `score` と `nodesOwned` の集計値を持ち、ランキングは `players` を `score` の降順で読む(`score` の範囲インデックス)。架空ネットワーク(`subnet` / `base`)は拠点 id から決定的に作るので保存しなくてよい(表示用に `subnet` だけ残す)。

## 8. 実装(2026-10-17)

- `server/store-cosmos.js`: 保存口の Cosmos 版。`ensure()` がデータベース(共有 1000 RU/s)とコンテナーを「あれば使う、なければ作る」。`loadTiles` は `country`(階層キーの 1 段目)で絞って `t<z> IN (...)` と `level >= 最小`
- `tools/db-setup.js`(`npm.cmd run db:setup -- --db pc-dev`): regions を上書き、nodes は空なら全部、`--force` でマスター項目だけ更新(owner / defense などのゲーム状態は保つ)
- `server/env.js`: `.env` を読む(Git 管理外)。`.env.example` が雛形
- `test/cosmos.js`: 接続文字列があるときだけ、一時データベース `pc-test` で読み書きと復元を検証して削除する
