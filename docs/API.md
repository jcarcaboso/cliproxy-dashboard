# API boundary and provider contract

Verified against CLIProxyAPI source `d7914afdedca7af95ee974a42453dc49fc1388ce`
and the official Management Center source
`ee79a794526a30c03748a8864a9ac6589a31833b` on October 4, 2026.
The latter was still the official frontend's `main` commit when checked.
This is the contract used by that client, **not a stability guarantee from the
provider or a claim that every account has reset entitlements**.

## CLIProxyAPI

| Purpose | Existing v8 route |
|---|---|
| Verify management key and discover credentials | `GET /v8/management/credentials` |
| Read provider quota/profile and redeem verified resets | `POST /v8/management/requests/api-call` |

Each provider call supplies exactly one discovered `authIndex`, a fixed URL,
fixed headers and `Authorization: Bearer $TOKEN$`. CLIProxyAPI resolves the
provider token; the dashboard never downloads credential files.

The similarly named `/credentials/quota/providers`, `/credentials/quota/fetch`
and `/credentials/quota/reset` v8 routes are not registered in the inspected
server. The legacy management `ResetQuota` handler clears local routing
quota/cooldown state; it is **not** used here to impersonate replenished provider
allowance.

Sources:
- [v8 routes](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/server_management_v8.go)
- [removed-route regression tests](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/server_management_v8_test.go)
- [API-call implementation](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/handlers/management/api_tools.go)
- [local reset handler](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/handlers/management/quota.go)

## Codex

- Usage: `https://chatgpt.com/backend-api/wham/usage`.
- Credit status: `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`.
- Consume one reset: `POST .../rate-limit-reset-credits/consume`, with a unique
  `redeem_request_id`.

`used_percent` becomes remaining percentage. Windows are classified by
`limit_window_seconds`: 18,000 is five hours and 604,800 is weekly. Positional
primary/secondary fallback is used only when duration is absent. A reported
monthly/other duration is retained as an extra window, never labeled weekly.
Plan comes from usage, then the credential's projected metadata/ID-token claims.

Calls bind `Chatgpt-Account-Id` when available. A reset is not offered without
that identity. Credit status and identity are checked again before
confirmation. Codex has a provider-defined rate-limit reset scope here; a
5-hour-only Codex reset is not invented.

The reported `available_count` / `availableCount` is the banked balance and is
authoritative even when credit details are absent, null, empty or partial.
Usage-embedded totals supply a fallback when the credit endpoint omits totals.
Only when no total is reported do we count available detail entries, excluding
explicitly expired or invalid expiries; a null expiry is permitted.
`applicable_available_count` is a usage hint, not a manual-redemption permission
gate. This matches the official management frontend and native Codex v0.160.0.
Zero banked credits, unavailable status or missing identity still disable reset.

Consume response codes `reset`, `nothing_to_reset`, `no_credit` and
`already_redeemed` are terminal outcomes. Unknown codes remain uncertain and
block another attempt pending review. A legacy successful response with no code
is reported as accepted, not proof of replenished quota. An independent quota
read follows; failed refresh never causes another consume request.

