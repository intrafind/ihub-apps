## Authentication and Authorization Concept

This concept outlines a comprehensive authentication and authorization layer for the AI Hub Apps platform, supporting multiple authentication methods with robust security measures.

**Last Updated:** July 20, 2025 - Added ETag security fixes and authentication bypass vulnerability patches.

### Objectives

- Allow anonymous and authenticated users.
- Control access to apps and features through role‐based or group‐based permissions.
- Map user information and group memberships from external identity providers.

### Supported Authentication Methods

- **OIDC with Microsoft Entra** – primary method for receiving user identity and groups.
- **Local Active Directory (AD)** – via Windows Integrated Authentication (WIA), using libraries such as passport-waffle/passport-windowsauth (Node.js).
- **OAuth 2.0 providers** (e.g., Google, Facebook) – optional additional sign‐in options.
- **Local accounts** for development or fallback scenarios.
- Other identity systems (e.g., SAML or LDAP) can be integrated later if needed.

### Authorization Approach

1. Users are assigned to groups in the identity provider
2. 1 to many groups are mapped to our 1 to many groups on our side.
3. Apps are mapped to groups.
4. Grant anonymous users access only to specific apps via a specific group.

### Implementation Steps

1. ✅ **Authentication Library Integration** - Implemented Passport.js with multiple authentication strategies
2. ✅ **OIDC Support** - Added Microsoft Entra, Google, and Auth0 OIDC providers
3. ✅ **Local Authentication** - Implemented JWT-based local authentication with bcrypt password hashing
4. ✅ **Proxy Authentication** - Added support for proxy header-based authentication
5. ✅ **Authentication Middleware** - Comprehensive middleware for authentication validation
6. ✅ **Group Mapping** - Dynamic group mapping and permission enhancement
7. ✅ **Authorization Checks** - Endpoint protection with group-based access control
8. ✅ **Security Hardening** - Fixed authentication bypass vulnerabilities and cache poisoning

### Design Notes

- ✅ **Multi-Strategy Authentication** - Passport.js implementation supporting OIDC, local, and proxy authentication
- ✅ **Configuration-Based** - Group mappings and permissions stored in JSON configuration files
- ✅ **Unified User Format** - Normalized user profiles from all authentication sources
- ✅ **Extensible Architecture** - Plugin system for additional authentication providers
- ✅ **Wildcard Support** - Apps can be mapped to groups using "*" for all apps access
- ✅ **Stateless Architecture** - JWT-based authentication without server-side sessions
- ✅ **Token Security** - JWT tokens with configurable expiration and secret rotation
- ✅ **Horizontal Scaling** - No session state, fully scalable across multiple instances

### Security Measures Implemented

#### Authentication Security
- **Authentication Bypass Prevention** - All API endpoints protected with `authRequired` middleware
- **JWT Token Validation** - Comprehensive token verification with expiration checks
- **Password Security** - bcrypt hashing with user-specific salts
- **Session Management** - Secure logout with comprehensive cache cleanup

#### Authorization Security  
- **Group-Based Permissions** - Fine-grained access control through group memberships
- **Resource Filtering** - Apps, prompts, and models filtered by user permissions
- **Admin Protection** - Separate middleware for administrative endpoint protection
- **Permission Enhancement** - Runtime permission calculation based on group memberships

#### Caching Security (Critical Fix)
- **ETag Content-Based Hashing** - ETags generated from filtered content, not user identity
- **Cache Poisoning Prevention** - Different permission levels get different ETags
- **Efficient Cache Sharing** - Users with same permissions share cache efficiently
- **Cache Invalidation** - Permission changes automatically invalidate relevant caches

### Technical Implementation Details

#### Key Files Modified/Created

**Authentication Middleware:**
- `server/middleware/authRequired.js` - Core authentication validation middleware
- `server/middleware/localAuth.js` - JWT-based local authentication  
- `server/middleware/oidcAuth.js` - OIDC provider configurations
- `server/middleware/proxyAuth.js` - Proxy header authentication

