import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual browser renderers with minimal DOM stubs; no browser dependency.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const now = Date.parse('2026-10-07T12:00:00Z');
async function ui({ authenticated = false, dashboard, paused = false } = {}) {
  let time = now;
  const elements = new Map(), selections = new Map(), intervals = [], requests = [];
  const element = () => ({
    dataset: {}, setAttribute() {}, addEventListener() {}, focus() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    replaceChildren() { this.innerHTML = ''; },
    children: new Map(),
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, element());
      return this.children.get(selector);
    },
    querySelectorAll: () => []
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll: selector => selections.get(selector) || [], addEventListener() {}
  };
  const context = vm.createContext({
    document, URL, location: { href: 'https://dashboard.invalid/usage/', protocol: 'https:' },
    Date: class extends Date { static now() { return time; } },
    localStorage: { getItem: () => String(paused), setItem() {} },
    fetch: async (url, options) => {
      requests.push({ method: options.method, path: url.pathname });
      assert.equal(options.method, 'GET', 'UI timer tests must never send a reset request');
      if (url.pathname.endsWith('/session')) {
        return { ok: true, json: async () => ({ authenticated, csrfToken: 'test-only', sessionTtlHours: 168 }) };
      }
      assert.equal(url.pathname, '/usage/api/dashboard');
      if (dashboard instanceof Error) throw dashboard;
      return { ok: true, json: async () => structuredClone(dashboard) };
    },
    setInterval(callback) { intervals.push(callback); }, setTimeout() {}, clearTimeout() {}
  });
  const renderers = await new vm.Script(`(async () => {
    ${source}
    return { renewal, resetBalance, accountRow, summary, tick, pollAt, load, resetDialog, explainReset,
      render: data => { snapshot = data; render(); } };
  })()`).runInContext(context);
  return { ...renderers, elements, selections, requests,
    setTime: value => { time = value; }, setDashboard: value => { dashboard = value; },
    async interval() { intervals.forEach(callback => callback()); await new Promise(setImmediate); }
  };
}
const future = now + 20 * 86400000;
const previous = Date.parse('2026-09-24T12:00:00Z');

