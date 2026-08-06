# SSL Certificate Domain Whitelist Feature

**Date**: 2026-02-05  
**Status**: Implemented  
**Type**: Security Enhancement

## Problem Statement

The current SSL certificate validation in iHub Apps has a security issue: the `ignoreInvalidCertificates` setting is a global ON/OFF switch. When enabled, it ignores SSL certificate validation for **ALL** external connections, not just the ones that need it. This creates an unnecessary security risk, making the application vulnerable to man-in-the-middle attacks even for connections to services with valid certificates.

### Issue Reference

GitHub Issue: "Ignore invalid SSL certificates is a global ON/OFF"

## Solution

Implement a domain whitelist feature that allows administrators to:
1. Enable/disable SSL certificate validation globally (maintaining backward compatibility)
2. Specify a list of domains for which SSL validation should be bypassed
3. Validate SSL certificates normally for all other domains

## Implementation

### Backend Changes

#### 1. Platform Configuration Schema (`platformConfigSchema.js`)

Added new SSL configuration structure:

```javascript
ssl: z
  .object({
    ignoreInvalidCertificates: z.boolean().default(false),
    domainWhitelist: z
      .array(z.string())
      .default([])
      .describe('List of domains/patterns for which SSL validation should be ignored')
  })
  .default({})
```

#### 2. HTTP Configuration (`httpConfig.js`)

Implemented domain-based SSL validation with three new functions:

**`isDomainWhitelisted(hostname, whitelist)`**
- Checks if a hostname matches any pattern in the whitelist
- Supports three pattern types:
  - Exact match: `api.example.com`
  - Wildcard: `*.example.com` (matches all subdomains)
  - Subdomain: `.example.com` (matches subdomains but not root)

**`shouldIgnoreSSLForURL(url, sslConfig)`**
- Determines if SSL validation should be bypassed for a specific URL
- Returns `true` only if:
  - `ignoreInvalidCertificates` is enabled AND
  - Domain is in whitelist (empty whitelist = secure default, no SSL bypass)

**`createAgent(url, forceIgnoreSSL)`**
- Updated to use `shouldIgnoreSSLForURL()` for per-request SSL decisions
- No global `NODE_TLS_REJECT_UNAUTHORIZED=0` setting
- Maintains backward compatibility with `forceIgnoreSSL` parameter

#### 3. Logging Improvements

Enhanced SSL configuration logging to show:
- Current `ignoreInvalidCertificates` setting
- Domain whitelist contents
- Whether validation is global or domain-specific

### Frontend Changes

#### 1. SSL Configuration Component (`SSLConfig.jsx`)

Created a comprehensive admin UI component with:
- **Toggle for `ignoreInvalidCertificates`**: Easy enable/disable switch
- **Domain Whitelist Management**: Add/remove domains via text input
- **Security Warnings**: Alerts when SSL validation is disabled
- **Pattern Help**: Guidance on supported domain patterns
- **Real-time Validation**: Shows which domains are whitelisted

#### 2. Integration (`AdminSystemPage.jsx`)

Added SSLConfig component to the admin system page, positioned after the Logging Configuration section.

#### 3. Internationalization

Added translations for English and German:
- Component titles and descriptions
- Button labels
- Security warnings
- Domain pattern help text

### Configuration Files

Updated default and example `platform.json` files to include the new structure:

```json
{
  "ssl": {
    "ignoreInvalidCertificates": false,
    "domainWhitelist": []
  }
}
```

## Security Improvements

### Before

- Global SSL bypass: ALL external connections ignore certificate validation
- Attack surface: Entire application vulnerable to MITM attacks
- No granular control

### After

- Per-domain SSL bypass: Only whitelisted domains ignore validation
- Reduced attack surface: Only explicitly whitelisted domains at risk
- Granular control: Administrators specify exactly which domains to trust

## Backward Compatibility

**Important Security Change**: The default behavior has been updated for improved security:

1. **Empty Whitelist**: When `domainWhitelist` is empty and `ignoreInvalidCertificates` is true, SSL validation is **enabled for all domains** (secure default). Domains must be explicitly whitelisted to bypass SSL validation.
2. **Missing Configuration**: If `ssl` section is missing, defaults to secure settings (validation enabled, empty whitelist)
3. **Existing Code**: No changes required to existing adapter or tool code

