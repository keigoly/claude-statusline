#!/usr/bin/env node
/**
 * Claude Code ステータスライン — 多段表示
 *   1) [folder] カレントフォルダ（~ 省略）
 *   2) [repo] リポジトリ名 │ [branch] ブランチ [→ 作業中の worktree のブランチ]
 *        主ツリーが既定ブランチ(main)以外 / linked worktree が既定ブランチを保持 なら赤＋警告記号
 *   3) [ctx] コンテキスト使用量バー │ [model] モデル/工数(effort) [→ OpenRouter 外注先 · 配信事業者]
 *   4) [rate] プラン種別 │ 5h 使用率 ([reset] リセット) │ 7d 使用率 ([reset] リセット) │
 *        モデル別週間枠 [[stale] 経過時間] │ OR/RP/Anlas 残額   ← Pro/Max のみ・初回応答後に出現
 *        プラン種別とモデル別週間枠は背景取得。古い間は薄く落として経過時間を赤で添える
 *   5) [pr] PR #番号
 *
 * stdin: Claude Code が渡す JSON（https://code.claude.com/docs/en/statusline 準拠）。
 *   model.display_name … 現在セッションのモデル
 *   effort.level        … 現在の reasoning effort（low/medium/high/xhigh/max）。/effort 変更も反映。
 *
 * 配色:
 *   - アイコン … オレンジ（#FF6A00, truecolor）で統一
 *   - モデル名 … Fable 5 のみレインボー（ultrathink 風、1文字ずつ7色循環）/ それ以外は teal 単色
 *   - 工数      … low=白 / medium=青 / high=緑 / xhigh=赤 / max=金
 *   - 使用率バー/％ … 0-30%=緑 / 31-60%=黄 / 61-90%=赤 / 91%+=紫
 *
 * 要 Nerd Font（端末側のフォント設定で指定する）。
 * `STATUSLINE_ICONS=emoji` で絵文字にフォールバック。例外時も最低1行返す。ネットワーク無し。
 * git は通常 1 回。`~/.claude/statusline-worktree/<session_id>.json` がある場合のみ
 * 作業中 worktree の確認で最大 3 回増える（実測 1 回あたり約 0.17 秒・全体で変化なし）。
 */
'use strict';
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- アイコンセット（Nerd Font / 絵文字 切替）----
const ICON_SET = (process.env.STATUSLINE_ICONS || 'nerd').toLowerCase();
const ICONS = {
  nerd: {
    folder: '\u{F07B}',  //
    repo:   '\u{F1B2}',  //  (cube)
    branch: '\u{E725}',  //  (git branch)
    ctx:    '\u{F080}',  //  (bar chart)
    model:  '\u{F0E7}',  //  (bolt)
    rate:   '\u{F0726}', // 󰜦 (treasure chest)
    pr:     '\u{E726}',  //  (git pull request)
    reset:  '\u{F021}',  //  (refresh / reset)
    route:  '\u{2192}',  // → (外注経路の矢印。U+2192 は等幅フォントに必ずある字形を選ぶ)
    inflight: '\u{22EF}', // ⋯ (生成中。route と同じく等幅で必ず出る字形に限る)
    warn:   '\u{F071}',  //  (warning triangle。運用違反の印)
    stale:  '\u{F017}',  //  (clock。背景取得が止まって値が古い印)
  },
  emoji: {
    folder: '📁', repo: '🐙', branch: '🌿', ctx: '🧠', model: '💪', rate: '💰', pr: 'PR', reset: '🔄',
    route: '→', inflight: '⋯', warn: '⚠', stale: '🕒',
  },
};
const I = ICONS[ICON_SET] || ICONS.nerd;

// ---- ANSI ----
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  blue: '\x1b[38;5;75m',          // パス・リポジトリ名
  green: '\x1b[38;5;78m',         // ブランチ・低使用率・レート%
  teal: '\x1b[38;5;43m',          // モデル
  yellow: '\x1b[38;5;221m',       // PR番号
  gray: '\x1b[38;5;245m',         // 区切り・リセット時刻・モデル/工数区切り
  orange: '\x1b[38;2;255;106;0m', // アイコン色（#FF6A00）
  gold: '\x1b[38;5;220m',         // プラン種別（Max 20x 等）
  route: '\x1b[38;2;167;139;250m',// 外注先モデル名（外部＝自前のモデル配色と混ざらない藤色）
  red: '\x1b[38;5;196m',          // 警告（主ツリーの運用違反・Anlas 契約切れ・背景取得の停止）
};
const paint = (s, c) => `${c}${s}${C.reset}`;
const SEP = ` ${C.gray}│${C.reset} `;
// アイコンはオレンジで統一
const ic = (g) => `${C.orange}${g}${C.reset}`;

