# パケット陣取り / Packet Conquest(試作版 0.1)

サブネット計算の問題に正解して、自分のネットワークを隣の拠点へ広げていくオンライン対戦ゲームです。
日本とその周辺を簡略化したネットワーク地図の上で、最大6人(ボットを含む)が4分間で点数を競います。

## ルール

- 開始時に1つずつ拠点をもらいます
- **自分の拠点とつながっている拠点**をタップすると「攻撃」。問題に正解すると、相手の防御レベルが1下がり、0なら奪えます
- **自分の拠点**をタップすると「防御強化」。正解すると防御レベルが1上がります(最大3)
- 防御レベルが高い拠点ほど、問題が難しくなります(難易度1〜3)
- 不正解だと4秒間、操作できません
- 点数: データセンター(DC)1点、海底ケーブルの陸揚げ拠点(GW)2点、相互接続点(IX)3点
- 拠点をすべて失っても、どこからでも再侵入できます

問題(サブネットマスク、ネットワークアドレス、ブロードキャストアドレス、ホスト数、同じネットワークの判定)はプログラムがその場で計算して作るので、何度遊んでも問題が尽きず、答えは常に正確です。解答後には解き方の解説が出ます。

## ファイル構成

```
server/index.js            HTTP で画面を配信し、WebSocket(/ws)で対戦を中継する
server/room.js             部屋・得点・ボットなどのゲーム進行
server/map/tokyo.js        東京周辺の拠点マスター(緯度・経度・Lv・点数)
server/map/geo.js          緯度経度から描画座標とリンクを計算
server/map/japan.js        旧地図(永続ワールド化で削除予定)
server/questions/subnet.js 問題の自動生成(サブネット計算)
public/            ブラウザの画面(index.html, style.css, app.js)
test/check.js      問題生成の検証(3万問を計算し直して答えを確認)
test/map.js        拠点マスターの検証(重複・座標・Lv・リンクの連結)
test/e2e.js        2人で接続して1試合を通す動作確認
```

## 手元で動かす

Node.js 20 以上が必要です(https://nodejs.org の LTS 版)。

```bash
npm install
npm start
# → ブラウザで http://localhost:3000 を開く
```

- **1人で試す**: 部屋に入って「ボットを追加」→「ゲーム開始」
- **2人以上で試す**: 同じブラウザでタブをもう1つ開き、同じ部屋コードで入る(タブごとに別のプレイヤーになります)
- **スマホで試す**: パソコンと同じ Wi-Fi につなぎ、`http://<パソコンのIPアドレス>:3000` を開く。
  IP アドレスは Windows なら `ipconfig`、Mac なら「システム設定 → Wi-Fi → 詳細」で確認できます。
  つながらない場合は、パソコンのファイアウォールが Node.js の通信を許可しているか確認してください
- **止める**: ターミナルで Ctrl + C

### 自動テスト

```bash
npm test            # 問題3万問を計算し直して、答えが正しいか確認
npm run test:e2e    # サーバー起動中に別のターミナルで実行。2人で1試合を通す
```

## Azure App Service にデプロイする

### 1. Azure CLI でまとめて作成・デプロイ(いちばん簡単)

```bash
az login
cd packet-conquest
az webapp up \
  --name <世界で一意なアプリ名> \
  --resource-group packet-jintori-rg \
  --location japaneast \
  --runtime "NODE:20-lts" \
  --sku B1 \
  --os-type Linux
```

完了すると `https://<アプリ名>.azurewebsites.net` で遊べます。`npm install` はデプロイ時に Azure 側で実行されます。
2回目以降の更新は、同じフォルダで `az webapp up` をもう一度実行するだけです。

### 2. 必ず確認する設定

```bash
# WebSocket を有効にする(対戦の通信に必須)
az webapp config set -g packet-jintori-rg -n <アプリ名> --web-sockets-enabled true

# 誰も遊んでいない間にアプリが止まらないようにする(B1 以上で使える)
az webapp config set -g packet-jintori-rg -n <アプリ名> --always-on true

# 起動コマンド(通常は自動で npm start になるが、明示しておくと確実)
az webapp config set -g packet-jintori-rg -n <アプリ名> --startup-file "npm start"
```

ポータルで設定する場合は「構成 → 全般設定」の「Web ソケット」「常時接続」をオンにします。

### 3. 料金プランの注意

| プラン | 向いている用途 | 注意点 |
|---|---|---|
| Free (F1) | 動作確認だけ | WebSocket の同時接続数が少なく、1日の CPU 時間にも上限がある。常時接続も使えない |
| Basic (B1) | **試作品のテストにおすすめ** | 月額数千円程度。常時接続が使える |
| Standard 以上 | 公開・本番 | スロット(本番と検証の切り替え)や自動スケールが使える |

### 4. インスタンス数は1台にしておく

この試作版は、部屋と試合の状態をサーバーのメモリに持っています。インスタンスを2台以上に増やすと、同じ部屋の人が別のサーバーにつながって対戦できなくなります。
台数を増やす段階になったら、**Azure Web PubSub** や **Azure Cache for Redis** で状態を共有する作りに変えます。

### 5. 動作確認

- `https://<アプリ名>.azurewebsites.net/healthz` が `ok rooms=…` を返せばサーバーは起動しています
- ログを見る: `az webapp log tail -g packet-jintori-rg -n <アプリ名>`

## 次に作るとよいもの

1. ログインと、試合をまたいだランキング(Azure Database for PostgreSQL など)
2. 問題の種類を増やす(ルーティング、ポート番号、DNS、OSI 参照モデル)
3. 階層ごとに能力が解放される、長期のやりこみ要素
4. 実際のインターネットのつながり方(AS・海底ケーブル)を元にした地図
