import { credential, record, text, renewalDates, codexWindows, claudeWindows, claudePlan, claudeFableAvailable, codexResets, claudeResets, emptyWindows } from './normalize.js';
import { createHash } from 'node:crypto';

export class ProxyError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
const URLS = {
  codexUsage: 'https://chatgpt.com/backend-api/wham/usage',
  codexSubscription: 'https://chatgpt.com/backend-api/subscriptions',
  codexCredits: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  codexConsume: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
  claudeUsage: 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1',
  claudeProfile: 'https://api.anthropic.com/api/oauth/profile'
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT = /^[a-z0-9_-]{1,40}$/;
const unknownResets = () => ({ full: null, five: null, options: [], reason: 'Reset availability not reported' });
// Last good quota reading per credential, displayed as stale for a bounded time.
export const USAGE_CACHE_MS = 15 * 60 * 1000;
const USAGE_RETRY_MS = 750;
// Provider reads fail intermittently; these failures are worth one more attempt.
const transientRead = error => error instanceof ProxyError && (
  ['proxy_unreachable', 'invalid_api_call_response', 'invalid_upstream_response'].includes(error.code) ||
  (['proxy_request_failed', 'provider_read_failed'].includes(error.code) && (error.upstreamStatus === null || error.upstreamStatus === 0 ||
    error.upstreamStatus === 408 || error.upstreamStatus === 429 || error.upstreamStatus >= 500 && error.upstreamStatus < 600)));

async function jsonResponse(response) {
  let length = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 5 * 1024 * 1024) throw new ProxyError('upstream_response_too_large');
      chunks.push(chunk);
    }
  } catch (error) { throw error instanceof ProxyError ? error : new ProxyError('proxy_unreachable'); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProxyError('invalid_upstream_response'); }
}

