### Tools

Apps can optionally specify a list of tool identifiers via the `tools` property.
Tool definitions are loaded from `config/tools.json` or discovered from a Model Context Protocol (MCP) server via the `MCP_SERVER_URL` environment variable. Each tool includes a JSON schema for its parameters and the name of the implementation script in `server/tools`. Tools are executed by calling `/api/tools/{id}` with the required parameters. A common example is the built-in `web-search` tool which performs a web search using DuckDuckGo. Additional tools provide direct access to Bing (`bing-search`), Google (`google-search`), and Brave (`brave-search`) when the corresponding API keys are configured.
For example, the `Chat with DuckDuckGo` app in `config/apps.json` enables the `web-search` tool for its prompts.

Each entry in `config/tools.json` uses the following fields:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier referenced by apps |
| `name` | Display name |
| `description` | Short description of the tool |
| `script` | The script file in `server/tools` implementing the tool |
| `parameters` | JSON schema describing the tool input |

> **Note**: Tool support is experimental and subject to change.
