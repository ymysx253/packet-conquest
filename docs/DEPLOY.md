# Azure App Service への配置(フェーズ 1 手順 10)

ポータルだけで進められる手順。コマンドは手元の zip 作成(`make-zip.cmd` のダブルクリック)と `LOG_SALT` の乱数作りだけ。2026-10-18 作成、2026-10-21 実際の画面に合わせて全項目を順番どおりに書き直し(変えない項目も書く)。

## 0. 前提

- Cosmos DB アカウント `packet-conquest`(Japan East、無料枠、合計 1000 RU/s)とデータベース `packet-conquest` は作成済み(`docs/DB.md` 第 10 章)
- ドメイン `packet-conquest.com` は 2026-10-21 に取得済み(第 6 章)。無くても `*.azurewebsites.net` で動く
- サーバーは `PORT` 環境変数で待ち受け、保存先は `COSMOS_CONNECTION_STRING` と `COSMOS_DATABASE` で決まる。WebSocket は `/ws`

## 1. App Service を作る

画面に出る順に、**変えない項目も含めて全部**書く(2026-10-21 実際に作ったときの画面に合わせた)。「既定のまま」は触らなくてよい項目。

ポータル → 「App Service」→ 上の「＋ 作成」→ **「Web アプリ」**(「Web アプリとデータベース」「WordPress on App Service」「Web アプリ (Managed Instance 用)」は選ばない。データベースは作成済みの Cosmos DB を使う)。

### 1-1. 「基本」タブ

| 項目 | 値 | 理由 |
|---|---|---|
| サブスクリプション | 使うサブスクリプション | |
| リソース グループ | 新規 `packet-conquest_group`(既定で出る名前のまま) | まとめて管理 |
| 名前 | `packet-conquest` | いまの Azure は名前の後ろに自動で文字と地域が付く(例: `packet-conquest-xxxx.japaneast-01.azurewebsites.net`)。URL に `japaneast` が入っているかで地域も確かめる |
| 安全な一意の既定のホスト名 | 有効(既定のまま) | 上の自動で付く名前のこと |
| 公開 | **コード** | |
| ランタイム スタック | **Node 24 LTS**(無ければ 22 LTS) | Node 20 は 2026-04 でサポート終了。手元の確認は Node 24 |
| オペレーティング システム | **Linux**(Node を選ぶと Linux になる) | 安く、Node の扱いが素直 |
| リージョン | **Japan East** | Cosmos DB と同じ(遅延と転送費) |
| Linux プラン | 「新規作成」→ `asp-packet-conquest` | プランの名前の頭に `asp-` を付けるのがよくある付け方。あとから名前は変えられないが、動きには関係しない |
| 価格プラン | **Basic B1**(1.75 GB メモリ。確認画面では「SKU Basic、サイズ S」と出る)。**既定で Premium V3 P0V3 が選ばれるので「価格プランを確認する」で変える** | WebSocket と Always On が使える最小。P0V3 は約 4 倍の値段。Free F1 は Always On が無く、しばらくすると止まる |
| ゾーン冗長(出たとき) | 無効 | B1 では使えない |

### 1-2. 「データベース」タブ

何も作らない(既定のまま次へ)。データベースは作成済みの Cosmos DB(`docs/DB.md` 第 10 章)。

### 1-3. 「デプロイ」タブ

| 項目 | 値 | 理由 |
|---|---|---|
| 継続的デプロイ | **無効化**(既定のまま) | 配置は zip を Kudu に置く(第 3・4 章) |
| GitHub 設定(アカウント・組織・リポジトリ・ブランチ) | 空のまま | 継続的デプロイを使わない |
| 基本認証 | **無効にする**(既定のまま) | ID とパスワードだけで入れる入口を閉じる。Kudu はポータルと同じ Microsoft アカウントで入れる |

### 1-4. 「ネットワーク」タブ

| 項目 | 値 | 理由 |
|---|---|---|
| パブリック アクセスを有効にする | **オン**(既定のまま) | プレイヤーがインターネットからつなぐ |
| 仮想ネットワーク統合を有効にする | **オフ**(既定のまま) | Cosmos DB へはサーバーから接続文字列で(暗号化して)つなぐので要らない |

### 1-5. 「監視とセキュリティ保護」タブ

| 項目 | 値 | 理由 |
|---|---|---|
| Application Insights を有効にする | **いいえ** | この組み合わせ(Linux・Node 24)ではコードを変えない監視ができない。出来事は Cosmos の events(`docs/LOGS.md`)、サーバーの出力は「ログ ストリーム」で見る |
| Defender for App Service を有効にする | **チェックしない** | 1 台あたり月 2,000 円前後(B1 と同じくらい)。不正対策はゲーム側(`docs/SECURITY.md`)。人が増えてから考える |

