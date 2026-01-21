# Office Integration for Outlook on Mac

This directory contains the Office Add-in integration for Outlook on Mac, enabling users to:

1. **Summarize emails** using the iHub summarizer app
2. **Generate replies** using the iHub email-composer app  
3. **Analyze attachments** using AI

## Features

- **Email Summarization**: Quickly get AI-powered summaries of long emails
- **Reply Generation**: Generate professional responses with appropriate tone
- **Attachment Analysis**: Analyze email attachments based on metadata
- **Streaming Responses**: Real-time streaming of AI responses
- **Mac Native**: Optimized for Outlook on Mac

## Installation

### Prerequisites

- Outlook for Mac (version 16.0 or later)
- Access to an iHub Apps server instance
- HTTPS-enabled iHub server (required for Office Add-ins)

### Step 1: Configure the Manifest

1. Open `manifest.xml` in this directory
2. Replace all instances of `{{APP_URL}}` with your iHub server URL
   - Example: `https://ihub.yourcompany.com`
3. Ensure the URL uses HTTPS (required by Office Add-ins)

### Step 2: Deploy the Add-in Files

You have two options for deployment:

#### Option A: Host on your iHub Server (Recommended)

1. Copy the `outlook/` directory contents to your iHub server's public directory
2. Ensure the files are accessible at `https://your-ihub-server.com/outlook/`
3. Test by accessing `https://your-ihub-server.com/outlook/taskpane.html` in a browser

#### Option B: Use the Build Script

The add-in files will be automatically included in production builds:

```bash
npm run prod:build
```

The files will be copied to `dist/public/outlook/`

### Step 3: Install the Add-in in Outlook for Mac

1. Open Outlook for Mac
2. Go to **Get Add-ins** from the Home ribbon
3. Click **My Add-ins** in the left sidebar
4. Click **Add a Custom Add-in** → **Add from File...**
5. Select the `manifest.xml` file from the `outlook/` directory
6. Click **Install**

The add-in should now appear in your Outlook ribbon.

### Step 4: Configure the API URL

1. Open any email in Outlook
2. Click one of the iHub AI buttons in the ribbon
3. In the taskpane, enter your iHub server URL in the configuration field
4. The URL will be saved for future use

## Usage

### Summarizing an Email

1. Open an email in Outlook
2. Click the **Summarize Email** button in the ribbon
3. Wait for the AI to generate a summary
4. Click **Copy to Clipboard** to use the summary

### Generating a Reply

1. Open an email you want to reply to
2. Click the **Generate Reply** button in the ribbon
3. The AI will generate a professional response
4. Copy the reply and paste it into your email compose window

### Analyzing Attachments

1. Open an email with attachments
2. Click the **Analyze Attachments** button in the ribbon
3. The AI will provide insights about the attachments

## Server-Side Configuration

### CORS Configuration

Ensure your iHub server allows requests from Office Add-ins. Update `contents/config/platform.json`:

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

### Required Apps

The following apps must be enabled on your iHub server:

1. **summarizer** - For email summarization
2. **email-composer** - For reply generation

These apps are available in `examples/apps/` and should be copied to your active apps directory.

## Troubleshooting

### Add-in doesn't appear in Outlook

- Verify the manifest.xml file has valid XML syntax
- Check that all URLs in the manifest use HTTPS
- Try removing and re-adding the add-in

### API Connection Errors

- Verify the iHub server URL is correct and uses HTTPS
- Check CORS configuration on the server
- Ensure the server is accessible from your Mac
- Check browser console for detailed error messages

### Streaming doesn't work

- Verify the iHub API supports Server-Sent Events (SSE)
- Check network connectivity
- Try with a different email or content

## Development

### Testing Locally

For local development:

1. Use ngrok or similar to create an HTTPS tunnel to your local iHub server:
   ```bash
   ngrok http 3000
   ```

2. Update the manifest.xml with the ngrok URL

3. Install the add-in in Outlook

4. Test your changes

### Debugging

1. Open the taskpane in Outlook
2. Right-click and select **Inspect Element** (if available on Mac)
3. Check the browser console for JavaScript errors
4. Monitor network requests to debug API calls

## Architecture

### Files

- **manifest.xml**: Office Add-in manifest defining the add-in metadata and buttons
- **taskpane.html**: Main UI for the add-in task pane
- **src/taskpane.js**: JavaScript logic for Office.js integration and API communication
- **commands.html**: Required file for function commands (currently unused)
- **assets/**: Icons for the add-in (to be added)

### API Integration

The add-in communicates with the iHub server's chat API:

```
POST /api/chat/sessions/{appId}
{
  "messages": [{"role": "user", "content": "..."}],
  "variables": {...},
  "streamResponse": true
}
```

Responses are streamed using Server-Sent Events (SSE).

## Security Considerations

- Always use HTTPS for the iHub server
- API keys (if required) should be configured on the server
- Email content is sent to the iHub server for processing
- Consider data privacy implications for sensitive emails

## Future Enhancements

- [ ] Add icons for better visual integration
- [ ] Support for more apps (translation, analysis, etc.)
- [ ] Attachment content extraction and analysis
- [ ] Settings panel for API configuration
- [ ] Multi-language support
- [ ] Offline mode with cached responses
- [ ] Insert generated content directly into email compose window

## Support

For issues or questions:

1. Check the iHub Apps documentation at `https://your-ihub-server.com/page/help`
2. Review server logs for API errors
3. Check Outlook's add-in error logs
4. Contact your iHub administrator

## License

This Office Add-in integration is part of the iHub Apps platform and follows the same license terms.
