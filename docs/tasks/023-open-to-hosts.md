# 023 主催者への開放（申請と承認、Host の付け外し、利用者の削除）

状態: done / 依存: 013、022

## 目的
主催者（Host）に開放するときに、Host が画面で自分のランキングを操作でき、Admin が画面で Host を付け外しできるようにする。利用者が増える見込みは高くないので、開放すると決めたときに着手する（2026-11-25 ユーザーの判断）。

## 読むべき資料
- `docs/architecture.md`「権限」
- `docs/decisions.md` 2026-11-25（タスク 022、タスク 021）
- `docs/local/008-terms-notes.md`（ローカル限定。雀魂の規約面の暫定の判断）
- `docs/local/014-login-notes.md`（ローカル限定。Discord の規約の要点）

## 作業範囲
- 画面: ランキングの Host の一覧と付け外し（Admin だけ）
- 画面: Host には、自分が付いているランキングだけを出し、許されない操作のボタンを出さない。手伝いの人を「共同ホスト」などと出し分けるか
- 利用者の許可の一覧（いまは SSM を CLI で変えている）を、Admin の画面から変えられるようにするか決める。するなら置き場所（SSM のままか DynamoDB か）と pre sign-up のトリガーの変更
- 利用者をやめるときの削除（許可の一覧、Host の項目、利用者の情報、Cognito の利用者）を1つの操作にする
- 開放して雀魂への要求が増えるときの上限（1つのランキングに指定できる雀魂アカウントの数を含む）と、雀魂の規約面の判断のやり直し（`docs/local/008-terms-notes.md`。タスク 021 から移した）
- 初めての候補の更新（雀魂アカウントの内部 ID がまだ無い）では、API の間隔の確認が効かず、続けて送るとどれも受け付けられる（`src/api/routes.ts` の `refresh`。タスク 029 で見送った）。上限とあわせて見直す。表示用 ID で予約する形が候補

## 完了条件
- Admin が画面で Host をランキングに付け外しでき、Host が画面で自分のランキングを操作できる
- ある Host が、付いていないランキングを見たり操作したりできないことを、テストで確かめている

## メモ
- タスク 024 からの申し送り: 利用者の情報（`USER#<sub>` / `PROFILE`。Discord の ID・表示名）はまだ書いていない。アクセストークンには Discord の ID・名前が無いので、書くなら ID トークンを API に送ってもらうか、Cognito の `AdminGetUser` で引く（`docs/decisions.md` 2026-11-25 タスク 024）。Host の付け外しの API も無い（Host の項目を読む道は `src/api/authorize.ts` にある）
- 2026-11-27 の作業（決定は `docs/decisions.md` 2026-11-27 タスク 023）
  - 雀魂の規約の本文を Playwright で読み、判断をやり直した（`docs/local/008-terms-notes.md`）。グレーと理解したうえで進める（ユーザーの判断）
  - 登録は「誰でもログイン → 本人が申請 → Admin が承認」。SSM の許可の一覧はやめ、pre sign-up は人数（50人）だけを見る
  - API: `PUT /api/me/profile`・`DELETE /api/me`・`GET /api/users`・`POST /api/users/{sub}/approve`・`DELETE /api/users/{sub}`・`GET|PUT|DELETE /api/rankings/{id}/hosts[/{sub}]`。Cognito は `src/api/directory.ts`（本番は `src/api/aws.ts` の `CognitoDirectory`）
  - 画面: 申請（`web/src/Apply.tsx`）、利用者（`web/src/UserList.tsx`、`#/users`）、ランキングの設定の「主催者」の欄、一覧の雀魂アカウント32件以上の印
  - テスト: `src/api/users.test.ts`（付いていないランキングのすべての経路で 404 を含む）
  - 初めての候補の更新の間隔は、タスク 033 に分けた
- 本番の確認（2026-11-27）: `terraform apply`（API と pre sign-up の権限、pre sign-up の差し替え）の後にデプロイ（テスト123件が成功）。`apicheck smoke` が通り、`GET /api/users`（Cognito からの一覧）、テスト用のランキングで `GET /api/rankings/{id}/hosts` と、承認していない人を付けると 400 になることを確かめた（ランキングは削除＝非公開にした）。管理の画面を Playwright で開き、利用者の画面と設定の「主催者」の欄が出ることを見た
- 本番で確かめていないこと: 2つめの Discord アカウントでの申請 → 承認 → 主催者に付ける → 主催者の画面 → 削除の一連（テストでは確かめた）。主催者を初めて迎えるときに通す
- 残り: SSM の `/jantama-ranking/allowed-discord-ids`（どこからも読まれない。管理人の ID が1件）を消す。セッションの中では削除が許可されなかったので、ユーザーが `aws ssm delete-parameter --name /jantama-ranking/allowed-discord-ids` で消す
