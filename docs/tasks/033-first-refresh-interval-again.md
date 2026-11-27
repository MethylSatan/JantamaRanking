# 033 初めての候補の更新の間隔を見直す

状態: done / 依存: 023

## 目的
雀魂アカウントの内部 ID がまだ無い（表示用 ID で指定した直後の）候補の更新では、API の間隔の確認が効かず、続けて送るとどれも受け付けられる（`src/api/routes.ts` の `refresh`）。主催者に開放して利用者が増えたときに、雀魂への要求が重ならないようにする。タスク 029 で見送り、タスク 023 から分けた。

## 読むべき資料
- `docs/decisions.md` 2026-11-27（タスク 029、タスク 023）
- `docs/architecture.md`「雀魂への負荷との関係」

## 作業範囲
- 表示用 ID で指定した仮の項目ごとに、受け付けた時刻を持つ（表示用 ID で予約する形）か、ほかの形にするかを決めて直す
- 表示用 ID を残さない決まり（タスク 031）を崩さない

## 完了条件
- 初めての候補の更新を続けて送っても、間隔の中なら2回目が 429 になる（テストで確かめる）

## メモ
- 2026-11-27: 仮の項目（`ACCOUNT#PENDING#<pendingId>`）に `lastRequestedAt` を条件付きで書く `reservePendingRefresh` を足し、`refresh` で内部 ID の無いアカウントに使うようにした（`src/api/store.ts`、`src/api/memory-store.ts`、`src/api/routes.ts`）。テストは `src/api/games.test.ts`「初めての候補の更新（表示用 ID で指定した直後）も…」。理由は `docs/decisions.md` 2026-11-27（タスク 033）
- 内部 ID を引いたあとの `MAJSOUL#` の `lastRequestedAt` には、仮の項目の時刻を写さない（ジョブはふつう5秒より長くかかる）
