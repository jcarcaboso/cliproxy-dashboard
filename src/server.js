import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ProxyClient, ProxyError } from './proxy.js';
import { ResetStore } from './reset-store.js';
import { averages, record } from './normalize.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COOKIE = 'cliproxy_dashboard_session';
const DEFAULT_SESSION_HOURS = 8;
const ID = /^[a-f0-9]{24}$/;
const OP_ID = /^[a-f0-9-]{36}$/;
class AppError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new AppError(status, code); };
const secureEqual = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function configuration(env = process.env) {
  const upstream = env.CLIPROXY_BASE_URL;
  if (!upstream) throw new Error('Set CLIPROXY_BASE_URL to your existing CLIProxyAPI v8 server');
  const publicUrl = new URL(env.PUBLIC_ORIGIN || env.DASHBOARD_PUBLIC_ORIGIN || 'http://localhost:8080');
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
      publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin, without a path or credentials');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol === 'http:' && !local && env.ALLOW_INSECURE_HTTP !== 'true') throw new Error('Use HTTPS for a remote PUBLIC_ORIGIN; ALLOW_INSECURE_HTTP=true is only for explicit local testing');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const sessionTtlHours = Number(env.SESSION_TTL_HOURS ?? DEFAULT_SESSION_HOURS);
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 720) throw new Error('SESSION_TTL_HOURS must be an integer between 1 and 720');
  return {
    upstream, publicOrigin: publicUrl.origin, secureCookie: publicUrl.protocol === 'https:',
    enableResets: env.ENABLE_RESETS === 'true', sessionTtlHours,
    dataDir: env.DATA_DIR || path.join(ROOT, '.data'), port, host: env.HOST || '127.0.0.1'
  };
}

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'json_required');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) fail(413, 'request_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
  if (!record(value)) fail(400, 'object_required');
  return value;
}
function fields(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'unexpected_field');
}
async function concurrent(items, limit, fn) {
  const output = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) { const i = index++; output[i] = await fn(items[i]); }
  }));
  return output;
}

