# Microsoft Teams Integration

**Status: ✅ IMPLEMENTED**  
**Last Updated: July 21, 2025**

## Overview

This concept outlines how to expose the AI Hub Apps inside Microsoft Teams. The
goal is to give users a bot interface that can execute any configured app and an
optional tab embedding the standard web UI. Users should be able to chat with a
bot like "Translate this document" and have the bot run the `translator` app in
the background.
Additionally, apps can be invoked from a message context menu, such as running the summary app on a shared document.

## Objectives

- Provide a Teams bot that forwards user messages to the AI Hub Apps backend.
- Allow the bot to pick an app based on user intent (e.g. translator).
- Offer an optional Teams tab that loads the web client.
- Provide message actions to run AI Hub apps on selected messages or documents (e.g. summarize a shared file).

- Reuse existing authentication and configuration where possible.

## Architecture

1. **Teams App**
   - The app manifest defines a **Bot** and a **Personal Tab**.
   - The tab simply loads the hosted React client (`https://your.aihub.example/`).
   - The bot exposes a message endpoint using the Microsoft Bot Framework.
2. **Bot Service**
   - Implement a new `server/teamsBot.js` that uses `botbuilder` to handle
     activities.
   - Incoming messages are parsed for the desired app. A simple intent mapping
     or LLM call can resolve phrases like "translate this" to the `translator`
     app.
   - The bot calls the existing chat API:
     `POST /api/chat/sessions/{appId}` with the user's text and any variables.
   - Streaming SSE responses are relayed back to Teams as messages.
3. **Authentication**
   - The bot uses OAuth with Microsoft Entra to obtain the user's identity.
   - The same token or user ID is sent to the AI Hub backend so existing
     authorization logic can apply.
4. **Deployment**
   - Host the bot service alongside the server or as a separate Node.js process.
   - Register the Teams app in Azure and upload the generated manifest.
5. **Message Extension**
   - Register an action-based message extension in the manifest.
   - The extension sends the selected message or attachment to the server, which runs the chosen AI Hub app (e.g. summary) and posts the result.

## Key Files

- `server/teamsBot.js` – New bot implementation using `botbuilder`.
- `server/teamsMessageExtension.js` – Handles context-menu actions and message extension requests.
- `server/server.js` – Import and start the bot service when Teams integration is
  enabled via environment variables (`TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`).
- `client/` – No changes required; the existing build is used for the Teams tab.
- `concepts/2025-07-21 Microsoft Teams Integration.md` – This document.

## Implementation Steps

1. **Add Dependencies**
   - Install `botbuilder` and `restify` (or express integration) in `server/`.
2. **Create `teamsBot.js`**
   - Configure the Bot Framework adapter with app ID and password from env vars.
   - Implement a message handler that:
     1. Detects the target app (e.g. via regex or LLM service).
     2. Sends the user's text to the chat endpoint of that app.
     3. Streams the AI Hub response back to the Teams conversation.
3. **Update `server.js`**
   - Optionally start the bot if the env vars are present.
   - Expose the `/api/teams/messages` endpoint used by the adapter.
4. **Create Teams Manifest**
   - Define bot and tab capabilities.
   - Update the manifest to include a command for running an app on a selected message.
   - Point the tab URL to the hosted client application.
5. **Add Message Extension**
   - Implement `teamsMessageExtension.js` to handle action requests.
   - Send selected messages or files to the appropriate app and return the result.
6. **Authentication Flow**
   - Use Teams OAuth to sign in. Pass the token to the server for user mapping.
   - Ensure the server's existing authentication middleware can handle the token
     or map it to a session.
7. **Testing**
   - Deploy the bot to Azure or a public endpoint.
   - Install the app in Teams and verify that commands like "Translate this text"
     produce the expected result using the `translator` app.

## Benefits

- Users interact with AI Hub Apps without leaving Teams.
- The bot provides a lightweight way to trigger apps from chat.
- Existing React client is reused as a tab for rich interactions.
- Message extension actions allow AI Hub Apps to process content directly from Teams messages.

## Implementation Status

### ✅ Completed Components

1. **Teams Bot Service** (`server/teamsBot.js`)
   - Bot Framework integration with activity handling
   - Intent recognition and app mapping
   - User context extraction from Teams
   - Integration with existing ChatService
   - Welcome cards and adaptive card responses

2. **Teams Message Extension Handler** (`server/teamsMessageExtension.js`)
   - Action-based message extensions for context menu
   - Content extraction from messages and attachments
   - Command mapping to AI Hub apps
   - Adaptive card response formatting

3. **Teams App Manifest** (`teams/manifest.json`)
   - Bot, tab, and message extension definitions
   - Command lists and context menu actions
   - Permission and domain configurations
   - OAuth integration settings

4. **Server Integration** (`server/server.js`)
   - Teams bot adapter initialization
   - API endpoint `/api/teams/messages` for bot messaging
   - Teams tab configuration endpoint `/teams/config`
   - Conditional initialization based on environment variables

5. **Configuration Documentation** (`TEAMS_CONFIGURATION.md`)
   - Comprehensive setup guide for Azure Bot Service
   - Environment variable configuration
   - Teams app packaging and deployment
   - Troubleshooting and testing procedures

### 🔧 Configuration Required

To enable Teams integration, set these environment variables:

```bash
TEAMS_APP_ID=your-microsoft-app-id
TEAMS_APP_PASSWORD=your-bot-client-secret
DOMAIN_NAME=your-domain.com
```

### 📋 Setup Steps

1. **Azure Bot Registration**: Register bot in Azure Bot Service
2. **Environment Configuration**: Set required environment variables
3. **Teams App Packaging**: Update manifest.json with your details and create ZIP package
4. **Teams Installation**: Upload app to Teams Admin Center or sideload for testing
5. **Verification**: Test bot conversations, message extensions, and tab integration

### 🎯 Supported Features

- **Conversational Bot**: Natural language interaction with intent mapping
- **Message Extensions**: "Summarize", "Translate", "Analyze", "Improve Writing" context actions
- **Personal Tab**: Full AI Hub Apps web interface embedded in Teams
- **Team Tab**: Configurable team-wide access to AI applications
- **Authentication**: Automatic integration with existing Microsoft OAuth
- **Multi-language Support**: Leverages existing localization system

## Configuration Guide

For detailed setup instructions, see **[TEAMS_CONFIGURATION.md](../TEAMS_CONFIGURATION.md)** in the root directory.

This comprehensive guide covers:

- Azure Bot Service registration
- Environment variable configuration
- Teams app manifest customization
- Installation and deployment procedures
- Testing and troubleshooting steps
- Security considerations and best practices
