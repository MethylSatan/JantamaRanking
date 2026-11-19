# 017 liqi の定義への追従

状態: todo / 依存: 016

## 目的
Node から雀魂と通信するには、liqi（protobuf）の定義が要る。今は 11/16 に旧クライアント（Laya 版）の経路（`version.json` → `resversion<ver>.json` → `liqi.json`、`0.11.x` 系列）で取った写しを使っている。WebGL 版が送る項目の一部（`requestConnection` の項目6、`oauth2Login` の `device` の中など）はこの定義に無く、手で補っている。雀魂の更新で定義が変わっても、Web サービスの定期取得が止まらないようにする。

## 読むべき資料
- `docs/architecture.md`（雀魂の WebGL 版の通信）
- `docs/tasks/016-client-version-tracking.md`（メモ。静的ファイルの取り方、UnityFS の展開）

## 作業範囲
- WebGL 版の中（`bundle_info_so.majset` が指すデータファイル、`jp-WebGL-release-*.data.gz` など）から定義を得られるかを調べる。まず手元のキャッシュと `local/probe/static-20261119/` を探す
- 旧クライアントの `liqi.json` が今も更新されているか、WebGL 版の通信と食い違いがないかを確かめる
- 定義を Lambda でどう持つかを決める（固定の写しを同梱する、ビルド時に取る、など）。`liqi.json` は雀魂のものなので、公開リポジトリには入れない
- 定義が合わなくなったことに、どう気づくか（デコードの失敗、`err=151` 以外のログインの失敗）を決める

## 完了条件
- 定義の得方・持ち方・壊れたときの気づき方が決まり、`docs/decisions.md` と `docs/architecture.md` に書かれている

## メモ
（未着手。016 で、ユーザーの判断により、決めるのを後に回した）
