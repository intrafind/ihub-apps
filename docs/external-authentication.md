# External Authentication Integration

This document explains how to configure and use the External Authentication Integration feature in AI Hub Apps.

## Overview

AI Hub Apps supports multiple authentication modes and is **fully functional without any authentication by default**:

### **Default Configuration (No Authentication Required)**

- **Anonymous Access**: Users can access all apps, models, and features without logging in
- **Zero Configuration**: Works out of the box with no setup required
- **Full Functionality**: All features available to anonymous users by default

### **Optional Authentication Modes**

The platform supports five authentication methods:

1. **[JWT Authentication](jwt-authentication.md)** - External JWT tokens (no handshake required)
2. **[OIDC Authentication](oidc-authentication.md)** - Full OpenID Connect flow
3. **Local Authentication** - Built-in user database
4. **Proxy Authentication** - Reverse proxy headers
5. **Anonymous** - No authentication (default)

- **Proxy Mode**: Authentication handled by reverse proxy or external service
- **Local Mode**: Built-in username/password authentication
- **OIDC Mode**: OpenID Connect authentication with external providers

The system is designed to be stateless and flexible, supporting both authenticated and anonymous access based on your needs.

## Default Configuration (No Authentication)

**AI Hub Apps works perfectly without any authentication setup!** This is the default configuration:

```json
{
  "auth": {
    "mode": "proxy"
  },
  "anonymousAuth": {
    "enabled": true,
    "defaultGroups": ["anonymous"]
  },
  "proxyAuth": {
    "enabled": false
  },
  "localAuth": {
    "enabled": false
  },
  "oidcAuth": {
    "enabled": false
  },
  "authorization": {
    "anonymousAccess": true,
    "defaultGroup": "anonymous"
  }
}
```

### What This Means

- **No Login Required**: Users can immediately start using all apps and features
- **Full Access**: Anonymous users have access to all apps, models, and prompts by default
- **Zero Setup**: No configuration files to edit, no authentication providers to set up
- **Admin Panel**: Still accessible via admin authentication (separate from user auth)

### Anonymous User Permissions

By default, anonymous users get access to everything through the `anonymous` group:

```json
{
  "groups": {
    "anonymous": {
      "apps": ["*"],
      "prompts": ["*"],
      "models": ["*"],
      "adminAccess": false
    }
  }
}
```

**To restrict anonymous access**, modify `contents/config/groups.json`:

```json
{
  "groups": {
    "anonymous": {
      "id": "anonymous",
      "name": "Anonymous",
      "description": "Access for unauthenticated users",
      "permissions": {
        "apps": ["chat", "translator"],
        "prompts": ["general"],
        "models": ["gemini-flash"],
        "adminAccess": false
      },
      "mappings": ["anonymous"]
    }
  }
}
```

### When to Enable Authentication

Consider enabling authentication when you need:

- **User Tracking**: Know who is using which features
- **Access Control**: Restrict certain apps/models to specific users or groups
- **Usage Analytics**: Track usage per user or department
- **Corporate Integration**: Connect with existing SSO/identity systems
- **Compliance**: Meet security or audit requirements

## Configuration

### Platform Configuration

Authentication is configured in `contents/config/platform.json`:

```json
{
  "auth": {
    "mode": "proxy"
  },
  "anonymousAuth": {
    "enabled": true,
    "defaultGroups": ["anonymous"]
  },
  "proxyAuth": {
    "enabled": false,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups",
    "jwtProviders": [
      {
        "name": "example-provider",
        "header": "Authorization",
        "issuer": "https://example.com",
        "audience": "ai-hub-apps",
        "jwkUrl": "https://example.com/.well-known/jwks.json"
      }
    ]
  },
  "authorization": {
    "adminGroups": ["admin", "IT-Admin", "Platform-Admin"],
    "userGroups": ["user", "users"],
    "anonymousAccess": true,
    "defaultGroup": "anonymous"
  },
  "localAuth": {
    "enabled": false,
    "usersFile": "contents/config/users.json",
    "sessionTimeoutMinutes": 480,
    "jwtSecret": "${JWT_SECRET}"
  }
}
```

### Environment Variables

You can override configuration using environment variables:

```bash
# Authentication mode
AUTH_MODE=proxy|local|oidc
AUTH_ALLOW_ANONYMOUS=true|false
AUTH_ANONYMOUS_GROUP=anonymous
AUTH_AUTHENTICATED_GROUP=authenticated

# Proxy authentication
PROXY_AUTH_ENABLED=true|false
PROXY_AUTH_USER_HEADER=X-Forwarded-User
PROXY_AUTH_GROUPS_HEADER=X-Forwarded-Groups
PROXY_AUTH_ANONYMOUS_GROUP=anonymous

# Local authentication
LOCAL_AUTH_ENABLED=true|false
LOCAL_AUTH_SESSION_TIMEOUT=480
JWT_SECRET=your-secret-key

# OIDC authentication
OIDC_AUTH_ENABLED=true|false
```

### Group Management

**NEW:** AI Hub Apps now includes a unified group management system accessible through the admin interface at `/admin/groups`.

#### Admin Interface

- **Create/Edit Groups**: Full UI for managing groups, permissions, and external mappings
- **Permission Assignment**: Visual interface for assigning apps, models, and prompts to groups
- **External Mappings**: Configure how external groups (from OIDC, LDAP, etc.) map to internal groups
- **Wildcard Support**: Easy toggles for "All Apps (_)", "All Models (_)", "All Prompts (\*)"

#### Unified Configuration

Group configuration is now stored in `contents/config/groups.json`:

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Admin",
      "description": "Full administrative access to all resources",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Admins", "IT-Admin", "Platform-Admin"]
    },
    "user": {
      "id": "user",
      "name": "User",
      "description": "Standard user access to common applications",
      "permissions": {
        "apps": ["chat", "translator", "summarizer"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo", "gemini-pro"],
        "adminAccess": false
      },
      "mappings": ["Users", "Employees", "Staff"]
    }
  }
}
```

#### Legacy Support

The system maintains backwards compatibility with existing `groupPermissions.json` and legacy `groupMap.json` files. Use the migration script to convert to the new format:

```bash
node scripts/migrate-group-config.js
```

### Group Assignment

AI Hub Apps provides automatic group assignment for all authenticated users:

#### Automatic Groups

- **Authenticated Group**: All logged-in users automatically receive the `authenticated` group (configurable via `authenticatedGroup` in platform.json)
- **Provider Groups**: OIDC users can receive provider-specific default groups
- **Anonymous Group**: Non-authenticated users receive the `anonymous` group

#### Configuration

Set the authenticated group in `contents/config/platform.json`:

```json
{
  "auth": {
    "authenticatedGroup": "authenticated"
  },
  "anonymousAuth": {
    "enabled": true,
    "defaultGroups": ["anonymous"]
  }
}
```

#### Multi-Group Permission Aggregation

Users can belong to multiple groups simultaneously, and the system automatically aggregates permissions from **all** their groups using Set union logic. This means users see the combined permissions from every group they belong to.

**Example**: A user with groups `["authenticated", "microsoft-users", "hr"]` gets access to:

- Apps from all three groups combined
- Models from all three groups combined
- Prompts from all three groups combined
- Admin access if any group grants it

**Benefits**:

- **Flexible Access**: Users get broader access through multiple group memberships
- **No Conflicts**: Set aggregation ensures no duplicate permissions
- **Additive Permissions**: More groups = more access (never less)

**Testing Multi-Group Aggregation**:

```javascript
// Single group: limited access
const singleGroup = getPermissionsForUser(['google-users']);
// Result: 2 apps, 2 models

// Multiple groups: expanded access
const multiGroup = getPermissionsForUser(['authenticated', 'google-users']);
// Result: 5 apps, 4 models (union of both groups)

