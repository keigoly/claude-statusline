#!/usr/bin/env node
/**
 * Claude Code ステータスライン — 多段表示
 *   1) [folder] カレントフォルダ（~ 省略）
 *   2) [repo] リポジトリ名 │ [branch] ブランチ
 *   3) [ctx] コンテキスト使用量バー │ [model] モデル/工数(effort) [→ OpenRouter 外注先 · 配信事業者]
 *   4) [rate] 5h 使用率 ([reset] リセット) │ 7d 使用率 ([reset] リセット) │ OR 残額   ← Pro/Max のみ・初回応答後に出現
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
 * `STATUSLINE_ICONS=emoji` で絵文字にフォールバック。例外時も最低1行返す。git 1回のみ・ネットワーク無し。
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
  },
  emoji: {
    folder: '📁', repo: '🐙', branch: '🌿', ctx: '🧠', model: '💪', rate: '💰', pr: 'PR', reset: '🔄',
    route: '→',
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
// プラン種別 … Keychain 由来キャッシュ or ~/.claude.json の *RateLimitTier から得る。
// モデル別週間制限 … 背景フェッチャ(usage-fetch.cjs)が GET /api/oauth/usage の結果を書いたキャッシュから読む。
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
  // 1) キャッシュ（フェッチャが oauth から書いた値）を優先 → ~/.claude.json の巨大 read を避ける
  if (cache && cache.tier) return labelTier(cache.tier);
  // 2) キャッシュ未生成時のみ ~/.claude.json を正規表現で軽量抽出（全体 JSON.parse はしない）
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
  try { fs.writeFileSync(lock, String(now)); } catch (_) { return; }
  try {
    const { spawn } = require('node:child_process');
    const fetcher = path.join(path.dirname(fs.realpathSync(__filename)), 'usage-fetch.cjs');
    spawn(process.execPath, [fetcher], { detached: true, stdio: 'ignore' }).unref();
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

// 直近 ROUTE_WINDOW_SEC 以内の OpenRouter 呼び出しを 1 件返す（無ければ null）
function readRoute() {
  if (!EVENTS_DIR) return null; // 未設定＝機能オフ
  const cutoff = Date.now() - ROUTE_WINDOW_SEC * 1000;
  for (const off of [0, -1]) { // JST の日跨ぎ直後は前日ファイルにも当たる
    const lines = tailLines(path.join(EVENTS_DIR, `events_${jstDateStr(off)}.jsonl`), ROUTE_TAIL_BYTES);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].indexOf('"openrouter"') < 0) continue; // JSON.parse 前の粗フィルタ
      let e;
      try { e = JSON.parse(lines[i]); } catch (_) { continue; }
      const p = e && e.payload;
      if (!p || p.backend !== 'openrouter' || !p.model) continue;
      if (p.provider && ROUTE_IGNORE.has(p.provider)) continue; // テスト用の偽サーバ
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts)) continue;
      return ts >= cutoff ? { model: p.model, provider: p.provider || null } : null; // 最新が窓外なら出さない
    }
  }
  return null;
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

// モデル別週間制限の表示: モデル名は既存のモデル配色（Fable=シルバー等）で、％は使用率カラー
function renderScoped(b) {
  if (!b || b.percent == null) return null;
  const style = isFable(b.name) ? FABLE_STYLE : isOpus(b.name) ? OPUS_STYLE : isSonnet(b.name) ? SONNET_STYLE : null;
  const nm = style ? sheen(b.name, style.base, style.shine) : paint(b.name, C.teal);
  return `${nm} ${paint(Math.round(b.percent) + '%', barColor(b.percent))}`;
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
  const rl = data.rate_limits || {};
  const pr = data.pr || {};
  const lines = [];

  // 1) フォルダ
  lines.push(`${ic(I.folder)} ${paint(abbrevHome(cwd, home), C.blue)}`);

  // 2) リポジトリ │ ブランチ
  const seg2 = [];
  if (repoName) seg2.push(`${ic(I.repo)} ${paint(repoName, C.blue)}`);
  if (branch) seg2.push(`${ic(I.branch)} ${paint(branch, C.green)}`);
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
    const route = readRoute();
    if (route) {
      m += ` ${C.gray}${I.route}${C.reset} ${paint(routeLabel(route.model), C.route)}`;
      if (route.provider) m += ` ${C.dim}· ${route.provider}${C.reset}`;
    }
    seg3.push(`${ic(I.model)} ${m}`);
  }
  lines.push(seg3.join(SEP));

  // 4) プラン種別 & レート制限（Max 20x │ 5h │ 7d │ Fable…）
  //    5h/7d は stdin(rate_limits) 由来の即時値。プラン種別と Fable 等モデル別枠は背景キャッシュ由来。
  const usage = readUsageCache();
  const seg4 = [];
  const plan = readPlanTier(usage);
  if (plan) seg4.push(`${C.gold}${plan}${C.reset}`);
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
    for (const b of usage.scoped) { const s = renderScoped(b); if (s) seg4.push(s); }
  }
  // OpenRouter 残額（背景キャッシュ由来）。min(クレジット残高, キー期間上限残) = 実際に使い切れる額。
  // 着色は使用率と同じ規則にそろえる（残りが減る＝使用率が上がる、と読み替える）。
  const or = usage && usage.openrouter;
  if (or && typeof or.remaining === 'number') {
    const usedPct = or.base > 0 ? Math.max(0, Math.min(100, 100 - (or.remaining / or.base) * 100)) : 0;
    seg4.push(`OR ${paint(fmtUsd(or.remaining), barColor(usedPct))}`);
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
