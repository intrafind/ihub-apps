# AI Hub Apps

This repository contains the source code for the AI Hub Apps.

## Purpose

The purpose of this repository is to provide a collection of apps, which a user can use to interact with all kind of AI models.

## Apps

### Chat

### Translation

## Implementation

### Server

The server is implemented as a Node.js application, likely using a framework like Express.js to provide a REST API gateway. Its primary responsibilities include:

*   **Configuration Loading:** Reads configuration files (e.g., JSON) defining available apps, language models (LLMs), endpoints, API keys, default styles, and the disclaimer text.
*   **API Endpoints:**
        /api
        /api/apps
        /api/apps/{appId}
        /api/apps/{appId}/chat
        /api/apps/{appId}/chat/{chatId} #openai compatible chat completions endpoint, which supports streaming
        /api/models
        /api/models/{modelId}
        /api/models/{modelId}/chat #openai compatible chat completions endpoint, which supports streaming
        /api/disclaimer

    *   Provides endpoints for the frontend to fetch the list of available apps (`/api/apps`).
    *   Provides endpoints to fetch the list of available models (`/api/models`).
    *   Provides an endpoint to fetch the disclaimer text (`/api/disclaimer`).
    *   Provides the main endpoint for handling chat interactions (`/api/chat` or similar).
