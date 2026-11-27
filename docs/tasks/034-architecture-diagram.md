# 034 全体像の図を新しい方式に直す

状態: done / 依存: 004

## 目的
`architecture.png` は旧方式（Tampermonkey → Drive → GAS → スプレッドシート）の図のままで、今の構成（Lambda が雀魂から牌譜を取る Web サービス）と合わない。タスク 004 で README から外したので急がない。

## 読むべき資料
- `docs/architecture.md`（データの流れ、Web サービスの構成）

## 作業範囲
- 今の構成の図を作る（開発者向け。`docs/architecture.md` から参照する）。または図をやめて、`docs/architecture.md` のテキストの図に任せる
- `CLAUDE.md` の文書の地図と `docs/architecture.md` 冒頭の図の説明を合わせる

## 完了条件
- 図（または図の代わりの説明）が今の構成と合っている

## メモ
- 2026-11-27: `docs/architecture.md` の冒頭に「全体像」の節を作り、Web サービスの構成を Mermaid で描いた（利用者・CloudFront・S3・Lambda・DynamoDB・SSM・Cognito・Discord・雀魂）。`architecture.png` は消した（git の履歴に残る）。`CLAUDE.md` の文書の地図も合わせた
- 描画の確認（Mermaid を CDN から読んで Playwright で描く）は自動の許可判定で止められたため、push 後に GitHub の表示で確かめる