### 1-6. 「タグ」タブ

空のまま。

### 1-7. 「確認および作成」タブ

次を確かめて「作成」: ランタイム Node 24 LTS / Linux / Japan East / プラン `asp-packet-conquest` / **SKU Basic・1.75 GB メモリ** / Application Insights 無効。

## 2. 構成(環境変数と全般設定)

作成した App Service を開いて設定する。保存すると App Service が再起動する。

### 2-1. 環境変数(左メニュー「設定」→「環境変数」→「アプリ設定」タブ)

「＋ 追加」で 1 行ずつ足し、最後に下の「適用」→「確認」。「接続文字列」タブには何も入れない(接続文字列もアプリ設定に置く)。

| 名前 | 値 | 備考 |
|---|---|---|
| `COSMOS_CONNECTION_STRING` | Cosmos DB の「キー」→ プライマリ接続文字列(手元の `.env` と同じ) | **ここにだけ置く。** リポジトリや zip には入れない(`.env` は zip に含めない)。サーバーの中だけで使い、画面には送らない |
| `COSMOS_DATABASE` | `packet-conquest` | 本番データベース |
| `LOG_SALT` | 長い乱数の文字列。手元で `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` を実行して出た 64 文字を貼る | 出来事の記録(`docs/LOGS.md` 3.4)で接続元を日替わりのハッシュにする塩。**一度入れたら変えない**(変える・消すと、前後の記録で同じ接続元か見比べられなくなる。ゲームは止まらない)。ここ以外に書かない(控えるならパスワード管理ソフトに 1 つだけ) |
| `ADMIN_KEY` | **アイテムを配るときだけ作る**。長い乱数(24 文字以上。`LOG_SALT` と同じ作り方で別の値) | 管理者がアイテムを配る口 `POST /admin/grant` の鍵(2026-10-22)。無ければ口ごと無い扱い(404)。使い方は下の「アイテムを配る」 |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | zip を置いたときに App Service 側で `npm install` を走らせる |
| `ALLOWED_ORIGINS` | **作らない**(ドメインを付けたら `https://packet-conquest.com,https://www.packet-conquest.com`) | 同じホストからの接続は常に通るので、`*.azurewebsites.net` のうちは要らない |
| `WEBSITE_RUN_FROM_PACKAGE` | **作らない**(変数そのものを一覧に入れない。自動で入っていたら削除) | あると zip が読み取り専用のまま動き、上のビルド(`npm install`)が走らないので起動しない |

`PORT` は App Service が自分で入れるので作らない。

### 2-2. 全般設定(左メニュー「設定」→「構成」→「全般設定」タブ)

画面の上から順に。最後に上の「保存」。

| 項目 | 値 | 理由 |
|---|---|---|
| SCM 基本認証の発行資格情報 | チェックなし(既定のまま) | 1-3 の基本認証と同じ |
| FTP 基本認証の発行資格情報 | チェックなし(既定のまま) | FTP は使わない |
| WebJobs ランタイム | チェックなし(既定のまま) | 使わない |
| FTP の状態 | **無効**(既定は「FTPS のみ」なので変える) | FTP は使わない。入口を閉じる |
| 受信 IP モード | IPv4(既定のまま) | |
| HTTP バージョン | 1.1(既定のまま) | WebSocket は 1.1 で動く |
| HTTP 2.0 プロキシ | オフ(既定のまま) | |
| SSH | チェックあり(既定のまま) | ポータルからサーバーの中を見るときに使う(Microsoft アカウントで入る) |
| Always On | **チェックを入れる**(既定はなし) | 誰も来ない間にサーバーが止まるのを防ぐ。B1 以上で使える |
| セッション アフィニティ | チェックなし(既定のまま) | 1 台なので要らない。台数を増やすときに考える(第 8 章) |
| セッション アフィニティ プロキシ | チェックなし(既定のまま) | 同上 |
| HTTPS のみ | チェックあり(既定のまま) | |
| 最小の受信 TLS バージョン | 1.2(既定のまま) | |
| SCM 最小受信 TLS バージョン | 1.2(既定のまま) | |
| 最小受信 TLS 暗号スイート | 既定値のまま | |
| リモート デバッグ | チェックなし(Node 24 では選べない) | |
| クライアント証明書モード | **無視**(既定のまま) | プレイヤーに証明書は求めない |

