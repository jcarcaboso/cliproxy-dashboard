// Wire fields follow the pinned upstream Management Center contract in docs/API.md.
import { createHash } from 'node:crypto';

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max = 120) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '';
export function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value); return Number.isFinite(n) ? n : null;
  }
  return null;
}
export const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function instant(value) {
  if (value == null || value === '' || value === 0) return null;
  const n = numeric(value);
  const ms = n === null ? (typeof value === 'string' ? Date.parse(value) : NaN) : n > 1e11 ? n : n * 1000;
  return Number.isFinite(ms) && ms > 0 && ms < 8640000000000000 ? ms : null;
}
export function windowValue(used, resetAt) {
  const n = numeric(used);
  return { remaining: n === null || n < 0 ? null : Math.max(0, 100 - n), resetAt: instant(resetAt) };
}
export const emptyWindows = () => ({ five: windowValue(null, null), week: windowValue(null, null), fable: windowValue(null, null) });

export function renewalDates(...sources) {
  const rows = sources.filter(record).flatMap(source => [source, ...(record(source.subscription) ? [source.subscription] : [])]);
  const first = keys => rows.flatMap(row => keys.map(key => instant(row[key]))).find(value => value !== null) ?? null;
  return {
    nextAt: first(['active_until', 'activeUntil', 'chatgpt_subscription_active_until', 'chatgptSubscriptionActiveUntil',
      'subscription_active_until', 'subscriptionActiveUntil', 'renews_at', 'renewsAt', 'current_period_end', 'currentPeriodEnd']),
    lastAt: first(['last_renewal_at', 'lastRenewalAt', 'last_renewed_at', 'lastRenewedAt']),
    // Subscription creation/activation is not evidence of the last billing renewal.
    startedAt: first(['active_start', 'activeStart', 'chatgpt_subscription_active_start', 'chatgptSubscriptionActiveStart',
      'subscription_active_start', 'subscriptionActiveStart', 'subscription_created_at', 'subscriptionCreatedAt'])
  };
}

function tokenClaims(value) {
  if (record(value)) return value;
  if (typeof value !== 'string' || value.length > 20000) return {};
  try { const claim = JSON.parse(Buffer.from(value.split('.')[1], 'base64url')); return record(claim) ? claim : {}; } catch { return {}; }
}
export function credential(item) {
  if (!record(item)) return null;
  const authIndex = typeof item.auth_index === 'number' ? String(item.auth_index) : (item.auth_index ?? item.authIndex);
  if (typeof authIndex !== 'string' || !authIndex.trim() || authIndex.length > 256 || /[\x00-\x20\x7f]/.test(authIndex)) return null;
  const provider = text(item.provider || item.type, 40).toLowerCase() || 'unknown';
  const metadata = record(item.metadata) ? item.metadata : {};
  const attrs = record(item.attributes) ? item.attributes : {};
  const claims = [item.id_token, metadata.id_token, attrs.id_token].map(tokenClaims);
  const authClaims = claims.flatMap(c => record(c['https://api.openai.com/auth']) ? [c['https://api.openai.com/auth'], c] : [c]);
  const firstText = (values, max) => values.map(value => text(value, max)).find(Boolean) || '';
  const accountId = firstText([
    item.chatgpt_account_id, item.chatgptAccountId, metadata.chatgpt_account_id,
    metadata.chatgptAccountId, attrs.chatgpt_account_id, attrs.chatgptAccountId,
    ...authClaims.flatMap(c => [c.chatgpt_account_id, c.chatgptAccountId])
  ], 200);
  const plan = firstText([
    item.plan_type, item.planType, metadata.plan_type, metadata.planType, attrs.plan_type, attrs.planType,
    ...authClaims.flatMap(c => [c.chatgpt_plan_type, c.plan_type, c.planType])
  ], 60);
  const id = createHash('sha256').update(`${provider}\0${authIndex}`).digest('hex').slice(0, 24);
  return {
    id, authIndex, provider, accountId, plan: plan || null,
    renewal: renewalDates(item, metadata, attrs, ...authClaims),
    label: text(item.label || item.email || item.name || item.id || `${provider} account`),
    disabled: item.disabled === true || item.disabled === 'true' || item.status === 'disabled',
    fingerprint: createHash('sha256').update(JSON.stringify([
      provider, authIndex, accountId, text(item.id), text(item.email || metadata.email || attrs.email)
    ])).digest('hex')
  };
}

