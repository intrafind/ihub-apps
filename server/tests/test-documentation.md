# Authentication Security Test Suite

This test suite validates the critical authentication and authorization security fixes implemented to prevent authentication bypass vulnerabilities.

## Test Categories

### 1. Authentication Security Tests (`authentication-security.test.js`)

**Anonymous Access Disabled - Complete Lockdown**

- ✅ Blocks unauthenticated access to `/api/apps`
- ✅ Blocks unauthenticated access to `/api/models`
- ✅ Blocks unauthenticated access to chat endpoints
- ✅ Blocks unauthenticated access to model test endpoints
- ✅ Blocks unauthenticated access to tools, prompts, feedback
- ✅ Allows access to public endpoints (auth status, platform config)

**Anonymous Access Enabled - Limited Access**

- ✅ Allows anonymous access but filters by permissions
- ✅ Shows only permitted apps/models for anonymous users
- ✅ Blocks access to restricted apps
- ✅ Allows chat with permitted apps only

**Authenticated User Access - Group-Based Permissions**

- ✅ Users see apps based on their group memberships
- ✅ Finance group gets access to finance-specific apps
- ✅ Users blocked from apps outside their groups
- ✅ Chat access respects group permissions

**Admin Endpoint Protection**

- ✅ Regular users blocked from admin endpoints
- ✅ Anonymous users blocked from admin endpoints
- ✅ Admin users can access admin endpoints

**JWT Token Validation**

- ✅ Rejects invalid JWT tokens
- ✅ Rejects expired JWT tokens
- ✅ Accepts valid JWT tokens
- ✅ Handles malformed authorization headers

**Authentication Bypass Prevention**

- ✅ Prevents header manipulation attacks
- ✅ Prevents query parameter bypasses
- ✅ Prevents request body manipulation
- ✅ Prevents privilege escalation via token manipulation

## Running Tests

### Install Dependencies

```bash
npm install
```

### Run All Authentication Tests

```bash
npm run test:auth
```

### Run All Tests

```bash
npm test
```

### Run Tests with Coverage

```bash
npm run test:coverage
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

## Test Scenarios Covered

### Critical Security Scenarios

1. **Complete Authentication Bypass Prevention**
   - When `allowAnonymous: false`, NO API endpoints accessible without auth
   - Validates the critical vulnerability fix

2. **Permission-Based Access Control**
   - Users only see resources their groups allow
   - Anonymous users get minimal access when enabled

3. **Admin Privilege Separation**
   - Regular users cannot access admin endpoints
   - Admin access properly validated

4. **Multi-Group Access Rights**
   - Users with multiple groups get combined permissions
   - Group hierarchy respected

5. **Token Security**
   - JWT tokens properly validated
   - Tampered/expired tokens rejected
   - Proper secret validation

6. **Attack Vector Prevention**
   - Header manipulation attacks blocked
   - Query/body parameter bypasses prevented
   - SQL injection attempts handled
   - XSS attempts sanitized

## Expected Test Results

All tests should **PASS** - any failures indicate potential security vulnerabilities.

### Key Assertions

- `allowAnonymous: false` → **401 errors** for all API endpoints without auth
- `allowAnonymous: true` → **403 errors** for unauthorized resources
- Invalid tokens → **401 errors**
- Admin endpoints → **403 errors** for non-admin users
- Group permissions → **Filtered results** based on user groups

## Security Coverage

These tests ensure:

1. **No Authentication Bypass** - The critical vulnerability is fixed
2. **Proper Authorization** - Users only access permitted resources
3. **Admin Protection** - Admin endpoints properly secured
4. **Token Security** - JWT handling is secure
5. **Attack Prevention** - Common attack vectors blocked

## Continuous Security Testing

Run these tests:

- ✅ Before every deployment
- ✅ After any authentication/authorization changes
- ✅ As part of CI/CD pipeline
- ✅ During security audits

## Test Maintenance

When adding new API endpoints:

1. Add authentication middleware (`authRequired`, `chatAuthRequired`, etc.)
2. Add test cases to validate protection
3. Test both anonymous-disabled and anonymous-enabled scenarios
4. Verify group-based permissions work correctly

## Security Test Checklist

- [ ] All chat endpoints protected ✅
- [ ] All API endpoints protected ✅
- [ ] Admin endpoints restricted ✅
- [ ] Group permissions enforced ✅
- [ ] Token validation secure ✅
- [ ] Attack vectors blocked ✅
- [ ] Error handling secure ✅
- [ ] No information disclosure ✅
