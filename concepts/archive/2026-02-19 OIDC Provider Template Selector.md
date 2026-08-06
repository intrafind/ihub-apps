# OIDC Provider Template Selector

**Date**: 2026-02-19  
**Type**: Feature Enhancement  
**Status**: Implemented  

## Overview

This feature enhances the OIDC provider configuration by adding a template selector modal that allows administrators to choose from predefined provider configurations or create custom providers.

## Problem

Previously, when adding an OIDC provider, administrators had to:
- Know all provider-specific URLs (authorization, token, userinfo)
- Manually enter all configuration fields
- Risk typos in URLs
- Remember scopes and settings for each provider

This created a high barrier to entry and was error-prone.

## Solution

### User Flow Diagram

```
┌─────────────────────────────────────────────────────┐
│  Admin Page > Authentication > OIDC Settings        │
└─────────────────────────────────────────────────────┘
                      │
                      │ Click "Add OIDC Provider"
                      ▼
┌─────────────────────────────────────────────────────┐
│              Select OIDC Provider                    │
│  ┌───────────────────────────────────────────────┐  │
│  │  Choose a preconfigured provider template    │  │
│  │  or create a custom configuration            │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────────────┐  ┌──────────────────┐        │
│  │    🔶 Auth0      │  │    🔴 Google     │        │
│  │  Enterprise ID   │  │  Google Accounts │        │
│  └──────────────────┘  └──────────────────┘        │
│                                                      │
│  ┌──────────────────┐  ┌──────────────────┐        │
│  │  🔵 Microsoft    │  │  🟢 Keycloak     │        │
│  │  Azure AD/M365   │  │  Open Source     │        │
│  └──────────────────┘  └──────────────────┘        │
│                                                      │
│  ┌──────────────────────────────────────────┐      │
│  │         ⚙️  Custom Provider               │      │
│  │  Configure your own OIDC settings        │      │
│  └──────────────────────────────────────────┘      │
│                                                      │
│              [Cancel]                                │
└─────────────────────────────────────────────────────┘
                      │
                      │ Select provider (e.g., Google)
                      ▼
┌─────────────────────────────────────────────────────┐
│  Provider Configuration Form                         │
│  ┌─────────────────────────────────────────────┐   │
│  │ ✓ Name: google              (pre-filled)   │   │
│  │ ✓ Display: Google           (pre-filled)   │   │
│  │ ✓ Auth URL: https://...     (pre-filled)   │   │
│  │ ✓ Token URL: https://...    (pre-filled)   │   │
│  │ ✓ UserInfo URL: https://... (pre-filled)   │   │
│  │ ✓ Scope: openid, profile... (pre-filled)   │   │
│  │ ✓ Groups Attr: groups       (pre-filled)   │   │
│  │ ✓ PKCE: enabled            (pre-filled)   │   │
│  │                                              │   │
│  │ ⚠️  Client ID: [ENTER HERE]                 │   │
│  │ ⚠️  Client Secret: [ENTER HERE]             │   │
│  └─────────────────────────────────────────────┘   │
│                                                      │
│              [Save Configuration]                    │
└─────────────────────────────────────────────────────┘
```

### Configuration Reduction

**Before**: 10 fields to configure
```
❌ Name
❌ Display Name
❌ Client ID
❌ Client Secret
❌ Authorization URL
❌ Token URL
❌ User Info URL
❌ Scope
❌ Groups Attribute
❌ PKCE setting
```

**After**: 2 fields to configure (80% reduction)
```
✓ Name (pre-filled)
✓ Display Name (pre-filled)
❌ Client ID (only this needs input)
❌ Client Secret (only this needs input)
✓ Authorization URL (pre-filled)
✓ Token URL (pre-filled)
✓ User Info URL (pre-filled)
✓ Scope (pre-filled)
✓ Groups Attribute (pre-filled)
✓ PKCE setting (pre-filled)
```

## Implementation Details

### File Structure