export function codexWindows(body, now) {
  const windows = emptyWindows(), extras = [];
  const rate = body?.rate_limit ?? body?.rateLimit;
  if (!record(rate)) return { windows, extras };
  const primary = rate.primary_window ?? rate.primaryWindow;
  const secondary = rate.secondary_window ?? rate.secondaryWindow;
  const candidates = [primary, secondary].map((raw, i) => ({ raw, i })).filter(x => record(x.raw));
  const assigned = new Set();
  // Reported durations take precedence over any legacy positional fallback.
  candidates.sort((a, b) => Number(numeric(a.raw.limit_window_seconds ?? a.raw.limitWindowSeconds) === null) -
    Number(numeric(b.raw.limit_window_seconds ?? b.raw.limitWindowSeconds) === null));
  for (const { raw, i } of candidates) {
    if (!record(raw)) continue;
    const seconds = numeric(raw.limit_window_seconds ?? raw.limitWindowSeconds);
    // Positional fallback is only for legacy payloads with no reported duration.
    const key = seconds === 18000 ? 'five' : seconds === 604800 ? 'week' : seconds === null ? (i === 0 ? 'five' : 'week') : null;
    const offset = numeric(raw.reset_after_seconds ?? raw.resetAfterSeconds);
    const reset = instant(raw.reset_at ?? raw.resetAt) ?? (offset !== null && offset >= 0 ? now + offset * 1000 : null);
    const value = windowValue(raw.used_percent ?? raw.usedPercent, reset);
    if (key && !assigned.has(key)) { windows[key] = value; assigned.add(key); }
    else extras.push({ periodSeconds: seconds, ...value }); // A monthly window must not be labeled weekly.
  }
  return { windows, extras };
}

export function claudeWindows(body) {
  const windows = emptyWindows();
  for (const [key, source] of [['five', 'five_hour'], ['week', 'seven_day']]) {
    if (record(body?.[source])) windows[key] = windowValue(body[source].utilization, body[source].resets_at);
  }
  const scoped = Array.isArray(body?.limits) ? body.limits.filter(limit =>
    record(limit) && limit.kind === 'weekly_scoped' && limit.is_active !== false &&
    ['fable', 'fable 5'].includes(text(limit.scope?.model?.display_name).toLowerCase()) &&
    numeric(limit.percent) !== null) : [];
  const fable = scoped.find(limit => limit.is_active === true) || scoped[0];
  if (fable) windows.fable = windowValue(fable.percent, fable.resets_at);
  else if (record(body?.iguana_necktie)) windows.fable = windowValue(body.iguana_necktie.utilization, body.iguana_necktie.resets_at);
  return windows;
}

// Lower tiers can report an unused Fable window without an entitlement.
export function claudeFableAvailable(profile, windows) {
  if (/max_20x/i.test(text(profile?.organization?.rate_limit_tier))) return true;
  const remaining = windows?.fable?.remaining;
  return typeof remaining === 'number' && remaining < 100;
}

export function claudePlan(profile) {
  if (profile?.organization?.organization_type === 'claude_team' && profile?.organization?.subscription_status === 'active') return 'Team';
  const account = profile?.account;
  if (account?.has_claude_max === true) return 'Max';
  if (account?.has_claude_pro === true) return 'Pro';
  if (account?.has_claude_max === false && account?.has_claude_pro === false) return 'Free';
  return null;
}

function resetExpirations(total, entries) {
  if (total === null || total === 0) return [];
  const groups = new Map();
  let reported = 0;
  for (const entry of entries) {
    if (!entry.count) continue;
    reported += entry.count;
    groups.set(entry.expiresAt, (groups.get(entry.expiresAt) || 0) + entry.count);
  }
  // Conflicting detail counts cannot establish the expiry of the banked balance.
  if (reported > total) return [{ count: total, expiresAt: null }];
  if (reported < total) groups.set(null, (groups.get(null) || 0) + total - reported);
  return [...groups].sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))
    .map(([expiresAt, count]) => ({ count, expiresAt }));
}

export function codexResets(body, now) {
  const unknown = { full: null, five: null, options: [], reason: 'Reset-credit status unavailable' };
  if (!record(body) || !['available_count', 'availableCount', 'credits'].some(key => key in body)) return unknown;
  const rawAvailable = body.available_count ?? body.availableCount;
  const available = count(numeric(rawAvailable));
  if (rawAvailable != null && available === null) return unknown;
  if (body.credits != null && !Array.isArray(body.credits)) return unknown;
  const credits = Array.isArray(body.credits) ? body.credits.filter(c => {
    if (!record(c) || !['codex_rate_limits', 'codexRateLimits'].includes(c.reset_type ?? c.resetType) || c.status !== 'available') return false;
    const expiry = c.expires_at ?? c.expiresAt;
    return expiry == null || (instant(expiry) !== null && instant(expiry) > now);
  }) : null;
  // The reported count is authoritative. The details array can be absent,
  // empty or partial, and a detail can legitimately have no expiry timestamp.
  const total = available ?? (credits ? credits.length : null);
  if (total === null) return unknown;
  // Match native Codex: banked credits gate redemption. A usage-only
  // applicability hint is not a second balance or a manual-redemption denial.
  const valid = total > 0;
  const reason = valid ? null : 'No reset credits remaining';
  return {
    full: total, five: null, reason,
    expirations: {
      full: resetExpirations(total, (credits ?? []).map(c => ({ count: 1, expiresAt: instant(c.expires_at ?? c.expiresAt) }))),
      five: []
    },
    options: [{ kind: 'full', label: 'Codex rate-limit reset', count: total, usable: valid,
      clears: ['Provider-defined Codex rate limits'], grantId: null, reason }]
  };
}

