# Admin Endpoints Security Audit Script

## Overview

This script performs a comprehensive security audit of all admin endpoints (`/admin/*`) in the iHub Apps platform to ensure they are properly protected with the `adminAuth` middleware.

## Usage

### Quick Run

```bash
npm run security:audit
```

or

```bash
node scripts/audit-admin-endpoints.js
```

### Expected Output

```
🔍 Starting Admin Endpoints Security Audit

================================================================================
✓ [EXCEPTION] GET /api/admin/auth/status
  File: auth.js:160
  Reason: Intentionally public (auth status check)

================================================================================

📊 Security Audit Summary

Total Admin Endpoints: 106
✅ Protected Endpoints: 105
⚠️  Intentional Exceptions: 1
❌ Unprotected Endpoints: 0

✅ All admin endpoints are properly protected!
   105 endpoints with adminAuth middleware
   1 documented exceptions

🔒 Security Audit: PASSED
```

## What It Checks

The script verifies that:

1. **All admin endpoints use `adminAuth` middleware**
   - Scans all files in `server/routes/admin/`
   - Extracts route definitions using regex patterns
   - Checks for `adminAuth` in route middleware chain

2. **Documented exceptions are properly justified**
   - Maintains a whitelist of intentional exceptions
   - Reports on why exceptions are allowed

3. **No unauthorized admin access is possible**
   - Identifies any endpoints missing protection
   - Reports vulnerabilities with file and line numbers

## Exit Codes

- **0**: All admin endpoints are properly protected ✅
- **1**: Vulnerabilities found - unprotected admin endpoints detected 🚨

## Intentional Exceptions

### `/api/admin/auth/status` (GET)

**Purpose:** Allows the admin UI to check authentication requirements before prompting for credentials.

**Security:** This endpoint only returns whether authentication is required. It does not expose sensitive data or allow any admin operations.

## Adding New Admin Endpoints

When adding new admin endpoints:

1. **Always use `adminAuth` middleware**:
   ```javascript
   import { adminAuth } from '../../middleware/adminAuth.js';
   
   app.get(buildServerPath('/api/admin/my-endpoint', basePath), adminAuth, async (req, res) => {
     // Your handler code
   });
   ```

2. **Run the audit script**:
   ```bash
   npm run security:audit
   ```

3. **If intentionally creating a public endpoint**:
   - Add it to `INTENTIONAL_EXCEPTIONS` in `scripts/audit-admin-endpoints.js`
   - Document the reason in code comments
   - Update this README with justification

## Integration with CI/CD

This script can be integrated into CI/CD pipelines:

```yaml
# .github/workflows/security-audit.yml
name: Security Audit

on: [push, pull_request]

jobs:
  audit-admin-endpoints:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm run security:audit
```

## Maintenance

- **Run after every PR**: Ensure no new vulnerabilities are introduced
- **Run before releases**: Verify security posture before deployment
- **Update exceptions**: Keep `INTENTIONAL_EXCEPTIONS` list current

## Related Documentation

- [Admin Endpoints Security Audit Report](../concepts/2026-02-03%20Admin%20Endpoints%20Security%20Audit.md)
- [Admin Authentication Middleware](../server/middleware/adminAuth.js)
- [Security Tests](../server/tests/admin-endpoints-security.test.js)

## Troubleshooting

### False Positives

If the script reports a false positive (endpoint IS protected but reported as unprotected):

1. Check that `adminAuth` appears within 10 lines of the route definition
2. Ensure proper formatting of middleware chain
3. Update the regex patterns in the script if needed

### False Negatives

If an endpoint should be flagged but isn't:

1. Verify the route uses `buildServerPath()` or template literals
2. Check that the file is in `server/routes/admin/`
3. Update the script's route extraction patterns

## Contributing

When modifying this script:

1. Test with both protected and unprotected routes
2. Verify exit codes work correctly
3. Update this README with changes
4. Run `npm run lint:fix` before committing
