# Microsoft Teams Integration Configuration Guide

This guide provides step-by-step instructions for setting up Microsoft Teams integration with AI Hub Apps.

## Overview

The Teams integration provides three main capabilities:

1. **Teams Bot** - Conversational interface for AI Hub Apps
2. **Teams Tab** - Embedded web interface in Teams
3. **Message Extensions** - Context menu actions for processing messages

## Prerequisites

- Microsoft Azure subscription with bot registration capabilities
- AI Hub Apps server deployed and accessible from the internet
- Microsoft Teams admin access for app installation
- SSL certificate (required for Teams integration)

## Step 1: Azure Bot Service Setup

### 1.1 Create Bot Registration

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to "Create a resource" > "AI + Machine Learning" > "Bot"
3. Click "Create" and fill out:
   - **Bot handle**: `aihubapps-bot` (must be globally unique)
   - **Subscription**: Your Azure subscription
   - **Resource Group**: Create new or use existing
   - **Pricing tier**: F0 (free) for testing, S1 for production
   - **Bot template**: "Echo Bot" (we'll customize this)

### 1.2 Configure Bot Channels

1. After creation, go to your bot resource
2. Navigate to "Channels" in the left sidebar
3. Click on "Microsoft Teams" channel
4. Enable the channel and note the configuration

### 1.3 Get Bot Credentials

1. In your bot resource, go to "Configuration"
2. Note the **Microsoft App ID** (this is your `TEAMS_APP_ID`)
3. Click "Manage" next to Microsoft App ID
4. Go to "Certificates & secrets"
5. Create a new client secret and save the value (this is your `TEAMS_APP_PASSWORD`)

**⚠️ Important**: Save the client secret value immediately - it won't be shown again!

## Step 2: Environment Configuration

### 2.1 Server Environment Variables

Add these environment variables to your AI Hub Apps server:

```bash
# Teams Integration
TEAMS_APP_ID=your-microsoft-app-id-here
TEAMS_APP_PASSWORD=your-client-secret-here

# Domain (required for Teams manifest)
DOMAIN_NAME=your-domain.com
```

### 2.2 Azure Bot Configuration

1. Return to Azure Portal > Your Bot > Configuration
2. Set **Messaging endpoint**: `https://your-domain.com/api/teams/messages`
3. Click "Apply" to save

## Step 3: Teams App Manifest

### 3.1 Prepare Manifest Files

1. Navigate to the `/teams` directory in your AI Hub Apps installation
2. Edit `manifest.json`:
   - Replace `{{TEAMS_APP_ID}}` with your actual Microsoft App ID
   - Replace `{{DOMAIN_NAME}}` with your domain (e.g., `aihub.example.com`)
   - Update developer information and URLs

### 3.2 Create App Icons

Create two icon files in the `/teams` directory:

- **`color-icon.png`** - 192x192 pixels, full color app icon
- **`outline-icon.png`** - 32x32 pixels, transparent outline icon

### 3.3 Package Teams App

1. Create a ZIP file containing:
   - `manifest.json`
   - `color-icon.png`
   - `outline-icon.png`
2. Name the file `ai-hub-apps-teams.zip`

## Step 4: Teams App Installation

### 4.1 Upload to Teams Admin Center

1. Go to [Microsoft Teams Admin Center](https://admin.teams.microsoft.com)
2. Navigate to "Teams apps" > "Manage apps"
3. Click "Upload new app"
4. Upload your `ai-hub-apps-teams.zip` file
5. Set permissions and availability as needed

### 4.2 Install for Users

**Option A: Admin Installation**

1. In Teams Admin Center, find your app
2. Click "..." > "Available to everyone" (or specific users/groups)

**Option B: Sideloading (Development)**

1. In Teams, go to "Apps"
2. Click "Upload a custom app" (requires sideloading permissions)
3. Upload your ZIP file

## Step 5: Verification and Testing

### 5.1 Test Bot Functionality

1. In Teams, search for "AI Hub Apps" in the Apps section
2. Click "Add" to install the bot
3. Send a test message: "Help me translate this text to German"
4. Verify the bot responds with appropriate AI assistance

### 5.2 Test Tab Integration

1. Add the AI Hub Apps tab to a team channel
2. Verify the web interface loads correctly within Teams
3. Test authentication flow

### 5.3 Test Message Extensions

1. Right-click on any message in Teams
2. Look for "AI Hub Apps" in the context menu
3. Test actions like "Summarize", "Translate", "Analyze"

## Step 6: Authentication Integration

The Teams integration automatically leverages your existing Microsoft OAuth configuration from `platform.json`. Users are authenticated using their Teams/Entra credentials.

### Verify Authentication Setup

Check your `contents/config/platform.json` contains:

```json
{
  "auth": {
    "provider": "oidc",
    "oidc": {
      "issuer": "https://login.microsoftonline.com/YOUR_TENANT_ID/v2.0",
      "clientId": "YOUR_CLIENT_ID",
      "clientSecret": "YOUR_CLIENT_SECRET"
    }
  }
}
```

## Troubleshooting

### Common Issues

**1. Bot not responding**

- Check server logs for errors
- Verify `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` are correct
- Ensure messaging endpoint is accessible from Azure

**2. Authentication issues**

- Verify Microsoft OAuth configuration in platform.json
- Check user groups and permissions
- Ensure SSL certificate is valid

**3. Message extensions not working**

- Verify manifest.json has correct message extension commands
- Check server endpoint `/api/teams/messages` is responding
- Review Azure bot channel configuration

**4. Tab not loading**

- Check CORS configuration in server
- Verify domain is accessible
- Test direct URL access: `https://your-domain.com/?teams=true`

### Debug Commands

**Check server status:**

```bash
curl https://your-domain.com/api/health
```

**Test Teams endpoint:**

```bash
curl -X POST https://your-domain.com/api/teams/messages
```

**View server logs:**

```bash
# Docker
docker logs your-container-name

# PM2
pm2 logs

# Direct
tail -f /var/log/aihubapps.log
```

## Advanced Configuration

### Custom Intent Mapping

Edit `/server/teamsBot.js` to customize how user messages map to AI Hub Apps:

```javascript
const intentMap = {
  translate: ['translator', 'translation-assistant'],
  summarize: ['summarizer', 'document-summarizer']
  // Add your custom mappings
};
```

### Message Extension Commands

Add new message extension commands in `/teams/manifest.json`:

```json
{
  "id": "your-command",
  "type": "action",
  "title": "Your Command",
  "description": "Description of what this command does",
  "context": ["message"]
}
```

Then handle the command in `/server/teamsMessageExtension.js`.

### Teams-Specific Styling

The client automatically detects Teams context via the `?teams=true` URL parameter and can apply Teams-specific styling.

## Security Considerations

- Always use HTTPS in production
- Store bot credentials securely (environment variables, not in code)
- Implement proper user authentication and authorization
- Regularly rotate bot client secrets
- Monitor bot usage and implement rate limiting if needed

## Production Deployment

- Use a robust SSL certificate (not self-signed)
- Implement proper logging and monitoring
- Set up health checks for the bot endpoint
- Consider load balancing for high availability
- Backup bot configuration and credentials securely

## Support

For technical issues with:

- **Azure Bot Service**: Contact Microsoft Azure Support
- **Teams Integration**: Check Microsoft Teams developer documentation
- **AI Hub Apps**: Review server logs and configuration files

## Resources

- [Microsoft Teams App Documentation](https://docs.microsoft.com/en-us/microsoftteams/platform/)
- [Bot Framework Documentation](https://docs.microsoft.com/en-us/azure/bot-service/)
- [Teams App Manifest Reference](https://docs.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
