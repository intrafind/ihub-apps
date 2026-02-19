# OIDC Provider Template Selector Feature

## Overview
This document describes the newly implemented OIDC Provider Template Selector feature that simplifies the process of adding OIDC authentication providers to iHub Apps.

## Problem Statement
Previously, when adding an OIDC provider, administrators had to manually configure all provider-specific settings (authorization URL, token URL, user info URL, scopes, etc.). This required deep knowledge of each provider's OIDC implementation and was error-prone.

## Solution
The new feature adds a provider template selector modal that allows administrators to:
1. Choose from predefined provider templates (Auth0, Google, Microsoft, Keycloak)
2. Or create a custom provider with manual configuration

## Implementation Details

### 1. Provider Templates
Five provider templates are now available:

#### Auth0
```javascript
{
  name: 'auth0',
  displayName: 'Auth0',
  authorizationURL: 'https://${AUTH0_DOMAIN}/authorize',
  tokenURL: 'https://${AUTH0_DOMAIN}/oauth/token',
  userInfoURL: 'https://${AUTH0_DOMAIN}/userinfo',
  scope: ['openid', 'profile', 'email'],
  groupsAttribute: 'groups',
  pkce: true
}
```

#### Google
```javascript
{
  name: 'google',
  displayName: 'Google',
  authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenURL: 'https://www.googleapis.com/oauth2/v4/token',
  userInfoURL: 'https://www.googleapis.com/oauth2/v2/userinfo',
  scope: ['openid', 'profile', 'email'],
  groupsAttribute: 'groups',
  pkce: true
}
```

#### Microsoft
```javascript
{
  name: 'microsoft',
  displayName: 'Microsoft',
  authorizationURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  userInfoURL: 'https://graph.microsoft.com/v1.0/me',
  scope: ['openid', 'profile', 'email', 'User.Read'],
  groupsAttribute: 'groups',
  pkce: true
}
```

#### Keycloak
```javascript
{
  name: 'keycloak',
  displayName: 'Keycloak',
  authorizationURL: 'https://${KEYCLOAK_SERVER}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth',
  tokenURL: 'https://${KEYCLOAK_SERVER}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token',
  userInfoURL: 'https://${KEYCLOAK_SERVER}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/userinfo',
  scope: ['openid', 'profile', 'email'],
  groupsAttribute: 'groups',
  pkce: true
}
```

#### Custom
An empty template for manual configuration.

### 2. User Interface Changes

#### Before
- Single "Add OIDC Provider" button that immediately created an empty provider
- All fields had to be filled manually

#### After
- "Add OIDC Provider" button opens a selection modal
- Modal displays 5 provider options in a grid layout:
  - Auth0 (orange icon)
  - Google (red icon)
  - Microsoft (blue icon)
  - Keycloak (green icon)
  - Custom (gray icon, spans 2 columns)
- Each option shows:
  - Icon with colored background
  - Provider name
  - Brief description
- Clicking a provider creates a new provider configuration with pre-filled values

### 3. Modal Design
The modal includes:
- Title: "Select OIDC Provider"
- Description: "Choose a preconfigured provider template or create a custom configuration"
- 2-column grid layout (responsive: 1 column on mobile, 2 on desktop)
- Hover effect: Blue border on hover
- Close button (X) in top-right corner
- Cancel button at bottom

### 4. Code Changes

**File: `client/src/features/admin/components/PlatformFormEditor.jsx`**

1. Added `OIDC_PROVIDER_TEMPLATES` constant with all templates
2. Added `showProviderModal` state variable
3. Modified `addOidcProvider()` function to accept `templateType` parameter
4. Updated "Add OIDC Provider" button to open modal
5. Added complete modal component at the end of the form

**Files: `shared/i18n/en.json` and `shared/i18n/de.json`**