// Complex multiple groups: maximum access
const complexGroups = getPermissionsForUser(['authenticated', 'microsoft-users', 'hr']);
// Result: 7 apps, 4 models, 3 prompt types (union of all groups)
```

## Authentication Modes

### 1. Proxy Mode

Authentication is handled by a reverse proxy (nginx, Apache, OAuth2 Proxy, etc.) or pure JWT tokens.

**Configuration:**

```json
{
  "auth": { "mode": "proxy" },
  "proxyAuth": {
    "enabled": true,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups",
    "jwtProviders": [
      {
        "name": "your-provider",
        "header": "Authorization",
        "issuer": "https://your-provider.com",
        "audience": "ai-hub-apps",
        "jwkUrl": "https://your-provider.com/.well-known/jwks.json"
      }
    ]
  }
}
```

**Authentication Methods:**

#### **Header-Based Authentication (Traditional)**

- `X-Forwarded-User`: User identifier (email or username)
- `X-Forwarded-Groups`: Comma-separated list of groups
- `X-Forwarded-Name`: User's display name (optional)
- `X-Forwarded-Email`: User's email address (optional)

**Example nginx configuration:**

```nginx
location / {
    proxy_pass http://ai-hub-apps:3000;
    proxy_set_header X-Forwarded-User $remote_user;
    proxy_set_header X-Forwarded-Groups "Users,Employees";
    proxy_set_header X-Forwarded-Name "$http_x_forwarded_name";
    proxy_set_header X-Forwarded-Email "$http_x_forwarded_email";
}
```

#### **Pure JWT Authentication (New)**

Supports authentication using **only JWT tokens** without requiring any headers:

- `Authorization: Bearer <jwt-token>`: JWT token containing all user information

**JWT Token Claims:**

```json
{
  "sub": "user123",
  "preferred_username": "johndoe",
  "email": "john@example.com",
  "name": "John Doe",
  "given_name": "John",
  "family_name": "Doe",
  "groups": ["users", "admins"],
  "iss": "https://your-provider.com",
  "aud": "ai-hub-apps"
}
```

**User Extraction Priority:**

1. **User ID**: `preferred_username` → `upn` → `email` → `sub`
2. **Name**: JWT `name` → `given_name + family_name` → header `X-Forwarded-Name` → user ID
3. **Email**: JWT `email` → header `X-Forwarded-Email`
4. **Groups**: JWT `groups` array + header `X-Forwarded-Groups` (combined)

#### **Hybrid Mode**

Combines both methods - headers provide base authentication, JWT provides enhanced user data:

```bash
# Headers for basic auth + JWT for enhanced data
curl -H "X-Forwarded-User: user@example.com" \
     -H "X-Forwarded-Groups: basic-users" \
     -H "Authorization: Bearer <jwt-with-detailed-info>" \
     http://localhost:3000/api/auth/status
```

### 2. Local Mode

Built-in username/password authentication.

**Configuration:**

```json
{
  "auth": { "mode": "local" },
  "localAuth": {
    "enabled": true,
    "jwtSecret": "your-secure-secret"
  }
}
```

**User Management:**
Users are stored in `contents/config/users.json`:

```json
{
  "users": {
    "user_admin": {
      "id": "user_admin",
      "username": "admin",
      "email": "admin@example.com",
      "name": "Administrator",
      "groups": ["admin"],
      "active": true,
      "passwordHash": "$2b$12$..."
    }
  },
  "metadata": {
    "version": "2.0.0",
    "passwordHashingMethod": "bcrypt + userId salt",
    "description": "Passwords are hashed with user ID for unique hashes"
  }
}
```

**Password Security:**
The system uses an enhanced bcrypt hashing method that incorporates the user ID:

- Each password is combined with the user ID before hashing: `userId:password`
- This ensures every password hash is unique, even if multiple users have the same password
- Prevents rainbow table attacks and password hash copying between users
- Uses bcrypt with 12 rounds for strong protection

**Demo Users:**

- Username: `admin`, Password: `password123` (admin group)
- Username: `user`, Password: `password123` (user group)

### 3. OIDC Mode

OpenID Connect authentication with external providers like Google, Microsoft, Auth0, and others.

**Configuration:**

```json
{
  "auth": { "mode": "oidc" },
  "oidcAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "google",
        "displayName": "Google",
        "clientId": "${GOOGLE_CLIENT_ID}",
        "clientSecret": "${GOOGLE_CLIENT_SECRET}",
        "authorizationURL": "https://accounts.google.com/o/oauth2/v2/auth",
        "tokenURL": "https://www.googleapis.com/oauth2/v4/token",
        "userInfoURL": "https://www.googleapis.com/oauth2/v2/userinfo"
      }
    ]
  }
}
```

**See [OIDC Authentication Guide](./oidc-authentication.md) for complete configuration instructions.**

## API Endpoints

### Authentication Status

```http
GET /api/auth/status
```

Returns current authentication configuration and user status.

### Local Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "password123"
}
```

