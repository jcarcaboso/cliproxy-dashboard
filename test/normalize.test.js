import test from 'node:test';
import assert from 'node:assert/strict';
import { credential, renewalDates, codexWindows, claudeWindows, claudeFableAvailable, codexResets, claudeResets, claudePlan, averages } from '../src/normalize.js';
import { configuration } from '../src/server.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
test('credential projection never includes provider secrets and retains stable identity', () => {
  const c = credential({ auth_index: 'one', provider: 'codex', label: '<script>label</script>', id_token: { chatgpt_account_id: 'account', plan_type: 'pro' }, access_token: 'SECRET' });
  assert.match(c.id, /^[a-f0-9]{24}$/);
  assert.equal(c.accountId, 'account'); assert.equal(c.plan, 'pro');
  assert.equal(JSON.stringify(c).includes('SECRET'), false);
  assert.equal(credential({ auth_index: 'bad\nindex' }), null);
});
test('renewal dates accept explicit billing metadata without inferring renewal history', () => {
  assert.deepEqual(renewalDates({
    active_until: 'invalid', subscription: { activeUntil: NOW / 1000 },
    last_renewal_at: '2026-09-22T12:00:00Z'
  }), { nextAt: NOW, lastAt: Date.parse('2026-09-22T12:00:00Z'), startedAt: null });
  assert.deepEqual(renewalDates({
    chatgpt_subscription_active_until: NOW - 86400000,
    chatgpt_subscription_active_start: '2025-01-22T12:00:00Z',
    created_at: '2020-01-01', expires_at: NOW + 3600000, resets_at: NOW + 86400000
  }), { nextAt: NOW - 86400000, lastAt: null, startedAt: Date.parse('2025-01-22T12:00:00Z') });
  assert.deepEqual(renewalDates(null, [], { active_until: 0, last_renewal_at: {}, subscription_created_at: false }),
    { nextAt: null, lastAt: null, startedAt: null });
});
test('credential renewal metadata resolves nested JWT and subscription fields without exposing secrets', () => {
  const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': {
    chatgpt_subscription_active_until: NOW / 1000, chatgpt_subscription_active_start: NOW - 86400000
  }, access_token: 'HIDDEN_SECRET' })).toString('base64url')}.signature`;
  const c = credential({ auth_index: 'renewal', provider: 'codex', metadata: { id_token: token },
    attributes: { subscription: { lastRenewalAt: NOW - 86400000 } } });
  assert.deepEqual(c.renewal, { nextAt: NOW, lastAt: NOW - 86400000, startedAt: NOW - 86400000 });
  assert.equal(JSON.stringify(c).includes('HIDDEN_SECRET'), false);
});
test('averages always order Codex above Claude and omit absent providers', () => {
  const rows = ['gemini', 'claude', 'codex'].map(provider => ({ provider, status: 'ok', windows: {} }));
  assert.deepEqual(averages(rows).map(group => group.provider), ['codex', 'claude', 'gemini']);
  assert.deepEqual(averages(rows.filter(row => row.provider === 'claude')).map(group => group.provider), ['claude']);
  assert.deepEqual(averages([]), []);
});
test('Codex duration wins over order and monthly is never mislabeled weekly', () => {
  const p = { rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 30, reset_at: 1791120000 }, secondary_window: { limit_window_seconds: 18000, used_percent: 10, reset_after_seconds: 120 } } };
  const value = codexWindows(p, NOW);
  assert.equal(value.windows.five.remaining, 90); assert.equal(value.windows.week.remaining, 70);
  assert.equal(value.windows.five.resetAt, NOW + 120000);
  p.rate_limit.primary_window.limit_window_seconds = 2592000;
  assert.equal(codexWindows(p, NOW).windows.week.remaining, null);
  assert.equal(codexWindows(p, NOW).extras.length, 1);
});
test('Codex legacy windows, explicit zero, unknown and over-limit readings', () => {
  const data = codexWindows({ rateLimit: { primaryWindow: { usedPercent: 0 }, secondaryWindow: { usedPercent: 105 } } }, NOW);
  assert.equal(data.windows.five.remaining, 100); assert.equal(data.windows.week.remaining, 0);
  assert.equal(codexWindows({}, NOW).windows.five.remaining, null);
  const mixed = codexWindows({ rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 604800 },
    secondary_window: { used_percent: 90 }
  } }, NOW);
  assert.equal(mixed.windows.week.remaining, 70, 'Legacy ordering must not overwrite a known weekly window');
});
test('Claude Fable modern scoped window wins; legacy fallback stays supported', () => {
  const payload = { five_hour: { utilization: 25 }, seven_day: { utilization: null }, iguana_necktie: { utilization: 90 }, limits: [
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 20, is_active: true },
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Other' } }, percent: 99 }
  ] };
  assert.equal(claudeWindows(payload).fable.remaining, 80);
  assert.equal(claudeWindows(payload).week.remaining, null);
  payload.limits[0].is_active = false;
  assert.equal(claudeWindows(payload).fable.remaining, 10, 'Inactive scoped windows are not current quota');
  delete payload.limits; assert.equal(claudeWindows(payload).fable.remaining, 10);
  assert.equal(claudePlan({ account: { has_claude_pro: false } }), null);
  assert.equal(claudePlan({ account: { has_claude_max: true } }), 'Max');
});

test('Fable requires the Max 20x tier or recorded nonzero usage, including legacy windows', () => {
  const modern = { limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable 5' } }, is_active: true, percent: 0 }] };
  const top = { organization: { rate_limit_tier: 'default_claude_max_20x' } };
  const lower = { organization: { rate_limit_tier: 'default_claude_max_5x' } };
  for (const payload of [modern, { iguana_necktie: { utilization: 0 } }]) {
    const windows = claudeWindows(payload);
    assert.equal(claudeFableAvailable(top, windows), true);
    assert.equal(claudeFableAvailable(lower, windows), false);
    assert.equal(claudeFableAvailable(null, windows), false);
    assert.equal(windows.fable.remaining, 100);
  }
  assert.equal(claudeFableAvailable(top, claudeWindows({})), true);
  assert.equal(claudeFableAvailable(lower, claudeWindows({})), false);
  modern.limits[0].percent = 20;
  assert.equal(claudeFableAvailable(lower, claudeWindows(modern)), true);
  assert.equal(claudeFableAvailable(null, claudeWindows({ iguana_necktie: { utilization: 20 } })), true);
  modern.limits[0].is_active = false;
  assert.equal(claudeFableAvailable(lower, claudeWindows(modern)), false);
  modern.limits[0].is_active = true;
  modern.limits[0].percent = null;
  assert.equal(claudeFableAvailable(lower, claudeWindows(modern)), false);
});

test('credential identity changes invalidate fingerprints while label and token rotation do not', () => {
  const file = { provider: 'claude', auth_index: 'one', email: 'first@example.test', id: 'first.json' };
  const first = credential(file);
  for (const changed of [{ email: 'second@example.test' }, { id: 'replacement.json' }]) {
    const other = credential({ ...file, ...changed });
    assert.equal(other.id, first.id);
    assert.notEqual(other.fingerprint, first.fingerprint);
  }
  assert.equal(credential({ ...file, label: 'Renamed', access_token: 'rotated' }).fingerprint, first.fingerprint);
});
test('Codex uses the authoritative banked count, not usage-only applicability hints', () => {
  assert.equal(codexResets({ available_count: 2, applicable_available_count: 0 }, NOW).options[0].usable, true);
  assert.equal(codexResets({ available_count: '2', applicable_available_count: '0' }, NOW).options[0].usable, true);
  assert.equal(codexResets({ available_count: 2, applicable_available_count: 'invalid' }, NOW).full, 2);
  assert.equal(codexResets({ available_count: 'invalid', applicable_available_count: 2 }, NOW).full, null);
  const expired = { credits: [{ reset_type: 'codex_rate_limits', status: 'available', expires_at: new Date(NOW - 1).toISOString() }] };
  assert.equal(codexResets(expired, NOW).full, 0);
  assert.equal(codexResets({ surprise: 5 }, NOW).full, null);
});
test('Codex reported totals remain usable without detailed credit/expiry entries', () => {
  for (const credits of [null, [], [{ reset_type: 'codex_rate_limits', status: 'available', expires_at: null }]]) {
    const result = codexResets({ available_count: 3, credits }, NOW);
    assert.equal(result.full, 3);
    assert.equal(result.options[0].usable, true);
  }
});
test('Codex reset expirations preserve distinct dates and unknown credits without changing the balance', () => {
  const entry = expiresAt => ({ resetType: 'codexRateLimits', status: 'available', expiresAt });
  const result = codexResets({ availableCount: 4, credits: [
    entry(NOW + 3 * 86400000), entry(NOW + 3 * 86400000), entry(NOW + 5 * 86400000)
  ] }, NOW);
  assert.equal(result.full, 4); assert.equal(result.options[0].usable, true);
  assert.deepEqual(result.expirations, { full: [
    { count: 2, expiresAt: NOW + 3 * 86400000 }, { count: 1, expiresAt: NOW + 5 * 86400000 }, { count: 1, expiresAt: null }
  ], five: [] });
  assert.deepEqual(codexResets({ available_count: 3, credits: null }, NOW).expirations.full, [{ count: 3, expiresAt: null }]);
});
test('Codex conflicting or invalid expiry details do not invent dates or change reset eligibility', () => {
  const entry = expires_at => ({ reset_type: 'codex_rate_limits', status: 'available', expires_at });
  const conflicting = codexResets({ available_count: 1, credits: [entry(NOW + 86400000), entry(NOW + 86400000)] }, NOW);
  assert.deepEqual(conflicting.expirations.full, [{ count: 1, expiresAt: null }]);
  assert.equal(conflicting.options[0].usable, true);
  const invalid = codexResets({ available_count: 2, credits: [entry('invalid'), entry(NOW - 1)] }, NOW);
  assert.deepEqual(invalid.expirations.full, [{ count: 2, expiresAt: null }]);
  assert.deepEqual(codexResets({ available_count: 0, credits: [] }, NOW).expirations.full, []);
});
test('Codex manual redemption follows the reported banked balance', () => {
  const result = codexResets({ available_count: 3, applicable_available_count: 0, credits: [] }, NOW);
  assert.equal(result.full, 3, 'Keep the reported banked balance visible');
  assert.equal(result.options[0].usable, true, 'Match native Codex: available credits gate manual redemption');
});
test('Codex available detail entries can omit expiry, but not provide an invalid expiry', () => {
  assert.equal(codexResets({ credits: [{ resetType: 'codexRateLimits', status: 'available', expiresAt: null }] }, NOW).full, 1);
  assert.equal(codexResets({ credits: [{ reset_type: 'codex_rate_limits', status: 'available', expires_at: 'invalid' }] }, NOW).full, 0);
  assert.equal(codexResets({ available_count: 0, credits: [{ reset_type: 'codex_rate_limits', status: 'available' }] }, NOW).options[0].usable, false);
  assert.equal(codexResets({ available_count: 3, credits: {} }, NOW).full, null);
});
test('Codex account identity resolves supported camel-case and fallback metadata', () => {
  const direct = credential({ auth_index: 'one', provider: 'codex', chatgptAccountId: 'account-one', planType: 'pro' });
  assert.equal(direct.accountId, 'account-one');
  assert.equal(direct.plan, 'pro');
  const nested = credential({ auth_index: 'two', provider: 'codex', id_token: '', metadata: { id_token: { chatgpt_account_id: 'account-two', plan_type: 'plus' } } });
  assert.equal(nested.accountId, 'account-two');
  assert.equal(nested.plan, 'plus');
});
function grants() {
  return { cedar_ember: { eligible: true, at_limit: true, grants: [
    { id: 'all', resets_total: 3, resets_left: 2, clears: ['five_hour', 'seven_day'], usable_now: true, use_requires_limit: true },
    { id: 'short', resets_total: 2, resets_left: 1, clears: ['five_hour'], usable_now: true }
  ] } };
}
test('Claude full and five-hour expirations use grant end dates, never quota or grant-renewal dates', () => {
  const body = grants();
  body.cedar_ember.weekly_resets_at = new Date(NOW + 7 * 86400000).toISOString();
  body.seven_day = { resets_at: body.cedar_ember.weekly_resets_at };
  body.cedar_ember.grants[0].ends_at = new Date(NOW + 2 * 86400000).toISOString();
  body.cedar_ember.grants[1].ends_at = new Date(NOW + 4 * 86400000).toISOString();
  body.cedar_ember.grants.push({ ...body.cedar_ember.grants[0], id: 'more', resets_left: 1, ends_at: null });
  const result = claudeResets(body, NOW);
  assert.deepEqual(result.expirations, { full: [
    { count: 2, expiresAt: NOW + 2 * 86400000 }, { count: 1, expiresAt: null }
  ], five: [{ count: 1, expiresAt: NOW + 4 * 86400000 }] });
  body.cedar_ember.grants[0].ends_at = new Date(NOW - 1).toISOString();
  const expired = claudeResets(body, NOW);
  assert.equal(expired.options[0].usable, false);
  assert.equal(expired.expirations.full[0].expiresAt, NOW - 1);
  body.cedar_ember.grants[1].resets_left = 0;
  assert.deepEqual(claudeResets(body, NOW).expirations.five, []);
});
test('Claude full and 5h grants are distinct and provider eligibility is enforced', () => {
  const payload = grants();
  const parsed = claudeResets(payload, NOW);
  assert.equal(parsed.full, 2); assert.equal(parsed.five, 1);
  assert.ok(parsed.options.every(g => g.usable));
  payload.cedar_ember.at_limit = false;
  assert.ok(claudeResets(payload, NOW).options.every(g => !g.usable));
});
test('Malformed, duplicate, unknown-scope and missing usability grants fail closed', () => {
  for (const mutate of [
    p => { p.cedar_ember.grants[0].resets_left = 99; },
    p => { p.cedar_ember.grants[1].id = 'all'; },
    p => { p.cedar_ember.cooldown_until = 'invalid'; },
    p => { p.cedar_ember.grants[0].clears.push('unknown_provider_window'); }
  ]) { const p = grants(); mutate(p); assert.equal(claudeResets(p, NOW).full, null); }
  const p = grants(); delete p.cedar_ember.grants[0].usable_now;
  assert.equal(claudeResets(p, NOW).options[0].usable, false);
});
test('Provider averages exclude stale/unknown and never pool unlike providers', () => {
  const a = (provider, status, remaining) => ({ provider, status, windows: { five: { remaining } } });
  const rows = averages([a('codex', 'ok', 10), a('codex', 'ok', 90), a('codex', 'stale', 100), a('claude', 'ok', null)]);
  assert.equal(rows[0].values.five.remaining, 50); assert.equal(rows[0].values.five.reporting, 2);
  assert.equal(rows[1].values.five.remaining, null);
});
test('Configuration defaults to loopback and rejects unsafe origins', () => {
  assert.equal(configuration({ CLIPROXY_BASE_URL: 'http://localhost:8317' }).host, '127.0.0.1');
  assert.throws(() => configuration({ CLIPROXY_BASE_URL: 'http://localhost:8317', PUBLIC_ORIGIN: 'http://example.com' }));
  assert.throws(() => configuration({ CLIPROXY_BASE_URL: 'http://localhost:8317', PUBLIC_ORIGIN: 'https://example.com/path' }));
  assert.equal(configuration({ CLIPROXY_BASE_URL: 'http://localhost:8317', PUBLIC_ORIGIN: 'https://example.com' }).secureCookie, true);
});
test('session lifetime is configurable, bounded and defaults to eight hours', () => {
  const env = { CLIPROXY_BASE_URL: 'http://localhost:8317' };
  assert.equal(configuration(env).sessionTtlHours, 8);
  assert.equal(configuration({ ...env, SESSION_TTL_HOURS: '168' }).sessionTtlHours, 168);
  assert.equal(configuration({ ...env, SESSION_TTL_HOURS: '720' }).sessionTtlHours, 720);
  for (const value of ['', '0', '-1', '1.5', '721', 'Infinity', 'NaN', 'seven days']) {
    assert.throws(() => configuration({ ...env, SESSION_TTL_HOURS: value }), /SESSION_TTL_HOURS/);
  }
});
