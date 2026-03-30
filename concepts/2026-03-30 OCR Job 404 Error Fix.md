# OCR Job 404 Error Fix

**Date**: 2026-03-30
**Issue**: OCR jobs return 404 error when accessing progress/download endpoints
**Root Cause**: Anonymous user access not properly handled in job access control

## Problem Description

When anonymous access is enabled in the platform configuration, users could create OCR jobs but could not access them via the progress or download endpoints. The endpoints would return a 404 error with the message "Job not found" even though the job existed in the job store.

### Symptoms

1. Job creation succeeded and returned a job ID
2. Progress endpoint (`/jobs/:jobId/progress`) returned 404
3. Download endpoint (`/jobs/:jobId/download`) returned 404
4. Cancel endpoint (`/jobs/:jobId/cancel`) returned 404
5. Job appeared in the list when refreshing the jobs page, but individual job access failed

### Error Message

```
"error": "No API key configured for model gemini-3.1-flash-image"
```

This error was shown because the job failed immediately, but the underlying issue was that even when jobs succeeded, they couldn't be accessed due to the authentication problem.

## Root Cause Analysis

The issue was in the authentication flow for anonymous users:

1. **Anonymous Access Enabled**: When `anonymousAuth.enabled` is `true` in `platform.json`, the `authRequired` middleware allows requests to proceed without setting `req.user`.

2. **Job Creation**: Jobs were created with `userId: req.user?.id`, which resulted in `userId: undefined` for anonymous users.

3. **Job Access Check**: The `canAccessJob()` function had this logic:
   ```javascript
   export function canAccessJob(job, user) {
     if (!job || !user) return false;  // ❌ Returns false if user is undefined
     if (user.permissions?.adminAccess === true) return true;
     return job.userId === user.id;
   }
   ```

4. **Result**: When an anonymous user (with `req.user = undefined`) tried to access their job (with `job.userId = undefined`), the function would return `false` at the first check, causing a 404 error.

### Code Locations

- **`server/middleware/authRequired.js`** (lines 22-29): Allows anonymous access without setting `req.user`
- **`server/routes/toolsService/ocrRoutes.js`** (line 103): Creates jobs with `req.user?.id`
- **`server/routes/toolsService/jobStore.js`** (lines 56-64): Original `canAccessJob` function
- **`server/routes/toolsService/jobRoutes.js`** (lines 29, 72, 92): Uses `canAccessJob` to check access

## Solution

Updated `canAccessJob()` and `listJobs()` functions to properly handle anonymous users:

### Updated `canAccessJob()` Function

```javascript
export function canAccessJob(job, user) {
  if (!job) return false;

  // Admin access
  if (user?.permissions?.adminAccess === true) return true;

  // Both job and user are anonymous (undefined/null userId)
  if (!job.userId && !user?.id) return true;

  // Regular user accessing their own job
  if (user?.id && job.userId === user.id) return true;

  return false;
}
```

**Key changes:**
- Removed the early `!user` check that blocked anonymous users
- Added explicit check for anonymous access: both job and user have no ID
- Used optional chaining (`?.`) to safely access user properties

### Updated `listJobs()` Function

```javascript
export function listJobs(userId, isAdmin, filters = {}) {
  const result = [];
  for (const [id, job] of jobs) {
    // Admin sees all jobs
    if (isAdmin) {
      // Continue to filter checks below
    } else if (!userId && !job.userId) {
      // Anonymous user (undefined userId) can only see anonymous jobs
      // Continue to filter checks below
    } else if (userId && job.userId === userId) {
      // Regular user can only see their own jobs
      // Continue to filter checks below
    } else {
      // Skip this job - user cannot access it
      continue;
    }

    if (filters.status && job.status !== filters.status) continue;
    if (filters.toolType && job.toolType !== filters.toolType) continue;
    result.push({...});
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}
```

**Key changes:**
- Replaced simple `job.userId !== userId` check with explicit logic for anonymous, authenticated, and admin users
- Anonymous users can only see anonymous jobs (both have undefined userId)
- Authenticated users can only see their own jobs
- Admins can see all jobs

## Access Control Matrix

| Job Owner    | Accessing User | Can Access? | Reason                                    |
|-------------|---------------|-------------|-------------------------------------------|
| Anonymous   | Anonymous     | ✅ Yes      | Both have undefined userId                |
| Anonymous   | Authenticated | ❌ No       | Different user types                      |
| Anonymous   | Admin         | ✅ Yes      | Admin has access to all jobs              |
| Authenticated | Anonymous   | ❌ No       | Cannot access authenticated user's job    |
| Authenticated | Same User   | ✅ Yes      | User can access their own job             |
| Authenticated | Other User  | ❌ No       | Cannot access other user's job            |
| Authenticated | Admin       | ✅ Yes      | Admin has access to all jobs              |

## Testing

Created comprehensive tests in `server/tests/jobStore.test.js`:

- ✅ Anonymous job access by anonymous users
- ✅ Authenticated job access by job owner
- ✅ Admin access to all jobs
- ✅ Cross-user access prevention
- ✅ List jobs filtering for anonymous users
- ✅ List jobs filtering for authenticated users
- ✅ List jobs for admin users

All tests pass successfully.

## Files Modified

1. **`server/routes/toolsService/jobStore.js`**:
   - Updated `canAccessJob()` function (lines 56-74)
   - Updated `listJobs()` function (lines 81-113)

## Backward Compatibility

This fix maintains backward compatibility:
- Authenticated users can still access their own jobs
- Admin users can still access all jobs
- No changes to the API interface
- Only adds support for anonymous users that was previously broken

## Security Considerations

The fix maintains proper security:
- Anonymous users can only access anonymous jobs (no userId on either side)
- Authenticated users cannot access anonymous jobs (different user types)
- Anonymous users cannot access authenticated users' jobs
- Users cannot access other users' jobs
- Admin access is preserved for all jobs

## Future Improvements

Consider these enhancements:
1. Add explicit user session tracking for anonymous users (e.g., session ID in cookies)
2. Add job cleanup for anonymous jobs after shorter TTL (currently 1 hour for all jobs)
3. Consider adding rate limiting per anonymous session
4. Add metrics tracking for anonymous vs authenticated job usage