### Get Current User

```http
GET /api/auth/user
Authorization: Bearer <token>
```

### Logout

```http
POST /api/auth/logout
Authorization: Bearer <token>
```

### Create User (Admin Only)

```http
POST /api/auth/users
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "username": "newuser",
  "email": "user@example.com",
  "password": "securepassword",
  "name": "New User",
  "groups": ["user"]
}
```

## Testing

### Proxy Mode Testing

Test with curl:

```bash
# Test with headers (traditional)
curl -H "X-Forwarded-User: test@example.com" \
     -H "X-Forwarded-Groups: admin,users" \
     -H "X-Forwarded-Name: Test User" \
     -H "X-Forwarded-Email: test@example.com" \
     http://localhost:3000/api/auth/status

# Test with pure JWT (no headers required)
curl -H "Authorization: Bearer <jwt-token>" \
     http://localhost:3000/api/auth/status

# Test hybrid mode (headers + JWT)
curl -H "X-Forwarded-User: test@example.com" \
     -H "X-Forwarded-Groups: basic-users" \
     -H "Authorization: Bearer <jwt-with-enhanced-data>" \
     http://localhost:3000/api/auth/status

# Test JWT with specific claims
# JWT payload: {"sub":"user123","email":"john@example.com","groups":["admin"],"name":"John Doe"}
curl -H "Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9..." \
     http://localhost:3000/api/auth/status
```

### Local Mode Testing

```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \\
     -H "Content-Type: application/json" \\
     -d '{"username":"admin","password":"password123"}'

# Get user info
curl -H "Authorization: Bearer <token>" \\
     http://localhost:3000/api/auth/user

# Test filtered resources
curl -H "Authorization: Bearer <token>" \\
     http://localhost:3000/api/apps
```

### Configuration Testing

```bash
# Test platform config endpoint
curl http://localhost:3000/api/configs/platform | jq '.auth'

# Test with environment overrides
PROXY_AUTH_ENABLED=true \\
PROXY_AUTH_USER_HEADER=X-Custom-User \\
npm start
```

## Client Integration

### Authentication Context

```jsx
import { AuthProvider, useAuth } from './features/auth';

function App() {
  return (
    <AuthProvider>
      <YourAppComponents />
    </AuthProvider>
  );
}

function SomeComponent() {
  const { user, login, logout, isAuthenticated } = useAuth();

  if (isAuthenticated) {
    return <div>Welcome {user.name}!</div>;
  }

  return <LoginForm />;
}
```

### Authentication Guard

```jsx
import { AuthGuard } from './features/auth';

function ProtectedComponent() {
  return (
    <AuthGuard requireAuth={true}>
      <YourProtectedContent />
    </AuthGuard>
  );
}

function AdminComponent() {
  return (
    <AuthGuard requireAdmin={true}>
      <YourAdminContent />
    </AuthGuard>
  );
}
```

## Security Considerations

1. **JWT Secrets**: Use strong, unique secrets for JWT signing
2. **HTTPS**: Always use HTTPS in production
3. **Token Expiration**: Configure appropriate session timeouts
4. **Group Validation**: Validate group memberships server-side
5. **Password Hashing**: Uses bcrypt with user ID salt for unique hashes per user
   - Each password hash is unique even if users have the same password
   - Prevents rainbow table attacks and password hash copying between users
   - Uses bcrypt rounds 12+ for strong security

## Admin Authentication Security

**CRITICAL**: The admin authentication system enforces strict security based on authentication mode:

### Admin Secret Usage Rules

| Authentication Mode | Admin Secret    | Admin Access Method                          |
| ------------------- | --------------- | -------------------------------------------- |
| **Anonymous**       | ✅ **Required** | Admin secret is the only way to access admin |
| **Local**           | ❌ **Disabled** | Only authenticated users with admin groups   |
| **OIDC**            | ❌ **Disabled** | Only authenticated users with admin groups   |
| **Proxy**           | ❌ **Disabled** | Only authenticated users with admin groups   |

### Security Benefits

