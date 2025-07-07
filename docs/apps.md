## App Configuration

The app configuration defines the behavior, appearance, and capabilities of each AI application in the AI Hub Apps. Configuration is managed through the `config/apps.json` file, which contains an array of app objects.

### Basic App Structure

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

| Property | Type | Description |
|----------|------|-------------|
| `id` | String | Unique identifier for the app |
| `order` | Number | Display order in the app list (optional) |
| `name` | Object | Localized names for the app |
| `description` | Object | Localized descriptions of app functionality |
| `color` | String | Hex color code for app theming |
| `icon` | String | Icon identifier for the app (see [Available Icons](#available-icons)) |
| `system` | Object | Localized system prompts/instructions for the AI model |
| `tokenLimit` | Number | Maximum token limit for context window |
| `preferredModel` | String | Default AI model to use with this app. If omitted, the server falls back to the model marked as default in `models.json` |
| `preferredOutputFormat` | String | Format for AI responses (markdown, text) |
| `preferredStyle` | String | Style guidance for AI responses (normal, professional, creative, academic) |
| `preferredTemperature` | Number | Temperature setting (0.0-1.0) controlling randomness |
| `sendChatHistory` | Boolean | Whether to include chat history in API requests |

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

| Type | Description |
|------|-------------|
| `string` | Single-line text input |
| `text` | Multi-line text input |
| `dropdown` | Selection from predefined values |

#### Source Path

Some apps can load content from a file:

```json
"sourcePath": "/contents/faq.md"
```

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

| Property | Description |
|----------|-------------|
| `settings.enabled` | Master switch for all settings - when `false`, all settings UI is hidden |
| `settings.model.enabled` | Enable/disable model selection option |
| `settings.style.enabled` | Enable/disable response style selection |
| `settings.temperature.enabled` | Enable/disable temperature adjustment |
| `settings.outputFormat.enabled` | Enable/disable output format selection |
| `settings.chatHistory.enabled` | Enable/disable chat history toggle |
| `inputMode.microphone.mode` | Mode for recording (`manual` or `automatic`) |
| `inputMode.microphone.showTranscript` | Show the live transcript while recording |
| `inputMode.microphone.enabled` | Enable/disable microphone input for voice commands |

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

When `true`, users can submit the form without entering content in the main input field.

#### Other Options

- `allowEmptyContent`: Allow submission without content input
- `allowedModels`: Restrict which models can be used with this app
- `disallowModelSelection`: Prevent user from changing the model

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
`VITE_ICON_BASE_URL` environment variable).  The file name should match the
icon identifier (e.g., `my-icon.svg`).  Files in this directory override
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

