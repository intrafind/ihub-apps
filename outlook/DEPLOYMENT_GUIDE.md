# Deployment Guide for Office Integration

## Overview

This guide covers deploying the Outlook Add-in integration for iHub Apps on Mac.

## Prerequisites

- iHub Apps server running with HTTPS enabled
- Outlook for Mac (version 16.0 or later)  
- Web server access to host the add-in files

## Deployment Steps

### 1. Server Deployment

The add-in files need to be accessible via HTTPS on your iHub server.

#### Option A: Automatic Deployment (Recommended)

The production build process automatically includes the Outlook integration:

```bash
npm run prod:build
```

The Outlook files will be available at:
- `dist/public/outlook/manifest.xml`
- `dist/public/outlook/taskpane.html`
- `dist/public/outlook/commands.html`
- `dist/public/outlook/src/taskpane.js`

#### Option B: Manual Deployment

1. Copy the `outlook/` directory to your web server's public directory
2. Ensure files are accessible at `https://your-ihub-server.com/outlook/`

### 2. Configure the Manifest

Edit `outlook/manifest.xml` and replace all `{{APP_URL}}` placeholders:

```bash
# Using sed (Linux/Mac)
sed -i 's/{{APP_URL}}/https:\/\/your-ihub-server.com/g' outlook/manifest.xml

# Or manually edit the file
```

### 3. Update Server CORS Configuration

Add Office Add-in domains to your CORS configuration in `contents/config/platform.json`:

```json
{
  "cors": {
    "origin": [
      "https://outlook.office.com",
      "https://outlook.office365.com", 
      "https://outlook.live.com",
      "https://your-ihub-server.com",
      "${ALLOWED_ORIGINS}"
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

Restart your server after updating the configuration.

### 4. Enable Required Apps

Ensure the following apps are enabled on your server:

1. Copy `examples/apps/summarizer.json` to your active apps directory
2. Copy `examples/apps/email-composer.json` to your active apps directory

### 5. Test Server Accessibility

Verify the add-in files are accessible:

```bash
curl https://your-ihub-server.com/outlook/taskpane.html
curl https://your-ihub-server.com/outlook/manifest.xml
```

## Client Installation

### Installing on Outlook for Mac

1. Open Outlook for Mac
2. Click **Get Add-ins** from the Home ribbon
3. Select **My Add-ins** in the left sidebar
4. Click **Add a Custom Add-in** → **Add from File...**
5. Browse and select the `manifest.xml` file
6. Click **Install**

### Verification

1. Open any email in Outlook
2. Look for "iHub AI" buttons in the ribbon
3. Click "Summarize Email" to test
4. Enter your iHub server URL in the configuration field
5. Verify the summary is generated

## Distribution to Users

### Option 1: Manual Distribution

1. Share the configured `manifest.xml` file with users
2. Provide installation instructions (see Client Installation above)
3. Users install individually on their Macs

### Option 2: Centralized Deployment (Office 365)

For Office 365 organizations:

1. Go to Microsoft 365 Admin Center
2. Navigate to **Settings** → **Integrated apps**
3. Click **Upload custom apps**
4. Upload the `manifest.xml` file
5. Configure deployment settings
6. Deploy to specific users or groups

## Configuration for End Users

After installation, users need to configure the API URL:

1. Click any iHub AI button in Outlook
2. Enter the iHub server URL: `https://your-ihub-server.com`
3. The configuration is saved in browser localStorage

## Monitoring and Support

### Server-Side Logs

Monitor API requests from the Outlook add-in:

```bash
tail -f server/server.log | grep "outlook\|/api/chat"
```

### Client-Side Debugging

Users can debug issues:

1. Right-click in the taskpane
2. Select "Inspect Element" (if available)
3. Check browser console for errors

### Common Issues

1. **Add-in doesn't appear**: Verify manifest.xml syntax and HTTPS URLs
2. **CORS errors**: Check server CORS configuration  
3. **API connection fails**: Verify server URL and network connectivity
4. **No streaming response**: Check SSE support in the iHub API

## Security Considerations

- Always use HTTPS for the iHub server
- Configure appropriate authentication on the server
- Review data privacy implications for email content
- Consider implementing rate limiting for API endpoints
- Use secure storage for any API keys or tokens

## Updates and Maintenance

### Updating the Add-in

1. Modify files in the `outlook/` directory
2. Rebuild: `npm run prod:build`
3. Deploy updated files to the server
4. Users will automatically get updates on next load
5. For manifest changes, users must reinstall the add-in

### Version Management

Update the version in `outlook/manifest.xml`:

```xml
<Version>1.1.0.0</Version>
```

## Troubleshooting Guide

### Issue: Add-in not loading

**Solution**:
- Clear Outlook's add-in cache
- Verify HTTPS certificate is valid
- Check server accessibility

### Issue: Streaming doesn't work

**Solution**:
- Verify SSE support in browser
- Check network proxies
- Test API endpoint directly

### Issue: CORS errors in console

**Solution**:
- Update platform.json CORS configuration
- Restart iHub server
- Verify credentials: true is set

## Testing Checklist

Before deploying to production:

- [ ] Manifest XML is valid
- [ ] All URLs use HTTPS
- [ ] CORS configuration includes Office domains
- [ ] Required apps (summarizer, email-composer) are enabled
- [ ] API endpoints are accessible
- [ ] Streaming responses work correctly
- [ ] Summarize email function works
- [ ] Generate reply function works
- [ ] Analyze attachments function works
- [ ] Error handling displays appropriate messages
- [ ] Configuration persists across sessions

## Support Resources

- iHub Apps Documentation: `https://your-ihub-server.com/page/help`
- Office Add-ins Documentation: https://docs.microsoft.com/office/dev/add-ins/
- Outlook Add-ins Specific: https://docs.microsoft.com/office/dev/add-ins/outlook/

## Rollback Procedure

If issues occur:

1. Remove the add-in from Outlook (Get Add-ins > My Add-ins > Remove)
2. Revert server changes
3. Restart server
4. Investigate and fix issues
5. Re-deploy when ready
