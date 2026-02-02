# Office Integration for Outlook on Mac

## Overview

This concept document describes the implementation of Office Add-in integration for Outlook on Mac, enabling users to leverage iHub Apps AI capabilities directly within their email client.

**Date**: 2026-01-21
**Status**: Implemented
**Type**: Integration

## Problem Statement

Users want to use iHub Apps AI features (email summarization, reply generation, attachment analysis) without leaving their Outlook client on Mac. This requires a native Office Add-in integration that can:

1. Extract email content from Outlook
2. Send it to the iHub backend for processing
3. Display streaming AI responses in real-time
4. Allow users to copy/use the generated content

## Solution

We implemented an Office Add-in for Outlook that provides:

1. **Email Summarization**: Uses the existing `summarizer` app to create concise summaries of emails
2. **Reply Generation**: Uses the `email-composer` app to generate professional responses
3. **Attachment Analysis**: Analyzes email attachments based on their metadata

## Architecture

### Components

```
┌─────────────────────┐
│  Outlook for Mac    │
│  ┌───────────────┐  │
│  │ Email Content │  │
│  └───────┬───────┘  │
│          │          │
│  ┌───────▼───────┐  │
│  │ Office Add-in │  │  (taskpane.html + taskpane.js)
│  │   UI Panel    │  │
│  └───────┬───────┘  │
└──────────┼──────────┘
           │ HTTPS
           │ POST /api/chat/sessions/{appId}
           │ SSE Streaming Response
           ▼
┌──────────────────────┐
│   iHub Server        │
│  ┌────────────────┐  │
│  │  Chat API      │  │
│  │  /api/chat/*   │  │
│  └────────┬───────┘  │
│           │          │
│  ┌────────▼───────┐  │
│  │   AI Adapters  │  │
│  │ (OpenAI, etc)  │  │
│  └────────────────┘  │
└──────────────────────┘
```

### Files Structure

```
outlook/
├── manifest.xml              # Office Add-in manifest
├── taskpane.html            # Main UI for the task pane
├── commands.html            # Required for function commands
├── src/
│   └── taskpane.js         # Office.js integration logic
├── assets/                  # Icons (to be added)
├── README.md               # User documentation
├── DEPLOYMENT_GUIDE.md     # Deployment instructions
└── build-outlook-package.sh # Build script
```

## Implementation Details

### 1. Office Add-in Manifest (`manifest.xml`)

The manifest defines:
- Add-in metadata (name, description, version)
- Host application (Mailbox)
- UI buttons in Outlook ribbon
- Task pane URLs
- Required permissions (ReadWriteItem)

Key features:
- Two ribbon buttons: "Summarize Email" and "Generate Reply"
- Task pane loads with different actions via URL parameters
- Supports both read and compose modes

### 2. Task Pane UI (`taskpane.html`)

Provides:
- Configuration field for iHub server URL
- Action buttons for different AI operations
- Result display area with streaming support
- Copy to clipboard functionality
- Status indicators (loading, success, error)

### 3. Office.js Integration (`src/taskpane.js`)

Core functionality:
- Office.js initialization and event handling
- Email content extraction using Office.js APIs
- API communication with iHub server
- SSE streaming response handling
- LocalStorage for configuration persistence

Key functions:
- `getEmailContent()`: Extracts email body text
- `summarizeEmail()`: Sends email to summarizer app
- `generateReply()`: Creates AI-powered response
- `analyzeAttachments()`: Analyzes attachment metadata
- `streamChatRequest()`: Handles SSE streaming from iHub API

### 4. API Integration

The add-in communicates with the iHub chat API:

**Endpoint**: `POST /api/chat/sessions/{appId}`

**Request**:
```json
{
  "messages": [
    {
      "role": "user",
      "content": "Email content with subject and sender info"
    }
  ],
  "variables": {
    "action": "summarize",
    "type": "professional",
    "recipient": "sender@example.com"
  },
  "streamResponse": true
}
```

**Response**: Server-Sent Events (SSE) stream

```
data: {"content": "This email discusses..."}
data: {"content": " the following topics:"}
data: {"done": true}
```

## Server-Side Requirements

### 1. CORS Configuration

Must allow requests from Office Add-in domains:

```json
{
  "cors": {
    "origin": [
      "https://outlook.office.com",
      "https://outlook.office365.com",
      "https://outlook.live.com"
    ],
    "credentials": true
  }
}
```

### 2. Required Apps

Two apps must be enabled:

1. **summarizer** (`examples/apps/summarizer.json`)
   - Used for email summarization
   - Supports multiple action types (summarize, extract facts, etc.)

2. **email-composer** (`examples/apps/email-composer.json`)
   - Used for reply generation
   - Supports different email types and tones

