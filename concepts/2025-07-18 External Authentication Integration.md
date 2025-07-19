# External Authentication Integration

This concept outlines how AI Hub Apps can rely on a reverse proxy or external service for user authentication. Instead of handling the login flow ourselves, the server will trust user information provided by upstream components such as nginx, Apache, OAuth proxies, or Microsoft Teams. The long term goal is to support both this "proxy" mode and a full OpenID Connect (OIDC) flow managed by the server itself.

## Goals

- Support deployments where authentication is already handled outside of the AI Hub Apps server.
- Reuse user identity (name, email, groups) provided by a reverse proxy or platform like Teams.
- Keep the server stateless: every request must include the required headers or tokens.
- Allow mapping of external groups to our internal permission groups.

## Implementation Overview

1. **Configuration**
   - Add a `proxyAuth` section to `platform.json` describing where user data is passed:
     - `enabled`: activate or deactivate the feature.
     - `userHeader`: header name containing the user identifier (e.g. `X-Forwarded-User`).
     - `groupsHeader`: optional header with comma‑separated group names.
     - `jwtProviders`: array of JWT provider configs. Each entry specifies:
       - `header`: name of the header containing the token (default `Authorization`).
       - `issuer`/`audience` values expected in the token claims.
       - `jwkUrl`: location of the JSON Web Key Set for verifying the signature.
   - Environment variables (e.g. `PROXY_AUTH_ENABLED`, `PROXY_AUTH_USER_HEADER`) can override the values in `platform.json` so deployments may adjust settings without editing the file.

2. **Middleware**
   - Create `server/middleware/proxyAuth.js`.
   - Read the configured headers from each request.
   - If a JWT is present, determine the matching provider from `jwtProviders` and verify the token using `jsonwebtoken` and the provider's JWKs.
   - Populate `req.user` with `{ id, name, email, groups }` so downstream routes can perform authorization.
   - If `proxyAuth.enabled` is false or headers are missing, treat the user as anonymous.

3. **Group Mapping**
   - Reuse the existing group‑to‑app mapping logic from the authorization concept.
   - Map incoming group names to internal groups via a configuration file.

4. **Usage in Routes**
   - Update existing route handlers to rely on `req.user` for user information.
   - Continue tracking `x-session-id` or chat ID for analytics, but include the user identifier when available.

5. **Examples and Documentation**
   - Provide example snippets in `docs/server-config.md` showing how to enable proxy authentication.
   - Explain expected headers when deploying behind nginx, OAuth2 Proxy, or when receiving Teams tokens.

## Benefits

- Allows immediate integration with corporate SSO solutions without implementing our own login.
- Keeps the server stateless and scalable.
- Prepares the codebase for a future full authentication layer by normalizing user data early.

## Next Step: Built-in OIDC Support

After the proxy mode is stable we will integrate full OIDC login in the server. This keeps the platform flexible for customers that cannot provide authenticated headers.

1. **Provider Configuration**
   - Introduce an `authProviders` array in `platform.json` with one entry per OIDC provider.
   - Each provider defines `issuer`, `clientId`, `clientSecret`, `scopes`, and `jwkUrl` for token validation.
   - Multiple providers can coexist so different customers may use their own identity systems.

2. **Passport.js Integration**
   - Use Passport.js strategies for each configured provider to handle the login redirect and callback.
   - Upon successful authentication normalize the user profile and groups the same way as the proxy mode.
   - Issue a short lived token signed by the server so subsequent requests remain stateless.

3. **Compatibility with Proxy Mode**
   - Both proxy authentication and server managed OIDC can be enabled. If a valid JWT from a proxy is present it is used; otherwise the user may go through the OIDC login flow.

This two phase approach ensures the server can integrate with existing SSO setups immediately while paving the way for a self contained authentication option.

## Client Login Flow Configuration

The frontend loads `/api/configs/platform` during startup. This response will contain an `auth` section describing how users are expected to authenticate. The UI then chooses the appropriate flow:

- `mode: "proxy"` – The client starts an external login (e.g., Microsoft Teams or a corporate SSO page) and receives a JWT. This token is forwarded to the server using the header defined in `proxyAuth.jwtProviders[*].header`.
- `mode: "local"` – The user enters a username and password directly in the UI. The credentials are sent to `/api/login`, the server verifies them, and replies with its own JWT.
- `mode: "oidc"` – The UI redirects the browser to a server endpoint which starts an OIDC flow via Passport.js. After the provider calls back, the server issues a JWT for subsequent requests.

