import { credential, record, text, renewalDates, codexWindows, claudeWindows, claudePlan, codexResets, claudeResets, emptyWindows } from './normalize.js';
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

async function jsonResponse(response) {
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > 5 * 1024 * 1024) throw new ProxyError('upstream_response_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProxyError('invalid_upstream_response'); }
}

export class ProxyClient {
  constructor(baseUrl, { fetchImpl = fetch, now = Date.now } = {}) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid CLIPROXY_BASE_URL');
    this.base = parsed.href.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.now = now;
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
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ProxyError('management_access_denied', 401); }
    if (response.status === 404) { await response.body?.cancel(); throw new ProxyError('v8_management_unavailable'); }
    if (!response.ok) { await response.body?.cancel(); throw new ProxyError('proxy_request_failed'); }
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
      if (body.has_more !== true) return result;
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
    if (response.status < 200 || response.status >= 300 || !response.body) throw new ProxyError('provider_read_failed');
    return response.body;
  }
  async account(key, item, previous) {
    const output = {
      id: item.id, provider: item.provider, label: item.label, plan: item.plan,
      renewal: { ...item.renewal, stale: false },
      disabled: item.disabled, status: 'unknown', observedAt: null,
      windows: emptyWindows(), extraWindows: [], resets: unknownResets(), error: null
    };
    if (item.disabled) return { view: { ...output, status: 'disabled', error: 'Credential disabled in CLIProxyAPI' }, item, resetData: null };
    if (!['codex', 'claude'].includes(item.provider)) return { view: { ...output, status: 'unsupported', error: 'Quota adapter not available for this provider' }, item, resetData: null };
    const calls = item.provider === 'codex'
      ? [this.readProvider(key, item, URLS.codexUsage), this.readProvider(key, item, URLS.codexCredits, { credits: true }),
        item.accountId ? this.readProvider(key, item, `${URLS.codexSubscription}?account_id=${encodeURIComponent(item.accountId)}`) : Promise.resolve(null)]
      : [this.readProvider(key, item, URLS.claudeUsage), this.readProvider(key, item, URLS.claudeProfile)];
    const results = await Promise.allSettled(calls);
    const [usage, secondary, subscription] = results;
    const authFailure = results.find(r => r.status === 'rejected' && r.reason.code === 'management_access_denied');
    if (authFailure) throw authFailure.reason;
    const dates = item.provider === 'codex' ? renewalDates(subscription?.value) :
      renewalDates(secondary.value?.organization);
    for (const field of ['nextAt', 'lastAt', 'startedAt']) {
      output.renewal[field] = dates[field] ?? item.renewal?.[field] ?? previous?.renewal?.[field] ?? null;
    }
    output.renewal.stale = output.renewal.nextAt !== null && dates.nextAt === null && item.renewal?.nextAt == null;
    if (usage.status === 'rejected') {
      return { view: {
        ...output,
        ...(previous ? { windows: previous.windows, extraWindows: previous.extraWindows, plan: previous.plan, observedAt: previous.observedAt } : {}),
        status: previous?.observedAt ? 'stale' : 'unavailable', error: 'Unable to read provider quota; reset disabled'
      }, item, resetData: null };
    }
    const body = usage.value;
    output.status = 'ok'; output.observedAt = this.now();
    let resetData = null;
    if (item.provider === 'codex') {
      const { windows, extras } = codexWindows(body, this.now());
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
      const profile = secondary.status === 'fulfilled' ? secondary.value : null;
      output.plan = claudePlan(profile) || item.plan;
      resetData = claudeResets(body, this.now());
      resetData.organization = UUID.test(profile?.organization?.uuid ?? '') ? profile.organization.uuid.toLowerCase() : null;
      resetData.nextGrantId = text(body.cedar_ember?.next_grant_id, 40);
      if (!resetData.organization) resetData.options.forEach(o => { o.usable = false; o.reason = 'Organization identity not reported'; });
    }
    output.resets = this.publicResets(resetData);
    if (Object.values(output.windows).every(w => w.remaining === null)) {
      output.status = 'unavailable';
      output.error = 'No supported quota percentages were reported';
    }
    const identity = item.provider === 'codex' ? item.accountId : resetData?.organization;
    const scopeId = identity ? createHash('sha256').update(`${item.provider}\0${identity}`).digest('hex').slice(0, 24) : item.id;
    return { view: output, item, resetData, scopeId };
  }
  publicResets(data) {
    return {
      full: data?.full ?? null, five: data?.five ?? null,
      expirations: data?.expirations ?? { full: [], five: [] },
      usable: { full: data?.options.some(o => o.kind === 'full' && o.usable) ?? false, five: data?.options.some(o => o.kind === 'five' && o.usable) ?? false },
      reason: data?.reason ?? null,
      // Labels/scopes are display data; the browser never submits a grant ID or organization.
      options: (data?.options ?? []).map(o => ({ kind: o.kind, label: o.label, count: o.count, usable: o.usable, reason: o.reason, clears: o.clears }))
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