- **No Bypass Attacks**: Admin secret cannot be used to bypass proper authentication in local/OIDC/proxy modes
- **Mode-Specific Security**: Each authentication mode has appropriate security measures
- **Dynamic Admin Groups**: Admin groups are configurable without hardcoded frontend dependencies
- **Clear Error Messages**: Users receive appropriate guidance based on their authentication status

### Backend Security Implementation

The system automatically:

- Detects the current authentication mode
- Validates user groups against configured admin groups
- Rejects admin secret attempts in non-anonymous modes
- Provides clear error messages for unauthorized access attempts

### Frontend Integration

The admin UI automatically:

- Uses regular authentication tokens for admin users in authenticated modes
- Falls back to admin secret authentication only in anonymous mode
- Shows appropriate forms and error messages based on authentication context
- Handles authentication failures gracefully with proper redirects

## Troubleshooting

### Common Issues

1. **JWT Secret Not Set**
   - Error: "JWT secret not configured"
   - Solution: Set `JWT_SECRET` environment variable

2. **Token Expired**
   - Error: "JWT verification failed"
   - Solution: User needs to login again

3. **Missing Headers**
   - Error: User not authenticated in proxy mode
   - Solution: Check reverse proxy configuration

4. **Permission Denied**
   - Error: "Insufficient permissions"
   - Solution: Check user's group membership and permissions

### Debug Mode

Enable debug logging:

```bash
DEBUG=auth:* npm start
```

## Migration Guide

### From Admin-Only to Full Authentication

1. Update `platform.json` with auth configuration
2. Create group permissions and mapping files
3. Enable authentication mode
4. Update client to use AuthProvider
5. Test authentication flows

### Adding New Groups

1. Add group to `groupPermissions.json`
2. Map external groups in `groupMap.json`
3. Test resource filtering
4. Update client permissions checks

## Quick Start Scenarios

### Scenario 1: Default Setup (No Authentication)

**Goal**: Get started immediately with full functionality

```bash
# Just start the application - no configuration needed!
npm run dev
```

**Result**: All users have full access to all apps, models, and features

---

### Scenario 2: Restricted Anonymous Access

**Goal**: Allow anonymous access but limit which apps/models are available

1. Edit `contents/config/groups.json`:

```json
{
  "groups": {
    "anonymous": {
      "id": "anonymous",
      "name": "Anonymous",
      "description": "Access for unauthenticated users",
      "permissions": {
        "apps": ["chat", "translator", "summarizer"],
        "prompts": ["general"],
        "models": ["gemini-flash", "gpt-3.5-turbo"],
        "adminAccess": false
      },
      "mappings": ["anonymous"]
    }
  }
}
```

2. Restart the application

**Result**: Anonymous users only see specified apps and models

---

### Scenario 3: Enable Local Authentication

**Goal**: Add user accounts with different permission levels

1. Set environment variable:

```bash
export LOCAL_AUTH_ENABLED=true
export JWT_SECRET=your-secure-secret-key
```

2. Update `contents/config/platform.json`:

```json
{
  "auth": { "mode": "local" },
  "localAuth": { "enabled": true }
}
```

3. Start application and use demo accounts:
   - Admin: `admin` / `password123`
   - User: `user` / `password123`

**Result**: Login required, different access levels per user group

---

### Scenario 4: Corporate SSO Integration

**Goal**: Use existing corporate authentication

1. Configure reverse proxy (nginx, OAuth2 Proxy, etc.)
2. Update `contents/config/platform.json`:

```json
{
  "auth": { "mode": "proxy" },
  "proxyAuth": { "enabled": true }
}
```

3. Map corporate groups in `contents/config/groups.json` using the "mappings" arrays

**Result**: Users authenticate via corporate SSO, groups mapped to permissions

---

### Scenario 5: Disable Anonymous Access

**Goal**: Require authentication for all access

1. Update `contents/config/platform.json`:

```json
{
  "anonymousAuth": { "enabled": false },
  "authorization": { "anonymousAccess": false }
}
```

**Result**: All users must authenticate to access any features

## Examples

See `examples/authentication/` directory for:

- nginx proxy configuration
- Docker Compose setup with OAuth2 Proxy
- Kubernetes deployment with ingress auth
- Client integration examples
