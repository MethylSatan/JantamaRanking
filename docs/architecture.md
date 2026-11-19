# アーキテクチャ

全体像の図は `architecture.png`（①牌譜を開く → ②牌譜ファイル取得 → ③Drive へアップロード → ④スクリプト実行 → ⑤牌譜データ取得 → ⑥スプレッドシートへ投入）。

## 構成要素
| 要素 | 場所 | 役割 |
|---|---|---|
| GetPaifuURLs | `Tampermonkey/GetPaifuURLs.js` | **WebGL 版では動かない（2026-11 時点）。** 雀魂の画面で L キー。`fetchGameRecordList`（type=1: 友人戦、最大30件）を呼び、URLと対戦者名を `PaifuURLs_YYYYMMDD.txt` に保存 |
| downloadlogs | `Tampermonkey/downloadlogs.js` | **WebGL 版では動かない（2026-11 時点）。** S キーで、開いている牌譜を json でダウンロード。Equim-chan 作のフォーク |
| PaifuImporter | `PaifuImporter/` | Node。`getPaifu.js` が `majsoul.js` で雀魂に WebSocket 接続し、URL一覧の各牌譜を `fetchGameRecord` で取得、`parse()` で変換して `output/` に json 保存 |
| token.js | `misc/token.js` | WebSocket メッセージ（hex）からアクセストークンを取り出す補助 |
| 牌譜回収（実装予定） | 未定（タスク 006） | 運営のアカウントで、主催者の友人戦一覧（`fetchAccountInfoExtra`）と中身（`fetchGameRecordsDetail`）を取る。Web サービスの Lambda で動く部品として作る。検証用の試作は `local/probe/`（gitignore 済み） |
| Web サービス（実装予定） | 未定（タスク 010〜013） | 下の「Web サービスの構成」 |
| 集計 | `src/ranking/` | 牌譜 json から対局の結果を取り出し、ランキングを作る。依存のない TypeScript の関数。Lambda と画面の両方で使う。下の「集計（Web サービス）」 |
| Drive / GAS / スプレッドシート | リポジトリ外（GAS の写しは `gas/`） | 旧方式の牌譜の置き場、投入スクリプト、集計。**Web サービスに置き換えてやめる**（2026-11-19）。シートの構成と集計のルールは下の「旧集計（スプレッドシート）」 |

## データの流れ
雀魂のブラウザ版は Unity WebGL 版へ置き換わり（時期は未確認。2026-11 時点で確認）、Tampermonkey の2本は動かなくなった（タスク 001）。代わりに、運営のアカウントから主催者の友人戦を取る方式にする（タスク 005、`docs/decisions.md` 2026-11-16）。
```
新: 雀魂 ──(Lambda、運営のアカウント: 主催者の友人戦一覧 → 候補 → 選んだ対局の中身)──▶ 牌譜 json（S3）
    ──▶ 対局の結果（DynamoDB）──▶ 集計 ──▶ ランキングの画面
```
旧（参考）:
```
雀魂 ──(Tampermonkey)──▶ 牌譜URL一覧 .txt ──(PaifuImporter)──▶ 牌譜 json
雀魂 ──(downloadlogs)──────────────────────────────────────▶ 牌譜 json
牌譜 json ──▶ Google Drive ──(GAS)──▶ スプレッドシート（試合結果シート）──▶ 集計
```

## Web サービスの構成（タスク 008 で決定、未実装）
word-flashcard（隣のリポジトリ）の配信基盤に合わせる。決定の理由は `docs/decisions.md` 2026-11-19。
```
ブラウザ → jantama.methylsatan.com（Route 53 の ALIAS）
        → CloudFront（WAF、*.methylsatan.com の証明書、定額の無料プラン）
            ├ /*     → S3（画面: SPA、ランキングの JSON）
            └ /api/* → Lambda Function URL → Lambda（Node）
Lambda ──(L2、運営アカウント)──▶ 雀魂
  ├ 認証情報: SSM Parameter Store（SecureString）
  ├ データ: DynamoDB。牌譜の生 json は S3
  └ 定期取得: EventBridge Scheduler → Lambda
運営の認証: Cognito のユーザープール（運営1人。API は JWT で守る）
```

