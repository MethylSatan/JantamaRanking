# アーキテクチャ

全体像の図は `architecture.png`（①牌譜を開く → ②牌譜ファイル取得 → ③Drive へアップロード → ④スクリプト実行 → ⑤牌譜データ取得 → ⑥スプレッドシートへ投入）。

## 構成要素
| 要素 | 場所 | 役割 |
|---|---|---|
| GetPaifuURLs | `Tampermonkey/GetPaifuURLs.js` | **WebGL 版では動かない（2026-11 時点）。** 雀魂の画面で L キー。`fetchGameRecordList`（type=1: 友人戦、最大30件）を呼び、URLと対戦者名を `PaifuURLs_YYYYMMDD.txt` に保存 |
| downloadlogs | `Tampermonkey/downloadlogs.js` | **WebGL 版では動かない（2026-11 時点）。** S キーで、開いている牌譜を json でダウンロード。Equim-chan 作のフォーク |
| PaifuImporter | `PaifuImporter/` | Node。`getPaifu.js` が `majsoul.js` で雀魂に WebSocket 接続し、URL一覧の各牌譜を `fetchGameRecord` で取得、`parse()` で変換して `output/` に json 保存 |
| token.js | `misc/token.js` | WebSocket メッセージ（hex）からアクセストークンを取り出す補助 |
| 牌譜回収 | `src/collector/` | システム用の雀魂アカウントで、主催者の友人戦一覧（`fetchAccountInfoExtra`）と中身（`fetchGameRecordsDetail`）を取る。Web サービスの Lambda から呼ぶ部品と、手元で試す CLI。下の「牌譜回収（タスク 006）」 |
| Web サービス | `infra/`（Terraform）、`src/api/`（Lambda）、`web/`（画面）、`.github/workflows/deploy.yml` | 基盤はタスク 010 で構築済み（`docs/deploy.md`）。画面と API の中身はタスク 013（024〜028 に分割）。下の「Web サービスの構成」 |
| 集計 | `src/ranking/` | 牌譜 json から対局の結果を取り出し、ランキングを作る。依存のない TypeScript の関数。Lambda と画面の両方で使う。下の「集計（Web サービス）」 |
| Drive / GAS / スプレッドシート | リポジトリ外（GAS の写しは `gas/`） | 旧方式の牌譜の置き場、投入スクリプト、集計。**Web サービスに置き換えてやめる**（2026-11-19）。シートの構成と集計のルールは下の「旧集計（スプレッドシート）」 |

## データの流れ
雀魂のブラウザ版は Unity WebGL 版へ置き換わり（時期は未確認。2026-11 時点で確認）、Tampermonkey の2本は動かなくなった（タスク 001）。代わりに、システム用の雀魂アカウントから主催者の友人戦を取る方式にする（タスク 005、`docs/decisions.md` 2026-11-16）。
```
新: 雀魂 ──(Lambda、システム用の雀魂アカウント: 主催者の友人戦一覧 → 候補 → 選んだ対局の中身)──▶ 牌譜 json（S3）
    ──▶ 対局の結果（DynamoDB）──▶ 集計 ──▶ ランキングの画面
```
旧（参考）:
```
雀魂 ──(Tampermonkey)──▶ 牌譜URL一覧 .txt ──(PaifuImporter)──▶ 牌譜 json
雀魂 ──(downloadlogs)──────────────────────────────────────▶ 牌譜 json
牌譜 json ──▶ Google Drive ──(GAS)──▶ スプレッドシート（試合結果シート）──▶ 集計
```

## Web サービスの構成（タスク 008 で決定。基盤はタスク 010 で構築）
word-flashcard（隣のリポジトリ）の配信基盤に合わせる。決定の理由は `docs/decisions.md` 2026-11-19。
```
ブラウザ → jantama-ranking.methylsatan.com（Route 53 の ALIAS）
        → CloudFront（WAF、*.methylsatan.com の証明書、定額の無料プラン）
            ├ /*     → S3（画面: SPA、ランキングの JSON）
            └ /api/* → Lambda Function URL（OAC）→ Lambda（Node 24）
Lambda ──(L2、システム用の雀魂アカウント)──▶ 雀魂
  ├ 認証情報: SSM Parameter Store（SecureString）
  ├ データ: DynamoDB。牌譜の生 json は S3
  └ 定期取得: EventBridge Scheduler → Lambda
Admin・Host の認証: Cognito のユーザープール ← Discord（OIDC の IdP）。API は Cognito の JWT で守る
```

