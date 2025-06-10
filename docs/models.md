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

### Tools

Apps can optionally specify a list of tool identifiers via the `tools` property.
Tool definitions are loaded from `config/tools.json` or discovered from a Model Context Protocol (MCP) server via the `MCP_SERVER_URL` environment variable. Each tool includes a JSON schema for its parameters and the name of the implementation script in `server/tools`. Tools are executed by calling `/api/tools/{id}` with the required parameters. A common example is the built-in `web-search` tool which performs a web search using DuckDuckGo. Additional tools provide direct access to Bing (`bing-search`) and Google (`google-search`) when the corresponding API keys are configured.
For example, the `Chat with DuckDuckGo` app in `config/apps.json` enables the `web-search` tool for its prompts.

Each entry in `config/tools.json` uses the following fields:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier referenced by apps |
| `name` | Display name |
| `description` | Short description of the tool |
| `script` | The script file in `server/tools` implementing the tool |
| `parameters` | JSON schema describing the tool input |

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

