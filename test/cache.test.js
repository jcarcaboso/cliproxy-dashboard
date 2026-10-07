import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { ProxyClient, USAGE_CACHE_MS } from '../src/proxy.js';
import { credential } from '../src/normalize.js';

async function signedIn(t, options) {
  const h = await harness(t, options);
  assert.equal((await h.login()).status, 200);
  const result = await h.call('GET', '/api/dashboard');
  assert.equal(result.status, 200);
  return { ...h, dashboard: result.body };
}
const codex = data => data.accounts.find(a => a.provider === 'codex' && !a.disabled);
const claude = data => data.accounts.find(a => a.provider === 'claude');
const usageCalls = h => h.upstream.state.calls.filter(c => c.authIndex === 'auth-codex-one' && c.url.endsWith('/wham/usage')).length;
// The dashboard throttles refreshes within three seconds of the previous attempt.
async function refreshAfter(h, ms) {
  h.upstream.state.now += ms;
  return (await h.call('GET', '/api/dashboard')).body;
}

test('a transient Codex usage failure is retried once and reads live data', async t => {
  const h = await harness(t);
  h.upstream.state.usageFailOnce.add('auth-codex-one');
  await h.login();
  const data = (await h.call('GET', '/api/dashboard')).body;
  assert.equal(codex(data).status, 'ok');
  assert.equal(codex(data).windows.five.remaining, 18);
  assert.equal(usageCalls(h), 2);
});

test('a failed Codex read shows the cached reading as stale, across sessions, with resets disabled', async t => {
  const h = await signedIn(t);
  h.upstream.state.usageFail.add('auth-codex-one');
  const data = await refreshAfter(h, 60000);
  const a = codex(data);
  assert.equal(a.status, 'stale');
  assert.equal(a.windows.five.remaining, 18);
  assert.equal(a.observedAt, h.upstream.state.now - 60000);
  assert.match(a.error, /cached/);
  assert.equal(a.resets.enabled, false);
  // A new sign-in starts with no session history but still gets the shared reading.
  await h.login();
  assert.equal(codex((await h.call('GET', '/api/dashboard')).body).status, 'stale');
});

test('the cache is dropped once it ages out', async t => {
  const h = await signedIn(t);
  h.upstream.state.usageFail.add('auth-codex-one');
  const a = codex(await refreshAfter(h, USAGE_CACHE_MS + 1000));
  assert.equal(a.status, 'unavailable');
  assert.equal(a.windows.five.remaining, null);
});

test('the cache is dropped once one of its windows resets', async t => {
  const h = await harness(t);
  h.upstream.state.codexFiveResetMs = 60000;
  await h.login(); await h.call('GET', '/api/dashboard');
  h.upstream.state.usageFail.add('auth-codex-one');
  const a = codex(await refreshAfter(h, 61000));
  assert.equal(a.status, 'unavailable');
  assert.equal(a.windows.week.remaining, null);
});

test('credential-list outages and throttled refreshes still enforce the cache TTL', async t => {
  const h = await signedIn(t);
  const observedAt = codex(h.dashboard).observedAt;
  h.upstream.state.credentialsFail = true;
  h.upstream.state.now = observedAt + USAGE_CACHE_MS - 1;
  const stale = (await h.call('GET', '/api/dashboard')).body;
  assert.equal(codex(stale).status, 'stale');
  assert.equal(codex(stale).resets.enabled, false);
  assert.equal(stale.accounts.find(a => a.provider === 'gemini').status, 'unsupported');
  h.upstream.state.now += 1; // Still inside the three-second refresh throttle.
  const expired = codex((await h.call('GET', '/api/dashboard')).body);
  assert.equal(expired.status, 'unavailable');
  assert.equal(expired.windows.five.remaining, null);
  assert.equal(expired.observedAt, null);
});

