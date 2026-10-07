import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createDashboard } from '../src/server.js';

export const KEY = 'test-management-key-not-a-real-secret';
export async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
export async function close(server) {
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections(); await closed;
}
export async function mockProxy() {
  const state = {
    now: Date.now(), calls: [], mutations: [], credentialsFail: false, usageFail: new Set(), emptyUsage: false,
    transportDrop: false, claimResult: 'reset', credits: 2, fullLeft: 2, fiveLeft: 1, duplicateCodex: false,
    organization: '11111111-1111-4111-8111-111111111111',
    codexAccountId: 'account-codex-one', badKey: false, onMutation: null, labelPrefix: '',
    claudeUsed: { five: 100, week: 69, fable: 78 }, fableModern: true,
    subscriptionBody: { active_until: '2026-10-22T12:00:00Z' }, subscriptionFail: false,
    codexRenewal: {}, claudeProfile: null, providers: null,
    usageFailOnce: new Set(), codexFiveResetMs: 2760000, claudeCooldownUntil: null
  };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}` || state.badKey) { json(res, 401, { error: 'denied' }); return; }
    const url = new URL(req.url, 'http://test');
    if (req.method === 'GET' && url.pathname === '/v8/management/credentials') {
      if (state.credentialsFail) { json(res, 503, { error: 'unavailable' }); return; }
      json(res, 200, { files: [
        { auth_index: 'auth-codex-one', provider: 'codex', label: state.labelPrefix + 'Personal', id_token: { chatgpt_account_id: state.codexAccountId, plan_type: 'pro', ...state.codexRenewal }, access_token: 'PROVIDER_SECRET_NOT_FOR_BROWSER', refresh_token: 'REFRESH_SECRET_NOT_FOR_BROWSER' },
        { auth_index: 'auth-claude-one', provider: 'claude', label: state.labelPrefix + 'Studio' },
        { auth_index: 'auth-unsupported', provider: 'gemini', label: state.labelPrefix + 'Other provider' },
        { auth_index: 'auth-disabled', provider: 'codex', label: state.labelPrefix + 'Disabled', disabled: true },
        ...(state.duplicateCodex ? [{ auth_index: 'auth-codex-alias', provider: 'codex', label: 'Alias', id_token: { chatgpt_account_id: state.codexAccountId, plan_type: 'pro' } }] : [])
      ].filter(file => !state.providers || state.providers.includes(file.provider)) }); return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v8/management/requests/api-call') { json(res, 404, {}); return; }
    let raw = ''; for await (const part of req) raw += part;
    let call; try { call = JSON.parse(raw); } catch { json(res, 400, {}); return; }
    state.calls.push(call);
    const reply = (status, body) => json(res, 200, { status_code: status, header: {}, body: JSON.stringify(body) });
    if (call.header.Authorization !== 'Bearer $TOKEN$') { reply(400, { error: 'Token must stay in proxy' }); return; }
    if (call.method === 'POST') {
      state.mutations.push(call);
      if (state.onMutation) await state.onMutation(call);
      if (state.transportDrop) { req.socket.destroy(); return; }
      if (call.url.endsWith('/rate-limit-reset-credits/consume')) {
        if (state.codexConsumeCode) {
          if (state.codexConsumeCode === 'reset') state.credits -= 1;
          reply(200, { code: state.codexConsumeCode, windows_reset: state.codexConsumeCode === 'reset' ? 2 : 0 });
          return;
        }
        state.credits -= 1; reply(200, { ok: true }); return;
      }
      if (call.url === `https://api.anthropic.com/api/organizations/${state.organization}/reset_rate_limits`) {
        const data = JSON.parse(call.data);
        if (state.claimResult === 'reset') {
          state.claudeUsed.five = 0;
          if (data.grant_id === 'full_grant') { state.fullLeft -= 1; state.claudeUsed.week = 0; }
          if (data.grant_id === 'five_grant') state.fiveLeft -= 1;
        }
        reply(200, { result: state.claimResult }); return;
      }
      reply(400, { error: 'unexpected mutation' }); return;
    }
    if (call.url.startsWith('https://chatgpt.com/backend-api/subscriptions?')) {
      reply(state.subscriptionFail ? 503 : 200, state.subscriptionBody); return;
    }
    if (state.usageFail.has(call.authIndex)) { reply(503, { error: 'UPSTREAM_SECRET_MUST_NOT_LEAK' }); return; }
    if (state.usageFailOnce.delete(call.authIndex)) { reply(502, { error: 'transient' }); return; }
    if (call.url.endsWith('/wham/usage')) {
      if (state.holdNextUsage) {
        const gate = state.holdNextUsage; state.holdNextUsage = null;
        state.onUsageStart?.(); await gate;
      }
      if (state.emptyUsage) { reply(200, { plan_type: 'pro', rate_limit_reset_credits: { applicable_available_count: state.credits } }); return; }
      reply(200, { plan_type: 'pro', rate_limit: {
        primary_window: { used_percent: 82, limit_window_seconds: 18000, reset_at: Math.floor((state.now + state.codexFiveResetMs) / 1000) },
        secondary_window: { used_percent: 38, limit_window_seconds: 604800, reset_at: Math.floor((state.now + 194400000) / 1000) }
      }, rate_limit_reset_credits: state.usageCreditsOverride ?? { available_count: state.credits, applicable_available_count: state.credits } }); return;
    }
    if (call.url.endsWith('/rate-limit-reset-credits')) {
      if (state.creditsBodyOverride !== undefined) { reply(200, state.creditsBodyOverride); return; }
      reply(200, { available_count: state.credits, applicable_available_count: state.credits,
        credits: Array.from({ length: Math.max(0, state.credits) }, (_, i) => ({
          id: `credit-${i}`, reset_type: 'codex_rate_limits', status: 'available',
          expires_at: new Date(state.now + 86400000).toISOString()
        })) }); return;
    }
    if (call.url.includes('/api/oauth/usage')) {
      const grant = (id, left, clears) => ({
        id, label: id === 'full_grant' ? 'Full provider reset' : '5-hour reset',
        resets_total: 3, resets_left: left, starts_at: null,
        ends_at: new Date(state.now + 86400000).toISOString(),
        clears, paused: false, usable_now: left > 0, use_requires_limit: true
      });
      reply(200, {
        five_hour: { utilization: state.claudeUsed.five, resets_at: new Date(state.now + 3960000).toISOString() },
        seven_day: { utilization: state.claudeUsed.week, resets_at: new Date(state.now + 136800000).toISOString() },
        iguana_necktie: { utilization: 90, resets_at: new Date(state.now + 136800000).toISOString() },
        ...(state.fableModern ? { limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable 5' } }, is_active: true, percent: state.claudeUsed.fable, resets_at: new Date(state.now + 136800000).toISOString() }] } : {}),
        cedar_ember: {
          eligible: true, at_limit: true, next_grant_id: 'full_grant',
          cooldown_until: state.claudeCooldownUntil, weekly_resets_at: new Date(state.now + 136800000).toISOString(),
          grants: [grant('full_grant', state.fullLeft, ['five_hour', 'seven_day', 'seven_day_overage_included']), grant('five_grant', state.fiveLeft, ['five_hour'])]
        }
      }); return;
    }
    if (call.url.endsWith('/api/oauth/profile')) {
      reply(200, state.claudeProfile ?? { account: { has_claude_max: true, has_claude_pro: false }, organization: { uuid: state.organization } }); return;
    }
    reply(404, { error: 'unhandled read' });
  });
  const origin = await listen(server);
  return { state, server, origin };
}