The chosen mode can be overridden with an `AUTH_MODE` environment variable so deployments can switch authentication strategies without rebuilding the client.

## Current Implementation Status (Updated: 2025-07-18)

### ✅ **Implemented Components:**
1. **Proxy Authentication Middleware** - `server/middleware/proxyAuth.js` - Fully implemented with JWT validation, JWK support, and group mapping
2. **Configuration Structure** - `contents/config/platform.json` - Basic proxyAuth configuration present
3. **Platform Config API** - `/api/configs/platform` endpoint exists for client configuration loading
4. **Admin Authentication** - Complete admin auth system with Bearer token validation
5. **Group Mapping** - Group-to-permission mapping system implemented

### ⚠️ **Missing Components (High Priority):**
1. **Auth Mode Configuration** - No `auth.mode` section in platform config or environment variables
2. **Client Authentication Flow** - No client-side authentication components for proxy/local/OIDC modes
3. **Local Authentication Mode** - No username/password login implementation
4. **OIDC Authentication Mode** - No Passport.js integration or OIDC provider support
5. **Login/Logout Routes** - No `/api/login` or authentication endpoints beyond admin auth

### 🔧 **Improvements Needed (Medium Priority):**
1. **Enhanced Platform Config Response** - `/api/configs/platform` doesn't include `auth` section as specified
2. **JWT Provider Configuration** - Empty `jwtProviders` array needs example configurations
3. **User Context Integration** - Routes don't fully utilize `req.user` from proxy auth
4. **Error Handling** - Limited authentication error pages and flows

### 🧪 **Testing Recommendations:**

#### **Proxy Mode Testing:**
```bash
# Test with headers
curl -H "X-Forwarded-User: test@example.com" \
     -H "X-Forwarded-Groups: admin,users" \
     http://localhost:3000/api/some-protected-route

# Test with JWT
curl -H "Authorization: Bearer <jwt-token>" \
     http://localhost:3000/api/some-protected-route
```

#### **Configuration Testing:**
```bash
# Test platform config endpoint
curl http://localhost:3000/api/configs/platform | jq '.auth'

# Test with environment overrides
PROXY_AUTH_ENABLED=true \
PROXY_AUTH_USER_HEADER=X-Custom-User \
npm start
```

#### **Integration Testing Setup:**
- Use Docker containers with nginx proxy for header injection
- Mock JWT providers with test keys
- Create test user directories for local mode

### 📋 **Next Steps:**
1. Complete authentication mode configuration in platform.json
2. Implement client-side authentication context and components
3. Add local authentication mode with username/password
4. Integrate OIDC mode with Passport.js
5. Create comprehensive test suite for all authentication modes

**Current Status:** Foundation is solid with proxy authentication working, but client-side integration and completion of local/OIDC modes are needed for full functionality.

## Group-Based Authorization Strategy

### **Core Questions & Solutions:**

#### **1. How to leverage groups for admin access?**
- **Current State:** Admin access uses Bearer token from `platform.json` admin secret
- **Proposed Enhancement:** 
  ```json
  "authorization": {
    "adminGroups": ["Admins", "IT-Admin", "Platform-Admin"],
    "userGroups": ["Users", "Everyone"],
    "anonymousAccess": true
  }
  ```
- **Implementation:** Check if user's groups intersect with `adminGroups` for admin routes

#### **2. How to handle anonymous users/groups?**
- **Anonymous User Mapping:** Users without authentication get assigned to `["anonymous"]` group
- **Configuration:**
  ```json
  "proxyAuth": {
    "anonymousGroup": "anonymous",
    "allowAnonymous": true
  }
  ```
- **Group Mapping:** Map `"anonymous"` to specific internal permissions

#### **3. How to filter apps, prompts, models by groups?**

**Group-Centric Access Control (Recommended Approach):**
```json
{
  "groups": {
    "admin": {
      "apps": ["*"],
      "prompts": ["*"], 
      "models": ["*"],
      "adminAccess": true
    },
    "hr": {
      "apps": ["hr-assistant", "chat", "email-composer"],
      "prompts": ["hr-policies", "interview-questions"],
      "models": ["gpt-4", "claude-3-sonnet"]
    },
    "users": {
      "apps": ["chat", "translator", "summarizer"],
      "prompts": ["general"],
      "models": ["gpt-3.5-turbo", "gemini-pro"]
    },
    "contractors": {
      "apps": ["chat"],
      "prompts": [],
      "models": ["gpt-3.5-turbo"]
    },
    "anonymous": {
      "apps": ["chat"],
      "prompts": [],
      "models": ["gemini-flash"]
    }
  }
}
```

