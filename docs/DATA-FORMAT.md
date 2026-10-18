# 地図データの形式(世界共通・協力企業との受け渡し)

作成: 2026-10-19 / 版: `pc-data/1`

パケット陣取りの地図データ(地域・拠点・航路)と、その出典・使用許諾の持ち方を、**世界に広げても、協力企業(航空会社・船会社・データ事業者など)からデータを受け取っても作り直さずに済む形**で決める。今は日本だけだが、この形で持つ。

関連: `DB.md`(Cosmos DB のコンテナー)、`PLACES.md`(名所の基準)、`DESIGN.md` 3.4(地図と拠点)、第 14 章(つながりと支配)。

---

## 0. 原則

1. **内部 id は一度付けたら変えない。** ゲーム状態(所有者・強化・進捗)は内部 id にひもづく。統合・改名しても id は残し、`replacedBy` で行き先を示す
2. **外部の識別コードで照合する。** 名前ではなく、国際的なコード(空港の IATA・ICAO、港の UN/LOCODE、Wikidata の QID など)で外部データと突き合わせる。拠点は `codes` に持つ
3. **すべての記録に出典を付ける。** 出典は台帳(`sources`)の id で指す。台帳に使用許諾(商用可・継承条件・表示の文言)を持ち、**商用で使えない出典の記録は本番に入れない**(読み込み時に機械的に止める)
4. **記録の元(マスター)と、ゲームが使う形(派生)を分ける。** 航路は独立した記録として持ち、拠点の `routes` は読み込み時に作る派生の値。協力企業のデータを差し替えても、拠点のマスターやゲーム状態は触らない
5. **国際標準に合わせる。** 国・地域は ISO 3166、言語は BCP 47、日時は ISO 8601(UTC)、座標は WGS84 の緯度・経度、空港は IATA / ICAO、港は UN/LOCODE、時刻表は IATA SSIM / GTFS
6. **形式に版を付ける。** ファイルとレコードに `schema`(例 `pc.routes/1`)を持つ。項目を足すのは後方互換(版はそのまま)、意味を変える・項目を消すときは版を上げて変換を書く

---

## 1. 共通の約束

| 項目 | 決まり | 例 |
|---|---|---|
| 文字コード | UTF-8(CSV は Excel 向けに BOM 付きも受け付ける) | |
| 内部 id | 英小文字・数字・ハイフンだけ。**接頭辞で出どころを表す**(下の表)。最大 64 文字 | `st-003766`、`lm-q193499` |
| 座標 | WGS84 の緯度・経度(10 進、小数 5 桁 ≒ 1 m) | `lat: 35.68124, lon: 139.76712` |
| 国 | ISO 3166-1 alpha-2(大文字) | `JP`、`US` |
| 国内の地域 | ISO 3166-2(都道府県・州)。市区町村は各国の公式コード(日本は全国地方公共団体コード)を `JP-13-13101` の形で | |
| 言語 | BCP 47 | `ja`、`en`、`zh-Hant` |
| 名前 | `name` はゲームの表示名(日本語 UI では日本語)。`names` に言語ごとの正式名(`local` は現地語) | `names: { ja: "東京国際空港", en: "Haneda Airport", local: "東京国際空港" }` |
| 日時 | ISO 8601。時刻つきは UTC(`Z`)、日付だけは `YYYY-MM-DD` | `2026-10-19T00:00:00Z` |
| 距離・面積 | km、km² | |
| 真偽 | `true` / `false`(文字列にしない) | |
| 空欄 | 項目を省く(`null` は「値が無いことを確かめた」意味のときだけ) | |

**内部 id の接頭辞**

| 接頭辞 | 出どころ | 例 |
|---|---|---|
| `st-` | 鉄道駅(国土数値情報 N02 のグループコード。他国は各国の駅データ) | `st-003766` |
| `lm-` | 名所(Wikidata の QID を小文字) | `lm-q193499` |
| `isl-` | 離島の玄関口(Wikidata の QID を小文字) | `isl-q2512004` |
| (接頭辞なし) | 手で入れた拠点(東京の名所 64 件) | `haneda`、`kokkai` |
| `home-` | プレイヤーの拠点(ゲームが作る) | |
| `rt-` | 航路(第 5 章) | |
| `src-` | 出典(第 2 章) | `src-ksj-n02-2025` |
| 予約 | `ap-`(空港を空港データから直接作るとき)、`pt-`(港を港データから直接作るとき)、`sp-`(スポンサー拠点)、`usr-`(利用者の登録) | |

