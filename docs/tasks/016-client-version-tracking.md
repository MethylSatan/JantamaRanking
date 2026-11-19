# 016 雀魂のバージョンへの追従

状態: todo / 依存: 011

## 目的
Node から雀魂にログインするときは、雀魂のバージョン（`client_version_string`、`client_version.resource`）を送る。雀魂が更新されると古いバージョンは `err=151` で拒否される（`docs/decisions.md` 2026-11-19 タスク 011）。Web サービス（Lambda）はブラウザを開けないので、ブラウザなしで今のバージョンを得て、定期取得が止まらないようにする。

## 読むべき資料
- `docs/architecture.md`（雀魂の WebGL 版の通信）
- `docs/tasks/011-lambda-majsoul-connectivity.md`（メモ）

## 作業範囲
- 今のバージョンをブラウザなしで得る方法を調べる。第一候補は `version.json`（liqi の定義を取るときの入口。WebGL 版の `0.16.x` と同じ値かは未確認）。他に、ゲームの起動時に読む設定ファイルなど
- 調べるときは、まずブラウザの通信の記録（`local/probe/` のログ、キャッシュ）から探し、サーバーへの試行を増やさない
- バージョンと一緒に liqi の定義も変わりうる。定義の更新をどう追うかもあわせて考える
- 得たバージョンを Lambda でどう使うか（毎回取る、`err=151` のときだけ取り直す、など）を決める

## 完了条件
- 雀魂のバージョンの得方と使い方が決まり、`docs/decisions.md` と `docs/architecture.md` に書かれている

## メモ
- 手元の検証用の暫定: `login-observe.js` がゲームの送ったバージョンを `local/probe/client-version.json` に保存し、`check-cred.js`・`node-direct.js` はそこから読む。`err=151` が出たら `cred-refresh.sh` でブラウザを1回開けば直る
