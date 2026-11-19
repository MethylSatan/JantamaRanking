# タスク一覧

セッション開始時はここで担当タスクを確認し、そのタスクファイルを開く。
状態: `todo`（未着手） / `doing`（作業中） / `done`（完了）

| # | タスク | 依存 | 状態 |
|---|---|---|---|
| [001](001-verify-current.md) | 現状コードの動作確認 | - | done |
| [002](002-gas-alternative.md) | GAS 依存をやめる方式の検討（008 で決着） | 001 | done |
| [003](003-import-gas-script.md) | GAS スクリプトとシートのサンプルをリポジトリに取り込む | - | done |
| [004](004-readme-setup.md) | README の導入方法を書く | 013 | todo |
| [005](005-paifu-collection-method.md) | 牌譜の回収方式の検討 | 001 | done |
| [006](006-collect-by-operator-account.md) | 運営アカウントでの牌譜回収ツールの実装 | 005、007、011、016 | todo |
| [007](007-l2-login-investigation.md) | Node から直接ログインする方法（L2）の調査 | 005 | done |
| [008](008-web-service-design.md) | セルフサービスの Web サービスの構成検討 | 007 | done |
| [009](009-credential-lifetime.md) | 運営アカウントの認証情報の有効期間と取り直し方 | 007 | doing |
| [010](010-aws-infra.md) | AWS 基盤（Terraform とデプロイ） | 008、011 | todo |
| [011](011-lambda-majsoul-connectivity.md) | Lambda から雀魂に接続できるかの確認 | 007、008 | done |
| [012](012-ranking-rules.md) | 集計ルールの移植 | 003 | done |
| [013](013-web-ui.md) | Web サービスの画面と API | 006、010、012 | todo |
| [014](014-x-login.md) | X ログインの調査（主催者への開放） | 013 | todo |
| [015](015-legacy-data-migration.md) | 旧方式の牌譜（Drive）の移行 | 012、013 | todo |
| [016](016-client-version-tracking.md) | 雀魂のバージョンへの追従 | 011 | done |
| [017](017-liqi-definition-tracking.md) | liqi の定義への追従 | 016 | todo |

## 新しいタスクの作り方
- ファイル名は `NNN-短い名前.md`（連番）。この表にも行を足す
- 形式は他のタスクファイルと揃える: 目的 / 読むべき資料 / 作業範囲 / 完了条件 / メモ
- 「読むべき資料」には、そのタスクに必要な文書だけを挙げる
