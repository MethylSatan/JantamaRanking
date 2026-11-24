# 024 API の土台（認証・権限・ランキングの管理）

状態: todo / 依存: 020、022（親: 013）

## 目的
雀魂に要求しない部分の API を作る。ログインした利用者を確かめ、`authorize()` で判断し、ランキングと雀魂アカウントの指定を DynamoDB に持ち、操作ログを残す。025（取り込み）と 026（管理の画面）の土台にする。

## 読むべき資料
- `docs/architecture.md`「データモデル」「API」「権限（タスク 022）」
- `docs/deploy.md`「API と OAC」（`x-auth-token`、`x-amz-content-sha256`）
- `docs/tasks/013-web-ui.md` のメモ（タスク 014・020・021・022 からの申し送り）
- `src/api/handler.ts`

## 作業範囲
- ルーティング（Function URL のイベント、ペイロード形式 2.0）
- `x-auth-token` の Cognito の JWT の検証（JWKS、発行者、`token_use`、期限）。Admin は `cognito:groups` の `admins` で判定
- `authorize(利用者, 操作, ランキング ID)` と、操作の許可の表（`docs/architecture.md` と同じ形）。Host の項目（`RANKING#<ID>` / `MEMBER#<sub>`、逆向きの `USER#<sub>` / `RANKING#<ID>`）を読む道も作る。付いていないランキングは 404
- `GET /api/me`（許可の表を返す）。利用者の情報の項目（`USER#<sub>` / `PROFILE`）をここで書くか決める
- ランキングの作成・一覧・取得・名前の変更・削除（非公開）、雀魂アカウントの指定・外す、操作ログの記録（sub と `via`）と閲覧
- DynamoDB は依存を注入し、`node --test` でテストする

## 完了条件
- 上の API がデプロイされ、Admin の JWT で呼べ、JWT が無い・Admin でない要求は拒まれる
- `authorize()` の表のテストがある

## メモ
- 2026-11-25 に 013 から分けた（`docs/decisions.md` 2026-11-25 タスク 013 の分割）