```
client/src/features/admin/components/
  └── PlatformFormEditor.jsx          (Modified)
shared/i18n/
  ├── en.json                          (Modified)
  └── de.json                          (Modified)
OIDC_PROVIDER_SELECTOR_FEATURE.md     (New)
concepts/
  └── 2026-02-19 OIDC Provider Template Selector.md  (New)
```

### Provider Templates

Each template includes:
- Provider name and display name
- Pre-configured OAuth/OIDC URLs
- Appropriate scopes
- Security settings (PKCE)
- Groups attribute mapping

#### Supported Providers

1. **Auth0**
   - Enterprise identity platform
   - URLs use `${AUTH0_DOMAIN}` placeholder
   - Standard scopes: openid, profile, email

2. **Google**
   - Consumer Google accounts
   - Fixed URLs for Google OAuth
   - Standard scopes: openid, profile, email

3. **Microsoft**
   - Azure AD / Microsoft 365
   - Common tenant endpoints
   - Includes User.Read scope for Graph API

4. **Keycloak**
   - Open-source identity management
   - URLs use `${KEYCLOAK_SERVER}` and `${KEYCLOAK_REALM}` placeholders
   - Standard OpenID Connect scopes

5. **Custom**
   - Empty template
   - For non-standard providers
   - All fields must be configured manually

### Code Architecture

```javascript
// Template Definition
const OIDC_PROVIDER_TEMPLATES = {
  google: {
    name: 'google',
    displayName: 'Google',
    authorizationURL: 'https://accounts.google.com/...',
    tokenURL: 'https://www.googleapis.com/...',
    userInfoURL: 'https://www.googleapis.com/...',
    scope: ['openid', 'profile', 'email'],
    groupsAttribute: 'groups',
    pkce: true
  },
  // ... other templates
};

// Function Signature
addOidcProvider(templateType = 'custom') {
  const template = OIDC_PROVIDER_TEMPLATES[templateType];
  // Create provider with pre-filled values
}
```

### UI Components

#### Modal Structure
```jsx
<Modal>
  <Header>
    <Title>Select OIDC Provider</Title>
    <CloseButton />
  </Header>
  <Body>
    <Description />
    <ProviderGrid>
      <ProviderCard onClick={() => select('auth0')} />
      <ProviderCard onClick={() => select('google')} />
      <ProviderCard onClick={() => select('microsoft')} />
      <ProviderCard onClick={() => select('keycloak')} />
      <ProviderCard onClick={() => select('custom')} />
    </ProviderGrid>
  </Body>
  <Footer>
    <CancelButton />
  </Footer>
</Modal>
```

#### Provider Card
```jsx
<ProviderCard>
  <Icon color={providerColor} />
  <Title>{providerName}</Title>
  <Description>{providerDescription}</Description>
</ProviderCard>
```

### Internationalization

All UI text is fully internationalized:

**English Keys**:
- `admin.auth.addOidcProvider`: "Add OIDC Provider"
- `admin.auth.selectOidcProvider`: "Select OIDC Provider"
- `admin.auth.auth0Description`: "Enterprise identity platform"
- etc.

**German Keys**:
- `admin.auth.addOidcProvider`: "OIDC-Anbieter hinzufügen"
- `admin.auth.selectOidcProvider`: "OIDC-Anbieter auswählen"
- `admin.auth.auth0Description`: "Unternehmens-Identitätsplattform"
- etc.

## Benefits

### For Administrators
- **Faster Configuration**: 80% fewer fields to fill
- **Error Prevention**: Pre-filled URLs eliminate typos
- **Better UX**: Visual selection vs. blank forms
- **Guided Setup**: Descriptions help choose right provider
- **Consistency**: Same setup process across deployments

### For Developers
- **Maintainability**: Templates in one place
- **Extensibility**: Easy to add new providers
- **Type Safety**: Structured template format
- **Testing**: Easier to test with known configurations

### For Organizations
- **Reduced Support**: Less confusion during setup
- **Faster Onboarding**: New admins can configure quickly
- **Standardization**: Consistent configurations
- **Documentation**: Self-documenting through UI

