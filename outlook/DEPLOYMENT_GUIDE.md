# Deployment Guide for Outlook Integration

## Quick Start

The Outlook Add-in for iHub Apps is now managed through the **Admin → Integrations** panel. This guide provides a quick overview of the deployment process.

**For comprehensive admin documentation, see: `docs/outlook-integration-admin-guide.md`**

## Overview

The Outlook integration is automatically deployed with your iHub Apps server and provides:

- Dynamic manifest generation with correct URLs
- Admin panel for easy distribution
- Automatic configuration for end users

## Prerequisites

1. **iHub Apps Server**
   - Version 4.2.0 or later
   - HTTPS enabled (required by Office Add-ins)
   - Admin access

2. **Outlook for Mac**
   - Version 16.0 or later for end users

3. **Required Apps**
   - `summarizer` app enabled
   - `email-composer` app enabled

## Deployment Steps

### 1. Server Deployment

The Outlook integration is automatically included in production builds:

```bash
npm run prod:build
```

Files are deployed to: `dist/public/outlook/`

The following endpoints are automatically available:

- `GET /api/integrations/outlook/manifest.xml` - Dynamically generated manifest
- `GET /api/integrations/outlook/info` - Integration information
- Static files at `/outlook/` (taskpane.html, taskpane.js, etc.)

### 2. Access Admin Panel

1. Log in to iHub Apps as administrator
2. Navigate to **Admin** → **Integrations**
3. Find the "Outlook Add-in for Mac" section

### 3. Download Manifest

In the Admin → Integrations page:

1. Click **Download Manifest**
2. Save the `ihub-outlook-manifest.xml` file
3. Distribute to users

**Important**: The manifest is dynamically generated with your server's URLs - no manual configuration needed!

### 4. Verify Configuration

Before distributing, verify:

#### CORS Configuration

Check `contents/config/platform.json` includes Office domains:

```json
{
  "cors": {
    "origin": [
      "https://outlook.office.com",
      "https://outlook.office365.com",
      "https://outlook.live.com",
      "https://your-ihub-server.com"
    ],
    "credentials": true
  }
}
```

**Note**: Restart server after modifying `platform.json`

#### Required Apps

Verify in **Admin** → **Apps**:

- ✅ Content Summarizer (summarizer)
- ✅ Email Composer (email-composer)

If missing, copy from examples:

```bash
cp examples/apps/summarizer.json contents/apps/
cp examples/apps/email-composer.json contents/apps/
```

### 5. Distribute to Users

**Option A: Manual Distribution**

1. Send `ihub-outlook-manifest.xml` to users
2. Provide installation instructions

**Option B: Centralized (Office 365)**

1. Upload manifest to Microsoft 365 Admin Center
2. Deploy to users/groups automatically

## User Installation

Users install the add-in by:

1. Opening Outlook for Mac
2. Going to **Get Add-ins** → **My Add-ins**
3. Clicking **Add a Custom Add-in** → **Add from File**
4. Selecting the `ihub-outlook-manifest.xml` file

The add-in appears as two ribbon buttons:

- **Summarize Email**
- **Generate Reply**

## Features

- **Auto-Configuration**: Add-in automatically detects server URL
- **Email Summarization**: AI-powered summaries
- **Reply Generation**: Professional responses
- **Attachment Analysis**: Intelligent attachment insights
- **Streaming Responses**: Real-time AI output

## Authentication

The add-in uses **server-side authentication**:

- Same authentication as main iHub app
- No separate configuration needed
- Email content sent via authenticated HTTPS requests

## Monitoring

Monitor usage through:

- **Admin** → **Usage Reports** (summarizer and email-composer apps)
- Server logs: `tail -f server/server.log`

## Troubleshooting

### Add-in doesn't appear

- Verify Outlook for Mac 16.0+
- Try removing and reinstalling
- Restart Outlook

### Connection errors

- Check HTTPS is enabled
- Verify CORS configuration
- Check server logs

### Summarization fails

- Verify apps are enabled
- Check AI model configuration
- Review server logs

## Updating

**Minor updates** (UI/functionality): Automatic when server updates

**Major updates** (manifest changes):

1. Download new manifest from Admin panel
2. Redistribute to users
3. Users reinstall the add-in

## Getting Help

1. **Comprehensive Admin Guide**: See `docs/outlook-integration-admin-guide.md`
2. **User Documentation**: See `outlook/README.md`
3. **Technical Details**: See `concepts/2026-01-21 Office Integration for Outlook on Mac.md`
4. **Server Logs**: Check `server/server.log` for errors

## API Endpoints Reference

- **`GET /api/integrations/outlook/manifest.xml`**
  - Generates manifest with correct URLs
  - Requires authentication
  - Downloads as `ihub-outlook-manifest.xml`

- **`GET /api/integrations/outlook/info`**
  - Returns integration configuration
  - Public endpoint
  - Includes features, URLs, instructions

- **POST `/api/chat/sessions/summarizer`**
  - Email summarization
  - Requires authentication

- **POST `/api/chat/sessions/email-composer`**
  - Reply generation
  - Requires authentication

## Security Considerations

1. **HTTPS Required**: Office Add-ins mandate HTTPS
2. **Data Privacy**: Email content sent to server for processing
3. **Authentication**: Uses existing iHub authentication
4. **No Permanent Storage**: Email content not stored
5. **CORS**: Configure properly to allow Office domains

## Best Practices

1. ✅ Test yourself before distributing
2. ✅ Start with a small user group
3. ✅ Provide user training
4. ✅ Monitor usage and feedback
5. ✅ Keep server updated

## Additional Resources

- **Admin Panel**: Navigate to Admin → Integrations for current status
- **Full Admin Guide**: `docs/outlook-integration-admin-guide.md`
- **User Guide**: `outlook/README.md`
- **Architecture**: `concepts/2026-01-21 Office Integration for Outlook on Mac.md`

---

**For detailed administrative documentation, troubleshooting, and best practices, refer to:**
**`docs/outlook-integration-admin-guide.md`**
