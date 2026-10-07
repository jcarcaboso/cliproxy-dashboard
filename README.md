# CLIProxy usage dashboard

A standalone dashboard for an existing CLIProxyAPI v8 server. It does **not**
replace `management.html`, change the proxy, or rebuild its authentication and
settings screens.

The module uses Node.js 24 and browser-native HTML/CSS/JavaScript. It has no npm
runtime dependencies and no imports from the surrounding Go repository. Copy
this directory into its own repository whenever you want.

## Published image

Source: https://github.com/jcarcaboso/cliproxy-dashboard. Releases are
published to the **public** Docker Hub repository `skorcius/cliproxy-dashboard`.
Each release's pinned digest, image config digest and build-input hashes are in
`releases/<version>.json`. Tags are immutable and there is no `latest` tag.
Releases before 0.1.8 were built from a local module snapshot; 0.1.7 is
imported here as the first commit, byte-identical to its manifest.

See [docs/RELEASING.md](docs/RELEASING.md) for the release and deployment steps.

No Docker Hub login or pull token is required. To use the published image with
the standalone Compose file, set `DASHBOARD_IMAGE` to a pinned reference from
`releases/` in `.env`, then run:

```sh
docker compose pull dashboard
docker compose up -d --no-build dashboard
```

Use `--no-build` with a digest-pinned image. The source-build workflow below
uses the default local image name instead.

The live instance runs at `https://cliproxy.mlab.alpetxino.com/usage/`. Its
manually approved service declaration lives in the homelab nodes repository
under `homelab/services/apps-mrb-01_cliproxy-dashboard/`. That instance has
per-account reset controls enabled at the user's request. Standalone
installations are read-only by default.

## What it does

- Shows all returned credentials, grouped by provider.
- Reads Codex 5-hour/weekly usage, plan and reset credits.
- Reads Claude 5-hour/weekly usage, plan, Fable quota and reset grants.
  Fable is shown only for accounts reporting the Max 20x tier or recorded Fable
  usage. A zero-utilization window alone is not treated as an entitlement.
  A Claude table with no Fable account drops the column entirely.
- When a Claude reset grant is in cooldown or has not started, shows a live
  countdown to the provider-reported instant it becomes usable. The dashboard
  re-reads shortly after it passes.
- Retries a transient provider usage failure once. If the read still fails, it
  shows the last good reading as stale (resets disabled) with its age. That
  reading is shared across sessions and dropped after 15 minutes, as soon as one
  of its windows resets, when the credential identity changes, and after any
  reset redemption in its scope.
- Keeps disabled, unsupported and unavailable accounts visible rather than
  inventing usage or silently dropping them.
- Provides manual refresh and fixed five-minute auto-refresh with Pause/Resume.
- Uses the selected sidebar layout, Codex-first averages, aligned limits, plan
  badges and colored reset countdowns. Providers without accounts are hidden.
- Shows compact renewal countdown/date and explicit reported renewal history.
  Activation dates are not displayed, and undated Claude subscription fields
  are hidden. Missing billing history is not inferred.
- Shows days left and expiry dates for positive reset balances, grouped by full
  or five-hour scope and expiry. Sparse details leave undated credits explicit.
- Supports configurable session lifetime through `SESSION_TTL_HOURS` and shows
  that duration on the sign-in page.
- Offers **one-account-only** provider resets when explicitly enabled and
  currently allowed by the provider.

### Provider-specific layout and local preview

The user-approved layout shipped in `0.1.7`. Codex omits the Fable column and
uses the recovered space for aligned reset quantity, expiry date and days-left
columns. In `0.1.8`, Claude shows Fable only for eligible accounts and omits
the column when none qualify. Unsupported Codex 5-hour reset balances
are omitted; actual reported balances remain visible. An elapsed subscription
date reads **Date passed**, without guessing a new date.

The temporary review listener was stopped after the approved deployment. To
review this layout again with synthetic accounts and no management key:

```sh
node test/layout-preview.js
# http://127.0.0.1:8788/
```

The `/no-fable/` fixture has no eligible Fable accounts. The `/countdown/`
fixture starts a twelve-second reset cooldown and reports eligibility on the
next read after it expires. Both are read-only and block reset requests.

Set `HOST=0.0.0.0` to serve the sample preview on a reachable LAN/Tailscale
interface. The fixture makes no proxy/provider connections, disables management
key entry and rejects every non-GET request. It is excluded from the production
Docker image. It is a development fixture, not an authentication or production mode.

