// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The components Admin → Logging offers for the component filter
 * (`platform.logging.components.filter`).
 *
 * Every `id` is a `component` the server really logs with (a literal
 * `component: '<id>'` or `const COMPONENT = '<id>'` in `server/`);
 * `tests/unit/client/log-components-emitted.test.jsx` checks this, so a
 * component that is renamed or removed on the server is not offered as a
 * filter that only ever yields silence (OB-B3).
 *
 * One line per component: `id | name | description`, with the English name
 * and description. A line ending in `| localized` is shown localized, by the
 * keys `admin.logging.components.<id>.name` and `….description` (add both to
 * `shared/i18n/en.json` and `de.json`). The table is kept as text so the list
 * stays plain data rather than dozens of near-identical object literals.
 */
const COMPONENT_TABLE = `
Server | Server | Main server initialization, startup, shutdown, and clustering operations
ChatService | Chat Service | Chat request processing, LLM interactions, streaming responses, and conversation handling
AuthService | Authentication Service | User authentication, login/logout operations, session management (Local, OIDC, Proxy, LDAP, NTLM)
JwtAuth | JWT Authentication | JWT token validation, user authentication via bearer tokens, token expiration checks
ConfigCache | Configuration Cache | Configuration loading, caching, hot-reload operations for apps, models, and platform settings
ApiKeyVerifier | API Key Verifier | Verification of provider API keys (OpenAI, Anthropic, Google, Mistral) at startup
AgentLoop | Agent Loop | The one agentic loop behind chats, workflow nodes, agents and app invocations: model steps, tool execution, budgets, compaction
LLMClient | LLM Client | Every provider request and response: model resolution, API keys, retries, usage
RunLog | Run Ledger | Append-only run ledger: persistence, retention sweep, spill files, deletion cascade
RunStream | Run Stream | Live run events (SSE v2) delivered to chat, workflow and run detail views
InteractionService | Interactions | Human touchpoints raised by runs (questions, approvals, reviews): pending store, answers, expiry
DataRoutes | Data Routes | API routes for chat, prompts, models, apps, and general data endpoints
ModelsRoutes | Models Admin Routes | Admin API endpoints for model configuration, updates, and management
Middleware | Middleware | Request processing middleware (CORS, authentication, rate limiting, error handling)
StaticRoutes | Static Routes | Static file serving, SPA routing, uploaded assets, and documentation serving
Swagger | Swagger/OpenAPI | API documentation generation and Swagger UI serving
Version | Version Info | Application version information, build details, and version checking
SSE | Server-Sent Events | SSE connection management for real-time LLM streaming responses
OpenAIAdapter | OpenAI Adapter | OpenAI API integration, request formatting, response parsing for GPT models
AnthropicAdapter | Anthropic Adapter | Anthropic API integration for Claude models, streaming support
GoogleAdapter | Google Adapter | Google AI (Gemini) API integration, multimodal support, safety settings
VLLMAdapter | vLLM Adapter | vLLM server integration for local model hosting
Setup | Setup | Initial application setup, environment configuration, dependency checks
Utils | Utilities | General utility functions, helpers, and common operations
TokenStorage | Token Storage | Token storage and retrieval for authentication sessions
ResourceLoader | Resource Loader | Loading of application resources, assets, and configuration files
ConfigLoader | Config Loader | Configuration file loading, parsing, and validation
WorkflowEngine | Workflow Engine | Workflow runs: node scheduling, state, retries and failures | localized
NtlmAuth | NTLM Authentication | Windows (NTLM/Kerberos) sign-in and group lookup | localized
OidcAuth | OIDC Authentication | OpenID Connect sign-in: redirects, token exchange, group mapping | localized
LdapAuth | LDAP Authentication | LDAP and Active Directory sign-in and group lookup | localized
ProxyAuth | Proxy Authentication | Sign-in from headers or tokens set by a reverse proxy | localized
Authorization | Authorization | Group inheritance and permission checks for apps, models and tools | localized
IFinderService | iFinder | iFinder document search and retrieval | localized
JiraService | Jira | Jira integration: sign-in and issue requests | localized
WebSearch | Web Search | Web search requests to Brave, Staan, SearXNG and other search engines | localized
McpClientManager | MCP Clients | Connections to MCP servers: connect, list tools, reconnect | localized
`;

/**
 * @typedef {Object} LogComponent
 * @property {string} id - The `component` the server logs with
 * @property {string} name - English name
 * @property {string} description - English description
 * @property {string} [nameKey] - i18n key of the name, when localized
 * @property {string} [descriptionKey] - i18n key of the description, when localized
 */

/**
 * One table line as a component entry.
 *
 * @param {string} line - `id | name | description[ | localized]`
 * @returns {LogComponent}
 */
function componentOf(line) {
  const [id, name, description, flag] = line.split('|').map(part => part.trim());
  if (flag !== 'localized') return { id, name, description };
  const prefix = `admin.logging.components.${id}`;
  return {
    id,
    name,
    description,
    nameKey: `${prefix}.name`,
    descriptionKey: `${prefix}.description`
  };
}

/**
 * Every component the filter offers, in the order shown.
 *
 * @type {LogComponent[]}
 */
export const LOG_COMPONENTS = COMPONENT_TABLE.trim().split('\n').map(componentOf);