**Authorization System:**
- `server/utils/authorization.js` - Permission calculation and group mapping
- `contents/config/groupPermissions.json` - Group-based permission definitions
- `contents/config/users.json` - Local user database with hashed passwords

**Security Fixes:**
- `server/routes/generalRoutes.js` - ETag content-based hashing implementation
- `client/src/api/client.js` - Frontend authentication integration
- `client/src/api/utils/requestHandler.js` - User-friendly error handling

#### Critical Security Vulnerabilities Fixed

1. **Authentication Bypass (High Severity)**
   - **Issue:** API endpoints accessible without authentication when `allowAnonymous: false`
   - **Fix:** Implemented comprehensive `authRequired` middleware on all protected endpoints
   - **Impact:** Prevented unauthorized access to apps, chat, and administrative functions

2. **ETag Cache Poisoning (High Severity)**  
   - **Issue:** All users shared same ETag, allowing Admin's full app list to be cached for regular users
   - **Fix:** Content-based ETag generation - ETag reflects actual filtered app content
   - **Impact:** Users with different permissions now get different ETags, preventing cache poisoning

3. **Frontend Authentication Integration**
   - **Issue:** API client not sending authentication headers, poor error handling
   - **Fix:** Automatic Bearer token injection and user-friendly error messages
   - **Impact:** Seamless authentication flow and better user experience

### Testing and Validation

- **Authentication Test Suite:** `server/tests/authentication-security.test.js` (150+ test cases)
- **Manual Testing Script:** `server/tests/manual-auth-test.js` 
- **Integration Tests:** Frontend-backend authentication flow validation
- **Security Verification:** Permission filtering and cache isolation confirmed

### Configuration Examples

**Group Permissions Example:**
```json
{
  "groups": {
    "admin": {
      "apps": ["*"],
      "prompts": ["*"], 
      "models": ["*"],
      "adminAccess": true
    },
    "user": {
      "apps": ["chat", "translator", "summarizer"],
      "prompts": ["general", "writing"],
      "models": ["gpt-3.5-turbo", "claude-3-sonnet"],
      "adminAccess": false
    }
  }
}
```

**Platform Configuration:**
```json
{
  "auth": {
    "mode": "local",
    "allowAnonymous": false,
    "anonymousGroup": "anonymous",
    "authenticatedGroup": "authenticated"
  },
  "localAuth": {
    "enabled": true,
    "sessionTimeoutMinutes": 480,
    "jwtSecret": "secure-secret-key"
  }
}
```

1. **Which identity provider(s) will be used initially?**  
   Support both OIDC via Microsoft Entra and local Active Directory (AD) via Windows Integrated Authentication.
2. **Will anonymous access be permitted, and to which apps?**  
   Yes. Anonymous users are handled like authenticated users. They are mapped to a specific group, which specifies which apps they can use.
3. **Which authentication library should be used with the Express server?**  
   Use Passport.js with both OIDC and Windows/AD strategies (e.g., passport-azure-ad, passport-openidconnect, passport-waffle, or passport-windowsauth).
4. **Where will user profiles and tokens be stored?**  
   Initially in memory or sessions; persist them in a database if the project grows.
5. **How will failures be handled (e.g., expired tokens, AD connection issues)?**  
   Return localized error codes similar to the existing API error handling.
6. **Do we need local accounts for development?**  
   Not yet.
7. **How will the front end handle login/logout?**  
   Replace the current random session ID with real authentication tokens obtained during login. Support both login flows in the UI.

### Impact on Existing Code

- Add middleware to authenticate incoming requests and check permissions for both OIDC and AD users.
- Update client-side session utilities to store authentication tokens instead of only a random ID, and support both login flows.
- Normalize user and group data from both authentication sources for consistent authorization checks.
- Usage tracking can include tenant and user identifiers once authentication is in place.