test('a live snapshot becomes unavailable at a reset boundary even within the refresh throttle', async t => {
  const h = await harness(t);
  h.upstream.state.now = Date.parse('2026-10-07T12:00:00Z');
  h.upstream.state.codexFiveResetMs = 1000;
  await h.login();
  assert.equal(codex((await h.call('GET', '/api/dashboard')).body).status, 'ok');
  h.upstream.state.now += 1000;
  const a = codex((await h.call('GET', '/api/dashboard')).body);
  assert.equal(a.status, 'unavailable');
  assert.equal(a.windows.five.remaining, null);
  assert.equal(a.resets.enabled, false);
  assert.equal(usageCalls(h), 1);
});

test('a credential identity change does not retain usage or renewal dates from the prior identity', async t => {
  const h = await signedIn(t);
  h.upstream.state.codexAccountId = 'replacement-account';
  h.upstream.state.subscriptionFail = true;
  h.upstream.state.usageFail.add('auth-codex-one');
  const a = codex(await refreshAfter(h, 4000));
  assert.equal(a.status, 'unavailable');
  assert.equal(a.windows.five.remaining, null);
  assert.equal(a.renewal.nextAt, null);
});

test('a reset redemption invalidates the cached pre-reset reading', async t => {
  const h = await signedIn(t);
  const id = codex(h.dashboard).id;
  const prepared = await h.call('POST', `/api/accounts/${id}/reset/prepare`, { kind: 'full' });
  assert.equal(prepared.status, 200);
  h.upstream.state.onMutation = () => { h.upstream.state.usageFail.add('auth-codex-one'); };
  assert.equal((await h.call('POST', `/api/accounts/${id}/reset`, { operationId: prepared.body.operationId })).status, 200);
  const a = codex(await refreshAfter(h, 5000));
  assert.equal(a.status, 'unavailable');
  assert.equal(a.windows.five.remaining, null);
});

test('Fable is hidden below the Max 20x tier unless it has recorded usage', async t => {
  const h = await harness(t);
  h.upstream.state.claudeUsed.fable = 0;
  h.upstream.state.claudeProfile = { account: { has_claude_max: true }, organization: { uuid: h.upstream.state.organization, rate_limit_tier: 'default_claude_max_5x' } };
  await h.login();
  let data = (await h.call('GET', '/api/dashboard')).body;
  assert.equal(claude(data).fableAvailable, false);
  assert.equal(claude(data).windows.fable.remaining, null);
  assert.equal(data.summaries.find(s => s.provider === 'claude').values.fable.total, 0);

  h.upstream.state.claudeProfile.organization.rate_limit_tier = 'default_claude_max_20x';
  data = await refreshAfter(h, 5000);
  assert.equal(claude(data).fableAvailable, true);
  assert.equal(claude(data).windows.fable.remaining, 100);

  h.upstream.state.claudeProfile.organization.rate_limit_tier = 'default_claude_max_5x';
  h.upstream.state.claudeUsed.fable = 20;
  data = await refreshAfter(h, 5000);
  assert.equal(claude(data).fableAvailable, true);
  assert.equal(claude(data).windows.fable.remaining, 80);
});

test('a Claude reset cooldown reports when the reset becomes available', async t => {
  const h = await harness(t);
  const until = h.upstream.state.now + 2 * 3600000;
  h.upstream.state.claudeCooldownUntil = new Date(until).toISOString();
  await h.login();
  const a = claude((await h.call('GET', '/api/dashboard')).body);
  assert.equal(a.resets.usable.full, false);
  assert.equal(a.resets.reason, 'No usable grant right now');
  assert.equal(a.resets.availableAt, until);
  assert.ok(a.resets.options.every(o => o.reason === 'Reset cooldown active' && o.availableAt === until));
});

