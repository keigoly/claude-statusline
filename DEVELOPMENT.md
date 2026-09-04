# 開発ノート

使い方は [README.md](./README.md) を参照。ここには**なぜその実装になっているか**を残す。

## 構成

| ファイル | 役割 |
| --- | --- |
| `statusline.cjs` | 本体。Claude Code が各描画で **stdin に JSON** を渡して実行し、**標準出力がそのままステータス行**になる。git を 1 回叩く以外は I/O をローカルファイルに限る |
| `usage-fetch.cjs` | 背景フェッチャ。ネットワークへ出るのはこのプロセスだけ。結果をキャッシュへ atomic に書く |

キャッシュは `~/.claude/statusline-usage-cache.json`。

## 設計の前提: 描画はブロックしてはいけない

statusline はアクティブ時に毎秒数回実行される。1 回の描画で数百 ms かかると入力が引っかかるため、
**本体は同期 I/O をローカルファイル読みに限り、ネットワークには一切触れない**。

外部から取る必要のある値は、すべて次の形にそろえてある。

1. 本体はキャッシュを**読むだけ**
2. キャッシュが TTL 超過なら、本体が**detached でフェッチャを spawn**（`.unref()` / `stdio:'ignore'`）
3. フェッチャが書き終えた**次の描画**から新しい値が出る

多重起動はロックファイル（90 秒）で防ぐ。取得に失敗しても既存キャッシュは壊さない。

## 調査で分かった Claude Code 側の仕様

いずれも実バイナリと実機の描画で確認したもの。**公式に保証された挙動ではない**。

### stdin にはモデル別週間枠もプラン種別も載らない

statusline へ渡る `rate_limits` は `five_hour` と `seven_day` の 2 つだけ。本体が HTTP レスポンス
ヘッダーの `anthropic-ratelimit-unified-*` から組み立てているため、出力キーは最大 4 種にしかならず、
モデル別の週間枠は構造上載らない。プラン種別も同様に含まれない。

→ 背景フェッチャが Claude Code 自身の使う usage エンドポイントを叩いて補完する。認証は Keychain の
OAuth トークンを読むだけで、リフレッシュは本体に任せる。**非公開の経路なので本体更新で壊れうる**が、
壊れても fail-open で他の表示は出続ける。

> 当初ここに「期限切れなら次回描画で再取得される」と書いていたが、**これは誤り**だった。
> 本体がリフレッシュするまでフェッチャ側は失敗し続ける。実際に 30 時間止まった（後述）。

### プラン種別は OAuth トークンからは取れない

Keychain の `claudeAiOauth.rateLimitTier` と `~/.claude.json` の `organizationRateLimitTier` は、
どちらも**ログイン時に焼き付く値**で、そのあとのプラン変更には追従しない。2026-09-05 に
Max 5x → 20x へ変更したあと、次の順で確かめた。

| 操作 | Keychain / `~/.claude.json` の値 |
| --- | --- |
| トークンのリフレッシュ（`claude -p` を 1 回走らせると Keychain が書き換わる） | `default_claude_max_5x` のまま |
| `claude auth logout && claude auth login`（再ログイン） | `default_claude_max_20x` に更新される |

つまりリフレッシュでは直らず、**再ログインするまで古い値が残り続ける**。プランを変えたあと
何日もログインし直さないのが普通なので、この 2 つは表示の根拠にできない。

現況を返すのは `GET /api/oauth/profile` の `organization.rate_limit_tier` だけで、リフレッシュ前の
時点で既に `default_claude_max_20x` を返していた。よって**プラン種別は profile から取る**。
`subscription_status` / `has_extra_usage_enabled` / `seat_tier` も同じ応答に入っている。

`readPlanTier()` の 2 番目の候補（`~/.claude.json` の正規表現抽出）は残してあるが、上の理由で
初回描画の穴埋め専用であり、金（確定色）では出さない。

プラン変更は稀なので `PROFILE_TTL_SEC`（既定 1 時間）に 1 回しか叩かない。usage の成功に相乗りする
形で呼ぶので、トークンの状態判定は 1 か所で済む。

