# Microsoft Teams Integration

## Overview

This concept outlines how to expose the AI Hub Apps inside Microsoft Teams. The
goal is to give users a bot interface that can execute any configured app and an
optional tab embedding the standard web UI. Users should be able to chat with a
bot like "Translate this document" and have the bot run the `translator` app in
the background.

## Objectives

- Provide a Teams bot that forwards user messages to the AI Hub Apps backend.
- Allow the bot to pick an app based on user intent (e.g. translator).
- Offer an optional Teams tab that loads the web client.
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

## Key Files

- `server/teamsBot.js` – New bot implementation using `botbuilder`.
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
   - Point the tab URL to the hosted client application.
5. **Authentication Flow**
   - Use Teams OAuth to sign in. Pass the token to the server for user mapping.
   - Ensure the server's existing authentication middleware can handle the token
     or map it to a session.
6. **Testing**
   - Deploy the bot to Azure or a public endpoint.
   - Install the app in Teams and verify that commands like "Translate this text"
     produce the expected result using the `translator` app.

## Benefits

- Users interact with AI Hub Apps without leaving Teams.
- The bot provides a lightweight way to trigger apps from chat.
- Existing React client is reused as a tab for rich interactions.
