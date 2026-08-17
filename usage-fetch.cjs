#!/usr/bin/env node
'use strict';
/**
 * statusline 用 背景 usage フェッチャ
 *   Claude Code の GET /api/oauth/usage を叩き、週間モデル別制限（Fable 等）を含む
 *   正規化キャッシュを ~/.claude/statusline-usage-cache.json へ atomic に書く。
 *   2026-08-09 追加: OpenRouter の残額（GET /api/v1/key + /credits）も同じキャッシュへ載せる。
 *   2 系統は独立に取得し、片方が落ちても他方は前回値を保って出続ける（fail-open）。
 *
 * 呼び出し: statusline.cjs から detached spawn される（描画をブロックしない）。
 *   statusline はキャッシュを「読むだけ」でネットワークに触れない。実 fetch はこの子プロセスのみ。
 *
 * 認証: macOS Keychain "Claude Code-credentials" の claudeAiOauth.accessToken。
 *   トークンのリフレッシュは Claude Code 本体が行うため、ここでは現在値を読むだけ（リフレッシュ実装なし）。
 *
 * 失敗方針（fail-open）: 認証不可・ネットワーク不通・非200・パース失敗のいずれでも
 *   既存キャッシュを壊さず、ロックだけ解放して静かに終了する。statusline は Fable を出さないだけ。
 *
 * 応答スキーマ（実測・2026-07 / Claude Code v2.1.210）:
 *   { five_hour:{utilization,resets_at}, seven_day:{...},
 *     limits:[ {kind:"session"|"weekly_all"|"weekly_scoped", percent, resets_at, is_active,
 *               scope:{model:{display_name:"Fable"}}|null }, ... ],
 *     extra_usage:{is_enabled,utilization,...} }
 *   resets_at は ISO8601 文字列。ここで epoch 秒へ変換して statusline の時刻整形に合わせる。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const CACHE = path.join(os.homedir(), '.claude', 'statusline-usage-cache.json');
const LOCK = CACHE + '.lock';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLI_VERSION = process.env.STATUSLINE_CLI_VERSION || '2.1.210';

function unlock() { try { fs.unlinkSync(LOCK); } catch (_) {} }

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) { return null; }
}

function writeCache(obj) {
  try {
    const tmp = CACHE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CACHE); // atomic 置換
  } catch (_) {}
}

// API キーの解決。env が最優先。無ければ STATUSLINE_ENV_FILE が指す dotenv 形式
// （`KEY=VALUE`・`#` 始まりはコメント）のファイルから 1 キーだけ取り出す。既定パスは持たない。
// 値はメモリ上のみ。ログにも stdout にも一切出さない（このプロセスは stdio:'ignore' で起動される）。
function readSecret(key) {
  if (process.env[key]) return process.env[key];
  const SECRETS = process.env.STATUSLINE_ENV_FILE;
  if (!SECRETS) return null;
  try {
    for (const ln of fs.readFileSync(SECRETS, 'utf8').split('\n')) {
      const s = ln.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 0 || s.slice(0, i).trim() !== key) continue;
      return s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return null;
}

/**
 * OpenRouter の残額。上限が 2 系統あり、先に枯れる方が実際の制約になる:
 *   ① クレジット残高   = /credits の total_credits - total_usage
 *   ② キーの期間上限残 = /key の limit_remaining（limit 未設定なら上限なし）
 * remaining は min(①,②)、base はその remaining が出た側の総額（％着色に使う）。
 * 同じキーを複数の環境で使い回している場合、この値はそれらの消費が合算された実額になる。
 * 失敗時は null（呼び出し側が既存キャッシュを保つ）。
 */