// Exercise both HTTP layers without a network or wall-clock retry delay.
function clientFixture(provider = 'codex') {
  const state = {
    now: Date.parse('2026-10-07T12:00:00Z'), calls: [], waits: [], respond: null,
    file: { auth_index: 'one', provider, email: 'first@example.test', chatgpt_account_id: provider === 'codex' ? 'first' : undefined },
    profile: { organization: { uuid: '11111111-1111-4111-8111-111111111111' } }
  };
  const usage = call => call.url.includes('/usage');
  const envelope = (status, body) => Response.json({ status_code: status, body: JSON.stringify(body) });
  state.body = provider === 'codex'
    ? { rate_limit: { primary_window: { used_percent: 82, limit_window_seconds: 18000, reset_after_seconds: 3600 } } }
    : { five_hour: { utilization: 82, resets_at: new Date(state.now + 3600000).toISOString() } };
  const client = new ProxyClient('http://proxy.invalid', {
    now: () => state.now, sleep: async ms => { state.waits.push(ms); },
    fetchImpl: async (url, options) => {
      if (url.includes('/credentials?')) return Response.json({ files: state.file ? [state.file] : [] });
      const call = JSON.parse(options.body);
      state.calls.push(call);
      const response = await state.respond?.(call);
      if (response) return response;
      return envelope(200, usage(call) ? state.body : call.url.includes('/profile') ? state.profile : {});
    }
  });
  return { state, client, usage, envelope, item: () => credential(state.file),
    read: previous => client.account('test-key', credential(state.file), previous) };
}

test('transient usage reads retry exactly once through either HTTP layer', async t => {
  const failures = [
    ['transport', () => { throw new Error('offline'); }],
    ['body transport', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('disconnected')); } }))],
    ['invalid management JSON', () => new Response('{')],
    ['invalid envelope', () => Response.json({})],
    ['invalid provider JSON', () => Response.json({ status_code: 200, body: '{' })],
    ...[408, 429, 500, 502, 503].flatMap(status => [
      [`provider ${status}`, f => f.envelope(status, {})],
      [`management ${status}`, () => new Response('', { status })]
    ])
  ];
  for (const provider of ['codex', 'claude']) for (const [name, fail] of failures) {
    await t.test(`${provider}: ${name}`, async () => {
      const f = clientFixture(provider);
      let failed = false;
      f.state.respond = call => {
        if (f.usage(call) && !failed) { failed = true; return fail(f); }
      };
      const result = await f.read();
      assert.equal(result.view.status, 'ok');
      assert.equal(result.view.windows.five.remaining, 18);
      assert.equal(f.state.calls.filter(f.usage).length, 2);
      assert.deepEqual(f.state.waits, [750]);
      assert.ok(f.state.calls.every(call => call.method === 'GET'));
    });
  }
});

test('permanent usage refusals do not retry or resurrect cached data', async t => {
  for (const provider of ['codex', 'claude']) for (const status of [400, 401, 403, 404, 422]) {
    await t.test(`${provider}: ${status}`, async () => {
      const f = clientFixture(provider);
      await f.read();
      f.state.calls = [];
      f.state.respond = call => f.usage(call) ? f.envelope(status, {}) : undefined;
      assert.equal((await f.read()).view.status, 'unavailable');
      assert.equal(f.state.calls.filter(f.usage).length, 1);
      assert.deepEqual(f.state.waits, []);
      f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
      assert.equal((await f.read()).view.windows.five.remaining, null);
    });
  }
});

test('management authentication failure clears the shared cache and never retries', async t => {
  for (const status of [401, 403]) await t.test(String(status), async () => {
    const f = clientFixture();
    await f.read();
    f.state.calls = [];
    f.state.respond = call => f.usage(call) ? new Response('', { status }) : undefined;
    await assert.rejects(f.read(), { code: 'management_access_denied' });
    assert.equal(f.state.calls.filter(f.usage).length, 1);
    assert.deepEqual(f.state.waits, []);
    f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
    assert.equal((await f.read()).view.status, 'unavailable');
  });
});

test('last-good age is unchanged by failed reads and expires at exactly fifteen minutes', async () => {
  const f = clientFixture();
  const first = await f.read(), observedAt = first.view.observedAt;
  f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
  f.state.now += USAGE_CACHE_MS - 1;
  const stale = await f.read();
  assert.equal(stale.view.status, 'stale');
  assert.equal(stale.view.observedAt, observedAt);
  assert.equal(stale.resetData, null);
  assert.equal(f.client.chooseReset(stale, 'full'), null);
  f.state.now += 1;
  const expired = await f.read(stale);
  assert.equal(expired.view.status, 'unavailable');
  assert.equal(expired.view.observedAt, null);
  assert.equal(expired.view.windows.five.remaining, null);
  assert.equal(f.state.calls.filter(f.usage).length, 5);
});

