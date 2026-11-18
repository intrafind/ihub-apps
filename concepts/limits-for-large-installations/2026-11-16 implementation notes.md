# Limits for large installations — implementation notes

Goal: the shipped rate limits and LLM concurrency fit 10,000 employees (about 1,000 busy users at
the peak), possibly all behind one corporate NAT address. Background data: load-test plan RC13
("Rate limits and LLM throttling: does it hurt").

## What changed, and where

| Piece | File |
| --- | --- |
| Defaults (the one place for the values) | `server/defaults/config/platform.json` (`rateLimit.*`, `requestConcurrency`) |
| Migration for existing installs | `server/migrations/V254__limits_for_large_installations.js` — reads the new values from the defaults file via `ctx.readDefaultJson`; only the *old* values are constants in the migration |
| Per-user keys, IP+username sign-in key, per-IP ceiling | `server/middleware/rateLimiting.js` (`userKeyOptions`, `createAuthLimiter`, `USER_KEYED_LIMITERS`) |
| Mount order | `server/middleware/setup.js` — general limiters now after the auth chain and the anonymous-principal middleware; `authApi` and `oauthApi` stay before auth |
| Slow-slot log | `server/requestThrottler.js` (`noteSlotWait`, `getSlowSlotWaits`) |
| Admin UI | `server/routes/admin/rateLimits.js`, `client/src/features/admin/components/RateLimitConfig.jsx`, i18n `admin.security.rateLimits.*` in `shared/i18n/{en,de}.json` |
| Schema (docs/JSON schema) | `server/validators/platformConfigSchema.js` (`keyBy`, `anonymousLimit`, `perIpLimit`) |
| Docs | `docs/sizing.md#limits-for-large-installations`, `docs/rate-limiting.md`, `docs/platform.md`, `docs/server-config.md`, release note in `docs/releases/next/breaking-changes.md` |

## How user keying works

1. `setup.js` runs: body parsers → `authApi`/`oauthApi` limiters (per IP / IP+username) → auth chain
   (proxy, Teams, JWT, ...) → anonymous principal → **general limiters** → routes.
2. At that point `req.user.id` is the user id (or OAuth client id), or `'anonymous'`.
3. `keyGenerator`: `user:<id>` for a signed-in request, `ip:<ipKeyGenerator(req.ip)>` otherwise.
   `limit` is a function: `limit` for users, `anonymousLimit` (fallback `limit`) for anonymous.
4. Stores stay per-worker `MemoryStore` (no bus round trip), so the effective limit is ×WORKERS.
5. A 401 from the auth chain (bad token) is answered before the general limiters run and is not
   counted. Accepted: verifying a JWT is cheap, and the general limiters skip failed requests anyway.

## Changing the defaults

Edit `server/defaults/config/platform.json` only. V254 picks the values up from there (until it has
been released; after that, a change of defaults needs a new migration). The code fallbacks in
`LIMITER_FALLBACKS` are used only when a config lacks a key; `authApi.perIpLimit: 5000` mirrors the
defaults file.

## Open points

- Final numbers wait for the load-test measurements (i-rl, i-conc).
- Concurrency: decided against a separate default for self-hosted models (`requestConcurrencyLocal`
  and a list of hosted API domains). `requestConcurrency` rises from 5 to 25 for every model;
  admins set `concurrency` on a model with a small backend or a rate-limited key.
- Optional later: per-worker throttle slots with borrowing from the primary (saves ~25 ms per model
  call); not done.