### 構成要素
| 要素 | 内容 |
|---|---|
| 画面 | SPA（word-flashcard と同じ Vite + TypeScript + Preact の見込み）。運営向け: 主催者の指定 → 候補の対局の一覧 → 取り込む対局を選ぶ。閲覧者向け: ランキング |
| API（Lambda） | 候補の更新（雀魂から一覧を取る）、取り込み（選んだ対局の中身を取り、結果を保存し、ランキングを作り直す）、対象外にする操作 |
| 定期取得 | 1日1回程度、登録した主催者の候補を更新する。一覧は種類ごとに最新50件なので、上限に達する前に取りこぼさないため |
| 認証情報 | 運営アカウントの `code` / `uid`（と端末 ID）。取り直しはタスク 009 |
| Terraform | `infra/`。状態は `methylsatan-tfstate` の `jantama-ranking/terraform.tfstate`。Route 53 のゾーン、証明書（us-east-1）、GitHub の OIDC プロバイダーは word-flashcard のものを `data` で参照する |

### データモデル（概要。実装で詰める）
- ランキング（企画）: 名前、公開用の推測されない ID、対象の主催者、集計のルール
- 主催者: 雀魂の表示用 ID と内部 ID、最後に候補を更新した時刻
- 対局: 牌譜 uuid、日時、ルール、参加者、状態（候補 / 取り込み済み / 対象外）、取り込み済みなら各家の順位・点数
- ランキングの JSON: 取り込みのたびに作り直して S3 に置き、CloudFront から配る（閲覧で Lambda を動かさない）

### 作り直し・取り消し・履歴（`docs/product.md` 非機能要件「旧方式の利点を引き継ぐ」）
- 牌譜の生の json を置く S3 はバージョニングを有効にする。対局の結果とランキングは、牌譜から作る派生データとして扱う
- 作り直しの機能: S3 の全牌譜 → 対局の結果 → ランキング。旧方式の「アーカイブから全量を取り込み直す」にあたる。同じ入力からは毎回同じ結果になるようにする
- 取り消し: 対局の状態を「対象外」にするだけで、データは消さない。対象外から戻すこともできる
- 操作ログ: 誰が・いつ・どの対局を・どう変えたかを、追記だけで DynamoDB に残す
- 過去の時点に戻す: DynamoDB のポイントインタイムリカバリ（35日）と、ランキングの JSON の過去の版（S3 のバージョニング）
- 並べ替え・絞り込みは画面側で行う（ランキングの JSON を受け取ったブラウザで処理する）。CSV などでの書き出しは用意しない

### 雀魂に負荷をかけない運用
- 1回の実行につきログインは1回。要求の間隔は1秒以上。1回で取る牌譜の数に上限を設ける
- 同時に実行しない（DynamoDB の条件付き書き込みでロック）。手動の更新は間隔を制限する
- 定期取得は1日1回程度

### 費用の見込み（東京）
- CloudFront・WAF・Route 53: 定額の無料プランで $0（1アカウントで Free プランは3つまで。word-flashcard で1つ使用）
- Lambda・DynamoDB・SSM（標準）・EventBridge Scheduler・Cognito: 恒常の無料枠に収まる見込み
- S3（牌譜の json。バージョニングで古い版も残る）: 1円未満
- DynamoDB のポイントインタイムリカバリ: データ量に比例（数 MB なら1円未満の見込み。料金はタスク 010 で確かめる）
- 未確認: Lambda Function URL を定額プランのディストリビューションの配信元にできるか（タスク 010）

### 既知のリスク
- Lambda は AWS の IP から雀魂に接続する。弾かれないか、運営がブラウザで遊んでいるときに同時ログインで追い出し合わないかを、先に確かめる（タスク 011）
  - 2026-11-19: Lambda からの1回目は `oauth2Auth` が `err=151` で失敗した。原因は送った版が古かったこと。版を直すと Lambda からログインから牌譜の取得まで通った（`docs/decisions.md` 2026-11-19 タスク 011）。同時ログインの挙動は未確認
- 雀魂の利用規約との関係は `docs/local/008-terms-notes.md`

## 集計（Web サービス。タスク 012）
旧シートの集計（下の「旧集計」）を移したもの。`src/ranking/`。テストは直下で `npm test`。決定の理由は `docs/decisions.md` 2026-11-19（タスク 012）。

