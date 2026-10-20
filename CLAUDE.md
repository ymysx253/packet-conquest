# パケット陣取り / Packet Conquest

ネットワークの知識に正解して陣地を広げる、オンライン対戦の学習ゲーム。
**設計の全体像・確定仕様・未決事項は `docs/DESIGN.md` にある。作業の前に必ず読むこと。** レベル定義(1〜999 を知識の領域 100 ごと × 10 段で定義)は `docs/LEVELS.md`、不正耐性(画面は信用しない原則、直すべき穴、ボット対策)は `docs/SECURITY.md`、拠点に使ってよい名所のジャンルは `docs/PLACES.md`(ジャンルごとの数と足す候補は `docs/GENRE.md`)、Cosmos DB のコンテナーとドキュメントの形は `docs/DB.md`。課金のルール(有料の要素と共通の決まり)は `docs/BILLING.md`。地図データ(地域・拠点・航路・出典)の形式と協力企業との受け渡しは `docs/DATA-FORMAT.md`(拠点・航路・出典を足すときは必ず従う)。 プレイヤー向けの遊び方(いまの規則の説明書。規則を変えたら一緒に直す)は `docs/MANUAL.md`。

## 現状

- フェーズ1(日本・永続ワールド)を実装中。全国 47 都道府県の駅 8,973 + 名所 3,079(東京の手作り 64 + Wikidata から 3,015。都道府県庁舎は 47 そろい、7 県は位置参照情報の座標)+ 離島の空港・港・島 111 + 航路の端の空港・港 304 ほか + 全国の町・字 101,584(`tools/import-towns.js`。国勢調査の小地域、丁目はまとめる)+ 観光地 531(`tools/import-tourism.js`。温泉・景勝地・滝・岬・峠・町並み)+ 離島の仮の港 179(`pp-`。`tools/import-links.js`。道でつながる島は国土地理院の道路中心線で調べてふつうの線で結ぶ。`tools/fetch-road-links.js`)= 公開 114,811 拠点(ほかに非公開 24: 自衛隊・米軍の飛行場と基地・演習場、皇居、立ち入り制限の島、北方領土・尖閣諸島)、空路 538・海路 689 の航路の記録 + 幻の航路 187(道も航路も無い離島の港・仮の港といちばん近い港を結ぶ。1 日 20 分だけ、航路ごとに時間をずらす)(`server/map/data/routes/`。公開データに無い航路は会社の航路図で確かめて `docs/routes/hand-routes.csv` → `tools/import-hand-routes.js` で足す。いま 7 件。季節航路は毎日 UTC 3〜10 時(サーバーの時計)だけ使える)、全国 1,900 市区町村の地域マスターと境界、Lv1〜10 の生成問題、復帰コード、初心者保護、Cosmos DB 保存(`.env` の接続文字列で切り替え。本番データベース `packet-conquest`)まで済
- レベルは「問われる知識の難しさ」だけで決める(1〜999。`docs/LEVELS.md`)。拠点の基礎レベルは国会議事堂 777 を物差しに段ごと(町・字 1〜9、駅 10〜200、名所 15〜70、観光地 15〜300、空港 150〜500、庁舎 400。`docs/LEVEL-PLAN.md`、`tools/levels.js`)。問題の無いレベルの拠点は占領・強化できない。制限時間・2 問連続は難易度に使わない。突破に必要な正解の回数は拠点のつながりの本数(`adj` / `hits`。駅は同じ路線の前後の駅)。隣を自分かチームが 2 つ以上押さえていると 2 つ目から 1 つにつき 1 回減る(囲み。最低 1。World.siege)。つながりはすぐ隣だけ: 間にほかの町があれば飛び越えず、海の上ではつながらない(路線・空路・海路は別。`tools/import-towns.js`、海の判定は `tools/sea.js`)。強化で出題レベルが上がり、24 時間ごとに 1 下がる。都道府県・国は拠点ではなく配下の集まりで、配下の 3/4 以上を持つと支配(DESIGN.md 第 14 章)。チームは個人に付き(作成か参加、所属中は作成不可。チームにいる間に取った拠点は、抜けるとチームの持ち物)、回数の合算と支配はチーム単位。ランキングは総合 3 種 + 週間 + チーム
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
- `server/questions/index.js`: 問題の取得口(レベル → 生成器の対応はここ 1 か所) / `server/questions/subnet.js`: Lv1〜3 サブネット計算 / `server/questions/basics.js`: Lv4〜10(VLSM、集約、IPv6、経路表、ARP/MAC 表、ACL、NAT 表)。Lv11 以上は LEVELS.md の階段に沿って追加する(設計書は `docs/questions/`: README → COMMON → design-11-50 / design-51-100 の順に読む)。固定問題は DB(Cosmos DB の questions)に テンプレート id・seed・版 で保存する前提
- `server/map/data/regions.json`: 地域マスター(宇宙→天体→大陸→国→地方→州→市・区。段(tier)で表す共通の階層。DB の regions と同じ項目) / `server/map/data/tokyo.json`: 東京の拠点マスター(DB の nodes と同じ項目。`region` で区・市を指す)。拠点や地域を足すときはこれらに1行追加し `npm.cmd test` で検証 / `server/map/load.js`: 読み込み・検証・保存用の形(`regionDocs`) / `server/map/geo.js`: 距離・リンク自動生成
- 画面は緯度・経度を受け取って自分で投影する(サーバーは描画座標を送らない)
- `public/`: 画面(ビルド不要の HTML / CSS / JS)。`public/data/bounds/<都道府県>.json` と `japan.json`(粗い全国版)は区・市の境界(`tools/import-boundaries.js` が国土数値情報 N03 から作る)。`public/data/water.json` は湖・湾の形(`tools/import-water.js`。薄い水色で塗る)。`public/data/sea-paths.json` は海路を海の上に描く道すじ(`tools/build-sea-paths.js`。海路の記録や境界を変えたら作り直す)。拠点マスターは都道府県ごとのファイル(`tokyo.json`、`kanagawa.json`、`chiba.json` …)で、`server/map/all.js` が全部まとめて読む。地域マスターは全国の都道府県・市区町村を持つ(`tools/import-regions.js`)
- 手元の確認は保存をメモリ版にして(環境変数 `STORE=memory`。`.claude/launch.json` の `packet-conquest-memory`)ブラウザで行う。本番 DB に確認用の書き込みをしない。DB の確認は `npm.cmd test` の `pc-test`(作って消す)