### 再描画には上限がある

アイドル時は約 1fps（`refreshInterval` は整数秒のみで小数不可）、アクティブ時も約 3fps
（300ms デバウンス）。Claude Code はスクリプトの出力を 1 枚のスナップショットとして行に貼る方式で、
描画ループへは触れられない。**滑らかなアニメーションは構造的に不可能**。

→ 動かすと必ず「1 秒ずつ」カクつくため、モデル名の装飾は**静的グラデーション**を採用している。

### effort の一部は statusline から区別できない

最上位の effort 指定は、stdin にも環境変数にも通常の最高値と同じ値でしか現れない。

## Anthropic 側の取得スケジュール (2026-09-05)

### 起きたこと

2026-09-04 00:29 に Keychain の access token が期限切れになり、そこから **30 時間**、
`Max 5x`（実際は 20x）と `Fable 16%`（実際は 37%）が貼り付いた。見た目は完全に正常だった。

### なぜ止まり続けたか

3 つが噛み合っていた。

1. **期限切れでも叩きに行っていた。** リフレッシュは本体の仕事なので、こちらは失敗するしかない
2. **`/api/oauth/usage` の 429 は認証より前に返る。** 期限切れトークンでも 401 ではなく
   429（`retry-after` ≒ 3549）が返る。5 分ごとに叩き続けると窓が延び続け、
   **トークンが直っても復帰できない**状態に入る
3. **失敗しても「新鮮なキャッシュ」に見えていた。** bail 経路が OpenRouter / RunPod / Anlas の
   残額だけを書き戻すため、キャッシュファイルの mtime は 5 分ごとに更新される。statusline 側は
   mtime しか見ていないので TTL 判定は通り、また 5 分後にフェッチャを起動する — の無限ループ

### どう直したか

キャッシュに `anthropic` ブロック（`lastSuccessAt` / `lastAttemptAt` / `status` /
`cooldownUntil` / `failures`）を持たせ、Anthropic 側だけ独立にスケジュールする。

| 状態 | 挙動 |
| --- | --- |
| `cooldownUntil` が未来 | ネットワークへ出ない |
| `expiresAt` を過ぎている | **1 回も叩かない**。cooldown も置かない（本体が直した次回で即復帰する） |
| 429 | `cooldownUntil = now + max(retry-after, 60)` |
| 401 / 403 | `cooldownUntil = now + 300` |
| その他・通信断 | 指数バックオフ `60 * 2^(n-1)`、上限 1800 |
| 200 | `failures` を 0 に戻し `lastSuccessAt` を更新 |

期限切れ判定はローカルのファイル読みだけなので、cooldown を置く必要がない。本体がリフレッシュした
次の実行でそのまま 200 を取りに行ける。

### 古さを表示に出す (`STALE_SEC`)

最後の成功から `STALE_SEC`（既定 1800 秒）を過ぎたら、**プラン種別とモデル別週間枠を薄く落とし**、
経過時間を赤で添える。貼り付く種類の失敗（token 期限切れ・認証エラー・レート制限）だけ理由も出す。
一時的な通信断は経過時間だけでよい。

```
󰜦 Max 5x │ 5h 40% │ 7d 30% │ Fable 12% │  30時間前 (token 期限切れ) │ OR $12.3
```

薄く落とすのは「金のプラン種別」と「Fable の sheen」を消すためだ。光ったまま色が付いていると、
どうしても今の値に見える。**主ツリーの運用違反表示と同じ話で、正しい表示と、異常が伝わる表示は別物。**

5h / 7d は stdin 由来で常に今の値なので、ここでは触らない。

キャッシュ未生成の初回描画だけは `~/.claude.json` 由来の暫定プラン種別が出る。あれも追従しない値なので
金では出さず薄く落とす。初回の取得が済めば金に変わる。

## 配色

