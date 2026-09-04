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
 * 認証: macOS Keychain "Claude Code-credentials" の claudeAiOauth.accessToken
 *   （本体が平文へ退避している環境では ~/.claude/.credentials.json）。
 *   トークンのリフレッシュは Claude Code 本体が行うため、ここでは現在値を読むだけ（リフレッシュ実装なし）。
 *   **期限切れのトークンでは 1 回も叩かない**（後述の cooldown / expiresAt 判定）。
 *
 * 失敗方針（fail-open）: 認証不可・ネットワーク不通・非200・パース失敗のいずれでも
 *   既存キャッシュを壊さず、ロックだけ解放して静かに終了する。statusline は Fable を出さないだけ。
 *   ただし「静かに終了した」事実は cache.anthropic に残す（statusline が古さを表示に出せるように）。
 *
 * 2026-09-05 追加: プラン種別（Max 5x / 20x）は GET /api/oauth/profile の
 *   organization.rate_limit_tier から取る。OAuth トークン内の rateLimitTier は
 *   **プラン変更に追従しない**（20x へ変更後にリフレッシュしても 5x のまま返る）ことを実測した。
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

// プラン種別（/api/oauth/profile）の再取得間隔。プラン変更を察知するのが目的なので
// usage ほど頻繁でなくてよいが、変更に何時間も気づかないのも困る。既定 1 時間。
const PROFILE_TTL_SEC = Number(process.env.STATUSLINE_PROFILE_TTL_SEC) || 3600;
// access token の期限判定に使う余裕（秒）。境界ぴったりで叩いて 401 を貰うのを避ける。
const TOKEN_SKEW_SEC = 60;
// 連続失敗時の指数バックオフ（秒）。60 → 120 → 240 … で 30 分頭打ち。
const BACKOFF_BASE_SEC = 60;
const BACKOFF_MAX_SEC = 1800;

function unlock() { try { fs.unlinkSync(LOCK); } catch (_) {} }

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) { return null; }
}