Sources:
- [OpenAI app-server rate-limit contract](https://learn.chatgpt.com/docs/app-server)
- [Native Codex redemption UI](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/chatwidget/usage.rs)
- [request constants](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/utils/quota/constants.ts)
- [Codex data and consume calls](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/features/quota/providers/codex/data.ts)
- [reset-credit normalization](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/utils/quota/resetCredits.ts)

## Claude

Reads use `https://api.anthropic.com` with the upstream client's OAuth beta
header and token placeholder:

- Usage and grants: `/api/oauth/usage?cedar_ember=1&skip_spend=1`.
- Profile/organization: `/api/oauth/profile`.
- Claim: `POST /api/organizations/{organization_uuid}/reset_rate_limits`.
  Body: `program: "cedar_ember"`, provider-issued `grant_id`, unique `request_id`.

5-hour and weekly usage use `five_hour` / `seven_day` utilization. Fable prefers
the active `limits[]` record with `kind: weekly_scoped` and model display name
`Fable` or `Fable 5`, falling back to `iguana_necktie` when appropriate.
Explicitly inactive scoped windows are ignored. Plan labels use reported Team
status and Max/Pro flags; multipliers are not guessed.

The `cedar_ember` block must pass shape, ID, counter, timestamp and scope checks.
Eligibility, `usable_now`, pause, expiry, cooldown and `use_requires_limit` /
`at_limit` are enforced. Missing permission flags fail closed.

The dashboard offers:

- Full grants explicitly clearing both `five_hour` and `seven_day`.
- 5-hour grants explicitly clearing only `five_hour`.

Known `seven_day_overage_included` scope is shown when supplied. Unknown scopes
are not silently accepted. Multiple eligible grants are selected using the
provider's suggested next grant, then expiry. Confirmation lists the exact
scope of the selected grant. **Fable is not assumed to be cleared by a full
grant**, because the inspected claim contract does not list that window.

Known terminal results are `reset`, `already_used`, `not_limited`, `cooldown`,
`ineligible`, and `unavailable`. Definite authentication/rate-limit refusals are
reported separately. Unrecognized results, transport failure and ambiguous
HTTP failures become unknown and are never automatically replayed.

Sources:
- [Claude usage/Fable/plan mapping](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/features/quota/providers/claude/data.ts)
- [reset-grant validation and claim contract](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/services/api/claudeResetGrants.ts)

## Dashboard API

### Subscription renewal metadata

Codex adds a fixed, read-only
`GET https://chatgpt.com/backend-api/subscriptions?account_id={encoded_account_id}`
through the existing management API-call adapter, with the same account-bound
header. The upstream Management Center uses this endpoint for `active_until`.
Missing account identity skips this optional request. Failure does not disable
otherwise valid usage or reset controls.

Each account exposes only `renewal.nextAt`, `lastAt`, `startedAt` (epoch
milliseconds or null), and `stale`. The next date prefers the live subscription
expiry, then supported credential/JWT subscription metadata. Claude uses
explicit subscription dates from its existing OAuth organization profile and
credential metadata when present; that profile does not guarantee billing
renewal dates. Provider payloads are never forwarded to the browser.

The UI shows whole days until renewal and a UTC date in a compact account
metadata grid. `lastAt` requires an explicit last-renewal field and its row is
hidden when absent. Subscription activation/creation (`startedAt`) is retained
in the normalized API for compatibility but no longer displayed. Account
creation, OAuth token expiry and quota-reset dates are not billing history.
Claude renewal metadata is hidden entirely when no next-renewal date is known.
Missing Codex next-renewal dates read **Not reported**; no monthly cycle or
payment date is inferred. An expired date reads **Due · refresh**, without rolling it forward.
Retained dates after an optional read failure are marked last-known.

The contract follows the same pinned
[Codex subscription call](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/features/quota/providers/codex/data.ts),
[credential fallback](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/utils/quota/resolvers.ts)
and [Claude profile fields](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/ee79a794526a30c03748a8864a9ac6589a31833b/src/types/quota.ts).

### Reset-credit and grant expiry

`resets.expirations.full` and `.five` are arrays of `{count, expiresAt}` groups.
Counts sharing an expiry are combined and dates sorted earliest first; null
expiry groups are listed last. These are display metadata, not an additional
eligibility gate. No credit or grant IDs are exposed in these arrays.

Codex uses the `expires_at` / `expiresAt` fields of supported available credit
entries. The authoritative banked balance remains unchanged. Sparse/null
credit details leave the undated remainder explicit. Conflicting detail counts
cannot establish an expiry for the balance and produce an unknown-date group.
Claude uses `ends_at` from each supported full or five-hour grant, with its
reported `resets_left` count. Expired Claude grants remain labeled expired and
unusable; an expired/invalid Codex detail is not used to date a banked credit.
Quota resets, the grant program's weekly replenishment date, subscription
renewals and confirmation expiry are never substituted for credit/grant expiry.

For a positive balance the UI shows days left and a UTC expiry date for each
group beneath the matching reset count. Elapsed dates read **Expired**, missing
dates **Not reported**, and zero/unknown balances have no expiry rows. Distinct
expiry groups retain their credit counts rather than suggesting the entire
balance expires on the first date. The existing one-account confirmation,
fresh status checks and journal-protected mutation flow are unchanged.

The browser sees a restricted, same-origin API—not a generic management proxy:

| Method | Route | Behavior |
|---|---|---|
| POST | `/api/session` | Verify management key; issue memory-backed session |
| GET | `/api/session` | Session status and CSRF token, never the key |
| POST | `/api/logout` | End session |
| GET | `/api/dashboard` | Normalized live/stale quota data |
| POST | `/api/accounts/:id/reset/prepare` | Fresh eligibility and single-account confirmation |
| POST | `/api/accounts/:id/reset` | Revalidate and submit one immutable operation |
| POST | `/api/accounts/:id/reset/review` | Explicitly acknowledge uncertainty; does not retry |

`SESSION_TTL_HOURS` sets an absolute session lifetime between 1 and 720 hours;
the portable module defaults to 8. The selected deployment uses 168 hours
(seven days). The cookie's `Max-Age` matches the server-side expiry. This is not
a sliding idle timeout. `GET /api/session` returns the non-secret
`sessionTtlHours` even when signed out, so the login page can show the configured
duration. Sign-out, upstream management-key rejection and a process restart
still invalidate the memory-backed session. Neither the key nor sessions are
persisted to disk.

Mutations require Origin + CSRF validation. The reset journal is durable before
the provider call. Confirmation is bound to one opaque account ID, provider
identity, scope, grant, count, and request ID; it expires after 60 seconds.
The backend has no array/bulk reset target.

Where a provider identity is reported, a separate hashed reset scope prevents
duplicate credentials from bypassing in-flight/unknown operation guards.
Other open confirmations for that scope are invalidated after a mutation.
An older read in flight is refreshed again after a reset, rather than being
presented as the post-reset quota snapshot.

Management auth errors invalidate the session. Provider read failures preserve
last-known data as stale and disable writes. Unsupported fields remain unknown.
There are no custom network deadlines beyond the underlying runtime and
CLIProxyAPI's existing management API-call behavior; no streaming proxy code
is changed.

Security design reference:
[OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
