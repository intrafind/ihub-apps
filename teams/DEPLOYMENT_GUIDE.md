# Microsoft Teams Integration - Deployment Guide

This guide walks you through deploying AI Hub Apps as a Microsoft Teams tab application with Single Sign-On (SSO) authentication.

## Prerequisites

- AI Hub Apps instance running on HTTPS (Teams requires secure connections)
- Azure AD tenant with admin privileges
- Teams admin access to upload custom applications
- Node.js installed for building the Teams package

## Step 1: Azure AD App Registration

### 1.1 Create App Registration

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure Active Directory** > **App registrations**
3. Click **New registration**
4. Configure:
   - **Name**: `AI Hub Apps Teams Integration`
   - **Supported account types**: `Accounts in this organizational directory only`
   - **Redirect URI**: Leave empty for now
5. Click **Register**
6. **Save the Application (client) ID** - you'll need this later

### 1.2 Configure Authentication

1. In your app registration, go to **Authentication**
2. Click **Add a platform** > **Single-page application**
3. Add redirect URI: `https://your-domain.com/teams/auth-end`
4. Enable **Access tokens** and **ID tokens**
5. Click **Configure**

### 1.3 Expose an API

1. Go to **Expose an API**
2. Click **Set** next to Application ID URI
3. Set to: `api://your-domain.com/{client-id}`
4. Click **Add a scope**:
   - **Scope name**: `access_as_user`
   - **Admin consent display name**: `Access AI Hub Apps as the user`
   - **Admin consent description**: `Allow Teams to access AI Hub Apps on behalf of the user`
   - **State**: `Enabled`
5. Click **Add scope**

### 1.4 API Permissions

1. Go to **API permissions**
2. Click **Add a permission** > **Microsoft Graph** > **Delegated permissions**
3. Add these permissions:
   - `User.Read`
   - `email`
   - `openid`
   - `profile`
4. Click **Grant admin consent** for your organization

### 1.5 Create Client Secret

1. Go to **Certificates & secrets**
2. Click **New client secret**
3. Add description: `AI Hub Apps Teams Integration`
4. Set expiration as needed
5. Click **Add**
6. **Copy the secret value** - you won't see it again

## Step 2: Configure AI Hub Apps

### 2.1 Update Platform Configuration

Update your `contents/config/platform.json`:

```json
{
  "authMode": "teams",
  "teamsAuth": {
    "enabled": true,
    "clientId": "your-azure-ad-client-id",
    "tenantId": "your-tenant-id",
    "domain": "your-domain.com",
    "validIssuers": [
      "https://login.microsoftonline.com/your-tenant-id/v2.0",
      "https://sts.windows.net/your-tenant-id/"
    ],
    "groupsAttribute": "groups",
    "defaultGroups": ["authenticated", "teams-users"]
  },
  "anonymousAuth": {
    "enabled": false
  },
  "oidcAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "azure-ad",
        "displayName": "Microsoft Azure AD",
        "clientId": "your-azure-ad-client-id",
        "clientSecret": "${AZURE_AD_CLIENT_SECRET}",
        "tenantId": "your-tenant-id",
        "authorizationURL": "https://login.microsoftonline.com/your-tenant-id/oauth2/v2.0/authorize",
        "tokenURL": "https://login.microsoftonline.com/your-tenant-id/oauth2/v2.0/token",
        "userInfoURL": "https://graph.microsoft.com/v1.0/me",
        "scope": ["openid", "profile", "email", "https://graph.microsoft.com/User.Read"],
        "callbackURL": "https://your-domain.com/api/auth/oidc/azure-ad/callback",
        "groupsAttribute": "groups",
        "defaultGroups": ["authenticated", "azure-users"],
        "pkce": true
      }
    ]
  }
}
```

### 2.2 Set Environment Variables

Add to your environment configuration:

```bash
AZURE_AD_CLIENT_SECRET=your-client-secret-from-step-1.5
```

### 2.3 Update Groups Configuration