### 構成要素
| 要素 | 内容 |
|---|---|
| 画面 | SPA（Vite + TypeScript + Preact。`docs/decisions.md` 2026-11-20 タスク 019）。Admin・Host 向け: 雀魂アカウント（複数可）の指定 → 候補の対局の一覧 → 取り込む対局を選ぶ。Viewer 向け: ランキング |
| API（Lambda） | 候補の更新（雀魂から一覧を取る）、取り込み（選んだ対局の中身を取り、結果を保存し、ランキングを作り直す）、対象外にする操作 |
| 定期取得 | 1日1回程度、登録した雀魂アカウントの候補を更新する。一覧は種類ごとに最新50件なので、上限に達する前に取りこぼさないため |
| 認証情報 | システム用の雀魂アカウントの `code` / `uid`（と端末 ID）。取り直しはタスク 009 |
| ログイン | Admin・Host は Discord でログインする（メールとパスワードは使わない）。Discord を Cognito の OIDC の IdP にし、画面は Cognito の Hosted UI（`jantama-ranking-auth.methylsatan.com`）へ移って認可コード＋PKCE でトークンを受け取る。許可した Discord の ID（SSM の一覧）でなければ、pre sign-up のトリガーが利用者を作らせない。スコープは `openid identify`（メールは求めない）。Admin かどうかは Cognito のグループ（`admins`）で持つ。操作ログには Cognito の `sub` を書き、Discord の ID・表示名との対応は別に持つ（本人の依頼で消せるように）。接続はタスク 020、主催者の本人確認は行わない（タスク 021）、権限は下の「権限（タスク 022）」（`docs/decisions.md` 2026-11-20 タスク 014） |
| Terraform | `infra/`。状態は `methylsatan-tfstate` の `jantama-ranking/terraform.tfstate`。Route 53 のゾーン、証明書（us-east-1）、GitHub の OIDC プロバイダーは word-flashcard のものを `data` で参照する。リソースの一覧・手順・OAC の注意は `docs/deploy.md` |

### データモデル（2026-11-25 にタスク 013 の分割で設計。タスク 024・025 で実装済み）
DynamoDB のテーブルは `pk`/`sk` のまま、GSI は足さない。件数が小さいので、一覧は一覧用の項目で引く（Scan は使わない）。

| 項目 | `pk` | `sk` | 主な属性 |
|---|---|---|---|
| ランキング | `RANKING#<ID>` | `META` | 名前、公開 ID、状態（公開 / 削除）、作成者の sub・時刻 |
| ランキングの一覧（Admin 用） | `RANKINGS` | `RANKING#<ID>` | 名前、状態 |
| ランキングの雀魂アカウント | `RANKING#<ID>` | `ACCOUNT#<表示用 ID>` | 内部 ID（最初の候補の更新で引く）、追加した人の sub・時刻 |
| 雀魂アカウント（ランキングをまたいで共有） | `MAJSOUL#<内部 ID>` | `META` | 最後に候補を更新した時刻、最後に手動の更新を受け付けた時刻、名前（一覧に出ていたニックネーム） |
| 雀魂アカウント → ランキング | `MAJSOUL#<内部 ID>` | `RANKING#<ID>` | 表示用 ID（定期取得で、取りこぼしの警告に使う処理済みの対局を集める） |
| 雀魂アカウントの一覧（定期取得用） | `MAJSOULS` | `MAJSOUL#<内部 ID>` | |
| 候補の対局（雀魂アカウントごと） | `MAJSOUL#<内部 ID>` | `GAME#<牌譜 uuid>` | 開始・終了時刻、四麻/三麻、`sub_tag`、参加者 |
| 対局の状態（ランキングごと） | `RANKING#<ID>` | `GAME#<牌譜 uuid>` | 状態（取り込み済み / 対象外）、取り込んだことがあれば `GameResult`（対象外にしても残す）、変えた人の sub・時刻 |
| 操作ログ | `RANKING#<ID>` | `LOG#<ISO 時刻>#<乱数>` | sub、`via`、操作、対象、内容 |
| Host・逆向きの項目・利用者の情報 | 下の「権限（タスク 022）」 | | |
| ロック | `LOCK` | `MAJSOUL` | 持ち主のジョブ ID、期限（epoch ms。条件付き書き込み） |
| ジョブ | `JOB#<ID>` | `META` | 種類（`refresh` / `import` / `rebuild`）、ランキング ID（定期取得は無し）、状態（`queued` / `running` / `done` / `failed`）、進み具合、結果、誤り、作成者の sub と `via`（定期取得は `scheduler`）、取り込む uuid |