---

## 2. 出典の台帳(`sources`)

置き場所: `server/map/data/sources.json`(Cosmos DB の `meta` に写す)。**台帳に無い出典の記録は読み込まない。**

| 項目 | 必須 | 内容 |
|---|---|---|
| `id` | ○ | `src-` で始まる内部 id。データの版(年)を含める(`src-ksj-n02-2025`) |
| `title` | ○ | データ名 |
| `publisher` | ○ | 提供者(省庁・団体・企業) |
| `kind` | ○ | `government`(政府)/ `community`(共同編集)/ `partner`(協力企業)/ `commercial`(購入)/ `internal`(自作) |
| `url` | | 入手先 |
| `license` | ○ | SPDX の識別子(`CC-BY-4.0`、`CC0-1.0`、`ODbL-1.0`)か、`LicenseRef-<名前>`(政府の独自規約・契約) |
| `commercialUse` | ○ | 商用で使えるか(`true` / `false`)。**`false` の出典は本番に入れない** |
| `shareAlike` | ○ | 継承条件(派生データを同じ条件で公開する義務)があるか。`true` の出典は拠点マスターに混ぜない |
| `attribution` | ○ | 表示が要るか。要るなら `attributionText`(`ja` / `en`)を画面のクレジットと README に出す |
| `retrievedAt` / `version` | ○ | 取得日・データの版(年度) |
| `contract` | 協力企業のとき | `{ id, party, signedAt, validUntil, scope, displayName }`(契約番号、相手、期限、使ってよい範囲、表示名)。**期限が切れた契約の記録は読み込まない** |
| `status` | ○ | `active` / `retired`(使うのをやめた。記録は残す) |
| `notes` | | 判断の記録(例: 「C02 は非商用なので使わない」) |

今の出典は第 10 章の表。

---

## 3. 地域(`regions`)

今の項目(`id`、`name`、`nameEn`、`kind`、`parent`、`code`、`status`、`localKind`、`nodeFile`、`center`、`bbox`)に次を足す(世界で使うため)。

| 項目 | 内容 |
|---|---|
| `iso` | 国は ISO 3166-1 alpha-2(`JP`)、都道府県・州は ISO 3166-2(`JP-13`)。今の `code` と同じ値で、市区町村は各国の公式コード(`JP-13-13101`) |
| `names` | 言語ごとの名前(`{ ja, en, local }`) |
| `src` | 出典 id(境界の出どころ。日本は `src-ksj-n03-2026`、海外は `src-geoboundaries-…`) |
| `excluded` | 扱わない地域の印と理由(北方領土・尖閣など。`DESIGN.md` 3.4)。拠点も航路も置かない |

---

## 4. 拠点(`nodes`)

マスターの項目(今あるもの)に次を足す。

| 項目 | 内容 |
|---|---|
| `codes` | 外部の識別コード。キーは決まった名前だけ: `iata`(空港 3 文字)、`icao`(空港 4 文字)、`unlocode`(港・都市 5 文字)、`wikidata`(QID)、`ksj`(国土数値情報のコード)、`osm` は使わない(ODbL)。協力企業の独自コードは `ext: [{ scheme: "<出典 id>", value }]` |
| `names` | 言語ごとの正式名 |
| `src` | 出典 id。ファイルの見出しの `defaultSource` を既定にし、違うものだけ書く(駅は N02、名所は Wikidata) |
| `gateway` | 空港・港などの玄関口の情報。`{ type: "airport" \| "port" \| "heliport" \| "station", scope: "international" \| "domestic", hub: true }`。航路を受けられるのは `gateway` を持つ拠点だけ |
| `replacedBy` | 統合で使わなくなった拠点の行き先 id(ゲーム状態の引き継ぎに使う) |
| `status` | 公開状態。`public`(既定)/ `hidden`(非公開)。非公開の拠点は DB には入れるが、ゲームでは使わない(線・航路・地域の集計・検索・配信の対象外)。後で公開に戻せるよう、コードや玄関口の情報は残す |
| `hiddenReason` | 非公開の理由(`status: hidden` のとき必須)。`military` = 自衛隊・米軍が設置・管理する飛行場(空港法の共用空港 8 か所。`tools/military.js`) |