| 対象 | 色 |
| --- | --- |
| アイコン | オレンジ `#FF6A00`（truecolor）で統一 |
| モデル名 | 主要モデルごとに `sheen(base, shine)` で中央がふわっと光る左右対称の静的グラデ。それ以外は teal 単色 |
| effort | low=白 / medium=青 / high=緑 / xhigh=赤 / max=金 |
| 使用率バー・％ | 0-30%=緑 / 31-60%=黄 / 61-90%=赤 / 91%+=紫（`barColor()`） |
| プラン種別 | 金 |
| 外注先モデル名 | 藤色 `#A78BFA`。**自前モデルの sheen とは意図的に別系統**にして「外部へ出ている」ことを一目で分かるようにしている |
| OpenRouter / RunPod 残額 | `balanceColor()`。**使用率ではなく残額の絶対値**（$15 / $10 / $5）。上限 $50 の 30% 残と $5 の 30% 残では意味が違うため |
| Anlas 残高 | `anlasColor()`。USD ではないので `balanceColor()` とは別のしきい値（500 / 1000 / 2000） |
| 古くなった値 | dim。金や sheen を残すと「今の値」に見えて凍結に気づけない（`STALE_SEC`） |

## 外注経路の読み取り (`readRoute()`)

- ファイル**末尾 64KB だけ**を `openSync` + `readSync` で読む。ログが肥大しても読み込み量は一定
- 先頭行は途中で切れているため捨てる
- `JSON.parse` の前に `indexOf('"openrouter"')` で粗フィルタ。実測 0.110ms/回
- 後方から走査し、**最初に見つかった 1 件**が窓外なら何も出さずに打ち切る（さらに古い行は見ない）
- ファイル名は JST 日付。日跨ぎ直後に取りこぼさないよう前日ファイルも見る（`[0, -1]` の 2 日分）。
  `jstDateStr()` は UTC から固定オフセットで計算するため、**マシンの TZ 設定に依存しない**

## 残額の算出

上限が 2 系統あり、**先に枯れる方**が実際の制約になるため `min` を採る。採用した側の総額を `base` として
一緒に保存し、`100 - remaining / base * 100` を使用率とみなして着色する。どちらが採用されたかは
`source` に残る。

Anthropic 側と OpenRouter 側は**独立に取得**する。片方が落ちても、もう片方が取れていれば
キャッシュへ載せる。これにより片方の障害でもう片方の表示が消えることはない。

## 主ツリーの運用違反表示 (2 行目)

「主ツリーは常に既定ブランチ (main)」「linked worktree は既定ブランチを掴まない」という運用の**違反だけ**を
赤＋警告記号で出す。正常時の見た目は従来どおり (緑のブランチ名)。

- `主ツリー≠main` … 主ツリー (`.git` が実ディレクトリのツリー) が既定ブランチ以外にいる。cmux の全ワークスペース・
  仕事用アカウント・launchd が同じ状態を見ている
- `worktree が main を保持` … linked worktree (`.git` が `gitdir:` を書いたファイル) が既定ブランチにいる。
  主ツリーは既定ブランチへ戻れなくなっている

2026-09-02、主ツリーが 10 日間 feat ブランチのままだったが、ブランチ名を正しく出していただけでは異常が正常に
見えて誰も気づかなかった。**正しい表示と、異常が伝わる表示は別物。**

判定は **git を叩かず fs だけ**で行う (`treeRole()`)。描画は毎秒数回走るので git 起動を増やさない
(実測: 変更前後で差なし)。既定ブランチは `refs/remotes/origin/HEAD` → `main` → `master` の順
(packed-refs も見る)。判定できなければ従来表示 (fail-open)。

同時に `C.red` を定義した。以前から `NAI 停止`（現 `Anlas 契約切れ`）が `C.red` を参照していたが未定義で、
`undefined` の文字列がそのまま出ていた。

## 変更手順

1. **見える化**: 変更前にモック描画で現状を把握する。色は `sed 's/\x1b\[[0-9;]*m//g'` で除去すると構造だけ確認できる
2. **最小改修**: 該当の定義・関数のみ変更する。関係ない箇所は触らない
3. **整合性確認**: 実端末で表示を確認する。異常系（キャッシュ不在・ディレクトリ不在・旧形式キャッシュ）も必ず通す

## テスト