- 候補は、ランキングの雀魂アカウントたちの候補の対局を牌譜 uuid で合わせ、そのランキングで状態の項目を持つ対局を除いたもの。状態の項目が無ければ候補。同じ雀魂アカウントの対局を、別のランキングでは違う扱いにできる
- 最後に候補を更新した時刻は雀魂アカウント単位（同じアカウントを指す複数のランキングで共有する）
- 雀魂アカウントの指定は、表示用 ID を保存するだけで雀魂に要求しない。内部 ID は最初の候補の更新のジョブで引き、そのとき「雀魂アカウント → ランキング」と「雀魂アカウントの一覧」の項目も作る。外すと、この2つも外す（どのランキングからも指されなくなったときだけ一覧から外す）
- 候補の対局は、一覧に出たものを処理済みも含めて全件書く（同じ uuid は上書き）。ジョブ・候補の項目を消すか（DynamoDB の TTL）は、手順が固まった後に決める（タスク 025 のメモ）
- 集計は、ランキングの `GAME#` の項目を1回の Query で読み、取り込み済みの `GameResult` から作る
- 操作ログはランキングごとに持つ。Admin が全体を見るときは、ランキングごとに引いて合わせる
- 牌譜（head）は data バケットの `records/<牌譜 uuid>.json` に置く（ランキングをまたいで1つ）。作り直しは、取り込み済みの uuid ごとに S3 の牌譜から `GameResult` を作り直す
- ランキングの JSON: 取り込み・対象外・戻す・作り直し・名前の変更のたびに作り直し、site バケットの `rankings/<公開 ID>.json` に置いて CloudFront から配る（閲覧で Lambda を動かさない）。`Cache-Control: no-cache` を付ける（CloudFront の `Managed-CachingOptimized` は配信元の Cache-Control に従うので、毎回確かめに行く）。公開 ID はランキング ID と別の推測されない値にし、取り直せるようにする。取り直したら新しい JSON を置いてから古い JSON を消す。ランキングを削除（非公開）にしたときも JSON を消す。過去の版は S3 のバージョニングで残る
- ランキングの JSON の形: `{ version: 1, name, generatedAt, games: GameResult[] }`。`games` は取り込み済みの対局だけ、終了時刻の順（同時刻は uuid の順）。集計済みの表にはしない。閲覧の画面（タスク 027）が期間・四麻か三麻かで絞り込んでから `src/ranking` の `aggregate` などで集計する
- 置き場所: 牌譜は data バケットの `records/<uuid>.json`、雀魂のバージョンと定義は同じバケットの `state/client-version.json`・`state/liqi.json`。システム用の雀魂アカウントの認証情報は SSM の SecureString `/jantama-ranking/majsoul-credentials`（JSON: `type`・`code`・`uid`）、定義の鍵は `/jantama-ranking/liqi-lua-key`（`docs/deploy.md` 手順 8）

### API（024・025 で実装済み）
| 要求 | 内容 |
|---|---|
| `GET /api/me` | sub、Admin か、操作の許可の表（`src/api/authorize.ts` の `PERMISSIONS`。画面がボタンを出し分ける） |
| `GET` / `POST /api/rankings` | ランキングの一覧（Admin は全部、Host は付いているもの。削除したものも状態付きで出す）・作成（`{name}`、1〜100文字） |
| `GET` / `PATCH` / `DELETE /api/rankings/{id}` | 取得（雀魂アカウントの一覧と、どの役割で許したか `via` を含む）・名前の変更（`{name}`）・削除（非公開にする） |
| `PUT` / `DELETE /api/rankings/{id}/accounts/{表示用 ID}` | 雀魂アカウントの指定・外す（表示用 ID は数字だけ。何度呼んでも同じ結果。変わったときだけ操作ログに書く） |
| `GET /api/rankings/{id}/games?state=candidate\|imported\|excluded` | 対局の一覧（既定は `candidate`）と、雀魂アカウントの一覧（内部 ID・名前・最後に候補を更新した時刻）。候補は一覧の1件の形に、どの雀魂アカウントの一覧に出たか（`sources`）を足したもの。取り込み済み・対象外は状態の項目 |
| `POST /api/rankings/{id}/refresh` | 候補の更新（ジョブ。202）。雀魂アカウントが無ければ 400、同じ雀魂アカウントの手動の更新から5秒たっていなければ 429 |
| `POST /api/rankings/{id}/import` | 取り込み（`{uuids}`。そのランキングの候補だけ、100件まで。ジョブ。202） |
| `POST /api/rankings/{id}/rebuild` | 牌譜からの作り直し（ジョブ。202。雀魂には接続しない） |
| `POST /api/rankings/{id}/games/{uuid}/exclude` / `restore` | 対象外にする・戻す（すぐ終わる。取り込み済みの対局が変わればランキングの JSON を作り直す） |
| `POST /api/rankings/{id}/public-id` | 公開 ID の取り直し（古い JSON は消す） |
| `GET /api/rankings/{id}/logs` | 操作ログ（新しい順に100件） |
| `GET /api/jobs/{id}` | ジョブの状態。そのランキングを見られる人だけ（定期取得のジョブは Admin だけ。ほかは 404） |

- 認証は `x-auth-token` ヘッダーの Cognito のアクセストークン（`docs/deploy.md`「API と OAC」）。`src/api/jwt.ts` が署名（RS256、JWKS）・発行者・`token_use=access`・`client_id`・期限を確かめる。判断は `authorize()`（下の「権限（タスク 022）」）
- 応答: トークンが無い・正しくない 401、表で許されない 403、ランキングが無い・付いていない 404、入力の誤り 400
- 利用者の情報（`USER#<sub>` / `PROFILE`）は 024 では書かない。アクセストークンに Discord の ID・名前が無く、使うのは Host の付け外し（タスク 023）なので、023 で決める

