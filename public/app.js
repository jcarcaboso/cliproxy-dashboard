const $ = id => document.getElementById(id);
const apiRoot = new URL('api/', location.href);
const names = new Map([['codex', 'Codex'], ['claude', 'Claude']]);
let csrf = null, snapshot = null, epoch = 0, loading = false, refreshAgain = false, resetBusy = false, paused = false, nextPoll = null;
try { paused = localStorage.getItem('usage-dashboard-paused') === 'true'; } catch { /* Optional preference storage. */ }
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '—';
const providerName = provider => names.get(provider) || (provider ? provider[0].toUpperCase() + provider.slice(1) : 'Unknown provider');
const planName = plan => plan ? plan[0].toUpperCase() + plan.slice(1) : 'Unknown';
const accountCount = count => `${count} ${count === 1 ? 'account' : 'accounts'}`;
// Fable is a Claude top-tier allowance; the column is hidden when no account in view has it.
const hasFable = accounts => accounts.some(a => a.provider === 'claude' && a.fableAvailable === true);
const quotaKeys = (provider, fable = true) => provider === 'claude' && fable ? ['five', 'week', 'fable'] : ['five', 'week'];
const quotaTone = value => value == null ? 'unknown' : value < 10 ? 'critical' : value < 25 ? 'low' : 'normal';
const utc = value => value && Number.isFinite(value) ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Not reported';
const renewalDate = value => value && Number.isFinite(value)
  ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(value) : 'Not reported';
const renewalDays = value => value <= Date.now() ? 'Date passed' : `${Math.ceil((value - Date.now()) / 86400000)}d`;
const expiryDays = value => value <= Date.now() ? 'Expired' : `${Math.ceil((value - Date.now()) / 86400000)}d`;
const timeTone = value => !value ? 'unknown' : value <= Date.now() ? 'due' : value - Date.now() <= 3600000 ? 'soon' : value - Date.now() <= 21600000 ? 'today' : 'later';
function countdown(value) {
  if (!value) return '—';
  const seconds = Math.ceil((value - Date.now()) / 1000);
  if (seconds <= 0) return 'Due · refresh';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}
const ago = value => {
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
};
// Provider-reported instant a reset becomes usable, shown only while it is still ahead.
const resetWait = (account, now = Date.now()) => {
  const at = account.resets?.availableAt;
  return account.status === 'ok' && account.resets?.enabled && !account.resets.operation &&
    !account.resets.usable?.full && !account.resets.usable?.five && Number.isFinite(at) && at > now ? at : null;
};
const resetReason = account => account.status !== 'ok' ? 'Current quota data unavailable; reset disabled' :
  account.resets?.reason || account.resets?.options?.find(o => !o.usable)?.reason || 'No eligible reset reported';
