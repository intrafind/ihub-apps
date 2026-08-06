# Platform Configuration Security Refactoring

## Date: 2025-01-27

## Problem Statement
The `/api/configs/platform` endpoint was exposing too much server configuration to the frontend, creating unnecessary security risks by leaking operational information to clients.

## Solution Architecture
Eliminated the `/api/configs/platform` endpoint and distributed its functionality across two focused endpoints:

1. **`/api/auth/status`** - handles all authentication-related configuration
2. **`/api/configs/ui`** - handles UI-related configuration and metadata

## Changes Made

### Backend Changes

#### 1. Enhanced `/api/auth/status` endpoint
**File**: `server/routes/auth.js`

- Added `showDemoAccounts` field to the `local` auth method configuration
- This endpoint now provides all authentication-related data needed by the frontend

#### 2. Enhanced `/api/configs/ui` endpoint  
**File**: `server/routes/chat/dataRoutes.js`

- Added `version` (app version from package.json)
- Added `computedRefreshSalt` (for cache busting)
- Added `defaultLanguage` (platform default language)
- Added `admin.pages` and `admin.encrypted` (admin configuration)

#### 3. Removed `/api/configs/platform` endpoint
**File**: `server/routes/chat/dataRoutes.js`

- Completely removed the endpoint handler and Swagger documentation
- This eliminates exposure of sensitive platform configuration data

### Frontend Changes

#### 1. Updated PlatformConfigContext
**File**: `client/src/shared/contexts/PlatformConfigContext.jsx`

- Changed from single `fetchPlatformConfig()` call to parallel fetching of both endpoints
- Combines data from `/api/auth/status` and `/api/configs/ui` into unified structure
- Maintains backward compatibility - existing components continue to work unchanged

#### 2. Updated Utility Services
**Files**: 
- `client/src/utils/forceRefresh.js` - now uses UI config for refresh salt
- `client/src/services/i18nService.js` - now uses UI config for default language

#### 3. Added new API endpoint
**File**: `client/src/api/endpoints/misc.js`

- Added `fetchAuthStatus()` function for the auth status endpoint
- Added corresponding cache key `AUTH_STATUS`

#### 4. Removed deprecated API functions
**File**: `client/src/api/endpoints/config.js`

- Removed `fetchPlatformConfig()` function
- Removed `PLATFORM_CONFIG` cache key

## Data Mapping

### Authentication Data (from `/api/auth/status`)
- `authMode` → `auth.mode`
- `anonymousAuth` → `anonymousAuth`
- `authMethods.local` → `localAuth`
- `authMethods.proxy` → `proxyAuth`
- `authMethods.oidc` → `oidcAuth`
- `authMethods.ldap` → `ldapAuth`
- `authMethods.ntlm` → `ntlmAuth`
- `authenticated` → `authenticated`
- `user` → `user`
- `autoRedirect` → `autoRedirect`

### UI/Metadata (from `/api/configs/ui`)
- `version` → `version`
- `computedRefreshSalt` → `computedRefreshSalt`
- `defaultLanguage` → `defaultLanguage`
- `admin` → `admin`

## Security Benefits

1. **Reduced Attack Surface**: Eliminated a broad endpoint that exposed internal configuration
2. **Principle of Least Privilege**: Each endpoint now only exposes data relevant to its purpose
3. **Better Separation of Concerns**: Auth data separate from UI data
4. **Maintained Functionality**: All existing features continue to work

## Testing Results

- ✅ Authentication flows working correctly
- ✅ UI configuration loading properly
- ✅ Cache busting (refresh salt) functioning
- ✅ Internationalization (default language) working
- ✅ Admin panel configuration intact
- ✅ All frontend components functioning without changes
- ✅ `/api/configs/platform` endpoint completely removed (returns 404)

## Backward Compatibility

This refactoring maintains complete backward compatibility at the component level:
- All React components continue to use `usePlatformConfig()` hook unchanged
- The `platformConfig` object structure remains the same
- No breaking changes for existing functionality

## Future Considerations

- Monitor for any additional data that might be needed by the frontend
- Consider further breaking down the auth status if it grows too large
- Regular security audits to ensure no sensitive data leakage