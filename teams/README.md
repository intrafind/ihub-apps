# Teams Integration Files

This directory contains the Microsoft Teams app integration files for AI Hub Apps.

## Files

- **manifest.json** - Teams app manifest defining bot, tabs, and message extensions
- **color-icon.png** - Color icon for Teams app (192x192 pixels)
- **outline-icon.png** - Outline icon for Teams app (32x32 pixels)

## Setup Instructions

### 1. Create App Icons

Create two icon files:

- `color-icon.png` - 192x192 pixels, full color version of your app icon
- `outline-icon.png` - 32x32 pixels, transparent outline icon

### 2. Configure Environment Variables

Set the following environment variables in your server configuration:

```bash
TEAMS_APP_ID=your-teams-app-id
TEAMS_APP_PASSWORD=your-teams-app-password
DOMAIN_NAME=your-domain.com
```

### 3. Customize Manifest

1. Replace `{{TEAMS_APP_ID}}` with your actual Teams App ID
2. Replace `{{DOMAIN_NAME}}` with your domain (e.g., `aihub.example.com`)
3. Update developer information, privacy policy, and terms of use URLs

### 4. Package and Deploy

1. Create a zip file containing:
   - manifest.json
   - color-icon.png
   - outline-icon.png

2. Upload the zip file to Teams:
   - Go to Teams Admin Center
   - Navigate to Teams apps > Manage apps
   - Click "Upload" and select your zip file

### 5. Register Bot in Azure

1. Register a new Bot in Azure Bot Service
2. Get the App ID and generate an App Password
3. Configure the messaging endpoint: `https://your-domain.com/api/teams/messages`
4. Enable Teams channel in the bot configuration

## Features

### Bot Capabilities

- **Personal Chat** - Direct conversation with the AI Hub Apps bot
- **Team/Group Chat** - Bot can be added to team channels and group chats
- **Intent Recognition** - Automatically maps user requests to appropriate AI apps
- **Streaming Responses** - Real-time response streaming (where supported)

### Message Extensions

- **Summarize** - Create summaries of selected messages or documents
- **Translate** - Translate selected text to other languages
- **Analyze** - Analyze content for insights
- **Improve Writing** - Enhance text for clarity and style

### Tabs

- **Personal Tab** - Direct access to the full AI Hub Apps web interface
- **Configurable Tab** - Team-wide access to specific AI applications

## Authentication

The Teams integration leverages the existing Microsoft OAuth configuration in `platform.json`. Users are automatically authenticated using their Microsoft Teams/Entra credentials.

## Supported Apps

All AI Hub Apps configured in `contents/config/apps.json` are automatically available through the Teams interface. The bot uses intent recognition to map user requests to the most appropriate app.
