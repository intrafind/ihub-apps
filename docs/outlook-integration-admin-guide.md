# Outlook Integration for Administrators

## Overview

The Outlook Add-in integration for iHub Apps enables your users to access AI-powered features directly within Outlook for Mac. This guide covers everything administrators need to know to deploy and manage this integration.

## Features

The Outlook Add-in provides:

- **Email Summarization**: AI-powered email summaries using the iHub summarizer app
- **Reply Generation**: Professional email responses using the email-composer app
- **Attachment Analysis**: Intelligent analysis of email attachments
- **Streaming Responses**: Real-time AI responses displayed in Outlook
- **Auto-Configuration**: Automatic server URL detection, no manual setup required

## Prerequisites

### Server Requirements

1. **iHub Apps Server**
   - Version: 4.2.0 or later
   - HTTPS enabled (required by Office Add-ins)
   - Admin access to the iHub instance

2. **Outlook for Mac**
   - Version 16.0 or later
   - Users must have permission to install custom add-ins

3. **Network Requirements**
   - HTTPS connection to iHub server
   - Office Add-in domains accessible for loading Office.js library

### Required Apps

The following iHub apps must be enabled:

1. **summarizer** - For email summarization
   - Location: `examples/apps/summarizer.json`
   - Copy to your active apps directory

2. **email-composer** - For reply generation
   - Location: `examples/apps/email-composer.json`
   - Copy to your active apps directory

## Deployment Steps

### Step 1: Access the Admin Panel

1. Log in to your iHub Apps instance as an administrator
2. Navigate to **Admin** from the main menu
3. Click on **Integrations**

You should see the "Outlook Add-in for Mac" section with:
- Current configuration details
- Available features
- Installation instructions
- Download button for the manifest file

### Step 2: Verify Server Configuration

Before distributing the add-in, verify your server configuration:

#### A. Check CORS Settings

Ensure Office Add-in domains are allowed in your CORS configuration.

**File**: `contents/config/platform.json`

```json
{
  "cors": {
    "origin": [
      "https://outlook.office.com",
      "https://outlook.office365.com",
      "https://outlook.live.com",
      "https://your-ihub-server.com"
    ],
    "credentials": true,
    "allowedHeaders": [
      "Content-Type",
      "Authorization",
      "X-Requested-With"
    ]
  }
}
```

**Note**: If you make changes to `platform.json`, restart the iHub server:

```bash
# If using systemd
sudo systemctl restart ihub-apps

# If running manually
# Stop the server (Ctrl+C) and restart
npm run start:prod
```

#### B. Verify Required Apps

Check that the required apps are enabled in your admin panel:

1. Go to **Admin** → **Apps**
2. Verify these apps are present and enabled:
   - **Content Summarizer** (summarizer)
   - **Email Composer** (email-composer)

If they're missing, copy them from the examples directory:

```bash
cp examples/apps/summarizer.json contents/apps/
cp examples/apps/email-composer.json contents/apps/
```

The server will automatically detect the new apps (no restart needed).

### Step 3: Download the Manifest File

The manifest file is dynamically generated with your server's correct URLs.

**In the Admin → Integrations page:**

1. Click the **Download Manifest** button
2. The file `ihub-outlook-manifest.xml` will be downloaded
3. Save this file in a secure location

**Important**: The manifest contains your server's URL and is customized for your installation. Do not modify this file manually.

### Step 4: Distribute to Users

You have two options for distributing the add-in to users:

#### Option A: Manual Distribution (Recommended for Testing)

1. Send the `ihub-outlook-manifest.xml` file to users
2. Provide installation instructions (see User Installation Guide below)
3. Users install individually on their Macs

**Pros**: Simple, quick for small teams
**Cons**: Each user must install manually

#### Option B: Centralized Deployment (Office 365)

For Office 365 organizations, you can deploy centrally:

1. Go to **Microsoft 365 Admin Center**
2. Navigate to **Settings** → **Integrated apps**
3. Click **Upload custom apps**
4. Upload the `ihub-outlook-manifest.xml` file
5. Configure deployment settings:
   - Select users or groups
   - Set deployment as optional or required
   - Schedule deployment
6. Deploy the add-in

