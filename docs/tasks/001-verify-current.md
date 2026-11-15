# 001 現状コードの動作確認

状態: done / 依存: なし

## 目的
2024-11 から止まっているコードが、今の雀魂で動くか確認する。壊れていれば、直すべき点を洗い出す。

## 読むべき資料
- `docs/architecture.md`（構成要素、PaifuImporter の詳細）

## 作業範囲
- Node.js の入っているバージョンと、`PaifuImporter` の `npm install` が通るか確認する（`uuid@3` などの古い依存）
- Tampermonkey の2本（L キー / S キー）が今の雀魂の画面で動くか、ユーザーと確認する
- `env.js` の作り方（トークンの取り方）を整理する。`misc/token.js` の使い方を含む
- `getPaifu.js` で牌譜を1件取得できるか試す（ユーザーのトークンが必要。トークンは会話やコミットに残さない）
- 動かない箇所と原因を、このファイルのメモに書く。修正が大きければ別タスクにする

## 完了条件
- 各スクリプトの動作可否が、メモに記録されている
- 直すべき点が、必要なら新しいタスクとして起票されている

## メモ
### 2026-11-15 雀魂側の変化の調査（静的確認）
公開リソースの読み取りだけで確認した結果。
- `version.json` は `0.11.252.w`（liqi.json は `v0.11.243.w`）。`majsoul.js` の取得手順（version.json → resversion → liqi.json / config.json）はそのまま通る
- proto 定義に `fetchGameRecordList`（`start/count/type`）、`fetchGameRecord`（`game_uuid/client_version_string`）、`oauth2Check` / `oauth2Login` / `oauth2Auth`、`heatbeat` は残っている。`ReqOauth2Login` には `gen_access_token` / `version` / `tag` が追加されている
- `code.js` は文字列テーブル方式で難読化されたが、`app` / `uiscript` / `cfg` / `net` / `GameMgr` はトップレベルの `var` 宣言のまま。`sendReq2Lobby`、`record_uuid`、`getClientVersion`、`UI_Replay`、`MessageWrapper` などの名前も残っている
- 結論（暫定・のちに誤りと判明）: Tampermonkey スクリプトが使う API とグローバルは、静的には消えていない、と判断した。実際には `code.js` はもうページで読み込まれていなかった（次の節）

### 2026-11-15 原因: Web 版クライアントが Unity WebGL に置き換わった
- downloadlogs を S キーで動かすと `Uncaught ReferenceError: GameMgr is not defined`。スクリプト自体は動いている（Tampermonkey の設定の問題ではない）
- `https://game.mahjongsoul.com/` の index.html は、`code.js`（Laya の JS クライアント）を読み込まなくなった。代わりに `Build/jp-WebGL-release-4.0.18(19).loader.js` / `.wasm.gz` を読み込む Unity WebGL 版になっている
- そのため `app` / `GameMgr` / `cfg` / `net` などの JS のグローバルがページに存在しない。**ゲーム内部の関数を直接呼ぶ今の Tampermonkey 2本は、この方式のままでは直せない**
- `version.json` / `resversion` / `liqi.json` / `code.js` は今も配信・更新されている（旧クライアント用に残っているだけかは未確認）
- 次に確かめること: WebGL 版の WebSocket 通信が、従来どおり liqi（protobuf）形式か。同じなら、PaifuImporter（Node から直接接続）や、ページの WebSocket を横取りする方式で代替できる見込み

### 2026-11-16 WebGL 版の通信形式（Playwright で確認、ログインなし）
- WebSocket の接続先は `wss://jpgs.mahjongsoul.com/gateway`
- 通信は**従来どおり liqi（protobuf）形式**。先頭バイトが `02`（リクエスト）/ `03`（レスポンス）、続く2バイトが連番、残りが `lq.Wrapper`。全フレームを `liqi.json`（`v0.11.243.w`）でデコードできた
- ログイン前の手順が変わっている。WebGL 版は最初に `.lq.Route.requestConnection`（`type` / `route_id` / `timestamp`）を送り、その後 `.lq.Route.heartbeat` を定期的に送る。`majsoul.js` は `.lq.Lobby.heatbeat` を送っていて、`requestConnection` を送っていない
- 結論: サーバー側のプロトコルは生きている。**PaifuImporter（Node から直接接続）は、接続手順を WebGL 版に合わせれば使える見込み**。Tampermonkey は、ゲーム内部の関数を呼ぶ方式は使えない。ページの WebSocket を横取りする方式なら可能性がある
- 手順メモ: Ubuntu 26.04 は Playwright の対応外。24.04 用のビルド（`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`）を使い、`npx playwright install` の zip 展開が止まるので手動で展開した。apt で `libnss3` / `libnspr4` / `libasound2t64` が必要。`channel: "chromium"` を指定すればヘッドレスでも通常版の Chromium で動く

### 2026-11-16 完了
- Tampermonkey の2本は動かない（原因は WebGL 化）。前提の整理と代替方式の検討は、タスク 005 に移した
- PaifuImporter の認証の確認（`npm install`、`env.js` とトークンの取り方、`getPaifu.js` で1件取得）は、ログイン方法に L2（Node から直接つなぐ）を選んだ場合だけ必要になるので、タスク 006 に移した
