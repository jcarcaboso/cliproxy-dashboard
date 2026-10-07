// Read-only sample data, never a production mode. No proxy/provider connections.
import http from 'node:http';
import fs from 'node:fs';
import { averages, emptyWindows } from '../src/normalize.js';

const now = Date.now(), day = 86400000;
const after = days => now + days * day;
const quota = (remaining, hours) => ({ remaining, resetAt: now + hours * 3600000 });
const credits = [{ count: 1, expiresAt: after(18) }, { count: 1, expiresAt: after(25) }];
const resets = (full, five, expirations) => ({
  full, five, expirations, enabled: true, usable: { full: full > 0, five: five > 0 },
  options: [], operation: null
});
const accounts = [
  {
    id: 'a'.repeat(24), provider: 'codex', label: 'personal@example.test', plan: 'plus', status: 'ok',
    windows: { ...emptyWindows(), five: quota(7, 1.7), week: quota(54, 142) },
    renewal: { nextAt: after(20), lastAt: after(-10), stale: false },
    resets: resets(2, null, { full: credits, five: [] })
  },
  {
    id: 'b'.repeat(24), provider: 'codex', label: 'work@example.test', plan: 'prolite', status: 'ok',
    windows: { ...emptyWindows(), week: quota(5, 113) },
    renewal: { nextAt: after(-9), lastAt: null, stale: false },
    resets: resets(2, null, { full: credits, five: [] })
  },
  {
    id: 'e'.repeat(24), provider: 'codex', label: 'cached@example.test', plan: 'plus', status: 'stale',
    windows: { ...emptyWindows(), five: quota(61, 3.2), week: quota(40, 90) }, observedAt: now - 4 * 60000,
    error: 'Live quota read failed; showing cached values; reset disabled',
    renewal: { nextAt: after(12), lastAt: null, stale: true },
    resets: { ...resets(1, null, { full: [], five: [] }), enabled: false, usable: {}, reason: 'Current quota data unavailable; reset disabled' }
  },
  {
    id: 'c'.repeat(24), provider: 'claude', label: 'studio@example.test', plan: 'pro', status: 'ok', fableAvailable: false,
    windows: { five: quota(4, 1.6), week: quota(53, 113), fable: { remaining: null, resetAt: null } },
    renewal: { nextAt: null, lastAt: null, stale: false },
    resets: { ...resets(1, 0, { full: [{ count: 1, expiresAt: after(18) }], five: [] }),
      usable: { full: false, five: false }, reason: 'No usable grant right now', availableAt: now + 2.4 * 3600000 }
  },
  {
    id: 'f'.repeat(24), provider: 'claude', label: 'max@example.test', plan: 'max', status: 'ok', fableAvailable: true,
    windows: { five: quota(72, 3.9), week: quota(31, 52), fable: quota(22, 52) },
    renewal: { nextAt: null, lastAt: null, stale: false },
    resets: resets(1, 1, { full: [{ count: 1, expiresAt: after(9) }], five: [{ count: 1, expiresAt: after(4) }] })
  }
];
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8788);
let blockedMutations = 0, countdownAt = null;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://preview.invalid').pathname;
  // Alternate read-only fixtures keep the production app unchanged.
  const scenario = pathname.match(/^\/(no-fable|countdown)\//)?.[1];
  const route = scenario ? pathname.slice(scenario.length + 1) : pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET') {
    blockedMutations += 1;
    req.resume(); json(403, { error: 'resets_disabled' }); return;
  }
  if (route === '/healthz') { json(200, { ok: true, fixtureOnly: true, providerMutations: 0, blockedMutations }); return; }
  if (route === '/api/session') { json(200, { authenticated: true, csrfToken: 'preview-only', sessionTtlHours: 168 }); return; }
  if (route === '/api/dashboard') {
    let rows = scenario === 'no-fable' ? accounts.filter(account => account.fableAvailable !== true) : accounts;
    if (scenario === 'countdown') {
      countdownAt ??= Date.now() + 12000;
      const ready = Date.now() >= countdownAt;
      rows = accounts.map(account => account.id === 'c'.repeat(24) ? {
        ...account, resets: { ...account.resets, availableAt: ready ? null : countdownAt,
          usable: { full: ready, five: false }, reason: ready ? null : 'Reset cooldown active' }
      } : account);
    }
    json(200, { accounts: rows, summaries: averages(rows), observedAt: Date.now(), resetsEnabled: true }); return;
  }
  const file = files.get(route);
  if (!file) { json(404, { error: 'not_found' }); return; }
  let body = fs.readFileSync(new URL(`../public/${file[0]}`, import.meta.url), 'utf8');
  if (file[0] === 'index.html') {
    if (scenario === 'countdown') countdownAt = Date.now() + 12000;
    body = body.replace('<title>Proxy usage dashboard</title>', '<title>Dashboard layout preview</title>')
      .replace('id="sign-out"', 'id="sign-out" hidden')
      .replace('id="management-key"', 'id="management-key" disabled')
      .replace('id="login-button"', 'id="login-button" disabled')
      .replace('<h1>Usage dashboard</h1>', '<h1>Usage dashboard <span class="demo-label">Preview · sample data</span></h1>');
  }
  if (file[0] === 'app.js') body = body.replace("'Connected to CLIProxyAPI'", "'Sample data · no live accounts'");
  res.writeHead(200, { 'Content-Type': file[1] }); res.end(body);
});
server.listen(port, host, () => console.log(`Read-only layout preview on ${host}:${port}. Sample accounts only; no key required.`));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
