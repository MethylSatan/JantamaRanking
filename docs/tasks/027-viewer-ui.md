# 027 閲覧者の画面

状態: todo / 依存: 025、026（親: 013）

## 目的
閲覧者が URL を開くだけでランキングを見られるようにする。旧スプレッドシートの「自由に並べ替え・絞り込みできる」を引き継ぐ。

## 読むべき資料
- `docs/product.md`（非機能要件「旧方式の利点を引き継ぐ」）
- `docs/architecture.md`「データモデル」（ランキングの JSON）、「集計（Web サービス）」
- `docs/tasks/025-refresh-and-import.md`（ランキングの JSON の形）

## 作業範囲
- 公開 URL の形を決める（`/r/<公開 ID>` か `?id=<公開 ID>` など。CloudFront の SPA のルーティングに関わる）
- ランキングの JSON を読み、列ごとの並べ替えと、名前・期間・四麻か三麻かでの絞り込み。今月参加済み・今月まだ打っていない人（旧シートの機能を引き継ぐ。`docs/decisions.md` 2026-11-19 タスク 012）
- noindex（`meta` と `robots.txt`）。CSV などでの書き出しは用意しない
- Vite の導入は 026 で済ませたものを使う

## 完了条件
- 閲覧者が URL を開くだけでランキングを見られ、並べ替え・絞り込みができる

## メモ
- 2026-11-25 に 013 から分けた（`docs/decisions.md` 2026-11-25 タスク 013 の分割）
- 2026-11-25 タスク 025 からの申し送り: ランキングの JSON は `rankings/<公開 ID>.json`、形は `{ version: 1, name, generatedAt, games: GameResult[] }`（取り込み済みの対局だけ。`docs/architecture.md`「データモデル」）。集計は画面で `src/ranking` の `aggregate`・`playedThisMonth`・`notPlayedThisMonth` を使う。CloudFront の都合で、更新の反映は最大1秒ほど遅れる。削除（非公開）や公開 ID の取り直しの後は、古い URL が 403 になる

