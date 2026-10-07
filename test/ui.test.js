import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual browser renderers with minimal DOM stubs; no browser dependency.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
async function ui() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { dataset: {}, setAttribute() {}, addEventListener() {} });
      return elements.get(id);
    },
    querySelectorAll: () => [], addEventListener() {}
  };
  const context = vm.createContext({
    document, URL, location: { href: 'https://dashboard.invalid/usage/', protocol: 'https:' },
    localStorage: { getItem: () => null },
    fetch: async () => ({ ok: true, json: async () => ({ authenticated: false, sessionTtlHours: 168 }) }),
    setInterval() {}, setTimeout() {}, clearTimeout() {}
  });
  const renderers = await new vm.Script(`(async () => {
    ${source}
    return { renewal, resetBalance, accountRow, summary, render: data => { snapshot = data; render(); } };
  })()`).runInContext(context);
  return { ...renderers, elements };
}
const future = Date.now() + 20 * 86400000;
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
    id: provider === 'codex' ? 'a'.repeat(24) : 'b'.repeat(24), provider, label: provider, status: 'ok',
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