**Migration Note**: If your existing configuration has `ignoreInvalidCertificates: true` with an empty whitelist, you must now add specific domains to the whitelist to bypass SSL validation for those domains.

## Usage Examples

### Example 1: Trust Specific Internal APIs

```json
{
  "ssl": {
    "ignoreInvalidCertificates": true,
    "domainWhitelist": [
      "api.internal.company.com",
      "llm.internal.company.com"
    ]
  }
}
```

Result: SSL validation bypassed only for the two specified internal APIs. All other external connections validate certificates normally.

### Example 2: Trust All Subdomains

```json
{
  "ssl": {
    "ignoreInvalidCertificates": true,
    "domainWhitelist": [
      "*.internal.company.com"
    ]
  }
}
```

Result: SSL validation bypassed for all subdomains of `internal.company.com` (e.g., `api.internal.company.com`, `auth.internal.company.com`).

### Example 3: Legacy Behavior (Not Recommended)

```json
{
  "ssl": {
    "ignoreInvalidCertificates": true,
    "domainWhitelist": []
  }
}
```

Result: SSL validation is **enabled** for ALL domains (secure default). No domains will bypass SSL validation unless explicitly added to the whitelist.

## Code Locations

- **Schema**: `server/validators/platformConfigSchema.js` (lines 157-167)
- **Backend Logic**: `server/utils/httpConfig.js` (lines 12-127, 217-286)
- **Frontend Component**: `client/src/features/admin/components/SSLConfig.jsx`
- **Integration**: `client/src/features/admin/pages/AdminSystemPage.jsx` (lines 7, 927-929)
- **Translations**: 
  - `shared/i18n/en.json` (lines 613-635)
  - `shared/i18n/de.json` (lines 755-777)

## Testing

### Manual Testing Required

1. **Default Behavior**: Verify SSL validation works normally with default configuration
2. **Global Bypass**: Test with `ignoreInvalidCertificates: true` and empty whitelist
3. **Domain Whitelist**: Test with specific domains in whitelist
4. **Pattern Matching**: Verify wildcard and subdomain patterns work correctly
5. **Admin UI**: Test adding/removing domains in admin interface

### Test Scenarios

| Scenario | Config | Expected Behavior |
|----------|--------|-------------------|
| Default | `ignoreInvalidCertificates: false` | All SSL certs validated |
| Secure Default | `ignoreInvalidCertificates: true`, empty whitelist | All SSL certs validated (secure default) |
| Specific Domain | `ignoreInvalidCertificates: true`, `["api.example.com"]` | Only api.example.com bypassed |
| Wildcard | `ignoreInvalidCertificates: true`, `["*.example.com"]` | All example.com subdomains bypassed |

## Future Improvements

1. **Certificate Pinning**: Add support for certificate pinning for specific domains
2. **Temporary Bypass**: Allow time-limited SSL bypass for specific domains
3. **Audit Logging**: Log all instances where SSL validation is bypassed
4. **UI Enhancements**: Add domain validation in the admin UI
5. **Certificate Details**: Show certificate information in admin UI for debugging

## Related Documentation

- `docs/ssl-certificates.md` - Updated with domain whitelist information
- `server/defaults/config/platform.json` - Default configuration example
- `examples/config/platform.json` - Extended configuration example

## Migration Guide

**IMPORTANT**: For existing deployments using `ignoreInvalidCertificates: true`:

1. **Action Required**: With the new secure default, an empty whitelist will NOT bypass SSL validation. You must add specific domains to the whitelist:
   ```json
   {
     "ssl": {
       "ignoreInvalidCertificates": true,
       "domainWhitelist": [
         "your-internal-api.company.com"
       ]
     }
   }
   ```
3. **Best Practice**: Only include domains that genuinely need SSL bypass

## Summary

This feature significantly improves the security posture of iHub Apps by replacing the all-or-nothing SSL validation bypass with a granular, domain-specific approach. Administrators can now precisely control which external services are trusted despite having invalid SSL certificates, while maintaining strict validation for all other connections.