### 取り込みの手順（Admin・Host から見た流れ。タスク 025）
1. ランキングを作り、雀魂アカウント（表示用 ID）を指定する
2. 候補を更新する（ジョブ）: システム用の雀魂アカウントでログインし、ランキングの雀魂アカウントごとに友人戦の一覧（四麻・三麻）を取って保存する。内部 ID がまだ無ければ先に引く。1つのアカウントの失敗（表示用 ID が見つからない など）は、そのアカウントの結果に書いて、ほかは続ける。上限が近い・取りこぼしたおそれの警告は、ジョブの結果に入れる
3. 候補を見る: ランキングの雀魂アカウントたちの対局を uuid で合わせ、このランキングで状態を持つ対局を除いて、新しい順に出す
4. 対局ごとに選ぶ
   - 取り込む（ジョブ）: 牌譜が S3 に無い対局だけ雀魂から取って `records/` に置き（S3 にあればログインしない）、`fromRecordGame` で結果を作って「取り込み済み」にする。起動を待つ間に状態が付いた対局は触らない。最後にランキングの JSON を作り直す
   - 対象外にする（すぐ終わる）: 「対象外」にする。取り込み済みだった対局は結果を残したまま外れる
5. 戻す: 対象外の対局を、結果があれば「取り込み済み」に、無ければ候補に戻す
6. 作り直し（ジョブ）: 結果を持つ対局ごとに、S3 の牌譜から結果を作り直し、JSON を作り直す
7. 公開 ID の取り直し: 新しい公開 ID で JSON を置き、古い JSON を消す
- 操作はすべて操作ログに書く。ジョブは、作った人の sub と `via` で、終わったとき（失敗も）に書く。対象はジョブ ID、内容はジョブの結果

### 非同期の処理（タスク 025）
雀魂への要求は CloudFront の応答待ち（既定30秒）を超えうるので、ジョブにする。`src/api/jobs.ts`。
1. API がジョブの項目を作り、自分の Lambda を非同期（`InvocationType: Event`、入力 `{"source":"job","jobId":…}`。関数名は `AWS_LAMBDA_FUNCTION_NAME`）で起動して、202 とジョブを返す
2. 起動された Lambda は、ジョブが `queued` のときだけ `running` に変えて処理する（非同期の起動は2回届きうるため）。ロックを取り、雀魂に要求し、ジョブの項目に進み具合と結果を書く。ロックが使われていれば5秒おきに最大60秒待ち、空かなければ失敗にする。ロックの期限は Lambda の timeout（300秒）より長い360秒
3. 画面はジョブの状態を数秒おきに見る
- 定期取得（Scheduler の `{"source":"scheduler","action":"refresh-candidates"}`）も、ジョブの項目を作って同じ処理を通す。登録されたすべての雀魂アカウントの候補を更新する。警告は CloudWatch Logs に `[通知]` 付きで出す（有効にするのはタスク 028）
- collector の `notify`（定義が変わった、ログインに失敗した など）は、CloudWatch Logs に `[通知]` 付きで出し、ジョブの結果の `notices` にも入れる

### 作り直し・取り消し・履歴（`docs/product.md` 非機能要件「旧方式の利点を引き継ぐ」）
- 牌譜の生の json を置く S3 はバージョニングを有効にする。対局の結果とランキングは、牌譜から作る派生データとして扱う
- 作り直しの機能: S3 の全牌譜 → 対局の結果 → ランキング。旧方式の「アーカイブから全量を取り込み直す」にあたる。同じ入力からは毎回同じ結果になるようにする
- 取り消し: 対局の状態を「対象外」にするだけで、データは消さない。対象外から戻すこともできる
- 操作ログ: 誰が・いつ・どの対局を・どう変えたかを、追記だけで DynamoDB に残す
- 過去の時点に戻す: DynamoDB のポイントインタイムリカバリ（35日）と、ランキングの JSON の過去の版（S3 のバージョニング）
- 並べ替え・絞り込みは画面側で行う（ランキングの JSON を受け取ったブラウザで処理する）。CSV などでの書き出しは用意しない

### 権限（タスク 022）
決定の理由は `docs/decisions.md` 2026-11-25（タスク 022）。

#### 用語
- **Admin**: このサービスを動かす人。全体の権限を持つ（以前の文書の「運営」）。画面など利用者に見せる日本語では「管理人」と書く
- **Host（主催者）**: ランキングに付いて、そのランキングを操作する人。友人戦を開いている本人のほか、手伝いの人も Host として付ける
- **Viewer（閲覧者）**: ランキングを見る人。ログインしない
- **ランキングの雀魂アカウント**: そのランキングの候補の対局を取ってくる元の雀魂アカウント。1つのランキングに複数指定できる。持ち主が Host である必要はなく、持ち主かどうかも確かめない（タスク 021）
- **システム用の雀魂アカウント**: このサービスが牌譜を取りに行くための雀魂アカウント（以前の文書の「運営アカウント」）

#### 役割
| 役割 | 範囲 | 持ち方 |
|---|---|---|
| Admin | 全体。すべてのランキングを操作でき、利用者を管理する | Cognito のグループ `admins` |
| Host | ランキングごと。1つのランキングに何人でも付けられる | DynamoDB のランキングごとの対応（`role=host`） |
| Viewer | ログインしない。推測されない URL でランキングを見るだけ | なし |

- ログインできても、Admin でなく、どのランキングにも付いていない利用者は、何も操作できない（ランキングの一覧が空になる）
- Admin だけで回しているランキングには、Host がいなくてよい

#### 操作ごとの許可
○: できる、―: できない。Host の欄は、自分が付いているランキングに限る。

