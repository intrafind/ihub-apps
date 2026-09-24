/**
 * Built-in catalog of hosted MCP servers, offered under Admin → MCP servers →
 * Browse catalog. An entry is a template for a `mcpServers.json` server: the
 * admin picks one, stores the API key as a credential, tests and saves.
 *
 * Only servers iHub can connect to today are listed: no auth, or one static
 * credential shared by all users (bearer token, vendor header or basic auth).
 * Servers that insist on an interactive OAuth login for every user are left
 * out until outbound per-user OAuth exists.
 *
 * Entry fields:
 *   id             suggested server id (also the default tool prefix)
 *   name           product name, not translated
 *   vendor         company behind the server
 *   category       one of MCP_CATALOG_CATEGORIES
 *   description    { en, de }
 *   transport      transport block, copied into the form; `headers` are
 *                  non-secret headers the vendor expects next to the key
 *   auth           { type: 'none' } | { type: 'bearer' } | { type: 'basic' } |
 *                  { type: 'header', headerName, valuePrefix? } — the
 *                  credential reference is left for the admin to pick
 *   credentialHint { en, de } where to create the key (entries with a key)
 *   notes          { en, de } optional setup notes (regions, URL options)
 *   docsUrl        vendor documentation for the MCP server
 *   tags           extra search terms
 */

export const MCP_CATALOG_CATEGORIES = [
  'documentation',
  'development',
  'productivity',
  'content',
  'automation',
  'customer',
  'analytics',
  'data',
  'finance'
];

