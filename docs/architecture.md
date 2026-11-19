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
| Drive / GAS / スプレッドシート | リポジトリ外 | 旧方式の牌譜の置き場、投入スクリプト、集計。**Web サービスに置き換えてやめる**（2026-11-19）。集計のルールを移すために、タスク 003 で取り込む |

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

### 雀魂に負荷をかけない運用
- 1回の実行につきログインは1回。要求の間隔は1秒以上。1回で取る牌譜の数に上限を設ける
- 同時に実行しない（DynamoDB の条件付き書き込みでロック）。手動の更新は間隔を制限する
- 定期取得は1日1回程度

### 費用の見込み（東京）
- CloudFront・WAF・Route 53: 定額の無料プランで $0（1アカウントで Free プランは3つまで。word-flashcard で1つ使用）
- Lambda・DynamoDB・SSM（標準）・EventBridge Scheduler・Cognito: 恒常の無料枠に収まる見込み
- S3（牌譜の json）: 1円未満
- 未確認: Lambda Function URL を定額プランのディストリビューションの配信元にできるか（タスク 010）

### 既知のリスク
- Lambda は AWS の IP から雀魂に接続する。弾かれないか、運営がブラウザで遊んでいるときに同時ログインで追い出し合わないかを、先に確かめる（タスク 011）
- 雀魂の利用規約との関係は `docs/local/008-terms-notes.md`

## PaifuImporter の詳細
- CommonJS。依存は `protobufjs` / `ws` / `request-promise` / `uuid@3` など（古い。更新はタスクで検討）
- 認証: `env.js`（gitignore 済み）から `URL_BASE` / `ACCESS_TOKEN` / `PREFERRED_SERVER` / `OAUTH_TYPE` を読む
- 入力: `input/` の牌譜URL一覧（ファイル名は `getPaifu.js` にハードコード）
- 出力: `output/YYYY_MM_DD-hh_mm_ss_<ルール表示>.json`。`parse()` の結果は downloadlogs 由来の mjlog 形式（`ver: "2.3"`、`ref` は牌譜 uuid、`rule` など）
- 時刻は `TZ=Asia/Tokyo` 固定

## 雀魂の WebGL 版の通信（タスク 001・005 で確認）
- 接続先は `wss://jpgs.mahjongsoul.com/gateway`。ログイン後に `jpgsbk.mahjongsoul.com/gateway` も張る。最初に `.lq.Route.requestConnection` を送る
- 形式は従来どおり liqi（protobuf）。定義は `version.json` → `resversion<ver>.json` → `liqi.json` で取れる
- `client_version_string` は `WebGL_2022-0.16.280` の形式
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
