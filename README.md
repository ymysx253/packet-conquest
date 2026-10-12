# パケット陣取り / Packet Conquest(フェーズ1 開発中)

ネットワークの問題に正解して、自分のネットワークを隣の拠点へ広げていくオンライン陣取りゲームです。
世界は1つで制限時間はありません。まずは東京周辺の約30拠点から始め、地図を外へ広げていきます。
設計の全体像は `docs/DESIGN.md` にあります。

## ルール(フェーズ1 時点)

- 参加すると、東京駅の近くに**自分専用の拠点**が生まれ、近い2つの拠点とつながります
- **自分の拠点とつながっている拠点**をタップすると「攻撃」。正解すると相手の防御 Lv が1下がり、0なら奪えます
- **自分の拠点**をタップすると「防御強化」。正解すると防御 Lv が1上がります(最大3)
- 中立の拠点は場所ごとに難易度(Lv1〜3)が決まっています。東京タワーや国会議事堂などは高難度。他のプレイヤーの陣地は Lv4
- 不正解だと4秒間、操作できません
- 点数は拠点ごとに 1〜5 点。奪った拠点の点数は累計点としても記録されます
- **初心者保護**: 生まれたばかりの拠点は24時間、拠点が3つ以下のプレイヤーは攻撃されません
- 切断しても拠点は残ります。**復帰コード**を入れれば別の端末からも同じプレイヤーとして続けられます

問題は Lv1〜4 がプログラムで自動生成(答えは常に正確)、Lv5 以上は固定問題を DB に持つ予定です(フェーズ2)。

## ファイル構成

```
server/index.js            HTTP で画面を配信し、WebSocket(/ws)で世界の状態を中継する
server/world.js            永続ワールド(参加・拠点の生成・攻撃/防御・初心者保護・配信)
server/store.js            保存口(いまはメモリ版。Cosmos DB 版を追加予定)
server/map/tokyo.js        東京周辺の拠点マスター(緯度・経度・Lv・点数)。初回起動時のシード
server/map/geo.js          距離の計算、投影、リンクの自動生成
server/questions/index.js  問題の取得口(Lv1〜4 は生成、Lv5 以上は DB)
server/questions/subnet.js サブネット問題の自動生成
public/                    ブラウザの画面(index.html, style.css, app.js)
test/check.js              問題生成の検証(3万問を計算し直して答えを確認)
test/map.js                拠点マスターの検証(重複・座標・Lv・リンクの連結)
test/world.js              永続ワールドの検証(参加・攻撃・保護・復帰・再起動)
test/e2e.js                2人で接続して参加から奪取・復帰まで通す動作確認
```

## 手元で動かす

Node.js 20 以上が必要です(https://nodejs.org の LTS 版)。Windows の PowerShell では `npm` の代わりに `npm.cmd` を使います。

```bash
npm install
npm start
# → ブラウザで http://localhost:3000 を開く
```

- **1人で試す**: 名前を入れて「東京に参加する」。隣の拠点を取って広げていけます
- **2人以上で試す**: 別のブラウザ(またはプライベートウィンドウ)で開いて参加する。同じブラウザの別タブは同じプレイヤーになります
- **別の端末で続ける**: 画面右の「復帰コード」を参加画面に入力する
- **スマホで試す**: パソコンと同じ Wi-Fi につなぎ、`http://<パソコンのIPアドレス>:3000` を開く。
  IP アドレスは Windows なら `ipconfig`、Mac なら「システム設定 → Wi-Fi → 詳細」で確認できます。
  つながらない場合は、パソコンのファイアウォールが Node.js の通信を許可しているか確認してください
- **止める**: ターミナルで Ctrl + C。いまは保存先がメモリなので、止めると世界は初期状態に戻ります

### 自動テスト

```bash
npm test            # 問題3万問・拠点マスター・永続ワールドの検証
npm run test:e2e    # サーバー起動中に別のターミナルで実行。2人で参加から奪取・復帰まで通す
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

世界の状態はサーバーのメモリに持ち、変更を DB に書き込む作りです。インスタンスを2台以上に増やすと、別のサーバーにつながった人どうしで状態が食い違います。
台数を増やす段階(フェーズ4)で **Azure Web PubSub** や **Azure Cache for Redis** を使う作りに変えます。

### 5. 動作確認

- `https://<アプリ名>.azurewebsites.net/healthz` が `ok rooms=…` を返せばサーバーは起動しています
- ログを見る: `az webapp log tail -g packet-jintori-rg -n <アプリ名>`

## 次に作るもの

`docs/DESIGN.md` の第8章(フェーズ計画)を参照。