const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const CLEARS = new Set(['five_hour', 'seven_day', 'seven_day_overage_included']);
export function claudeResets(body, now) {
  const block = body?.cedar_ember;
  const unknown = { full: null, five: null, options: [], reason: 'Reset-grant status unavailable' };
  if (!record(block) || typeof block.eligible !== 'boolean' || !Array.isArray(block.grants ?? [])) return unknown;
  if (block.at_limit != null && typeof block.at_limit !== 'boolean') return unknown;
  for (const name of ['weekly_resets_at', 'cooldown_until']) {
    if (block[name] != null && (typeof block[name] !== 'string' || instant(block[name]) === null)) return unknown;
  }
  const options = [], seen = new Set();
  let full = 0, five = 0;
  for (const raw of block.grants ?? []) {
    if (!record(raw) || typeof raw.id !== 'string' || !GRANT_ID.test(raw.id) || seen.has(raw.id)) return unknown;
    seen.add(raw.id);
    const left = count(raw.resets_left), total = count(raw.resets_total);
    if (left === null || total === null || left > total || !Array.isArray(raw.clears ?? [])) return unknown;
    for (const name of ['paused', 'usable_now', 'use_requires_limit']) {
      if (raw[name] != null && typeof raw[name] !== 'boolean') return unknown;
    }
    for (const name of ['starts_at', 'ends_at']) if (raw[name] != null && (typeof raw[name] !== 'string' || instant(raw[name]) === null)) return unknown;
    const clears = raw.clears ?? [];
    if (clears.some(key => !CLEARS.has(key))) return unknown; // Unknown scope is not safe to offer for spending.
    const kind = clears.includes('five_hour') && clears.includes('seven_day') ? 'full' :
      clears.length === 1 && clears[0] === 'five_hour' ? 'five' : null;
    if (!kind) continue;
    if (kind === 'full') full += left; else five += left;
    if (!Number.isSafeInteger(full) || !Number.isSafeInteger(five)) return unknown;
    const reason = !block.eligible ? 'Account is not eligible' : raw.paused === true ? 'Grant is paused' :
      left === 0 ? 'No resets left' : raw.usable_now !== true ? 'Provider marks grant unavailable' :
      raw.use_requires_limit !== false && block.at_limit !== true ? 'Account must be rate-limited' :
      instant(raw.starts_at) > now ? 'Grant has not started' :
      instant(raw.ends_at) !== null && instant(raw.ends_at) <= now ? 'Grant expired' :
      instant(block.cooldown_until) > now ? 'Reset cooldown active' : null;
    // Only these two reasons end at a provider-reported instant.
    const availableAt = reason === 'Grant has not started' ? instant(raw.starts_at) :
      reason === 'Reset cooldown active' ? instant(block.cooldown_until) : null;
    options.push({
      kind, grantId: raw.id, label: text(raw.label) || (kind === 'full' ? 'Full reset' : '5-hour reset'),
      count: left, usable: reason === null, reason, availableAt, expiresAt: instant(raw.ends_at),
      clears: clears.map(key => ({ five_hour: '5-hour window', seven_day: 'Weekly window', seven_day_overage_included: 'Weekly included overage' }[key]))
    });
  }
  const waits = options.map(o => o.availableAt).filter(value => value !== null);
  return {
    full, five, options,
    // When nothing is usable now, the earliest reported instant a grant becomes usable.
    availableAt: !options.some(o => o.usable) && waits.length ? Math.min(...waits) : null,
    expirations: {
      full: resetExpirations(full, options.filter(o => o.kind === 'full')),
      five: resetExpirations(five, options.filter(o => o.kind === 'five'))
    },
    reason: !block.eligible ? 'Account is not eligible' : options.some(o => o.usable) ? null : 'No usable grant right now'
  };
}

export function averages(accounts) {
  const rank = provider => provider === 'codex' ? 0 : provider === 'claude' ? 1 : 2;
  return [...new Set(accounts.map(a => a.provider))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(provider => {
    const group = accounts.filter(a => a.provider === provider);
    const values = {};
    for (const key of ['five', 'week', 'fable']) {
      // Accounts without Fable on their plan are not part of its coverage.
      const members = key === 'fable' ? group.filter(a => a.fableAvailable !== false) : group;
      const known = members.filter(a => a.status === 'ok' && a.windows[key]?.remaining !== null && a.windows[key]?.remaining !== undefined);
      values[key] = { remaining: known.length ? known.reduce((sum, a) => sum + a.windows[key].remaining, 0) / known.length : null, reporting: known.length, total: members.length };
    }
    return { provider, total: group.length, values };
  });
}