| ファイル | 内容 |
|---|---|
| `types.ts` | `GameResult`（牌譜 uuid、終了時刻、四麻/三麻、各家の結果）、`PlayerResult`（席、アカウント ID、名前、点数、pt、順位）、`RankingRow` |
| `mjlog.ts` | `fromMjlog`: mjlog 形式（前期・後期とも）の牌譜 json から `GameResult` を作る。読むのは `ref`・`ratingc`・`name`・`sc`・`title[1]` だけ。アカウント ID は無い（新方式の牌譜から作る関数はタスク 006 で足す） |
| `rank.ts` | 順位は pt の大きい順。pt が同じなら席順（東家が上） |
| `period.ts` | 日付は日本時間の朝6時で区切る（`businessDay` / `businessMonth` / `businessYear`）。期間 `{ from?, to? }` は両端の日を含む |
| `aggregate.ts` | `aggregate`: ランキング。`playedThisMonth`: 今月参加済み。`notPlayedThisMonth`: 今年打った人のうち今月まだの人（今年の対局数の多い順） |

- ルールは固定。四麻と三麻は別のランキング。最低対局数なし
- まとめるキーは、アカウント ID があれば `id:<ID>`、無ければ `name:<名前>`。表示名は最新の対局の名前
- 列は累計pt・平均pt・対局数・トップ回数。pt の合計は 0.1pt 単位の整数で足す（浮動小数の誤差を出さない）
- 並べ方は累計pt の大きい順。同点は対局数の少ない順、さらにキーの順。順位は 1, 2, 3… と振る（同点でも分ける）
- 旧シートとの違い: 区切りが0時→6時、年別に12月31日を含む、今月参加済みは1日から（旧四麻は3日から）、累計pt が同点のときの並びを決めた
- 旧シートとの突合（2026-11-19）: 牌譜 json（Drive のアーカイブの全量）→ 試合結果シート → Ranking シートの3点で比べ、すべて一致した。牌譜から取り出した結果は試合結果シートの全行と、集計は全期間・年別の Ranking シート（四麻・三麻）の全員の値と一致した。年別はシートと同じ区切り（0時、終点を含まない）で比べた。6時区切りにしても、どの年も対局数は変わらない。具体は `docs/local/012-verify-notes.md`

## 旧集計（スプレッドシート。タスク 003 で記録）
Web サービスに移す集計のルール（タスク 012）。シートの場所と、データの具体（件数・期間）は `docs/local/003-sheet-notes.md`。
シートの値は GAS が書き込み、集計はシートの式（`QUERY`）で行っていた。

### シート
| シート | 内容 |
|---|---|
| `四麻Results` / `三麻Results` | 対局の結果。1行が1対局の1人。式はない（GAS が書き込む） |
| `四麻全期間Ranking` / `三麻全期間Ranking` | 全期間のランキング |
| `四麻YYYY年Ranking` / `三麻YYYY年Ranking` | 年ごとのランキング（2022〜2024）。`I2` / `I3` に集計の起点・終点の日付 |
| `ちのちゃん向け` | 今月まだ打っていない人の一覧（主催者向け）。年別シートの「今月参加済み」が `-` の人を、対局数の多い順に並べ、1行につなげたものも出す |
| `コンパネ（管理者用）` | 「集計対象リスト【未実装】」とだけある |
| `misc` | 今後の予定のメモ（説明書、集計対象の制限＝ランキングに載りたくない人への対応、セルフサービス化） |
| `sandbox` / `Backup` | 式の試作と控え。集計には使っていない |

### 試合結果シートの列
| 列 | 見出し | 内容 |
|---|---|---|
| A | 対戦日時 | 対局の終了時刻（日本時間）。牌譜 json の `title[1]` |
| B | 順位 | 1〜4（三麻は1〜3）。json には無く、`sc` から求める（下記） |
| C | プレイヤー名 | 雀魂のニックネーム。json の `name[席]` |
| D | スコア | 終局時の持ち点。json の `sc[2×席]` |
| E | pt | 雀魂が計算した最終の pt。json の `sc[2×席+1]` |
| F | 牌譜URL | `https://game.mahjongsoul.com/?paipu=<牌譜 uuid>`。uuid は json の `ref` |

### 入力の牌譜 json（GAS が読んでいたもの）
どちらも downloadlogs 由来の mjlog 形式（`ver: "2.3"`）。途中で取得の方法を変えたため、形式が2種類ある。

