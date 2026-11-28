# 027 閲覧者の画面

状態: done / 依存: 025、026（親: 013）

## 目的
閲覧者が URL を開くだけでランキングを見られるようにする。旧スプレッドシートの「自由に並べ替え・絞り込みできる」を引き継ぐ。

## 読むべき資料
- `docs/product.md`（非機能要件「旧方式の利点を引き継ぐ」）
- `docs/architecture.md`「データモデル」（ランキングの JSON）、「集計（Web サービス）」
- `docs/tasks/025-refresh-and-import.md`（ランキングの JSON の形）

## 作業範囲
- 公開 URL は 026 で `/ranking.html?id=<公開 ID>` に決めた（`docs/decisions.md` 2026-11-25 タスク 026）。`web/ranking.html` を Vite の入口に足す（`web/vite.config.ts` の `input`）
- ランキングの JSON を読み、列ごとの並べ替えと、名前・期間・四麻か三麻かでの絞り込み。今月参加済み・今月まだ打っていない人（旧シートの機能を引き継ぐ。`docs/decisions.md` 2026-11-19 タスク 012）
- noindex（`meta` と `robots.txt`）。CSV などでの書き出しは用意しない
- Vite の導入は 026 で済ませたものを使う

## 完了条件
- 閲覧者が URL を開くだけでランキングを見られ、並べ替え・絞り込みができる

## メモ
- 2026-11-25 に 013 から分けた（`docs/decisions.md` 2026-11-25 タスク 013 の分割）
- 2026-11-25 タスク 025 からの申し送り: ランキングの JSON は `rankings/<公開 ID>.json`、形は `{ version: 1, name, generatedAt, games: GameResult[] }`（取り込み済みの対局だけ。`docs/architecture.md`「データモデル」）。集計は画面で `src/ranking` の `aggregate`・`playedThisMonth`・`notPlayedThisMonth` を使う。CloudFront の都合で、更新の反映は最大1秒ほど遅れる。削除（非公開）や公開 ID の取り直しの後は、古い URL が 403 になる
- 2026-11-25 タスク 026 からの申し送り: 画面の土台は `web/`（Vite + Preact。`docs/architecture.md`「管理の画面」）。日時の書式などは `web/src/lib/format.ts` にある。`src/ranking` は画面から import してバンドルできる（依存なし）。手元では `npm run dev` で `http://localhost:5173/ranking.html` を開ける。ランキングの JSON は本番の `/rankings/<公開 ID>.json` にしかないので、proxy に `/rankings` を足すと手元で読める
- 2026-11-25 実装した（`docs/architecture.md`「閲覧の画面」、`docs/decisions.md` 2026-11-25 タスク 027）。`web/ranking.html`・`web/src/ViewerApp.tsx`・`web/src/lib/viewer.ts`（テストは `viewer.test.ts`）。dev の proxy に `/rankings` を足した
- 確認（2026-11-25）: `npm test`・`npm run typecheck`・`npm run build:web`（`dist/web/ranking.html` ができる）。本番に公開中のランキングが無かったので、`npm run dev` の画面を Playwright で開き、`/rankings/*.json` を架空の対局に差し替えて確かめた: 並べ替え（逆順、同じ値は順位の順）、四麻 / 三麻、年・全期間・期間の指定、名前（カタカナでひらがなに合う）、URL を別のページで開いて同じ状態、今月まだの人の1行とコピー、幅 375px で横にはみ出さない、存在しない公開 ID（本番の CloudFront が 403）と `id` 無しで「見つかりません」
- 本番での確認（2026-11-25、デプロイ後）: `ranking.html` は 200 で、`x-robots-tag` と `meta` の noindex が付く。テスト用のランキングを作り、名前の変更で対局0件の JSON を公開して表示を確かめた。次に、026 と同じ雀魂アカウントを指定して候補の更新をし、牌譜が保存済みの1件（四麻）だけを取り込んで（雀魂への要求なし）、実際の対局の表・並べ替え・三麻の空の表示・今月まだの人を確かめた。最後に削除（非公開）にし、JSON が 403 になった
- 雀魂へのログインは2回。apicheck で候補の更新を誤って続けて2回送り、初めての更新は間隔の確認から外れるため両方動いた（タスク 029 に起票）
- 確かめていないこと: ダークモードの見た目
