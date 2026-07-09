# Auth Method Ordering Fix

**Date:** 2026-03-12  
**Issue:** Username/Password shown below OIDC when Local Mode is the primary auth method

## Problem

When both Local Users (username/password) and OIDC were configured, the login form
always displayed OIDC providers above the username/password form, regardless of which
auth mode was set as primary.

**Expected behaviour:** When `auth.mode` is `local` (or `ldap`), the username/password
form should appear first, above any external providers (OIDC, NTLM).

## Root Cause

The render order of authentication sections in both `LoginForm.jsx` and `auth-gate.js`
was hardcoded:

1. OIDC providers
2. NTLM
3. Username/password form

No consideration was given to `authMode` (the primary configured authentication mode)
when determining the display order.

## Fix

Both the React login form and the vanilla-JS pre-auth gate were updated to respect the
`authMode` value returned by `/api/auth/status`:

- When `authMode === 'local'` **or** `authMode === 'ldap'`: username/password appears
  first, followed by NTLM, then OIDC.
- For all other modes (default): OIDC appears first, then NTLM, then username/password
  (preserving the existing behaviour).

### Files Changed

| File | Change |
|------|--------|
| `client/src/features/auth/components/LoginForm.jsx` | Added `isLocalPrimary` flag; extracted reusable section variables (`usernamePasswordSection`, `oidcSection`, `ntlmSection`, `orSeparator`); render sections in order based on flag |
| `client/src/auth-gate/auth-gate.js` | Added `isLocalPrimary` flag; extracted `appendOidcSection()` and `appendNtlmSection()` helpers; append sections in appropriate order based on flag |

## Behaviour Matrix

| `authMode` | Display Order |
|------------|--------------|
| `local` | Username/Password → NTLM → OIDC |
| `ldap` | Username/Password → NTLM → OIDC |
| `oidc` | OIDC → NTLM → Username/Password |
| `proxy` | OIDC → NTLM → Username/Password |
| `anonymous` | OIDC → NTLM → Username/Password |
| `ntlm` | OIDC → NTLM → Username/Password |