Only Codex and Claude have quota adapters initially. Other providers appear as
unsupported. Provider APIs may omit fields or change; unknown means unknown,
not zero or a simulated limit.

Rows represent proxy credential records. Multiple records can refer to the
same provider account and share its quota. Shared reset scopes are marked,
and pending/unknown operations also block aliases of the same reported provider
account or organization. A reset still sends one credential-specific request;
other tokens for that same underlying account will naturally see its new quota.

### “Overall” values

The sidebar shows the **average remaining percentage of reporting account entries**
within each provider/window. It excludes stale/unknown readings and displays
coverage. This is not pooled capacity or a plan-weighted total: the provider
responses do not consistently supply comparable account capacities.

A reported monthly window is not shown as a weekly allowance. Fable is read
from its own provider window, not copied from the general weekly percentage.

## Run with an existing proxy

### Standalone Compose

```sh
cd cliproxy-dashboard
cp .env.example .env
# Edit CLIPROXY_BASE_URL and PUBLIC_ORIGIN.
docker compose up -d --build
```

Open the address in `PUBLIC_ORIGIN` and enter your existing **management key**.
This is not a client API key and not an OAuth access token.

Defaults:

- Browser: `http://localhost:8080`, bound to host loopback.
- Upstream: `http://host.docker.internal:8317` from the container.
- Provider resets: **disabled**.
- Persistent operation journal: named volume `dashboard-state`.

Set `CLIPROXY_BASE_URL` to the proxy's root/base path, **not** `/v1` or
`/v8/management`. The dashboard container must be able to reach it. The proxy
must permit management requests from that container and require a strong key.
Do not expose the management API publicly just to make this work.

For remote use, put the dashboard behind your HTTPS reverse proxy and set the
exact browser-facing origin, for example `PUBLIC_ORIGIN=https://usage.example.com`.
When changing the published port, change `PUBLIC_ORIGIN` too. No wildcard CORS
or automatic trust of forwarded host headers is used. A reverse-proxy path
prefix can be used if it is stripped before forwarding and the browser URL
ends with `/`.

Use HTTPS for upstream management traffic outside a trusted local network.
For a private CA, mount the CA certificate and set `NODE_EXTRA_CA_CERTS`; do not
disable certificate verification.

### Optional integration with this checkout's existing Compose

An off-by-default `dashboard` profile adds only `usage-dashboard`:

```sh
# Existing cli-proxy-api service should already be running.
docker compose --profile dashboard up -d --build usage-dashboard
```

It connects to `http://cli-proxy-api:8317` on the existing Compose network.
It has no `depends_on`, so this command does not build or restart the proxy.
The proxy service, image, credential volumes and stock management UI are
unchanged.

Root-Compose overrides use `DASHBOARD_PROXY_URL`, `DASHBOARD_PUBLIC_ORIGIN`,
`DASHBOARD_PORT`, `DASHBOARD_BIND_HOST`, and `DASHBOARD_ENABLE_RESETS`.
The standalone module uses the shorter names in its `.env.example`.

### Native Node

```sh
cd dashboard
CLIPROXY_BASE_URL=http://127.0.0.1:8317 \
PUBLIC_ORIGIN=http://localhost:8080 npm start
```

`npm start` loads `.env` if present. Native mode binds to `127.0.0.1` by default;
Docker sets `HOST=0.0.0.0` inside the container. Other settings are `PORT`
(default 8080) and `DATA_DIR` (default `.data`).

## Authentication and trust

The management key is verified by CLIProxyAPI and held only in this process's
session memory. It is not written to disk, returned to the browser, placed in
URLs, or stored in browser local/session storage. A restart requires sign-in
again. `SESSION_TTL_HOURS` sets an absolute lifetime from 1 to 720 hours, with
an eight-hour default for the portable module. The selected instance uses
`168` (seven days). The browser cookie expires at the same time; sign-out or
management-key rejection still ends the session immediately.

The session uses an HttpOnly, SameSite=Strict cookie, with Secure and a `__Host-`
prefix under HTTPS. Mutations require both the configured Origin and a
per-session CSRF token. The UI has no external scripts/assets. Upstream labels
are escaped; errors use fixed messages rather than leaking upstream bodies.
Use a dedicated trusted hostname for production, not an origin shared with
untrusted applications.