export async function harness(t, { enableResets = true, directory, secureCookie = false, sessionTtlHours = 8 } = {}) {
  const upstream = await mockProxy();
  const dataDir = directory || fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const config = { upstream: upstream.origin, publicOrigin: 'http://127.0.0.1', secureCookie, enableResets, dataDir, sessionTtlHours };
  let application = createDashboard(config, { now: () => upstream.state.now });
  let origin = await listen(application.server); config.publicOrigin = origin;
  let cookie = '', csrf = '';
  async function call(method, route, body, options = {}) {
    const response = await fetch(origin + route, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: config.publicOrigin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) })
    });
    const value = await response.text();
    let json; try { json = JSON.parse(value); } catch { json = null; }
    return { status: response.status, headers: response.headers, text: value, body: json };
  }
  async function login() {
    const response = await call('POST', '/api/session', { managementKey: KEY });
    cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
    csrf = response.body?.csrfToken || '';
    return response;
  }
  async function restart() {
    await close(application.server);
    application = createDashboard(config, { now: () => upstream.state.now });
    origin = await listen(application.server); config.publicOrigin = origin;
    cookie = ''; csrf = '';
  }
  t.after(async () => {
    await close(application.server); await close(upstream.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { upstream, config, call, login, restart, get origin() { return origin; }, get store() { return application.store; }, dataDir };
}