*   **LLM Interaction:**
    *   Receives chat messages from the frontend (formatted according to OpenAI's message structure).
    *   Identifies the target LLM based on the user's selection or app configuration.
    *   Forwards the request, including the conversation history and system prompt, to the appropriate remote LLM API endpoint.
    *   Manages API keys required for different LLM services.
*   **Response Streaming:** Receives the response stream from the LLM and forwards it back to the connected frontend client using either WebSockets or Server-Sent Events (SSE) for real-time updates.

## Initial Concept

We want to build an application for users to get started working with AI-enabled applications. These applications are using LLMs and we want to let user use them to support their daily work.
The application consists of a start page. When the user opens the start page, the user will be asked for a username, which is only stored in browser local storage, but also used when using our apps. We use this name to personalize the experience as well as tracking who did what. The user can decide to stay anonymous, in this case we generate a username.
When the user returns to the web application, we will show them their last name, if available. Below the input for the username, we also show a disclaimer, which has been loaded from the backend.
After the user has chosen a username on the start page, the web application switches to the next screen. This app overview screen shows his/her/its name and loads the apps from the backend. A maximum of 7 apps are shown. If we have more apps, we show also show a more button. The apps which are loaded from the backend, can be configured in a json file in the backend. Each app consists of a name, a description, a color, an icon, a system, a token limit, a preferred model, a preferred output format (like markdown, html, pure text, ...) and an optional prompt which can contain variables.  These variables can have a type like string, date, number or boolean. The variables can have predefined values which consists of a label as well as a text which will be used for replacing the variable in the prompt. The variables will be used to adjust the frontend and allow the user a simpler work / guidance what to fill out.
When a user has selected an app, the chat application opens, where the user can simply chat with the llms. These apps will help the user to translate text, these apps  are specialized in generating content, these apps can be used to summarize content incl. voice of tone, writing style as well as the action for the summary like "just summarize", "extract the key facts", "highlight actions items", "list all decisions", "summarize and provide recommendations" or nothing as well as free text or just a full custom app, where the user can enter the system as well as user prompt.
At the app overview page the user can also search for apps via a search box on the page. The search is done purely on the client side.
A user can favorize apps as well as we are tracking which apps he/she/it has used before. This tracking is done in the browser and connected to the username. If the user has chosen a different name, they will not see the used apps from the last time.
When a user has chosen the app, the client will render a chat interface as well as a panel with the information about the app and if the app contains variables with the input fields. It is also possible to expand the system prompt and the normal prompt as well as an option to edit them. A user can save the changes, but they are not written back. A hint should be shown to the user that the changes are only temporarily until the next login.
When a user fills out the optional fields for the variables and enters their text for translation, summarization or whatever the apps is able to do, it will send all the information to the backend in the message format used by OpenAI to simulate a conversion between the assistant and the user.
The backend will send it to an OpenAI compatible LLM hosted remotely and waits for the answer to be streamed back. Our backend will then stream it to our frontend via either Websockets or Server Sent Events.

Example:
instructions: "Talk like a pirate.", #system prompt
input=[
{"role": "user", "content": "knock knock."},
{"role": "assistant", "content": "Who's there?"},
{"role": "user", "content": "Orange."},
] #the messages between the user and the assistant
We will send all messages which have been send before with the request, so we can simulate a conversion and allow the model to use the asked information before. For example, if we have asked to summarize it and afterwards ask to translate it, the llm knows that it has to use the summarized text.
We have to be careful about the context window. This means we should count the tokens on client side and check it against the limit configured in each app.
Our application will also load the available models from our server and if multiples ones are configured, we allow the user to switch the model. Each model has a remote url, an optional api key, a human readable name and a description what it excels in. Depending on the model, our backend will send the request to the configured url.
The conversation in our app looks like a chat with an assistant. A user can modify their input, they can send it again, can copy the text to easily extract it, allow a download for an answer as well as the whole chat.
The user can also tell the assistant how they want to have their response formatted. The user can also chose a certain writing style. Styles allow the user to customize how llm communicates, helping you achieve more while working in a way that feels natural to you. Styles could be:

Normal: Default responses from Claude

Concise: Shorter and more direct responses

Formal: Clear and polished responses

Explanatory: Educational responses for learning new concepts
The default styles are also configured on the backend side and loaded from our web application.
But also custom styles are possible, which are stored in the local storage.

All keys as well as texts has to support i18n / localization.
Therefore we want to build a web application which talks through a small node.js service with the LLMs.

## Setup and Installation

### Prerequisites

- Node.js 20.x or higher
- npm 8.x or higher

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd ai-hub-apps
   ```

2. Install dependencies:
   ```bash
   npm run install:all
   ```

   This will install dependencies for both the client and server components.

### Development

To run the application in development mode:

```bash
npm run dev
```

This will:
- Start the Node.js server on port 3000
- Launch the Vite development server for the client
- Enable hot reloading for both client and server changes

## Building for Production

### Standard Production Build

To create a production build:

```bash
npm run prod:build
```

This creates a `dist` directory containing:
- Optimized client build in `dist/public`
- Server files in `dist/server`
- Application content and configuration in `dist/contents`
- Example setups in `dist/examples`
- Production dependencies alongside `package.json`

To start the production build:

```bash
npm run start:prod
```

### Building as Binary

You can package the entire application as a standalone binary using:

**Prerequisite:** Node.js 20 or newer is required for creating the binary.

```bash
./build.sh --binary
```

This creates versioned executables in the `dist-bin` directory along with configuration files and assets.

To run the binary (replace `${VERSION}` with the current version):

```bash
./dist-bin/ai-hub-apps-v${VERSION}-macos    # On macOS
./dist-bin/ai-hub-apps-v${VERSION}-linux    # On Linux
./dist-bin/ai-hub-apps-v${VERSION}-win.bat  # On Windows
```

### Downloading Pre-built Binaries

Pre-built binaries for all platforms are available on the [GitHub Releases](https://github.com/your-username/ai-hub-apps/releases) page. Each release includes:

- **Standalone executables**:
  - `ai-hub-apps-v<version>-macos` - for macOS
  - `ai-hub-apps-v<version>-linux` - for Linux
  - `ai-hub-apps-v<version>-win.bat` - for Windows
  
- **Complete packages** (executable + configuration files):
  - `ai-hub-apps-v<version>-macos.tar.gz` - macOS package
  - `ai-hub-apps-v<version>-linux.tar.gz` - Linux package
  - `ai-hub-apps-v<version>-win.zip` - Windows package

For most users, downloading the complete package is recommended as it includes all necessary configuration files and assets.

## Configuration

### Server Configuration

The server can be configured through environment variables or by editing the `config.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port the server listens on | `3000` |
| `HOST` | Host interface to bind to | `0.0.0.0` |
| `REQUEST_TIMEOUT` | LLM request timeout (ms) | `60000` |
| `OPENAI_API_KEY` | OpenAI API key | (required) |
| `ANTHROPIC_API_KEY` | Anthropic API key | (required) |
| `GOOGLE_API_KEY` | Google AI API key | (required) |

### SSL Configuration

For HTTPS support, set these environment variables or define them in `config.env`:

| Variable | Description |
|----------|-------------|
| `SSL_KEY` | Path to SSL private key |
| `SSL_CERT` | Path to SSL certificate |
| `SSL_CA` | Path to CA certificate (optional) |

Example of running with custom configuration:

```bash
PORT=8080 HOST=127.0.0.1 npm run start:prod
```

Or with the binary (replace `${VERSION}` with the current version):

```bash
PORT=8080 HOST=127.0.0.1 ./dist-bin/ai-hub-apps-v${VERSION}-macos
```

## Configuration Files

Configuration JSON files are kept in `contents/config` during development. When building, they are copied to `dist/contents/config`.

### apps.json

This file defines all available applications in the AI Hub. Each app has the following structure:

```json
{
  "id": "unique-id",
  "name": {
    "en": "App Name",
    "de": "App Name German"
  },
  "description": {
    "en": "Short description of the app",
    "de": "Kurze Beschreibung der App"
  },
  "color": "#HEXCOLOR",
  "icon": "icon-name",
  "system": {
    "en": "System prompt text for the LLM",
    "de": "Systemaufforderungstext für das LLM"
  },
  "tokenLimit": 16000,
  "preferredModel": "model-id",
  "preferredTemperature": 0.7,
  "preferredOutputFormat": "markdown",
  "variables": [
    {
      "name": "variableName",
      "type": "string",
      "label": {
        "en": "Human-readable label",
        "de": "Menschenlesbare Bezeichnung"
      },
      "predefinedValues": [
        {
          "label": {
            "en": "Option 1",
            "de": "Option 1 DE"
          },
          "value": "option1-value"
        }
      ],
      "required": true
    }
  ]
}
```

Variable types can be:
- `string`: Text input
- `text`: Multi-line text input
- `date`: Date picker
- `number`: Numeric input
- `boolean`: Toggle/checkbox
- `select`: Selection from predefined values

### models.json

This file defines the available LLM models:

```json
[
  {
    "id": "model-id",
    "name": "Model Name",
    "description": "Model description",
    "provider": "openai|anthropic|google",
    "maxTokens": 16000,
    "endpointOverride": "https://custom-endpoint.com" (optional)
  }
]
```

The `provider` field determines which adapter is used to format requests to the LLM.

### styles.json

Defines writing styles available to the user:

```json
{
  "concise": "Please keep your responses brief and to the point.",
  "formal": "Please use formal language and a professional tone.",
  "explanatory": "Please provide detailed explanations suitable for someone learning the concept."
}
```

### ui.json

Configures the user interface elements:

```json
{
  "title": {
    "en": "AI Hub",
    "de": "KI-Hub"
  },
  "header": {
    "links": [
      {
        "name": {
          "en": "Home",
          "de": "Startseite"
        },
        "url": "/"
      }
    ]
  },
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
      }
    ]
  },
  "disclaimer": {
    "text": {
      "en": "Disclaimer text...",
      "de": "Haftungsausschluss Text..."
    },
    "version": "1.0",
    "updated": "2023-01-01"
  },
  "pages": {
    "privacy": {
      "title": {
        "en": "Privacy Policy",
        "de": "Datenschutzerklärung"
      },
      "content": {
        "en": "# Privacy Policy Content in Markdown",
        "de": "# Datenschutzerklärung Inhalt in Markdown"
      }
    }
  }
}
```

## Localization

The application supports internationalization through localization files:

### Server-side Localization

Server-side strings are defined in `config/locales/{lang}.json` files.

### Client-side Localization

Client-side translations are stored in:
- Core translations: `client/src/i18n/core/{lang}.json`
- App-specific translations: `client/src/i18n/locales/{lang}.json`

### Adding a New Language

1. Create a new JSON file in each of these directories named after the language code (e.g., `fr.json` for French)
2. Copy the structure from an existing language file and translate all values
3. Update the language selector in `client/src/components/LanguageSelector.jsx` to include the new language

## Creating Custom Pages

Custom pages can be added through the `ui.json` configuration in the `pages` section:

1. Add a new entry to the `pages` object:
   ```json
   "pages": {
     "page-id": {
       "title": {
         "en": "Page Title",
         "de": "Seitentitel"
       },
       "content": {
         "en": "# Page content in markdown format",
         "de": "# Seiteninhalt im Markdown-Format"
       }
     }
   }
   ```

2. The content field supports Markdown, which will be rendered by the application.

3. To link to the page from the header, add an entry to the `header.links` array:
   ```json
   "header": {
     "links": [
       {
         "name": {
           "en": "Page Title",
           "de": "Seitentitel"
         },
         "url": "/page/page-id"
       }
     ]
   }
   ```

4. To link to the page from the footer, add an entry to the `footer.links` array:
   ```json
   "footer": {
     "links": [
       {
         "name": {
           "en": "Page Title",
           "de": "Seitentitel"
         },
         "url": "/page/page-id"
       }
     ]
   }
   ```

Custom pages are rendered using the `MarkdownPage` component and are accessible at the path `/page/{id}`.

## Development Guidelines

- All UI changes should support dark/light mode themes
- New features should include appropriate translations
- API endpoints should follow the established pattern
- Server-side code should maintain the modular adapter pattern for LLM providers