test('cache expires at a window boundary, including extra windows, and after clock rollback', async t => {
  for (const boundary of ['five', 'extra', 'rollback']) await t.test(boundary, async () => {
    const f = clientFixture();
    if (boundary === 'five') f.state.body.rate_limit.primary_window.reset_after_seconds = 60;
    if (boundary === 'extra') f.state.body.rate_limit.secondary_window = {
      used_percent: 10, limit_window_seconds: 2592000, reset_after_seconds: 60
    };
    await f.read();
    f.state.now += boundary === 'rollback' ? -1 : 60000;
    f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
    const result = await f.read();
    assert.equal(result.view.status, 'unavailable');
    assert.equal(result.view.extraWindows.length, 0);
  });
});

test('changed, disabled and removed credentials invalidate last-good usage', async t => {
  for (const change of ['account', 'email', 'disabled', 'removed']) await t.test(change, async () => {
    const f = clientFixture();
    const original = { ...f.state.file };
    await f.read();
    if (change === 'account') f.state.file.chatgpt_account_id = 'second';
    if (change === 'email') f.state.file.email = 'second@example.test';
    if (change === 'disabled') f.state.file.disabled = true;
    if (change === 'removed') f.state.file = null;
    await f.client.credentials('test-key');
    f.state.file = original;
    f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
    assert.equal((await f.read()).view.status, 'unavailable');
  });
});

test('a changed or missing Claude organization invalidates quota even when usage fails', async t => {
  for (const uuid of ['22222222-2222-4222-8222-222222222222', null]) await t.test(String(uuid), async () => {
    const f = clientFixture('claude');
    const old = await f.read();
    f.state.profile.organization.uuid = uuid;
    f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
    const result = await f.read(old);
    assert.equal(result.view.status, 'unavailable');
    assert.notEqual(result.scopeId, old.scopeId);
  });
});

test('a denied Claude profile cannot fall back when usage is unavailable', async () => {
  const f = clientFixture('claude');
  await f.read();
  f.state.respond = call => f.envelope(f.usage(call) ? 503 : 403, {});
  assert.equal((await f.read()).view.windows.five.remaining, null);
});

test('a session with an old Claude organization cannot borrow a replacement organization cache', async () => {
  const f = clientFixture('claude');
  const old = await f.read();
  f.state.profile.organization.uuid = '22222222-2222-4222-8222-222222222222';
  assert.equal((await f.read()).view.status, 'ok');
  const stale = f.client.staleAccount(old);
  assert.equal(stale.view.status, 'unavailable');
  assert.equal(stale.view.windows.five.remaining, null);
  assert.equal(stale.resetData, null);
});

test('a read that completes after its quota window reset is not live data for reset actions', async () => {
  const f = clientFixture();
  f.state.body.rate_limit.primary_window.reset_after_seconds = 60;
  f.state.respond = call => { if (f.usage(call)) f.state.now += 60000; };
  const result = await f.read();
  assert.equal(result.view.status, 'unavailable');
  assert.equal(result.resetData, null);
  assert.equal(f.client.chooseReset(result, 'full'), null);
});

test('unrecognized successful usage clears previously supported quota', async () => {
  const f = clientFixture();
  await f.read();
  f.state.body = {};
  assert.equal((await f.read()).view.status, 'unavailable');
  f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
  assert.equal((await f.read()).view.status, 'unavailable');
});

test('in-flight reads cannot refill a cache invalidated by a reset', async () => {
  const f = clientFixture();
  const first = await f.read();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  f.state.respond = async call => {
    if (f.usage(call)) { started(); await gate; return f.envelope(200, f.state.body); }
  };
  const reading = f.read();
  await pending;
  f.client.invalidateUsage(first.scopeId);
  release();
  assert.equal((await reading).view.status, 'unavailable');
  assert.equal(f.client.cachedUsage(f.item()), null);
  f.state.respond = call => f.usage(call) ? f.envelope(503, {}) : undefined;
  assert.equal((await f.read()).view.status, 'unavailable');
});
