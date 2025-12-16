# App Configuration Guide

This comprehensive guide covers how to configure and customize AI applications in iHub Apps, from simple chat interfaces to complex enterprise applications with structured output and tool calling.

## Table of Contents

- [Quick Start](#quick-start)
- [App Types](#app-types)
- [Basic App Structure](#basic-app-structure)
- [Property Details](#property-details)
- [Advanced Configuration](#advanced-configuration-options)
- [Variables and User Input](#variables)
- [Tool Integration](#tool-integration)
- [Structured Output](#structured-output)
- [Upload Features](#upload-features)
- [UI Customization](#ui-customization)
- [Complete Examples](#complete-examples)
- [Troubleshooting](#troubleshooting)

## Quick Start

Create your first AI app in under 5 minutes with this minimal configuration.

### Minimal App Configuration

Add this to your `contents/apps/my-first-app.json`:

```json
{
  "id": "my-assistant",
  "name": {
    "en": "My Assistant"
  },
  "description": {
    "en": "A helpful AI assistant"
  },
  "color": "#4F46E5",
  "icon": "chat",
  "system": {
    "en": "You are a helpful assistant. Answer questions clearly and concisely."
  },
  "tokenLimit": 4000
}
```

That's it! Your app will:
- Appear in the app list with the specified name and icon
- Use the default AI model configured in your system
- Provide a standard chat interface
- Apply the system prompt to guide AI behavior

### Quick Examples by Use Case

**Customer Support Bot:**
```json
{
  "id": "support-bot",
  "name": { "en": "Support Assistant" },
  "description": { "en": "24/7 customer support" },
  "system": { "en": "You are a friendly customer support agent. Help users with their questions professionally." },
  "tokenLimit": 4000,
  "preferredStyle": "professional",
  "tools": ["webSearch"]
}
```

**Document Analyzer:**
```json
{
  "id": "doc-analyzer",
  "name": { "en": "Document Analyzer" },
  "description": { "en": "Extract insights from documents" },
  "system": { "en": "Analyze uploaded documents and extract key information." },
  "tokenLimit": 8000,
  "upload": {
    "enabled": true,
    "fileUpload": {
      "maxFileSizeMB": 10,
      "supportedPdfFormats": ["application/pdf"]
    }
  }
}
```

**Data Extractor with Structured Output:**
```json
{
  "id": "data-extractor",
  "name": { "en": "Data Extractor" },
  "description": { "en": "Extract structured data from text" },
  "system": { "en": "Extract information and return it in JSON format." },
  "tokenLimit": 4000,
  "preferredOutputFormat": "json",
  "outputSchema": {
    "type": "object",
    "properties": {
      "entities": { "type": "array", "items": { "type": "string" } },
      "summary": { "type": "string" }
    }
  }
}
```

## App Types

iHub Apps supports three types of applications:

### Chat Apps (default)

Standard AI-powered chat interfaces with customizable prompts and settings. This is the default type when `type` is omitted.

```json
{
  "id": "my-chat-app",
  "type": "chat",
  "name": { "en": "My Chat Assistant" },
  "description": { "en": "AI assistant for general questions" },
  "system": { "en": "You are a helpful assistant." },
  "tokenLimit": 4000,
  "color": "#4F46E5",
  "icon": "chat"
}
```

### Redirect Apps

Link to external applications or websites directly from the app list. Perfect for integrating third-party tools, external services, or specialized applications that don't need to be embedded.

**Use Cases:**
- Link to external SaaS tools (e.g., CRM, project management)
- Connect to internal applications on different domains
- Provide quick access to web-based tools
- Create shortcuts to frequently used resources

**Basic Configuration:**

```json
{
  "id": "external-tool",
  "type": "redirect",
  "name": { "en": "External Tool" },
  "description": { "en": "Opens external application" },
  "redirectConfig": {
    "url": "https://example.com/tool",
    "openInNewTab": true,
    "showWarning": true
  },
  "color": "#10B981",
  "icon": "external-link"
}
```

**Configuration Properties:**

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `url` | String (URL) | Yes | - | The target URL to redirect to. Must be a valid HTTP/HTTPS URL. |
| `openInNewTab` | Boolean | No | `true` | Whether to open the URL in a new browser tab. When `false`, navigates in the same window. |
| `showWarning` | Boolean | No | `true` | Whether to display a warning page before redirecting. When `false`, redirects immediately without confirmation. |

**Step-by-Step Setup:**

1. **Create the app configuration file** in `contents/apps/my-redirect-app.json`:
   ```json
   {
     "id": "my-external-tool",
     "type": "redirect",
     "name": {
       "en": "External Tool",
       "de": "Externes Tool"
     },
     "description": {
       "en": "Quick access to our project management system",
       "de": "Schnellzugriff auf unser Projektverwaltungssystem"
     },
     "redirectConfig": {
       "url": "https://projects.company.com",
       "openInNewTab": true,
       "showWarning": true
     },
     "color": "#10B981",
     "icon": "external-link",
     "enabled": true
   }
   ```

2. **Configure redirect behavior:**
   - Set `showWarning: true` for external sites to inform users they're leaving iHub Apps
   - Set `showWarning: false` for seamless redirects to trusted internal tools
   - Use `openInNewTab: true` to keep iHub Apps open in the background
   - Use `openInNewTab: false` to fully navigate away from iHub Apps

3. **Add translations** for all supported languages in the `name` and `description` fields

4. **Restart the server** to load the new app configuration

5. **Verify** the app appears in the apps list with an "External" badge

**Configuration Examples:**

*Immediate redirect to internal tool (no warning):*
```json
{
  "id": "intranet",
  "type": "redirect",
  "name": { "en": "Company Intranet" },
  "description": { "en": "Access company resources" },
  "redirectConfig": {
    "url": "https://intranet.company.local",
    "openInNewTab": false,
    "showWarning": false
  },
  "color": "#3B82F6",
  "icon": "building"
}
```

*External service with warning:*
```json
{
  "id": "external-crm",
  "type": "redirect",
  "name": { "en": "CRM System" },
  "description": { "en": "Customer relationship management" },
  "redirectConfig": {
    "url": "https://crm.external-vendor.com",
    "openInNewTab": true,
    "showWarning": true
  },
  "color": "#8B5CF6",
  "icon": "users"
}
```

### Iframe Apps

Embed external applications directly within iHub Apps using an iframe. This creates a seamless integration where the external application appears as a native part of iHub Apps.

**Use Cases:**
- Embed business intelligence dashboards
- Integrate document editors or collaboration tools
- Display internal web applications
- Provide access to specialized tools without leaving iHub Apps

**Basic Configuration:**

```json
{
  "id": "embedded-app",
  "type": "iframe",
  "name": { "en": "Embedded Application" },
  "description": { "en": "External app embedded in iHub" },
  "iframeConfig": {
    "url": "https://example.com/app",
    "allowFullscreen": true,
    "sandbox": ["allow-scripts", "allow-same-origin", "allow-forms"]
  },
  "color": "#3B82F6",
  "icon": "window"
}
```

**Configuration Properties:**

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `url` | String (URL) | Yes | - | The URL of the application to embed. Must be a valid HTTP/HTTPS URL. |
| `allowFullscreen` | Boolean | No | `true` | Whether to allow the embedded app to enter fullscreen mode. |
| `sandbox` | Array<String> | No | `["allow-scripts", "allow-same-origin", "allow-forms"]` | Array of sandbox permissions that control what the iframe can do. See [Sandbox Permissions](#iframe-sandbox-permissions) below. |

**Step-by-Step Setup:**

1. **Create the app configuration file** in `contents/apps/my-iframe-app.json`:
   ```json
   {
     "id": "my-embedded-app",
     "type": "iframe",
     "name": {
       "en": "Analytics Dashboard",
       "de": "Analyse-Dashboard"
     },
     "description": {
       "en": "Company analytics and reporting",
       "de": "Unternehmensanalyse und Berichterstattung"
     },
     "iframeConfig": {
       "url": "https://analytics.company.com/dashboard",
       "allowFullscreen": true,
       "sandbox": [
         "allow-scripts",
         "allow-same-origin",
         "allow-forms",
         "allow-popups"
       ]
     },
     "color": "#8B5CF6",
     "icon": "chart-bar",
     "enabled": true
   }
   ```

2. **Verify the target site allows embedding:**
   - Check that the site doesn't send `X-Frame-Options: DENY` or `X-Frame-Options: SAMEORIGIN` headers
   - Verify the Content Security Policy (CSP) allows embedding
   - Test the URL in a simple HTML iframe to confirm it works

3. **Configure sandbox permissions** based on what the app needs (see below)

4. **Add translations** for all supported languages

5. **Restart the server** to load the new app configuration

6. **Test the embedded app** to ensure it loads and functions correctly

**Iframe Sandbox Permissions:**

The `sandbox` attribute restricts what the embedded application can do. Include only the permissions your application needs:

| Permission | Description | Risk Level |
|------------|-------------|------------|
| `allow-scripts` | Allows JavaScript execution | Medium - Required for most modern web apps |
| `allow-same-origin` | Treats content as same origin, enables storage access | High - Required for apps that need cookies/storage |
| `allow-forms` | Allows form submission | Low - Required for apps with forms |
| `allow-popups` | Allows opening new windows/tabs | Medium - Required for apps that open external links |
| `allow-modals` | Allows `alert()`, `confirm()`, `prompt()` dialogs | Low - Usually safe to enable |
| `allow-top-navigation` | Allows navigating the top-level window | High - Generally avoid unless necessary |
| `allow-downloads` | Allows downloading files | Medium - Enable if app needs file downloads |

**Recommended Sandbox Configurations:**

*Minimal (most restrictive):*
```json
"sandbox": ["allow-scripts"]
```

*Standard (balanced security and functionality):*
```json
"sandbox": ["allow-scripts", "allow-same-origin", "allow-forms"]
```

*Permissive (for trusted applications):*
```json
"sandbox": ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-modals", "allow-downloads"]
```

**Configuration Examples:**

*Embedded whiteboard application:*
```json
{
  "id": "whiteboard",
  "type": "iframe",
  "name": { "en": "Collaborative Whiteboard" },
  "description": { "en": "Draw and brainstorm together" },
  "iframeConfig": {
    "url": "https://excalidraw.com/",
    "allowFullscreen": true,
    "sandbox": [
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-popups",
      "allow-downloads"
    ]
  },
  "color": "#8B5CF6",
  "icon": "pencil"
}
```

*Embedded analytics dashboard:*
```json
{
  "id": "analytics",
  "type": "iframe",
  "name": { "en": "Analytics Dashboard" },
  "description": { "en": "View company metrics and reports" },
  "iframeConfig": {
    "url": "https://metabase.company.com/public/dashboard/abc123",
    "allowFullscreen": true,
    "sandbox": ["allow-scripts", "allow-same-origin"]
  },
  "color": "#3B82F6",
  "icon": "chart-bar"
}
```

*Internal document editor:*
```json
{
  "id": "docs-editor",
  "type": "iframe",
  "name": { "en": "Document Editor" },
  "description": { "en": "Create and edit documents" },
  "iframeConfig": {
    "url": "https://docs.company.local/editor",
    "allowFullscreen": false,
    "sandbox": [
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-modals"
    ]
  },
  "color": "#10B981",
  "icon": "document-text"
}
```

## Required vs Optional Fields by App Type

Different app types have different required and optional fields. Here's a quick reference:

### All App Types (Required Fields)

These fields are required for **all** app types (chat, redirect, iframe):

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | String | Unique identifier (alphanumeric, dots, hyphens, underscores) | `"my-app"` |
| `name` | Object | Localized app names | `{"en": "My App", "de": "Meine App"}` |
| `description` | Object | Localized descriptions | `{"en": "Description", "de": "Beschreibung"}` |
| `color` | String | Hex color code | `"#4F46E5"` |
| `icon` | String | Icon identifier | `"chat"` |

### Chat Apps (Additional Required Fields)

Chat apps require these additional fields:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `system` | Object | Localized system prompts | `{"en": "You are a helpful assistant."}` |
| `tokenLimit` | Number | Max tokens (1-1,000,000) | `4000` |

Optional fields include: `preferredModel`, `preferredStyle`, `preferredTemperature`, `tools`, `variables`, `settings`, etc.

### Redirect Apps (Additional Required Fields)

Redirect apps require:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `type` | String | Must be `"redirect"` | `"redirect"` |
| `redirectConfig` | Object | Redirect configuration | See below |
| `redirectConfig.url` | String | Target URL | `"https://example.com"` |

### Iframe Apps (Additional Required Fields)

Iframe apps require:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `type` | String | Must be `"iframe"` | `"iframe"` |
| `iframeConfig` | Object | Iframe configuration | See below |
| `iframeConfig.url` | String | URL to embed | `"https://example.com/app"` |

### Common Optional Fields

These optional fields work for all app types:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | Boolean | `true` | Whether the app is enabled |
| `order` | Number | - | Display order in app list |
| `category` | String | - | App category for grouping |

### Chat-Specific Fields Not Used in Redirect/Iframe Apps

The following fields are specific to chat apps and are not used for redirect or iframe types:
- `system`, `tokenLimit`, `preferredModel`, `preferredOutputFormat`
- `preferredStyle`, `preferredTemperature`, `sendChatHistory`
- `tools`, `variables`, `prompt`, `outputSchema`
- `settings`, `inputMode`, `upload`, `features`
- `greeting`, `starterPrompts`, `messagePlaceholder`
- `allowEmptyContent`, `allowedModels`, `disallowModelSelection`
- `sources`, `thinking`, `iassistant`

## Basic App Structure

Each app is defined with the following essential properties:

```json
{
  "id": "app-id",
  "order": 1,
  "name": {
    "en": "App Name in English",
    "de": "App Name in German"
  },
  "description": {
    "en": "App description in English",
    "de": "App description in German"
  },
  "color": "#4F46E5",
  "icon": "icon-name",
  "system": {
    "en": "System instructions in English",
    "de": "System instructions in German"
  },
  "tokenLimit": 4096,
  "preferredModel": "gpt-3.5-turbo",
  "preferredOutputFormat": "markdown",
  "preferredStyle": "normal",
  "preferredTemperature": 0.7,
  "sendChatHistory": true
}
```

### Property Details

| Property                | Type    | Description                                                                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | String  | **Required.** Unique identifier for the app                                                                              |
| `name`                  | Object  | **Required.** Localized names for the app                                                                                |
| `description`           | Object  | **Required.** Localized descriptions of app functionality                                                                |
| `color`                 | String  | **Required.** Hex color code for app theming                                                                             |
| `icon`                  | String  | **Required.** Icon identifier for the app (see [Available Icons](#available-icons))                                      |
| `system`                | Object  | **Required.** Localized system prompts/instructions for the AI model                                                     |
| `tokenLimit`            | Number  | Optional. Maximum token limit for context window (1-1,000,000)                                                           |
| `order`                 | Number  | Optional. Display order in the app list                                                                                  |
| `preferredModel`        | String  | Optional. Default AI model to use with this app. If omitted, uses the model marked as default in `models.json`          |
| `preferredOutputFormat` | String  | Optional. Format for AI responses (markdown, text, json, html)                                                           |
| `preferredStyle`        | String  | Optional. Style guidance for AI responses (normal, professional, creative, academic)                                     |
| `preferredTemperature`  | Number  | Optional. Temperature setting (0.0-2.0) controlling randomness                                                           |
| `sendChatHistory`       | Boolean | Optional. Whether to include chat history in API requests (default: true)                                                |
| `outputSchema`          | Object  | Optional. JSON schema describing the structured response format                                                          |
| `iassistant`            | Object  | Optional. Tool-specific configuration for iAssistant RAG integration (see [Tool-Specific Configuration](#tool-specific-configuration)) |

### Advanced Configuration Options

Apps can include additional configuration for user inputs and prompt formatting:

#### Prompt Template

The `prompt` property defines how user inputs are formatted before being sent to the model:

```json
"prompt": {
  "en": "Selected Language: \"{{language}}\" - Text to translate: \"{{content}}\"",
  "de": "Ausgewählte Sprache: \"{{language}}\" - Text der übersetzt werden soll: \"{{content}}\""
}
```

#### Variables

The `variables` property defines customizable inputs for the app:

```json
"variables": [
  {
    "name": "language",
    "label": {
      "en": "Target Language",
      "de": "Zielsprache"
    },
    "type": "string",
    "description": {
      "en": "Select the target language for translation.",
      "de": "Wähle die Zielsprache für die Übersetzung."
    },
    "defaultValue": {
      "en": "English",
      "de": "Englisch"
    },
    "required": true,
    "predefinedValues": [
      {"label": {"en": "English", "de": "Englisch"}, "value": "English"},
      {"label": {"en": "Spanish", "de": "Spanisch"}, "value": "Spanish"}
    ]
  }
]
```

### Variable Placeholders

Administrators can override the automatically generated placeholder for each variable:

```json
"variables": [
  {
    "name": "language",
    "placeholder": {
      "en": "Choose a language",
      "de": "Sprache wählen"
    }
  }
]
```

#### Variable Types

| Type       | Description                      |
| ---------- | -------------------------------- |
| `string`   | Single-line text input           |
| `text`     | Multi-line text input            |
| `dropdown` | Selection from predefined values |


#### Settings Configuration

The `settings` property controls which configuration options users can adjust for each app:

```json
"settings": {
  "enabled": true,
  "model": { "enabled": true },
  "style": { "enabled": true },
  "temperature": { "enabled": true },
  "outputFormat": { "enabled": true },
  "chatHistory": { "enabled": true }
},
"inputMode": {
  "type": "multiline",
  "microphone": {
    "enabled": true,
    "mode": "manual",
    "showTranscript": true
  }
}
```

| Property                              | Description                                                              |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `settings.enabled`                    | Master switch for all settings - when `false`, all settings UI is hidden |
| `settings.model.enabled`              | Enable/disable model selection option                                    |
| `settings.style.enabled`              | Enable/disable response style selection                                  |
| `settings.temperature.enabled`        | Enable/disable temperature adjustment                                    |
| `settings.outputFormat.enabled`       | Enable/disable output format selection                                   |
| `settings.chatHistory.enabled`        | Enable/disable chat history toggle                                       |
| `inputMode.microphone.mode`           | Mode for recording (`manual` or `automatic`)                             |
| `inputMode.microphone.showTranscript` | Show the live transcript while recording                                 |
| `inputMode.microphone.enabled`        | Enable/disable microphone input for voice commands                       |

For more details, see the [Microphone Feature](microphone-feature.md) documentation.

When a setting is disabled (`false`), the corresponding UI element will be hidden, and the app will use the predefined value specified in its configuration.

#### Features

- `imageUpload` – allow users to attach images (see [Image Upload Feature](image-upload-feature.md))
- `fileUpload` – allow users to upload text or PDF files (see [File Upload Feature](file-upload-feature.md))

#### Input Mode

Apps can configure the chat input with the `inputMode` object. The `type` controls how the input behaves.

```json
"inputMode": {
  "type": "multiline",
  "rows": 5,
  "microphone": {
    "enabled": true,
    "mode": "manual",
    "showTranscript": true
  }
}
```

Available types:

- `single` – single line text field (default)
- `multiline` – expandable text area

The optional `rows` property sets the initial number of textarea rows (defaults to 2). If the `microphone` block is provided, it configures voice input for that app.

#### Message Placeholders

Apps can define custom placeholder text for the message input:

```json
"messagePlaceholder": {
  "en": "Enter your text to translate...",
  "de": "Geben Sie Ihren Text zum Übersetzen ein..."
}
```

#### Welcome Messages

Apps can configure a welcome message that appears above the chat input when no messages exist and no starter prompts are configured.

**Simple format (legacy):**

```json
"greeting": {
  "en": "Hello! I'm your AI assistant. How can I help you today?",
  "de": "Hallo! Ich bin Ihr KI-Assistent. Wie kann ich Ihnen heute helfen?"
}
```

**Extended format with title and subtitle:**

```json
"greeting": {
  "en": {
    "title": "👋 Welcome!",
    "subtitle": "I'm your AI assistant. How can I help you today?"
  },
  "de": {
    "title": "👋 Willkommen!",
    "subtitle": "Ich bin Ihr KI-Assistent. Wie kann ich Ihnen heute helfen?"
  }
}
```

Both formats are supported for backward compatibility. The extended format allows you to configure a separate title and subtitle for the greeting screen, providing better visual hierarchy and customization.

Welcome messages are displayed as informational cards above the input area, not as chat messages. They take priority over example prompts but are hidden if starter prompts are configured.

#### Starter Prompts

Apps can offer clickable starter prompts shown when the chat has no messages.
Each prompt can optionally set initial values for input variables:

```json
"starterPrompts": [
  {
    "title": { "en": "Brainstorm a topic" },
    "message": { "en": "Help me brainstorm about a specific topic." }
  },
  {
    "title": { "en": "Translate to German" },
    "message": { "en": "Translate the following text." },
    "variables": { "language": "German" }
  }
]
```

Starter prompts take the highest priority and will hide both welcome messages and example prompts when configured.

If starter prompts are defined, any configured greeting message will be
suppressed so the prompts can be displayed instead.

#### App Startup States

The chat interface adapts its initial appearance based on the app configuration:

1. **Starter Prompts State**: When `starterPrompts` are configured, they are displayed in a grid layout with the chat input below. This provides guided entry points for users.

2. **Welcome Message State**: When no starter prompts are configured but a `greeting` message exists, the welcome message appears in an informational card above the chat input.

3. **Example Prompts State**: When neither starter prompts nor welcome messages are configured, the interface shows a centered layout with example prompts and centers the input box for better visual balance.

The priority order is: Starter Prompts > Welcome Message > Example Prompts.

#### Content Restrictions

Apps can be configured to allow empty content submission:

```json
"allowEmptyContent": true
```

To enforce structured responses from the model, provide an `outputSchema` with a JSON Schema definition:

```json
"outputSchema": {
  "type": "object",
  "properties": { "id": {"type": "string"} }
}
```

Structured output works with all supported adapters. When an `outputSchema` is provided the server enables the provider's JSON mode automatically. The server translates the request as follows:

- **OpenAI**: `response_format: { type: 'json_object' }`
- **Mistral**: `response_format: { type: 'json_schema', json_schema: { schema, name: 'response', strict: true } }`
- **Anthropic**: adds a `json` tool with your schema and forces the model to use it
- **Google Gemini**: `generationConfig.response_mime_type` set to `application/json` and the schema passed as `generationConfig.response_schema`

When `true`, users can submit the form without entering content in the main input field.

#### Other Options

- `allowEmptyContent`: Allow submission without content input
- `allowedModels`: Restrict which models can be used with this app
- `disallowModelSelection`: Prevent user from changing the model
- `outputSchema`: JSON schema defining the required structure of the AI response

### Tool-Specific Configuration

Some tools support app-level configuration to override platform defaults. This allows individual apps to customize tool behavior for their specific use case.

#### iAssistant Configuration

The `iassistant` configuration object allows apps to customize iAssistant RAG (Retrieval-Augmented Generation) behavior:

```json
{
  "id": "my-rag-app",
  "name": { "en": "Knowledge Base Assistant" },
  "description": { "en": "Search and answer from knowledge base" },
  "color": "#2563eb",
  "icon": "search-brain",
  "system": { 
    "en": "You are an assistant that searches documents and provides accurate answers."
  },
  "tools": ["iAssistant_ask"],
  "iassistant": {
    "baseUrl": "https://my-iassistant-instance.example.com",
    "profileId": "my-search-profile-id",
    "filter": [
      {
        "key": "category",
        "values": ["documentation", "help"],
        "isNegated": false
      }
    ],
    "searchMode": "multiword",
    "searchDistance": "",
    "searchFields": {}
  }
}
```

**iAssistant Configuration Properties:**

- `baseUrl` (optional): URL of the iAssistant API endpoint. Overrides the platform-level setting.
- `profileId` (optional): Search profile ID to use. Can be plain text or base64-encoded.
- `filter` (optional): Array of filter objects to apply to searches:
  - `key`: Field name to filter on
  - `values`: Array of values to match
  - `isNegated`: Boolean, if true excludes matches instead of including them
- `searchMode` (optional): Search algorithm mode (e.g., "multiword")
- `searchDistance` (optional): Search distance parameter
- `searchFields` (optional): Object specifying which fields to search

This configuration allows each app to query different knowledge bases, apply different filters, or use different search profiles without affecting other apps using iAssistant.

### Available Icons

The system supports these icons:

- `question-mark-circle` - Question mark in a circle
- `information-circle` - Information icon
- `chat-bubbles` - Chat conversation bubbles
- `globe` - Globe/Earth icon
- `document-text` - Document with text
- `mail` - Email/envelope
- `light-bulb` - Light bulb for ideas
- `sparkles` - Sparkles/magic effect
- `calendar` - Calendar
- `code` - Code brackets
- `users` - People/users
- `document-search` - Document with search
- `share` - Share icon
- And more as defined in the system's Icon component

Additional icons can be provided by placing custom SVG files in the
`public/icons` directory (or any directory specified by the
`VITE_ICON_BASE_URL` environment variable). The file name should match the
icon identifier (e.g., `my-icon.svg`). Files in this directory override
icons of the same name from the built-in set.

### Settings Configuration Examples

Here are some practical examples of how to configure the settings for different use cases:

#### Example 1: Basic Chat App with All Settings Available

```json
{
  "id": "full-featured-chat",
  "name": {
    "en": "Full Featured Chat"
  },
  // Other app properties
  "settings": {
    "enabled": true,
    "model": {
      "enabled": true
    },
    "style": {
      "enabled": true
    },
    "temperature": {
      "enabled": true
    },
    "outputFormat": {
      "enabled": true
    },
    "chatHistory": {
      "enabled": true
    },
    "microphone": {
      "enabled": true
    }
  }
}
```

#### Example 2: Specialized App with Limited Settings

```json
{
  "id": "specialized-translator",
  "name": {
    "en": "Specialized Translator"
  },
  // Other app properties
  "settings": {
    "enabled": true,
    "model": {
      "enabled": false
    },
    "style": {
      "enabled": false
    },
    "temperature": {
      "enabled": false
    },
    "outputFormat": {
      "enabled": true
    },
    "chatHistory": {
      "enabled": false
    },
    "microphone": {
      "enabled": true
    }
  }
}
```

#### Example 3: Fixed Configuration App (No Settings)

```json
{
  "id": "fixed-faq-bot",
  "name": {
    "en": "FAQ Bot"
  },
  // Other app properties
  "settings": {
    "enabled": false
  }
}
```

## Troubleshooting

### Common Configuration Issues

**App not appearing in the list:**
- Verify JSON syntax is valid (no trailing commas, proper quotes)
- Check that the app ID is unique
- Ensure the app file is in `contents/apps/` directory
- Restart the server after adding new app files

**Variables not working:**
- Confirm variable names in prompt template match variable definitions
- Check that variable types are valid (`string`, `text`, `dropdown`)
- Verify required fields are marked correctly

**Tools not executing:**
- Ensure tools are defined in `contents/config/tools.json`
- Check that tool IDs match exactly (case-sensitive)
- Verify user has permissions for the specified tools

**Structured output validation errors:**
- Validate your JSON schema syntax
- Test with simpler schemas first
- Check provider-specific limitations

### App Type Specific Issues

**Redirect Apps:**

*App redirects but doesn't open:*
- Check if browser pop-up blocker is preventing new tabs
- Verify the URL is accessible from the user's network
- Ensure the URL includes the protocol (https:// or http://)
- Test the URL directly in a browser

*Warning page shows but redirect button doesn't work:*
- Check browser console for JavaScript errors
- Verify the `redirectConfig.url` is a valid URL format
- Ensure no network policies are blocking the redirect

*Users don't want to see the warning page:*
- Set `redirectConfig.showWarning: false` for immediate redirect
- This is recommended for trusted internal applications only

**Iframe Apps:**

*"Failed to load embedded application" error:*
- **X-Frame-Options blocking**: The target site sends `X-Frame-Options: DENY` or `SAMEORIGIN` headers
  - Solution: Contact the site administrator to allow framing from your domain, or use a redirect app instead
- **CSP blocking**: The site's Content Security Policy prevents embedding
  - Solution: The target site needs to adjust its CSP `frame-ancestors` directive
- **HTTPS mixed content**: Embedding HTTP content in HTTPS page
  - Solution: Use HTTPS URLs or serve iHub Apps over HTTP (not recommended)

*Iframe loads but features don't work:*
- Check sandbox permissions - add necessary permissions like `allow-popups`, `allow-modals`
- Verify `allow-same-origin` is included if the app needs storage/cookies
- Check browser console for security or permission errors

*Authentication issues in embedded app:*
- Ensure `allow-same-origin` is in sandbox permissions
- Check if the app uses third-party cookies (may be blocked by browser)
- Consider using redirect type instead if authentication is complex

*Iframe is slow to load:*
- The target application may be resource-intensive
- Consider using redirect type to open in a separate tab
- Check network latency between user and target server

*Embedded app breaks out of iframe:*
- The app uses `target="_top"` or `target="_parent"` in links
- Add `allow-top-navigation` to sandbox if this is intended
- Or remove this permission to prevent breakout (links won't work)

**Security Considerations:**

*Redirect Apps:*
- Always validate URLs to prevent open redirect vulnerabilities
- Use `showWarning: true` for external sites to inform users
- Consider maintaining a whitelist of allowed domains
- Be cautious with redirects to user-provided URLs

*Iframe Apps:*
- Only embed applications from trusted sources
- Use minimal sandbox permissions necessary for functionality
- Avoid `allow-top-navigation` unless absolutely required
- Be aware that embedded apps can potentially:
  - Run JavaScript in the context of the iframe
  - Access their own cookies and storage (with `allow-same-origin`)
  - Make network requests to their own domain
- Never embed untrusted or user-provided URLs
- Consider implementing Content Security Policy headers for additional protection

**Best Practices:**

*Redirect Apps:*
- Use descriptive names and descriptions to clarify where users are going
- Choose appropriate icons that represent the external service
- Test redirects on different browsers and devices
- Document any required VPN or network access for internal apps

*Iframe Apps:*
- Test thoroughly in the target browsers your users will use
- Verify mobile responsiveness if users access via mobile devices
- Monitor for changes in the embedded app that might break integration
- Keep a list of embedded URLs and verify them periodically
- Consider fallback options if embedding fails
- Document any special requirements or limitations of the embedded app

## Related Documentation

- **[Tool Calling Guide](tool-calling.md)**: Learn how to add external capabilities to your apps
- **[Structured Output Guide](structured-output.md)**: Configure apps to return JSON responses
- **[Models Configuration](models.md)**: Configure AI model settings and providers
- **[UI Configuration](ui.md)**: Customize the user interface and branding
- **[Upload Features](file-upload-feature.md)**: Enable file and image upload capabilities
- **[Localization Guide](localization.md)**: Add multi-language support to your apps

---

*This documentation follows iHub Apps best practices for app configuration. For additional examples and support, consult the community resources or refer to the example configurations in `contents/apps/`.*
