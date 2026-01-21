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
- **Mac Native**: Optimized for Outlook for Mac
- **Auto-Configuration**: URLs are automatically configured from the server

## Installation

### Prerequisites

- Outlook for Mac (version 16.0 or later)
- Access to an iHub Apps server instance with admin privileges
- HTTPS-enabled iHub server (required for Office Add-ins)

### Step 1: Download the Manifest from Admin Panel

1. Log in to your iHub Apps instance as an administrator
2. Navigate to **Admin** → **Integrations**
3. Find the "Outlook Add-in for Mac" section
4. Click **Download Manifest** button
5. The manifest file will be downloaded as `ihub-outlook-manifest.xml`

**Note**: The manifest is dynamically generated with the correct server URLs, so no manual configuration is needed!

### Step 2: Install the Add-in in Outlook for Mac

1. Open Outlook for Mac
2. Go to **Get Add-ins** from the Home ribbon
3. Click **My Add-ins** in the left sidebar
4. Click **Add a Custom Add-in** → **Add from File...**
5. Select the downloaded `ihub-outlook-manifest.xml` file
6. Click **Install**

The add-in should now appear in your Outlook ribbon with two buttons:
- **Summarize Email**
- **Generate Reply**

### Step 3: Start Using the Add-in

1. Open any email in Outlook
2. Click one of the iHub AI buttons in the ribbon
3. The taskpane will open and automatically connect to your iHub server
4. Use the AI features to summarize, reply, or analyze attachments

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
2. Click the **Analyze Attachments** button in the ribbon (available through the taskpane menu)
3. The AI will provide insights about the attachments

## Authentication

The Outlook Add-in uses **server-side authentication**. This means:

- Authentication is handled by your iHub Apps server
- The add-in automatically uses the same authentication as your iHub instance
- Email content is sent to the iHub server for AI processing
- Ensure proper authentication and authorization are configured on the server

**Important Security Notes:**
- Email content is transmitted to your iHub server via HTTPS
- The server processes the content using configured AI models
- No data is stored permanently on the server
- Follow your organization's data privacy policies

## Server-Side Configuration

### CORS Configuration

The iHub server automatically serves the add-in files, but you may need to verify CORS settings in `contents/config/platform.json`:

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

1. **summarizer** - For email summarization (from `examples/apps/summarizer.json`)
2. **email-composer** - For reply generation (from `examples/apps/email-composer.json`)

## Troubleshooting

### Add-in doesn't appear in Outlook

- Verify the manifest.xml file was downloaded correctly
- Check that Outlook for Mac is version 16.0 or later
- Try removing and re-adding the add-in

### API Connection Errors

- Verify the iHub server is accessible and using HTTPS
- Check that you're logged in to the iHub server
- Check browser console for detailed error messages

### Streaming doesn't work

- Verify the iHub API supports Server-Sent Events (SSE)
- Check network connectivity
- Try with a different email or content

## Admin Panel Features

Administrators can access the Integrations panel to:

1. **Download Manifest**: Get the dynamically generated manifest.xml file
2. **View Configuration**: See the server URL and endpoint information
3. **Get Installation Instructions**: Step-by-step guide for end users
4. **Authentication Info**: Understand how authentication works

## Architecture

The Outlook Add-in uses Office.js APIs to:

1. Extract email content (subject, sender, body)
2. Send content to iHub chat API (`/api/chat/sessions/{appId}`)
3. Receive streaming responses via Server-Sent Events (SSE)
4. Display results in the task pane

**Data Flow:**
```
Outlook Email → Office.js → Taskpane → iHub Chat API → LLM → Streaming Response → Taskpane Display
```

## Support

For issues or questions:

1. Check the iHub Apps documentation at `/page/help`
2. Contact your iHub administrator
3. Review server logs for API errors

## Future Enhancements

- Direct insertion of generated content into email compose window
- Support for more apps (translation, formatting, etc.)
- Attachment content extraction and analysis
- Multi-language UI support
- Offline mode with cached responses