function writeCache(obj) {
  try {
    // .tmp をプロセス毎に分ける。固定名だと、statusline が起動した子と手で叩いた
    // `node usage-fetch.cjs`（README / DEVELOPMENT.md が案内している）が同じ .tmp を
    // 奪い合い、書きかけを rename して**壊れた JSON** をキャッシュへ置いてしまう。
    // そうなると statusline 側は readUsageCache が null になり 4 行目が丸ごと消える。
    const tmp = `${CACHE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CACHE); // atomic 置換
  } catch (_) { try { fs.unlinkSync(`${CACHE}.${process.pid}.tmp`); } catch (__) {} }
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

/**
 * Claude Code の OAuth 資格情報を読む（読むだけ・書かない）。
 *
 * 本体の保存先は「Keychain 優先・失敗したら平文フォールバック」の 2 段構えで、
 * 平文へ退避したときは **Keychain 項目の方を削除する**。Keychain だけを見ていると
 * その環境で永久に「トークン無し」になるため、両方を見る。
 *
 * リフレッシュはしない。本体はリフレッシュトークンをローテートし、ロックと
 * compare-and-swap で保存しているので、こちらが割り込むとログアウトさせうる。
 */
function readOAuth() {
  try {
    const raw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    }).trim();
    const o = JSON.parse(raw).claudeAiOauth;
    if (o && o.accessToken) return o;
  } catch (_) {}
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    return JSON.parse(raw).claudeAiOauth || null;
  } catch (_) { return null; }
}

// ISO8601 文字列 or epoch(秒/ミリ秒・数値でも数値文字列でも) → epoch 秒。
// 1e12 を境にミリ秒とみなす（2001-09-09 以降の秒 epoch は 1e9 台なので衝突しない）。
function toEpochSec(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v).trim()) ? Number(v) : NaN);
  if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// Retry-After は「秒数」か「HTTP-date」のどちらかで来る。両方を秒へ寄せる。
function parseRetryAfter(v, nowSec) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.floor(t / 1000) - nowSec) : 0;
}

/**
 * Claude Code 本体と同じ体裁で Anthropic の OAuth API を 1 回叩く。
 * 例外を投げず、必ず { ok, status, retryAfter, json } を返す（呼び出し側で分岐しやすくする）。
 * status 0 は「接続できなかった / タイムアウト」。
 */
async function anthropicGet(pathname, token, nowSec) {
  try {
    const r = await fetch('https://api.anthropic.com' + pathname, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': `claude-cli/${CLI_VERSION} (external, cli)`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    const retryAfter = parseRetryAfter(r.headers.get('retry-after'), nowSec);
    if (!r.ok) return { ok: false, status: r.status, retryAfter, json: null };
    try { return { ok: true, status: r.status, retryAfter, json: await r.json() }; }
    catch (_) { return { ok: false, status: r.status, retryAfter, json: null }; }
  } catch (_) {
    return { ok: false, status: 0, retryAfter: 0, json: null };
  }
}

async function main() {
  const prev = readCache();
  const nowSec = Math.floor(Date.now() / 1000);

  // 課金元は Anthropic 側の成否と独立に取る（片方が落ちても他方は出続ける）。
  const [or, rp, nai] = await Promise.all([
    fetchOpenRouter(), fetchRunPod(), fetchNovelAI(),
  ]);

  // Anthropic の結果を載せる土台。前回値を引き継いだうえで残額だけ今回値で上書きする。
  // 今回取れなければ前回値を残す（残額は緩やかにしか動かないため、欠落より鮮度落ちを選ぶ）。
  const base = Object.assign({}, prev || {}, {
    openrouter: or || (prev && prev.openrouter) || null,
    runpod: rp || (prev && prev.runpod) || null,
    novelai: nai || (prev && prev.novelai) || null,
  });

  // ---- Anthropic 側だけが持つ取得スケジュール ----
  //
  // ここだけ独自に「次に叩いてよい時刻」を持つ。理由は 2 つある。
  //   ① access token が期限切れの間は 100% 失敗する。ローカルで判るのだから 1 回も叩かない
  //   ② GET /api/oauth/usage の 429 は **認証より前** に返る（期限切れトークンでも 401 ではなく
  //      429 が返り、retry-after ≒ 3549 が付く）。叩き続けると窓が延び続け、トークンが直っても
  //      復帰できない
  //
  // 2026-09-05、この 2 つが重なって 30 時間ぶん Fable の％とプラン種別が凍結した。しかも
  // bail 経路が残額だけ書き戻すのでキャッシュの mtime は 5 分ごとに新しくなり、statusline からは
  // 「新鮮なキャッシュ」に見えていた。**古いことが判る状態で止まる**のがここの責務。
  const sched = (prev && prev.anthropic) || {};
  const finish = (anthropic) => { writeCache(Object.assign(base, { anthropic })); unlock(); };
  // 失敗・見送り時: 最後に成功した時刻は保ったまま、状態だけ更新して終わる。
  const halt = (status, cooldownUntil, failures) => finish({
    lastSuccessAt: sched.lastSuccessAt || null,
    lastAttemptAt: nowSec,
    status,
    cooldownUntil: cooldownUntil || null,
    failures: failures == null ? (sched.failures || 0) : failures,
  });

  // ① クールダウン中はネットワークへ出ない
  if (sched.cooldownUntil && nowSec < sched.cooldownUntil) {
    finish(Object.assign({}, sched, { lastAttemptAt: nowSec }));
    return;
  }

  const oauth = readOAuth();
  if (!oauth || !oauth.accessToken) { halt('no_token', nowSec + 300, 0); return; }

  // ② 期限切れトークンでは叩かない。リフレッシュは Claude Code 本体の仕事なので、
  //    本体が直した次の実行でそのまま復帰できるよう cooldown は置かない（判定はローカルで無料）。
  const expSec = typeof oauth.expiresAt === 'number' ? Math.floor(oauth.expiresAt / 1000) : null;
  if (expSec && nowSec >= expSec - TOKEN_SKEW_SEC) { halt('token_expired', null, sched.failures || 0); return; }

  // ③ 使用量
  const usage = await anthropicGet('/api/oauth/usage', oauth.accessToken, nowSec);
  if (!usage.ok) {
    const failures = (sched.failures || 0) + 1;
    let cooldown;
    if (usage.status === 429) cooldown = nowSec + Math.max(usage.retryAfter, BACKOFF_BASE_SEC);
    else if (usage.status === 401 || usage.status === 403) cooldown = nowSec + 300;
    else cooldown = nowSec + Math.min(BACKOFF_BASE_SEC * Math.pow(2, failures - 1), BACKOFF_MAX_SEC);
    halt(usage.status ? `http_${usage.status}` : 'network', cooldown, failures);
    return;
  }
  const data = usage.json || {};

  // ④ プラン種別。**OAuth トークン内の rateLimitTier は使わない。**
  //    2026-09-05 実測: Max 20x へ変更したあと、トークンをリフレッシュしても
  //    claudeAiOauth.rateLimitTier は default_claude_max_5x のままで、~/.claude.json の
  //    organizationRateLimitTier も同じ古い値を写していた。現況を返すのは profile だけ。
  //    プラン変更は稀なので PROFILE_TTL_SEC（既定 1 時間）に 1 回しか叩かない。
  let tier = (prev && prev.tier) || null;
  let tierSource = (prev && prev.tierSource) || null;
  let tierFetchedAt = (prev && prev.tierFetchedAt) || null;
  if (tierSource !== 'profile' || !tierFetchedAt || nowSec - tierFetchedAt >= PROFILE_TTL_SEC) {
    const prof = await anthropicGet('/api/oauth/profile', oauth.accessToken, nowSec);
    const org = prof.ok && prof.json && prof.json.organization;
    const t = org && org.rate_limit_tier;
    if (typeof t === 'string' && t) { tier = t; tierSource = 'profile'; tierFetchedAt = nowSec; }
  }
  // profile が一度も取れていない時だけ、トークン側の値で穴を埋める（古い可能性がある値）。
  if (!tier && oauth.rateLimitTier) { tier = oauth.rateLimitTier; tierSource = 'oauth'; tierFetchedAt = nowSec; }

  // limits[] を正規化。将来モデル枠が増えても scoped に自動追加される。
  const out = Object.assign(base, {
    fetchedAt: nowSec,
    tier,
    tierSource,
    tierFetchedAt,
    subscriptionType: oauth.subscriptionType || null,
    session: null,
    weekly_all: null,
    scoped: [],
    overage: null,
    anthropic: { lastSuccessAt: nowSec, lastAttemptAt: nowSec, status: 'ok', cooldownUntil: null, failures: 0 },
  });
  const limits = Array.isArray(data.limits) ? data.limits : [];
  let parsed = 0;
  for (const l of limits) {
    if (!l || typeof l.percent !== 'number') continue;
    const entry = { percent: l.percent, resets_at: toEpochSec(l.resets_at), is_active: !!l.is_active };
    parsed++;
    if (l.kind === 'session') out.session = entry;
    else if (l.kind === 'weekly_all') out.weekly_all = entry;
    else if (l.kind === 'weekly_scoped') {
      const name = l.scope && l.scope.model && l.scope.model.display_name;
      if (name) out.scoped.push(Object.assign({ name }, entry));
    }
  }
  // 200 なのに 1 件も読めない ＝ 先方のスキーマが変わった可能性。ここで前回値を捨てると
  // Fable の枠が「元から無い」のと見分けが付かなくなる。前回値を残し、成功時刻は進めない
  // （statusline 側が古さとして出す）。README の「壊れても fail-open」はこの意味。
  // ただし前回も空だったなら「元から枠が無いアカウント」なので騒がない。
  const hadData = !!(prev && ((prev.scoped && prev.scoped.length) || prev.session || prev.weekly_all));
  if (!parsed && hadData) {
    out.session = (prev && prev.session) || null;
    out.weekly_all = (prev && prev.weekly_all) || null;
    out.scoped = (prev && prev.scoped) || [];
    out.fetchedAt = (prev && prev.fetchedAt) || null;
    out.anthropic = {
      lastSuccessAt: sched.lastSuccessAt || null,
      lastAttemptAt: nowSec,
      status: 'schema',
      cooldownUntil: nowSec + 300,
      failures: (sched.failures || 0) + 1,
    };
  }
  if (data.extra_usage && data.extra_usage.is_enabled) {
    const u = data.extra_usage.utilization;
    out.overage = { enabled: true, percent: typeof u === 'number' ? u : null };
  }

  writeCache(out);
  unlock();
}

main().catch(() => unlock());