| 操作 | Admin | Host |
|---|---|---|
| ランキングの作成 | ○ | ― |
| ランキングの閲覧（管理の画面で。雀魂アカウントの一覧を含む） | ○ | ○ |
| ランキングの雀魂アカウントの指定・変更 | ○ | ○ |
| ランキングの名前の変更 | ○ | ○ |
| ランキングの削除（非公開にする。データは消さない） | ○ | ― |
| 候補の更新（雀魂への要求） | ○ | ○ |
| 取り込み | ○ | ○ |
| 対象外にする・戻す | ○ | ○ |
| 牌譜からの作り直し | ○ | ○ |
| 操作ログの閲覧 | ○（全体） | ○ |
| 公開 URL の発行・取り直し | ○ | ○ |
| ランキングへの Host の付け外し | ○ | ― |
| 利用者の許可（Discord の ID の許可の一覧） | ○ | ― |
| Admin の付け外し | CLI だけ | ― |

- ランキングの作成は Admin だけにする。雀魂アカウントの指定・変更は Host にもできる。雀魂アカウントは候補を取る元にすぎないので、持ち主かどうかの確認（本人確認）は行わない（タスク 021）。同意なしに友人戦が集計・公開されることは、Admin が誰を Host に付けるかで防ぐ。指定・変更は操作ログに書く
- ランキングごとの役割は Host の1つにする。持ち主と手伝いを分けても、違いは名前の変更や公開 URL の取り直しなど小さく、手伝いの人を足すにも Admin が許可の一覧に足す必要があるので、Host が他の人を付け外しできても手間は減らない。区別が要るようになったら、`role` の値を足す
- ランキングの削除は、データを残して非公開にする（上の「作り直し・取り消し・履歴」の、データを消さない方針）。データまで消すのは Admin が手作業で行う

#### ランキングごとの権限の持ち方（DynamoDB。テーブルは `pk`/`sk`）
| 項目 | `pk` | `sk` | 属性 |
|---|---|---|---|
| ランキングの Host | `RANKING#<ランキング ID>` | `MEMBER#<sub>` | `role`（`host`）、`addedBy`（sub）、`addedAt` |
| 利用者から引く逆向きの項目 | `USER#<sub>` | `RANKING#<ランキング ID>` | `role` |
| 利用者の情報 | `USER#<sub>` | `PROFILE` | Discord の ID、表示用の名前 |

- 利用者は Cognito の `sub` で表す。Discord の ID・表示名は「利用者の情報」の項目にだけ置き、操作ログや Host の項目には書かない（Discord の規約で消すとき、この項目と Cognito の利用者を消せば済む）
- Host の項目と逆向きの項目は、1つのトランザクション（`TransactWriteItems`）で一緒に書き、一緒に消す。ランキングの一覧は逆向きの項目から引く
- Host は、自分が付いていないランキングの存在も知れない。そのランキングへの要求は 404 で返す
- 対局の状態（候補 / 取り込み済み / 対象外）は、ランキングごとに持つ。同じ雀魂アカウントの対局を、別のランキングでは違う扱いにできる

#### 全体の権限とランキングごとの権限の分け方
- Cognito のグループは、全体に効く印（`admins`）にだけ使う。ランキングごとの権限はグループにしない（グループの数の上限、トークンが大きくなる、変更がトークンの取り直しまで効かない）
- グループの変更は、ID トークン・アクセストークンの期限（既定の1時間）まで効かない。Admin を急いで外すときは、グループから外したうえで、利用者を無効にし（`AdminDisableUser`）、全端末でサインアウトさせる（`AdminUserGlobalSignOut`）
- ランキングごとの権限は、要求のたびに DynamoDB を読むので、付け外しはすぐ効く

#### API での判断
- 権限の判断は1か所にまとめる: `authorize(利用者, 操作, ランキング ID)`。利用者は JWT から取った `sub` と `cognito:groups`。結果は「許可（どの役割で許したか: `admin` / `host`）」か「拒否」
- 操作の種類と、それを許す役割の表は、コードの中で上の「操作ごとの許可」と同じ形の1つの表にする（`src/api/authorize.ts` の `PERMISSIONS`。`authorize.test.ts` が文書と同じかを確かめる）。画面はこの表を API から受け取り、できない操作のボタンを出さない（判断は必ず API で行う）
- 操作ログには、操作した人の `sub` と、どの役割で許したか（`via`）を書く。Host の付け外しも操作ログに書く

#### 付け外しの流れ
当面（Admin だけが操作する間）:
- 利用者の許可は、Admin が SSM の許可の一覧（`/jantama-ranking/allowed-discord-ids`）を CLI で変える。Admin の付け外しは、Cognito のグループを CLI で変える（`docs/deploy.md`）
- Host の項目は作らない（Admin はグループで全体に効くので要らない）

主催者に開放したとき:
- 主催者や手伝いの人に自分の Discord の ID を Admin へ伝えてもらい、Admin が許可の一覧に足す。Admin がランキングを作り、その人を Host として付ける。雀魂アカウントの指定は Admin でも Host でもよい
- 許可の一覧と Host の付け外しを画面から行えるようにするかは、開放するときに決める（タスク 023）。招待リンクと Discord サーバーのロールは採らない（`docs/decisions.md` 2026-11-25 タスク 022）
- 取り消し: ランキングから外すだけなら、Host の項目を消す。利用者そのものをやめるときは、許可の一覧から外し、Host の項目・利用者の情報・Cognito の利用者を消す。操作ログには `sub` だけが残る（Discord の規約。`docs/local/014-login-notes.md`）

