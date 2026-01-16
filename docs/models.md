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
   - Examples: GPT-3.5 Turbo, GPT-4, GPT-5.2
   - **GPT-5.x Support**: The platform supports OpenAI's GPT-5.x model family with advanced reasoning and verbosity controls. See [GPT-5.x Configuration](#gpt-5x-configuration) for details.

2. **Anthropic** (`provider: "anthropic"`)
   - Compatible with the Anthropic Messages API format
   - Examples: Claude 3 Opus, Claude 3 Sonnet

3. **Google** (`provider: "google"`)
   - Compatible with the Google Gemini API format
   - Examples: Gemini 1.5 Flash

4. **Mistral** (`provider: "mistral"`)
   - Compatible with Mistral's La Plateforme API format
   - Examples: Mistral Small, Mixtral 8x7B
5. **Local Models** (can use any provider format they're compatible with)
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

### GPT-5.x Configuration

OpenAI's GPT-5.x model family (including GPT-5, GPT-5.1, GPT-5.2, GPT-5.2-pro, GPT-5-mini, and GPT-5-nano) introduces new reasoning and verbosity controls that allow fine-tuning of model behavior.

#### Supported GPT-5.x Models

- `gpt-5` - Base GPT-5 model
- `gpt-5.1` - GPT-5.1 model
- `gpt-5.2` - Latest flagship model with best intelligence
- `gpt-5.2-pro` - Uses more compute for harder thinking
- `gpt-5.2-codex` - Optimized for coding tasks
- `gpt-5.2-chat-latest` - Model powering ChatGPT
- `gpt-5-mini` - Cost-optimized reasoning and chat
- `gpt-5-nano` - High-throughput, simple tasks

#### Thinking Configuration for GPT-5.x

GPT-5.x models use the same `thinking` configuration as other reasoning models (like Google Gemini). The platform automatically maps thinking parameters to GPT-5.x's reasoning and verbosity controls:

**Thinking Budget to Reasoning Effort Mapping:**
- `thinking.enabled: false` or `budget: 0` → **none** (lowest latency, supports temperature)
- `budget: 1-100` → **low** (minimal reasoning, faster responses)
- `budget: -1` (dynamic) or `101-500` → **medium** (balanced reasoning, default)
- `budget: 501-1000` → **high** (more thorough reasoning)
- `budget: > 1000` → **xhigh** (maximum reasoning effort, GPT-5.2 only)

**Thinking Thoughts to Verbosity Mapping:**
- `thoughts: false` → **medium** verbosity (balanced output length)
- `thoughts: true` → **high** verbosity (thorough explanations, extensive documentation)

#### Example GPT-5.2 Configuration

```json
{
  "id": "gpt-5.2",
  "modelId": "gpt-5.2",
  "name": {
    "en": "GPT-5.2",
    "de": "GPT-5.2"
  },
  "description": {
    "en": "OpenAI's most intelligent model for general and agentic tasks",
    "de": "OpenAIs intelligentestes Modell für allgemeine und agentische Aufgaben"
  },
  "url": "https://api.openai.com/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 128000,
  "supportsTools": true,
  "supportsImages": true,
  "thinking": {
    "enabled": true,
    "budget": -1,
    "thoughts": false
  }
}
```

This configuration uses dynamic reasoning budget (mapped to "medium" effort) and medium verbosity.

#### Example GPT-5.2-Pro Configuration (Maximum Reasoning)

For tasks requiring maximum reasoning capability:

```json
{
  "id": "gpt-5.2-pro",
  "modelId": "gpt-5.2-pro",
  "name": {
    "en": "GPT-5.2 Pro",
    "de": "GPT-5.2 Pro"
  },
  "description": {
    "en": "GPT-5.2 with maximum reasoning effort for complex problems",
    "de": "GPT-5.2 mit maximaler Denkleistung für komplexe Probleme"
  },
  "url": "https://api.openai.com/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 128000,
  "supportsTools": true,
  "supportsImages": true,
  "thinking": {
    "enabled": true,
    "budget": 1500,
    "thoughts": true
  }
}
```

This configuration uses a high budget (mapped to "xhigh" effort) and includes thoughts (mapped to "high" verbosity).

#### Example GPT-5-Mini Configuration (Low Budget)

For cost-effective tasks:

```json
{
  "id": "gpt-5-mini",
  "modelId": "gpt-5-mini",
  "name": {
    "en": "GPT-5 Mini",
    "de": "GPT-5 Mini"
  },
  "description": {
    "en": "Cost-optimized reasoning model balancing speed and capability",
    "de": "Kostenoptimiertes Reasoning-Modell mit Geschwindigkeit und Leistung"
  },
  "url": "https://api.openai.com/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 128000,
  "supportsTools": true,
  "supportsImages": true,
  "thinking": {
    "enabled": true,
    "budget": 50,
    "thoughts": false
  }
}
```

This configuration uses a low budget (mapped to "low" effort) and medium verbosity.

#### Migration from GPT-4.x

Legacy models (GPT-4, GPT-3.5, o1, o3) continue to work without any configuration changes. The platform automatically detects GPT-5.x models and uses the appropriate API parameters.

When migrating from GPT-4.x to GPT-5.x, configure the `thinking` parameter:
- For faster responses: Use `budget: 0` or `enabled: false` (maps to "none" effort)
- For balanced performance: Use `budget: -1` (maps to "medium" effort, default)
- For better accuracy: Use `budget: 800` (maps to "high" effort)
- For maximum reasoning: Use `budget: 1500` (maps to "xhigh" effort)
- For detailed outputs: Set `thoughts: true` (maps to "high" verbosity)

#### Important Notes

1. **Temperature Compatibility**: The `temperature` parameter is only supported when reasoning effort is `"none"` (i.e., `thinking.enabled: false` or `budget: 0`). For other effort levels, the temperature parameter is ignored.

2. **API Differences**: GPT-5.x models use `max_output_tokens` instead of the deprecated `max_tokens` parameter. The platform handles this automatically.

3. **Default Configuration**: If `thinking` is not specified for a GPT-5.x model, it defaults to:
   ```json
   {
     "enabled": true,
     "budget": -1,
     "thoughts": false
   }
   ```
   This maps to "medium" reasoning effort and "medium" verbosity.

4. **Consistent with Other Models**: The `thinking` configuration works the same way across all reasoning-capable models (Google Gemini, GPT-5.x), providing a unified interface.
