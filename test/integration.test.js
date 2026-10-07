import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, KEY } from './helpers.js';
import { ResetStore } from '../src/reset-store.js';
import { randomUUID } from 'node:crypto';

async function signedIn(t, options) {
  const h = await harness(t, options);
  assert.equal((await h.login()).status, 200);
  const result = await h.call('GET', '/api/dashboard');
  assert.equal(result.status, 200);
  return { ...h, dashboard: result.body };
}
const account = (data, provider) => data.accounts.find(a => a.provider === provider && a.status === 'ok');
const prepare = (h, id, kind = 'full') => h.call('POST', `/api/accounts/${id}/reset/prepare`, { kind });
const confirm = (h, id, operationId) => h.call('POST', `/api/accounts/${id}/reset`, { operationId });

test('sign-in is required; key stays server-side; cookie/CSRF/origin boundaries work', async t => {
  const h = await harness(t);
  assert.equal((await h.call('GET', '/api/dashboard')).status, 401);
  const wrongOrigin = await h.call('POST', '/api/session', { managementKey: KEY }, { headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(h.upstream.state.calls.length, 0);
  const login = await h.login();
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal(login.text.includes(KEY), false);
  const data = await h.call('GET', '/api/dashboard');
  assert.equal(data.status, 200);
  for (const secret of [KEY, 'PROVIDER_SECRET_NOT_FOR_BROWSER', 'REFRESH_SECRET_NOT_FOR_BROWSER', 'auth-codex-one', 'Bearer $TOKEN$']) {
    assert.equal(data.text.includes(secret), false, secret);
  }
  assert.equal(data.body.accounts.length, 4);
  const codex = account(data.body, 'codex'), claude = account(data.body, 'claude');
  assert.equal(codex.windows.five.remaining, 18); assert.equal(codex.windows.week.remaining, 62);
  assert.equal(claude.windows.fable.remaining, 22); assert.equal(claude.plan, 'Max');
  assert.equal(data.body.accounts.find(a => a.provider === 'gemini').status, 'unsupported');
  assert.ok(h.upstream.state.calls.every(c => !['auth-disabled', 'auth-unsupported'].includes(c.authIndex)));
  assert.equal((await h.call('POST', `/api/accounts/${codex.id}/reset/prepare`, { kind: 'full' }, { headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
  assert.equal((await h.call('POST', '/api/logout', {})).status, 200);
  assert.equal((await h.call('GET', '/api/dashboard')).status, 401);
});

test('read-only is the default deployment mode and cannot consume resets', async t => {
  const h = await signedIn(t, { enableResets: false });
  const a = account(h.dashboard, 'codex');
  assert.equal(a.resets.enabled, false);
  assert.equal(a.resets.full, 2);
  assert.equal((await prepare(h, a.id)).status, 403);
  assert.equal(h.upstream.state.mutations.length, 0);
});
test('renewal metadata is account-bound, read-only and distinct from quota resets', async t => {
  const h = await harness(t);
  h.upstream.state.codexAccountId = 'account /?&';
  h.upstream.state.codexRenewal = { chatgpt_subscription_active_start: '2025-01-22T12:00:00Z' };
  h.upstream.state.subscriptionBody = { active_until: '2026-10-22T12:00:00Z', last_renewal_at: '2026-09-22T12:00:00Z', secret: 'BILLING_SECRET' };
  h.upstream.state.claudeProfile = { account: { has_claude_max: true, created_at: '2020-01-01' }, organization: {
    uuid: h.upstream.state.organization, subscription_created_at: '2026-07-12T12:00:00Z'
  } };
  await h.login();
  const response = await h.call('GET', '/api/dashboard');
  const codex = account(response.body, 'codex'), claude = account(response.body, 'claude');
  assert.deepEqual(codex.renewal, { nextAt: Date.parse('2026-10-22T12:00:00Z'), lastAt: Date.parse('2026-09-22T12:00:00Z'),
    startedAt: Date.parse('2025-01-22T12:00:00Z'), stale: false });
  assert.deepEqual(claude.renewal, { nextAt: null, lastAt: null, startedAt: Date.parse('2026-07-12T12:00:00Z'), stale: false });
  assert.equal(response.text.includes('BILLING_SECRET'), false);
  const reads = h.upstream.state.calls.filter(call => call.url.includes('/subscriptions?'));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].url, 'https://chatgpt.com/backend-api/subscriptions?account_id=account%20%2F%3F%26');
  assert.equal(reads[0].header['Chatgpt-Account-Id'], h.upstream.state.codexAccountId);
  assert.equal(reads[0].method, 'GET');
  assert.equal(h.upstream.state.mutations.length, 0);
});
test('optional subscription failures retain dates as last-known without disabling valid resets', async t => {
  const h = await signedIn(t);
  const before = account(h.dashboard, 'codex');
  h.upstream.state.subscriptionFail = true; h.upstream.state.now += 4000;
  const data = (await h.call('GET', '/api/dashboard')).body;
  const after = account(data, 'codex');
  assert.equal(after.renewal.nextAt, before.renewal.nextAt);
  assert.equal(after.renewal.stale, true);
  assert.equal(after.status, 'ok'); assert.equal(after.resets.usable.full, true);
  assert.equal(h.upstream.state.mutations.length, 0);
});
test('subscription failures fall back to credential expiry and missing identities skip the billing request', async t => {
  const h = await harness(t);
  h.upstream.state.subscriptionFail = true;
  h.upstream.state.codexRenewal = { chatgpt_subscription_active_until: '2026-10-22T12:00:00Z' };
  await h.login();
  const data = (await h.call('GET', '/api/dashboard')).body;
  assert.equal(account(data, 'codex').renewal.nextAt, Date.parse('2026-10-22T12:00:00Z'));
  assert.equal(account(data, 'codex').renewal.stale, false);
  h.upstream.state.codexAccountId = ''; h.upstream.state.now += 4000;
  h.upstream.state.calls.length = 0;
  await h.call('GET', '/api/dashboard');
  assert.equal(h.upstream.state.calls.some(call => call.url.includes('/subscriptions?')), false);
  assert.equal(h.upstream.state.mutations.length, 0);
});
test('dashboard provider averages hide providers when their accounts are absent', async t => {
  const h = await harness(t);
  h.upstream.state.providers = ['claude'];
  await h.login();
  let data = (await h.call('GET', '/api/dashboard')).body;
  assert.deepEqual(data.summaries.map(group => group.provider), ['claude']);
  h.upstream.state.providers = []; h.upstream.state.now += 4000;
  data = (await h.call('GET', '/api/dashboard')).body;
  assert.deepEqual(data.summaries, []); assert.deepEqual(data.accounts, []);
});
test('dashboard projects per-scope expiry groups without exposing provider credit IDs', async t => {
  const h = await signedIn(t), now = h.upstream.state.now;
  const codex = account(h.dashboard, 'codex'), claude = account(h.dashboard, 'claude');
  assert.deepEqual(codex.resets.expirations, { full: [{ count: 2, expiresAt: now + 86400000 }], five: [] });
  assert.deepEqual(claude.resets.expirations, {
    full: [{ count: 2, expiresAt: now + 86400000 }], five: [{ count: 1, expiresAt: now + 86400000 }]
  });
  h.upstream.state.creditsBodyOverride = { available_count: 3, credits: [
    { id: 'PRIVATE_CREDIT_ID', reset_type: 'codex_rate_limits', status: 'available', expires_at: now + 2 * 86400000 }
  ] };
  h.upstream.state.now += 4000;
  const response = await h.call('GET', '/api/dashboard');
  assert.deepEqual(account(response.body, 'codex').resets.expirations.full, [
    { count: 1, expiresAt: now + 2 * 86400000 }, { count: 2, expiresAt: null }
  ]);
  assert.equal(response.text.includes('PRIVATE_CREDIT_ID'), false);
  assert.equal(account(response.body, 'codex').resets.usable.full, true);
  assert.equal(h.upstream.state.mutations.length, 0);
});

test('Codex usage totals supplement missing details; a zero banked count still refuses reset', async t => {
  const h = await harness(t);
  h.upstream.state.creditsBodyOverride = { credits: null };
  await h.login();
  let data = (await h.call('GET', '/api/dashboard')).body;
  const a = account(data, 'codex');
  assert.equal(a.resets.full, 2);
  assert.equal(a.resets.usable.full, true);
  assert.equal((await prepare(h, a.id)).status, 200);
  assert.equal(h.upstream.state.mutations.length, 0);

  h.upstream.state.creditsBodyOverride = { available_count: 2, credits: [] };
  h.upstream.state.usageCreditsOverride = { availableCount: 2, applicableAvailableCount: 0 };
  h.upstream.state.now += 4000;
  data = (await h.call('GET', '/api/dashboard')).body;
  const available = account(data, 'codex');
  assert.equal(available.resets.full, 2);
  assert.equal(available.resets.usable.full, true);
  assert.equal((await prepare(h, a.id)).status, 200);
  h.upstream.state.creditsBodyOverride = { available_count: 0, credits: [] };
  h.upstream.state.now += 4000;
  data = (await h.call('GET', '/api/dashboard')).body;
  assert.equal(account(data, 'codex').resets.full, 0);
  assert.equal(account(data, 'codex').resets.usable.full, false);
  assert.equal((await prepare(h, a.id)).status, 409);
  assert.equal(h.upstream.state.mutations.length, 0);
});

test('Codex terminal outcomes are reported accurately without automatic retries', async t => {
  for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed', 'unrecognized']) {
    const h = await signedIn(t);
    h.upstream.state.codexConsumeCode = code;
    const a = account(h.dashboard, 'codex');
    const p = await prepare(h, a.id);
    const result = await confirm(h, a.id, p.body.operationId);
    assert.equal(result.body.outcome, code === 'unrecognized' ? 'unknown' : code);
    assert.equal(result.body.state, code === 'unrecognized' ? 'unknown' : 'settled');
    assert.equal(h.upstream.state.mutations.length, 1);
    await confirm(h, a.id, p.body.operationId);
    assert.equal(h.upstream.state.mutations.length, 1);
  }
});

test('Codex consume targets exactly one credential and duplicate confirmation is idempotent', async t => {
  const h = await signedIn(t);
  const a = account(h.dashboard, 'codex');
  const prepared = await prepare(h, a.id);
  assert.equal(prepared.status, 200);
  assert.equal(h.upstream.state.mutations.length, 0, 'Preparation must only read');
  const first = await confirm(h, a.id, prepared.body.operationId);
  assert.equal(first.body.state, 'settled'); assert.equal(first.body.outcome, 'accepted');
  const duplicate = await confirm(h, a.id, prepared.body.operationId);
  assert.deepEqual(duplicate.body, first.body);
  assert.equal(h.upstream.state.mutations.length, 1);
  const sent = h.upstream.state.mutations[0];
  assert.equal(sent.authIndex, 'auth-codex-one');
  assert.equal(sent.url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  assert.equal(sent.header['Chatgpt-Account-Id'], 'account-codex-one');
  assert.match(JSON.parse(sent.data).redeem_request_id, /^[a-f0-9-]{36}$/);
  assert.equal(h.upstream.state.fullLeft, 2, 'Claude credits must stay unchanged');
  const refreshed = await h.call('GET', '/api/dashboard');
  assert.equal(account(refreshed.body, 'codex').resets.full, 1);
  assert.equal(account(refreshed.body, 'codex').windows.five.remaining, 18, 'Never optimistically invent 100% allowance');
  assert.equal(account(refreshed.body, 'codex').lastReset.outcome, 'accepted');
  const journal = fs.readFileSync(path.join(h.dataDir, 'reset-operations.json'), 'utf8');
  assert.equal(journal.includes(KEY), false);
  assert.equal(journal.includes('auth-codex-one'), false);
});

test('Claude 5h reset uses the exact grant/org and leaves weekly/Fable untouched', async t => {
  const h = await signedIn(t);
  const a = account(h.dashboard, 'claude');
  assert.equal(a.resets.full, 2); assert.equal(a.resets.five, 1);
  const prepared = await prepare(h, a.id, 'five');
  assert.deepEqual(prepared.body.clears, ['5-hour window']);
  const result = await confirm(h, a.id, prepared.body.operationId);
  assert.equal(result.body.outcome, 'reset');
  const sent = h.upstream.state.mutations[0], body = JSON.parse(sent.data);
  assert.equal(sent.authIndex, 'auth-claude-one');
  assert.equal(sent.url, `https://api.anthropic.com/api/organizations/${h.upstream.state.organization}/reset_rate_limits`);
  assert.equal(body.program, 'cedar_ember'); assert.equal(body.grant_id, 'five_grant');
  assert.match(body.request_id, /^[a-f0-9-]{36}$/);
  const data = (await h.call('GET', '/api/dashboard')).body;
  const updated = account(data, 'claude');
  assert.equal(updated.windows.five.remaining, 100);
  assert.equal(updated.windows.week.remaining, a.windows.week.remaining);
  assert.equal(updated.windows.fable.remaining, a.windows.fable.remaining);
  assert.equal(updated.resets.five, 0);
  assert.equal(h.upstream.state.credits, 2);
});

test('full Claude grant does not claim Fable is included when the provider omits it', async t => {
  const h = await signedIn(t), a = account(h.dashboard, 'claude');
  const p = await prepare(h, a.id);
  assert.deepEqual(p.body.clears, ['5-hour window', 'Weekly window', 'Weekly included overage']);
  await confirm(h, a.id, p.body.operationId);
  const updated = account((await h.call('GET', '/api/dashboard')).body, 'claude');
  assert.equal(updated.windows.week.remaining, 100);
  assert.equal(updated.windows.fable.remaining, a.windows.fable.remaining);
});

test('bulk targets, scope changes, arbitrary proxy URLs and cross-account confirmations are refused', async t => {
  const h = await signedIn(t), a = account(h.dashboard, 'codex'), b = account(h.dashboard, 'claude');
  assert.equal((await prepare(h, 'all')).status, 404);
  assert.equal((await prepare(h, a.id, 'all')).status, 400);
  assert.equal((await h.call('POST', `/api/accounts/${a.id}/reset/prepare`, { kind: 'full', url: 'http://metadata.invalid/' })).status, 400);
  const p = await prepare(h, a.id);
  assert.equal((await confirm(h, b.id, p.body.operationId)).status, 409);
  assert.equal((await h.call('POST', `/api/accounts/${a.id}/reset`, { operationId: p.body.operationId, kind: 'five' })).status, 400);
  assert.equal(h.upstream.state.mutations.length, 0);
});

test('expired confirmation, changed identity and changed eligibility never send a mutation', async t => {
  const h = await signedIn(t), a = account(h.dashboard, 'codex');
  let p = await prepare(h, a.id);
  h.upstream.state.now += 61000;
  assert.equal((await confirm(h, a.id, p.body.operationId)).status, 409);
  p = await prepare(h, a.id);
  h.upstream.state.codexAccountId = 'different-account';
  const identity = await confirm(h, a.id, p.body.operationId);
  assert.equal(identity.body.error, 'account_identity_changed');
  p = await prepare(h, a.id);
  h.upstream.state.credits = 1;
  const changed = await confirm(h, a.id, p.body.operationId);
  assert.equal(changed.body.error, 'eligibility_changed');
  assert.equal(h.upstream.state.mutations.length, 0);
});

test('unknown outcome is durable across restart and requires explicit review, never a retry', async t => {
  const h = await harness(t);
  await h.login();
  const a = account((await h.call('GET', '/api/dashboard')).body, 'codex');
  const p = await prepare(h, a.id);
  h.upstream.state.transportDrop = true;
  const lost = await confirm(h, a.id, p.body.operationId);
  assert.equal(lost.body.state, 'unknown');
  assert.equal(h.upstream.state.mutations.length, 1);
  assert.equal((await prepare(h, a.id)).status, 409);
  await h.restart(); await h.login();
  let data = (await h.call('GET', '/api/dashboard')).body;
  assert.equal(account(data, 'codex').resets.operation.state, 'unknown');
  assert.equal(account(data, 'codex').resets.enabled, false);
  assert.equal((await prepare(h, a.id)).status, 409);
  const reviewRoute = `/api/accounts/${a.id}/reset/review`;
  assert.equal((await h.call('POST', reviewRoute, { operationId: p.body.operationId, acknowledge: false })).status, 400);
  assert.equal((await h.call('POST', reviewRoute, { operationId: p.body.operationId, acknowledge: true })).status, 200);
  assert.equal(h.upstream.state.mutations.length, 1, 'Review must not re-send');
  h.upstream.state.transportDrop = false;
  assert.equal((await prepare(h, a.id)).status, 200);
  data = (await h.call('GET', '/api/dashboard')).body;
  assert.equal(account(data, 'codex').lastReset.state, 'reviewed');
});

test('a persisted in-flight write becomes unknown after process restart', async t => {
  const h = await signedIn(t), a = account(h.dashboard, 'codex');
  const id = randomUUID();
  h.store.begin({ id, accountId: a.id, kind: 'full', requestId: randomUUID() });
  const recovered = new ResetStore(h.dataDir, () => h.upstream.state.now);
  assert.equal(recovered.get(id).state, 'unknown');
  assert.ok(recovered.blocked(a.id));
});

test('simultaneous confirmation does not spend twice', async t => {
  const h = await signedIn(t), a = account(h.dashboard, 'codex');
  const p = await prepare(h, a.id);
  let release, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.upstream.state.onMutation = async () => { started(); await gate; };
  const first = confirm(h, a.id, p.body.operationId);
  await startedPromise;
  const second = await confirm(h, a.id, p.body.operationId);
  assert.equal(second.status, 202);
  assert.equal(second.body.state, 'pending');
  release(); assert.equal((await first).status, 200);
  assert.equal(h.upstream.state.mutations.length, 1);
});

test('stale snapshots preserve last known data but disable resets and exclude averages', async t => {
  const h = await signedIn(t), a = account(h.dashboard, 'codex');
  h.upstream.state.now += 4000;
  h.upstream.state.usageFail.add('auth-codex-one');
  const stale = (await h.call('GET', '/api/dashboard')).body;
  const old = stale.accounts.find(x => x.id === a.id);
  assert.equal(old.status, 'stale'); assert.equal(old.windows.five.remaining, 18);
  assert.equal(old.resets.enabled, false);
  assert.equal(stale.summaries.find(g => g.provider === 'codex').values.five.remaining, null);
  assert.equal(JSON.stringify(stale).includes('UPSTREAM_SECRET_MUST_NOT_LEAK'), false);
  h.upstream.state.credentialsFail = true; h.upstream.state.now += 4000;
  assert.equal((await h.call('GET', '/api/dashboard')).body.error, 'proxy_unavailable');
});

test('session expiry, login throttling and revoked management key are enforced', async t => {
  const h = await harness(t);
  for (let i = 0; i < 5; i++) assert.equal((await h.call('POST', '/api/session', { managementKey: 'wrong' })).status, 401);
  assert.equal((await h.call('POST', '/api/session', { managementKey: KEY })).status, 429);
  h.upstream.state.now += 61000;
  assert.equal((await h.login()).status, 200);
  h.upstream.state.now += 8 * 60 * 60 * 1000 + 1;
  assert.equal((await h.call('GET', '/api/dashboard')).status, 401);
  await h.login(); h.upstream.state.badKey = true;
  assert.equal((await h.call('GET', '/api/dashboard')).status, 401);
  assert.equal((await h.call('GET', '/api/session')).body.authenticated, false);
});
test('seven-day sessions match cookie lifetime and expire at the absolute boundary', async t => {
  const h = await harness(t, { sessionTtlHours: 168, secureCookie: true });
  const status = await h.call('GET', '/api/session');
  assert.equal(status.body.sessionTtlHours, 168); assert.equal(status.body.authenticated, false);
  const startedAt = h.upstream.state.now, login = await h.login();
  assert.match(login.headers.get('set-cookie'), /Max-Age=604800/);
  assert.match(login.headers.get('set-cookie'), /__Host-cliproxy_dashboard_session=/);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  h.upstream.state.now = startedAt + 8 * 3600000 + 1;
  assert.equal((await h.call('GET', '/api/dashboard')).status, 200);
  h.upstream.state.now = startedAt + 168 * 3600000 - 1;
  assert.equal((await h.call('GET', '/api/session')).body.authenticated, true);
  h.upstream.state.now += 1;
  assert.equal((await h.call('GET', '/api/dashboard')).status, 401);
  assert.equal((await h.call('GET', '/api/session')).body.authenticated, false);
});
test('long sessions still end on sign-out, restart and upstream key revocation', async t => {
  const h = await harness(t, { sessionTtlHours: 168 });
  await h.login();
  const logout = await h.call('POST', '/api/logout', {});
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await h.call('GET', '/api/dashboard')).status, 401);
  await h.login(); await h.restart();
  assert.equal((await h.call('GET', '/api/session')).body.authenticated, false);
  await h.login(); h.upstream.state.badKey = true;
  assert.equal((await h.call('GET', '/api/dashboard')).status, 401);
  assert.equal((await h.call('GET', '/api/session')).body.authenticated, false);
});

test('static serving is allowlisted and security headers are present', async t => {
  const h = await harness(t);
  const page = await h.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.text, /rel="icon" type="image\/svg\+xml" href="favicon.svg"/);
  const icon = await h.call('GET', '/favicon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
  assert.match(icon.text, /viewBox="0 0 32 32"/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.text, /<form id="login-form" method="post">/, 'A non-JavaScript submission must never put the management key in a URL');
  for (const url of ['/.env', '/src/server.js', '/.data/reset-operations.json', '/management.html']) {
    assert.notEqual((await h.call('GET', url)).status, 200);
  }
});