#### 雀魂への負荷との関係
- 手動の候補の更新の間隔は、役割ではなく雀魂アカウントごとに制限する。同じ雀魂アカウントを複数のランキングが指していても、雀魂への要求は雀魂アカウントの単位で起きるため。Admin も同じ制限に従う。間隔は5秒（ユーザーの判断で数秒。`docs/decisions.md` 2026-11-25 タスク 025）。内部 ID がまだ無い（初めての更新の）アカウントは数えない
- 同時に実行しないためのロックは全体で1つ（下の「雀魂に負荷をかけない運用」）。開放して要求が増えたときの上限は、タスク 023 でやり直す

### 雀魂に負荷をかけない運用
- 1回の実行につきログインは1回。要求の間隔は1秒以上。1回で取る牌譜の数に上限を設ける
- 同時に実行しない（DynamoDB の条件付き書き込みでロック。上の「非同期の処理」）。手動の更新は雀魂アカウントごとに5秒あける
- 定期取得は1日1回程度

### 費用の見込み（東京）
- CloudFront・WAF・Route 53: 定額の無料プランで $0（1アカウントで Free プランは3つまで。word-flashcard で1つ使用）
- Lambda・DynamoDB・SSM（標準）・EventBridge Scheduler・Cognito: 恒常の無料枠に収まる見込み（Cognito の Lite プランの OIDC 連携は月50 MAU まで無料）
- S3（牌譜の json。バージョニングで古い版も残る）: 1円未満
- DynamoDB のポイントインタイムリカバリ: $0.228/GB月（数 MB なら1円未満）
- Lambda Function URL を配信元にしても、定額の無料プランに加入できた（2026-11-20、タスク 010）
- 単価と見込みの表は `docs/deploy.md`

### 既知のリスク
- Lambda は AWS の IP から雀魂に接続する。弾かれないか、システム用の雀魂アカウントでブラウザから遊んでいるときに同時ログインで追い出し合わないかを、先に確かめる（タスク 011）
  - 2026-11-19: Lambda からの1回目は `oauth2Auth` が `err=151` で失敗した。原因は送った雀魂のバージョンが古かったこと。バージョンを直すと Lambda からログインから牌譜の取得まで通った（`docs/decisions.md` 2026-11-19 タスク 011）。同時ログインの挙動は確認しない。システム用の雀魂アカウントは運用専用で、ブラウザでは遊ばない（同 タスク 011）
- 雀魂の利用規約との関係は `docs/local/008-terms-notes.md`

## 集計（Web サービス。タスク 012）
旧シートの集計（下の「旧集計」）を移したもの。`src/ranking/`。テストは直下で `npm test`。決定の理由は `docs/decisions.md` 2026-11-19（タスク 012）。

| ファイル | 内容 |
|---|---|
| `types.ts` | `GameResult`（牌譜 uuid、終了時刻、四麻/三麻、各家の結果）、`PlayerResult`（席、アカウント ID、名前、点数、pt、順位）、`RankingRow` |
| `mjlog.ts` | `fromMjlog`: mjlog 形式（前期・後期とも）の牌譜 json から `GameResult` を作る。読むのは `ref`・`ratingc`・`name`・`sc`・`title[1]` だけ。アカウント ID は無い |
| `record.ts` | `fromRecordGame`: 新方式の牌譜（雀魂の `RecordGame` の head。タスク 006）から `GameResult` を作る。アカウント ID が入る。点数は `part_point_1`、pt は `total_point / 1000`、終了時刻は `end_time`。`accounts` に無い席は AI |
| `rank.ts` | 順位は pt の大きい順。pt が同じなら席順（東家が上） |
| `period.ts` | 日付は日本時間の朝6時で区切る（`businessDay` / `businessMonth` / `businessYear`）。期間 `{ from?, to? }` は両端の日を含む |
| `aggregate.ts` | `aggregate`: ランキング。`playedThisMonth`: 今月参加済み。`notPlayedThisMonth`: 今年打った人のうち今月まだの人（今年の対局数の多い順） |

- ルールは固定。四麻と三麻は別のランキング。最低対局数なし
- まとめるキーは、アカウント ID があれば `id:<ID>`、無ければ `name:<名前>`。表示名は最新の対局の名前
- 列は累計pt・平均pt・対局数・トップ回数。pt の合計は 0.1pt 単位の整数で足す（浮動小数の誤差を出さない）
- 並べ方は累計pt の大きい順。同点は対局数の少ない順、さらにキーの順。順位は 1, 2, 3… と振る（同点でも分ける）
- 旧シートとの違い: 区切りが0時→6時、年別に12月31日を含む、今月参加済みは1日から（旧四麻は3日から）、累計pt が同点のときの並びを決めた
- 旧シートとの突合（2026-11-19）: 牌譜 json（Drive のアーカイブの全量）→ 試合結果シート → Ranking シートの3点で比べ、すべて一致した。牌譜から取り出した結果は試合結果シートの全行と、集計は全期間・年別の Ranking シート（四麻・三麻）の全員の値と一致した。年別はシートと同じ区切り（0時、終点を含まない）で比べた。6時区切りにしても、どの年も対局数は変わらない。具体は `docs/local/012-verify-notes.md`

