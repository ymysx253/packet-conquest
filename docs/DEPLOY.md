# Azure App Service への配置(フェーズ 1 手順 10)

ポータルだけで進められる手順。コマンドは手元の zip 作成(`make-zip.cmd` のダブルクリック)だけ。2026-10-18 作成。

## 0. 前提

- Cosmos DB アカウント `packet-conquest`(Japan East、無料枠、合計 1000 RU/s)とデータベース `packet-conquest` は作成済み(`docs/DB.md` 第 10 章)
- ドメイン `packet-conquest.com` は取得予定(第 11 章)。無くても `*.azurewebsites.net` で動く
- サーバーは `PORT` 環境変数で待ち受け、保存先は `COSMOS_CONNECTION_STRING` と `COSMOS_DATABASE` で決まる。WebSocket は `/ws`

## 1. App Service を作る

ポータル → 「App Service」→ 作成(Web アプリ)。

| 項目 | 値 | 理由 |
|---|---|---|
| サブスクリプション / リソース グループ | Cosmos DB と同じリソース グループ | まとめて管理 |
| 名前 | `packet-conquest`(取れなければ `packet-conquest-app`) | URL は `https://<名前>.azurewebsites.net` |
| 公開 | コード | |
| ランタイム スタック | **Node 20 LTS**(無ければ 22 LTS) | `package.json` の engines は 20 以上 |
| オペレーティング システム | **Linux** | 安く、Node の扱いが素直 |
| リージョン | **Japan East** | Cosmos DB と同じ(遅延と転送費) |
| プラン | **Basic B1** | WebSocket と Always On が使える最小。Free F1 では Always On が無く、しばらくすると止まる。費用の目安は月 2,000 円前後(従量) |
| ゾーン冗長 | 無効 | |

「確認および作成」→「作成」。

## 2. 構成(アプリ設定と全般設定)

作成した App Service → 左メニュー「設定」→「環境変数」(古い表示では「構成」)。

**アプリ設定**(名前 = 値。保存すると再起動する)

| 名前 | 値 | 備考 |
|---|---|---|
| `COSMOS_CONNECTION_STRING` | Cosmos DB の「キー」→ プライマリ接続文字列 | **ここにだけ置く。** リポジトリや zip には入れない(`.env` は zip に含めない) |
| `COSMOS_DATABASE` | `packet-conquest` | 本番データベース |
| `ALLOWED_ORIGINS` | `https://packet-conquest.com,https://www.packet-conquest.com` | ドメインを付けるまでは空でよい(同じホストからの接続は常に通る) |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | zip を置いたときに App Service 側で `npm install` を走らせる |
| `WEBSITE_RUN_FROM_PACKAGE` | 設定しない | 設定すると上のビルドが走らない |

**全般設定**(「構成」→「全般設定」タブ)

| 項目 | 値 |
|---|---|
| スタートアップ コマンド | `npm start` |
| Web ソケット | **オン**(必須。これが無いと `/ws` がつながらない) |
| Always On | **オン**(B1 以上で可。止まらないようにする) |
| HTTPS のみ | オン |
| 最小 TLS バージョン | 1.2 |
| ARR アフィニティ | オフ(1 台のうちはどちらでもよい) |

## 3. zip を作る(手元)

1. プロジェクトの `make-zip.cmd` をダブルクリック → `packet-conquest-deploy.zip` ができる(`node_modules`、`.env`、`data`、`.git` は入らない)
2. 入っているもの: `server/`、`public/`、`tools/`、`test/`、`docs/`、`infra/`、`package.json`、`package-lock.json` など

## 4. 配置する(Kudu の Zip Push Deploy)

1. App Service → 左メニュー「開発ツール」→「高度なツール」→「移動」(新しいタブで Kudu が開く)
2. 上のメニュー「Tools」→「Zip Push Deploy」
3. ページに zip を**ドラッグ&ドロップ**する。`npm install` が走るので 1〜3 分待つ
4. 終わったら App Service の「概要」→「参照」で開く。`https://<名前>.azurewebsites.net/healthz` が `ok players=0 ...` を返せば起動している

うまくいかないとき: 左メニュー「監視」→「ログ ストリーム」でサーバーの出力(起動時の「保存: Cosmos DB packet-conquest」の行、エラー)を見る。

## 5. 動作確認

1. ブラウザで開き、参加して拠点を 1 つ取る
2. Cosmos DB のデータ エクスプローラーで `players` と `nodes` の `owner` が入ることを確認(`docs/DB.md`)
3. 別の端末(スマホ)でも開き、復帰コードで戻れることを確認
4. 起動ログに「休眠アカウントを回収」が出ていないこと(初回は 0 件のはず)

## 6. ドメインと HTTPS(packet-conquest.com を取ったら)

1. App Service → 「設定」→「カスタム ドメイン」→「カスタム ドメインの追加」
2. 画面に出る **TXT レコード**(`asuid.<ドメイン>`)と **CNAME**(`www` → `<名前>.azurewebsites.net`)、裸ドメイン用の **A レコード**(App Service の IP)を、ドメインの管理画面(レジストラ)の DNS に登録する
3. 検証が通ったら追加し、「バインドの追加」→ **App Service マネージド証明書**(無料)→ SNI SSL
4. `ALLOWED_ORIGINS` にドメインを入れて保存(再起動)
5. `www` と裸ドメインの両方を追加する

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
- [ ] Azure に配置し HTTPS — この手順
- [ ] 出典・商標のクレジット — 済
