# External Authentication Integration

This document explains how to configure and use the External Authentication Integration feature in AI Hub Apps.

## Overview

AI Hub Apps supports multiple authentication modes and is **fully functional without any authentication by default**:

### **Default Configuration (No Authentication Required)**
- **Anonymous Access**: Users can access all apps, models, and features without logging in
- **Zero Configuration**: Works out of the box with no setup required
- **Full Functionality**: All features available to anonymous users by default

### **Optional Authentication Modes**
- **Proxy Mode**: Authentication handled by reverse proxy or external service
- **Local Mode**: Built-in username/password authentication  
- **OIDC Mode**: OpenID Connect authentication (future implementation)

The system is designed to be stateless and flexible, supporting both authenticated and anonymous access based on your needs.

## Default Configuration (No Authentication)

**AI Hub Apps works perfectly without any authentication setup!** This is the default configuration:

```json
{
  "auth": {
    "mode": "proxy",
    "allowAnonymous": true,
    "anonymousGroup": "anonymous"
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

**To restrict anonymous access**, modify `contents/config/groupPermissions.json`:

```json
{
  "groups": {
    "anonymous": {
      "apps": ["chat", "translator"],
      "prompts": ["general"],
      "models": ["gemini-flash"],
      "adminAccess": false
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
    "mode": "proxy",
    "allowAnonymous": true,
    "anonymousGroup": "anonymous"
  },
  "proxyAuth": {
    "enabled": false,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups",
    "anonymousGroup": "anonymous",
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

### Group Permissions

Configure group-based permissions in `contents/config/groupPermissions.json`:

```json
{
  "groups": {
    "admin": {
      "apps": ["*"],
      "prompts": ["*"],
      "models": ["*"],
      "adminAccess": true,
      "description": "Full administrative access"
    },
    "user": {
      "apps": ["chat", "translator", "summarizer"],
      "prompts": ["general"],
      "models": ["gpt-3.5-turbo", "gemini-pro"],
      "adminAccess": false,
      "description": "Standard user access"
    },
    "anonymous": {
      "apps": ["chat"],
      "prompts": [],
      "models": ["gemini-flash"],
      "adminAccess": false,
      "description": "Anonymous user access"
    }
  }
}
```

### Group Mapping

Map external groups to internal groups in `contents/config/groupMap.json`:

```json
{
  "IT-Admin": ["admin"],
  "Users": ["user"],
  "Employees": ["user"],
  "Contractors": ["contractors"],
  "anonymous": ["anonymous"]
}
```

## Authentication Modes

### 1. Proxy Mode

Authentication is handled by a reverse proxy (nginx, Apache, OAuth2 Proxy, etc.).

**Configuration:**
```json
{
  "auth": { "mode": "proxy" },
  "proxyAuth": { "enabled": true }
}
```

**Headers Expected:**
- `X-Forwarded-User`: User identifier (email or username)
- `X-Forwarded-Groups`: Comma-separated list of groups
- `Authorization`: Bearer JWT token (optional)

**Example nginx configuration:**
```nginx
location / {
    proxy_pass http://ai-hub-apps:3000;
    proxy_set_header X-Forwarded-User $remote_user;
    proxy_set_header X-Forwarded-Groups "Users,Employees";
}
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

### 3. OIDC Mode (Future)

OpenID Connect authentication with external providers.

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
# Test with headers
curl -H "X-Forwarded-User: test@example.com" \\
     -H "X-Forwarded-Groups: admin,users" \\
     http://localhost:3000/api/auth/status

# Test with JWT
curl -H "Authorization: Bearer <jwt-token>" \\
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

1. Edit `contents/config/groupPermissions.json`:
```json
{
  "groups": {
    "anonymous": {
      "apps": ["chat", "translator", "summarizer"],
      "prompts": ["general"],
      "models": ["gemini-flash", "gpt-3.5-turbo"],
      "adminAccess": false
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

3. Map corporate groups in `contents/config/groupMap.json`

**Result**: Users authenticate via corporate SSO, groups mapped to permissions

---

### Scenario 5: Disable Anonymous Access
**Goal**: Require authentication for all access

1. Update `contents/config/platform.json`:
```json
{
  "auth": { "allowAnonymous": false },
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