export const MCP_SERVER_CATALOG = [
  // --- Documentation ---------------------------------------------------------
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    vendor: 'Microsoft',
    category: 'documentation',
    description: {
      en: 'Search and read official Microsoft documentation and code samples for Azure, Microsoft 365, .NET and more.',
      de: 'Offizielle Microsoft-Dokumentation und Codebeispiele zu Azure, Microsoft 365, .NET und mehr durchsuchen und lesen.'
    },
    transport: { type: 'streamableHttp', url: 'https://learn.microsoft.com/api/mcp' },
    auth: { type: 'none' },
    docsUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
    tags: ['azure', 'microsoft 365', '.net', 'docs']
  },
  {
    id: 'context7',
    name: 'Context7',
    vendor: 'Upstash',
    category: 'documentation',
    description: {
      en: 'Up-to-date, version-specific documentation and code examples for thousands of libraries and frameworks.',
      de: 'Aktuelle, versionsgenaue Dokumentation und Codebeispiele für Tausende Bibliotheken und Frameworks.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.context7.com/mcp' },
    auth: { type: 'none' },
    notes: {
      en: 'Works without a key. For higher rate limits, create an API key on context7.com and switch the authentication to Bearer token.',
      de: 'Funktioniert ohne Schlüssel. Für höhere Limits auf context7.com einen API-Schlüssel erstellen und die Authentifizierung auf Bearer-Token umstellen.'
    },
    docsUrl: 'https://context7.com/docs/resources/all-clients',
    tags: ['libraries', 'frameworks', 'code', 'docs']
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    vendor: 'Cognition',
    category: 'documentation',
    description: {
      en: 'Ask questions about public GitHub repositories and read their generated architecture documentation.',
      de: 'Fragen zu öffentlichen GitHub-Repositories stellen und deren generierte Architekturdokumentation lesen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.deepwiki.com/mcp' },
    auth: { type: 'none' },
    notes: {
      en: 'Covers public repositories only.',
      de: 'Deckt nur öffentliche Repositories ab.'
    },
    docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    tags: ['github', 'repositories', 'code']
  },
  {
    id: 'astro-docs',
    name: 'Astro Docs',
    vendor: 'Astro',
    category: 'documentation',
    description: {
      en: 'Search the official documentation of the Astro web framework.',
      de: 'Die offizielle Dokumentation des Web-Frameworks Astro durchsuchen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.docs.astro.build/mcp' },
    auth: { type: 'none' },
    docsUrl: 'https://docs.astro.build/en/guides/build-with-ai/',
    tags: ['web', 'framework', 'docs']
  },

  // --- Development & operations ----------------------------------------------
  {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    category: 'development',
    description: {
      en: 'Work with repositories, issues, pull requests, code search and Actions.',
      de: 'Mit Repositories, Issues, Pull Requests, Codesuche und Actions arbeiten.'
    },
    transport: { type: 'streamableHttp', url: 'https://api.githubcopilot.com/mcp/' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create a personal access token under GitHub Settings → Developer settings → Personal access tokens, with the scopes the tools need (for example repo, read:org).',
      de: 'Persönliches Zugriffstoken unter GitHub Settings → Developer settings → Personal access tokens erstellen, mit den Scopes, die die Tools brauchen (z. B. repo, read:org).'
    },
    notes: {
      en: 'Use https://api.githubcopilot.com/mcp/readonly for read-only tools. GitHub Enterprise Cloud with data residency uses https://copilot-api.<subdomain>.ghe.com/mcp; GitHub Enterprise Server is not supported.',
      de: 'Mit https://api.githubcopilot.com/mcp/readonly nur lesende Tools nutzen. GitHub Enterprise Cloud mit Datenresidenz nutzt https://copilot-api.<subdomain>.ghe.com/mcp; GitHub Enterprise Server wird nicht unterstützt.'
    },
    docsUrl:
      'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server',
    tags: ['git', 'code', 'issues', 'pull requests']
  },
  {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    category: 'development',
    description: {
      en: 'Investigate errors, issues, traces and releases, and query events across projects.',
      de: 'Fehler, Issues, Traces und Releases untersuchen und Events projektübergreifend abfragen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.sentry.dev/mcp' },
    auth: { type: 'header', headerName: 'Authorization', valuePrefix: 'Sentry-Bearer ' },
    credentialHint: {
      en: 'Create a user auth token in Sentry (User settings → User Auth Tokens) with org:read, project:read, project:write, team:read, team:write and event:write.',
      de: 'User Auth Token in Sentry erstellen (User settings → User Auth Tokens) mit org:read, project:read, project:write, team:read, team:write und event:write.'
    },
    notes: {
      en: 'Sentry expects the “Sentry-Bearer” scheme, not “Bearer”. Append /<organization> or /<organization>/<project> to the URL to limit the scope.',
      de: 'Sentry erwartet das Schema „Sentry-Bearer“, nicht „Bearer“. Mit /<organisation> oder /<organisation>/<projekt> an der URL den Umfang eingrenzen.'
    },
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
    tags: ['errors', 'monitoring', 'observability']
  },
  {
    id: 'postman',
    name: 'Postman',
    vendor: 'Postman',
    category: 'development',
    description: {
      en: 'Manage Postman workspaces, collections, environments and API specifications.',
      de: 'Postman-Workspaces, Collections, Umgebungen und API-Spezifikationen verwalten.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.postman.com/minimal' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create a Postman API key under Settings → API keys (postman.postman.co/settings/me/api-keys).',
      de: 'Postman-API-Schlüssel unter Settings → API keys erstellen (postman.postman.co/settings/me/api-keys).'
    },
    notes: {
      en: '/minimal offers the essential tools; use /mcp for the full tool set or /code for code generation. The EU region uses https://mcp.eu.postman.com.',
      de: '/minimal bietet die wichtigsten Tools; /mcp für alle Tools oder /code für Codegenerierung verwenden. Die EU-Region nutzt https://mcp.eu.postman.com.'
    },
    docsUrl: 'https://learning.postman.com/docs/developer/postman-api/postman-mcp-server/',
    tags: ['api', 'testing', 'collections']
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    vendor: 'Cloudflare',
    category: 'development',
    description: {
      en: 'Manage a Cloudflare account through the Cloudflare API: Workers, DNS, R2, KV and more.',
      de: 'Ein Cloudflare-Konto über die Cloudflare-API verwalten: Workers, DNS, R2, KV und mehr.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.cloudflare.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API token at dash.cloudflare.com/profile/api-tokens with only the permissions needed. Tokens with IP filtering are not supported.',
      de: 'API-Token unter dash.cloudflare.com/profile/api-tokens mit nur den nötigen Berechtigungen erstellen. Tokens mit IP-Filter werden nicht unterstützt.'
    },
    docsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    tags: ['workers', 'dns', 'r2', 'cdn']
  },
  {
    id: 'supabase',
    name: 'Supabase',
    vendor: 'Supabase',
    category: 'development',
    description: {
      en: 'Query and manage Supabase projects: database, tables, migrations, edge functions and logs.',
      de: 'Supabase-Projekte abfragen und verwalten: Datenbank, Tabellen, Migrationen, Edge Functions und Logs.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.supabase.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create a personal access token in the Supabase dashboard under Account → Access Tokens (project API keys do not work).',
      de: 'Persönliches Zugriffstoken im Supabase-Dashboard unter Account → Access Tokens erstellen (Projekt-API-Schlüssel funktionieren nicht).'
    },
    notes: {
      en: 'Recommended: append ?project_ref=<project-ref>&read_only=true to limit the server to one project and read-only queries.',
      de: 'Empfohlen: ?project_ref=<projekt-ref>&read_only=true an die URL anhängen, um den Server auf ein Projekt und lesende Abfragen zu beschränken.'
    },
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    tags: ['postgres', 'database', 'sql']
  },
  {
    id: 'neon',
    name: 'Neon',
    vendor: 'Neon',
    category: 'development',
    description: {
      en: 'Manage serverless Postgres projects and branches on Neon and run SQL queries.',
      de: 'Serverlose Postgres-Projekte und -Branches auf Neon verwalten und SQL-Abfragen ausführen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.neon.tech/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API key in the Neon Console under Settings → API keys.',
      de: 'API-Schlüssel in der Neon Console unter Settings → API keys erstellen.'
    },
    notes: {
      en: 'Append ?readonly=true for read-only tools, or ?projectId=<id> to limit the server to one project.',
      de: 'Mit ?readonly=true nur lesende Tools nutzen oder mit ?projectId=<id> auf ein Projekt beschränken.'
    },
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    tags: ['postgres', 'database', 'sql']
  },
  {
    id: 'render',
    name: 'Render',
    vendor: 'Render',
    category: 'development',
    description: {
      en: 'Inspect Render services, deploys, logs and metrics, and update environment variables.',
      de: 'Render-Services, Deploys, Logs und Metriken einsehen und Umgebungsvariablen ändern.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.render.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API key in the Render dashboard under Account Settings → API Keys.',
      de: 'API-Schlüssel im Render-Dashboard unter Account Settings → API Keys erstellen.'
    },
    docsUrl: 'https://render.com/docs/mcp-server',
    tags: ['hosting', 'deploy', 'cloud']
  },
  {
    id: 'buildkite',
    name: 'Buildkite',
    vendor: 'Buildkite',
    category: 'development',
    description: {
      en: 'Inspect Buildkite pipelines, builds, jobs and logs.',
      de: 'Buildkite-Pipelines, Builds, Jobs und Logs einsehen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.buildkite.com/direct' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API access token under Personal Settings → API Access Tokens; its REST scopes decide which tools work.',
      de: 'API Access Token unter Personal Settings → API Access Tokens erstellen; seine REST-Scopes bestimmen, welche Tools funktionieren.'
    },
    notes: {
      en: 'Tokens only work on the /direct endpoint. Add the header “X-Buildkite-Readonly: true” to hide tools that change data.',
      de: 'Tokens funktionieren nur am Endpunkt /direct. Mit dem Header „X-Buildkite-Readonly: true“ werden Tools ausgeblendet, die Daten ändern.'
    },
    docsUrl: 'https://buildkite.com/docs/apis/mcp-server/remote/configuring-ai-tools',
    tags: ['ci', 'cd', 'pipelines', 'builds']
  },
  {
    id: 'honeycomb',
    name: 'Honeycomb',
    vendor: 'Honeycomb',
    category: 'development',
    description: {
      en: 'Query observability data, traces, boards, triggers and SLOs in Honeycomb.',
      de: 'Observability-Daten, Traces, Boards, Trigger und SLOs in Honeycomb abfragen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.honeycomb.io/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'A team owner creates a Management API key (Team Settings → API Keys) with the Model Context Protocol and Environments permissions. Store it as <KEY_ID>:<KEY_SECRET>.',
      de: 'Ein Team-Owner erstellt einen Management-API-Schlüssel (Team Settings → API Keys) mit den Berechtigungen Model Context Protocol und Environments. Als <KEY_ID>:<KEY_SECRET> speichern.'
    },
    notes: {
      en: 'EU teams use https://mcp.eu1.honeycomb.io/mcp.',
      de: 'EU-Teams nutzen https://mcp.eu1.honeycomb.io/mcp.'
    },
    docsUrl: 'https://docs.honeycomb.io/integrations/mcp/configuration-guide',
    tags: ['observability', 'tracing', 'slo']
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    vendor: 'PagerDuty',
    category: 'development',
    description: {
      en: 'Look up incidents, services, schedules and on-call rotations in PagerDuty.',
      de: 'Incidents, Services, Dienstpläne und Rufbereitschaften in PagerDuty abrufen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.pagerduty.com/mcp' },
    auth: { type: 'header', headerName: 'Authorization', valuePrefix: 'Token token=' },
    credentialHint: {
      en: 'Use a PagerDuty user API token (My Profile → User Settings) or an account API key (Integrations → API Access Keys).',
      de: 'PagerDuty-User-API-Token (My Profile → User Settings) oder Account-API-Schlüssel (Integrations → API Access Keys) verwenden.'
    },
    notes: {
      en: 'EU accounts use https://mcp.eu.pagerduty.com/mcp.',
      de: 'EU-Konten nutzen https://mcp.eu.pagerduty.com/mcp.'
    },
    docsUrl: 'https://support.pagerduty.com/main/docs/pagerduty-mcp-server-integration-guide',
    tags: ['incidents', 'on-call', 'operations']
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    vendor: 'Braintrust',
    category: 'development',
    description: {
      en: 'Search Braintrust experiments, datasets and logs for evaluating AI applications.',
      de: 'Braintrust-Experimente, Datasets und Logs zur Evaluierung von KI-Anwendungen durchsuchen.'
    },
    transport: { type: 'streamableHttp', url: 'https://api.braintrust.dev/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API key in Braintrust under Settings → API keys; the server acts with its owner’s permissions.',
      de: 'API-Schlüssel in Braintrust unter Settings → API keys erstellen; der Server handelt mit den Rechten des Besitzers.'
    },
    notes: {
      en: 'The EU region uses https://api-eu.braintrust.dev/mcp.',
      de: 'Die EU-Region nutzt https://api-eu.braintrust.dev/mcp.'
    },
    docsUrl: 'https://www.braintrust.dev/docs/reference/mcp',
    tags: ['evals', 'llm', 'observability']
  },

  // --- Productivity ----------------------------------------------------------
  {
    id: 'atlassian',
    name: 'Atlassian (Jira & Confluence)',
    vendor: 'Atlassian',
    category: 'productivity',
    description: {
      en: 'Search, create and update Jira issues and Confluence pages.',
      de: 'Jira-Issues und Confluence-Seiten suchen, erstellen und bearbeiten.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.atlassian.com/v2/mcp' },
    auth: { type: 'basic' },
    credentialHint: {
      en: 'Enter the Atlassian account email as username and store a scoped API token (id.atlassian.com/manage-profile/security/api-tokens) as the password.',
      de: 'Die E-Mail-Adresse des Atlassian-Kontos als Benutzername eintragen und ein API-Token mit Scopes (id.atlassian.com/manage-profile/security/api-tokens) als Passwort speichern.'
    },
    notes: {
      en: 'An Atlassian organization admin must allow API-token authentication for the Rovo MCP server. For a service account, use Bearer token with its API key instead. Compass tools are not available with API tokens.',
      de: 'Ein Atlassian-Organisationsadmin muss die API-Token-Authentifizierung für den Rovo-MCP-Server erlauben. Für ein Servicekonto stattdessen Bearer-Token mit dessen API-Schlüssel verwenden. Compass-Tools sind mit API-Tokens nicht verfügbar.'
    },
    docsUrl:
      'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token/',
    tags: ['jira', 'confluence', 'rovo', 'issues', 'wiki']
  },
  {
    id: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    category: 'productivity',
    description: {
      en: 'Find, create and update Linear issues, projects and comments.',
      de: 'Linear-Issues, Projekte und Kommentare finden, erstellen und bearbeiten.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.linear.app/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create a personal API key in Linear under Settings → Account → Security & Access. A key with read permission only gives read-only access.',
      de: 'Persönlichen API-Schlüssel in Linear unter Settings → Account → Security & Access erstellen. Ein Schlüssel nur mit Leserecht erlaubt nur lesenden Zugriff.'
    },
    docsUrl: 'https://linear.app/docs/mcp',
    tags: ['issues', 'project management', 'tickets']
  },
  {
    id: 'monday',
    name: 'monday.com',
    vendor: 'monday.com',
    category: 'productivity',
    description: {
      en: 'Read and update monday.com boards, items, updates and workspaces.',
      de: 'monday.com-Boards, Items, Updates und Workspaces lesen und bearbeiten.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.monday.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create a personal API token via your profile picture → Developers → My access tokens. It acts with that user’s permissions.',
      de: 'Persönliches API-Token über das Profilbild → Developers → My access tokens erstellen. Es handelt mit den Rechten dieses Benutzers.'
    },
    docsUrl: 'https://developer.monday.com/api-reference/docs/mcp-api-token',
    tags: ['project management', 'boards', 'tasks']
  },
  {
    id: 'coda',
    name: 'Coda',
    vendor: 'Coda',
    category: 'productivity',
    description: {
      en: 'Read and edit Coda docs, pages and tables.',
      de: 'Coda-Dokumente, Seiten und Tabellen lesen und bearbeiten.'
    },
    transport: { type: 'streamableHttp', url: 'https://coda.io/apis/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Generate an API token under Account settings → API settings and set its restriction type to “MCP”.',
      de: 'API-Token unter Account settings → API settings erzeugen und die Einschränkung auf „MCP“ setzen.'
    },
    docsUrl: 'https://help.coda.io/hc/en-us/articles/44722661982989-Connect-to-the-Coda-MCP',
    tags: ['docs', 'wiki', 'tables']
  },

  // --- Content & media -------------------------------------------------------
  {
    id: 'sanity',
    name: 'Sanity',
    vendor: 'Sanity',
    category: 'content',
    description: {
      en: 'Query and edit structured content, schemas and releases in Sanity.',
      de: 'Strukturierte Inhalte, Schemas und Releases in Sanity abfragen und bearbeiten.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.sanity.io' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API token at sanity.io/manage (project → API → Tokens); tools are limited to the token’s role.',
      de: 'API-Token unter sanity.io/manage erstellen (Projekt → API → Tokens); die Tools sind auf die Rolle des Tokens beschränkt.'
    },
    docsUrl: 'https://www.sanity.io/docs/ai/mcp-server',
    tags: ['cms', 'headless', 'content']
  },
  {
    id: 'cloudinary',
    name: 'Cloudinary',
    vendor: 'Cloudinary',
    category: 'content',
    description: {
      en: 'Search, upload, tag and transform images and videos in Cloudinary.',
      de: 'Bilder und Videos in Cloudinary suchen, hochladen, verschlagworten und transformieren.'
    },
    transport: {
      type: 'streamableHttp',
      url: 'https://asset-management.mcp.cloudinary.com/mcp'
    },
    auth: { type: 'header', headerName: 'cloudinary-url' },
    credentialHint: {
      en: 'Store the environment URL cloudinary://<api_key>:<api_secret>@<cloud_name> from Console → Settings → API Keys.',
      de: 'Die Umgebungs-URL cloudinary://<api_key>:<api_secret>@<cloud_name> aus Console → Settings → API Keys speichern.'
    },
    docsUrl: 'https://cloudinary.com/documentation/cloudinary_llm_mcp',
    tags: ['images', 'video', 'assets', 'dam']
  },
  {
    id: 'wix',
    name: 'Wix',
    vendor: 'Wix',
    category: 'content',
    description: {
      en: 'Manage Wix sites and the business data behind them.',
      de: 'Wix-Websites und die zugehörigen Geschäftsdaten verwalten.'
    },
    transport: {
      type: 'streamableHttp',
      url: 'https://mcp.wix.com/mcp',
      headers: { 'wix-account-id': 'YOUR_WIX_ACCOUNT_ID' }
    },
    auth: { type: 'header', headerName: 'Authorization' },
    credentialHint: {
      en: 'Create an API key in the Wix API Keys Manager with the permissions the tools need.',
      de: 'API-Schlüssel im Wix API Keys Manager mit den nötigen Berechtigungen erstellen.'
    },
    notes: {
      en: 'Replace YOUR_WIX_ACCOUNT_ID in the additional headers with your Wix account ID. The key is sent without a “Bearer” prefix.',
      de: 'YOUR_WIX_ACCOUNT_ID in den zusätzlichen Headern durch die eigene Wix-Konto-ID ersetzen. Der Schlüssel wird ohne „Bearer“-Präfix gesendet.'
    },
    docsUrl: 'https://dev.wix.com/docs/overview/ai-the-wix-platform/the-wix-mcp',
    tags: ['website', 'cms', 'e-commerce']
  },

  // --- Automation & web ------------------------------------------------------
  {
    id: 'zapier',
    name: 'Zapier',
    vendor: 'Zapier',
    category: 'automation',
    description: {
      en: 'Run actions in thousands of apps through the actions configured on a Zapier MCP server.',
      de: 'Aktionen in Tausenden Apps über die auf einem Zapier-MCP-Server konfigurierten Aktionen ausführen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.zapier.com/api/v1/connect' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'At mcp.zapier.com create a server, add the actions it may run, then generate a token on its Connect tab.',
      de: 'Auf mcp.zapier.com einen Server anlegen, die erlaubten Aktionen hinzufügen und im Tab „Connect“ ein Token erzeugen.'
    },
    docsUrl: 'https://docs.zapier.com/mcp/get-started/connect/openai-api',
    tags: ['workflows', 'integrations', 'no-code']
  },
  {
    id: 'apify',
    name: 'Apify',
    vendor: 'Apify',
    category: 'automation',
    description: {
      en: 'Run Apify Actors for web scraping, crawling and data extraction.',
      de: 'Apify-Actors für Web-Scraping, Crawling und Datenextraktion ausführen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.apify.com' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Copy your API token from the Apify Console under Settings → API & Integrations.',
      de: 'API-Token in der Apify Console unter Settings → API & Integrations kopieren.'
    },
    notes: {
      en: 'Append ?tools=actors,docs,apify/rag-web-browser (for example) to choose the tools and Actors.',
      de: 'Mit ?tools=actors,docs,apify/rag-web-browser (Beispiel) an der URL die Tools und Actors auswählen.'
    },
    docsUrl: 'https://docs.apify.com/integrations/mcp',
    tags: ['scraping', 'crawler', 'web data']
  },
  {
    id: 'browser-use',
    name: 'Browser Use',
    vendor: 'Browser Use',
    category: 'automation',
    description: {
      en: 'Let a cloud browser agent navigate websites, fill in forms and extract information.',
      de: 'Einen Cloud-Browser-Agenten Websites bedienen, Formulare ausfüllen und Informationen auslesen lassen.'
    },
    transport: { type: 'streamableHttp', url: 'https://api.browser-use.com/v3/mcp' },
    auth: { type: 'header', headerName: 'X-Browser-Use-API-Key' },
    credentialHint: {
      en: 'Create an API key at cloud.browser-use.com under Settings → API keys. Usage is billed by Browser Use.',
      de: 'API-Schlüssel auf cloud.browser-use.com unter Settings → API keys erstellen. Die Nutzung wird von Browser Use abgerechnet.'
    },
    docsUrl: 'https://docs.browser-use.com/cloud/guides/mcp-server',
    tags: ['browser', 'web automation', 'agent']
  },
  {
    id: 'superglue',
    name: 'superglue',
    vendor: 'superglue',
    category: 'automation',
    description: {
      en: 'Discover and run prebuilt integration tools that connect APIs and systems.',
      de: 'Vorgefertigte Integrationstools finden und ausführen, die APIs und Systeme verbinden.'
    },
    transport: { type: 'streamableHttp', url: 'https://api.superglue.cloud/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API key at app.superglue.cloud via the organization menu → API Keys.',
      de: 'API-Schlüssel auf app.superglue.cloud über das Organisationsmenü → API Keys erstellen.'
    },
    docsUrl: 'https://superglue.ai/docs/mcp/using-the-mcp/',
    tags: ['integrations', 'api', 'workflows']
  },

  // --- Sales & support -------------------------------------------------------
  {
    id: 'close',
    name: 'Close',
    vendor: 'Close',
    category: 'customer',
    description: {
      en: 'Search and update leads, contacts, opportunities and activities in the Close CRM.',
      de: 'Leads, Kontakte, Opportunities und Aktivitäten im Close-CRM suchen und bearbeiten.'
    },
    transport: {
      type: 'streamableHttp',
      url: 'https://mcp.close.com/mcp',
      headers: { 'Close-Scope': 'mcp.read' }
    },
    auth: { type: 'header', headerName: 'Close-API-Key' },
    credentialHint: {
      en: 'Create an API key in Close under Settings → Developer → API Keys. Each key belongs to one user.',
      de: 'API-Schlüssel in Close unter Settings → Developer → API Keys erstellen. Jeder Schlüssel gehört zu einem Benutzer.'
    },
    notes: {
      en: 'The Close-Scope header starts read-only (mcp.read). Change it to mcp.write_safe or mcp.write_destructive to allow changes.',
      de: 'Der Header Close-Scope ist zunächst nur lesend (mcp.read). Für Änderungen auf mcp.write_safe oder mcp.write_destructive setzen.'
    },
    docsUrl: 'https://developer.close.com/mcp',
    tags: ['crm', 'sales', 'leads']
  },
  {
    id: 'intercom',
    name: 'Intercom',
    vendor: 'Intercom',
    category: 'customer',
    description: {
      en: 'Search conversations, contacts, companies and help-center articles, and add internal notes.',
      de: 'Konversationen, Kontakte, Firmen und Help-Center-Artikel durchsuchen und interne Notizen hinzufügen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.intercom.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Use the access token of an Intercom app: Developer Hub → your app → Configure → Authentication.',
      de: 'Access Token einer Intercom-App verwenden: Developer Hub → App → Configure → Authentication.'
    },
    notes: {
      en: 'EU-hosted workspaces use https://mcp.eu.intercom.com/mcp. Australian workspaces are not supported.',
      de: 'In der EU gehostete Workspaces nutzen https://mcp.eu.intercom.com/mcp. Australische Workspaces werden nicht unterstützt.'
    },
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    tags: ['support', 'helpdesk', 'crm']
  },
  {
    id: 'fireflies',
    name: 'Fireflies.ai',
    vendor: 'Fireflies.ai',
    category: 'customer',
    description: {
      en: 'Search meeting transcripts, summaries and action items recorded by Fireflies.',
      de: 'Von Fireflies aufgezeichnete Meeting-Transkripte, Zusammenfassungen und Aufgaben durchsuchen.'
    },
    transport: { type: 'streamableHttp', url: 'https://api.fireflies.ai/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API key in Fireflies under Settings → Developer Settings. It acts with that user’s permissions.',
      de: 'API-Schlüssel in Fireflies unter Settings → Developer Settings erstellen. Er handelt mit den Rechten dieses Benutzers.'
    },
    docsUrl: 'https://docs.fireflies.ai/getting-started/mcp-configuration',
    tags: ['meetings', 'transcripts', 'notes']
  },
  {
    id: 'modjo',
    name: 'Modjo',
    vendor: 'Modjo',
    category: 'customer',
    description: {
      en: 'Analyse recorded sales calls, deals and accounts.',
      de: 'Aufgezeichnete Verkaufsgespräche, Deals und Accounts analysieren.'
    },
    transport: { type: 'streamableHttp', url: 'https://api.mcp.modjo.ai/v1/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'An administrator creates the key in Modjo under Settings → Integrations → Modjo API key. It covers the whole workspace.',
      de: 'Ein Administrator erstellt den Schlüssel in Modjo unter Settings → Integrations → Modjo API key. Er gilt für den gesamten Workspace.'
    },
    docsUrl: 'https://help.modjo.ai/en/articles/15459539-set-up-and-use-the-modjo-mcp',
    tags: ['sales', 'calls', 'conversation intelligence']
  },

  // --- Analytics -------------------------------------------------------------
  {
    id: 'posthog',
    name: 'PostHog',
    vendor: 'PostHog',
    category: 'analytics',
    description: {
      en: 'Query product analytics, insights, feature flags, experiments and error tracking.',
      de: 'Produktanalysen, Insights, Feature Flags, Experimente und Fehler-Tracking abfragen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.posthog.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create a personal API key with the “MCP Server” preset under Settings → Personal API keys (keys start with phx_).',
      de: 'Persönlichen API-Schlüssel mit der Vorlage „MCP Server“ unter Settings → Personal API keys erstellen (beginnt mit phx_).'
    },
    notes: {
      en: 'EU Cloud projects use https://mcp-eu.posthog.com/mcp. Add ?features=flags,dashboards (for example) to the URL to limit the tools to those areas.',
      de: 'Projekte in der EU Cloud nutzen https://mcp-eu.posthog.com/mcp. Mit ?features=flags,dashboards (Beispiel) an der URL werden die Tools auf diese Bereiche beschränkt.'
    },
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    tags: ['product analytics', 'feature flags', 'errors']
  },

  // --- Data & research -------------------------------------------------------
  {
    id: 'hugging-face',
    name: 'Hugging Face',
    vendor: 'Hugging Face',
    category: 'data',
    description: {
      en: 'Search models, datasets, Spaces and papers on the Hugging Face Hub.',
      de: 'Modelle, Datasets, Spaces und Paper auf dem Hugging Face Hub durchsuchen.'
    },
    transport: { type: 'streamableHttp', url: 'https://huggingface.co/mcp' },
    auth: { type: 'none' },
    notes: {
      en: 'Works without a token with a reduced tool set. For all tools, create an access token at huggingface.co/settings/tokens, switch the authentication to Bearer token, and pick tools and Spaces at huggingface.co/settings/mcp.',
      de: 'Funktioniert ohne Token mit weniger Tools. Für alle Tools ein Access Token unter huggingface.co/settings/tokens erstellen, die Authentifizierung auf Bearer-Token umstellen und Tools sowie Spaces unter huggingface.co/settings/mcp auswählen.'
    },
    docsUrl: 'https://huggingface.co/docs/hub/hf-mcp-server',
    tags: ['models', 'datasets', 'ml', 'papers']
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    vendor: 'Google',
    category: 'data',
    description: {
      en: 'Ground answers in Google Maps data: places, addresses and routes (Maps Grounding Lite).',
      de: 'Antworten mit Google-Maps-Daten untermauern: Orte, Adressen und Routen (Maps Grounding Lite).'
    },
    transport: { type: 'streamableHttp', url: 'https://mapstools.googleapis.com/mcp' },
    auth: { type: 'header', headerName: 'X-Goog-Api-Key' },
    credentialHint: {
      en: 'Enable the “Maps Grounding Lite API” in a Google Cloud project and create an API key under APIs & Services → Credentials. Requests are billed per call.',
      de: 'Die „Maps Grounding Lite API“ in einem Google-Cloud-Projekt aktivieren und unter APIs & Services → Credentials einen API-Schlüssel erstellen. Anfragen werden pro Aufruf abgerechnet.'
    },
    docsUrl: 'https://developers.google.com/maps/ai/grounding-lite',
    tags: ['maps', 'places', 'geocoding', 'routes', 'location']
  },
  {
    id: 'statista',
    name: 'Statista',
    vendor: 'Statista',
    category: 'data',
    description: {
      en: 'Search Statista statistics and retrieve chart data for market and consumer research.',
      de: 'Statista-Statistiken durchsuchen und Diagrammdaten für Markt- und Verbraucherforschung abrufen.'
    },
    transport: { type: 'streamableHttp', url: 'https://api.statista.ai/v1/mcp' },
    auth: { type: 'header', headerName: 'x-api-key' },
    credentialHint: {
      en: 'Statista issues the API key after you request access at platform.statista.ai; it requires a Statista contract.',
      de: 'Statista stellt den API-Schlüssel nach einer Zugangsanfrage auf platform.statista.ai aus; ein Statista-Vertrag ist erforderlich.'
    },
    docsUrl: 'https://docs.platform.statista.ai/mcp-server/introduction',
    tags: ['statistics', 'market research']
  },
  {
    id: 'primamcp',
    name: 'PRIMAMCP',
    vendor: 'PLANIT PRIMA',
    category: 'data',
    description: {
      en: 'Look up German and EU legal information for legal research.',
      de: 'Rechtsinformationen zu deutschem und EU-Recht für die juristische Recherche abrufen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.planitprima.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API key (starts with sk-legal-) at mcp.planitprima.com/keys; it is shown only once. The free tier allows 150 requests per month.',
      de: 'API-Schlüssel (beginnt mit sk-legal-) unter mcp.planitprima.com/keys erstellen; er wird nur einmal angezeigt. Der kostenlose Tarif erlaubt 150 Anfragen pro Monat.'
    },
    docsUrl: 'https://mcp.planitprima.com/docs',
    tags: ['legal', 'law', 'germany', 'eu', 'lawbster']
  },

  // --- Finance & payments ----------------------------------------------------
  {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    category: 'finance',
    description: {
      en: 'Work with Stripe customers, payments, invoices, subscriptions and products, and search the Stripe docs.',
      de: 'Mit Stripe-Kunden, Zahlungen, Rechnungen, Abos und Produkten arbeiten und die Stripe-Dokumentation durchsuchen.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.stripe.com' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an agent API key (Dashboard → API keys, shown with an “Agent” badge) with only the permissions needed. From 31 October 2026 Stripe MCP rejects secret keys and restricted keys without the Agent tag.',
      de: 'Agent-API-Schlüssel erstellen (Dashboard → API keys, mit „Agent“-Kennzeichnung) und nur die nötigen Berechtigungen vergeben. Ab 31. Oktober 2026 lehnt Stripe MCP Secret Keys und Restricted Keys ohne Agent-Kennzeichnung ab.'
    },
    notes: {
      en: 'Test in a sandbox first. Stripe asks for human confirmation of some write actions, such as refunds.',
      de: 'Zuerst in einer Sandbox testen. Für manche schreibenden Aktionen, etwa Erstattungen, verlangt Stripe eine Bestätigung durch einen Menschen.'
    },
    docsUrl: 'https://docs.stripe.com/mcp',
    tags: ['payments', 'billing', 'subscriptions', 'invoices']
  },
  {
    id: 'debitura',
    name: 'Debitura',
    vendor: 'Debitura',
    category: 'finance',
    description: {
      en: 'Work with cross-border debt collection cases on the Debitura platform.',
      de: 'Mit grenzüberschreitenden Inkassofällen auf der Debitura-Plattform arbeiten.'
    },
    transport: { type: 'streamableHttp', url: 'https://mcp.debitura.com/mcp' },
    auth: { type: 'bearer' },
    credentialHint: {
      en: 'Create an API key at app.debitura.com/CreditorApiKey. Each key is tied to one creditor account.',
      de: 'API-Schlüssel unter app.debitura.com/CreditorApiKey erstellen. Jeder Schlüssel gehört zu einem Gläubigerkonto.'
    },
    docsUrl: 'https://github.com/debitura/Debitura.MCP',
    tags: ['debt collection', 'receivables', 'invoices']
  }
];
