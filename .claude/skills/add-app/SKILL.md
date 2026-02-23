---
name: add-app
description: Scaffold a new AI app config JSON file in contents/apps/ that passes the project's Zod schema validation. Use when creating a new AI application for the iHub platform.
---

## Gather Requirements

Ask the user for:
- **id**: Unique app identifier (lowercase, hyphens, max 50 chars, e.g. `my-new-app`)
- **name**: Display name in English and German
- **description**: Short description in English and German
- **system prompt**: The AI system prompt in English and German
- **icon**: HeroIcon name (e.g. `SparklesIcon`, `ChatBubbleLeftIcon`, `DocumentTextIcon`)
- **color**: Hex color code (e.g. `#4F46E5`)
- **tokenLimit**: Max tokens (typical values: 4096, 8192, 16384, 32768, 131072)

## Create the Config File

Create `contents/apps/{id}.json` with this minimal valid shape:

```json
{
  "id": "{id}",
  "name": {
    "en": "...",
    "de": "..."
  },
  "description": {
    "en": "...",
    "de": "..."
  },
  "color": "#4F46E5",
  "icon": "SparklesIcon",
  "system": {
    "en": "...",
    "de": "..."
  },
  "tokenLimit": 8192,
  "enabled": true
}
```

## Optional Fields (add as needed)

```json
{
  "order": 10,
  "preferredModel": "gpt-4o",
  "preferredOutputFormat": "markdown",
  "preferredTemperature": 0.7,
  "sendChatHistory": true,
  "messagePlaceholder": { "en": "Type your message...", "de": "Nachricht eingeben..." },
  "greeting": { "en": "Hello! How can I help?", "de": "Hallo! Wie kann ich helfen?" },
  "starterPrompts": [
    { "en": "Summarize this document", "de": "Dieses Dokument zusammenfassen" }
  ],
  "allowedModels": ["gpt-4o", "claude-opus-4-6"],
  "disallowModelSelection": false,
  "allowEmptyContent": false,
  "tools": ["webSearch", "calculator"],
  "features": { "magicPrompt": true },
  "upload": { "enabled": true, "maxSize": 10485760 },
  "variables": [
    {
      "id": "language",
      "type": "select",
      "label": { "en": "Language", "de": "Sprache" },
      "options": [
        { "value": "en", "label": { "en": "English", "de": "Englisch" } }
      ]
    }
  ]
}
```

## Permissions

To restrict access to specific groups, add to `contents/config/groups.json` under the relevant group's `permissions.apps` array. Use `"*"` to allow all apps for a group.

## Verify

After creating the file, check that the server loads it correctly:
```bash
timeout 10s node server/server.js 2>&1 | grep -E "error|{id}" | head -10
```

No server restart needed — apps are reloaded automatically via `configCache`.