export class ProxyClient {
  constructor(baseUrl, { fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid CLIPROXY_BASE_URL');
    this.base = parsed.href.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.usageCache = new Map();
    this.usageEpoch = 0;
  }
  // A cached reading is accurate only for the same credential identity, for a
  // bounded age, and until one of its windows resets.
  cachedUsage(item) {
    const entry = this.usageCache.get(item.id);
    if (!entry || entry.fingerprint !== item.fingerprint || item.disabled) return null;
    const now = this.now();
    const resetPassed = [...Object.values(entry.windows), ...entry.extraWindows].some(w => w?.resetAt != null && w.resetAt <= now);
    if (now < entry.observedAt || now - entry.observedAt >= USAGE_CACHE_MS || resetPassed) {
      this.usageCache.delete(item.id);
      return null;
    }
    return entry;
  }
  // Drop readings for credentials no longer returned by the proxy.
  retainUsage(items) {
    const active = new Map(items.filter(item => !item.disabled).map(item => [item.id, item]));
    for (const [id, entry] of this.usageCache) {
      if (active.get(id)?.fingerprint !== entry.fingerprint) this.invalidateUsage(id);
    }
  }
  // A provider reset changes usage for every credential sharing that scope.
  invalidateUsage(scopeId) {
    // Resets are rare; discard overlapping reads rather than refill an invalidated cache.
    this.usageEpoch += 1;
    for (const [id, entry] of this.usageCache) if (entry.scopeId === scopeId || id === scopeId) this.usageCache.delete(id);
  }
  staleAccount(account) {
    const { item, view } = account;
    const entry = this.cachedUsage(item);
    const cached = !account.scopeId || entry?.scopeId === account.scopeId ? entry : null;
    const inactive = ['disabled', 'unsupported'].includes(view.status);
    return {
      ...account, resetData: null, usage: cached, scopeId: cached?.scopeId || account.scopeId || item.id,
      view: {
        ...view, plan: cached?.plan ?? item.plan, observedAt: cached?.observedAt ?? null,
        windows: cached?.windows ?? emptyWindows(), extraWindows: cached?.extraWindows ?? [],
        fableAvailable: cached?.fableAvailable, resets: unknownResets(),
        status: inactive ? view.status : cached ? 'stale' : 'unavailable',
        error: inactive ? view.error : cached
          ? 'Live quota read failed; showing cached values; reset disabled'
          : 'Unable to read provider quota; reset disabled'
      }
    };
  }
  async readUsage(key, item, url) {
    try { return await this.readProvider(key, item, url); } catch (error) {
      if (!transientRead(error)) throw error;
      await this.sleep(USAGE_RETRY_MS);
      return this.readProvider(key, item, url);
    }
  }
  async management(key, path, body) {
    let response;
    try {
      response = await this.fetch(this.base + '/v8/management' + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch { throw new ProxyError('proxy_unreachable'); }
    if (response.status === 401 || response.status === 403) {
      this.usageCache.clear(); this.usageEpoch += 1;
      await response.body?.cancel(); throw new ProxyError('management_access_denied', 401);
    }
    if (response.status === 404) { await response.body?.cancel(); throw new ProxyError('v8_management_unavailable'); }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new ProxyError('proxy_request_failed');
      error.upstreamStatus = response.status;
      throw error;
    }
    return jsonResponse(response);
  }
  async credentials(key) {
    const result = [], seen = new Set();
    for (let page = 1; page <= 10; page += 1) {
      const body = await this.management(key, `/credentials?page=${page}&page_size=100`);
      if (!record(body) || !Array.isArray(body.files)) throw new ProxyError('invalid_credential_list');
      for (const file of body.files) {
        const item = credential(file);
        if (!item) throw new ProxyError('invalid_credential_list');
        if (seen.has(item.id)) throw new ProxyError('ambiguous_credential_identity');
        seen.add(item.id); result.push(item);
      }
      if (result.length > 500) throw new ProxyError('too_many_accounts');
      if (body.has_more !== true) { this.retainUsage(result); return result; }
    }
    throw new ProxyError('credential_pagination_limit');
  }
  headers(item, credits = false) {
    if (item.provider === 'claude') return {
      Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
      'User-Agent': 'claude-cli/2.1.280 (external, cli)', 'anthropic-beta': 'oauth-2025-04-20'
    };
    return {
      Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
      'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
      ...(item.accountId ? { 'Chatgpt-Account-Id': item.accountId } : {}),
      ...(credits ? { Accept: 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop' } : {})
    };
  }
  async provider(key, item, url, { method = 'GET', data, credits = false } = {}) {
    // Only callers in this module select URLs. No browser-supplied URL/header is forwarded.
    const envelope = await this.management(key, '/requests/api-call', {
      authIndex: item.authIndex, method, url, header: this.headers(item, credits),
      ...(data === undefined ? {} : { data: JSON.stringify(data) })
    });
    if (!record(envelope) || !Number.isInteger(envelope.status_code)) throw new ProxyError('invalid_api_call_response');
    let body = envelope.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    return { status: envelope.status_code, body: record(body) ? body : null };
  }
  async readProvider(key, item, url, options) {
    const response = await this.provider(key, item, url, options);
    if (response.status < 200 || response.status >= 300 || !response.body) {
      const error = new ProxyError('provider_read_failed');
      error.upstreamStatus = response.status >= 200 && response.status < 300 ? null : response.status;
      throw error;
    }
    return response.body;
  }
  async account(key, item, previousAccount) {
    const existing = this.usageCache.get(item.id);
    if (existing && (existing.fingerprint !== item.fingerprint || item.disabled)) this.invalidateUsage(item.id);
    const epoch = this.usageEpoch, observedAt = this.now();
    const output = {
      id: item.id, provider: item.provider, label: item.label, plan: item.plan,
      renewal: { ...item.renewal, stale: false },
      disabled: item.disabled, status: 'unknown', observedAt: null,
      windows: emptyWindows(), extraWindows: [], resets: unknownResets(), error: null
    };
    if (item.disabled) return { view: { ...output, status: 'disabled', error: 'Credential disabled in CLIProxyAPI' }, item, resetData: null };
    if (!['codex', 'claude'].includes(item.provider)) return { view: { ...output, status: 'unsupported', error: 'Quota adapter not available for this provider' }, item, resetData: null };
    const calls = item.provider === 'codex'
      ? [this.readUsage(key, item, URLS.codexUsage), this.readProvider(key, item, URLS.codexCredits, { credits: true }),
        item.accountId ? this.readProvider(key, item, `${URLS.codexSubscription}?account_id=${encodeURIComponent(item.accountId)}`) : Promise.resolve(null)]
      : [this.readUsage(key, item, URLS.claudeUsage), this.readProvider(key, item, URLS.claudeProfile)];
    const results = await Promise.allSettled(calls);
    const [usage, secondary, subscription] = results;
    const authFailure = results.find(r => r.status === 'rejected' && r.reason.code === 'management_access_denied');
    if (authFailure) throw authFailure.reason;
    if (usage.status === 'rejected' && (!transientRead(usage.reason) ||
        results.some(r => r.status === 'rejected' && [401, 403].includes(r.reason.upstreamStatus)))) {
      this.invalidateUsage(item.id);
      return this.staleAccount({ view: output, item });
    }
    if (epoch !== this.usageEpoch) return this.staleAccount({ view: output, item, scopeId: existing?.scopeId || item.id });
    const profile = item.provider === 'claude' && secondary.status === 'fulfilled' ? secondary.value : null;
    const organization = UUID.test(profile?.organization?.uuid ?? '') ? profile.organization.uuid.toLowerCase() : null;
    const identity = item.provider === 'codex' ? item.accountId : organization;
    const cached = this.cachedUsage(item);
    const scopeId = identity ? createHash('sha256').update(`${item.provider}\0${identity}`).digest('hex').slice(0, 24)
      : item.provider === 'claude' && secondary.status === 'rejected' ? cached?.scopeId || item.id : item.id;
    if (cached && cached.scopeId !== scopeId) this.invalidateUsage(item.id);
    const previous = previousAccount?.item.fingerprint === item.fingerprint && previousAccount.scopeId === scopeId ? previousAccount.view : null;
    const dates = item.provider === 'codex' ? renewalDates(subscription?.value) :
      renewalDates(secondary.value?.organization);
    for (const field of ['nextAt', 'lastAt', 'startedAt']) {
      output.renewal[field] = dates[field] ?? item.renewal?.[field] ?? previous?.renewal?.[field] ?? null;
    }
    output.renewal.stale = output.renewal.nextAt !== null && dates.nextAt === null && item.renewal?.nextAt == null;
    if (usage.status === 'rejected') {
      return this.staleAccount({ view: output, item, scopeId });
    }
    const body = usage.value;
    output.status = 'ok'; output.observedAt = observedAt;
    let resetData = null;
    if (item.provider === 'codex') {
      const { windows, extras } = codexWindows(body, observedAt);
      output.windows = windows; output.extraWindows = extras;
      output.plan = text(body.plan_type ?? body.planType, 60) || item.plan;
      const details = secondary.status === 'fulfilled' ? secondary.value : {};
      const embeddedValue = body.rate_limit_reset_credits ?? body.rateLimitResetCredits;
      const embedded = record(embeddedValue) ? embeddedValue : {};
      const raw = {
        available_count: details.available_count ?? details.availableCount ?? embedded.available_count ?? embedded.availableCount,
        credits: details.credits ?? embedded.credits
      };
      resetData = codexResets(raw, this.now());
      if (!item.accountId) {
        resetData.reason = 'Account identity not reported';
        resetData.options.forEach(o => { o.usable = false; o.reason = resetData.reason; });
      }
    } else {
      output.windows = claudeWindows(body);
      output.plan = claudePlan(profile) || item.plan;
      output.fableAvailable = claudeFableAvailable(profile, output.windows);
      if (!output.fableAvailable) output.windows.fable = { remaining: null, resetAt: null };
      resetData = claudeResets(body, this.now());
      resetData.organization = organization;
      resetData.nextGrantId = text(body.cedar_ember?.next_grant_id, 40);
      if (!resetData.organization) resetData.options.forEach(o => { o.usable = false; o.reason = 'Organization identity not reported'; });
    }
    output.resets = this.publicResets(resetData);
    if (Object.values(output.windows).every(w => w.remaining === null)) {
      output.status = 'unavailable';
      output.error = 'No supported quota percentages were reported';
    }
    let usageEntry = null;
    if (output.status === 'ok') {
      usageEntry = {
        fingerprint: item.fingerprint, scopeId, observedAt: output.observedAt, plan: output.plan,
        windows: output.windows, extraWindows: output.extraWindows, fableAvailable: output.fableAvailable
      };
      this.usageCache.set(item.id, usageEntry);
      if (!this.cachedUsage(item)) return this.staleAccount({ view: output, item, scopeId });
    } else this.invalidateUsage(item.id);
    return { view: output, item, resetData, scopeId, usage: usageEntry };
  }
  publicResets(data) {
    return {
      full: data?.full ?? null, five: data?.five ?? null,
      expirations: data?.expirations ?? { full: [], five: [] },
      usable: { full: data?.options.some(o => o.kind === 'full' && o.usable) ?? false, five: data?.options.some(o => o.kind === 'five' && o.usable) ?? false },
      reason: data?.reason ?? null, availableAt: data?.availableAt ?? null,
      // Labels/scopes are display data; the browser never submits a grant ID or organization.
      options: (data?.options ?? []).map(o => ({ kind: o.kind, label: o.label, count: o.count, usable: o.usable, reason: o.reason, availableAt: o.availableAt ?? null, clears: o.clears }))
    };
  }
  chooseReset(account, kind) {
    const candidates = account.resetData?.options.filter(o => o.kind === kind && o.usable) ?? [];
    return candidates.find(o => o.grantId === account.resetData.nextGrantId) ||
      candidates.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0] || null;
  }
  async redeem(key, account, option, requestId) {
    // A mutation is issued exactly once. Unknown outcomes are resolved by the durable operation ledger.
    try {
      let response;
      if (account.item.provider === 'codex' && option.kind === 'full') {
        response = await this.provider(key, account.item, URLS.codexConsume, {
          method: 'POST', data: { redeem_request_id: requestId }
        });
        if (response.status >= 200 && response.status < 300) {
          const code = response.body?.code;
          if (code == null) return 'accepted'; // Older endpoints acknowledged by status only.
          return ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(code) ? code : 'unknown';
        }
      } else if (account.item.provider === 'claude' && UUID.test(account.resetData.organization ?? '') && GRANT.test(option.grantId ?? '')) {
        response = await this.provider(key, account.item,
          `https://api.anthropic.com/api/organizations/${account.resetData.organization}/reset_rate_limits`, {
            method: 'POST', data: { program: 'cedar_ember', grant_id: option.grantId, request_id: requestId }
          });
        const terminal = ['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable'];
        if (response.status >= 200 && response.status < 300 && terminal.includes(response.body?.result)) return response.body.result;
      } else return 'unavailable';
      if (response.status === 401 || response.status === 403) return 'auth_error';
      if (response.status === 429) return 'rate_limited';
      return 'unknown';
    } catch (error) {
      return error.code === 'management_access_denied' ? 'auth_error' : 'unknown';
    }
  }
}