// 工数(effort)ごとの色: low=白 / medium=青 / high=緑 / xhigh=赤 / max=金
const EFFORT_COLOR = {
  low:    '\x1b[38;5;231m', // 白
  medium: '\x1b[38;5;39m',  // 青
  high:   '\x1b[38;5;46m',  // 緑
  xhigh:  '\x1b[38;5;196m', // 赤
  max:    '\x1b[38;5;220m', // 金
};

// モデル別スタイル（ドラゴンボール超モチーフ・静的メタリックグラデ）:
//   Fable5 = 身勝手の極意（透き通るクールシルバー）/ Opus = スーパーサイヤ人ブルー（鮮やかメタリックブルー）
// いずれも中央がふわっと光る左右対称の sheen。穏やか＝動きなし・静的
// （statusline は最速でもアイドル1fpsで、動かすと必ず「1秒ずつ」カクつくため）。
const isFable  = (name) => /fable/i.test(name);
const isOpus   = (name) => /opus/i.test(name);
const isSonnet = (name) => /sonnet/i.test(name);
const FABLE_STYLE  = { base: [204, 213, 219], shine: [227, 236, 244] }; // 身勝手の極意: クールシルバー
const OPUS_STYLE   = { base: [30, 130, 240],  shine: [150, 225, 255] }; // 神ブルー: 鮮やかメタリックブルー
const SONNET_STYLE = { base: [226, 34, 96],   shine: [255, 102, 170] }; // 超サイヤ人ゴッド: マゼンタ寄りの鮮やか赤
function sheen(s, base, shine) {
  const vis = [...s].filter((c) => c !== ' ').length;    // 可視文字数
  let out = '', i = 0;
  for (const ch of s) {
    if (ch === ' ') { out += ch; continue; }
    const p = vis > 1 ? i / (vis - 1) : 0.5;             // 左0→右1
    const k = Math.sin(Math.PI * p);                     // 0(縁)→1(中央): 中央がふわっと光る
    const mix = (a, b) => Math.round(a + (b - a) * k);
    out += `\x1b[38;2;${mix(base[0], shine[0])};${mix(base[1], shine[1])};${mix(base[2], shine[2])}m${ch}`;
    i++;
  }
  return out + C.reset;
}

// 使用率バー/％の色: 0-30%=緑(現状) / 31-60%=黄 / 61-90%=赤 / 91%+=紫
function barColor(p) {
  return p >= 91 ? '\x1b[38;5;129m' // 紫
       : p >= 61 ? '\x1b[38;5;196m' // 赤
       : p >= 31 ? '\x1b[38;5;226m' // 黄
       :           C.green;          // 緑（現状の緑）
}

// 残額（USD）の色: >$15=緑 / $15以下=黄 / $10以下=赤 / $5以下=紫
//
// 使用率（barColor）とは別規則にしている。残額は「上限に対する割合」ではなく
// 「あと何ドル使えるか」で危険度が決まるため（上限 $50 の 30% 残と $5 の 30% 残では
// 意味が違う）。OpenRouter / RunPod の両方でこの絶対額のしきい値にそろえる。
function balanceColor(v) {
  return v <= 5  ? '\x1b[38;5;129m' // 紫
       : v <= 10 ? '\x1b[38;5;196m' // 赤
       : v <= 15 ? '\x1b[38;5;226m' // 黄
       :           C.green;
}

// Anlas 残高の色。**USD の balanceColor とは別規則。**
// Opus の月間付与が 10,000 で、Character Reference 付き生成が 1 枚 5、
// 1216x1856 まで上げると 49。つまり 1,000 を切ると本番構図で 20 枚しか引けない。
// そこを赤、月の 1/5 を割ったところを黄にしてある。
function anlasColor(v) {
  return v < 500   ? '\x1b[38;5;129m' // 紫（ほぼ枯渇）
       : v < 1000  ? '\x1b[38;5;196m' // 赤
       : v < 2000  ? '\x1b[38;5;226m' // 黄
       :             C.green;
}

// ---- Anthropic 由来の値の「古さ」----
//
// プラン種別とモデル別週間枠（Fable 等）だけは背景フェッチャ経由で、stdin には載らない。
// つまり取得が壊れると **前回の値がそのまま出続ける**。2026-09-05、Keychain の access token が
// 期限切れになったあと 30 時間ぶん `Max 5x` と `Fable 16%` が貼り付いたまま、見た目は正常だった。
// 主ツリーの表示で学んだのと同じ話で、**正しい表示と、異常が伝わる表示は別物**。
// 古い間は値を薄く落とし、経過時間と理由を添える。
const STALE_SEC = Number(process.env.STATUSLINE_STALE_SEC) || 1800;
// 貼り付く（放っておいても直らない）失敗だけ理由を出す。一時的な通信断は経過時間だけでよい。
const STALE_REASON = {
  token_expired: 'token 期限切れ',
  no_token: 'token 無し',
  http_401: '認証エラー',
  http_403: '認証エラー',
  http_429: 'レート制限',
  schema: '応答形式の変化',
};