Update `contents/config/groups.json` to include Teams users:

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Admin",
      "description": "Full administrative access",
      "inherits": ["teams-users"],
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Global Admins", "IT-Admin"]
    },
    "teams-users": {
      "id": "teams-users",
      "name": "Teams Users",
      "description": "Standard Teams users",
      "inherits": ["authenticated"],
      "permissions": {
        "apps": ["chat", "summarizer", "translator"],
        "prompts": ["*"],
        "models": ["gpt-4", "claude-sonnet"]
      }
    },
    "authenticated": {
      "id": "authenticated",
      "name": "Authenticated Users",
      "description": "All authenticated users",
      "permissions": {
        "apps": ["chat"],
        "prompts": [],
        "models": ["gpt-3.5-turbo"]
      }
    }
  }
}
```

## Step 3: Build Teams App Package

### 3.1 Prepare Icons

1. Create or obtain your app icons:
   - **color.png**: 192x192 pixels, full color with transparent background
   - **outline.png**: 32x32 pixels, monochrome outline with transparent background
2. Place them in `teams/icons/` directory

### 3.2 Build Package

Run the build script:

```bash
cd teams/
./build-teams-package.sh
```

Follow the prompts to enter:

- Teams App ID (generate a new GUID)
- Your AI Hub Apps URL
- Azure AD Client ID

The script will create `teams/build/ai-hub-apps-teams.zip`

### 3.3 Manual Package Creation (Alternative)

If the script doesn't work, create manually:

1. Copy `manifest.json` to `manifest.configured.json`
2. Replace placeholders with your values:
   - `{{TEAMS_APP_ID}}`: New GUID (use online generator)
   - `{{APP_URL}}`: Your AI Hub Apps URL
   - `{{VALID_DOMAIN}}`: Your domain without https://
   - `{{AAD_CLIENT_ID}}`: Your Azure AD client ID
3. Create ZIP with: `manifest.json`, `color.png`, `outline.png`

## Step 4: Deploy to Microsoft Teams

### 4.1 Upload via Teams Admin Center

1. Go to [Teams Admin Center](https://admin.teams.microsoft.com)
2. Navigate to **Teams apps** > **Manage apps**
3. Click **Upload new app** > **Upload**
4. Select your `ai-hub-apps-teams.zip` file
5. Click **Open**

### 4.2 Upload via Teams Client (Sideloading)

1. In Teams, go to **Apps**
2. Click **Upload a custom app** (bottom left)
3. Select **Upload for [your organization]**
4. Choose your ZIP file
5. Click **Add**

### 4.3 Configure App Permissions

1. In Teams Admin Center, find your uploaded app
2. Set appropriate policies:
   - **App permission policy**: Allow custom apps
   - **App setup policy**: Pin app if desired
3. Assign to users/groups as needed

## Step 5: Install and Test

### 5.1 Install App

1. In Teams, go to **Apps**
2. Search for "AI Hub Apps"
3. Click **Add**
4. The app will open as a personal tab

### 5.2 Test Authentication

1. App should automatically attempt SSO
2. If consent is required, complete the consent flow
3. Verify you're logged in and can access AI Hub Apps features
4. Test different apps based on your permissions

## Step 6: Production Considerations

### 6.1 Security

- Use HTTPS for all endpoints
- Regularly rotate client secrets
- Monitor authentication logs
- Review and audit permissions

### 6.2 Monitoring

- Set up logging for Teams authentication events
- Monitor API usage and performance
- Track user adoption and usage patterns

### 6.3 Maintenance

- Keep Teams SDK updated
- Monitor for Azure AD changes
- Update app manifest as needed
- Regular security reviews

## Troubleshooting

### Common Issues

1. **"App not found" error**
   - Check manifest formatting
   - Verify app ID is correct
   - Ensure app is approved in admin center

2. **Authentication fails**
   - Check Azure AD configuration
   - Verify redirect URIs match
   - Check client secret hasn't expired

3. **Permission denied**
   - Review groups configuration
   - Check user group memberships
   - Verify app permissions in manifest

4. **App doesn't load**
   - Check HTTPS certificate is valid
   - Verify domain is in valid domains list
   - Check server logs for errors

### Logs to Check

- AI Hub Apps server logs
- Azure AD sign-in logs
- Teams admin center app logs
- Browser developer console

### Support

For additional support:

1. Check the main AI Hub Apps documentation
2. Review Teams development documentation
3. Check Azure AD troubleshooting guides
4. Contact your IT administrator for organization-specific issues

## Advanced Configuration

### Custom Branding

Update the manifest to customize:

- App name and description
- Color scheme (accentColor)
- Additional metadata

### Bot Integration (Future)

The current implementation focuses on tab functionality. Bot capabilities can be added later by:

- Registering a bot in Azure
- Adding bot configuration to manifest
- Implementing bot message handlers

### Message Extensions (Future)

Add message extension capabilities by:

- Configuring compose extensions in manifest
- Implementing message extension handlers
- Adding search and action commands