## 牌譜回収（タスク 006）
`src/collector/`。Lambda から呼ぶ部品（`index.ts`）と、手元で試す CLI（`cli.ts`。手順は `docs/collector.md`）。決定の理由は `docs/decisions.md` 2026-11-19（タスク 006）。

| ファイル | 内容 |
|---|---|
| `session.ts` | `openSession(deps)`: 保存済みの雀魂のバージョンと定義でログインする。`oauth2Auth` が `err=151` のときだけ、静的ファイルから作り直し、ログインを1回だけやり直す。`refreshState`: 作り直しだけ（ログインしない） |
| `collect.ts` | `listCandidates(session, 主催者, 既知か)`: 四麻・三麻の友人戦から、取り込み済み・対象外を除いた候補と、除く前の全件（`all`）。`fetchHeads(session, uuids)`: 牌譜の head を取り、見た目の情報を外す。`gameLength(sub_tag)`: 東風・半荘 |
| `static.ts` / `unityfs.ts` | 公開の静的ファイル（ログインなし）。`bundle_info_so.majset` から、資産のパスが入っているバンドル名を引く |
| `liqi.ts` | 定義の Lua の復号（鍵は呼び出し側から）、protobufjs の JSON への変換、使っている型の比較 |
| `connection.ts` / `login.ts` | WebSocket と L2 のログイン。応答に定義に無い項目番号があればログに残す |

- 呼び出し側が渡すもの（`CollectorDeps`）: 雀魂のバージョンと定義の置き場所（`store`。Lambda では S3、CLI ではファイル）、認証情報（Lambda では SSM、CLI では秘密ファイル）、定義の鍵、通知の送り先。取り込み済み・対象外の記録と、同時に実行しないためのロックも呼び出し側が持つ（タスク 025）
- 主催者は、表示用 ID（`searchAccountByEid` で内部 ID を引く）か内部 ID で指定する。Web サービスでは内部 ID を保存して使う（要求が1回減る）
- 候補: uuid、開始・終了時刻、四麻/三麻、`sub_tag`、参加者（席・名前・内部 ID・順位）。一覧が40件以上なら「上限が近い」、50件ちょうどで一番古い対局が未処理なら「取りこぼしたおそれ」と警告する
- 一覧の `sub_tag` は牌譜の `config.mode.mode` と同じ値（2026-11-19 に60件で確認）。一の位が 1 なら東風、2 なら半荘。十の位は三麻とみられる（11・12）。4 の意味は未確認
- 保存する牌譜: `RecordGame` の head（`fetchGameRecordsDetail` の `record_list` の1件、protobufjs の `toObject` の形）から、参加者の見た目の情報（`avatar_id`・`character`・`views`・`title`・`avatar_frame`）を外したもの。1件あたり json で約1.2KB（gzip で約0.55KB）。0 や空の項目は省かれる（席 0 の `seat` など）
- 要求: ログインは1回の実行につき1回（`err=151` のやり直しを除く）。Lobby の要求の間は2秒。`fetchGameRecordsDetail` は50件ずつまとめる（50件まで1回で返ることを確認）。1回の実行で取る牌譜は100件まで
- 2本目の接続（`jpgsbk`）は張らない。張らなくても一覧と牌譜は取れる（タスク 011・006）
- Lambda（`nodejs24.x`）へは、esbuild で1ファイルの ESM にまとめて載せる（`npm run build:api`。タスク 010）。`ws` などは CommonJS で Node の組み込みを `require` するので、banner で `createRequire` を入れる（入れないと読み込みで `Dynamic require of "events" is not supported` になる。`node -e` で読むと `require` があるので気づかない）
- Web サービスでの組み込み（タスク 025）: `src/api/aws.ts` が `CollectorDeps` を作る（`store` は S3 の `state/`、認証情報と鍵は SSM）。`listCandidates` の戻り値の `all`（処理済みを含む全件）を候補の対局として保存する

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
- 形式は従来どおり liqi（protobuf）。定義は WebGL 版の静的ファイルから作る（タスク 017）
  - `bundle_info_so.majset` を展開すると、資産のパスごとに、入っているバンドルの番号が分かる。定義に要るのは2つ
    - `MyAssets/docs/proto_config.bytes`（平文の JSON）: サービスのメソッドと要求・応答の型名の一覧
    - Lua の定義ファイル（protoc-gen-lua の生成物）: 型ごとの項目の名前・番号・型。暗号化されていて、鍵は公開リポジトリに置かない
  - 2つを合わせて、protobufjs の JSON（旧来の liqi.json と同じ形）にする。具体は `docs/local/017-liqi-notes.md`
  - Web サービスでは、雀魂のバージョンと同じく `oauth2Auth` が `err=151` のときだけ作り直して S3 に置く。使っている型の項目番号・型が変わっていたら採用せずに通知する（`docs/decisions.md` 2026-11-19 タスク 017）
  - 旧クライアント（Laya 版）の経路（`version.json` → `resversion<ver>.json` → `liqi.json`）は、2026-11 時点で更新が止まっている。牌譜の型（`Record*`）とログインに使う型は WebGL 版と同じなので、比較用に残す
  - こちらから送る要求では、repeated の数値を packed にしない（ゲームと揃える）。サーバーは packed で返す