Web ソケット: Linux の App Service にはこの項目が無い(切り替えなしで使える。2026-10-21 の初回配置で `wss://…/ws` がつながることを確認)。Windows で作ったときだけ「オン」にする(無いと `/ws` がつながらない)。配置したあと画面が「接続中」になれば通っている。

### 2-3. スタック設定(同じ「構成」の「スタック設定」タブ)

| 項目 | 値 |
|---|---|
| スタック / バージョン | Node / 24 LTS(作成時のまま) |
| スタートアップ コマンド | `sh start-azure.sh`(2026-10-26 から。zip に同梱した公式の Node.js で起動する。第 3.1 節) |

「保存」。

### 2-4. ほかのタブ(同じ「構成」の中)

「正常性チェック」「パスのマッピング」「エラー ページ」は変えない(正常性チェックは台数を増やすときに `/healthz` を入れる)。

## 3. zip を作る(手元)

0. 初回と、Node.js のセキュリティリリースが出たとき: `node tools/fetch-node-runtime.js 24.22.1`(版は最新の 24 系に変える)。公式の Linux 版の Node.js を取り、SHA-256 を公式の一覧と照らして `runtime/node/` に置く(`runtime/` は Git に入れない)
1. プロジェクトの `make-zip.cmd` をダブルクリック → `packet-conquest-deploy.zip` ができる(`node_modules`、`.env`、`data`、`.git` は入らない)
2. 入っているもの: `server/`、`public/`、`tools/`、`test/`、`docs/`、`infra/`、`package.json`、`package-lock.json`、`start-azure.sh`、`runtime/node/`(Node.js 本体)など。約 75 MB

### 3.1 Node.js の版(2026-10-26)

- App Service の組み込みの「Node 24 LTS」は細かい版を選べず、Azure が更新するまで古いまま(2026-10-26 に Kudu の SSH で `node -v` を打つと v24.7.0。6 月・7 月・10 月のセキュリティ修正が入っていない)
- そこで公式の Linux 版(今は v24.22.1。2026-10-21 のセキュリティリリース)を zip に同梱し、`start-azure.sh` がそれで `server/index.js` を起動する(無ければ組み込みの node で起動し、ログにそう出す)。`npm install`(ビルド)は組み込みの node のままでよい
- 確かめ方: ログ ストリームの起動の行に `Node.js v24.22.1` と出る(2026-10-26 に本番で切り替えて確かめた)
- 起動するときは Node.js 本体を `/tmp`(コンテナーの中の速いディスク)に写してそこから動かす(2026-10-26)。`/home` はネットワークの共有で、動いているファイルは置き換えられず、次の配置が `rsync: rename ... runtime/node/bin/node: No such file or directory` で失敗したため
- この直しを入れる前の版が動いている間は、同じ失敗が 1 回だけ起きる。そのときは App Service を「停止」→ zip を置く(第 4 章)→「開始」
- 新しいセキュリティリリースが出たら: 上の 0 を新しい版で流す → zip を作り直す → 第 4 章で置く

## 4. 配置する(Kudu の Deployments)

2026-10-21 時点の Linux の App Service では、Kudu を開くと新しい画面(Kudu Dashboard)が出る。zip はこの画面の「Deployments」から置く。

1. App Service → 左メニュー「開発ツール」→「高度なツール」→「移動」(新しいタブで Kudu Dashboard が開く。基本認証は無効のままでよい。ポータルと同じ Microsoft アカウントで入る)
2. 左メニュー「CONFIGURATION」の「**Deployments**」を押す(右の「Environment」の「Deployments」からも同じ画面)。上に「Deploy your Node.js 24-lts app」と出て、手順が「1 Upload → 2 Deploy」の 2 段になっている
3. 「1 Upload」の「Upload Your Application」の点線の枠に `packet-conquest-deploy.zip` を**ドラッグ&ドロップ**する(「Browse Files」で選んでもよい。上限 1 GB)
4. 「2 Deploy」(Review & Deploy)で次を確かめ、右下の「**Deploy**」を押す。App Service 側で `npm install` が走るので 1〜3 分待つ
   | 項目 | 値 | 理由 |
   |---|---|---|
   | RUNTIME | Node.js 24-lts(「Configured」と出ていればよい) | |
   | FILE | `packet-conquest-deploy.zip`(約 10 MB) | |
   | Skip Server-Side Build (Pre Built App) | **チェックしない**(既定のまま) | チェックすると `npm install` が走らず、`node_modules` の無い zip なので起動しない |
   | DEPLOYMENT TAG (OPTIONAL) | zip を作ったときのコミット(`git log --oneline -1` の先頭の 7 文字。例: `6ca1950`)。空でもよい | 「History」でどの版を置いたか見分けられる |
   | File Structure | 中身の一覧(見るだけ)。`server/`、`public/`、`package.json` があり、`.env` と `node_modules` が無いこと | 接続文字列を zip に入れない |