Added translation keys:
- `admin.auth.addOidcProvider`: "Add OIDC Provider" / "OIDC-Anbieter hinzufügen"
- `admin.auth.selectOidcProvider`: "Select OIDC Provider" / "OIDC-Anbieter auswählen"
- `admin.auth.selectProviderDescription`: Description text
- `admin.auth.auth0Description`: "Enterprise identity platform" / "Unternehmens-Identitätsplattform"
- `admin.auth.googleDescription`: "Sign in with Google accounts" / "Anmeldung mit Google-Konten"
- `admin.auth.microsoftDescription`: "Sign in with Microsoft/Azure AD accounts" / "Anmeldung mit Microsoft/Azure AD-Konten"
- `admin.auth.keycloakDescription`: "Open source identity management" / "Open-Source-Identitätsverwaltung"
- `admin.auth.customProvider`: "Custom Provider" / "Benutzerdefinierter Anbieter"
- `admin.auth.customProviderDescription`: Description for custom option

## User Workflow

### Adding a Provider

1. Navigate to Admin > Authentication
2. Enable OIDC Authentication
3. Click "Add OIDC Provider" button
4. Modal appears with 5 provider options
5. Select desired provider (e.g., Google)
6. Form is pre-filled with:
   - Provider name: "google"
   - Display name: "Google"
   - Authorization URL: "https://accounts.google.com/o/oauth2/v2/auth"
   - Token URL: "https://www.googleapis.com/oauth2/v4/token"
   - User Info URL: "https://www.googleapis.com/oauth2/v2/userinfo"
   - Scope: "openid, profile, email"
   - Groups Attribute: "groups"
   - PKCE: enabled
7. Admin only needs to fill:
   - Client ID (e.g., from environment variable `${GOOGLE_CLIENT_ID}`)
   - Client Secret (e.g., from environment variable `${GOOGLE_CLIENT_SECRET}`)
8. Save configuration

### Advantages

**Before**: Admin needed to know and enter 7-10 provider-specific fields
**After**: Admin only needs to enter 2 fields (Client ID and Client Secret)

## Benefits

1. **Reduced Configuration Time**: 80% reduction in fields to configure
2. **Error Prevention**: Pre-filled URLs eliminate typos and incorrect configurations
3. **Improved UX**: Visual provider selection vs. empty form
4. **Consistency**: Standardized configurations across deployments
5. **Documentation**: Built-in provider descriptions help admins choose
6. **Flexibility**: Custom option still available for non-standard providers
7. **Internationalization**: Full support for English and German

## Technical Benefits

1. **Maintainable**: Templates centralized in one location
2. **Extensible**: Easy to add new provider templates
3. **Type-safe**: Template structure ensures all required fields
4. **Backward Compatible**: Existing configurations unaffected

## Future Enhancements

Potential future improvements:
1. Add more provider templates (Okta, Azure AD B2C, etc.)
2. Provider-specific configuration wizards
3. Test connection button for each provider
4. Import/export provider configurations
5. Provider logo images instead of generic icons

## Testing

### Manual Testing Checklist
- [ ] Modal opens when clicking "Add OIDC Provider"
- [ ] All 5 provider options are displayed correctly
- [ ] Clicking each provider creates configuration with pre-filled values
- [ ] Custom provider creates empty configuration
- [ ] Modal closes after selecting a provider
- [ ] Cancel button closes modal without changes
- [ ] Close button (X) closes modal without changes
- [ ] Translations work in both English and German
- [ ] Provider configurations can be edited after creation
- [ ] Save functionality works with new providers

### Browser Compatibility
- Chrome/Edge: ✓ (Tested)
- Firefox: ✓ (Expected)
- Safari: ✓ (Expected)

## Documentation Updates

No documentation updates required as this is a UI enhancement that simplifies existing functionality. The feature is self-explanatory through the UI.

## Rollout Plan

1. **Phase 1**: Feature merged to main branch
2. **Phase 2**: Test with internal users
3. **Phase 3**: Release in next version
4. **Phase 4**: Update migration guide if needed

## Support

For issues or questions:
- GitHub Issues: https://github.com/intrafind/ihub-apps/issues
- Documentation: https://github.com/intrafind/ihub-apps/blob/main/docs/oidc-authentication.md