async function fetchOpenRouter() {
  const key = readSecret('OPENROUTER_API_KEY');
  if (!key) return null;
  const get = async (p) => {
    const r = await fetch('https://openrouter.ai/api/v1' + p, {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()).data || {};
  };

  let k, c;
  try { [k, c] = await Promise.all([get('/key'), get('/credits')]); } catch (_) { return null; }

  const cands = [];
  if (typeof c.total_credits === 'number' && typeof c.total_usage === 'number') {
    cands.push({ remaining: c.total_credits - c.total_usage, base: c.total_credits, source: 'credits' });
  }
  if (typeof k.limit_remaining === 'number' && typeof k.limit === 'number' && k.limit > 0) {
    cands.push({ remaining: k.limit_remaining, base: k.limit, source: 'key_limit' });
  }
  if (!cands.length) return null;

  const win = cands.reduce((a, b) => (b.remaining < a.remaining ? b : a));
  return {
    remaining: win.remaining,
    base: win.base,
    source: win.source,
    usage_monthly: typeof k.usage_monthly === 'number' ? k.usage_monthly : null,
    limit_reset: k.limit_reset || null,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * RunPod のクレジット残高。
 *
 * REST (rest.runpod.io/v1) に残高を返す口が無いため、旧 GraphQL の
 * `myself { clientBalance }` を使う。**User-Agent が要る** — 既定の UA だと
 * Cloudflare が 403 (error 1010) で弾く。
 *
 * OpenRouter と違い上限の概念が無い純粋なプリペイド残高なので base は持たない。
 * 失敗時は null（呼び出し側が既存キャッシュを保つ）。
 */
async function fetchRunPod() {
  const key = readSecret('RUNPOD_API_KEY');
  if (!key) return null;
  try {
    const r = await fetch('https://api.runpod.io/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        // 既定 UA だと Cloudflare に 403 で落とされる（2026-08-09 実測）
        'User-Agent': 'claude-statusline/1.0',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query: 'query { myself { clientBalance } }' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const bal = j && j.data && j.data.myself && j.data.myself.clientBalance;
    if (typeof bal !== 'number') return null;
    return { balance: bal, fetchedAt: Math.floor(Date.now() / 1000) };
  } catch (_) { return null; }
}

/**
 * NovelAI の Anlas 残高。
 *
 * **ホストは `image.novelai.net`。** `api.novelai.net` は 400 で
 * 「third-party tool は image URL へ更新せよ」と返す（2026-08-17 実測）。
 * 「NovelAI の画像 API は 2024 年に廃止された」という記述が各所に残っているが、
 * 実際は移転しただけで、この誤情報の出どころがここ。
 *
 * Anlas は API では `trainingStepsLeft.fixedTrainingStepsLeft` という名前で返る
 * （元は学習ステップ数だった名残）。サブスクの定額なので USD 残高は存在せず、
 * 従量なのはこの Anlas だけ。Opus は月 10,000 付与。
 *
 * **UA が要る** — DNS/CDN/TLS 終端がすべて Cloudflare のため、既定 UA だと弾かれる。
 * 失敗時は null（呼び出し側が既存キャッシュを保つ）。
 */
async function fetchNovelAI() {
  const key = readSecret('NOVELAI_API_KEY');
  if (!key) return null;
  try {
    const r = await fetch('https://image.novelai.net/user/subscription', {
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': 'claude-statusline/1.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const anlas = j && j.trainingStepsLeft && j.trainingStepsLeft.fixedTrainingStepsLeft;
    if (typeof anlas !== 'number') return null;
    return {
      anlas,
      tier: typeof j.tier === 'number' ? j.tier : null,
      active: !!j.active,
      expiresAt: typeof j.expiresAt === 'number' ? j.expiresAt : null,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  } catch (_) { return null; }
}

function readOAuth() {
  try {
    const raw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    }).trim();
    return JSON.parse(raw).claudeAiOauth || null;
  } catch (_) { return null; }
}

// ISO8601 文字列 or epoch(秒/ミリ秒) → epoch 秒
function toEpochSec(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

async function main() {
  const prev = readCache();

  // 課金元は Anthropic 側の成否と独立に取る（片方が落ちても他方は出続ける）。
  const [or, rp, nai] = await Promise.all([
    fetchOpenRouter(), fetchRunPod(), fetchNovelAI(),
  ]);
  // Anthropic 側が取れなかった場合でも、残額が新しく取れていれば既存キャッシュへ載せて残す。
  const bail = () => {
    const patch = {};
    if (or) patch.openrouter = or;
    if (rp) patch.runpod = rp;
    if (nai) patch.novelai = nai;
    if (Object.keys(patch).length) writeCache(Object.assign({}, prev || {}, patch));
    unlock();
  };

  const oauth = readOAuth();
  if (!oauth || !oauth.accessToken) { bail(); return; }

  let res;
  try {
    res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': `claude-cli/${CLI_VERSION} (external, cli)`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (_) { bail(); return; }
  if (!res.ok) { bail(); return; }

  let data;
  try { data = await res.json(); } catch (_) { bail(); return; }

  // limits[] を正規化。将来モデル枠が増えても scoped に自動追加される。
  const out = {
    fetchedAt: Math.floor(Date.now() / 1000),
    tier: oauth.rateLimitTier || null,
    subscriptionType: oauth.subscriptionType || null,
    session: null,
    weekly_all: null,
    scoped: [],
    overage: null,
    // 今回取れなければ前回値を残す（残額は緩やかにしか動かないため、欠落より鮮度落ちを選ぶ）
    openrouter: or || (prev && prev.openrouter) || null,
    runpod: rp || (prev && prev.runpod) || null,
    novelai: nai || (prev && prev.novelai) || null,
  };
  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const l of limits) {
    if (!l || typeof l.percent !== 'number') continue;
    const entry = { percent: l.percent, resets_at: toEpochSec(l.resets_at), is_active: !!l.is_active };
    if (l.kind === 'session') out.session = entry;
    else if (l.kind === 'weekly_all') out.weekly_all = entry;
    else if (l.kind === 'weekly_scoped') {
      const name = l.scope && l.scope.model && l.scope.model.display_name;
      if (name) out.scoped.push(Object.assign({ name }, entry));
    }
  }
  if (data.extra_usage && data.extra_usage.is_enabled) {
    const u = data.extra_usage.utilization;
    out.overage = { enabled: true, percent: typeof u === 'number' ? u : null };
  }

  writeCache(out);
  unlock();
}

main().catch(() => unlock());
