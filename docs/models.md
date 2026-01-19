## Models Configuration

The models configuration defines the AI models available in the iHub application. These settings are managed through the `config/models.json` file, which contains an array of model objects.

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

| Property         | Type   | Description                                                        |
| ---------------- | ------ | ------------------------------------------------------------------ |
| `id`             | String | Unique identifier for referencing the model within the application |
| `modelId`        | String | The actual model identifier used when calling the provider's API   |
| `name`           | String | Display name shown in the user interface                           |
| `description`    | String | Short description of the model's capabilities                      |
| `url`            | String | API endpoint URL for the model                                     |
| `provider`       | String | Provider identifier (openai, anthropic, google, etc.)              |
| `tokenLimit`     | Number | Maximum token capacity of the model's context window               |
| `requestDelayMs` | Number | Optional delay in milliseconds between API requests for this model |

### Tools

Apps can optionally specify a list of tool identifiers via the `tools` property.
Tool definitions are loaded from `config/tools.json` or discovered from a Model Context Protocol (MCP) server via the `MCP_SERVER_URL` environment variable. Each tool includes a JSON schema for its parameters and the name of the implementation script in `server/tools`. Tools are executed by calling `/api/tools/{id}` with the required parameters. A common example is the built-in `web-search` tool which performs a web search using DuckDuckGo. Additional tools provide direct access to Bing (`bing-search`), Google (`google-search`), and Brave (`brave-search`) when the corresponding API keys are configured.
For example, the `Chat with DuckDuckGo` app in `config/apps.json` enables the `web-search` tool for its prompts.

Each entry in `config/tools.json` uses the following fields:

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

### Model Selection in Apps

The iHub provides a flexible system for selecting which AI model an app uses. The model is determined based on the following order of precedence:

1.  **User Selection**: A user can manually select a model from the dropdown in the app's interface. This choice is saved for the session and overrides all other settings.

2.  **App-Specific Preferred Model**: You can set a specific model for an app in its configuration (e.g., in `examples/apps/chat.json`) using the `preferredModel` property. This is the default model for that specific app.

    ```json
    "preferredModel": "gpt-4"
    ```

3.  **System-Wide Default Model**: If an app does not have a `preferredModel` configured, the system will look for a globally defined default model. To configure a system-wide default, add `"default": true` to a model's definition in `contents/config/models.json`.

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

1. Add a new object to the models.json array
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