5. 結果は右上の「**History**」(または Dashboard の「Deployments」→「Last Deployment」)で見られる
6. 終わったら App Service の「概要」→「参照」で開く。`https://<既定のホスト名>/healthz` が `ok players=0 ...` を返せば起動している

古い画面を使うときは、Kudu Dashboard の右上「Old UI」→「Tools」→「Zip Push Deploy」でも置ける。

うまくいかないとき: Kudu Dashboard の「Log Stream」、または App Service の左メニュー「監視」→「ログ ストリーム」でサーバーの出力(起動時の「保存: Cosmos DB packet-conquest」の行、エラー)を見る。認証のエラーで置けないときだけ 2-2 の「SCM 基本認証の発行資格情報」にチェックを入れる。

## 5. 動作確認

1. ブラウザで開き、参加して拠点を 1 つ取る
2. Cosmos DB のデータ エクスプローラーで `players` と `nodes` の `owner` が入ることを確認(`docs/DB.md`)
3. 別の端末(スマホ)でも開き、復帰コードで戻れることを確認
4. 起動ログに「休眠アカウントを回収」が出ていないこと(初回は 0 件のはず)

## 6. ドメインと HTTPS(packet-conquest.com)

ドメイン `packet-conquest.com` は 2026-10-21 に取得済み(ネームサーバー `ns1.dns.ne.jp` / `ns2.dns.ne.jp`。DNS の設定はドメインを取ったところの管理画面で行う)。Azure の「App Service ドメイン」では買っていないので、Azure 側は「その他のすべてのドメイン サービス」を選ぶ。
画面に出る順に、変えない項目も含めて全部書く。裸のドメイン(`packet-conquest.com`)と `www.packet-conquest.com` の 2 つを、同じ手順で 1 つずつ追加する。

### 6-1. Azure で確認 ID と IP アドレスを控える

App Service → 左メニュー「設定」→「カスタム ドメイン」。画面の上に次の 2 つが出ている(右のボタンでコピーできる)。

| 項目 | 使い道 |
|---|---|
| IP アドレス | 裸のドメインの A レコードの値(6-3)。カンマ区切りで 2 つ出ていても、使うのは 6-2 のダイアログに出る 1 つ |
| カスタム ドメイン確認 ID | TXT レコード `asuid` / `asuid.www` の値(6-3)。このドメインを持っているのが自分だと Azure に示す |

### 6-2. カスタム ドメインの追加(1 つ目: packet-conquest.com)

「＋ カスタム ドメインの追加」(「App Service ドメインの購入」ではない)。右にダイアログが出る。

| 項目 | 値 | 理由 |
|---|---|---|
| ドメイン プロバイダー | **その他のすべてのドメイン サービス**(既定は「App Service ドメイン」なので変える) | ドメインは Azure の外で取った |
| TLS または SSL 証明書 | **App Service マネージド証明書**(既定のまま) | 無料。自動で更新される |
| TLS/SSL の種類 | **SNI SSL**(既定のまま) | 「IP ベースの SSL」は有料で、いまのブラウザには要らない |
| ドメイン | `packet-conquest.com` | |
| ホスト名レコードの種類 | **A レコード**(裸のドメイン。`www` のときは CNAME) | 裸のドメインには CNAME を置けない決まりがある |
| ドメインの検証 | 下に「A」と「TXT」の 2 行が出る。これを 6-3 で DNS に登録してから「検証」 | |

検証が両方とも緑になったら「追加」。証明書は最大 10 分ほどで付き、一覧の状態が「セキュリティ保護付き」になる。

### 6-3. DNS に登録する(ドメインを取ったところの管理画面)

| 種類 | ホスト名(名前) | 値 | TTL |
|---|---|---|---|
| A | 空欄(`@` と書く画面もある) | `20.210.68.15` | 既定のまま(3600 など) |
| TXT | `asuid` | `5988517C39A586E3CE88E651D696A2EA319D524BF28D3CFB36F5B75CF5E6D16A` | 既定のまま |
| CNAME | `www` | `packet-conquest-hta6bsazdegfa4a7.japaneast-01.azurewebsites.net` | 既定のまま |
| TXT | `asuid.www` | `5988517C39A586E3CE88E651D696A2EA319D524BF28D3CFB36F5B75CF5E6D16A`(上と同じ) | 既定のまま |