## Testing

### Test Scenarios

1. **Template Selection**
   - Open modal
   - Select each template
   - Verify pre-filled values

2. **Custom Provider**
   - Select custom template
   - Verify empty form
   - Fill manually

3. **Modal Behavior**
   - Open/close with X button
   - Cancel button
   - Click outside (if applicable)

4. **Internationalization**
   - Switch to German
   - Verify all text translates
   - Switch back to English

5. **Form Integration**
   - Add provider from template
   - Edit provider
   - Save configuration
   - Reload page

### Manual Testing Checklist

- [x] Code compiles without errors
- [x] Linting passes (npm run lint:fix)
- [x] Formatting passes (npm run format:fix)
- [x] Server starts successfully
- [ ] Modal opens on button click
- [ ] All 5 providers visible
- [ ] Templates pre-fill correctly
- [ ] Custom creates empty form
- [ ] Modal closes properly
- [ ] Translations work
- [ ] Save functionality works

## Future Enhancements

### Phase 2 Features
1. **Additional Templates**
   - Okta
   - Azure AD B2C
   - GitLab
   - GitHub
   - Generic SAML

2. **Configuration Wizard**
   - Step-by-step setup for each provider
   - Provider-specific help text
   - Validation per step

3. **Test Connection**
   - Button to test provider configuration
   - Pre-flight checks before saving
   - Detailed error messages

4. **Import/Export**
   - Export provider configurations
   - Import from JSON
   - Share configurations between instances

5. **Provider Logos**
   - Real provider logos
   - Better visual identification
   - Consistent branding

### Technical Improvements
1. **Template Versioning**
   - Track template versions
   - Migration path for updates
   - Deprecation notices

2. **Dynamic Templates**
   - Load templates from API
   - Admin-defined templates
   - Template marketplace

3. **Validation**
   - Pre-save validation
   - URL reachability checks
   - Scope validation

## Related Documentation

- **Implementation**: `OIDC_PROVIDER_SELECTOR_FEATURE.md`
- **OIDC Guide**: `docs/oidc-authentication.md`
- **Admin Guide**: `docs/ifinder-iassistant-admin-guide.md`
- **Architecture**: `docs/authentication-architecture.md`

## Code Locations

### Main Implementation
- `client/src/features/admin/components/PlatformFormEditor.jsx` (lines 1-150, 687-800)

### Translation Files
- `shared/i18n/en.json` (lines 470-485)
- `shared/i18n/de.json` (lines 644-660)

### Related Files
- `server/middleware/oidcAuth.js` (OIDC backend logic)
- `contents/config/platform.json` (configuration storage)

## Migration Notes

### Backward Compatibility
- ✅ Existing providers unaffected
- ✅ Manual configuration still works
- ✅ No breaking changes
- ✅ No database migrations needed

### Upgrade Path
1. Pull latest code
2. Install dependencies: `npm install`
3. Restart server
4. Feature available immediately

## Support

### Common Issues

**Issue**: Modal doesn't open
- **Solution**: Check browser console for errors
- **Solution**: Ensure React state updates correctly

**Issue**: Templates not pre-filling
- **Solution**: Verify OIDC_PROVIDER_TEMPLATES constant
- **Solution**: Check template type parameter

**Issue**: Translations missing
- **Solution**: Clear browser cache
- **Solution**: Verify i18n files loaded

### Getting Help
- GitHub Issues: https://github.com/intrafind/ihub-apps/issues
- Documentation: `docs/oidc-authentication.md`
- Code Review: `OIDC_PROVIDER_SELECTOR_FEATURE.md`

## Conclusion

This feature significantly improves the administrator experience when configuring OIDC authentication. By reducing configuration complexity from 10 fields to 2 fields, and providing visual provider selection, we've made enterprise-grade authentication more accessible while maintaining flexibility for custom providers.

The implementation is fully internationalized, maintainable, and extensible for future enhancements.
