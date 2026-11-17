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
 * `name` and `description` are the English text; an entry with `nameKey` /
 * `descriptionKey` is shown localized.
 *
 * @type {Array<{ id: string, name: string, description: string, nameKey?: string, descriptionKey?: string }>}
 */
export const LOG_COMPONENTS = [
  {
    id: 'Server',
    name: 'Server',
    description: 'Main server initialization, startup, shutdown, and clustering operations'
  },
  {
    id: 'ChatService',
    name: 'Chat Service',
    description:
      'Chat request processing, LLM interactions, streaming responses, and conversation handling'
  },
  {
    id: 'AuthService',
    name: 'Authentication Service',
    description:
      'User authentication, login/logout operations, session management (Local, OIDC, Proxy, LDAP, NTLM)'
  },
  {
    id: 'JwtAuth',
    name: 'JWT Authentication',
    description:
      'JWT token validation, user authentication via bearer tokens, token expiration checks'
  },
  {
    id: 'ConfigCache',
    name: 'Configuration Cache',
    description:
      'Configuration loading, caching, hot-reload operations for apps, models, and platform settings'
  },
  {
    id: 'ApiKeyVerifier',
    name: 'API Key Verifier',
    description: 'Verification of provider API keys (OpenAI, Anthropic, Google, Mistral) at startup'
  },
  {
    id: 'AgentLoop',
    name: 'Agent Loop',
    description:
      'The one agentic loop behind chats, workflow nodes, agents and app invocations: model steps, tool execution, budgets, compaction'
  },
  {
    id: 'LLMClient',
    name: 'LLM Client',
    description: 'Every provider request and response: model resolution, API keys, retries, usage'
  },
  {
    id: 'RunLog',
    name: 'Run Ledger',
    description:
      'Append-only run ledger: persistence, retention sweep, spill files, deletion cascade'
  },
  {
    id: 'RunStream',
    name: 'Run Stream',
    description: 'Live run events (SSE v2) delivered to chat, workflow and run detail views'
  },
  {
    id: 'InteractionService',
    name: 'Interactions',
    description:
      'Human touchpoints raised by runs (questions, approvals, reviews): pending store, answers, expiry'
  },
  {
    id: 'DataRoutes',
    name: 'Data Routes',
    description: 'API routes for chat, prompts, models, apps, and general data endpoints'
  },
  {
    id: 'ModelsRoutes',
    name: 'Models Admin Routes',
    description: 'Admin API endpoints for model configuration, updates, and management'
  },
  {
    id: 'Middleware',
    name: 'Middleware',
    description:
      'Request processing middleware (CORS, authentication, rate limiting, error handling)'
  },
  {
    id: 'StaticRoutes',
    name: 'Static Routes',
    description: 'Static file serving, SPA routing, uploaded assets, and documentation serving'
  },
  {
    id: 'Swagger',
    name: 'Swagger/OpenAPI',
    description: 'API documentation generation and Swagger UI serving'
  },
  {
    id: 'Version',
    name: 'Version Info',
    description: 'Application version information, build details, and version checking'
  },
  {
    id: 'SSE',
    name: 'Server-Sent Events',
    description: 'SSE connection management for real-time LLM streaming responses'
  },
  {
    id: 'OpenAIAdapter',
    name: 'OpenAI Adapter',
    description: 'OpenAI API integration, request formatting, response parsing for GPT models'
  },
  {
    id: 'AnthropicAdapter',
    name: 'Anthropic Adapter',
    description: 'Anthropic API integration for Claude models, streaming support'
  },
  {
    id: 'GoogleAdapter',
    name: 'Google Adapter',
    description: 'Google AI (Gemini) API integration, multimodal support, safety settings'
  },
  {
    id: 'VLLMAdapter',
    name: 'vLLM Adapter',
    description: 'vLLM server integration for local model hosting'
  },
  {
    id: 'Setup',
    name: 'Setup',
    description: 'Initial application setup, environment configuration, dependency checks'
  },
  {
    id: 'Utils',
    name: 'Utilities',
    description: 'General utility functions, helpers, and common operations'
  },
  {
    id: 'TokenStorage',
    name: 'Token Storage',
    description: 'Token storage and retrieval for authentication sessions'
  },
  {
    id: 'ResourceLoader',
    name: 'Resource Loader',
    description: 'Loading of application resources, assets, and configuration files'
  },
  {
    id: 'ConfigLoader',
    name: 'Config Loader',
    description: 'Configuration file loading, parsing, and validation'
  },
  {
    id: 'WorkflowEngine',
    name: 'Workflow Engine',
    description: 'Workflow runs: node scheduling, state, retries and failures',
    nameKey: 'admin.logging.components.WorkflowEngine.name',
    descriptionKey: 'admin.logging.components.WorkflowEngine.description'
  },
  {
    id: 'NtlmAuth',
    name: 'NTLM Authentication',
    description: 'Windows (NTLM/Kerberos) sign-in and group lookup',
    nameKey: 'admin.logging.components.NtlmAuth.name',
    descriptionKey: 'admin.logging.components.NtlmAuth.description'
  },
  {
    id: 'OidcAuth',
    name: 'OIDC Authentication',
    description: 'OpenID Connect sign-in: redirects, token exchange, group mapping',
    nameKey: 'admin.logging.components.OidcAuth.name',
    descriptionKey: 'admin.logging.components.OidcAuth.description'
  },
  {
    id: 'LdapAuth',
    name: 'LDAP Authentication',
    description: 'LDAP and Active Directory sign-in and group lookup',
    nameKey: 'admin.logging.components.LdapAuth.name',
    descriptionKey: 'admin.logging.components.LdapAuth.description'
  },
  {
    id: 'ProxyAuth',
    name: 'Proxy Authentication',
    description: 'Sign-in from headers or tokens set by a reverse proxy',
    nameKey: 'admin.logging.components.ProxyAuth.name',
    descriptionKey: 'admin.logging.components.ProxyAuth.description'
  },
  {
    id: 'Authorization',
    name: 'Authorization',
    description: 'Group inheritance and permission checks for apps, models and tools',
    nameKey: 'admin.logging.components.Authorization.name',
    descriptionKey: 'admin.logging.components.Authorization.description'
  },
  {
    id: 'IFinderService',
    name: 'iFinder',
    description: 'iFinder document search and retrieval',
    nameKey: 'admin.logging.components.IFinderService.name',
    descriptionKey: 'admin.logging.components.IFinderService.description'
  },
  {
    id: 'JiraService',
    name: 'Jira',
    description: 'Jira integration: sign-in and issue requests',
    nameKey: 'admin.logging.components.JiraService.name',
    descriptionKey: 'admin.logging.components.JiraService.description'
  },
  {
    id: 'WebSearch',
    name: 'Web Search',
    description: 'Web search requests to Brave, Tavily and other search engines',
    nameKey: 'admin.logging.components.WebSearch.name',
    descriptionKey: 'admin.logging.components.WebSearch.description'
  },
  {
    id: 'McpClientManager',
    name: 'MCP Clients',
    description: 'Connections to MCP servers: connect, list tools, reconnect',
    nameKey: 'admin.logging.components.McpClientManager.name',
    descriptionKey: 'admin.logging.components.McpClientManager.description'
  }
];