// 最後に Anthropic の取得が成功してからの経過秒。旧形式キャッシュ（anthropic 無し）は
// fetchedAt が成功時のみ更新される値なのでそのまま使える。判定材料が無ければ null。
function anthropicAge(cache) {
  const t = (cache && cache.anthropic && cache.anthropic.lastSuccessAt) || (cache && cache.fetchedAt);
  return t ? Math.max(0, Math.floor(Date.now() / 1000) - t) : null;
}

// 経過秒 → "45分" / "30時間" / "3日"（statusline は横幅が命なので 1 単位だけ出す）。
// 日へ丸めるのは 2 日から。30 時間を「1日前」と出すと実際より軽く見える。
function fmtAge(sec) {
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 172800) return `${Math.floor(sec / 3600)}時間`;
  return `${Math.floor(sec / 86400)}日`;
}

function abbrevHome(p, home) {
  if (home && p && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}

// ブランチは JSON に無いので git を 1 回だけ叩く（HEAD 参照のみで高速）
function gitBranch(cwd) {
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 800 };
  try { return execSync('git symbolic-ref --quiet --short HEAD', opts).trim(); } catch (_) {}
  try { return execSync('git rev-parse --short HEAD', opts).trim(); } catch (_) { return ''; }
}

// ---- 主ツリーの運用違反（git を叩かず fs だけで判定）----
// 「主ツリーは常に既定ブランチ(main)」「linked worktree は既定ブランチを掴まない」という運用の
// **違反だけ** を赤く出す。2026-09-02、主ツリーが 10 日間 feat ブランチのままだったが、
// ブランチ名を正しく表示していただけでは異常が正常に見え、誰も気づかなかった。
//
// 判定は `.git` の実体で行う。主ツリーは `.git` が **ディレクトリ**、linked worktree は
// `gitdir: <common>/worktrees/<name>` を書いた **ファイル**。既定ブランチは
// `refs/remotes/origin/HEAD` → main → master の順で決める（packed-refs も見る）。
// 全て fs 読みなので、描画ごとの git 起動回数は増えない。判定できなければ従来表示（fail-open）。
function findGitEntry(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    const g = path.join(d, '.git');
    try {
      const st = fs.statSync(g);
      return { top: d, entry: g, isDir: st.isDirectory() };
    } catch (_) {}
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}
function protectedBranchOf(commonDir) {
  try {
    const head = fs.readFileSync(path.join(commonDir, 'refs', 'remotes', 'origin', 'HEAD'), 'utf8').trim();
    const m = /^ref: refs\/remotes\/origin\/(.+)$/.exec(head);
    if (m) return m[1];
  } catch (_) {}
  let packed = '';
  try { packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8'); } catch (_) {}
  for (const b of ['main', 'master']) {
    if (fs.existsSync(path.join(commonDir, 'refs', 'heads', b))) return b;
    if (new RegExp(` refs/heads/${b}(\\n|$)`).test(packed)) return b;
  }
  return '';
}
// cwd が属するツリーの役割。{ kind: 'primary' | 'linked' | '', protected: 既定ブランチ名 }
function treeRole(cwd) {
  try {
    const g = findGitEntry(cwd);
    if (!g) return { kind: '', protected: '' };
    if (g.isDir) return { kind: 'primary', protected: protectedBranchOf(g.entry) };
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g.entry, 'utf8'));
    if (!m) return { kind: '', protected: '' };
    const gitDir = path.resolve(g.top, m[1].trim());
    // <common>/worktrees/<name> の形だけを linked worktree と見なす（submodule の modules/ は対象外）
    if (path.basename(path.dirname(gitDir)) !== 'worktrees') return { kind: '', protected: '' };
    return { kind: 'linked', protected: protectedBranchOf(path.dirname(path.dirname(gitDir))) };
  } catch (_) { return { kind: '', protected: '' }; }
}