値は 2026-10-21 に作った App Service(`packet-conquest-hta6bsazdegfa4a7`)のもの。どちらも DNS に載せる公開の値なので、ここに書いてよい。
カスタム ドメインの画面の IP アドレスには `20.210.68.15,20.43.67.50` の 2 つが出るが、A レコードに使うのは、既定のホスト名を引いたときに返る `20.210.68.15`(2026-10-21 に `nslookup` で確認)。App Service を作り直したり、プランの系列を変えたりしたら、値を確かめ直してこの表も直す。
DNS の反映には数分〜1 時間ほどかかることがある。「検証」が赤のときは少し待ってからやり直す。

### 6-4. 2 つ目: www.packet-conquest.com

6-2 と同じダイアログで、ドメインを `www.packet-conquest.com`、ホスト名レコードの種類を **CNAME** にする。ほかは 6-2 と同じ。

### 6-5. 許可するつなぎ元を足す

左メニュー「設定」→「環境変数」→「アプリ設定」で `ALLOWED_ORIGINS` を作り、値を `https://packet-conquest.com,https://www.packet-conquest.com` にして「適用」→「確認」(再起動する)。

### 6-6. 確かめる

1. `https://packet-conquest.com/healthz` と `https://www.packet-conquest.com/healthz` が `ok players=...` を返す
2. ブラウザで開き、鍵のマークが出て、上の帯が「接続中」になる
3. 一覧で 2 つとも「セキュリティ保護付き」

### 6-7. 気をつけること

- App Service のプランを別の系列(例: B → P)に変えると IP アドレスが変わることがある。そのときは A レコードを新しい IP に直す(カスタム ドメインの画面の IP アドレスで確かめる)
- 確認 ID の TXT レコードは消さない(証明書の更新に使う)
- マネージド証明書は英数字・ダッシュ・ピリオドのドメインだけ(日本語ドメインは使えない)

## 6.9 アイテムを配る(支払いができるまでの、管理者だけの口。2026-10-22)

`ADMIN_KEY` を入れたうえで、PowerShell から次のように送る(`<鍵>` と `<プレイヤー id>` を置き換える。プレイヤー id は Cosmos DB の players で見る)。kind は `home`(本拠地を増やす)か `guard`(守りを延ばす)、count は個数。本拠地を増やすアイテムは、渡す時点で毎月 10 個・合計 20 個の上限を守る。渡したことは出来事の記録(`item.grant`)に残る。

```
Invoke-RestMethod -Method Post -Uri https://packet-conquest.com/admin/grant -Headers @{ 'X-Admin-Key' = '<鍵>' } -ContentType 'application/json' -Body '{"playerId":"<プレイヤー id>","kind":"guard","count":5}'
```

使い終わったら `ADMIN_KEY` を消してもよい(消すと口が閉じる)。

## 7. 配置のやり直し(更新)

コードを変えたら「3. zip を作る」→「4. 配置する」を繰り返す。アプリ設定は残る。データベースはそのまま。

拠点マスター(`tokyo.json`)を変えたときは、手元から `node tools/db-setup.js --force` で本番 DB のマスター項目を更新する(ゲーム状態は保つ。`docs/DB.md` 第 8 章)。これは Claude が行う。

## 8. 費用の目安(月)

| 項目 | 目安 |
|---|---|
| App Service Basic B1(Linux、Japan East) | 約 2,000 円 |
| Cosmos DB | 無料枠(1000 RU/s、25 GB)の範囲なら 0 円 |
| ドメイン | 年 1,500〜2,500 円 |
| 送信データ | 最初の 100 GB は無料枠 |

人が増えて B1 で足りなくなったら、まず B2(同じ系列で 2 倍)、次にインスタンス数を増やす(複数台にするときは `SECURITY.md` F2 の制限と `DESIGN.md` 第 4 章の共有ストアが要る)。

## 9. チェックリスト(段階 A の条件。DESIGN.md 第 10 章)

- [ ] 保存(Cosmos DB)で再起動しても世界が残る — 済(2026-10-18 に本番 DB で確認)
- [ ] 差分配信 — 済
- [ ] `SECURITY.md` F1〜F6 — 済(F3 の同時接続数の上限は前段の制限と合わせて)
- [ ] 週間ランキングの最小版 — 済(総合 3 種 + 週間 + チーム)
- [ ] Azure に配置し HTTPS — 2026-10-21 に `*.azurewebsites.net`(HTTPS)で起動を確認(`/healthz` ok、WebSocket、開始地点の検索で本番 DB を読める)。独自ドメインはさくらのドメインの緊急メンテナンス明けに DNS を登録して第 6 章を行う
- [ ] 出典・商標のクレジット — 済