test('renewal UI shows next days/date but never subscription activation as history', async () => {
  const { renewal } = await ui();
  const html = renewal({ provider: 'codex', status: 'ok', renewal: { nextAt: future, startedAt: previous } });
  assert.match(html, /class="renewal-countdown">20d/);
  assert.match(html, new RegExp(`data-renewal="${future}"`));
  assert.doesNotMatch(html, /Active since|Last renewal|24 Sept 2026/);
  const reported = renewal({ provider: 'codex', status: 'ok', renewal: { nextAt: future, lastAt: previous } });
  assert.match(reported, /Last renewal/);
  assert.match(reported, /24 Sept 2026/);
  const expired = renewal({ provider: 'codex', status: 'ok', renewal: { nextAt: previous } });
  assert.match(expired, /Date passed/);
  assert.match(expired, /data-past="true"/);
});
test('Claude renewal details are hidden without a reported renewal date', async () => {
  const { renewal } = await ui();
  for (const dates of [undefined, {}, { startedAt: previous }, { lastAt: previous }, { nextAt: null, startedAt: previous }]) {
    assert.equal(renewal({ provider: 'claude', status: 'ok', renewal: dates }), '');
  }
  const reported = renewal({ provider: 'claude', status: 'ok', renewal: { nextAt: future, lastAt: previous } });
  assert.match(reported, /20d/); assert.match(reported, /Last renewal/);
  const stale = renewal({ provider: 'claude', status: 'stale', renewal: { nextAt: future } });
  assert.match(stale, /last known/);
});
test('provider summaries keep quota coverage but omit their explanatory footer', async () => {
  const { summary } = await ui();
  const values = Object.fromEntries(['five', 'week', 'fable'].map(key => [key, { remaining: 53, reporting: 1, total: 2 }]));
  const html = summary({ provider: 'claude', total: 2, values });
  assert.match(html, /Claude/); assert.match(html, /53%/); assert.match(html, /metric-coverage">1\/2/);
  assert.doesNotMatch(html, /<small>|Account average|pooled|plan-weighted/);
});
test('rendered headers omit provider-reported subtext and retain Codex-first layout', async () => {
  const { render, elements } = await ui();
  const accounts = ['claude', 'codex'].map((provider, i) => ({
    id: 'a'.repeat(23) + i, provider, label: provider, status: 'ok', windows: {}, resets: {}
  }));
  const values = Object.fromEntries(['five', 'week', 'fable'].map(key => [key, { remaining: null, reporting: 0, total: 1 }]));
  render({ accounts, summaries: accounts.map(a => ({ provider: a.provider, total: 1, values })), resetsEnabled: true });
  const html = elements.get('accounts-root').innerHTML;
  assert.match(html, /role="columnheader">Resets left<\/div>/);
  assert.doesNotMatch(html, /provider-reported|Active since/);
  assert.ok(html.indexOf('Codex usage') < html.indexOf('Claude usage'));
  assert.ok(elements.get('summary').innerHTML.indexOf('Codex') < elements.get('summary').innerHTML.indexOf('Claude'));
  render({ accounts: [], summaries: [], resetsEnabled: true });
  assert.equal(elements.get('summary').innerHTML, '');
});
test('reset balances show per-group days and expiry dates, with unknown dates kept explicit', async () => {
  const { resetBalance } = await ui();
  const account = { status: 'ok', resets: { full: 3, five: 1, expirations: {
    full: [{ count: 2, expiresAt: future }, { count: 1, expiresAt: null }],
    five: [{ count: 1, expiresAt: previous }]
  } } };
  const html = resetBalance(account, 'full');
  assert.match(html, /data-reset-expiry=/);
  assert.match(html, /reset-expiry-days">20d/);
  assert.match(html, /aria-label="2 resets">2/); assert.match(html, /aria-label="1 reset">1/);
  assert.match(html, /reset-expiry-head/); assert.match(html, /<span>Expires<\/span>/);
  assert.match(html, /Not reported/); assert.doesNotMatch(html, /Due · refresh|Active since/);
  const expired = resetBalance(account, 'five');
  assert.match(expired, /Expired/); assert.match(expired, /24 Sept 2026/);
  assert.match(expired, /data-expired="true"/);
});
test('zero or unknown reset balances omit expiry details and sparse balances do not infer a date', async () => {
  const { resetBalance } = await ui();
  for (const balance of [0, null, undefined]) {
    const html = resetBalance({ status: 'ok', resets: { full: balance, expirations: { full: [{ count: 1, expiresAt: future }] } } }, 'full');
    assert.doesNotMatch(html, /reset-expiries|reset-expiry-days/);
  }
  const unknown = resetBalance({ status: 'ok', resets: { full: 2 } }, 'full');
  assert.match(unknown, /Expires/); assert.match(unknown, /Not reported/);
  assert.doesNotMatch(unknown, /data-reset-expiry=/);
});
test('Codex omits Fable headers and cells while Claude retains its actual Fable quota', async () => {
  const { accountRow, render, elements } = await ui();
  const account = provider => ({
    id: provider === 'codex' ? 'a'.repeat(24) : 'b'.repeat(24), provider, label: provider, status: 'ok', fableAvailable: provider === 'claude',
    windows: { five: { remaining: 7 }, week: { remaining: 30 }, fable: { remaining: 100 } },
    resets: { full: 2, five: null }
  });
  const codex = accountRow(account('codex')), claude = accountRow(account('claude'));
  assert.doesNotMatch(codex, /Fable|Not applicable|:fable/);
  assert.match(claude, /:fable/); assert.match(claude, /100%/);
  assert.equal((codex.match(/role="cell"/g) || []).length, 4);
  assert.equal((claude.match(/role="cell"/g) || []).length, 5);
  const values = Object.fromEntries(['five', 'week', 'fable'].map(key => [key, { remaining: 30, reporting: 1, total: 1 }]));
  for (const provider of ['codex', 'claude']) {
    render({ accounts: [account(provider)], summaries: [{ provider, total: 1, values }], resetsEnabled: true });
    const html = elements.get('accounts-root').innerHTML;
    assert.match(html, new RegExp(`data-provider="${provider}"`));
    assert.equal((html.match(/role="columnheader"/g) || []).length, provider === 'codex' ? 5 : 6);
    assert.equal(html.includes('Fable weekly'), provider === 'claude');
  }
});
test('Codex hides only an unsupported five-hour reset balance, never a reported one', async () => {
  const { accountRow } = await ui();
  const account = { id: 'a'.repeat(24), provider: 'codex', label: 'codex', status: 'ok', windows: {}, resets: { full: 2, five: null } };
  assert.doesNotMatch(accountRow(account), /data-kind="five"/);
  account.resets.five = 1;
  assert.match(accountRow(account), /data-kind="five"/);
  assert.match(accountRow({ ...account, provider: 'claude', resets: { full: 1, five: 0 } }), /data-kind="five"/);
});
test('expiry rows align explicit quantity, date and days with a machine-readable timestamp', async () => {
  const { resetBalance } = await ui();
  const html = resetBalance({ status: 'ok', resets: { full: 2, expirations: { full: [{ count: 2, expiresAt: future }] } } }, 'full');
  assert.match(html, /Full resets/);
  assert.match(html, /class="reset-expiry-count" aria-label="2 resets">2/);
  assert.match(html, new RegExp(`datetime="${new Date(future).toISOString()}"`));
  assert.ok(html.indexOf('class="reset-expiry-date"') < html.indexOf('class="reset-expiry-days"'));
});
test('a known reset-availability instant renders a live countdown', async () => {
  const { accountRow } = await ui();
  const at = now + 2 * 3600000 + 13 * 60000;
  const account = { id: 'c'.repeat(24), provider: 'claude', label: 'Studio', status: 'ok', windows: {},
    resets: { enabled: true, usable: {}, reason: 'Reset cooldown active', availableAt: at } };
  const html = accountRow(account);
  assert.match(html, /Available in/);
  assert.match(html, new RegExp(`data-reset="${at}"`));
  assert.match(html, />2h 13m</);
  assert.doesNotMatch(accountRow({ ...account, resets: { ...account.resets, enabled: false } }), /Available in/);
  assert.doesNotMatch(accountRow({ ...account, resets: { ...account.resets, availableAt: now - 1000 } }), /Available in/);
});
test('Claude hides the Fable column when no account has it on its plan', async () => {
  const { render, elements, accountRow } = await ui();
  const values = Object.fromEntries(['five', 'week', 'fable'].map(key => [key, { remaining: 50, reporting: 1, total: key === 'fable' ? 0 : 1 }]));
  const account = { id: 'd'.repeat(24), provider: 'claude', label: 'Pro', status: 'ok', fableAvailable: false, windows: {}, resets: {} };
  render({ accounts: [account], summaries: [{ provider: 'claude', total: 1, values }], resetsEnabled: true });
  assert.match(elements.get('accounts-root').innerHTML, /data-fable="false"/);
  assert.doesNotMatch(elements.get('accounts-root').innerHTML, /Fable weekly/);
  assert.doesNotMatch(elements.get('summary').innerHTML, /Fable/);
  // In a mixed group the column stays, and accounts without Fable say so.
  assert.match(accountRow(account, true), /Not on this plan/);
});

const waitingAccount = () => ({
  id: 'c'.repeat(24), provider: 'claude', label: 'Studio', status: 'ok', fableAvailable: false,
  observedAt: now - 4 * 60000, windows: { five: { remaining: 4, resetAt: now + 3600000 } },
  resets: { enabled: true, full: 1, five: 0, usable: {}, reason: 'Reset cooldown active', availableAt: now + 1000 }
});
const snapshotOf = (...accounts) => ({
  accounts, observedAt: now, resetsEnabled: true,
  summaries: [{ provider: 'claude', total: accounts.length, values: Object.fromEntries(
    ['five', 'week', 'fable'].map(key => [key, { remaining: 4, reporting: 1, total: accounts.length }])
  ) }]
});
const resetButton = html => html.match(/<button class="account-reset [^>]*>/)?.[0];

test('countdown advances without enabling reset and triggers only one read after expiry', async () => {
  const account = waitingAccount();
  const app = await ui({ authenticated: true, dashboard: snapshotOf(account) });
  const timer = { dataset: { reset: String(account.resets.availableAt) } };
  app.selections.set('time[data-reset]', [timer]);
  app.tick();
  assert.equal(timer.textContent, '1s');
  assert.equal(app.pollAt(), now + 6000);
  app.setTime(now + 1000);
  await app.interval();
  assert.equal(timer.textContent, 'Due · refresh');
  assert.match(resetButton(app.elements.get('accounts-root').innerHTML), /disabled/);
  assert.equal(app.requests.length, 2);
  app.setTime(now + 6000);
  await app.interval();
  assert.equal(app.requests.length, 3);
  assert.match(resetButton(app.elements.get('accounts-root').innerHTML), /disabled/);
  assert.equal(app.pollAt(), now + 306000);
  app.setTime(now + 7000);
  await app.interval();
  assert.equal(app.requests.length, 3, 'an expired timestamp must not create a polling loop');
  app.setDashboard(snapshotOf({ ...account, resets: { ...account.resets, availableAt: null, usable: { full: true } } }));
  await app.load();
  assert.doesNotMatch(resetButton(app.elements.get('accounts-root').innerHTML), /disabled/);
  assert.ok(app.requests.every(request => request.method === 'GET'));
});

test('a read during the post-expiry grace period keeps the scheduled refresh', async () => {
  const app = await ui({ authenticated: true, dashboard: snapshotOf(waitingAccount()) });
  app.setTime(now + 3000);
  await app.load();
  assert.equal(app.pollAt(), now + 6000);
  app.setTime(now + 6000);
  await app.interval();
  assert.equal(app.requests.length, 4);
});

test('paused auto-refresh does not read after expiry and resuming reads immediately', async () => {
  const account = waitingAccount();
  const app = await ui({ authenticated: true, paused: true, dashboard: snapshotOf(account) });
  app.explainReset(account);
  assert.match(app.elements.get('dialog-content').innerHTML, /Auto-refresh is paused/);
  app.setTime(now + 60000);
  await app.interval();
  assert.equal(app.requests.length, 2);
  app.elements.get('auto-toggle').onclick();
  await app.interval();
  assert.equal(app.requests.length, 3);
});

test('only fresh, blocked grants with finite timestamps schedule availability refreshes', async () => {
  const app = await ui(), account = waitingAccount();
  const invalid = [
    { ...account, status: 'stale' },
    ...[null, NaN, Infinity, 'invalid', now].map(availableAt => ({ ...account, resets: { ...account.resets, availableAt } })),
    { ...account, resets: { ...account.resets, enabled: false } },
    { ...account, resets: { ...account.resets, usable: { full: true } } },
    ...['pending', 'unknown'].map(state => ({ ...account, resets: { ...account.resets, operation: { state } } }))
  ];
  for (const value of invalid) assert.doesNotMatch(app.accountRow(value), /Available in/);
  app.render(snapshotOf(...invalid.filter(value => value.resets.availableAt !== now)));
  assert.equal(app.pollAt(), now + 300000);
  app.render(snapshotOf({ ...account, resets: { ...account.resets, availableAt: now + 600000 } }, account));
  assert.equal(app.pollAt(), now + 6000, 'the earliest grant wins over the regular poll');
});

test('stale readings show their age and cannot enable reset even with old usable flags', async () => {
  const app = await ui(), account = waitingAccount();
  const stale = { ...account, status: 'stale', resets: { ...account.resets, usable: { full: true } } };
  const html = app.accountRow(stale);
  assert.match(html, /Last known/);
  assert.match(html, /read 4m ago/);
  assert.match(html, /reset disabled/);
  assert.match(html, /Quota unavailable/);
  assert.match(resetButton(html), /disabled/);
  assert.doesNotMatch(html, /Available in/);
  app.resetDialog(stale);
  assert.notEqual(app.elements.get('local-dialog').open, true);
  app.explainReset(stale);
  assert.match(app.elements.get('dialog-content').innerHTML, /Current quota data unavailable; reset disabled/);
  assert.doesNotMatch(app.elements.get('dialog-content').innerHTML, /Provider-reported availability/);
  const review = app.accountRow({ ...stale, resets: { ...stale.resets, operation: { state: 'unknown' } } });
  assert.match(resetButton(review), /data-action="review"/);
  assert.doesNotMatch(resetButton(review), /disabled/);
});

test('a failed refresh marks rows and aggregate quota stale without exposing reset actions', async () => {
  const account = waitingAccount();
  account.resets.usable.full = true;
  const app = await ui({ authenticated: true, dashboard: snapshotOf(account) });
  app.setDashboard(new Error('offline'));
  await app.load();
  const html = app.elements.get('accounts-root').innerHTML;
  assert.match(html, /data-status="stale"/);
  assert.match(html, /Last known/);
  assert.match(html, /read 4m ago/);
  assert.match(resetButton(html), /disabled/);
  assert.doesNotMatch(app.elements.get('summary').innerHTML, /4%/);
  assert.match(app.elements.get('summary').innerHTML, /metric-coverage">0\/1/);
});

test('an open reset dialog cannot submit after the account becomes stale', async () => {
  const account = waitingAccount();
  account.resets.usable.full = true;
  const app = await ui({ authenticated: true, dashboard: snapshotOf(account) });
  app.resetDialog(account);
  const form = app.elements.get('local-dialog').querySelector('form');
  app.render(snapshotOf({ ...account, status: 'stale' }));
  await form.onsubmit({ preventDefault() {} });
  assert.match(app.elements.get('dialog-error').textContent, /Current provider status is unavailable/);
  assert.equal(app.requests.length, 2);
});

test('mixed Claude eligibility keeps aligned cells but never displays ineligible Fable quota', async () => {
  const app = await ui(), pro = waitingAccount();
  pro.windows.fable = { remaining: 100, resetAt: now + 3600000 };
  const max = { ...pro, id: 'f'.repeat(24), fableAvailable: true };
  app.render(snapshotOf(pro, max));
  const html = app.elements.get('accounts-root').innerHTML;
  assert.match(html, /data-fable="true"/);
  assert.equal((html.match(/role="columnheader"/g) || []).length, 6);
  assert.equal((html.match(/role="cell"/g) || []).length, 10);
  assert.equal((html.match(/100%/g) || []).length, 1);
  assert.match(app.accountRow(pro), /Not on this plan/);
  assert.doesNotMatch(app.accountRow(pro), /100%/);
  assert.match(app.elements.get('summary').innerHTML, /Fable weekly/);
  const unknown = { ...pro, fableAvailable: undefined, status: 'unavailable' };
  app.render(snapshotOf(pro, unknown));
  assert.doesNotMatch(app.elements.get('accounts-root').innerHTML, /Fable weekly|:fable/);
  assert.doesNotMatch(app.elements.get('summary').innerHTML, /Fable weekly/);
  assert.match(app.accountRow(unknown, true), /Eligibility not reported/);
});
