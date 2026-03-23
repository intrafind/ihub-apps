## Models Configuration

The models configuration defines the AI models available in the iHub application. These settings are managed through individual JSON files in the `contents/models/` directory.

### Basic Model Structure

Each model is defined with the following properties:

```json
{
  "id": "gpt-3.5-turbo",
  "modelId": "gpt-3.5-turbo",
  "name": { "en": "GPT-3.5 Turbo" },
  "description": { "en": "Fast and efficient model for most everyday tasks and conversations" },
  "url": "https://api.openai.com/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 4096
}
```

### Property Details

| Property                       | Type    | Default  | Description                                                                                    |
| ------------------------------ | ------- | -------- | ---------------------------------------------------------------------------------------------- |
| `id`                           | String  | -        | **Required.** Unique identifier for referencing the model within the application               |
| `modelId`                      | String  | -        | **Required.** The actual model identifier used when calling the provider's API                 |
| `name`                         | Object  | -        | **Required.** Localized display name (e.g., `{"en": "GPT-4"}`) shown in the user interface    |
| `description`                  | Object  | -        | **Required.** Localized short description (e.g., `{"en": "..."}`) of the model's capabilities |
| `provider`                     | String  | -        | **Required.** Provider identifier. See [Providers](#providers) for valid values                |
| `url`                          | String  | -        | API endpoint URL for the model. Supports environment variable references like `${MY_URL}`      |
| `tokenLimit`                   | Number  | -        | Maximum token capacity of the model's context window (nullable)                                |
| `default`                      | Boolean | `false`  | Mark this model as the system-wide default. Only one model should have this set to `true`. See [Model Selection in Apps](#model-selection-in-apps) |
| `enabled`                      | Boolean | `true`   | Whether the model is visible and selectable. Set to `false` to hide without deleting           |
| `supportsTools`                | Boolean | `false`  | Whether the model supports tool/function calling                                               |
| `supportsImages`               | Boolean | -        | Whether the model can process image inputs (deprecated alias for `supportsVision`)             |
| `supportsVision`               | Boolean | -        | Whether the model supports image input (vision capabilities)                                   |
| `supportsAudio`                | Boolean | -        | Whether the model can process audio input                                                      |
| `supportsStructuredOutput`     | Boolean | -        | Whether the model natively supports structured JSON output schemas                             |
| `supportsUsageTracking`        | Boolean | -        | Whether the model reports token usage in its responses                                         |
| `supportsImageGeneration`      | Boolean | `false`  | Whether the model can generate images                                                          |
| `imageGeneration`              | Object  | -        | Default image generation parameters for this model. See [Image Generation Defaults](#image-generation-defaults) below |
| `apiKey`                       | String  | -        | Per-model API key stored encrypted on the server. Overrides the environment-level API key for this model only |
| `config`                       | Object  | -        | Provider-specific configuration options passed directly to the adapter (record of any key-value pairs) |
| `concurrency`                  | Number  | -        | Maximum number of concurrent in-flight requests to this model (1-100). Use to prevent rate-limit errors on low-quota plans |
| `requestDelayMs`               | Number  | -        | Optional delay in milliseconds between API requests for this model (0-10000)                  |
| `thinking`                     | Object  | -        | Extended thinking configuration for models that support it. See [Thinking Configuration](#model-thinking-configuration) below |
| `hint`                         | Object  | -        | Message displayed when this model is selected. See [Model Hints](#model-hints) for full documentation |

### Tools

Apps can optionally specify a list of tool identifiers via the `tools` property.
Tool definitions are loaded from `contents/config/tools.json` or discovered from a Model Context Protocol (MCP) server via the `MCP_SERVER_URL` environment variable. Each tool includes a JSON schema for its parameters and the name of the implementation script in `server/tools`. Tools are executed by calling `/api/tools/{id}` with the required parameters. A common example is the built-in `webSearch` tool, which performs a provider-configured web search. Additional tools provide direct access to specific search providers such as Brave (`braveSearch`) and Tavily (`tavilySearch`) when the corresponding API keys are configured.
For example, an app configured for web browsing can enable the `webSearch` tool for its prompts.

Each entry in `contents/config/tools.json` uses the following fields:

| Field         | Description                                             |
| ------------- | ------------------------------------------------------- |
| `id`          | Unique identifier referenced by apps                    |
| `name`        | Display name                                            |
| `description` | Short description of the tool                           |
| `script`      | The script file in `server/tools` implementing the tool |
| `parameters`  | JSON schema describing the tool input                   |

### Providers

The system currently supports the following providers:

1. **OpenAI** (`provider: "openai"`)
   - Compatible with the OpenAI Chat Completions API format
   - Examples: GPT-3.5 Turbo, GPT-4
   - Endpoint: `/v1/chat/completions`

2. **OpenAI Responses API** (`provider: "openai-responses"`)
   - Compatible with the new OpenAI Responses API format for GPT-5 and newer models
   - Provides enhanced reasoning capabilities, built-in tools, and improved performance
   - Endpoint: `/v1/responses`
   - Features:
     - Better performance with reasoning models like GPT-5
     - Agentic loop with built-in tools (web search, file search, code interpreter, etc.)
     - Lower costs due to improved cache utilization (40-80% improvement)
     - Stateful context with `store: true` by default
     - Flexible inputs (string or array of messages)
     - Structured outputs via `text.format`
   - Examples: GPT-5

3. **Anthropic** (`provider: "anthropic"`)
   - Compatible with the Anthropic Messages API format
   - Examples: Claude 3 Opus, Claude 3 Sonnet

4. **Google** (`provider: "google"`)
   - Compatible with the Google Gemini API format
   - Examples: Gemini 1.5 Flash

5. **Mistral** (`provider: "mistral"`)
   - Compatible with Mistral's La Plateforme API format
   - Examples: Mistral Small, Mixtral 8x7B

6. **Local Models** (can use any provider format they're compatible with)
   - Self-hosted models accessible via localhost or network
   - Example: Local vLLM implementation

7. **iAssistant Conversation** (`provider: "iassistant-conversation"`)
   - Connects to an IntraFind iAssistant service for retrieval-augmented conversations
   - Requires `iAssistant.baseUrl` configured in `platform.json`
   - Uses the iAssistant profile and search settings defined at the platform or app level

### Image Generation Defaults

For models with `supportsImageGeneration: true`, the `imageGeneration` object sets the default parameters:

```json
{
  "supportsImageGeneration": true,
  "imageGeneration": {
    "aspectRatio": "1:1",
    "quality": "Medium",
    "maxReferenceImages": 14
  }
}
```

| Property                          | Type   | Default  | Description                                                                                                                   |
| --------------------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `imageGeneration.aspectRatio`     | String | `"1:1"`  | Default aspect ratio. Options: `"1:1"`, `"16:9"`, `"9:16"`, `"5:4"`, `"4:5"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"21:9"` |
| `imageGeneration.quality`         | String | `"Medium"` | Default quality level. Options: `"Low"`, `"Medium"`, `"High"`                                                              |
| `imageGeneration.maxReferenceImages` | Number | `14`  | Maximum number of reference images accepted (1-14)                                                                           |

App-level `imageGeneration` settings (see [Apps documentation](apps.md)) override these model defaults.

### Model Thinking Configuration

For models that support extended thinking (such as Claude claude-3-7-sonnet), the `thinking` object configures the reasoning mode:

```json
{
  "thinking": {
    "enabled": true,
    "budget": 8000,
    "thoughts": false
  }
}
```

| Property           | Type    | Description                                                                                                                 |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `thinking.enabled` | Boolean | Enable extended thinking mode for this model                                                                                |
| `thinking.budget`  | Number  | Token budget for internal thinking steps. `0` disables thinking, `-1` lets the model decide dynamically, positive values set a specific budget |
| `thinking.thoughts`| Boolean | When `true`, the model's internal thinking steps are returned and shown in the response                                     |

App-level `thinking` settings override these model defaults for a specific app.

### Model Selection in Apps

The iHub provides a flexible system for selecting which AI model an app uses. The model is determined based on the following order of precedence:

1.  **User Selection**: A user can manually select a model from the dropdown in the app's interface. This choice is saved for the session and overrides all other settings.

2.  **App-Specific Preferred Model**: You can set a specific model for an app in its configuration (e.g., in `examples/apps/chat.json`) using the `preferredModel` property. This is the default model for that specific app.

    ```json
    "preferredModel": "gpt-4"
    ```

3.  **System-Wide Default Model**: If an app does not have a `preferredModel` configured, the system will look for a globally defined default model. To configure a system-wide default, add `"default": true` to a model's individual JSON file in `contents/models/`.

    ```json
    {
      "id": "gemini-2.5-flash-preview-05-20",
      "modelId": "gemini-2.5-flash-preview-05-20",
      "name": "Gemini 2.5",
      "description": "Google's versatile model optimized for text and code tasks",
      "url": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:streamGenerateContent",
      "provider": "google",
      "tokenLimit": 32768,
      "default": true,
      "supportsTools": true
    }
    ```

    If a default model is set, the app's model dropdown in the user interface will pre-select this model if the app has no `preferredModel`. If an app's preferred model cannot be found, the default model is used instead. Only one model should be marked as the default.

4.  **First Available Model**: If none of the above are set, the app will simply use the first model from the list of available models.

### Restricting Available Models

Apps can also specify which models are allowed to be used via the `allowedModels` property. This will restrict the models available in the model selection dropdown for that app.

```json
"allowedModels": ["local-vllm", "gemini-1.5-flash"]
```

### Adding New Models

To add a new model:

1. Create a new JSON file in `contents/models/` (e.g., `contents/models/my-model.json`)
2. Ensure the provider adapter in `server/adapters/` supports the provider
3. Provide required credentials in your environment variables

#### Example: Adding GPT-5 with Responses API

```json
{
  "id": "gpt-5",
  "modelId": "gpt-5",
  "name": {
    "en": "GPT-5",
    "de": "GPT-5"
  },
  "description": {
    "en": "OpenAI's most advanced reasoning model with enhanced capabilities using the Responses API",
    "de": "OpenAIs fortschrittlichstes Reasoning-Modell mit erweiterten Funktionen über die Responses API"
  },
  "url": "https://api.openai.com/v1/responses",
  "provider": "openai-responses",
  "tokenLimit": 128000,
  "supportsTools": true,
  "enabled": true,
  "default": false
}
```

**Important Notes for OpenAI Responses API:**
- Use `provider: "openai-responses"` for GPT-5 and newer models
- The endpoint URL must be `https://api.openai.com/v1/responses`
- You still need to set `OPENAI_API_KEY` in your environment
- The adapter automatically handles the conversion between Chat Completions and Responses API formats
- Responses are stored by default (`store: true`) for stateful conversations
- For organizations with Zero Data Retention requirements, the adapter can be configured to use encrypted reasoning items

## Model Hints

The Model Hints feature allows administrators to display important, internationalized messages when users select specific models. This is useful for guiding users to appropriate models, warning about deprecations, or enforcing acknowledgment for experimental models.

### Hint Severity Levels

Model hints support four severity levels with different visual styling and behaviors:

#### 1. Hint (Blue)
- **Purpose**: Subtle suggestions or best practices
- **Visual**: Blue background, information icon
- **Behavior**: Dismissible by user, input remains enabled
- **Example Use Case**: Cost optimization suggestions

```json
{
  "hint": {
    "message": {
      "en": "This model is optimized for quick responses. For complex reasoning tasks, consider using GPT-5.",
      "de": "Dieses Modell ist für schnelle Antworten optimiert. Für komplexe Denkaufgaben sollten Sie GPT-5 in Betracht ziehen."
    },
    "level": "hint",
    "dismissible": true
  }
}
```

#### 2. Info (Cyan)
- **Purpose**: Important information users should know
- **Visual**: Cyan background, information icon
- **Behavior**: Dismissible by user, input remains enabled
- **Example Use Case**: Model capability recommendations

```json
{
  "hint": {
    "message": {
      "en": "This model provides excellent reasoning capabilities. Recommended for complex analytical tasks.",
      "de": "Dieses Modell bietet hervorragende Reasoning-Fähigkeiten. Empfohlen für komplexe analytische Aufgaben."
    },
    "level": "info",
    "dismissible": true
  }
}
```

#### 3. Warning (Yellow)
- **Purpose**: Critical information that must be visible
- **Visual**: Yellow background, warning icon
- **Behavior**: Non-dismissible, always visible, input remains enabled
- **Example Use Case**: Model deprecation notices

```json
{
  "hint": {
    "message": {
      "en": "This model is being deprecated and will be removed in the next release. Please migrate to Gemini 2.0 Flash.",
      "de": "Dieses Modell wird eingestellt und in der nächsten Version entfernt. Bitte migrieren Sie zu Gemini 2.0 Flash."
    },
    "level": "warning",
    "dismissible": false
  }
}
```

#### 4. Alert (Red)
- **Purpose**: Critical warnings requiring explicit acknowledgment
- **Visual**: Red background, warning icon, "Important Notice" title
- **Behavior**: Blocks input until user clicks "I Understand" button
- **Example Use Case**: Experimental models, data classification warnings

```json
{
  "hint": {
    "message": {
      "en": "⚠️ EXPERIMENTAL MODEL ⚠️\n\nThis model is in early testing and may produce incorrect or unexpected results. Only use for testing purposes.",
      "de": "⚠️ EXPERIMENTELLES MODELL ⚠️\n\nDieses Modell befindet sich in der frühen Testphase und kann falsche oder unerwartete Ergebnisse liefern. Nur für Testzwecke verwenden."
    },
    "level": "alert",
    "dismissible": false
  }
}
```

### Configuration Schema

The hint configuration uses the following schema:

```json
{
  "hint": {
    "message": {
      "en": "English message (required)",
      "de": "German message (required)",
      // Additional languages as needed
    },
    "level": "hint" | "info" | "warning" | "alert",  // Required
    "dismissible": true | false  // Optional, defaults based on level
  }
}
```

**Required Fields:**
- `message`: Object with localized strings (minimum: `en` and `de`)
- `level`: One of the four severity levels

**Optional Fields:**
- `dismissible`: Whether users can dismiss the hint (only applies to hint/info levels)

### Common Use Cases

#### Model Deprecation
```json
"hint": {
  "message": {
    "en": "This model will be removed on March 1st. Please migrate to the new version.",
    "de": "Dieses Modell wird am 1. März entfernt. Bitte migrieren Sie zur neuen Version."
  },
  "level": "warning"
}
```

#### Cost Optimization
```json
"hint": {
  "message": {
    "en": "For simple queries, use GPT-4 Mini for 10x cost savings.",
    "de": "Für einfache Anfragen verwenden Sie GPT-4 Mini für 10-fache Kosteneinsparungen."
  },
  "level": "hint",
  "dismissible": true
}
```

#### Data Classification
```json
"hint": {
  "message": {
    "en": "⚠️ This model uses external cloud services. Do not use for classified information.",
    "de": "⚠️ Dieses Modell verwendet externe Cloud-Dienste. Nicht für klassifizierte Informationen verwenden."
  },
  "level": "alert"
}
```

### Internationalization

All hint messages must be internationalized:
- **Minimum**: Provide English (`en`) and German (`de`) translations
- **Additional**: Add more language codes as needed (e.g., `fr`, `es`, `ja`)
- **Fallback**: System falls back to English if user's language is not available

#### UI Element Translations

The hint feature includes built-in UI elements that are automatically translated:
- **"Important Notice"** (Alert title) - Translated via `pages.appChat.modelSelector.hint.alertTitle`
- **"Dismiss"** (Dismiss button) - Translated via `pages.appChat.modelSelector.hint.dismiss`
- **"I Understand"** (Acknowledge button) - Translated via `pages.appChat.modelSelector.hint.acknowledge`

These translations are defined in `shared/i18n/en.json` and `shared/i18n/de.json` and do not need to be configured in your model configuration files. Only the hint `message` content needs to be provided in your model configuration.

### User Experience

**Hint and Info Levels:**
1. User selects model with hint
2. Banner appears below model selector
3. User can read and optionally dismiss
4. Input remains enabled throughout

**Warning Level:**
1. User selects model with warning
2. Yellow banner appears and stays visible
3. Cannot be dismissed
4. Input remains enabled

**Alert Level:**
1. User selects model with alert
2. Red banner appears with "I Understand" button
3. Input is disabled (grayed out)
4. User must click "I Understand" to enable input
5. Acknowledgment must be repeated if user switches to another model and back

### Example Models

Example model configurations demonstrating all hint levels are available in `examples/models/`:

- `gpt-4-turbo-hint-example.json` - Hint level demo
- `claude-3-info-example.json` - Info level demo
- `gemini-warning-example.json` - Warning level demo
- `experimental-alert-example.json` - Alert level demo

See `examples/models/MODEL_HINTS_EXAMPLES.md` for detailed usage documentation.

### Technical Implementation

**Files:**
- Schema: `server/validators/modelConfigSchema.js` - Validates hint configuration
- UI Component: `client/src/features/chat/components/ModelHintBanner.jsx` - Renders hints
- Integration: `client/src/features/chat/components/ChatInput.jsx` - Displays hints and manages state
- Translations: `shared/i18n/en.json` and `shared/i18n/de.json` - UI element translations

**Key Features:**
- Hot-reloadable (no server restart needed)
- Schema validation prevents configuration errors
- State management ensures proper acknowledgment flow
- Accessible with ARIA roles and keyboard navigation
- Dark mode support