```sh
# 基本
echo '{"model":{"display_name":"Opus 5"},"effort":{"level":"xhigh"},"workspace":{"current_dir":"/tmp/demo","repo":{"name":"demo"}},"context_window":{"used_percentage":75},"rate_limits":{"five_hour":{"used_percentage":40,"resets_at":0}},"pr":{"number":42}}' | node statusline.cjs

# プラン種別・週間枠・残額まで出す（要 Keychain ログイン + OPENROUTER_API_KEY）
node usage-fetch.cjs && cat ~/.claude/statusline-usage-cache.json

# 外注経路の矢印
D=$(mktemp -d)
python3 -c "import json,datetime;ts=datetime.datetime.now(datetime.timezone.utc).isoformat();\
print(json.dumps({'timestamp':ts,'payload':{'backend':'openrouter','model':'z-ai/glm-5.2','provider':'Novita'}}))" \
  > "$D/events_$(date +%F).jsonl"
echo '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"/tmp/demo"},"context_window":{"used_percentage":38}}' \
  | STATUSLINE_EVENTS_DIR="$D" node statusline.cjs
```

必ず通すパターン: ①外注なし ②窓内に外注あり ③別モデルへの外注 ④窓外（矢印が消える）
⑤除外対象の事業者のみ（矢印が出ない）⑥イベントディレクトリ不在 ⑦`openrouter` を含まない旧キャッシュ。

古さ表示は、キャッシュを退避してから `anthropic.lastSuccessAt` を巻き戻して確認する。

```sh
C=~/.claude/statusline-usage-cache.json; cp "$C" /tmp/cache.bak
IN='{"workspace":{"current_dir":"/tmp"},"rate_limits":{"five_hour":{"used_percentage":59,"resets_at":0}}}'
back() { python3 -c "
import json,os,sys,time
p=os.path.expanduser('~/.claude/statusline-usage-cache.json'); j=json.load(open(p))
now=int(time.time())
j['anthropic']={'lastSuccessAt':now-int(sys.argv[1]),'lastAttemptAt':now,'status':sys.argv[2],'cooldownUntil':None,'failures':0}
json.dump(j,open(p,'w'))" "$1" "$2"; echo "$IN" | node statusline.cjs | sed 's/\x1b\[[0-9;]*m//g' | sed -n 4p; }
back 108000 token_expired   # 30時間前 (token 期限切れ)
back 2700   http_429        # 45分前 (レート制限)
back 10800  network         # 3時間前（理由は出さない）
back 1740   ok              # しきい値直下 → 何も出ない
cp /tmp/cache.bak "$C"
```

必ず通すパターン: ①正常 ②期限切れ（1 回も叩かない）③トークン無し ④クールダウン中
⑤429 の `retry-after` 尊重 ⑥連続失敗の指数バックオフと上限 ⑦復旧で `failures` が 0 に戻る
⑧`anthropic` キーを持たない旧キャッシュ ⑨キャッシュ不在。

主ツリーの運用違反表示は、一時リポジトリで次を通す (色は `sed 's/\x1b\[[0-9;]*m//g'` で除去して構造を見る):

```sh
D=$(mktemp -d); git init -q -b main "$D" && git -C "$D" commit -q --allow-empty -m init
git -C "$D" branch feat/x && git -C "$D" worktree add -q "$D-feat" feat/x
r() { printf '{"workspace":{"current_dir":"%s","repo":{"name":"t"}}}' "$1" | node statusline.cjs | sed -n 2p; }
r "$D"                                   # ① 主ツリー main → 緑
git -C "$D" switch -q feat/x 2>/dev/null || { git -C "$D" branch feat/y; git -C "$D" switch -q feat/y; }
r "$D"                                   # ② 主ツリー feat → 赤「主ツリー≠main」
r "$D-feat"                              # ③ worktree feat → 緑
git -C "$D" worktree add -q "$D-main" main
r "$D-main"                              # ④ worktree が main → 赤「worktree が main を保持」
r "$D/sub" 2>/dev/null; r /tmp           # ⑤ サブディレクトリでも判定 / git 外は行ごと消える
```

## 関連

- stdin スキーマ: https://code.claude.com/docs/en/statusline