The browser cannot submit arbitrary provider URLs, headers, auth indices,
organizations or grant IDs. The server selects fixed routes and re-resolves
the chosen credential. OAuth tokens remain in CLIProxyAPI: its authenticated
`requests/api-call` resolves `Bearer $TOKEN$` for that credential.

This is an operator dashboard using management-key privileges, not a multi-user
tenant/role system. Credential login, account enrollment, settings and key
management remain in the stock CLIProxyAPI UI.

## Real resets — disabled until you opt in

Review [the API contract](docs/API.md), then set `ENABLE_RESETS=true` in the
standalone configuration (or `DASHBOARD_ENABLE_RESETS=true` in root Compose).
Recreate **only the dashboard container**.

Reset counts are provider-reported credits/grants, not the prototype's numbers.
Claude grants enforce eligibility, cooldown, expiry and at-limit requirements.
Codex uses the authoritative banked balance; usage applicability hints do not
disable manual redemption. Missing identity, stale/unavailable data and an
unresolved prior attempt still block either provider. A disabled button now
has a clickable explanation; reading it never consumes a reset.

1. Choose one account and an offered scope.
2. **Check eligibility** reads fresh status and creates a 60-second confirmation.
3. Review the resolved account and exact provider-listed windows.
4. **Confirm reset** rechecks identity, eligibility, count and scope, then sends
   exactly one provider mutation.

There is no bulk reset. Codex uses its reset-credit consume endpoint. Claude
uses its eligible grant, organization and `cedar_ember` program contract.
The UI does not promise that Fable is cleared unless the provider says so.
The dashboard never sets usage to 100% itself; it re-reads the provider.

### Uncertain outcomes

Before sending a mutation, a pending record is atomically written and fsynced
to `DATA_DIR/reset-operations.json`. The journal contains opaque account and
operation IDs, request IDs, timestamps and outcomes—**no management/OAuth key**.

- A duplicate confirmation returns the same operation, not another mutation.
- A lost response, unrecognized result or pending record after restart is
  **unknown** and blocks further resets for that account.
- Nothing automatically retries a reset, including after restart.
- An operator must inspect current provider status and explicitly mark the
  operation reviewed. Review removes the local block; it does not retry,
  refund, or prove that the earlier request failed.

Preserve the journal volume when upgrading or moving deployments. Do not use
`docker compose down -v` to “fix” a pending reset. Back it up with the dashboard
stopped, and do not share one journal between multiple processes/replicas.
This service is designed for a single instance. It refuses further writes if
the journal reaches its bounded record limit; archive settled/reviewed history
while stopped, retaining unresolved records.

## Verification

```sh
npm run check
npm test
docker compose config --quiet
docker build -t cliproxy-dashboard:local .
```

Tests use a local fake CLIProxyAPI and provider responses. They verify quota and
plan normalization, Fable precedence, missing data, authentication, CSRF, scope
binding, no secret projection, stale reads, read-only mode, confirmation expiry,
identity changes, single-account reset behavior, concurrency/idempotence and
unknown-outcome persistence across restart.

Verified during development on October 4, 2026:

- 29 tests passed natively, inside the built Node 24 container, and after copying
  the module outside the Go checkout.
- Both standalone and root-profile Compose configurations validated. Without
  the optional profile, root Compose still selects only `cli-proxy-api`.
- The container ran as UID 1000 with a read-only root filesystem and could
  durably write/recover its operation journal on a separate volume.
- The real browser flow passed against the local fake upstream: sign-in,
  Codex confirmation, Claude 5-hour confirmation, unchanged other windows,
  server-only session cookie, no key in DOM/storage, manual refresh while
  paused, and a 390px layout without horizontal overflow.
- Temporary test containers, volumes, listener and firewall allowance were
  removed. The original design preview was left unchanged.

An optional integration preview runs the **real dashboard against a fake
upstream only**, never against the configured production URL:

```sh
node test/preview.js
# http://127.0.0.1:8788
# Deliberately fake test key: test-management-key-not-a-real-secret
```

This fixture is excluded from the Docker image. Test records are labeled
`Fixture / ...`; stop it with Ctrl+C.

The initial module development used only fixtures. Each release records its
test counts in `releases/<version>.json`; the homelab service README records
what was verified on the live deployment. Fixture checks never consume a reset.
Actual account data and entitlements must be checked after the operator
signs in; the pinned contract and fixture tests are not a live-provider guarantee.
