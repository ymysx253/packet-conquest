# パケット陣取り / Packet Conquest

ネットワークの知識に正解して陣地を広げる、オンライン対戦の学習ゲーム。
**設計の全体像・確定仕様・未決事項は `docs/DESIGN.md` にある。作業の前に必ず読むこと。** レベル定義(1〜999 を知識の領域 100 ごと × 10 段で定義)は `docs/LEVELS.md`、不正耐性(画面は信用しない原則、直すべき穴、ボット対策)は `docs/SECURITY.md`、拠点に使ってよい名所のジャンルは `docs/PLACES.md`。

## 現状

- 試作版 v0.1: 部屋コード制・4分間の対戦。サーバーのメモリに状態を持つ(1インスタンス専用)
- 次の目標: 制限時間なしの永続ワールド(全世界ネットワーク)と、10段階の難易度(レベル7〜10は制限時間つきのコマンド入力)
- フェーズごとに進める。順番と各フェーズの残課題は `docs/DESIGN.md` 第8章にある。フェーズ1は日本・永続ワールド
- フェーズ1の残課題は 8.2 で決定済み(#7 全滅時の再開のみ保留)。実装手順は 8.5。未決のものは勝手に決めて実装しない

## コマンド

ユーザーの環境は Windows + PowerShell で、実行ポリシーにより `npm` が使えない。案内するときは `npm.cmd` を使う。

```
npm.cmd install
npm.cmd start          # http://localhost:3000(Windows は start-game.cmd をダブルクリックでも可)
npm.cmd test           # 問題生成の検証(3万問)
npm.cmd run test:e2e   # サーバー起動中に実行。2人で1試合を通す
```

## 構成

- `server/index.js`: HTTP 配信 + WebSocket(`/ws`)。`PORT` 環境変数を使う(Azure App Service 用)
- `server/world.js`: 永続ワールド(参加・自分の拠点の生成・攻撃/防御・初心者保護・再生成・配信)
- `server/store.js`: 保存口。いまはメモリ版。手順5で Cosmos DB 版を追加し環境変数で切り替える
- `server/questions/index.js`: 問題の取得口(Lv1〜4 は生成、Lv5 以上は DB の固定問題) / `server/questions/subnet.js`: サブネット問題の生成
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
