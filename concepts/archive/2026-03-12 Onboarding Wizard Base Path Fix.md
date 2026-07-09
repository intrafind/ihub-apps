# Onboarding Wizard Does Not Recognize Base Path

**Date:** 2026-03-12  
**Issue:** Onboarding wizard restarts after login in nginx/subpath deployments

## Problem Description

When iHub is deployed behind an nginx reverse proxy with a subpath (e.g., `/ihub/`), the
first-run onboarding wizard would incorrectly restart from the beginning after the user
logged in at step 2 (the embedded login form).

**Symptom:** User sees a full-page refresh and the wizard reappears, forcing them to log in
again even though authentication already succeeded.

## Root Cause

There is a **race condition** between two asynchronous operations that fire in parallel on
initial page load:

1. **`AuthContext.loadAuthStatus()`** – fetches `/api/auth/status`.  When the user is *not*
   authenticated it stores `authReturnUrl = window.location.href` in `sessionStorage`.  At
   the time this resolves, the URL may still be the root (`https://myserver.com/ihub/`)
   because `SetupCheck` has not yet navigated.

2. **`PlatformConfigContext`** – also fetches `/api/auth/status` (and other endpoints) via a
   `Promise.all`.  When it resolves with `setup.configured === false`, `SetupCheck` calls
   `navigate('/setup', { replace: true })`, changing the URL to
   `https://myserver.com/ihub/setup`.

If **`AuthContext.loadAuthStatus()`** finishes *before* `PlatformConfigContext`, the stored
`authReturnUrl` is the **root URL** (`/ihub/`), not the setup URL (`/ihub/setup`).

Later, when the user submits the embedded login form, `loginLocal()` / `loginLdap()` in
`AuthContext` compares the paths:

```
currentPath  = /ihub/setup   ← where the wizard is
returnPath   = /ihub/        ← where authReturnUrl points
```

They differ → a full-page redirect to `/ihub/` is triggered → the wizard remounts but
`loginJustCompleted` state is gone → the wizard is stuck at the login step again.

**Why does this not happen in "normal" installations?**  Without a reverse-proxy, both
network requests resolve quickly (often within the same event-loop tick) and the relative
order is non-deterministic.  In many cases the platform config resolves first, `SetupCheck`
navigates to `/setup`, and *then* `loadAuthStatus` stores `authReturnUrl = /setup` – which
matches `currentPath` and no redirect occurs.  The nginx proxy adds extra latency, making
the problematic ordering reliably reproducible.

## Fix

Two changes to `client/src/features/setup/SetupWizard.jsx`:

### 1. Update `authReturnUrl` on wizard mount (primary fix)

When `SetupWizard` mounts, its URL is already the correct setup URL (`/ihub/setup`).
Overwriting `authReturnUrl` here guarantees the path comparison in `loginLocal` /
`loginLdap` will find identical values and **skip the redirect**:

```javascript
useEffect(() => {
  sessionStorage.setItem('authReturnUrl', window.location.href);
}, []);
```

This is safe with OIDC: `loginWithOidc()` overwrites `authReturnUrl` with the current URL
*after* the user clicks the OIDC button, so the OIDC redirect-back flow is unaffected.

### 2. Auto-advance from login step when already authenticated (defensive fix)

As a safety net for any residual case where the page does reload and the wizard restores at
step 2, an additional effect detects that the user is already an authenticated admin and
advances directly to step 3 (provider configuration):

```javascript
useEffect(() => {
  if (step === 2 && !authLoading && isAuthenticated && userIsAdmin) {
    setLoginError(null);
    setStep(3);
  }
}, [step, authLoading, isAuthenticated, userIsAdmin]);
```

## Files Changed

- `client/src/features/setup/SetupWizard.jsx` – two new `useEffect` hooks added