// ---- 作業中の git worktree ----
// **cwd のブランチが実態とは限らない。** ブランチ作業を専用 worktree で行う運用だと、
// エージェントのセッションは cwd をベースツリー（main）に置いたまま、実際の編集は
// 別ディレクトリで進む。cwd しか見ないと「ブランチを切り替え忘れている」ように見える。
//
// 置き換えではなく併記する。cwd が main であること自体は事実なので、これを消すと
// 別の嘘になる。`main → feat/xxx` と出せばどちらも正しく読める。
//
// マーカーはセッション単位（`~/.claude/statusline-worktree/<session_id>.json`）。
// 同じベースツリーを複数セッションが共有するため、リポジトリ単位だと他人の
// worktree を指す。書き手は worktree 作成スクリプト側。
//
// **1 セッションが複数リポジトリを触る**ので、中身はリポジトリごとの表にする。
// キーは git-common-dir（worktree 間で共有され、ベースツリーと worktree で同じ値）。
//   {"worktrees": {"<git-common-dir>": "<worktree の絶対パス>"}}
// キー自体がリポジトリの同一性なので、引けた時点で別リポジトリの混入は無い。
//
// 無い/壊れている/パスが消えた場合は、黙って従来表示に戻す（fail-open）。
// **古いマーカーで嘘を出さないことを、表示することより優先する。**
function gitCommonDir(dir) {
  try {
    const out = execSync('git rev-parse --git-common-dir', {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 800,
    }).trim();
    return out ? fs.realpathSync(path.resolve(dir, out)) : '';
  } catch (_) { return ''; }
}

// このセッションが cwd のリポジトリで作業している worktree の絶対パス（無ければ ''）
function activeWorktreePath(cwd, sessionId) {
  if (!sessionId) return '';
  try {
    const f = path.join(os.homedir(), '.claude', 'statusline-worktree', `${sessionId}.json`);
    const m = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    const key = gitCommonDir(cwd);
    if (!key) return '';
    const wt = (m.worktrees || {})[key];
    return wt && fs.existsSync(wt) ? wt : '';
  } catch (_) { return ''; }
}

function bar(pct, width = 10) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round((p / 100) * width);
  return paint('█'.repeat(filled), barColor(p)) + paint('░'.repeat(width - filled), C.gray);
}

// epoch 秒 → ローカル時刻 "4am" / "10:30pm"
function fmtTime(epoch) {
  const d = new Date(epoch * 1000);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? 'am' : 'pm';
  h = h % 12; if (h === 0) h = 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}