| 項目 | 前期（Tampermonkey の downloadlogs） | 後期（`PaifuImporter` の `parse()`） |
|---|---|---|
| `ref` / `rule` / `ratingc` / `lobby` / `name` / `sc` / `title` | あり | あり（意味は同じ） |
| `log`（局ごとの記録） | あり | なし |
| `dan` / `rate` / `sx`（段位・レート・性別） | あり | なし |
| `title[1]` の書式 | ブラウザの地域設定に従う（日本なら `2022/7/31 23:25:27`） | `ja-JP`（`2024/12/23 0:19:41`）。`TZ=Asia/Tokyo` |
| ファイル名 | `YYYY_M_D_<rule.disp>.json` など | `YYYY_MM_DD-hh_mm_ss_<rule.disp>.json` |

- 集計に使うのは、両方にある項目だけ（`ref`、`ratingc`、`name`、`sc`、`title[1]`）
- `ratingc` は `PF4`（四麻）か `PF3`（三麻）。三麻では `name[3]` が空文字、`sc[6]` と `sc[7]` が0
- `sc` は席順（東家から）に `[点数, pt, 点数, pt, …]`。点数は雀魂の `part_point_1`、pt は `total_point / 1000`
- `title[1]` は雀魂の `end_time`（終了時刻）

### GAS の処理（`gas/`）
- Drive の受け取り用フォルダ（四麻と三麻で別）にある json をすべて読み、ファイル名の昇順に処理する。1ファイルごとに、試合結果シートの2行目に挿入する（新しい対局が上に来る）。処理したファイルはアーカイブ用のフォルダへ移す。全部を取り込み直すときは、シートを空にしてからアーカイブ用のフォルダを読む
- 四麻か三麻かは、置くフォルダで分ける（`ratingc` は見ない）。部屋番号やルールでは絞らない。置いた牌譜はすべて集計に入る
- 重複は確かめない。同じ牌譜を2回置くと2回入る
- 順位は、pt の大きい順に並べて1から振る
- 対戦日時は `title[1]` の文字列をそのまま書き、シートが日時として解釈する
- 対局ごとに、行の背景色をランダムな淡い色にする（見た目だけ）
- 前期の形式のファイル名は月日が0埋めでないので、名前の順が日付の順にならないことがある。その場合、シートの行は日時の順に並ばない（集計には影響しない）

### pt と順位
pt は雀魂がサーバーで計算した値（`total_point`）で、GAS は計算していない。友人戦の部屋の設定によるもので、シートの全対局では次の式と一致した。
- 四麻: `pt = (点数 − 25000) / 1000 + ウマ`。ウマは順位順に `+15, +5, −5, −15`。オカなし。1対局の合計は0（点数の合計は 100000）
- 三麻: `pt = (点数 − 35000) / 1000 + ウマ`。ウマは順位順に `+15, 0, −15`。オカなし。1対局の合計は0（点数の合計は 105000）
- 同点の2人にも、雀魂は順位どおりに違うウマをつける（分けない）。そのため、順位は pt の大きい順で一意に決まり、シートの順位もそれと一致する
- Web サービスでは、牌譜の `total_point` をそのまま使えば、部屋の設定が違う対局にも対応できる。ウマの式は、確かめるため、または設定の表示のために使う

### ランキングの作り方
- 四麻と三麻は別のランキング
- プレイヤー名ごとにまとめる: 累計pt（合計）、平均pt、対局数、トップ回数（順位1の数）
- 並べ方は累計pt の大きい順。累計pt が同じときの並びは決めていない（`QUERY` 任せ）。順位は上から1, 2, 3…と振る（同点でも同じ順位にしない）
- 最低対局数などの条件はない。試合結果シートに入っている対局は、すべて対象（ルールが東風か半荘かは記録していない）
- 期間の絞り込み（年別）: `起点 <= 対戦日時 < 終点`。日付の区切りは0時
- 今月参加済み（年別シートの G 列）: 今月に1局以上打っていれば `◯`、なければ `-`

