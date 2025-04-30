# AI Hub Apps Documentation

This documentation covers configuration options for AI Hub Apps including apps, UI, models, content management, internationalization (i18n), and response styles.

## Table of Contents

1. [App Configuration](#app-configuration)
2. [UI Configuration](#ui-configuration)
3. [Models Configuration](#models-configuration)
4. [Content Management](#content-management)
5. [Internationalization (i18n)](#internationalization-i18n)
6. [Response Styles](#response-styles)
7. [Server Components and API Adapters](#server-components-and-api-adapters)

## App Configuration

The app configuration defines the behavior, appearance, and capabilities of each AI application in the AI Hub. Configuration is managed through the `config/apps.json` file, which contains an array of app objects.

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
| `preferredModel` | String | Default AI model to use with this app |
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

#### Custom Actions

Apps can define custom actions that trigger specific behaviors:

```json
"actions": [
  {
    "id": "draft-email",
    "label": {
      "en": "Draft Email",
      "de": "E-Mail entwerfen"
    },
    "description": {
      "en": "Generate an email draft based on the current parameters",
      "de": "E-Mail-Entwurf basierend auf den aktuellen Parametern generieren"
    }
  }
]
```

#### Other Options

- `allowEmptyContent`: Allow submission without content input
- `allowedModels`: Restrict which models can be used with this app
- `disallowModelSelection`: Prevent user from changing the model

### Available Icons

The system supports these icons:
- `question-mark-circle` - Question mark in a circle
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

## UI Configuration

The UI configuration defines the appearance and behavior of the AI Hub user interface. These settings are managed through the `config/ui.json` file.

### Basic Structure

The UI configuration contains the following top-level sections:

```json
{
  "title": {
    "en": "AI Hub",
    "de": "KI-Hub"
  },
  "header": { /* Header configuration */ },
  "footer": { /* Footer configuration */ },
  "disclaimer": { /* Disclaimer text */ },
  "pages": { /* Static page content */ }
}
```

### Title Configuration

The `title` property defines the localized application title shown in the browser tab and various UI elements:

```json
"title": {
  "en": "AI Hub",
  "de": "KI-Hub"
}
```

### Header Configuration

The `header` section controls the appearance and content of the application header:

```json
"header": {
  "defaultColor": "rgb(0, 53, 87)",
  "logo": {
    "url": "/logo-bmas-2.png",
    "alt": {
      "en": "AI Hub Logo",
      "de": "KI-Hub Logo"
    }
  },
  "links": [
    {
      "name": {
        "en": "Home",
        "de": "Startseite"
      },
      "url": "/"
    },
    // More navigation links...
  ]
}
```

| Property | Type | Description |
|----------|------|-------------|
| `defaultColor` | String | Background color for the header |
| `logo.url` | String | Path to the logo image |
| `logo.alt` | Object | Localized alt text for the logo |
| `links` | Array | Navigation links for the header |

### Footer Configuration

The `footer` section controls the appearance and content of the application footer:

```json
"footer": {
  "text": {
    "en": "© 2025 AI Hub. All rights reserved.",
    "de": "© 2025 KI-Hub. Alle Rechte vorbehalten."
  },
  "links": [
    {
      "name": {
        "en": "Privacy Policy",
        "de": "Datenschutzerklärung"
      },
      "url": "/page/privacy"
    },
    // More footer links...
  ]
}
```

### Disclaimer Configuration

The `disclaimer` section defines the legal disclaimer shown to users:

```json
"disclaimer": {
  "text": {
    "en": "Disclaimer text in English...",
    "de": "Disclaimer text in German..."
  },
  "version": "1.0",
  "updated": "2023-01-01"
}
```

### Static Pages

The `pages` section contains content for static pages that can be accessed through the application:

```json
"pages": {
  "privacy": {
    "title": {
      "en": "Privacy Policy",
      "de": "Datenschutzerklärung"
    },
    "content": {
      "en": "# Privacy Policy\n\n**Last Updated: April 9, 2025**\n\n...",
      "de": "# Datenschutzerklärung\n\n**Zuletzt aktualisiert: 9. April 2025**\n\n..."
    }
  },
  // More static pages...
}
```

Each page has:
- A localized `title`
- Localized `content` in Markdown format

### URL Routing

Static pages can be accessed through URL routes using the pattern `/page/{pageId}`, where `{pageId}` corresponds to the key in the `pages` object (e.g., `/page/privacy` for the privacy policy).

## Models Configuration

The models configuration defines the AI models available in the AI Hub application. These settings are managed through the `config/models.json` file, which contains an array of model objects.

### Basic Model Structure

Each model is defined with the following properties:

```json
{
  "id": "gpt-3.5-turbo",
  "modelId": "gpt-3.5-turbo",
  "name": "GPT-3.5 Turbo",
  "description": "Fast and efficient model for most everyday tasks and conversations",
  "url": "https://api.openai.com/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 4096
}
```

### Property Details

| Property | Type | Description |
|----------|------|-------------|
| `id` | String | Unique identifier for referencing the model within the application |
| `modelId` | String | The actual model identifier used when calling the provider's API |
| `name` | String | Display name shown in the user interface |
| `description` | String | Short description of the model's capabilities |
| `url` | String | API endpoint URL for the model |
| `provider` | String | Provider identifier (openai, anthropic, google, etc.) |
| `tokenLimit` | Number | Maximum token capacity of the model's context window |

### Providers

The system currently supports the following providers:

1. **OpenAI** (`provider: "openai"`)
   - Compatible with the OpenAI Chat Completions API format
   - Examples: GPT-3.5 Turbo, GPT-4

2. **Anthropic** (`provider: "anthropic"`)
   - Compatible with the Anthropic Messages API format
   - Examples: Claude 3 Opus, Claude 3 Sonnet

3. **Google** (`provider: "google"`)
   - Compatible with the Google Gemini API format
   - Examples: Gemini 1.5 Flash

4. **Local Models** (can use any provider format they're compatible with)
   - Self-hosted models accessible via localhost or network
   - Example: Local vLLM implementation

### Usage in Apps

Models can be specified in app configurations using the `preferredModel` property, which should match an `id` from models.json:

```json
"preferredModel": "gpt-4"
```

Apps can also specify which models are allowed to be used:

```json
"allowedModels": ["local-vllm", "gemini-1.5-flash"]
```

### Adding New Models

To add a new model:

1. Add a new object to the models.json array
2. Ensure the provider adapter in `server/adapters/` supports the provider
3. Provide required credentials in your environment variables

## Content Management

AI Hub Apps uses a content management system based on Markdown files stored in the `contents/` directory. These files serve multiple purposes:

1. Source material for knowledge-based AI apps
2. Static page content for the application
3. Documentation and supplementary information

### Content Directory Structure

The `contents/` directory contains Markdown (.md) files that can be referenced by the application:

```
contents/
  documentation.md  - Main documentation file
  faq.md           - Frequently asked questions
  [other-content].md - Additional content files
```

### Using Content in Apps

Content files can be incorporated into apps using the `sourcePath` property in app configurations:

```json
{
  "id": "faq-bot",
  "name": {
    "en": "FAQ Bot",
    "de": "FAQ-Bot"
  },
  // Other app properties...
  "sourcePath": "/contents/faq.md",
  "system": {
    "en": "You are a helpful FAQ assistant. Your job is to answer user questions based ONLY on the information provided in the sources section...",
    "de": "Du bist ein hilfreicher FAQ-Assistent..."
  }
}
```

When an app has a `sourcePath` defined:
- The contents of the specified file are loaded when the app is used
- The content is made available to the app through variables (typically `{{source}}` or `{{content}}`)
- The app can reference, search, and use this content when generating responses

### Markdown Content Format

Content files use standard Markdown with some specific conventions:

1. **Headings**: Use headings (# to ######) to structure content hierarchically
2. **Lists**: Use bullet and numbered lists for enumerated information
3. **Code blocks**: Use triple backticks (```) for code examples
4. **Tables**: Use Markdown tables where appropriate
5. **Images**: Images can be referenced using standard Markdown syntax
6. **Links**: Internal and external links work normally

Example from the FAQ content:

```markdown
# Frequently Asked Questions

## General Questions

### What is AI Hub Apps?
AI Hub Apps is a platform that provides a collection of specialized AI assistants...

### How do I start using an app?
Simply click on any app tile from the main dashboard...
```

### Static Page Integration

Content can be used as static pages in the UI configuration:

```json
"pages": {
  "faq": {
    "title": {
      "en": "Frequently Asked Questions",
      "de": "Häufig gestellte Fragen"
    },
    "content": {
      "en": "# Frequently Asked Questions\n\n**Last Updated...",
      "de": "# Häufig gestellte Fragen\n\n**Zuletzt aktualisiert..."
    }
  }
}
```

For larger content, it's better to reference files from the contents directory rather than embedding them directly in the configuration.

### Content Guidelines

For best results with AI-powered applications:

1. Structure content with clear headings and sections
2. Keep individual sections focused on a single topic
3. Use concise language that's easy to understand
4. Avoid excessive formatting that might confuse the AI
5. Update content regularly to ensure accuracy
6. Include a variety of question forms for FAQ content to improve matching

### Content Updates

To update content:

1. Edit the relevant .md file in the `contents/` directory
2. Save the changes
3. The application will automatically use the updated content on next access

No server restart is required when updating content files, as they are loaded dynamically when accessed.

## Internationalization (i18n)

AI Hub Apps supports multiple languages through a comprehensive internationalization (i18n) system. The application currently supports English and German, with the ability to add more languages.

### Localization Files

Translations are managed through JSON files in the `config/locales/` directory:

```
config/locales/
  en.json   - English translations
  de.json   - German translations
  [lang].json - Additional language files
```

Each locale file contains a structured set of translation keys and their corresponding values in that language.

### Translation Structure

The translation files follow a nested structure, organizing translations by feature area:

```json
{
  "app": {
    "title": "AI Hub",
    "loading": "Loading...",
    "error": "An error occurred",
    "retry": "Retry"
  },
  "common": {
    "send": "Send",
    "cancel": "Cancel",
    "save": "Save"
  },
  "pages": {
    "home": {
      "title": "AI Hub",
      "description": "Interact with various AI models through a simple interface"
    }
  }
}
```

### Localized App Configuration

App configurations in `config/apps.json` support localization for user-facing texts:

```json
{
  "id": "translator",
  "name": {
    "en": "Translator",
    "de": "Übersetzer"
  },
  "description": {
    "en": "Translate text between different languages",
    "de": "Text zwischen verschiedenen Sprachen übersetzen"
  },
  "system": {
    "en": "You are a helpful translation assistant...",
    "de": "Du bist ein hilfreicher Übersetzungsassistent..."
  }
}
```

### Variable Labels and Descriptions

App variables also support localized labels and descriptions:

```json
"variables": [
  {
    "name": "language",
    "label": {
      "en": "Target Language",
      "de": "Zielsprache"
    },
    "description": {
      "en": "Select the target language for translation.",
      "de": "Wähle die Zielsprache für die Übersetzung."
    },
    "predefinedValues": [
      {"label": {"en": "English", "de": "Englisch"}, "value": "English"},
      {"label": {"en": "Spanish", "de": "Spanisch"}, "value": "Spanish"}
    ]
  }
]
```

### UI Content Localization

The UI configuration in `config/ui.json` also supports localization:

```json
"title": {
  "en": "AI Hub",
  "de": "KI-Hub"
},
"header": {
  "logo": {
    "alt": {
      "en": "AI Hub Logo",
      "de": "KI-Hub Logo"
    }
  },
  "links": [
    {
      "name": {
        "en": "Home",
        "de": "Startseite"
      },
      "url": "/"
    }
  ]
}
```

### Static Page Content Localization

Static pages can have localized content:

```json
"pages": {
  "privacy": {
    "title": {
      "en": "Privacy Policy",
      "de": "Datenschutzerklärung"
    },
    "content": {
      "en": "# Privacy Policy\n\n...",
      "de": "# Datenschutzerklärung\n\n..."
    }
  }
}
```

### Language Selection

Users can switch between available languages using the language selector in the application interface. The selected language is stored in the user's browser and applied across sessions.

### Translation Keys

The following are the main categories of translation keys:

1. **app**: Core application labels
2. **header**: Navigation and header content
3. **common**: Reusable UI elements like buttons
4. **pages**: Page-specific content
5. **models**: Model descriptions and settings
6. **variables**: Labels for input variables
7. **settings**: User settings options
8. **error**: Error messages
9. **languages**: Language names
10. **appConfig**: App configuration options
11. **chatMessage**: Chat interface elements
12. **errors**: Client-side error messages
13. **serverErrors**: Server-side error messages
14. **responseStyles**: AI response style options

### Adding a New Language

To add support for a new language:

1. Create a new file in `config/locales/` named with the appropriate language code (e.g., `fr.json` for French)
2. Copy the structure from an existing language file
3. Translate all values to the new language
4. Update the language selector component to include the new option
5. Add the new language to the available languages list in the settings

### Translation Guidelines

When translating content:

1. Maintain the same structure and key names as the source file
2. Ensure all keys are translated
3. Respect the formatting and placeholder variables (e.g., `{provider}`)
4. Consider cultural differences and adapt content appropriately
5. Keep UI text concise and clear
6. Test the translated interface to ensure proper rendering

### Dynamic Content Translation

For dynamic content like AI-generated responses, the system sets the appropriate language context based on the user's selected language. This ensures that AI models respond in the correct language when possible.

### Fallback Mechanism

If a translation is missing for the selected language, the system will fall back to the default language (English) to ensure the UI remains functional.

## Response Styles

AI Hub Apps supports various response styles that control how AI models format and present their responses. These styles are defined in the `config/styles.json` file.

### Style Definitions

The styles.json file contains a mapping of style identifiers to descriptions that instruct the AI models how to respond:

```json
{
  "keep": "Keep the original style of the text.",
  "normal": "Provide default, balanced responses.",
  "concise": "Provide shorter and more direct responses. Be brief and to the point.",
  "formal": "Provide clear, professional and polished responses using formal language.",
  "explanatory": "Provide educational responses that explain concepts clearly, as if teaching a student.",
  "creative": "Provide imaginative and artistic responses, using metaphors and analogies.",
  "persuasive": "Provide convincing and compelling responses, using rhetorical techniques.",
  "humorous": "Provide light-hearted and funny responses, using jokes and puns.",
  "empathetic": "Provide compassionate and understanding responses, showing empathy and support.",
  "friendly": "Provide warm and approachable responses, using a friendly tone.",
  "technical": "Provide detailed and precise responses, using technical language.",
  "casual": "Provide relaxed and informal responses, using everyday language.",
  "detailed": "Provide thorough and comprehensive responses, covering all aspects of the topic.",
  "analytical": "Provide logical and critical responses, analyzing the topic in depth.",
  "assertive": "Provide confident and strong responses, taking a clear stance."
}
```

### Using Styles in Apps

In the app configuration, you can specify a preferred style using the `preferredStyle` property:

```json
"preferredStyle": "professional"
```

This style will be used as the default for the app, but users can change it during their interaction.

### Style Selection in the UI

The user interface allows users to select different response styles when interacting with apps. These style options are presented based on the definitions in styles.json.

### Custom Style Instructions

The style instructions are sent to the AI model as part of the system prompt, guiding the model to generate responses in the requested style. The specific formatting and tone characteristics are defined in the style description.

### Style Categories

The available styles can be categorized as follows:

1. **Neutral Styles**
   - `keep` - Maintains the original style without modification
   - `normal` - Default balanced approach

2. **Formal and Professional**
   - `formal` - Professional language suitable for business contexts
   - `technical` - Precise terminology for technical discussions
   - `analytical` - Critical analysis and logical reasoning

3. **Conversational**
   - `friendly` - Warm and approachable tone
   - `casual` - Relaxed, everyday language
   - `empathetic` - Compassionate and supportive

4. **Specialized**
   - `concise` - Brief and direct
   - `detailed` - Comprehensive and thorough
   - `explanatory` - Educational and clarifying
   - `creative` - Imaginative and artistic
   - `persuasive` - Convincing and compelling
   - `humorous` - Light-hearted and funny
   - `assertive` - Confident and direct

## Server Components and API Adapters

AI Hub Apps includes a server component that handles the communication with various AI model providers. This section covers the server architecture and API adapters.

### Server Structure

The server component is located in the `server/` directory with the following key files:

```
server/
  server.mjs        - Main server entry point
  utils.js          - Utility functions
  pkg-entry.cjs     - Package entry for binary builds
  adapters/
    index.js        - Adapter orchestration
    openai.js       - OpenAI API adapter
    anthropic.js    - Anthropic API adapter
    google.js       - Google AI API adapter
```

### Server Functionality

The server provides several key functions:

1. **API Proxying**: Routes client requests to the appropriate AI model provider
2. **Authentication**: Manages API keys and authentication with providers
3. **Request Formatting**: Converts internal app formats to provider-specific formats
4. **Response Processing**: Handles streaming responses and formats them for the client
5. **Error Handling**: Provides consistent error responses across different providers
6. **Logging**: Records interactions for monitoring and debugging

### API Adapters

The system uses provider-specific adapters to communicate with different AI model APIs:

#### OpenAI Adapter

The OpenAI adapter (`adapters/openai.js`) handles communication with OpenAI-compatible APIs:

- Supports models like GPT-3.5, GPT-4
- Compatible with OpenAI-compatible APIs (including local vLLM implementations)
- Handles the Chat Completions API format

#### Anthropic Adapter

The Anthropic adapter (`adapters/anthropic.js`) handles communication with Anthropic's Claude models:

- Supports Claude 3 Opus, Claude 3 Sonnet
- Implements Anthropic's Messages API format
- Manages specific Claude parameters and response formats

#### Google Adapter

The Google adapter (`adapters/google.js`) handles communication with Google's AI models:

- Supports Gemini models
- Implements Google's Generative Language API
- Handles Google-specific authentication and formatting

### Adding Custom Adapters

To add support for a new AI provider:

1. Create a new adapter file in the `server/adapters/` directory
2. Implement the required adapter interface functions:
   - `formatRequest`: Convert internal format to provider format
   - `makeRequest`: Send the request to the provider
   - `handleStream`: Process streaming responses
   - `formatError`: Format provider errors consistently
3. Register the adapter in `adapters/index.js`
4. Update the models configuration to use the new adapter

### Environment Configuration

The server uses environment variables for configuration, which can be set in the `config.env` file:

```
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GOOGLE_API_KEY=your_google_api_key
PORT=3000
LOG_LEVEL=info
```

### Binary Distribution

The server can be packaged as a binary for easier distribution, with the packaged files located in the `dist-bin/` directory. This includes:

- The compiled server binary
- Configuration files
- Static web assets
- A start script

### Docker Testing

You can test the Linux binary using Docker with the following command:

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v "$(pwd)/dist-bin:/app" \
  -w /app \
  -e OPENAI_API_KEY=your_openai_api_key \
  -e ANTHROPIC_API_KEY=your_anthropic_api_key \
  -e GOOGLE_API_KEY=your_google_api_key \
  --platform linux/amd64 \
  node:20-slim /bin/bash -c "chmod +x /app/ai-hub-apps-v1.0.3-linux && /app/ai-hub-apps-v1.0.3-linux"
```

This command:
- Maps port 3000 from the container to your host machine
- Mounts your dist-bin directory to the container
- Sets necessary environment variables
- Uses the node:20-slim image with the linux/amd64 platform
- Makes the binary executable and runs it

Run this command from your project root directory. Make sure to replace the placeholder API keys with your actual keys.

### Logging

The server logs interactions to the `logs/` directory, with daily log rotation:

```
logs/
  interactions-YYYY-MM-DD.log
```

These logs contain anonymized records of user interactions, model selections, and any errors encountered, which is useful for troubleshooting and monitoring usage patterns.