**Pros**: Centralized management, automatic deployment
**Cons**: Requires Office 365 admin rights

## User Installation Guide

Provide these instructions to your users:

### Installing the Add-in

1. **Receive the Manifest File**
   - Download `ihub-outlook-manifest.xml` from your administrator

2. **Open Outlook for Mac**
   - Launch Outlook for Mac (version 16.0 or later)

3. **Access Add-ins**
   - Click **Get Add-ins** from the Home ribbon
   - Select **My Add-ins** in the left sidebar

4. **Install Custom Add-in**
   - Click **Add a Custom Add-in** → **Add from File...**
   - Browse and select `ihub-outlook-manifest.xml`
   - Click **Install**

5. **Verify Installation**
   - Look for two new buttons in the Outlook ribbon:
     - **Summarize Email**
     - **Generate Reply**
   - If the buttons don't appear, restart Outlook

### Using the Add-in

**To Summarize an Email:**
1. Open any email in Outlook
2. Click **Summarize Email** in the ribbon
3. The task pane opens and displays a summary
4. Click **Copy to Clipboard** to use the summary

**To Generate a Reply:**
1. Open an email you want to reply to
2. Click **Generate Reply** in the ribbon
3. The task pane displays a generated response
4. Copy the reply and paste into your email

## Authentication

The Outlook Add-in uses your iHub server's existing authentication:

- **Authentication Type**: Server-side authentication
- **How it Works**: The add-in sends requests to your iHub server using the same authentication mechanism as the web application
- **Security**: Email content is transmitted securely via HTTPS to your server
- **Data Privacy**: No email content is permanently stored on the server

### Authentication Configuration

No additional authentication setup is required. The add-in automatically uses:

- Session-based authentication (if configured)
- JWT authentication (if configured)
- Anonymous access (if allowed by server configuration)

**Important**: Ensure your iHub server has proper authentication configured before deploying the add-in.

## Monitoring and Support

### Checking Add-in Usage

Currently, there's no built-in usage tracking for the Outlook add-in. Monitor general API usage:

1. Go to **Admin** → **Usage Reports**
2. Look for activity from the `summarizer` and `email-composer` apps
3. Check server logs for API requests

### Server Logs

Monitor add-in activity in server logs:

```bash
# View live logs
tail -f server/server.log

# Filter for Outlook-related requests
grep "outlook" server/server.log
grep "/api/chat/sessions/summarizer" server/server.log
grep "/api/chat/sessions/email-composer" server/server.log
```

### Common Issues and Solutions

#### Issue: Add-in doesn't appear in Outlook

**Solutions:**
1. Verify user is using Outlook for Mac 16.0 or later
2. Check that manifest file was downloaded correctly
3. Try removing and re-adding the add-in
4. Restart Outlook for Mac

#### Issue: "Connection Error" in task pane

**Solutions:**
1. Verify iHub server is running and accessible via HTTPS
2. Check CORS configuration in `platform.json`
3. Verify user can access iHub web interface
4. Check server logs for authentication errors

#### Issue: Summarization/Reply generation fails

**Solutions:**
1. Verify `summarizer` and `email-composer` apps are enabled
2. Check that AI model (OpenAI, Anthropic, etc.) is configured
3. Verify API keys are valid
4. Check server logs for errors

#### Issue: Slow or no streaming response

**Solutions:**
1. Verify SSE (Server-Sent Events) support in your server
2. Check network connectivity and firewalls
3. Test with a shorter email
4. Review server performance and resources

## Updating the Add-in

When you update your iHub server or need to redistribute the add-in:

### Minor Updates (No User Action Needed)

If only the task pane UI or functionality changes:

1. Deploy the updated iHub server
2. Users automatically get updates when they open the add-in

### Major Updates (Requires Redistribution)

If the manifest changes (new permissions, features, etc.):

1. Download the new manifest from **Admin** → **Integrations**
2. Redistribute to users following the same installation process
3. Users must remove the old add-in and install the new one

**Steps for users to update:**
1. In Outlook: Get Add-ins → My Add-ins
2. Find "iHub Apps - AI Assistant"
3. Click the three dots (...) → Remove
4. Install the new manifest file