### 移植で気をつけること（タスク 012 への申し送り。対応は上の「集計（Web サービス）」）
- 年別シートの終点が `YYYY-12-31` で、`<` で比べているため、12月31日の対局が入らない。意図ではないとみられる
- 四麻の年別シートの「今月参加済み」は、月の3日から末日の前日までを見ている（`EOMONTH(TODAY(),-1)+3` と `< EOMONTH(TODAY(),0)`）。`sandbox` の同じ式は1日からなので、意図ではないとみられる
- プレイヤー名（ニックネーム）でまとめているので、名前を変えると別人として数えられる。Web サービスでは雀魂のアカウント ID でまとめ、表示には最新の名前を使うのがよい
- 対局は深夜0時をまたぐことが多い。月や年での区切りに、日付の境目（0時か、配信の区切りか）をどうするか決める

## PaifuImporter の詳細
- CommonJS。依存は `protobufjs` / `ws` / `request-promise` / `uuid@3` など（古い。更新はタスクで検討）
- 認証: `env.js`（gitignore 済み）から `URL_BASE` / `ACCESS_TOKEN` / `PREFERRED_SERVER` / `OAUTH_TYPE` を読む
- 入力: `input/` の牌譜URL一覧（ファイル名は `getPaifu.js` にハードコード）
- 出力: `output/YYYY_MM_DD-hh_mm_ss_<ルール表示>.json`。`parse()` の結果は downloadlogs 由来の mjlog 形式（`ver: "2.3"`、`ref` は牌譜 uuid、`rule` など）
- 時刻は `TZ=Asia/Tokyo` 固定

## 雀魂の WebGL 版の通信（タスク 001・005 で確認）
- 接続先は `wss://jpgs.mahjongsoul.com/gateway`。ログイン後に `jpgsbk.mahjongsoul.com/gateway` も張る。最初に `.lq.Route.requestConnection` を送る
- 形式は従来どおり liqi（protobuf）。定義は `version.json` → `resversion<ver>.json` → `liqi.json` で取れる
- `client_version_string` は `WebGL_2022-0.16.280` の形式。ゲームの更新で版が上がり、古い版のままだと `oauth2Auth` が `err=151` になる（2026-11-19 に `0.16.287` を確認。追従の方法はタスク 016）
- ログインの流れ（タスク 006 で確認）
  1. ブラウザ側で Yostar の SDK が HTTP API（`jp-sdk-api.yostarplat.com`。`/user/quick-login` など）を呼び、`UserInfo.ID`（11文字）と `UserInfo.Token`（40文字）を得る。値はログインのたびに同じだった。HTTP の要求には、`authorization` ヘッダーとして JSON（`Head`: 地域・PID・端末 ID・UID・Token・時刻など。`Sign`: 32文字）が付いている
  2. `jpgs` に接続して `Route.requestConnection`（`type=1`、`route_id="jp-1"`、**項目6 = `"Web"`**）を送り、`Route.heartbeat` を定期的に送る。項目6は公開の liqi.json の定義になく、デコードでは見えない。これがないと `oauth2Auth` が `err=151` になる
  3. `oauth2Auth`（`type=21`、`code`=Token、`uid`=ID）→ `access_token`（36文字。毎回変わる）→ `oauth2Check` → `oauth2Login`（`client_version: {resource, package}`、`tag="jp"` など）
  4. 2本目の接続 `jpgsbk` では、`requestConnection`（`type=2`、`route_id="jp-2"`、項目6 = `"Web"`）→ `prepareLogin`（`access_token`）を送る
  - Node だけでも、保存した `code` / `uid` と項目6で、ログインから牌譜の取得まで通る（タスク 007）。Yostar の HTTP API を Node から呼ぶ必要はない
  - Yostar の Token は端末ごとに管理されている（`/user/device-list`・`/user/remove-device`）。期限切れ（`100403`）になることもある。有効期間はタスク 009 で計測中
  - WebGL 版は、公開の liqi.json にない項目を送ることがある（`oauth2Login` の `device` の中など）。差は、送信バイトをデコード→再エンコードして比べると見つかる
- 他人を指定できる主な要求: `searchAccountByEid`（表示 ID → 内部 ID）、`fetchAccountInfoExtra(account_id, category, type)`（`category` 1=四麻/2=三麻、`type` 1=段位戦/2=友人戦。最新50件、2024-08 ごろ以降）

## 既知の注意点
- 雀魂側のプロトコル・バージョン変更で動かなくなりうる（`majsoul.js` は 2024-11 の修正が最後）
- `getPaifu.js` はグローバル変数の暗黙宣言が多い（`paifuURLs`, `uuids` など）