- `client_version_string` は `WebGL_2022-0.16.280` の形式。雀魂の更新でバージョンが上がり、古いバージョンのままだと `oauth2Auth` が `err=151` になる（2026-11-19 に `0.16.287` を確認）
- 雀魂のバージョンは、ブラウザなしで静的ファイルから得られる（タスク 016）。ログインで送る値は3つ
  - `client_version.resource`: `appstatic.mahjongsoul.com/v4/jp/resources/ab/WebGL/ASTC/bundle_info_so.majset`（UnityFS。LZ4 で圧縮）を展開し、`u6v_td1bd8bb002s_<20桁の16進>` という名前を探す。同じ場所からそのファイル（約1KB、UnityFS）を取って展開すると、`{"version":"0.16.287","platform":"WebGL"}` が入っている。名前の前半はバージョンが変わっても同じで、後半のハッシュだけが変わる（11/16 と 11/19 で確認）
  - `client_version_string`: `WebGL_2022-` に `resource` を付けたもの。前半の `WebGL_2022-` は固定とみている（出どころは未確認）
  - `client_version.package`: `https://game.mahjongsoul.com/` の `window.__webglProductVersion`（`4.0.18`）
  - 静的ファイルには、ゲームと同じようにランダムな `randv` クエリを付ける。`bundle_hash.txt`（40桁）は `bundle_info_so.majset` の SHA-1・MD5 ではなかった。何のハッシュかは未確認
  - Web サービスでは、前回の値を保存して使い、`oauth2Auth` が `err=151` のときだけ取り直して、ログインを1回だけやり直す（`docs/decisions.md` 2026-11-19 タスク 016）
  - 旧クライアント（Laya 版）の `version.json` は `0.11.x` の系列で、WebGL 版の雀魂のバージョンとは別物
- ログインの流れ（タスク 006 で確認）
  1. ブラウザ側で Yostar の SDK が HTTP API（`jp-sdk-api.yostarplat.com`。`/user/quick-login` など）を呼び、`UserInfo.ID`（11文字）と `UserInfo.Token`（40文字）を得る。値はログインのたびに同じだった。HTTP の要求には、`authorization` ヘッダーとして JSON（`Head`: 地域・PID・端末 ID・UID・Token・時刻など。`Sign`: 32文字）が付いている
  2. `jpgs` に接続して `Route.requestConnection`（`type=1`、`route_id="jp-1"`、**項目6 = `"Web"`**）を送り、`Route.heartbeat` を定期的に送る。項目6は旧クライアントの liqi.json の定義になく、WebGL 版の定義では `platform`（文字列）。これがないと `oauth2Auth` が `err=151` になる
  3. `oauth2Auth`（`type=21`、`code`=Token、`uid`=ID）→ `access_token`（36文字。毎回変わる）→ `oauth2Check` → `oauth2Login`（`client_version: {resource, package}`、`tag="jp"` など）
  4. 2本目の接続 `jpgsbk` では、`requestConnection`（`type=2`、`route_id="jp-2"`、項目6 = `"Web"`）→ `prepareLogin`（`access_token`）を送る
  - Node だけでも、保存した `code` / `uid` と項目6で、ログインから牌譜の取得まで通る（タスク 007）。Yostar の HTTP API を Node から呼ぶ必要はない
  - Yostar の Token は端末ごとに管理されている（`/user/device-list`・`/user/remove-device`）。期限切れ（`100403`）になることもある。有効期間はタスク 009 で計測中
  - WebGL 版は、旧クライアントの liqi.json にない項目を送る（`oauth2Login` の `device` の中の `device_id` など）。WebGL 版の定義には載っていて、記録済みの要求はすべてバイト単位で再現できた（タスク 017）
- 他人を指定できる主な要求: `searchAccountByEid`（表示 ID → 内部 ID）、`fetchAccountInfoExtra(account_id, category, type)`（`category` 1=四麻/2=三麻、`type` 1=段位戦/2=友人戦。最新50件、2024-08 ごろ以降）
  - `fetchAccountInfoExtra` は、件数が50件に届かなくても 2024-08 ごろより前の記録を返さない（2026-11-20 に、本人の牌譜画面と比べて確認）。本人の一覧（`fetchGameRecordList` / `fetchNextGameRecordList`。相手を指定できない）は、それより前まで遡れる。新しい主催者の過去分の扱いはタスク 018

## 既知の注意点
- 雀魂側のプロトコル・バージョン変更で動かなくなりうる（`majsoul.js` は 2024-11 の修正が最後）
- `getPaifu.js` はグローバル変数の暗黙宣言が多い（`paifuURLs`, `uuids` など）