## Security Considerations

### Data Privacy

- **Email Content**: Email text is sent to your iHub server for AI processing
- **Transmission**: All data is encrypted in transit via HTTPS
- **Storage**: No email content is permanently stored on the server
- **Processing**: AI models (OpenAI, Anthropic, etc.) may process the content according to their privacy policies

### Recommendations

1. **Review Privacy Policies**: Ensure your AI provider's privacy policy is acceptable
2. **User Training**: Inform users about what data is sent to the server
3. **Sensitive Emails**: Advise users not to use AI features on highly sensitive emails
4. **Compliance**: Ensure usage complies with your organization's data policies (GDPR, HIPAA, etc.)

### Access Control

Configure access control in your iHub server:

1. **Group Permissions**: Use iHub's group system to control who can use which apps
2. **Anonymous Access**: Disable if you want to require authentication
3. **Rate Limiting**: Configure rate limits to prevent abuse

## Troubleshooting

### Diagnostic Commands

**Check server is running:**
```bash
curl https://your-ihub-server.com/api/health
```

**Check Outlook files are accessible:**
```bash
curl https://your-ihub-server.com/outlook/taskpane.html
```

**Test manifest generation:**
```bash
curl -u admin:password https://your-ihub-server.com/api/integrations/outlook/manifest.xml
```

**Check integration info:**
```bash
curl https://your-ihub-server.com/api/integrations/outlook/info
```

### Getting Help

1. **Review Logs**: Check `server/server.log` for errors
2. **Admin Panel**: Use Admin → Integrations for current status
3. **Documentation**: See the User Guide in the iHub help pages
4. **Support**: Contact your iHub support team

## Best Practices

1. **Test First**: Install and test the add-in yourself before distributing
2. **Gradual Rollout**: Deploy to a small group first, then expand
3. **User Training**: Provide training on how to use the AI features
4. **Feedback Loop**: Collect user feedback and address issues
5. **Monitor Usage**: Track usage to understand adoption and value
6. **Regular Updates**: Keep iHub server updated for latest features and fixes

## FAQ

**Q: Can this work on Windows or Web Outlook?**
A: The manifest is configured for desktop clients. It may work on Windows and Web with minor adjustments to the manifest, but has only been tested on Mac.

**Q: How many users can use this simultaneously?**
A: Limited only by your iHub server capacity and AI provider rate limits.

**Q: Can I customize which apps are available?**
A: Currently, the add-in uses `summarizer` and `email-composer` apps. Code changes would be needed to add more apps.

**Q: Is internet connection required?**
A: Yes, the add-in needs to connect to your iHub server, which needs internet to access AI providers.

**Q: Can users work offline?**
A: No, the add-in requires a connection to your iHub server.

**Q: How is this different from Microsoft's built-in AI?**
A: This uses your organization's iHub Apps server and AI configuration, giving you full control over data, prompts, and AI models.

## Additional Resources

- **User Documentation**: `outlook/README.md`
- **Technical Details**: `concepts/2026-01-21 Office Integration for Outlook on Mac.md`
- **iHub Documentation**: Available at `https://your-ihub-server.com/page/help`
- **Microsoft Office Add-ins**: https://docs.microsoft.com/office/dev/add-ins/

## Appendix: Configuration Reference

### Environment Variables

No special environment variables are required for the Outlook integration. It uses standard iHub configuration.

### File Locations

- **Add-in Files**: `outlook/` directory (auto-deployed to `dist/public/outlook/`)
- **Manifest Template**: `outlook/manifest.xml` (reference only)
- **Server Routes**: `server/routes/integrations/outlook.js`
- **Admin UI**: `client/src/features/admin/pages/IntegrationsPage.jsx`

### API Endpoints

- **GET `/api/integrations/outlook/manifest.xml`** - Download configured manifest (requires auth)
- **GET `/api/integrations/outlook/info`** - Get integration information (public)
- **POST `/api/chat/sessions/summarizer`** - Email summarization endpoint
- **POST `/api/chat/sessions/email-composer`** - Reply generation endpoint

---

**Document Version**: 1.0  
**Last Updated**: January 2026  
**For**: iHub Apps 4.2.0+
