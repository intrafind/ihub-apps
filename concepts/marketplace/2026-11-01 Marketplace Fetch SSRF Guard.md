# Marketplace Fetch SSRF Guard

**Date:** 2026-11-01
**Status:** Implemented
**Ticket:** GitHub [intrafind/ihub-apps#3087](https://github.com/intrafind/ihub-apps/issues/3087)
**Branch:** `claude/exciting-feynman-2aju98-marketplace-ssrf`
**Related:** [Marketplace docs → Security](../../docs/marketplace.md#security),
[Backend Implementation Summary](2026-02-24%20Backend%20Implementation%20Summary.md)

---

## Problem

Every marketplace download — the catalog, an item with `source.type: "url"`, skill companion
files, `discoverCompanions` (GitHub tree), integration companion files (`source.rawBase`) — went
through `throttledFetch` → `httpFetch` **without** an SSRF check, on purpose: a registry is
configured by an admin, and a registry inside the company network is a supported setup.

But the catalog is written by the registry's publisher, not by the admin. A public registry could
point a companion file (or an item, or a redirect) at `http://169.254.169.254/…` or any other
internal address, and the server would fetch it. The earlier review already stopped the registry
credentials from leaking to such hosts (`sharesCredentialScope`); the fetch itself still happened.

## Decision (2026-10-31, final)

A guard that **admits the registry's own hosts** and requires a **public target for everything
else**:

| Target                                                       | Public check? |
| ------------------------------------------------------------ | ------------- |
| The registry's catalog host (`URL.host` of `registry.source`, so the port counts) | No |
| The item's manifest / companions, when their host **is** the catalog host        | No |
| `api.github.com` + `raw.githubusercontent.com`, for a GitHub registry (catalog on `raw.githubusercontent.com`, `github.com` or `api.github.com`) | No |
| Any other host                                               | Yes: `assertPublicTarget` |

Redirects are followed by hand and every hop is checked again by the same rules.

Consequence: private registries keep working (their own host is admitted); what stops is a public
registry steering the server to an internal address. A private registry whose items live on a
*different* internal host than its catalog is refused — documented in the changelog and docs.

## Design

All code lives in `server/services/marketplace/marketplaceFetch.js`:

- `registryOwnHosts(registry)` — the `Set` of `URL.host` values admitted without the check.
- `assertAllowedMarketplaceTarget(url, registry)` — one hop: parses the URL (http/https only),
  admits the registry's own hosts, otherwise runs `marketplaceTargetGuard.checkTarget` (which is
  `assertPublicTarget` from `server/utils/ssrfGuard.js`). Returns the addresses to pin the
  connection to, or throws `MarketplaceTargetError` (`code: 'MARKETPLACE_TARGET_BLOCKED'`,
  `host`, a message naming the host).
- `marketplaceFetch(throttleId, url, { registry, headers, authHeaders })` — the one function every
  marketplace download goes through:
  - checks the hop, then calls `throttledFetch` with `redirect: 'manual'` and, for a public
    host, `lookup: createPinnedLookup(addresses)` (closes the DNS-rebinding window; `httpFetch`
    keeps applying proxy and the SSL whitelist);
  - on 301/302/303/307/308 with a `Location`, closes the body, resolves the location against the
    current URL and loops; at most `MAX_MARKETPLACE_REDIRECTS` (5) hops;
  - a refused redirect hop gets `; reached through a redirect from '<host>'` appended;
  - `authHeaders` go to the first hop and to a later hop only when it shares the credential
    scope of the first URL (`sharesCredentialScope`: same scheme + host, or GitHub ↔ GitHub over
    https).
- `sharesCredentialScope(url, trustedUrls)` moved here from `ContentInstaller.js` (same logic,
  shares `GITHUB_HOSTS` with `registryOwnHosts`).

`marketplaceTargetGuard` is an object with a `checkTarget` property (not a bare import) so tests
can answer DNS from a table and serve a "public" host from loopback. Production never replaces it.

### Call sites

| Caller                                               | What it fetches                              |
| ---------------------------------------------------- | -------------------------------------------- |
| `RegistryService.js` → `fetchContent`                | Catalog (`fetchCatalog`), item preview (`getItemDetail`) |
| `RegistryService.js` → `fetchGitHubTree`             | Plugin marketplace tree, `discoverCompanions` |
| `ContentInstaller.js` → `fetchItemContent`           | The item manifest (install, update, user skill copy) |
| `ContentInstaller.js` → `buildSkillContent`          | Skill companion files                         |
| `ContentInstaller.js` → `fetchIntegrationCompanionText` | Integration companions, served release notes |

Every caller passes the `registry` object; `discoverCompanions(url, authHeaders, registry)` got
the third parameter.

### Error surfacing

- Install / update / refresh: the error propagates; the admin route answers 500 with the message
  (as for any other fetch error such as `HTTP 404`).
- Skill companions and companion discovery used to be best-effort (warn and skip); a
  `MARKETPLACE_TARGET_BLOCKED` error is now re-thrown so the admin sees the refused host.
- Item preview: logged as a warning, preview stays empty (unchanged behaviour for fetch errors).
- User skill copy (`marketplaceSkills.js`): generic 502 "marketplace could not be reached"; the
  host is only in the server log.

## Tests

`npm run test:marketplace` (root `package.json`) runs:

- `server/tests/marketplaceFetch.test.js` — unit tests of the guard (private registry host,
  port counts, GitHub pair, public third-party host, metadata / loopback / IPv6 loopback
  addresses and a name resolving to a private address, non-http schemes) and real HTTP against two loopback servers (credentials, redirect to a
  private address refused without the client following it, redirect to a public host without
  credentials, same-host redirect keeps credentials, redirect limit).
- `server/tests/ContentInstaller.integration.test.js` — integration companions on
  `169.254.169.254` refused, nothing fetched there.
- `server/tests/ContentInstaller.install-guards.test.js` — item manifest on the registry host
  fetched; on `169.254.169.254` refused before any request.
- `server/tests/ContentInstaller.compatibility.test.js` was not wired into any script before;
  it is now part of `test:marketplace`.

## Open points / follow-ups

- `fetchItemContent` and skill companions still send the registry credentials to the item URL
  even when the catalog puts the item on a third-party host (only integration companions are
  scoped by `sharesCredentialScope`). Scoping them too would change behaviour for registries
  whose items live on another host with the same token — needs a product decision.
- In a proxy-only network without external DNS, a third-party host cannot be resolved for the
  check and is refused. The registry's own host and the GitHub pair are not affected. Same
  behaviour as the other SSRF-guarded paths (`webContentExtractor`, `HttpNodeExecutor`).