### 3. HTTPS Requirement

Office Add-ins require HTTPS. The iHub server must be accessible via a valid HTTPS URL.

## Installation Process

### For End Users

1. Obtain the configured `manifest.xml` file
2. Open Outlook for Mac
3. Go to Get Add-ins → My Add-ins
4. Click "Add a Custom Add-in" → "Add from File"
5. Select the manifest.xml file
6. Configure the iHub server URL in the add-in

### For Administrators

1. Deploy add-in files to iHub server's public directory
2. Configure manifest.xml with server URL
3. Distribute manifest.xml to users
4. Optionally deploy via Microsoft 365 Admin Center for centralized distribution

## Build Integration

The Outlook integration is included in the production build:

```bash
npm run prod:build
```

Files are copied to `dist/public/outlook/` and served alongside the main application.

Build script in package.json:
```json
{
  "scripts": {
    "build:outlook": "mkdir -p dist/public/outlook && cp -r outlook/* dist/public/outlook/",
    "build": "... && npm run build:outlook && ..."
  }
}
```

## Security Considerations

1. **Email Privacy**: Email content is sent to the iHub server for AI processing
2. **HTTPS Required**: All communication must use HTTPS
3. **API Authentication**: Consider implementing API key auth for production
4. **Data Retention**: Email data should not be permanently stored
5. **User Consent**: Users should be aware of data processing

## Testing

Manual testing checklist:
- [ ] Add-in loads in Outlook for Mac
- [ ] Configuration URL can be saved
- [ ] Email summarization works
- [ ] Reply generation works  
- [ ] Attachment analysis works
- [ ] Streaming responses display correctly
- [ ] Copy to clipboard functions
- [ ] Error messages display properly
- [ ] Works with various email formats

## Limitations

1. **Attachment Content**: Currently only analyzes attachment metadata, not content
2. **Insert into Email**: Generated replies must be manually copied
3. **Offline Mode**: Requires internet connection to iHub server
4. **Mac Only**: Manifest configured for desktop, but should work on Windows/Web with minor adjustments
5. **Authentication**: No user authentication implemented (relies on server-side config)

## Future Enhancements

1. **Direct Content Insertion**: Insert AI-generated content directly into compose window
2. **Attachment Content Analysis**: Extract and analyze attachment content (PDFs, docs, etc.)
3. **More AI Apps**: Support for translation, tone adjustment, formatting, etc.
4. **Multi-language UI**: Localized UI for different languages
5. **User Authentication**: Implement OAuth or other auth mechanisms
6. **Offline Caching**: Cache responses for offline access
7. **Custom Icons**: Add branded icons for better visual integration
8. **Settings Panel**: Advanced configuration options
9. **Analytics**: Track usage and popular features
10. **Calendar Integration**: Extend to Outlook Calendar events

## Related Code

### Server-Side

- **Chat API**: `server/routes/chat/sessionRoutes.js`
- **Chat Service**: `server/services/chat/ChatService.js`
- **CORS Middleware**: `server/middleware/setup.js`
- **Config Loading**: `server/configCache.js`

### App Configurations

- **Summarizer**: `examples/apps/summarizer.json`
- **Email Composer**: `examples/apps/email-composer.json`

### Build System

- **Package.json**: Added `build:outlook` script
- **Production Build**: Includes Outlook files in `dist/public/outlook/`

## Documentation

- **User Guide**: `outlook/README.md`
- **Deployment Guide**: `outlook/DEPLOYMENT_GUIDE.md`
- **Build Script**: `outlook/build-outlook-package.sh`

## Dependencies

### Client-Side

- Office.js (loaded from Microsoft CDN)
- Native browser APIs (Fetch, EventSource)
- LocalStorage for configuration

### Server-Side

No new dependencies required. Uses existing:
- Express.js
- Chat API
- LLM adapters
- SSE support

## Deployment Checklist

- [ ] Configure manifest.xml with production URL
- [ ] Deploy files to server's public directory
- [ ] Update CORS configuration
- [ ] Enable required apps (summarizer, email-composer)
- [ ] Test HTTPS accessibility
- [ ] Distribute manifest to users
- [ ] Provide user documentation
- [ ] Monitor server logs for API requests

## Success Metrics

- Number of users who install the add-in
- Frequency of use per user
- Most popular feature (summarize vs. reply generation)
- Error rate and types
- API response times
- User feedback and satisfaction

## Conclusion

The Office Integration for Outlook on Mac provides a seamless way for users to access iHub Apps AI capabilities without leaving their email client. The implementation leverages the existing chat API and apps, requiring minimal server-side changes while providing significant value to end users.

The modular architecture allows for easy extension to support additional AI features and can be adapted for other Office applications (Word, PowerPoint, etc.) in the future.
