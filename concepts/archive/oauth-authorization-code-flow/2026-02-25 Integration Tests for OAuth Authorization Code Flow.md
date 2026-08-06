# Integration Tests for OAuth Authorization Code Flow

**Date:** 2026-02-25
**Feature:** OAuth Authorization Code Flow (PKCE)
**Task:** 12 – Integration tests / OIDC compliance verification

---

## Overview

This document describes the unit test suite that verifies the OAuth Authorization Code Flow
implementation without requiring a running server. All tests run with a single Node.js command
and produce a clear pass/fail summary.

---

## Test File Location

```
tests/oauth-auth-code-unit.js
```

Run with:

```bash
node tests/oauth-auth-code-unit.js
```

Expected output ends with `Results: 35 passed, 0 failed`.

---

## Test Structure

The file is a self-contained ES module that imports the production modules directly and
exercises them through their public API. It uses Node.js built-in `assert/strict` — no
additional test framework is required to run these tests.

A minimal in-file harness (`test()` / `section()`) wraps each case and accumulates pass/fail
counts, exiting with a non-zero code if any assertion fails.

### Test Sections

| Section | Tests | What is covered |
|---------|-------|----------------|
| PKCE Utils (RFC 7636) | 8 | `generateCodeVerifier`, `generateCodeChallenge`, `verifyCodeChallenge` correctness including the RFC 7636 Appendix B reference vector |
| Authorization Code Store (RFC 6749 §4.1.2) | 6 | `generateCode`, `storeCode`, `consumeCode`, `cleanup` — particularly single-use enforcement and unknown-code handling |
| Consent Store | 7 | `hasConsent`, `grantConsent`, `revokeConsent` — including scope superset logic and expiry detection |
| Well-Known Discovery Document | 2 | Structural check that `wellKnown.js` contains all mandatory OIDC Discovery fields |
| Route Registration | 3 | Structural check that `server.js` calls all three route registration functions |
| Backward Compatibility | 5 | Confirms `oauth.js` retains `client_credentials` and adds `authorization_code`, `refresh_token`, `/revoke`, `/userinfo` |
| JWT Auth Security | 4 | Verifies `jwtAuth.js` uses `getJwtVerificationKey()`, explicit `algorithms` array, no `resolveJwtSecret`, and handles `oauth_authorization_code` authMode |

---

## Design Decisions

### No Test Framework Dependency

The test runner is a ~20-line harness written in-file. This keeps the file runnable without
`npm install` in CI environments that do not have project dependencies installed, and makes the
file self-documenting for junior developers.

### Consent Store Side-Effect Isolation

`consentStore.js` writes to `contents/config/oauth-consent.json` on disk. The test suite:

1. Reads the file before any test runs (`backupConsentFile`).
2. Resets to an empty store before each consent test (`resetConsentFile`).
3. Restores the original content after all consent tests complete (`restoreConsentFile`).

This means the tests are non-destructive to any existing consent data on a developer's machine.

### Structural Tests vs Integration Tests

The "route registration" and "source file" tests scan the raw source text for key symbol names.
This is intentional: it gives fast, dependency-free feedback that the wiring is in place without
spinning up the Express server. Full HTTP-level integration tests (which require a running server
and configured `contents/`) are a separate concern covered by `tests/oauth-flow-test.js`.

---

## Adding New Tests

To extend the suite, add a new `await test('description', async () => { ... })` call inside
the relevant section, or create a new `section('Name')` block. The harness automatically
collects results.

The test must throw (or call `assert.*`) to register as a failure. Uncaught promise rejections
are caught by the `test()` wrapper and counted as failures.

---

## Related Files

| File | Purpose |
|------|---------|
| `server/utils/pkceUtils.js` | PKCE code verifier/challenge generation and verification |
| `server/utils/authorizationCodeStore.js` | In-memory single-use code store with TTL |
| `server/utils/consentStore.js` | File-backed consent persistence |
| `server/routes/wellKnown.js` | OIDC Discovery and JWKS endpoints |
| `server/routes/oauth.js` | Token, revoke, and userinfo endpoints |
| `server/routes/oauthAuthorize.js` | Authorization endpoint with consent screen |
| `server/middleware/jwtAuth.js` | JWT validation middleware (RS256 fix) |
| `server/server.js` | Express app entry point – route registration |