## 守ること

- UI の文言はすべて日本語。名称は「パケット陣取り」、英語名は「Packet Conquest」
- 問題の答えは正確でなければならない。計算で決まるものはプログラムで生成し、`test/check.js` のように検証テストを付ける
- コマンド入力は手で打つ方式を守る。コマンドを選ぶボタンは作らない(Tab 補完と ↑ 履歴は可)
- ターミナルはゲーム内の架空ネットワークだけで動く模擬環境にする。実在システムへの接続、実在企業を攻撃対象にする表現、実在サーバーのアドレス、本物に使える攻撃手順は入れない
- サーバー側で答えを持ち、判定する(クライアントに正解を送らない)
- 地図に入れる地理データは使用許諾を確かめる(商用可か CC BY 4.0 のものだけ。国土数値情報の港湾・漁港・航路は非商用なので使わない)。北方領土・尖閣諸島(領有をめぐる争い)と軍事施設はゲームで扱わない。どちらも DB には非公開(`status: hidden`)で入れておく(`tools/military.js`、`tools/import-towns.js`)。本番 DB への反映(`tools/db-setup.js --force`)は、マスターの中身が変わった拠点だけを書く
- 配置先は Azure App Service。WebSocket の有効化が必要。手順は `docs/DEPLOY.md`(ポータルで作成、`make-zip.cmd` の zip を Kudu に置く)
