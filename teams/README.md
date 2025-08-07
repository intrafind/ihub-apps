# Microsoft Teams Integration

This directory contains the Microsoft Teams app package for iHub Apps.

## Setup Instructions

### 1. Prerequisites

- Azure AD app registration with Teams SSO configured
- iHub Apps instance accessible from Teams (HTTPS required)
- Teams admin permissions to upload custom apps

### 2. Configuration

1. Copy `manifest.json` to `manifest.configured.json`
2. Replace the following placeholders in `manifest.configured.json`:
   - `{{TEAMS_APP_ID}}`: Generate a new GUID for your Teams app
   - `{{APP_URL}}`: Your iHub Apps URL (e.g., https://ihub.company.com)
   - `{{VALID_DOMAIN}}`: Your domain without protocol (e.g., ihub.company.com)
   - `{{AAD_CLIENT_ID}}`: Your Azure AD app client ID

3. Add icon files:
   - `color.png`: 192x192px color icon
   - `outline.png`: 32x32px outline icon

### 3. Package Creation

1. Create a zip file containing:
   - `manifest.configured.json` (renamed to `manifest.json`)
   - `color.png`
   - `outline.png`

```bash
zip -r ihub-apps-teams.zip manifest.json color.png outline.png
```

### 4. Azure AD Configuration

1. In Azure Portal, navigate to your app registration
2. Under "Expose an API", add:
   - Application ID URI: `api://your-domain.com/{client-id}`
   - Scope: `access_as_user`
3. Under "API Permissions", add:
   - Microsoft Graph > Delegated > `User.Read`
   - Microsoft Graph > Delegated > `email`
   - Microsoft Graph > Delegated > `openid`
   - Microsoft Graph > Delegated > `profile`
4. Under "Authentication", add:
   - Platform: Single-page application
   - Redirect URI: `https://your-domain.com/teams/auth-end`

### 5. iHub Apps Configuration

Add Teams authentication to your `platform.json`:

```json
{
  "teamsAuth": {
    "enabled": true,
    "clientId": "your-aad-client-id",
    "tenantId": "your-tenant-id",
    "validIssuers": [
      "https://login.microsoftonline.com/{tenant-id}/v2.0",
      "https://sts.windows.net/{tenant-id}/"
    ]
  }
}
```

### 6. Upload to Teams

1. In Teams Admin Center or Teams client
2. Upload the `ihub-apps-teams.zip` package
3. Install for your organization or specific users

## Development

For local development with Teams:

1. Use ngrok or similar to expose your local instance
2. Update manifest with ngrok URL
3. Enable Teams development mode

## Troubleshooting

- Ensure HTTPS is enabled (Teams requires secure connections)
- Check browser console for SSO errors
- Verify Azure AD permissions are granted
- Confirm domain is listed in valid domains
