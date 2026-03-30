# 2026-03-30 Onboarding Admin Login Fix

## Problem

When performing a fresh iHub Apps installation, the onboarding wizard fails at the API key configuration step. The user successfully logs in as admin (groups: `["admins", "authenticated"]`, `isAdmin: true`), but the subsequent `POST /api/setup/configure` request returns:

```json
{
  "error": "Access denied",
  "message": "Admin access requires authentication with admin privileges."
}
```

## Root Cause

Two issues contribute to this failure:

### 1. Client: Missing Authorization Header in Setup API Calls

The `SetupWizard.jsx` component uses raw `fetch()` calls for the `/api/setup/test` and `/api/setup/configure` endpoints. While these calls include `credentials: 'include'` (which sends HTTP-only cookies), they do **not** include the `Authorization: Bearer <token>` header.

The rest of the application uses an Axios client (`client/src/api/client.js`) that automatically adds this header from `localStorage.getItem('authToken')` via a request interceptor. The setup wizard bypasses this mechanism.

In environments where the HTTP-only cookie is not forwarded reliably (e.g., certain reverse proxy configurations, cross-port development setups, or SameSite cookie restrictions), the server receives no authentication credentials at all.

### 2. Server: `adminAuth` Middleware Ignores `req.user.isAdmin`

The `adminAuth` middleware (`server/middleware/adminAuth.js`) calls `isAdminAuthRequired(req)`, which re-reads `groups.json` from disk to check admin access. It does **not** consult the `req.user.isAdmin` flag that the global `enhanceUserWithPermissions()` middleware has already set.

This means:
- The admin check is performed twice (redundantly)
- If the file read fails or returns unexpected data, the admin check fails even though the user was already identified as admin

Additionally, the middleware returned HTTP 403 for both unauthenticated and unauthorized requests, making debugging harder.

## Fix

### Client Fix (`client/src/features/setup/SetupWizard.jsx`)

Added a `buildAuthHeaders()` helper that includes both `Content-Type` and the `Authorization: Bearer <token>` header (read from `localStorage`). This mirrors the pattern used by the Axios client and ensures the JWT is transmitted even if the HTTP-only cookie is not forwarded.

### Server Fix (`server/middleware/adminAuth.js`)

1. **Fast path for `req.user.isAdmin`**: The `isAdminAuthRequired()` function now checks `req.user.isAdmin === true` first, before falling back to the groups config file. This trusts the permission enhancement already performed by the global middleware chain.

2. **Proper HTTP status codes**: The `adminAuth()` function now returns:
   - **401** for unauthenticated requests (no user or anonymous)
   - **403** for authenticated users without admin privileges

## Files Changed

| File | Change |
|------|--------|
| `client/src/features/setup/SetupWizard.jsx` | Added `buildAuthHeaders()` helper; setup API calls now include `Authorization` header |
| `server/middleware/adminAuth.js` | Added `req.user.isAdmin` fast path; proper 401/403 status codes; removed unused `configCache` import |