**照合の順番**(外部データの拠点を、どの内部の拠点に当てるか):

1. `codes` が一致(IATA → ICAO → UN/LOCODE → Wikidata → 協力企業のコード)
2. 名前(`names` のどれか)が一致し、2 km 以内
3. どれにも当たらなければ「照合できなかった一覧」に出し、**自動では拠点を作らない**(協力企業が拠点の記録そのものを出してくれたときだけ、第 6 章の拠点の受け渡しで作る)

---

## 5. 航路(`routes`)

**拠点から独立した記録**として持つ。置き場所: `server/map/data/routes/<出典 id>.json`(Cosmos DB の `routes` コンテナー、パーティションキー `/source`)。ゲームは読み込み時に、使える航路を拠点の `routes`(行き先・種類・名前・座標の要約)に変換して使う(今のしくみ)。

### 5.1 ファイル

```json
{
  "schema": "pc.routes/1",
  "source": "src-ksj-s10a-2016",
  "generatedAt": "2026-10-20T00:00:00Z",
  "routes": [ { …航路の記録… } ]
}
```

1 ファイル = 1 出典の**全体の写し**。差し替えるときはファイルごと置き換え、前回あって今回無い記録は消さずに `status: "ended"` にする(履歴として残す。第 6.4 節)。

### 5.2 航路の記録