**Benefits of Group-Centric Approach:**
- **Centralized**: All permissions defined in one configuration
- **Wildcard Support**: `"*"` means access to all resources of that type
- **Flexible**: Groups can have empty arrays (no access) or specific resource lists
- **Scalable**: Easy to add new groups without modifying individual resource files
- **Override Ready**: Can be enhanced later with resource-level restrictions
```

### **Implementation Plan:**

#### **Phase 1: Group-Centric Configuration**
1. **Group Permissions Configuration** (`contents/config/groupPermissions.json`)
   ```json
   {
     "groups": {
       "admin": {
         "apps": ["*"],
         "prompts": ["*"], 
         "models": ["*"],
         "adminAccess": true
       },
       "users": {
         "apps": ["chat", "translator", "summarizer"],
         "prompts": ["general"],
         "models": ["gpt-3.5-turbo", "gemini-pro"]
       },
       "anonymous": {
         "apps": ["chat"],
         "prompts": [],
         "models": ["gemini-flash"]
       }
     }
   }
   ```

2. **Enhanced Group Mapping** (`contents/config/groupMap.json`)
   ```json
   {
     "IT-Admins": ["admin"],
     "Platform-Admins": ["admin"], 
     "HR-Team": ["hr"],
     "Employees": ["users"],
     "Contractors": ["contractors"],
     "anonymous": ["anonymous"]
   }
   ```

#### **Phase 2: Group-Based Resource Filtering**
1. **Authorization Utility** (`server/utils/authorization.js`)
   ```javascript
   export function getPermissionsForUser(userGroups, groupPermissions) {
     const permissions = { apps: new Set(), prompts: new Set(), models: new Set(), adminAccess: false };
     
     for (const group of userGroups) {
       const groupPerms = groupPermissions.groups[group];
       if (!groupPerms) continue;
       
       // Handle wildcards and specific permissions
       if (groupPerms.apps?.includes('*')) permissions.apps.add('*');
       else groupPerms.apps?.forEach(app => permissions.apps.add(app));
       
       if (groupPerms.prompts?.includes('*')) permissions.prompts.add('*');
       else groupPerms.prompts?.forEach(prompt => permissions.prompts.add(prompt));
       
       if (groupPerms.models?.includes('*')) permissions.models.add('*');
       else groupPerms.models?.forEach(model => permissions.models.add(model));
       
       if (groupPerms.adminAccess) permissions.adminAccess = true;
     }
     
     return permissions;
   }
   
   export function filterResourcesByPermissions(resources, allowedResources, resourceType) {
     if (allowedResources.has('*')) return resources;
     return resources.filter(resource => allowedResources.has(resource.id || resource.modelId));
   }
   ```

2. **Enhanced API Endpoints**
   - `GET /api/apps` - Filter by group permissions
   - `GET /api/models` - Filter by group permissions  
   - `GET /api/prompts` - Filter by group permissions

#### **Phase 3: Admin Group Integration**
1. **Group-Based Admin Access** - Use `adminAccess: true` from group permissions
2. **Enhanced Admin Middleware** 
   ```javascript
   export function adminAuth(req, res, next) {
     // Check group-based admin access first
     if (req.user?.permissions?.adminAccess) return next();
     
     // Fall back to Bearer token for backward compatibility
     return legacyAdminAuth(req, res, next);
   }
   ```
3. **Gradual Migration** - Support both approaches during transition

### **Configuration Examples:**

#### **Enterprise Setup:**
```json
{
  "proxyAuth": {
    "enabled": true,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups"
  },
  "authorization": {
    "adminGroups": ["IT-Admin", "Platform-Admin"],
    "anonymousAccess": false,
    "defaultGroup": "user"
  }
}
```

#### **Open Platform Setup:**
```json
{
  "authorization": {
    "adminGroups": ["admin"],
    "anonymousAccess": true,
    "defaultGroup": "anonymous"
  }
}
```

### **Testing Strategy:**
```bash
# Test admin access via groups
curl -H "X-Forwarded-User: admin@company.com" \
     -H "X-Forwarded-Groups: IT-Admin,Users" \
     http://localhost:3000/api/admin/apps

# Test filtered apps
curl -H "X-Forwarded-User: user@company.com" \
     -H "X-Forwarded-Groups: HR,Users" \
     http://localhost:3000/api/apps

# Test anonymous access
curl http://localhost:3000/api/apps
```

This strategy provides flexible, group-based authorization while maintaining backward compatibility and supporting both authenticated and anonymous users.
