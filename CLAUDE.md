# claude-statusline — AI(Claude Code など)への指示

- Claude Code の多段ステータスライン。本体 `statusline.cjs` は描画のたびに stdin の JSON を受けて 1 回走り、ネットワークへ出るのは背景フェッチャ `usage-fetch.cjs` だけ。依存パッケージは無い。
- 使い方は `README.md`、なぜその実装なのか・変更手順・テストは `DEVELOPMENT.md`。変更の前に読む。
- 手元だけの指示があれば `CLAUDE.local.md`(git に入れない)も読む。

## 守ること

- 描画をブロックしない。`statusline.cjs` はネットワークに触れず、git を 1 回叩く以外の I/O はローカルファイルの読み取りに限る。外から取る値は `usage-fetch.cjs` の背景取得とキャッシュを通す。
- キャッシュ `~/.claude/statusline-usage-cache.json` は、他のツールからも読まれる前提で扱う。既存の項目の名前と意味は変えず、足すだけにする。
- 認証情報・トークン・個人の設定を git に入れない。
