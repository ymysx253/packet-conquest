# パケット陣取り / Packet Conquest

ネットワークの知識に正解して陣地を広げる、オンライン対戦の学習ゲーム。
**設計の全体像・確定仕様・未決事項は `docs/DESIGN.md` にある。作業の前に必ず読むこと。** レベル定義(1〜999 を知識の領域 100 ごと × 10 段で定義)は `docs/LEVELS.md`、不正耐性(画面は信用しない原則、直すべき穴、ボット対策)は `docs/SECURITY.md`、拠点に使ってよい名所のジャンルは `docs/PLACES.md`、Cosmos DB のコンテナーとドキュメントの形は `docs/DB.md`。 プレイヤー向けの遊び方(いまの規則の説明書。規則を変えたら一緒に直す)は `docs/MANUAL.md`。

## 現状

- フェーズ1(日本・永続ワールド)を実装中。東京 715 拠点(全駅 + 名所)、Lv1〜10 の生成問題、復帰コード、初心者保護、Cosmos DB 保存(`.env` の接続文字列で切り替え。本番データベース `packet-conquest`)まで済
- レベルは「問われる知識の難しさ」だけで決める(1〜999。`docs/LEVELS.md`)。制限時間・2 問連続は難易度に使わない。突破に必要な正解の回数は拠点のつながりの本数(`adj` / `hits`。駅は同じ路線の前後の駅)。強化で出題レベルが上がり、24 時間ごとに 1 下がる。都道府県・国は拠点ではなく配下の集まりで、配下の 3/4 以上を持つと支配(DESIGN.md 第 14 章)
- フェーズ計画と実装手順は `docs/DESIGN.md` 第 5 章、未決事項は第 6 章。未決のものは勝手に決めて実装しない

## コマンド

ユーザーの環境は Windows + PowerShell で、実行ポリシーにより `npm` が使えない。案内するときは `npm.cmd` を使う。

```
npm.cmd install
npm.cmd start          # http://localhost:3000(Windows は start-game.cmd をダブルクリックでも可)
npm.cmd test           # 問題生成(5万問)・拠点マスター・形・ワールドの検証
npm.cmd run test:e2e   # サーバー起動中に実行。2人で1試合を通す
```

## 構成

- `server/index.js`: HTTP 配信 + WebSocket(`/ws`)。`PORT` 環境変数を使う(Azure App Service 用)
- `server/world.js`: 永続ワールド(参加・自分の拠点の生成・攻撃/防御・初心者保護・再生成・配信)
- `server/store.js`: 保存口(メモリ版)。`server/store-cosmos.js` が Cosmos DB 版で、`COSMOS_CONNECTION_STRING` があればそちらを使う。拠点のつながりは `tools/import-links.js` で作り、マスターを入れ直すときは `node tools/db-setup.js --force`
- `server/questions/data/terms.json`: 技術用語マスター(標準名とベンダー固有名)/ `devices.json`: 機器種別マスター(架空メーカー)。名前を使うときはここを引く
- `server/questions/index.js`: 問題の取得口(レベル → 生成器の対応はここ 1 か所) / `server/questions/subnet.js`: Lv1〜3 サブネット計算 / `server/questions/basics.js`: Lv4〜10(VLSM、集約、IPv6、経路表、ARP/MAC 表、ACL、NAT 表)。Lv11 以上は LEVELS.md の階段に沿って追加する。固定問題は DB(Cosmos DB の questions)に テンプレート id・seed・版 で保存する前提
- `server/map/data/regions.json`: 地域マスター(宇宙→天体→大陸→国→地方→州→市・区。段(tier)で表す共通の階層。DB の regions と同じ項目) / `server/map/data/tokyo.json`: 東京の拠点マスター(DB の nodes と同じ項目。`region` で区・市を指す)。拠点や地域を足すときはこれらに1行追加し `npm.cmd test` で検証 / `server/map/load.js`: 読み込み・検証・保存用の形(`regionDocs`) / `server/map/geo.js`: 距離・リンク自動生成
- 画面は緯度・経度を受け取って自分で投影する(サーバーは描画座標を送らない)
- `public/`: 画面(ビルド不要の HTML / CSS / JS)

## 守ること

- UI の文言はすべて日本語。名称は「パケット陣取り」、英語名は「Packet Conquest」
- 問題の答えは正確でなければならない。計算で決まるものはプログラムで生成し、`test/check.js` のように検証テストを付ける
- コマンド入力は手で打つ方式を守る。コマンドを選ぶボタンは作らない(Tab 補完と ↑ 履歴は可)
- ターミナルはゲーム内の架空ネットワークだけで動く模擬環境にする。実在システムへの接続、実在企業を攻撃対象にする表現、実在サーバーのアドレス、本物に使える攻撃手順は入れない
- サーバー側で答えを持ち、判定する(クライアントに正解を送らない)
- 配置先は Azure App Service。WebSocket の有効化が必要