// epoch 秒 → "3/13 10am"
function fmtDateTime(epoch) {
  const d = new Date(epoch * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(epoch)}`;
}

// ---- プラン使用制限（Max 20x 等）＆ 週間モデル別制限（Fable 等）----
// これらは Claude Code が statusline へ渡す JSON には含まれない（rate_limits は five_hour/seven_day のみ）。
// プラン種別 … 背景フェッチャが GET /api/oauth/profile の organization.rate_limit_tier を書いたキャッシュ。
//   Keychain の OAuth トークンにも rateLimitTier があるが、**プラン変更に追従しない**ため使わない
//   （2026-09-05 実測: Max 20x へ変更後にトークンをリフレッシュしても 5x のまま。~/.claude.json も同じ）。
// モデル別週間制限 … 同じフェッチャが GET /api/oauth/usage の結果を書いたキャッシュから読む。
const USAGE_CACHE = path.join(os.homedir(), '.claude', 'statusline-usage-cache.json');

// "default_claude_max_20x" → "Max 20x" 等
function labelTier(t) {
  if (!t) return null;
  const mx = /max[_-]?(\d+)x/i.exec(t);
  if (mx) return `Max ${mx[1]}x`;
  if (/team/i.test(t)) return 'Team';
  if (/max/i.test(t)) return 'Max';
  if (/pro/i.test(t)) return 'Pro';
  if (/free/i.test(t)) return 'Free';
  return t;
}

function readPlanTier(cache) {
  // 1) キャッシュ（フェッチャが profile から書いた値）を優先 → ~/.claude.json の巨大 read を避ける
  if (cache && cache.tier) return labelTier(cache.tier);
  // 2) キャッシュ未生成時のみ ~/.claude.json を正規表現で軽量抽出（全体 JSON.parse はしない）。
  //    ここは Claude Code が写した値なので古いことがある。初回描画の穴埋め専用。
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    const m = /"userRateLimitTier"\s*:\s*"([^"]+)"/.exec(raw)
           || /"organizationRateLimitTier"\s*:\s*"([^"]+)"/.exec(raw);
    return m ? labelTier(m[1]) : null;
  } catch (_) { return null; }
}

function readUsageCache() {
  try { return JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8')); } catch (_) { return null; }
}

// キャッシュが TTL 超過なら背景フェッチャを detached spawn（描画はブロックしない）。
// ロックで多重起動を防ぐ（statusline はアクティブ時 ~3fps で走るため）。失敗は握りつぶす。
function maybeRefreshUsage() {
  const lock = USAGE_CACHE + '.lock';
  const TTL = (Number(process.env.STATUSLINE_USAGE_TTL_SEC) || 300) * 1000;
  const LOCK_TTL = 90 * 1000;
  const now = Date.now();
  let cacheAge = Infinity, lockAge = Infinity;
  try { cacheAge = now - fs.statSync(USAGE_CACHE).mtimeMs; } catch (_) {}
  try { lockAge = now - fs.statSync(lock).mtimeMs; } catch (_) {}
  if (cacheAge <= TTL) return;      // 十分に新しい
  if (lockAge <= LOCK_TTL) return;  // 取得が進行中（とみなす）
  // 排他は 'wx'（存在したら失敗）で取る。writeFileSync だと statSync との間に隙間があり、
  // 同じリポジトリを複数のウィンドウが毎秒 3 回描画する環境では、同じ tick で
  // 全員が「ロック無し」と判定して一斉に spawn する。
  try { fs.closeSync(fs.openSync(lock, 'wx')); }
  catch (_) {
    if (lockAge === Infinity) return;              // 作れず、かつ存在もしない → 書けない場所
    try { fs.writeFileSync(lock, String(now)); }   // 90 秒超えの残骸は奪ってよい
    catch (__) { return; }
  }
  try {
    const { spawn } = require('node:child_process');
    const fetcher = path.join(path.dirname(fs.realpathSync(__filename)), 'usage-fetch.cjs');
    const p = spawn(process.execPath, [fetcher], { detached: true, stdio: 'ignore' });
    // error は次の tick で飛ぶので try/catch では捕まらない。付けないと
    // 「stdout は出したあとに exit 1 で落ちる」という一番たちの悪い壊れ方をする。
    p.on('error', () => {});
    p.unref();
  } catch (_) {}
}

// ---- OpenRouter 外注経路（イベントログから直読み）----
// LLM ゲートウェイ側が 1 呼び出しごとに JSONL へ 1 行追記している前提で、その末尾だけを読み
// 「直近に外注した先」を出す。ネットワークもプロセス起動も使わない。
//
// 期待する 1 行の形（余分なキーは無視される）:
//   {"timestamp":"<ISO8601>","payload":{"backend":"openrouter",
//     "model":"<provider/slug>","provider":"<配信事業者名>"}}
// ファイル名は JST 日付で `events_YYYY-MM-DD.jsonl`。
//
// STATUSLINE_EVENTS_DIR が未設定なら機能ごと無効（矢印は出ない）。既定パスは持たない。
const EVENTS_DIR = process.env.STATUSLINE_EVENTS_DIR || null;
const ROUTE_WINDOW_SEC = Number(process.env.STATUSLINE_ROUTE_WINDOW_SEC) || 900; // 既定 15 分
// 完了前（in_flight）の行は別の窓で切る。生成が落ちて完了行が書かれないまま
// 終わった場合、15 分も「生成中」を出し続けると嘘になるため短くする。
// 画像生成の実測は 1 枚 30-60 秒なので 180 秒あれば正常系は覆える。
const ROUTE_INFLIGHT_WINDOW_SEC = Number(process.env.STATUSLINE_ROUTE_INFLIGHT_WINDOW_SEC) || 180;
const ROUTE_TAIL_BYTES = 64 * 1024; // 1 日 30KB 前後を想定。末尾だけ読めば足りる
// テスト用の偽サーバ名を除外する（カンマ区切り）。既定は "FakeProv"。
// ゲートウェイの回帰テストが本番ログへ書き込む構成だと、これが無いとテストのたびに誤表示される。
const ROUTE_IGNORE = new Set(
  (process.env.STATUSLINE_ROUTE_IGNORE_PROVIDERS || 'FakeProv').split(',').map((s) => s.trim()).filter(Boolean)
);

// JST 基準の YYYY-MM-DD（マシンの TZ 設定に依存させない）
function jstDateStr(offsetDays = 0) {
  const t = Date.now() + (9 * 3600 + offsetDays * 86400) * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

// ファイル末尾 bytes 分だけを行配列で返す（巨大化しても読み込み量は一定）
function tailLines(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // 先頭は行の途中で切れているので捨てる
    return lines;
  } catch (_) {
    return [];
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
  }
}

// 1 ディレクトリから「最後に書かれた外注 1 件」を返す（時間の窓はここでは見ない）
//
// 行は追記順＝時系列なので、末尾から遡って最初に当たった 1 件が「最新の状態」。
// 生成開始（in_flight:true）の後に完了行が来ていれば、完了行の方が後ろにあるので
// 自然に勝つ。完了行がまだ無ければ開始行に当たり、「生成中」を出せる。
function latestRouteIn(dir) {
  for (const off of [0, -1]) { // JST の日跨ぎ直後は前日ファイルにも当たる
    const lines = tailLines(path.join(dir, `events_${jstDateStr(off)}.jsonl`), ROUTE_TAIL_BYTES);
    for (let i = lines.length - 1; i >= 0; i--) {
      // JSON.parse 前の粗フィルタ。openrouter(テキスト/画像) と comfyui(画像) の両方を拾う。
      if (lines[i].indexOf('"openrouter"') < 0 && lines[i].indexOf('"comfyui"') < 0) continue;
      let e;
      try { e = JSON.parse(lines[i]); } catch (_) { continue; }
      const p = e && e.payload;
      if (!p || (p.backend !== 'openrouter' && p.backend !== 'comfyui') || !p.model) continue;
      if (p.provider && ROUTE_IGNORE.has(p.provider)) continue; // テスト用の偽サーバ
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts)) continue;
      return {
        ts, model: p.model, provider: p.provider || null,
        inFlight: p.in_flight === true, kind: p.kind || null,
      };
    }
  }
  return null;
}

// 直近の外注を 1 件返す（無ければ null）。複数のイベント置き場を突き合わせ、
// **最も新しいものを採る**。
function readRoute(dirs) {
  const now = Date.now();
  let best = null;
  for (const d of dirs) {
    const r = latestRouteIn(d);
    if (r && (!best || r.ts > best.ts)) best = r;
  }
  if (!best) return null;
  const window = best.inFlight ? ROUTE_INFLIGHT_WINDOW_SEC : ROUTE_WINDOW_SEC;
  if (best.ts < now - window * 1000) return null; // 最新が窓外なら出さない
  return best;
}

function gitToplevel(dir) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 800,
    }).trim();
  } catch (_) { return ''; }
}

// 読むべきイベント置き場の一覧。
//
// **worktree で実行したぶんを取りこぼさない** (2026-08-13 に実機で判明)。
// 呼び出し元リポジトリの observability は**モジュールの位置**を基準に書き込み先を
// 決めるため、worktree からスクリプトを走らせるとイベントは
// `<worktree>/observability/state/` に落ちる。ベースツリーだけを見ていると、
// OpenRouter へも RunPod へも実際には外注しているのに、ステータスラインには
// 何も出ない (実測: OpenRouter 40 件 / ComfyUI 64 件を丸ごと見落としていた)。
//
// 置き場の**相対位置**を EVENTS_DIR から求めて worktree 側に当てる。
// "observability/state" を直接書かないのは、この構成に依存しないため。
function eventsDirs(cwd, wtPath) {
  const dirs = [];
  if (!EVENTS_DIR) return dirs; // 未設定＝機能オフ
  dirs.push(EVENTS_DIR);
  if (!wtPath) return dirs;
  const top = gitToplevel(cwd);
  if (!top) return dirs;
  const rel = path.relative(top, EVENTS_DIR);
  // EVENTS_DIR がリポジトリの外にあるなら worktree 側に対応物は無い
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) dirs.push(path.join(wtPath, rel));
  return dirs;
}

// "z-ai/glm-5.2" → "GLM 5.2" / "deepseek/deepseek-v4-pro" → "DeepSeek V4 Pro"
const VENDOR_LABEL = { glm: 'GLM', deepseek: 'DeepSeek', qwen: 'Qwen', kimi: 'Kimi', gpt: 'GPT', llama: 'Llama' };
function routeLabel(slug) {
  return String(slug).split('/').pop().split('-').map((w) => {
    const k = VENDOR_LABEL[w.toLowerCase()];
    if (k) return k;
    if (/^v\d/i.test(w)) return w.toUpperCase();          // v4 → V4
    if (/^[\d.]+$/.test(w)) return w;                     // 5.2 はそのまま
    return w.charAt(0).toUpperCase() + w.slice(1);        // pro → Pro
  }).join(' ');
}

// 残額 → "$12.3" / "$9.50" / "$0.42"（$10 以上は小数1桁、未満は2桁）
function fmtUsd(v) {
  const n = Math.max(0, Number(v) || 0);
  return '$' + (n >= 10 ? n.toFixed(1) : n.toFixed(2));
}

// モデル別週間制限の表示: モデル名は既存のモデル配色（Fable=シルバー等）で、％は使用率カラー。
// 古い（背景取得が止まっている）間は sheen も使用率カラーも捨てて薄く落とす。
// 光っていて色が付いていると「今の値」に見えてしまい、凍結に気づけない。
function renderScoped(b, stale) {
  if (!b || b.percent == null) return null;
  const pct = Math.round(b.percent) + '%';
  if (stale) return `${C.dim}${b.name} ${pct}${C.reset}`;
  const style = isFable(b.name) ? FABLE_STYLE : isOpus(b.name) ? OPUS_STYLE : isSonnet(b.name) ? SONNET_STYLE : null;
  const nm = style ? sheen(b.name, style.base, style.shine) : paint(b.name, C.teal);
  return `${nm} ${paint(pct, barColor(b.percent))}`;
}

function render(data) {
  const home = process.env.HOME || '';
  const ws = data.workspace || {};
  const cwd = ws.current_dir || data.cwd || home || '.';
  const model = (data.model && data.model.display_name) || '';
  const effort = (data.effort && data.effort.level) || '';
  const cw = data.context_window || {};
  const pct = Math.floor(Number(cw.used_percentage) || 0);
  const repoName = (ws.repo && ws.repo.name) || '';
  const branch = gitBranch(cwd);
  // 作業中 worktree は「ブランチ表示」と「イベント置き場」の両方で要るので 1 回だけ引く
  const wtPath = activeWorktreePath(cwd, data.session_id);
  const rl = data.rate_limits || {};
  const pr = data.pr || {};
  const lines = [];

  // 1) フォルダ
  lines.push(`${ic(I.folder)} ${paint(abbrevHome(cwd, home), C.blue)}`);

  // 2) リポジトリ │ ブランチ
  const seg2 = [];
  if (repoName) seg2.push(`${ic(I.repo)} ${paint(repoName, C.blue)}`);
  if (branch) {
    // 運用違反だけ赤く出す（正常時は従来どおり緑）。
    //   主ツリーが既定ブランチ以外 … 全ワークスペース・別アカウント・launchd が同じ状態を見ている
    //   linked worktree が既定ブランチ … 主ツリーが既定ブランチへ戻れなくなっている
    const role = treeRole(cwd);
    let base = paint(branch, C.green);
    if (role.kind === 'primary' && role.protected && branch !== role.protected) {
      base = `${C.red}${I.warn} ${branch}${C.reset} ${C.gray}主ツリー≠${role.protected}${C.reset}`;
    } else if (role.kind === 'linked' && role.protected && branch === role.protected) {
      base = `${C.red}${I.warn} ${branch}${C.reset} ${C.gray}worktree が ${role.protected} を保持${C.reset}`;
    }
    // 作業中の worktree が別ブランチなら「cwd のブランチ → 作業中のブランチ」と併記する。
    // 同じブランチなら足さない（情報が増えないうえ、見た目が変わる理由も無い）。
    const wt = wtPath ? gitBranch(wtPath) : '';
    const text = (wt && wt !== branch) ? `${base} ${C.gray}→${C.reset} ${paint(wt, C.yellow)}` : base;
    seg2.push(`${ic(I.branch)} ${text}`);
  }
  if (seg2.length) lines.push(seg2.join(SEP));

  // 3) コンテキスト │ モデル(/工数)
  const seg3 = [`${ic(I.ctx)} ${bar(pct)} ${paint(pct + '%', barColor(pct))}`];
  if (model) {
    // モデル名: Fable5=シルバー / Opus=メタリックブルー / その他=teal。"/"=gray、工数は段階別(low白/medium青/high緑/xhigh赤/max金)
    const effortColor = EFFORT_COLOR[effort.toLowerCase()] || C.teal;
    const style = isFable(model) ? FABLE_STYLE : isOpus(model) ? OPUS_STYLE : isSonnet(model) ? SONNET_STYLE : null;
    const modelText = style ? sheen(model, style.base, style.shine) : paint(model, C.teal);
    let m = effort ? `${modelText}${C.gray}/${effortColor}${effort}${C.reset}` : modelText;
    // OpenRouter へ外注していた場合のみ「→ 外注先モデル · 配信事業者」を足す。
    // 直近 ROUTE_WINDOW_SEC 以内に実績が無ければ何も出さない（現状の見た目のまま）。
    const route = readRoute(eventsDirs(cwd, wtPath));
    if (route) {
      m += ` ${C.gray}${I.route}${C.reset} ${paint(routeLabel(route.model), C.route)}`;
      // 完了前は配信事業者がまだ判らないので、代わりに「生成中」を示す。
      // 画像は 30-60 秒かかるため、この表示が無いと無反応に見える。
      if (route.inFlight) m += ` ${C.yellow}${I.inflight}${C.reset}`;
      else if (route.provider) m += ` ${C.dim}· ${route.provider}${C.reset}`;
    }
    seg3.push(`${ic(I.model)} ${m}`);
  }
  lines.push(seg3.join(SEP));

  // 4) プラン種別 & レート制限（Max 20x │ 5h │ 7d │ Fable…）
  //    5h/7d は stdin(rate_limits) 由来の即時値。プラン種別と Fable 等モデル別枠は背景キャッシュ由来。
  const usage = readUsageCache();
  const seg4 = [];
  // 5h/7d は stdin 由来なので常に今の値。プラン種別と Fable 等だけが古くなりうる。
  // 古さを言うのは「取得由来の値を実際に出しているとき」だけ。何も出していない行に
  // 経過時間だけ置いても読み手には何が古いのか分からない。
  const age = anthropicAge(usage);
  const hasFetched = !!(usage && (usage.tier || (Array.isArray(usage.scoped) && usage.scoped.length)));
  const stale = hasFetched && age != null && age >= STALE_SEC;
  // キャッシュ未生成時は ~/.claude.json 由来の暫定値になる。あれは Claude Code が写した値で
  // プラン変更に追従しないため、金（確定色）では出さない。初回の取得が済めば金に変わる。
  const plan = readPlanTier(usage);
  const planUnverified = !(usage && usage.tier);
  if (plan) seg4.push((stale || planUnverified) ? `${C.dim}${plan}${C.reset}` : `${C.gold}${plan}${C.reset}`);
  const fh = rl.five_hour, wk = rl.seven_day;
  if (fh && fh.used_percentage != null) {
    let s = `5h ${paint(Math.round(fh.used_percentage) + '%', C.green)}`;
    if (fh.resets_at) s += ` ${C.dim}(${ic(I.reset)}${C.dim} ${fmtTime(fh.resets_at)})${C.reset}`;
    seg4.push(s);
  }
  if (wk && wk.used_percentage != null) {
    let s = `7d ${paint(Math.round(wk.used_percentage) + '%', C.green)}`;
    if (wk.resets_at) s += ` ${C.dim}(${ic(I.reset)}${C.dim} ${fmtDateTime(wk.resets_at)})${C.reset}`;
    seg4.push(s);
  }
  // 週間モデル別制限（Fable 等）: 背景キャッシュから。リセットは 7d と同一のため省略。
  if (usage && Array.isArray(usage.scoped)) {
    for (const b of usage.scoped) { const s = renderScoped(b, stale); if (s) seg4.push(s); }
  }
  // ここまでが Anthropic 由来。古ければ経過時間を赤で添える（貼り付く失敗だけ理由も出す）。
  if (stale) {
    const why = STALE_REASON[usage && usage.anthropic && usage.anthropic.status];
    seg4.push(`${ic(I.stale)} ${paint(fmtAge(age) + '前', C.red)}${why ? ` ${C.dim}(${why})${C.reset}` : ''}`);
  }
  // OpenRouter 残額（背景キャッシュ由来）。min(クレジット残高, キー期間上限残) = 実際に使い切れる額。
  // 着色は balanceColor（残額の絶対値）。使用率ではなく「あと何ドル使えるか」で危険度が決まるため。
  const or = usage && usage.openrouter;
  if (or && typeof or.remaining === 'number') {
    seg4.push(`OR ${paint(fmtUsd(or.remaining), balanceColor(or.remaining))}`);
  }
  // RunPod 残額。純粋なプリペイドで上限の概念が無いため、％ではなく実額の絶対値で着色する。
  // ここが枯れると画像生成が全停止し、ネットワークボリューム（=モデル）ごと失われ得るので、
  // 残額は常に見えている方がよい。しきい値は OpenRouter と共通（balanceColor）。
  const rp = usage && usage.runpod;
  if (rp && typeof rp.balance === 'number') {
    seg4.push(`RP ${paint(fmtUsd(rp.balance), balanceColor(rp.balance))}`);
  }
  // NovelAI の Anlas 残高。**USD ではないので balanceColor は使えない**
  // （あちらはドルの絶対額に合わせたしきい値）。Opus の月間付与 10,000 を基準に、
  // 1 か月ぶんの余力がどれだけ残っているかで着色する。
  // 契約が切れていると生成そのものが止まるので、その場合は残高より先に赤で出す。
  const nai = usage && usage.novelai;
  if (nai && typeof nai.anlas === 'number') {
    const label = nai.active === false ? paint('Anlas 契約切れ', C.red)
      : `Anlas ${paint(String(nai.anlas), anlasColor(nai.anlas))}`;
    seg4.push(label);
  }
  if (seg4.length) lines.push(`${ic(I.rate)} ${seg4.join(SEP)}`);

  // 5) PR
  if (pr && pr.number) {
    lines.push(`${ic(I.pr)} ${C.yellow}${C.underline}#${pr.number}${C.reset}`);
  }

  return lines.join('\n');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try { maybeRefreshUsage(); } catch (_) {} // TTL 超過時のみ背景取得を起動（detached・非ブロッキング）
  let out;
  try {
    out = render(JSON.parse(input || '{}'));
  } catch (_) {
    // フォールバック（ステータス行を空にしない）
    out = `${ic(I.folder)} ${abbrevHome(process.env.PWD || '.', process.env.HOME || '')}`;
  }
  process.stdout.write(out + '\n');
});