| 項目 | 必須 | 内容 |
|---|---|---|
| `id` | ○ | `rt-` + 出典・種類・端点・運航者から決まるハッシュ(12 桁)。同じ入力からは同じ id |
| `mode` | ○ | `air`(空路)/ `sea`(海路)。予約: `rail`(国際列車)、`land`(国境の陸路)。**海底ケーブルは航路にしない**(2026-10-19 決定。`cable` は受け付けない) |
| `from` / `to` | ○ | 内部の拠点 id(照合後) |
| `fromRef` / `toRef` | ○ | 出典が使っていたコード(`{ scheme: "iata", value: "HND" }`)。照合のやり直しと監査に使う |
| `bidirectional` | | 出典の上で往復か(既定 `true`)。片道しかない航路(周遊など)は `false`。**ゲームでは航路は「接続」なので向きを区別しない**(2026-10-19 決定)。事実として記録に残し、設定 `ROUTE_RULES.directed`(`server/map/routes.js`、既定 `false`)を `true` にしたときだけ片道として扱う |
| `scope` | | `domestic` / `international`(端点の国から決まる) |
| `carriers` | | 運航者 `[{ scheme: "iata-airline" \| "imo" \| "<出典 id>", code, name, sponsorId? }]`。**画面には出さない**(2026-10-19 決定)。運航者がスポンサーになったときだけ、`sponsorId`(`sponsors` コンテナーの id)で結び、スポンサーのしくみ(DESIGN.md 3.8)で出す。記録には残す(照合と監査に使う) |
| `status` | ○ | `active`(運航中)/ `seasonal`(季節運航)/ `suspended`(運休)/ `planned`(予定)/ `ended`(廃止) |
| `periods` | | 運航の期間 `[{ from: "2026-04-01", to: "2026-10-31", perWeek: 14, days: "1234567" }]`(`days` は月曜 1 〜日曜 7) |
| `metrics` | | 規模 `{ year, basis?, passengers?, flights?, cargoTons? }`。`basis` は `actual`(統計の実績。既定)か `schedule`(時刻表からの見込み。週の便数 × 52 など)。どれも **1 年間(暦年)** の値で、`passengers` は旅客数(人)、`flights` は運航回数(便。往復なら往と復の合計)、`cargoTons` は貨物(トン)。**航路の価値は規模で変える**(2026-10-19 決定。式は未決、DESIGN.md 第 6 章 #17)。項目名は決まったものだけ |
| `distanceKm` | | 端点の距離(出典にあればその値、無ければ大円距離) |
| `serviceTypes` | | 便・船の種類 `passenger`(旅客)/ `ferry`(フェリー)/ `passenger-cargo`(貨客)/ `ro-ro`(RORO)/ `cargo`(貨物)/ `other`。海路の出典が持っていれば入れる |
| `src` | ○ | 出典 id(ファイルの `source` と同じ。混ぜたファイルを作らない) |
| `sourceRecordId` | | 出典側の記録の id(差分の照合に使う) |
| `retrievedAt` | ○ | 取得日 |
| `verified` | | 人が確かめた印 `{ by, at }` |

### 5.3 ゲームで使う条件(読み込み時に機械的に判定)

1. 出典が台帳にあり、`status: active`、`commercialUse: true`、`shareAlike: false`、契約なら期限内
2. 航路の `status` が `active`、または `seasonal` で今日が `periods` の中
3. 両端の拠点があり、ハック可で、`gateway` を持ち、扱わない地域(`excluded`)でない
4. 同じ 2 拠点・同じ種類の航路が複数の出典や運航者にあれば 1 本にまとめる(ゲームの線は 1 本。記録は全部残す)
5. 向きは区別しない(片道の記録も往復の接続にする)。設定 `ROUTE_RULES.directed` が `true` のときだけ片道を区別する
6. 拠点の要約の項目は `{ to, mode, name, lat, lon, metrics? }`。`metrics` は 4 でまとめた記録のうち、いちばん新しい年の値の合計(運航者・出典・向きの分を足す)。運航者の名前は要約に入れない

ゲームの規則(`DESIGN.md` 3.4): 自分の拠点からたどれる空港・港を占領すると、航路の先の空港・港を攻撃できる。航路は突破回数に数えない。

---

## 6. 協力企業との受け渡し

### 6.1 受け付ける形(どれでもよい。こちらで第 4・5 章の形に変換する)

| 種類 | 形式 | 主な項目 | 用途 |
|---|---|---|---|
| 航路(簡易) | CSV(第 6.2 節のひな形) | 種類、出発と到着のコード、運航者、期間、便数 | 表計算で作れる |
| 空の時刻表 | **IATA SSIM** 第 7 章(航空会社の標準) | 便、区間、期間、曜日 | 航空会社 |
| 船・バス・鉄道の時刻表 | **GTFS**(`route_type` 4 = フェリー) | 停留所(港)、路線、便 | 船会社・自治体 |
| 拠点(空港・港) | CSV(第 6.3 節)または JSON Lines(第 4 章の形) | コード、名前、座標、種類 | 新しい港・空港 |
| こちらの正式な形 | JSON(第 4・5 章の形、`schema` 付き) | すべて | データ事業者 |

### 6.2 航路の CSV ひな形(`routes.csv`)

```
mode,from_scheme,from_code,to_scheme,to_code,bidirectional,carrier_scheme,carrier_code,carrier_name,status,valid_from,valid_to,per_week,days,metrics_year,passengers,flights,cargo_tons,record_id
air,iata,HND,iata,CTS,true,iata-airline,XX,(運航者名),active,2026-04-01,2026-10-31,98,1234567,2025,1000000,10000,,XX-HND-CTS
sea,unlocode,JPTYO,unlocode,JPOSM,true,partner,123,(運航者名),active,2026-04-01,,7,1234567,,,,,R-0001
```

- `*_scheme` は `iata` / `icao` / `unlocode` / `wikidata` / 協力企業のコード体系(出典 id)
- 規模(`metrics_year`、`passengers`、`flights`、`cargo_tons`)は分かるものだけ。1 年間の値
- コードが無い港は、拠点の CSV(6.3)で港を先に出してもらい、その `record_id` を `partner` の体系で指す

### 6.3 拠点の CSV ひな形(`gateways.csv`)

```
type,scheme,code,name_local,name_en,name_ja,lat,lon,country,scope,operator_name,record_id
port,unlocode,JPOSM,元町港,Motomachi Port,元町港,34.75114,139.35147,JP,domestic,,P-0001
```

### 6.4 差分と履歴

- 1 回の受け取り = その出典の**全体の写し**(差分だけ送ってもらう形にはしない。取りこぼしが起きるため)
- 前回あって今回無い航路は `status: "ended"`、`periods` に終わりの日を入れる(消さない)
- 取り込みのたびに「追加・変更・終了・照合できなかった」の一覧を作り、人が見てから本番に入れる
- 協力企業から取り下げの依頼が来たら、その出典を `status: retired` にする(記録は監査のために残し、ゲームでは使わない)

### 6.5 品質の検査(取り込み時に必ず通す)

| 検査 | 不合格の例 |
|---|---|
| 形式 | 必須項目の欠け、日付の形、コードの形(IATA は英大文字 3 文字 など) |
| 照合 | 端点が拠点に当たらない、当たった拠点が `gateway` でない |
| 自己ループ・重複 | 出発と到着が同じ、同じ記録が 2 回 |
| 距離 | 空路で 30 km 未満、海路で 1 km 未満(誤りの可能性) |
| 地域 | 扱わない地域(北方領土・尖閣など)の拠点が端点 |
| 使用許諾 | 出典が台帳に無い、非商用、継承条件つき、契約切れ |

---

## 7. 保存(Cosmos DB)

| コンテナー | パーティションキー | 内容 |
|---|---|---|
| `nodes`(今ある) | `/country`、`/region` | 拠点のマスター + ゲーム状態。`routes` は派生の要約(航路の記録から作る) |
| `routes`(新設) | `/source` | 航路の記録(第 5.2 節)。出典ごとに差し替えるので出典で分ける |
| `meta`(今ある) | `/id` | 出典の台帳を 1 件のドキュメント(`id: "sources"`)で写す |

航路の記録は管理と監査のためのもので、ゲームの毎回の読み込みでは使わない(拠点の要約で足りる)。

---

## 8. 版と変更の手順

- ファイルの `schema` は `pc.<種類>/<版>`(`pc.nodes/1`、`pc.routes/1`、`pc.sources/1`)
- 項目を足すのは同じ版のまま(読む側は知らない項目を無視する)
- 意味を変える・項目を消す・id の作り方を変えるときは版を上げ、変換の道具(`tools/migrate-*.js`)とテストを付ける
- 内部 id は版を上げても変えない

---

## 9. 決めたこと・残り

2026-10-19 にユーザーが決めた:

1. **運航者の名前は画面に出さない**。運航者がスポンサーになったときだけ別に出す(`carriers[].sponsorId`)
2. **航路の価値は規模で変える**(`metrics`)。**式は未決**(DESIGN.md 第 6 章 #17)
3. **海底ケーブルは航路にしない**(`mode` に `cable` を置かない)
4. **航路は接続なので片道・往復の区別はない**。区別できる設定(`ROUTE_RULES.directed`)だけ用意しておく

残り: 規模から価値を出す式(空路と海路で同じ物差しにするか、旅客と貨物をどう比べるか、規模の無い航路の扱い)

---

## 10. 今の出典(2026-10-19)

| id | データ | 使用許諾 | 商用 | 継承 | 使い道 |
|---|---|---|---|---|---|
| `src-ksj-n02-2025` | 国土数値情報 鉄道データ(N02、2025) | CC BY 4.0 | 可 | なし | 駅と路線のつながり |
| `src-ksj-n03-2026` | 国土数値情報 行政区域データ(N03、2026) | CC BY 4.0 | 可 | なし | 地域と境界 |
| `src-wikidata` | Wikidata | CC0 | 可 | なし | 名所、離島の空港・港・島、識別コード |
| `src-internal` | 手で入れた拠点 | 自作 | 可 | なし | 東京の名所 64 件 |
| `src-ksj-s10a-2016` | 国土数値情報 港湾間流通量・海上経路(S10a) | 商用可(国土数値情報の規約) | 可 | なし | 海路(取り込み予定) |
| `src-mlit-air-stats` | 国土交通省 航空輸送統計調査(路線別) | 政府統計(出典表示) | 可(見込み) | なし | 空路(取り込み予定) |
| (使わない)`src-ksj-c02` `src-ksj-c09` `src-ksj-n09` `src-ksj-s10b` | 港湾・漁港・旅客航路・空港間流通量 | 非商用 | 不可 | — | 記録として台帳に残す(`status: retired`) |
| (使わない)OpenStreetMap、OpenFlights、GADM | | ODbL / 非商用 | — | あり | 台帳に入れない |

---

## 11. 実装の状況(2026-10-18)

この形式は、読み込みとテストで機械的に守らせている。形式に合わないデータがあると、サーバーは起動しない。テストも落ちる。

| 決まり | どこで守らせるか |
|---|---|
| 拠点ファイルは `schema: "pc.nodes/1"` と `defaultSource`(台帳にある出典)を持つ | `server/map/load.js` の `validate` |
| `src` は台帳にある出典。全拠点の出典が「ゲームに使える」判定を通る | `validate`、`test/map.js` |
| `codes` のキーは決まった名前だけ。IATA・ICAO・UN/LOCODE・Wikidata の形を検査する。`ext` の `scheme` は台帳の出典 id | `validate` |
| 外部コードは拠点ごとに一意(同じ IATA が 2 つの拠点に付かない) | `test/map.js` |
| 駅の `codes.ksj` は id(`st-` の後ろ)から自動で付く。ファイルには書かない | `load.js` |
| ハック可の空港・港は `gateway` を持つ。ハック不可の拠点は `gateway` を持てない | `validate`、`test/map.js` |
| 拠点のファイルに `routes` は書けない(航路は `server/map/data/routes/`) | `validate` |
| 航路の記録の形、id の作り方、出典のゲート(非商用・継承条件・期限切れの契約・廃止は使わない) | `server/map/routes.js`、`server/map/sources.js`、`test/routes.js` |
| 本番の DB: 台帳を `meta` の `sources` に、航路の記録を `routes` コンテナーに写す | `tools/db-setup.js` |

**道具**

- `tools/migrate-nodes-v1.js`: 旧形式から `pc.nodes/1` へ移す(実施済み。何度実行しても同じ結果)
- `tools/fetch-codes.js`: 空港・港に IATA・ICAO・UN/LOCODE を Wikidata から付ける。値が割れているものは書かずに一覧に出す
- `tools/import-stations.js`、`import-landmarks.js`、`import-islands.js`: 取り込みの時点で `codes`・`src`・`gateway` を書く
- `tools/import-gateways.js`: 航路の端点になる空港・港を拠点にする(id は `ap-` / `pt-`)。既にある港には出典のコード(`codes.ext`)を付ける
- `tools/import-routes.js`: 航路の記録を出典ごとに書き直す(`server/map/data/routes/<出典 id>.json`)。照合できなかった端点は `docs/routes/README.md` に出す
- `tools/route-sources.js`(出典の読み取りと、統計表の空港名 → IATA / ICAO の表)、`tools/xlsx.js`(依存なしの xlsx 読み取り)

**取り込みの順番**(前の道具は自分の拠点を入れ直すので、この順に流す):

```
import-stations → import-landmarks → import-islands → import-gateways → fetch-codes → import-links → import-routes → db-setup --force
```

**今のデータ**

| 項目 | 件数 |
|---|---|
| 空港・港(すべて `gateway` あり) | 355(うち非公開 8) |
| IATA コードのある空港 | 88 |
| ICAO コードのある空港 | 95 |
| UN/LOCODE のある港・空港 | 31 |
| 空路の記録(2025 年の実績、向きごと) | 538(空港の組 271。うち端点が非公開の 58 件はゲームで使わない) |
| 海路の記録(2016 年の定期便、向きごと) | 418(港の組 229) |
| 航路を持つ空港・港(公開) | 307 |

照合できなかった端点は `docs/routes/README.md`。自衛隊・米軍が設置・管理する飛行場 8 か所(丘珠・千歳・三沢・百里・小松・美保・徳島・岩国)は非公開の拠点として入っていて、その航路の記録も残すが、ゲームでは使わない(2026-10-18 決定)。

UN/LOCODE は Wikidata にほとんど入っていない。世界展開の前に、国連欧州経済委員会(UNECE)が公開する UN/LOCODE の一覧から港に付け直す。