const messages = {
  management_access_denied: 'Management access was refused. Check the key and the proxy’s remote-management policy.',
  sign_in_required: 'Your session expired. Sign in again.',
  proxy_unreachable: 'Cannot reach CLIProxyAPI. Check the configured upstream address.',
  v8_management_unavailable: 'CLIProxyAPI v8 management is unavailable. Check the server version and management configuration.',
  origin_refused: 'This address does not match PUBLIC_ORIGIN. Check the dashboard deployment configuration.',
  csrf_refused: 'Your session changed. Reload this page before trying again.',
  login_rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  resets_disabled: 'Provider resets are disabled by the dashboard configuration.',
  reset_pending_review: 'A previous reset is pending or uncertain. Review its outcome before another attempt.',
  reset_unavailable: 'The provider does not currently report an eligible reset for this scope.',
  confirmation_expired: 'The confirmation expired. Check eligibility again.',
  eligibility_changed: 'Reset availability changed. Refresh and review a new confirmation.',
  account_identity_changed: 'The account identity changed. No reset was sent; refresh the dashboard.',
  provider_status_unavailable: 'Current provider status is unavailable. Wait before reviewing this operation.',
  reset_journal_unavailable: 'The reset journal could not be saved. Check its state before retrying.',
  reset_in_progress: 'A reset is already in progress for this account.',
  account_not_found: 'This account is no longer present in the proxy.',
  too_many_accounts: 'The proxy returned more accounts than this dashboard’s safety limit.',
  network_error: 'The request did not complete. Check connectivity; never blindly repeat a reset.'
};
function errorText(code) { return Object.hasOwn(messages, code) ? messages[code] : 'The request could not be completed. Refresh the page or check the dashboard configuration.'; }
function disconnected() {
  epoch += 1; csrf = null; snapshot = null; nextPoll = null; refreshAgain = false;
  $('dashboard').hidden = true; $('sign-in').hidden = false;
  $('summary').replaceChildren(); $('accounts-root').replaceChildren();
  if ($('local-dialog').open) $('local-dialog').close();
  $('local-dialog').replaceChildren();
}
async function request(method, route, body) {
  const generation = epoch;
  let response;
  try {
    response = await fetch(new URL(route, apiRoot), {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'POST' && csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch { throw new Error('network_error'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('network_error'); }
  if (!response.ok) {
    if (response.status === 401 && generation === epoch) disconnected();
    throw new Error(typeof data.error === 'string' ? data.error : 'request_failed');
  }
  return data;
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
}
function tick() {
  document.querySelectorAll('time[data-reset]').forEach(el => {
    const value = Number(el.dataset.reset) || null;
    el.textContent = countdown(value);
    el.dataset.urgency = el.dataset.stale === 'true' ? 'unknown' : timeTone(value);
  });
  document.querySelectorAll('time[data-renewal]').forEach(el => {
    const value = Number(el.dataset.renewal);
    el.querySelector('.renewal-countdown').textContent = renewalDays(value);
    el.dataset.past = String(value <= Date.now());
  });
  document.querySelectorAll('time[data-reset-expiry]').forEach(el => {
    const value = Number(el.dataset.resetExpiry);
    el.querySelector('.reset-expiry-days').textContent = expiryDays(value);
    el.dataset.expired = String(value <= Date.now());
  });
  $('last-sync').textContent = snapshot?.observedAt ? new Date(snapshot.observedAt).toISOString().slice(11, 19) + ' UTC' : '—';
  $('next-poll').textContent = paused ? 'Paused' : nextPoll ? countdown(nextPoll) : '—';
  $('refresh-mode').textContent = paused ? 'Manual · auto-refresh paused' : 'Auto · every 5 minutes';
  const toggle = $('auto-toggle');
  if (toggle.dataset.paused !== String(paused)) {
    toggle.dataset.paused = String(paused);
    toggle.innerHTML = paused ? '<span aria-hidden="true">▶</span> Resume' : '<span aria-hidden="true">Ⅱ</span> Pause';
    toggle.setAttribute('aria-label', paused ? 'Resume automatic refresh every 5 minutes' : 'Pause automatic refresh');
  }
}
function meter(value) {
  return `<progress class="live-meter" max="100" value="${typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0}" aria-hidden="true"></progress>`;
}
function limit(account, key) {
  if (key === 'fable' && account.fableAvailable !== true) {
    return `<div class="limit-cell limit-na unknown" role="cell" data-quota="${account.id}:${key}"><span class="mobile-limit-label">Fable weekly limit</span><span class="metric-label">${account.fableAvailable === false ? 'Not on this plan' : 'Eligibility not reported'}</span></div>`;
  }
  const value = account.windows?.[key] || { remaining: null, resetAt: null };
  const label = key === 'five' ? '5-hour' : key === 'week' ? 'Weekly' : 'Fable weekly';
  const stale = account.status !== 'ok';
  return `<div class="limit-cell ${quotaTone(value.remaining)}" role="cell" data-quota="${account.id}:${key}"><span class="mobile-limit-label">${label} limit</span>
    <div class="remaining-line"><span class="metric-label">${value.remaining == null ? 'Unavailable' : stale ? 'Last known' : 'Remaining'}</span><strong class="quota-number">${percent(value.remaining)}</strong></div>${meter(value.remaining)}
    <div class="reset-line"><span>${value.resetAt ? 'Resets in' : 'Not reported'}</span><time data-reset="${value.resetAt || ''}" data-stale="${stale}" data-urgency="${stale ? 'unknown' : timeTone(value.resetAt)}" title="${esc(utc(value.resetAt))}">${countdown(value.resetAt)}</time></div></div>`;
}
function summary(group, fable = group.values.fable?.total > 0) {
  const keys = quotaKeys(group.provider, fable);
  return `<section class="provider-summary"><header><h2>${esc(providerName(group.provider))}</h2><span>${accountCount(group.total)}</span></header><div class="total-metrics">${keys.map(key => {
    const v = group.values[key], label = key === 'five' ? '5-hour' : key === 'week' ? 'Weekly' : 'Fable weekly';
    return `<div class="total-quota ${quotaTone(v.remaining)}"><span class="metric-label">${label} <span class="metric-coverage">${v.reporting}/${v.total}</span></span><strong>${percent(v.remaining)}</strong>${meter(v.remaining)}</div>`;
  }).join('')}</div></section>`;
}
function renewal(account) {
  const dates = account.renewal || {};
  if (account.provider === 'claude' && !dates.nextAt) return '';
  const stale = dates.stale || account.status !== 'ok';
  return `<div class="account-renewal">
    <span>Renewal${stale && dates.nextAt ? ' · last known' : ''}</span>${dates.nextAt
      ? `<time data-renewal="${dates.nextAt}" data-past="${dates.nextAt <= Date.now()}" title="${esc(utc(dates.nextAt))} · Reported subscription expiry; not a quota reset"><b class="renewal-countdown">${renewalDays(dates.nextAt)}</b><span>${esc(renewalDate(dates.nextAt))}</span></time>`
      : '<span class="renewal-unknown">Not reported</span>'}
    ${dates.lastAt ? `<span>Last renewal</span><time title="${esc(utc(dates.lastAt))}">${esc(renewalDate(dates.lastAt))}</time>` : ''}
  </div>`;
}
function resetBalance(account, kind) {
  const resets = account.resets || {}, balance = resets[kind], label = kind === 'full' ? 'Full resets' : '5-hour resets';
  const expirations = resets.expirations?.[kind]?.length ? resets.expirations[kind] : [{ count: balance, expiresAt: null }];
  return `<div class="reset-balance${balance === 0 ? ' empty' : ''}" data-kind="${kind}"><div class="reset-count"><span>${label}</span><strong>${balance ?? '—'}</strong></div>${balance > 0
    ? `<div class="reset-expiries"><div class="reset-expiry-head" aria-hidden="true"><span>Qty</span><span>Expires</span><span>Left</span></div>${expirations.map(entry => `<div class="reset-expiry" title="${esc(`${entry.count} ${kind === 'full' ? 'full' : '5-hour'} reset${entry.count === 1 ? '' : 's'} · ${utc(entry.expiresAt)}${account.status !== 'ok' ? ' · Last known; refresh status' : ''}`)}"><span class="reset-expiry-count" aria-label="${entry.count} reset${entry.count === 1 ? '' : 's'}">${entry.count}</span>${entry.expiresAt
      ? `<time data-reset-expiry="${entry.expiresAt}" datetime="${new Date(entry.expiresAt).toISOString()}" data-expired="${entry.expiresAt <= Date.now()}"><span class="reset-expiry-date">${esc(renewalDate(entry.expiresAt))}</span><span class="reset-expiry-days">${expiryDays(entry.expiresAt)}</span></time>`
      : '<span class="reset-expiry-date">Not reported</span><span class="reset-expiry-days">—</span>'}</div>`).join('')}</div>` : ''}</div>`;
}
function accountRow(a, fable = true) {
  const resets = a.resets || {}, operation = resets.operation;
  const review = operation?.state === 'unknown', pending = operation?.state === 'pending';
  const usable = a.status === 'ok' && resets.enabled && (resets.usable?.full || resets.usable?.five);
  const reason = resetReason(a);
  const shortReason = reason.includes('identity') ? 'Identity missing' :
    reason.includes('applicable') ? 'Not eligible now' :
    reason.includes('credits remaining') ? 'No credits' :
    reason.includes('configuration') ? 'Read-only mode' :
    reason.includes('quota data') ? 'Quota unavailable' : 'Why unavailable?';
  const statusLabel = a.status === 'ok' ? '' : `<span class="stale">${esc(a.status)}</span>`;
  const wait = !usable && !review && !pending ? resetWait(a) : null;
  const cachedAge = a.status === 'stale' && a.observedAt ? ` · read ${ago(a.observedAt)}` : '';
  const note = (a.status === 'stale' ? `${a.error || 'Live quota read failed; showing last known values; reset disabled'}${cachedAge}` : a.error) ||
    (a.sharedResetScope ? 'Shares a provider reset scope with another credential.' : a.extraWindows?.length ? 'Another quota period was reported; it is not treated as weekly.' : '');
  return `<article class="account-grid refined-account" role="row" data-account="${a.id}" data-status="${esc(a.status)}" data-fable="${fable}">
    <div class="identity-cell" role="rowheader"><div class="identity-title"><strong class="account-name-truncated" title="${esc(a.label)}">${esc(a.label)}</strong><span class="plan-badge" title="Provider or credential-reported plan">${esc(planName(a.plan))}</span></div><span class="account-id">#${a.id.slice(0, 8)} ${statusLabel}</span>${renewal(a)}${note ? `<p class="account-notice" title="${esc(note)}">${esc(note)}</p>` : ''}</div>
    ${quotaKeys(a.provider, fable).map(key => limit(a, key)).join('')}
    <div class="resets-cell" role="cell">${resetBalance(a, 'full')}${a.provider === 'codex' && resets.five == null ? '' : resetBalance(a, 'five')}</div>
    <div class="account-action" role="cell"><button class="account-reset ${review ? 'review' : ''}" data-action="${review ? 'review' : 'reset'}" data-account-id="${a.id}" ${pending || (!review && !usable) || resetBusy ? 'disabled' : ''} title="${esc(review ? 'Review uncertain result; this does not repeat the reset' : reason)}" aria-label="${review ? 'Review reset outcome for' : 'Reset'} ${esc(a.label)}">${review ? 'Review' : pending ? 'Pending' : '↻ Reset'}</button>
    ${wait ? `<span class="reset-wait" title="${esc(`${reason} · usable from ${utc(wait)}`)}"><span>Available in</span><time data-reset="${wait}" data-urgency="${timeTone(wait)}">${countdown(wait)}</time></span>` : ''}
    ${!usable && !review && !pending ? `<button class="reset-reason" data-action="explain" data-account-id="${a.id}" title="${esc(reason)}" aria-label="Why reset is unavailable for ${esc(a.label)}">${esc(shortReason)}</button>` : ''}
    ${a.lastReset ? `<small class="last-operation" title="${esc(utc(a.lastReset.createdAt))}">Last: ${esc(a.lastReset.outcome || a.lastReset.state)}</small>` : ''}</div>
  </article>`;
}
function render() {
  if (!snapshot) return;
  const accounts = snapshot.accounts;
  $('account-summary').textContent = `${accountCount(accounts.length)} · ${accounts.filter(a => a.status === 'ok').length} reporting`;
  const providers = [...new Set(accounts.map(a => a.provider))].sort((a, b) => {
    const rank = p => p === 'codex' ? 0 : p === 'claude' ? 1 : 2;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  $('summary').innerHTML = providers.map(provider => snapshot.summaries.find(group => group.provider === provider))
    .filter(Boolean).map(group => summary(group, hasFable(accounts))).join('');
  $('accounts-root').innerHTML = providers.map(provider => {
    const group = accounts.filter(a => a.provider === provider), fable = hasFable(group);
    return `<section class="sidebar-provider"><div class="group-heading"><h2>${esc(providerName(provider))}</h2><span>${accountCount(group.length)} · ${group.filter(a => a.status === 'ok').length} reporting</span></div>
      <div class="provider-table" data-provider="${esc(provider)}" data-fable="${fable}" role="table" aria-label="${esc(providerName(provider))} usage"><div class="account-grid table-head" role="row"><div role="columnheader">Account <span>plan</span></div>${quotaKeys(provider, fable).map(key => `<div role="columnheader">${key === 'five' ? '5-hour limit' : key === 'week' ? 'Weekly limit' : 'Fable weekly'}</div>`).join('')}<div role="columnheader">Resets left</div><div class="action-heading" role="columnheader">Action</div></div>${group.map(a => accountRow(a, fable)).join('')}</div></section>`;
  }).join('') || '<p class="empty-state">No credentials were returned by CLIProxyAPI. Add accounts in its existing management UI.</p>';
  $('global-error').hidden = !snapshot.error && snapshot.resetsEnabled;
  $('global-error').textContent = snapshot.error ? 'The proxy is unavailable. Last-known values are marked stale; reset actions are disabled.' :
    'Read-only mode. Provider resets are disabled by the dashboard configuration.';
  $('connection-state').textContent = snapshot.error ? 'Proxy unavailable' : 'Connected to CLIProxyAPI';
  tick();
}
async function load(afterMutation = false) {
  if (!csrf) return;
  if (loading) { if (afterMutation === true) refreshAgain = true; return; }
  loading = true; const generation = epoch;
  $('refresh-now').disabled = true;
  try {
    const data = await request('GET', 'dashboard');
    if (generation !== epoch) return;
    snapshot = data; render();
  } catch (error) {
    if (generation === epoch) {
      $('global-error').hidden = false; $('global-error').textContent = errorText(error.message);
      if (snapshot) {
        snapshot.accounts.forEach(a => { a.status = 'stale'; a.resets.enabled = false; });
        snapshot.summaries.forEach(group => Object.values(group.values).forEach(value => {
          value.remaining = null; value.reporting = 0;
        }));
        snapshot.error = 'proxy_unavailable'; render();
      }
    }
  } finally {
    loading = false; $('refresh-now').disabled = false;
    nextPoll = csrf && !paused ? pollAt() : null; tick();
    if (refreshAgain && csrf) { refreshAgain = false; await load(); }
  }
}
// Re-read shortly after a known reset-availability instant instead of waiting for the next 5-minute poll.
function pollAt() {
  const now = Date.now();
  const waits = (snapshot?.accounts ?? []).map(account => resetWait(account, now - 5000)).filter(Boolean);
  return Math.min(now + 300000, ...waits.map(at => at + 5000));
}
function closeDialog() { if (!resetBusy) $('local-dialog').close(); }
function dialogBase(account, title) {
  const dialog = $('local-dialog');
  dialog.innerHTML = `<form class="account-reset-form"><header><h2 id="dialog-title">${esc(title)}</h2><button type="button" data-close aria-label="Cancel">×</button></header><div class="reset-target"><strong>${esc(account.label)}</strong><span>${esc(providerName(account.provider))} · ${esc(account.plan || 'Plan unknown')} · #${account.id.slice(0, 8)}</span></div><div id="dialog-content"></div><p id="dialog-error" class="error-text" role="alert" hidden></p><div class="dialog-actions"><button type="button" data-close>Cancel</button><button type="submit" id="dialog-submit">Check eligibility</button></div></form>`;
  dialog.querySelectorAll('[data-close]').forEach(button => { button.onclick = closeDialog; });
  dialog.showModal(); dialog.querySelector('[data-close]').focus();
  return dialog;
}
function lockDialog(locked) {
  resetBusy = locked; $('sign-out').disabled = locked;
  $('local-dialog').querySelectorAll('button,input').forEach(el => { el.disabled = locked; });
}
function resultText(receipt) {
  const values = {
    accepted: 'The provider accepted the reset request. The dashboard will re-read the actual quota.',
    reset: 'The provider reports that the reset was applied. No other account was included.',
    already_used: 'The provider reports this reset was already used.',
    not_limited: 'The provider refused the reset because the account is not limited.',
    cooldown: 'The provider reports a reset cooldown. No automatic retry was made.',
    ineligible: 'The account is not eligible for this reset.',
    unavailable: 'This reset is unavailable.',
    nothing_to_reset: 'The provider reports that no rate-limit window currently needs resetting.',
    no_credit: 'The provider reports that no reset credit is available.',
    already_redeemed: 'The provider reports this reset request was already redeemed.',
    auth_error: 'Provider authorization was refused. Check the account in CLIProxyAPI.',
    rate_limited: 'The provider rate-limited the reset request. No automatic retry was made.'
  };
  return receipt.state === 'unknown' || receipt.state === 'pending'
    ? 'The outcome is uncertain or pending. Do not repeat this reset. Refresh status and review the recorded operation.'
    : values[receipt.outcome] || 'The operation was recorded. Refresh provider status before any further action.';
}
function resetDialog(account) {
  const options = ['full', 'five'].filter(kind => account.resets.usable?.[kind]);
  if (account.status !== 'ok' || !account.resets.enabled || !options.length) return;
  const dialog = dialogBase(account, 'Reset this account');
  $('dialog-content').innerHTML = `<p class="reset-scope">Only this account can be targeted. There is no bulk reset.</p><fieldset><legend>Choose scope</legend>${options.map((kind, i) => `<label class="reset-option"><input type="radio" name="kind" value="${kind}" ${i === 0 ? 'checked' : ''}><span><strong>${kind === 'full' ? 'Full / provider reset' : '5-hour only'}</strong><small>Current eligibility will be checked again.</small></span><b>${account.resets[kind] ?? '—'} left</b></label>`).join('')}</fieldset>`;
  let prepared = null;
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    if (resetBusy) return;
    const current = snapshot?.accounts.find(a => a.id === account.id);
    if (!current || current.status !== 'ok' || !current.resets.enabled) {
      $('dialog-error').hidden = false;
      $('dialog-error').textContent = errorText('provider_status_unavailable');
      return;
    }
    const generation = epoch;
    lockDialog(true); $('dialog-error').hidden = true;
    const submittingReset = !!prepared;
    try {
      if (!prepared) {
        const kind = dialog.querySelector('[name=kind]:checked')?.value;
        prepared = await request('POST', `accounts/${account.id}/reset/prepare`, { kind });
        if (generation !== epoch) return;
        $('dialog-title').textContent = 'Confirm provider reset';
        dialog.querySelector('.reset-target').innerHTML = `<strong>${esc(prepared.label)}</strong><span>${esc(providerName(prepared.provider))} · #${prepared.accountId.slice(0, 8)}</span>`;
        $('dialog-content').innerHTML = `<p class="reset-scope">This spends one <strong>${esc(prepared.grantLabel)}</strong> on this account only.</p><ul class="confirmation-details">${prepared.clears.map(scope => `<li>${esc(scope)}</li>`).join('')}</ul><p class="reset-disclaimer">${esc(prepared.warning)} Only provider-listed windows are requested; other limits are not assumed to reset.</p><p class="dialog-note">Confirmation expires at ${esc(utc(prepared.expiresAt))}.</p>`;
        $('dialog-submit').textContent = 'Confirm reset';
      } else {
        const receipt = await request('POST', `accounts/${account.id}/reset`, { operationId: prepared.operationId });
        if (generation !== epoch) return;
        $('dialog-content').innerHTML = `<p class="reset-result">${esc(resultText(receipt))}</p>`;
        $('dialog-submit').hidden = true;
        dialog.querySelector('.dialog-actions [data-close]').textContent = 'Close';
        await load(true);
      }
    } catch (error) {
      if (generation !== epoch) return;
      $('dialog-error').hidden = false;
      $('dialog-error').textContent = submittingReset && error.message === 'network_error'
        ? 'No response was received. The reset may have been sent. Do not repeat it; refresh status and inspect the recorded outcome.'
        : errorText(error.message);
      // Never turn a failed/uncertain mutation into an automatic retry button.
      if (submittingReset) { $('dialog-submit').hidden = true; await load(true); }
    } finally {
      lockDialog(false);
      if (generation === epoch) render();
    }
  };
}
function reviewDialog(account) {
  const operation = account.resets.operation;
  if (!operation || operation.state !== 'unknown') return;
  const dialog = dialogBase(account, 'Review uncertain reset');
  $('dialog-content').innerHTML = `<p class="reset-disclaimer">A ${esc(operation.kind)} reset requested at ${esc(utc(operation.createdAt))} may have consumed a credit. It will not be retried automatically.</p><p class="dialog-note">Check the provider’s current usage and reset balance. Marking this reviewed only removes the local block; it does not prove the earlier request failed.</p><label class="review-checkbox"><input type="checkbox" required id="review-ack"> I have checked provider status and accept that a reset may have been used.</label>`;
  $('dialog-submit').textContent = 'Mark reviewed';
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault(); if (resetBusy || !$('review-ack').checked) return;
    const generation = epoch;
    lockDialog(true);
    try {
      await request('POST', `accounts/${account.id}/reset/review`, { operationId: operation.id, acknowledge: true });
      if (generation !== epoch) return;
      dialog.close(); toast('Marked reviewed locally. No reset was retried.'); await load(true);
    } catch (error) { if (generation === epoch) { $('dialog-error').hidden = false; $('dialog-error').textContent = errorText(error.message); } }
    finally { lockDialog(false); render(); }
  };
}
function explainReset(account) {
  const resets = account.resets || {};
  const reason = resetReason(account);
  const dialog = dialogBase(account, 'Why reset is unavailable');
  const wait = resetWait(account);
  $('dialog-content').innerHTML = `<p class="reset-disclaimer">${esc(reason)}</p>${wait ? `<p class="dialog-note">Provider-reported availability at <strong>${esc(utc(wait))}</strong>, in <time data-reset="${wait}">${countdown(wait)}</time>. ${paused ? 'Auto-refresh is paused; refresh manually after this time.' : 'The dashboard re-reads status shortly after.'} Availability still needs provider confirmation.</p>` : ''}<p class="dialog-note">Reported full credits: <strong>${resets.full ?? 'Unknown'}</strong><br>Reported 5-hour credits: <strong>${resets.five ?? 'Unknown'}</strong></p><p class="dialog-note">Refreshing reads current availability; this information view does not perform a reset. The provider decides the result of a confirmed redemption.</p>`;
  $('dialog-submit').hidden = true;
  dialog.querySelector('.dialog-actions [data-close]').textContent = 'Close';
  dialog.querySelector('form').onsubmit = event => event.preventDefault();
}

$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login-button').disabled = true; $('login-error').hidden = true;
  const key = $('management-key').value; $('management-key').value = '';
  try {
    const session = await request('POST', 'session', { managementKey: key });
    csrf = session.csrfToken; epoch += 1;
    $('sign-in').hidden = true; $('dashboard').hidden = false;
    await load(true);
  } catch (error) { $('login-error').textContent = errorText(error.message); $('login-error').hidden = false; }
  finally { $('login-button').disabled = false; }
};
$('sign-out').onclick = async () => {
  if (resetBusy) return;
  try { await request('POST', 'logout', {}); disconnected(); } catch (error) { toast(errorText(error.message)); }
};
$('refresh-now').onclick = load;
$('auto-toggle').onclick = () => {
  paused = !paused;
  try { localStorage.setItem('usage-dashboard-paused', String(paused)); } catch { /* Optional preference. */ }
  nextPoll = csrf && !paused ? Date.now() : null; tick();
};
$('accounts-root').onclick = event => {
  const button = event.target.closest('button[data-account-id]');
  if (!button || button.disabled || resetBusy) return;
  const account = snapshot?.accounts.find(a => a.id === button.dataset.accountId);
  if (!account) return;
  if (button.dataset.action === 'explain') explainReset(account);
  else if (button.dataset.action === 'review') reviewDialog(account);
  else resetDialog(account);
};
$('local-dialog').addEventListener('cancel', event => { if (resetBusy) event.preventDefault(); });
$('insecure-warning').hidden = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
setInterval(() => { tick(); if (csrf && !paused && nextPoll && Date.now() >= nextPoll) load(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && csrf && !paused && nextPoll && Date.now() >= nextPoll) load(); });
try {
  const session = await request('GET', 'session');
  if (Number.isInteger(session.sessionTtlHours) && session.sessionTtlHours > 0) {
    const hours = session.sessionTtlHours;
    $('session-lifetime').textContent = hours % 24 === 0
      ? `${hours / 24} ${hours === 24 ? 'day' : 'days'}` : `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  if (session.authenticated) { csrf = session.csrfToken; $('sign-in').hidden = true; $('dashboard').hidden = false; await load(); }
} catch (error) { $('login-error').textContent = errorText(error.message); $('login-error').hidden = false; }