export function createDashboard(config, { now = Date.now, fetchImpl = fetch, store = new ResetStore(config.dataDir, now) } = {}) {
  const proxy = new ProxyClient(config.upstream, { fetchImpl, now });
  const sessionTtlHours = config.sessionTtlHours ?? DEFAULT_SESSION_HOURS;
  const sessionMs = sessionTtlHours * 60 * 60 * 1000;
  const cookieName = config.secureCookie ? `__Host-${COOKIE}` : COOKIE;
  const sessions = new Map(), logins = new Map(), busyScopes = new Set();
  const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']]
  ]);
  function security(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  function send(res, status, body) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  function cookie(res, value, age) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secureCookie ? '; Secure' : ''}`);
  }
  function session(req, required = true) {
    const token = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const value = token && sessions.get(token);
    if (!value || value.expires <= now()) {
      if (token) sessions.delete(token);
      if (required) fail(401, 'sign_in_required');
      return null;
    }
    return value;
  }
  function origin(req) {
    if (req.headers.origin !== config.publicOrigin) fail(403, 'origin_refused');
  }
  function csrf(req, s) {
    origin(req);
    if (!secureEqual(req.headers['x-csrf-token'], s.csrf)) fail(403, 'csrf_refused');
  }
  function prune() {
    for (const [key, s] of sessions) {
      if (s.expires <= now()) sessions.delete(key);
      else for (const [id, op] of s.prepared) if (op.expiresAt < now()) s.prepared.delete(id);
    }
    for (const [key, attempts] of logins) if (attempts.until <= now()) logins.delete(key);
  }
  function publicSnapshot(s) {
    const scopes = new Map();
    for (const entry of s.accounts.values()) if (entry.scopeId) scopes.set(entry.scopeId, (scopes.get(entry.scopeId) || 0) + 1);
    const accounts = [...s.accounts.values()].map(entry => {
      const scopeId = entry.scopeId || entry.view.id;
      const operation = store.public(store.blocked(entry.view.id, scopeId));
      const resets = {
        ...entry.view.resets, operation,
        enabled: config.enableResets && !operation && entry.view.status === 'ok',
        ...(entry.view.status !== 'ok' ? { reason: 'Current quota data unavailable; reset disabled' } : {}),
        ...(operation ? { reason: 'Previous reset outcome needs review' } : {}),
        ...(!config.enableResets ? { reason: 'Resets are disabled by server configuration' } : {})
      };
      return { ...entry.view, sharedResetScope: (scopes.get(scopeId) || 0) > 1, resets, lastReset: store.public(store.latest(entry.view.id, scopeId)) };
    });
    return { accounts, summaries: averages(accounts), observedAt: s.observedAt, error: s.error, resetsEnabled: config.enableResets };
  }
  async function refresh(s) {
    if (s.refreshing) return s.refreshing;
    if (s.observedAt && now() - s.lastAttempt < 3000) return publicSnapshot(s);
    s.refreshing = (async () => {
      do {
        s.dirty = false;
        s.lastAttempt = now();
        try {
          const items = await proxy.credentials(s.key);
          const rows = await concurrent(items, 4, async item => {
            const previous = s.accounts.get(item.id);
            const row = await proxy.account(s.key, item, previous?.view);
            row.scopeId ||= previous?.scopeId || item.id;
            return row;
          });
          s.accounts = new Map(rows.map(row => [row.item.id, row]));
          s.observedAt = now(); s.error = null;
        } catch (error) {
          if (error.code === 'management_access_denied') throw error;
          if (!s.accounts.size) throw error;
          for (const entry of s.accounts.values()) {
            entry.view.status = entry.view.status === 'disabled' ? 'disabled' : 'stale';
            entry.view.resets = { full: null, five: null, usable: {}, options: [], reason: 'Proxy unavailable; reset disabled' };
            entry.view.error = 'Proxy unavailable; showing last known values';
            entry.resetData = null;
          }
          s.error = 'proxy_unavailable';
        }
        // A reset may complete while an older multi-account read is still in flight.
        // Re-read rather than publishing pre-reset counters as the post-reset result.
      } while (s.dirty);
      return publicSnapshot(s);
    })();
    try { return await s.refreshing; } finally { s.refreshing = null; }
  }
  async function freshAccount(s, id) {
    const item = (await proxy.credentials(s.key)).find(a => a.id === id);
    if (!item) fail(404, 'account_not_found');
    const account = await proxy.account(s.key, item);
    s.accounts.set(id, account);
    return account;
  }
  async function resetPrepare(s, id, body) {
    fields(body, ['kind']);
    if (!config.enableResets) fail(403, 'resets_disabled');
    if (!['full', 'five'].includes(body.kind)) fail(400, 'invalid_reset_scope');
    if (s.prepared.size >= 50) fail(429, 'too_many_confirmations');
    const account = await freshAccount(s, id);
    const scopeId = account.scopeId || id;
    if (busyScopes.has(scopeId) || store.blocked(id, scopeId)) fail(409, 'reset_pending_review');
    const option = proxy.chooseReset(account, body.kind);
    if (account.view.status !== 'ok' || !option) fail(409, 'reset_unavailable');
    const op = {
      id: randomUUID(), accountId: id, scopeId, kind: body.kind, requestId: randomUUID(),
      fingerprint: account.item.fingerprint, organization: account.resetData.organization || null,
      grantId: option.grantId, count: option.count, clears: option.clears,
      expiresAt: now() + 60000
    };
    s.prepared.set(op.id, op);
    return {
      operationId: op.id, accountId: id, label: account.view.label, provider: account.view.provider,
      kind: op.kind, grantLabel: option.label, available: option.count, clears: option.clears,
      expiresAt: op.expiresAt,
      warning: 'This consumes a provider reset for this account only. It cannot be undone. No automatic retry is made.'
    };
  }
  async function resetConfirm(s, id, body) {
    fields(body, ['operationId']);
    if (!config.enableResets) fail(403, 'resets_disabled');
    if (!OP_ID.test(body.operationId || '')) fail(400, 'invalid_confirmation');
    const prior = store.get(body.operationId);
    if (prior) {
      if (prior.accountId !== id || !s.accounts.has(id)) fail(404, 'operation_not_found');
      return store.public(prior);
    }
    const op = s.prepared.get(body.operationId);
    if (!op || op.accountId !== id || op.expiresAt <= now()) fail(409, 'confirmation_expired');
    if (busyScopes.has(op.scopeId) || store.blocked(id, op.scopeId)) fail(409, 'reset_pending_review');
    busyScopes.add(op.scopeId);
    try {
      const account = await freshAccount(s, id);
      const option = account.resetData?.options.find(o => o.kind === op.kind && o.grantId === op.grantId && o.usable);
      if (account.item.fingerprint !== op.fingerprint || (account.resetData?.organization || null) !== op.organization) fail(409, 'account_identity_changed');
      if (account.view.status !== 'ok' || !option || option.count !== op.count || JSON.stringify(option.clears) !== JSON.stringify(op.clears)) fail(409, 'eligibility_changed');
      try { store.begin(op); } catch { fail(503, 'reset_journal_unavailable'); }
      // Once this durable pending record exists, no response loss or restart permits an automatic retry.
      const outcome = await proxy.redeem(s.key, account, option, op.requestId);
      let receipt;
      try { receipt = store.finish(op.id, outcome); } catch { receipt = store.get(op.id); }
      // Old confirmations for aliases/tabs must not survive a reset against the same scope.
      for (const otherSession of sessions.values()) {
        for (const [id, prepared] of otherSession.prepared) {
          if (prepared.scopeId === op.scopeId) otherSession.prepared.delete(id);
        }
      }
      s.lastAttempt = 0;
      s.dirty = true;
      // Keep the receipt independent of the subsequent read; a failed refresh must not re-send the mutation.
      return store.public(receipt);
    } finally { busyScopes.delete(op.scopeId); }
  }

  const server = http.createServer(async (req, res) => {
    security(res); prune();
    let s = null;
    try {
      if (!req.url?.startsWith('/')) fail(400, 'invalid_path');
      const url = new URL(req.url, config.publicOrigin);
      const route = url.pathname;
      if ((req.method === 'GET' || req.method === 'HEAD') && files.has(route)) {
        const [file, type] = files.get(route);
        res.writeHead(200, { 'Content-Type': type });
        res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(ROOT, 'public', file)));
        return;
      }
      if (req.method === 'GET' && route === '/healthz') { send(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && route === '/api/session') {
        origin(req);
        const address = req.socket.remoteAddress || 'unknown';
        const attempts = logins.get(address) || { count: 0, until: now() + 60000 };
        if (++attempts.count > 5) fail(429, 'login_rate_limited');
        logins.set(address, attempts);
        const body = await readBody(req); fields(body, ['managementKey']);
        if (typeof body.managementKey !== 'string' || body.managementKey.length < 1 || body.managementKey.length > 2048 || /[\r\n\0]/.test(body.managementKey)) fail(400, 'invalid_management_key');
        if (sessions.size >= 100) fail(503, 'session_capacity');
        // Verify against the existing management API; never expose the returned raw credential records.
        const items = await proxy.credentials(body.managementKey);
        const token = randomBytes(32).toString('hex');
        s = { token, key: body.managementKey, csrf: randomBytes(32).toString('hex'), expires: now() + sessionMs,
          accounts: new Map(), prepared: new Map(), observedAt: null, lastAttempt: 0, error: null, refreshing: null, dirty: false };
        for (const item of items) s.accounts.set(item.id, {
          item, resetData: null,
          view: { id: item.id, provider: item.provider, label: item.label, plan: item.plan, status: 'unknown', windows: {}, resets: {}, observedAt: null }
        });
        const previous = session(req, false);
        if (previous) sessions.delete(previous.token);
        sessions.set(token, s); logins.delete(address);
        cookie(res, token, sessionMs / 1000);
        send(res, 200, { authenticated: true, csrfToken: s.csrf });
        return;
      }
      if (req.method === 'GET' && route === '/api/session') {
        s = session(req, false);
        send(res, 200, { ...(s ? { authenticated: true, csrfToken: s.csrf } : { authenticated: false }), sessionTtlHours });
        return;
      }
      s = session(req);
      if (req.method === 'POST' && route === '/api/logout') {
        csrf(req, s); sessions.delete(s.token); cookie(res, '', 0);
        send(res, 200, { ok: true }); return;
      }
      if (req.method === 'GET' && route === '/api/dashboard') {
        send(res, 200, await refresh(s)); return;
      }
      const match = route.match(/^\/api\/accounts\/([a-f0-9]{24})\/reset(?:\/(prepare|review))?$/);
      if (req.method === 'POST' && match && ID.test(match[1])) {
        csrf(req, s);
        const body = await readBody(req), id = match[1];
        if (match[2] === 'prepare') { send(res, 200, await resetPrepare(s, id, body)); return; }
        if (match[2] === 'review') {
          fields(body, ['operationId', 'acknowledge']);
          if (body.acknowledge !== true || !OP_ID.test(body.operationId || '')) fail(400, 'explicit_review_required');
          const account = await freshAccount(s, id);
          if (busyScopes.has(account.scopeId || id)) fail(409, 'reset_in_progress');
          if (account.view.status !== 'ok') fail(409, 'provider_status_unavailable');
          let reviewed;
          try { reviewed = store.review(body.operationId, id, account.scopeId || id); } catch { fail(503, 'reset_journal_unavailable'); }
          if (!reviewed) fail(409, 'operation_not_reviewable');
          s.lastAttempt = 0; s.dirty = true;
          send(res, 200, { ...store.public(reviewed), message: 'Reviewed locally; no reset was retried.' });
          return;
        }
        const receipt = await resetConfirm(s, id, body);
        send(res, receipt.state === 'pending' ? 202 : 200, receipt); return;
      }
      fail(404, 'not_found');
    } catch (error) {
      const status = error instanceof AppError || error instanceof ProxyError ? error.status : 500;
      const code = error instanceof AppError || error instanceof ProxyError ? error.code : 'internal_error';
      if (status === 401) {
        if (s) sessions.delete(s.token);
        // Do not let a late response from an old request erase a newer sign-in cookie.
        // The invalid server-side token is unusable; explicit logout clears the cookie.
      }
      send(res, status, { error: code });
    }
  });
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = configuration();
    const { server } = createDashboard(config);
    server.listen(config.port, config.host, () => console.log(`Dashboard listening on port ${config.port}; resets ${config.enableResets ? 'enabled with confirmation' : 'disabled'}.`));
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch {
    console.error('Dashboard could not start. Check CLIPROXY_BASE_URL, PUBLIC_ORIGIN and the writable DATA_DIR. See README.md.');
    process.exitCode = 1;
  }
}
