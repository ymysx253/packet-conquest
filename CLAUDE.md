# パケット陣取り / Packet Conquest

ネットワークの知識に正解して陣地を広げる、オンライン対戦の学習ゲーム。
**設計の全体像・確定仕様・未決事項は `docs/DESIGN.md` にある。作業の前に必ず読むこと。**

## 現状

- 試作版 v0.1: 部屋コード制・4分間の対戦。サーバーのメモリに状態を持つ(1インスタンス専用)
- 次の目標: 制限時間なしの永続ワールド(全世界ネットワーク)と、10段階の難易度(レベル7〜10は制限時間つきのコマンド入力)
- フェーズごとに進める。順番と各フェーズの残課題は `docs/DESIGN.md` 第8章にある。フェーズ1は日本・永続ワールド
- `docs/DESIGN.md` の「未決事項」と第8章の残課題は、実装に入る前にユーザーと決めること。勝手に決めて実装しない

## コマンド

ユーザーの環境は Windows + PowerShell で、実行ポリシーにより `npm` が使えない。案内するときは `npm.cmd` を使う。

```
npm.cmd install
npm.cmd start          # http://localhost:3000
npm.cmd test           # 問題生成の検証(3万問)
npm.cmd run test:e2e   # サーバー起動中に実行。2人で1試合を通す
```

## 構成

- `server/index.js`: HTTP 配信 + WebSocket(`/ws`)。`PORT` 環境変数を使う(Azure App Service 用)
- `server/room.js`: 進行(フェーズ1で永続ワールド `world.js` に作り替える) / `server/map/japan.js`: 地図 / `server/questions/subnet.js`: 問題の自動生成
- `server/map/`、`server/questions/` は地域・問題の種類ごとにファイルを増やす。保存処理は `server/store.js`、SQLite ファイルは `data/`(Git 管理外)
- `public/`: 画面(ビルド不要の HTML / CSS / JS)

## 守ること

- UI の文言はすべて日本語。名称は「パケット陣取り」、英語名は「Packet Conquest」
- 問題の答えは正確でなければならない。計算で決まるものはプログラムで生成し、`test/check.js` のように検証テストを付ける
- コマンド入力は手で打つ方式を守る。コマンドを選ぶボタンは作らない(Tab 補完と ↑ 履歴は可)
- ターミナルはゲーム内の架空ネットワークだけで動く模擬環境にする。実在システムへの接続、実在企業を攻撃対象にする表現、実在サーバーのアドレス、本物に使える攻撃手順は入れない
- サーバー側で答えを持ち、判定する(クライアントに正解を送らない)
- 配置先は Azure App Service。WebSocket の有効化が必要
