// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V213 — hosted MCP definitions move to the marketplace
 *
 * 29 definitions of hosted MCP servers (`mcp/<name>`: GitHub, Linear,
 * Stripe, Zapier, …) no longer ship in `server/defaults/integration-definitions/`;
 * they are integration items of the iHub Official Marketplace
 * (`integrations/mcp__<name>/` in intrafind/ihub-marketplace), where they are
 * updated without an iHub release. Admin → Integrations → Catalog lists them
 * from the marketplace and installs them from there.
 *
 * An installation of one of them would lose its definition on upgrade. For
 * every definition an installation in `config/integrations.json` uses, this
 * migration writes the marketplace's 1.0.0 copy (the shipped definition
 * without `builtIn`, plus its first release entry) to
 * `contents/integration-definitions/mcp__<name>/integration.json` and records
 * it in `config/installations.json` as installed from `ihub-official`, so the
 * installation keeps working, its tool ids stay the same, and later versions
 * arrive as marketplace updates. When the `ihub-official` registry is not
 * configured, the copy is written without a record: a local definition the
 * admin maintains.
 *
 * Re-linking: a server converted by V193 on an upgrade from 5.6.x became an
 * installation of the generic `com.intrafind/mcp-server` definition, because
 * V193 matches against the definitions shipped at the time it runs and these
 * no longer ship. So does a server an admin added by hand. Such an
 * installation is moved to the matching `mcp/<name>` definition when that
 * yields exactly the connection it has: the same endpoint (V193's URL
 * comparison: trimmed, trailing `/` ignored, case-insensitive) and
 * transport, the same headers (a definition's fixed header, such as Close's
 * `Close-Scope`, must already be among them), a sign-in mode the definition
 * offers with the same scheme (bearer, or the same header name and prefix),
 * the default tool prefix, MCP App views on, and no reconnect or other
 * setting the definition has no field for. The id, label, credential
 * reference, enabled state, action policy and app bindings stay as they are,
 * so the tool ids do not change; the timeout moves from the values onto the
 * installation, as V193 does for a matched server. An installation that does
 * not qualify stays generic and the log says why.
 *
 * A definition folder that already exists (installed from a registry or by
 * hand) is left as it is, and so is an existing record; a generic
 * installation is re-linked to it only when it holds the snapshot's version. Definitions no
 * installation uses are not written; the catalog offers them from the
 * marketplace. Idempotent: a second run finds the folders and changes
 * nothing.
 *
 * The definitions are a snapshot inlined below (the per-server data and the
 * shape they share). Do NOT replace them with a read of the marketplace or of
 * `server/defaults/` — migrations must be self-contained.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const version = '213';
export const description = 'mcp_definitions_to_marketplace';

const INTEGRATIONS_FILE = 'config/integrations.json';
const INSTALLATIONS_FILE = 'config/installations.json';
const REGISTRIES_FILE = 'config/registries.json';
const DEFINITIONS_DIR = 'integration-definitions';
const REGISTRY_ID = 'ihub-official';
const INSTALLED_BY = 'migration V213';
const GENERIC_DEFINITION = 'com.intrafind/mcp-server';
/** The cap of an installation's own timeout (snapshot of V193's MAX_INSTANCE_TIMEOUT_MS). */
const MAX_INSTANCE_TIMEOUT_MS = 120000;
/** The generic definition's reconnect defaults (snapshot as of V213). */
const RECONNECT_DEFAULTS = {
  reconnectEnabled: true,
  reconnectMaxRetries: 5,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  reconnectGrowthFactor: 1.5
};

/**
 * What differs between the 29 moved definitions (snapshot of 2026-11-03):
 * names, texts, publisher, category, endpoint, fixed headers, how the key is
 * sent (`account`, absent for a keyless server), where to create the key
 * (`keyHelp`) and the tags. {@link movedDefinition} builds the full
 * definition from it, exactly as the marketplace publishes it.
 */
const SERVERS = {
  apify: {
    name: { en: 'Apify', de: 'Apify' },
    description: {
      en: 'Run Apify Actors for web scraping, crawling and data extraction.\n\nAppend ?tools=actors,docs,apify/rag-web-browser (for example) to choose the tools and Actors.',
      de: 'Apify-Actors für Web-Scraping, Crawling und Datenextraktion ausführen.\n\nMit ?tools=actors,docs,apify/rag-web-browser (Beispiel) an der URL die Tools und Actors auswählen.'
    },
    publisher: 'Apify',
    category: 'automation',
    docsUrl: 'https://docs.apify.com/integrations/mcp',
    url: 'https://mcp.apify.com',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Copy your API token from the Apify Console under Settings → API & Integrations.',
      de: 'API-Token in der Apify Console unter Settings → API & Integrations kopieren.'
    },
    tags: ['scraping', 'crawler', 'web data']
  },
  'astro-docs': {
    name: { en: 'Astro Docs', de: 'Astro Docs' },
    description: {
      en: 'Search the official documentation of the Astro web framework.',
      de: 'Die offizielle Dokumentation des Web-Frameworks Astro durchsuchen.'
    },
    publisher: 'Astro',
    category: 'documentation',
    docsUrl: 'https://docs.astro.build/en/guides/build-with-ai/',
    url: 'https://mcp.docs.astro.build/mcp',
    tags: ['web', 'framework', 'docs']
  },
  braintrust: {
    name: { en: 'Braintrust', de: 'Braintrust' },
    description: {
      en: 'Search Braintrust experiments, datasets and logs for evaluating AI applications.\n\nThe EU region uses https://api-eu.braintrust.dev/mcp.',
      de: 'Braintrust-Experimente, Datasets und Logs zur Evaluierung von KI-Anwendungen durchsuchen.\n\nDie EU-Region nutzt https://api-eu.braintrust.dev/mcp.'
    },
    publisher: 'Braintrust',
    category: 'development',
    docsUrl: 'https://www.braintrust.dev/docs/reference/mcp',
    url: 'https://api.braintrust.dev/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an API key in Braintrust under Settings → API keys; the server acts with its owner’s permissions.',
      de: 'API-Schlüssel in Braintrust unter Settings → API keys erstellen; der Server handelt mit den Rechten des Besitzers.'
    },
    tags: ['evals', 'llm', 'observability']
  },
  'browser-use': {
    name: { en: 'Browser Use', de: 'Browser Use' },
    description: {
      en: 'Let a cloud browser agent navigate websites, fill in forms and extract information.',
      de: 'Einen Cloud-Browser-Agenten Websites bedienen, Formulare ausfüllen und Informationen auslesen lassen.'
    },
    publisher: 'Browser Use',
    category: 'automation',
    docsUrl: 'https://docs.browser-use.com/cloud/guides/mcp-server',
    url: 'https://api.browser-use.com/v3/mcp',
    account: { kind: 'header', header: 'X-Browser-Use-API-Key' },
    keyHelp: {
      en: 'Create an API key at cloud.browser-use.com under Settings → API keys. Usage is billed by Browser Use.',
      de: 'API-Schlüssel auf cloud.browser-use.com unter Settings → API keys erstellen. Die Nutzung wird von Browser Use abgerechnet.'
    },
    tags: ['browser', 'web automation', 'agent']
  },
  buildkite: {
    name: { en: 'Buildkite', de: 'Buildkite' },
    description: {
      en: 'Inspect Buildkite pipelines, builds, jobs and logs.\n\nTokens only work on the /direct endpoint. Add the header “X-Buildkite-Readonly: true” to hide tools that change data.',
      de: 'Buildkite-Pipelines, Builds, Jobs und Logs einsehen.\n\nTokens funktionieren nur am Endpunkt /direct. Mit dem Header „X-Buildkite-Readonly: true“ werden Tools ausgeblendet, die Daten ändern.'
    },
    publisher: 'Buildkite',
    category: 'development',
    docsUrl: 'https://buildkite.com/docs/apis/mcp-server/remote/configuring-ai-tools',
    url: 'https://mcp.buildkite.com/direct',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an API access token under Personal Settings → API Access Tokens; its REST scopes decide which tools work.',
      de: 'API Access Token unter Personal Settings → API Access Tokens erstellen; seine REST-Scopes bestimmen, welche Tools funktionieren.'
    },
    tags: ['ci', 'cd', 'pipelines', 'builds']
  },
  close: {
    name: { en: 'Close', de: 'Close' },
    description: {
      en: 'Search and update leads, contacts, opportunities and activities in the Close CRM.\n\nThe Close-Scope header starts read-only (mcp.read). Change it to mcp.write_safe or mcp.write_destructive to allow changes.',
      de: 'Leads, Kontakte, Opportunities und Aktivitäten im Close-CRM suchen und bearbeiten.\n\nDer Header Close-Scope ist zunächst nur lesend (mcp.read). Für Änderungen auf mcp.write_safe oder mcp.write_destructive setzen.'
    },
    publisher: 'Close',
    category: 'customer',
    docsUrl: 'https://developer.close.com/mcp',
    url: 'https://mcp.close.com/mcp',
    headers: { 'Close-Scope': 'mcp.read' },
    account: { kind: 'header', header: 'Close-API-Key' },
    keyHelp: {
      en: 'Create an API key in Close under Settings → Developer → API Keys. Each key belongs to one user.',
      de: 'API-Schlüssel in Close unter Settings → Developer → API Keys erstellen. Jeder Schlüssel gehört zu einem Benutzer.'
    },
    tags: ['crm', 'sales', 'leads']
  },
  cloudflare: {
    name: { en: 'Cloudflare', de: 'Cloudflare' },
    description: {
      en: 'Manage a Cloudflare account through the Cloudflare API: Workers, DNS, R2, KV and more.',
      de: 'Ein Cloudflare-Konto über die Cloudflare-API verwalten: Workers, DNS, R2, KV und mehr.'
    },
    publisher: 'Cloudflare',
    category: 'development',
    docsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    url: 'https://mcp.cloudflare.com/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an API token at dash.cloudflare.com/profile/api-tokens with only the permissions needed. Tokens with IP filtering are not supported.',
      de: 'API-Token unter dash.cloudflare.com/profile/api-tokens mit nur den nötigen Berechtigungen erstellen. Tokens mit IP-Filter werden nicht unterstützt.'
    },
    tags: ['workers', 'dns', 'r2', 'cdn']
  },
  cloudinary: {
    name: { en: 'Cloudinary', de: 'Cloudinary' },
    description: {
      en: 'Search, upload, tag and transform images and videos in Cloudinary.',
      de: 'Bilder und Videos in Cloudinary suchen, hochladen, verschlagworten und transformieren.'
    },
    publisher: 'Cloudinary',
    category: 'content',
    docsUrl: 'https://cloudinary.com/documentation/cloudinary_llm_mcp',
    url: 'https://asset-management.mcp.cloudinary.com/mcp',
    account: { kind: 'header', header: 'cloudinary-url' },
    keyHelp: {
      en: 'Store the environment URL cloudinary://<api_key>:<api_secret>@<cloud_name> from Console → Settings → API Keys.',
      de: 'Die Umgebungs-URL cloudinary://<api_key>:<api_secret>@<cloud_name> aus Console → Settings → API Keys speichern.'
    },
    tags: ['images', 'video', 'assets', 'dam']
  },
  fireflies: {
    name: { en: 'Fireflies.ai', de: 'Fireflies.ai' },
    description: {
      en: 'Search meeting transcripts, summaries and action items recorded by Fireflies.',
      de: 'Von Fireflies aufgezeichnete Meeting-Transkripte, Zusammenfassungen und Aufgaben durchsuchen.'
    },
    publisher: 'Fireflies.ai',
    category: 'customer',
    docsUrl: 'https://docs.fireflies.ai/getting-started/mcp-configuration',
    url: 'https://api.fireflies.ai/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an API key in Fireflies under Settings → Developer Settings. It acts with that user’s permissions.',
      de: 'API-Schlüssel in Fireflies unter Settings → Developer Settings erstellen. Er handelt mit den Rechten dieses Benutzers.'
    },
    tags: ['meetings', 'transcripts', 'notes']
  },
  github: {
    name: { en: 'GitHub', de: 'GitHub' },
    description: {
      en: 'Work with repositories, issues, pull requests, code search and Actions.\n\nUse https://api.githubcopilot.com/mcp/readonly for read-only tools. GitHub Enterprise Cloud with data residency uses https://copilot-api.<subdomain>.ghe.com/mcp; GitHub Enterprise Server is not supported.',
      de: 'Mit Repositories, Issues, Pull Requests, Codesuche und Actions arbeiten.\n\nMit https://api.githubcopilot.com/mcp/readonly nur lesende Tools nutzen. GitHub Enterprise Cloud mit Datenresidenz nutzt https://copilot-api.<subdomain>.ghe.com/mcp; GitHub Enterprise Server wird nicht unterstützt.'
    },
    publisher: 'GitHub',
    category: 'development',
    docsUrl:
      'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server',
    url: 'https://api.githubcopilot.com/mcp/',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create a personal access token under GitHub Settings → Developer settings → Personal access tokens, with the scopes the tools need (for example repo, read:org).',
      de: 'Persönliches Zugriffstoken unter GitHub Settings → Developer settings → Personal access tokens erstellen, mit den Scopes, die die Tools brauchen (z. B. repo, read:org).'
    },
    tags: ['git', 'code', 'issues', 'pull requests']
  },
  'google-maps': {
    name: { en: 'Google Maps', de: 'Google Maps' },
    description: {
      en: 'Ground answers in Google Maps data: places, addresses and routes (Maps Grounding Lite).',
      de: 'Antworten mit Google-Maps-Daten untermauern: Orte, Adressen und Routen (Maps Grounding Lite).'
    },
    publisher: 'Google',
    category: 'data',
    docsUrl: 'https://developers.google.com/maps/ai/grounding-lite',
    url: 'https://mapstools.googleapis.com/mcp',
    account: { kind: 'header', header: 'X-Goog-Api-Key' },
    keyHelp: {
      en: 'Enable the “Maps Grounding Lite API” in a Google Cloud project and create an API key under APIs & Services → Credentials. Requests are billed per call.',
      de: 'Die „Maps Grounding Lite API“ in einem Google-Cloud-Projekt aktivieren und unter APIs & Services → Credentials einen API-Schlüssel erstellen. Anfragen werden pro Aufruf abgerechnet.'
    },
    tags: ['maps', 'places', 'geocoding', 'routes', 'location']
  },
  honeycomb: {
    name: { en: 'Honeycomb', de: 'Honeycomb' },
    description: {
      en: 'Query observability data, traces, boards, triggers and SLOs in Honeycomb.\n\nEU teams use https://mcp.eu1.honeycomb.io/mcp.',
      de: 'Observability-Daten, Traces, Boards, Trigger und SLOs in Honeycomb abfragen.\n\nEU-Teams nutzen https://mcp.eu1.honeycomb.io/mcp.'
    },
    publisher: 'Honeycomb',
    category: 'development',
    docsUrl: 'https://docs.honeycomb.io/integrations/mcp/configuration-guide',
    url: 'https://mcp.honeycomb.io/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'A team owner creates a Management API key (Team Settings → API Keys) with the Model Context Protocol and Environments permissions. Store it as <KEY_ID>:<KEY_SECRET>.',
      de: 'Ein Team-Owner erstellt einen Management-API-Schlüssel (Team Settings → API Keys) mit den Berechtigungen Model Context Protocol und Environments. Als <KEY_ID>:<KEY_SECRET> speichern.'
    },
    tags: ['observability', 'tracing', 'slo']
  },
  'hugging-face': {
    name: { en: 'Hugging Face', de: 'Hugging Face' },
    description: {
      en: 'Search models, datasets, Spaces and papers on the Hugging Face Hub.\n\nWorks without a token with a reduced tool set. For all tools, create an access token at huggingface.co/settings/tokens, switch the authentication to Bearer token, and pick tools and Spaces at huggingface.co/settings/mcp.',
      de: 'Modelle, Datasets, Spaces und Paper auf dem Hugging Face Hub durchsuchen.\n\nFunktioniert ohne Token mit weniger Tools. Für alle Tools ein Access Token unter huggingface.co/settings/tokens erstellen, die Authentifizierung auf Bearer-Token umstellen und Tools sowie Spaces unter huggingface.co/settings/mcp auswählen.'
    },
    publisher: 'Hugging Face',
    category: 'data',
    docsUrl: 'https://huggingface.co/docs/hub/hf-mcp-server',
    url: 'https://huggingface.co/mcp',
    tags: ['models', 'datasets', 'ml', 'papers']
  },
  intercom: {
    name: { en: 'Intercom', de: 'Intercom' },
    description: {
      en: 'Search conversations, contacts, companies and help-center articles, and add internal notes.\n\nEU-hosted workspaces use https://mcp.eu.intercom.com/mcp. Australian workspaces are not supported.',
      de: 'Konversationen, Kontakte, Firmen und Help-Center-Artikel durchsuchen und interne Notizen hinzufügen.\n\nIn der EU gehostete Workspaces nutzen https://mcp.eu.intercom.com/mcp. Australische Workspaces werden nicht unterstützt.'
    },
    publisher: 'Intercom',
    category: 'customer',
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    url: 'https://mcp.intercom.com/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Use the access token of an Intercom app: Developer Hub → your app → Configure → Authentication.',
      de: 'Access Token einer Intercom-App verwenden: Developer Hub → App → Configure → Authentication.'
    },
    tags: ['support', 'helpdesk', 'crm']
  },
  linear: {
    name: { en: 'Linear', de: 'Linear' },
    description: {
      en: 'Find, create and update Linear issues, projects and comments.',
      de: 'Linear-Issues, Projekte und Kommentare finden, erstellen und bearbeiten.'
    },
    publisher: 'Linear',
    category: 'productivity',
    docsUrl: 'https://linear.app/docs/mcp',
    url: 'https://mcp.linear.app/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create a personal API key in Linear under Settings → Account → Security & Access. A key with read permission only gives read-only access.',
      de: 'Persönlichen API-Schlüssel in Linear unter Settings → Account → Security & Access erstellen. Ein Schlüssel nur mit Leserecht erlaubt nur lesenden Zugriff.'
    },
    tags: ['issues', 'project management', 'tickets']
  },
  'microsoft-learn': {
    name: { en: 'Microsoft Learn', de: 'Microsoft Learn' },
    description: {
      en: 'Search and read official Microsoft documentation and code samples for Azure, Microsoft 365, .NET and more.',
      de: 'Offizielle Microsoft-Dokumentation und Codebeispiele zu Azure, Microsoft 365, .NET und mehr durchsuchen und lesen.'
    },
    publisher: 'Microsoft',
    category: 'documentation',
    docsUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
    url: 'https://learn.microsoft.com/api/mcp',
    tags: ['azure', 'microsoft 365', '.net', 'docs']
  },
  modjo: {
    name: { en: 'Modjo', de: 'Modjo' },
    description: {
      en: 'Analyse recorded sales calls, deals and accounts.',
      de: 'Aufgezeichnete Verkaufsgespräche, Deals und Accounts analysieren.'
    },
    publisher: 'Modjo',
    category: 'customer',
    docsUrl: 'https://help.modjo.ai/en/articles/15459539-set-up-and-use-the-modjo-mcp',
    url: 'https://api.mcp.modjo.ai/v1/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'An administrator creates the key in Modjo under Settings → Integrations → Modjo API key. It covers the whole workspace.',
      de: 'Ein Administrator erstellt den Schlüssel in Modjo unter Settings → Integrations → Modjo API key. Er gilt für den gesamten Workspace.'
    },
    tags: ['sales', 'calls', 'conversation intelligence']
  },
  monday: {
    name: { en: 'monday.com', de: 'monday.com' },
    description: {
      en: 'Read and update monday.com boards, items, updates and workspaces.',
      de: 'monday.com-Boards, Items, Updates und Workspaces lesen und bearbeiten.'
    },
    publisher: 'monday.com',
    category: 'productivity',
    docsUrl: 'https://developer.monday.com/api-reference/docs/mcp-api-token',
    url: 'https://mcp.monday.com/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create a personal API token via your profile picture → Developers → My access tokens. It acts with that user’s permissions.',
      de: 'Persönliches API-Token über das Profilbild → Developers → My access tokens erstellen. Es handelt mit den Rechten dieses Benutzers.'
    },
    tags: ['project management', 'boards', 'tasks']
  },
  neon: {
    name: { en: 'Neon', de: 'Neon' },
    description: {
      en: 'Manage serverless Postgres projects and branches on Neon and run SQL queries.\n\nAppend ?readonly=true for read-only tools, or ?projectId=<id> to limit the server to one project.',
      de: 'Serverlose Postgres-Projekte und -Branches auf Neon verwalten und SQL-Abfragen ausführen.\n\nMit ?readonly=true nur lesende Tools nutzen oder mit ?projectId=<id> auf ein Projekt beschränken.'
    },
    publisher: 'Neon',
    category: 'development',
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    url: 'https://mcp.neon.tech/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an API key in the Neon Console under Settings → API keys.',
      de: 'API-Schlüssel in der Neon Console unter Settings → API keys erstellen.'
    },
    tags: ['postgres', 'database', 'sql']
  },
  pagerduty: {
    name: { en: 'PagerDuty', de: 'PagerDuty' },
    description: {
      en: 'Look up incidents, services, schedules and on-call rotations in PagerDuty.\n\nEU accounts use https://mcp.eu.pagerduty.com/mcp.',
      de: 'Incidents, Services, Dienstpläne und Rufbereitschaften in PagerDuty abrufen.\n\nEU-Konten nutzen https://mcp.eu.pagerduty.com/mcp.'
    },
    publisher: 'PagerDuty',
    category: 'development',
    docsUrl: 'https://support.pagerduty.com/main/docs/pagerduty-mcp-server-integration-guide',
    url: 'https://mcp.pagerduty.com/mcp',
    account: { kind: 'header', header: 'Authorization', valuePrefix: 'Token token=' },
    keyHelp: {
      en: 'Use a PagerDuty user API token (My Profile → User Settings) or an account API key (Integrations → API Access Keys).',
      de: 'PagerDuty-User-API-Token (My Profile → User Settings) oder Account-API-Schlüssel (Integrations → API Access Keys) verwenden.'
    },
    tags: ['incidents', 'on-call', 'operations']
  },
  posthog: {
    name: { en: 'PostHog', de: 'PostHog' },
    description: {
      en: 'Query product analytics, insights, feature flags, experiments and error tracking.\n\nEU Cloud projects use https://mcp-eu.posthog.com/mcp. Add ?features=flags,dashboards (for example) to the URL to limit the tools to those areas.',
      de: 'Produktanalysen, Insights, Feature Flags, Experimente und Fehler-Tracking abfragen.\n\nProjekte in der EU Cloud nutzen https://mcp-eu.posthog.com/mcp. Mit ?features=flags,dashboards (Beispiel) an der URL werden die Tools auf diese Bereiche beschränkt.'
    },
    publisher: 'PostHog',
    category: 'analytics',
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    url: 'https://mcp.posthog.com/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create a personal API key with the “MCP Server” preset under Settings → Personal API keys (keys start with phx_).',
      de: 'Persönlichen API-Schlüssel mit der Vorlage „MCP Server“ unter Settings → Personal API keys erstellen (beginnt mit phx_).'
    },
    tags: ['product analytics', 'feature flags', 'errors']
  },
  postman: {
    name: { en: 'Postman', de: 'Postman' },
    description: {
      en: 'Manage Postman workspaces, collections, environments and API specifications.\n\n/minimal offers the essential tools; use /mcp for the full tool set or /code for code generation. The EU region uses https://mcp.eu.postman.com.',
      de: 'Postman-Workspaces, Collections, Umgebungen und API-Spezifikationen verwalten.\n\n/minimal bietet die wichtigsten Tools; /mcp für alle Tools oder /code für Codegenerierung verwenden. Die EU-Region nutzt https://mcp.eu.postman.com.'
    },
    publisher: 'Postman',
    category: 'development',
    docsUrl: 'https://learning.postman.com/docs/developer/postman-api/postman-mcp-server/',
    url: 'https://mcp.postman.com/minimal',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create a Postman API key under Settings → API keys (postman.postman.co/settings/me/api-keys).',
      de: 'Postman-API-Schlüssel unter Settings → API keys erstellen (postman.postman.co/settings/me/api-keys).'
    },
    tags: ['api', 'testing', 'collections']
  },
  primamcp: {
    name: { en: 'PRIMAMCP', de: 'PRIMAMCP' },
    description: {
      en: 'Look up German and EU legal information for legal research.',
      de: 'Rechtsinformationen zu deutschem und EU-Recht für die juristische Recherche abrufen.'
    },
    publisher: 'PLANIT PRIMA',
    category: 'data',
    docsUrl: 'https://mcp.planitprima.com/docs',
    url: 'https://mcp.planitprima.com/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an API key (starts with sk-legal-) at mcp.planitprima.com/keys; it is shown only once. The free tier allows 150 requests per month.',
      de: 'API-Schlüssel (beginnt mit sk-legal-) unter mcp.planitprima.com/keys erstellen; er wird nur einmal angezeigt. Der kostenlose Tarif erlaubt 150 Anfragen pro Monat.'
    },
    tags: ['legal', 'law', 'germany', 'eu', 'lawbster']
  },
  statista: {
    name: { en: 'Statista', de: 'Statista' },
    description: {
      en: 'Search Statista statistics and retrieve chart data for market and consumer research.',
      de: 'Statista-Statistiken durchsuchen und Diagrammdaten für Markt- und Verbraucherforschung abrufen.'
    },
    publisher: 'Statista',
    category: 'data',
    docsUrl: 'https://docs.platform.statista.ai/mcp-server/introduction',
    url: 'https://api.statista.ai/v1/mcp',
    account: { kind: 'header', header: 'x-api-key' },
    keyHelp: {
      en: 'Statista issues the API key after you request access at platform.statista.ai; it requires a Statista contract.',
      de: 'Statista stellt den API-Schlüssel nach einer Zugangsanfrage auf platform.statista.ai aus; ein Statista-Vertrag ist erforderlich.'
    },
    tags: ['statistics', 'market research']
  },
  stripe: {
    name: { en: 'Stripe', de: 'Stripe' },
    description: {
      en: 'Work with Stripe customers, payments, invoices, subscriptions and products, and search the Stripe docs.\n\nTest in a sandbox first. Stripe asks for human confirmation of some write actions, such as refunds.',
      de: 'Mit Stripe-Kunden, Zahlungen, Rechnungen, Abos und Produkten arbeiten und die Stripe-Dokumentation durchsuchen.\n\nZuerst in einer Sandbox testen. Für manche schreibenden Aktionen, etwa Erstattungen, verlangt Stripe eine Bestätigung durch einen Menschen.'
    },
    publisher: 'Stripe',
    category: 'finance',
    docsUrl: 'https://docs.stripe.com/mcp',
    url: 'https://mcp.stripe.com',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an agent API key (Dashboard → API keys, shown with an “Agent” badge) with only the permissions needed. From 31 October 2026 Stripe MCP rejects secret keys and restricted keys without the Agent tag.',
      de: 'Agent-API-Schlüssel erstellen (Dashboard → API keys, mit „Agent“-Kennzeichnung) und nur die nötigen Berechtigungen vergeben. Ab 31. Oktober 2026 lehnt Stripe MCP Secret Keys und Restricted Keys ohne Agent-Kennzeichnung ab.'
    },
    tags: ['payments', 'billing', 'subscriptions', 'invoices']
  },
  supabase: {
    name: { en: 'Supabase', de: 'Supabase' },
    description: {
      en: 'Query and manage Supabase projects: database, tables, migrations, edge functions and logs.\n\nRecommended: append ?project_ref=<project-ref>&read_only=true to limit the server to one project and read-only queries.',
      de: 'Supabase-Projekte abfragen und verwalten: Datenbank, Tabellen, Migrationen, Edge Functions und Logs.\n\nEmpfohlen: ?project_ref=<projekt-ref>&read_only=true an die URL anhängen, um den Server auf ein Projekt und lesende Abfragen zu beschränken.'
    },
    publisher: 'Supabase',
    category: 'development',
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    url: 'https://mcp.supabase.com/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create a personal access token in the Supabase dashboard under Account → Access Tokens (project API keys do not work).',
      de: 'Persönliches Zugriffstoken im Supabase-Dashboard unter Account → Access Tokens erstellen (Projekt-API-Schlüssel funktionieren nicht).'
    },
    tags: ['postgres', 'database', 'sql']
  },
  superglue: {
    name: { en: 'superglue', de: 'superglue' },
    description: {
      en: 'Discover and run prebuilt integration tools that connect APIs and systems.',
      de: 'Vorgefertigte Integrationstools finden und ausführen, die APIs und Systeme verbinden.'
    },
    publisher: 'superglue',
    category: 'automation',
    docsUrl: 'https://superglue.ai/docs/mcp/using-the-mcp/',
    url: 'https://api.superglue.cloud/mcp',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'Create an API key at app.superglue.cloud via the organization menu → API Keys.',
      de: 'API-Schlüssel auf app.superglue.cloud über das Organisationsmenü → API Keys erstellen.'
    },
    tags: ['integrations', 'api', 'workflows']
  },
  wix: {
    name: { en: 'Wix', de: 'Wix' },
    description: {
      en: 'Manage Wix sites and the business data behind them.\n\nReplace YOUR_WIX_ACCOUNT_ID in the additional headers with your Wix account ID. The key is sent without a “Bearer” prefix.',
      de: 'Wix-Websites und die zugehörigen Geschäftsdaten verwalten.\n\nYOUR_WIX_ACCOUNT_ID in den zusätzlichen Headern durch die eigene Wix-Konto-ID ersetzen. Der Schlüssel wird ohne „Bearer“-Präfix gesendet.'
    },
    publisher: 'Wix',
    category: 'content',
    docsUrl: 'https://dev.wix.com/docs/overview/ai-the-wix-platform/the-wix-mcp',
    url: 'https://mcp.wix.com/mcp',
    headers: { 'wix-account-id': 'YOUR_WIX_ACCOUNT_ID' },
    account: { kind: 'header', header: 'Authorization' },
    keyHelp: {
      en: 'Create an API key in the Wix API Keys Manager with the permissions the tools need.',
      de: 'API-Schlüssel im Wix API Keys Manager mit den nötigen Berechtigungen erstellen.'
    },
    tags: ['website', 'cms', 'e-commerce']
  },
  zapier: {
    name: { en: 'Zapier', de: 'Zapier' },
    description: {
      en: 'Run actions in thousands of apps through the actions configured on a Zapier MCP server.',
      de: 'Aktionen in Tausenden Apps über die auf einem Zapier-MCP-Server konfigurierten Aktionen ausführen.'
    },
    publisher: 'Zapier',
    category: 'automation',
    docsUrl: 'https://docs.zapier.com/mcp/get-started/connect/openai-api',
    url: 'https://mcp.zapier.com/api/v1/connect',
    account: { kind: 'bearer' },
    keyHelp: {
      en: 'At mcp.zapier.com create a server, add the actions it may run, then generate a token on its Connect tab.',
      de: 'Auf mcp.zapier.com einen Server anlegen, die erlaubten Aktionen hinzufügen und im Tab „Connect“ ein Token erzeugen.'
    },
    tags: ['workflows', 'integrations', 'no-code']
  }
};

/** The release entry every moved definition starts with. */
const FIRST_RELEASE = {
  version: '1.0.0',
  date: '2026-11-03',
  summary: {
    en: 'First version in the marketplace; previously shipped with iHub.',
    de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
  }
};

/** The install field every moved definition offers for extra headers. */
const HEADERS_FIELD = {
  key: 'headers',
  type: 'list',
  title: { en: 'Additional headers', de: 'Zusätzliche Header' },
  description: {
    en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
    de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
  },
  advanced: true
};

/**
 * The marketplace's 1.0.0 definition of a moved server, key order included.
 * @param {string} name - the part after `mcp/`
 * @param {object} server - its {@link SERVERS} entry
 */
function movedDefinition(name, server) {
  const transport = { type: 'streamableHttp', url: server.url };
  if (server.headers) transport.headers = { ...server.headers };
  const install = [];
  let auth = { modes: ['none'] };
  if (server.account) {
    auth = { modes: ['service-account'], serviceAccount: { field: 'apiKey', ...server.account } };
    // The marketplace file lists `kind` first.
    const { kind, field, ...rest } = auth.serviceAccount;
    auth.serviceAccount = { kind, field, ...rest };
    install.push({
      key: 'apiKey',
      type: 'secret',
      title: { en: 'API key', de: 'API-Schlüssel' },
      description: server.keyHelp
    });
  }
  install.push(structuredClone(HEADERS_FIELD));
  return {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: `mcp/${name}`,
    version: '1.0.0',
    compatibility: { ihub: '>=5.6.0' },
    releases: [structuredClone(FIRST_RELEASE)],
    name: server.name,
    description: server.description,
    publisher: { name: server.publisher },
    categories: ['mcp', server.category],
    docsUrl: server.docsUrl,
    runs: 'cloud',
    protocol: { type: 'mcp', transport, apps: { enabled: true } },
    auth,
    install,
    capabilities: ['tools', 'views'],
    _meta: { tags: [...server.tags] }
  };
}

/** Folder name → the marketplace's 1.0.0 definition. */
export const MOVED_DEFINITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(SERVERS).map(([name, server]) => [`mcp__${name}`, movedDefinition(name, server)])
  )
);

/** Definition id (`mcp/github`) → folder name (`mcp__github`). */
const FOLDER_BY_ID = new Map(
  Object.entries(MOVED_DEFINITIONS).map(([folder, definition]) => [definition.id, folder])
);

export async function precondition(ctx) {
  return await ctx.fileExists(INTEGRATIONS_FILE);
}

function writeText(ctx) {
  if (ctx.writeText) return ctx.writeText;
  return async (relPath, text) => {
    const target = path.join(ctx.contentsDir, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
  };
}

// Snapshot of V193's normalizeUrl. Do NOT replace with an import.
function normalizeUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '').toLowerCase() : '';
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

// Snapshot of parseHeaderLines (protocols/mcp/serverConfig.js) as of V213.
function parseHeaderLines(lines) {
  const out = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const idx = String(line).indexOf(':');
    if (idx <= 0) continue;
    const name = String(line).slice(0, idx).trim();
    if (name)
      out[name.toLowerCase()] = String(line)
        .slice(idx + 1)
        .trim();
  }
  return out;
}

function sameRecord(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * The moved definition a generic installation can be re-linked to, as
 * `{ folder, instance }` with the re-linked installation, or `{ reason }`
 * when its endpoint is a moved one but the connection would change, or null
 * when its endpoint is none of them.
 *
 * @param {object} inst - a `com.intrafind/mcp-server` installation
 * @returns {{ folder: string, instance: object } | { reason: string } | null}
 */
export function relinkFor(inst) {
  const values = inst.values && typeof inst.values === 'object' ? inst.values : {};
  const transport = values.transport || 'streamableHttp';
  const url = normalizeUrl(values.url);
  if (!url) return null;
  const entry = Object.entries(MOVED_DEFINITIONS).find(
    ([, def]) => normalizeUrl(def.protocol.transport.url) === url
  );
  if (!entry) return null;
  const [folder, def] = entry;
  const fixed = def.protocol.transport;
  if (transport !== fixed.type) return { reason: `transport "${transport}" is not ${fixed.type}` };

  const mode = inst.auth?.mode || 'none';
  if (!def.auth.modes.includes(mode)) {
    return { reason: `sign-in mode "${mode}" is not offered by ${def.id}` };
  }
  if (mode === 'service-account') {
    const account = def.auth.serviceAccount;
    const kind = values.authKind || 'bearer';
    if (kind !== account.kind) {
      return { reason: `the credential is sent as "${kind}", ${def.id} sends "${account.kind}"` };
    }
    if (kind === 'header') {
      const name = String(values.headerName || '').toLowerCase();
      const prefix = values.valuePrefix || '';
      if (name !== account.header.toLowerCase() || prefix !== (account.valuePrefix || '')) {
        return { reason: `the credential header differs from ${def.id}'s ${account.header}` };
      }
    }
  }

  const prefix = typeof values.toolPrefix === 'string' ? values.toolPrefix.trim() : '';
  if (prefix && prefix !== `${inst.id}__`) {
    return { reason: `custom toolPrefix "${prefix}" (${def.id} has no toolPrefix field)` };
  }
  if (values.appsEnabled === false) return { reason: 'MCP App views are switched off' };
  for (const [key, standard] of Object.entries(RECONNECT_DEFAULTS)) {
    if (!isEmpty(values[key]) && values[key] !== standard) {
      return { reason: `${key} is set (${def.id} has no reconnect fields)` };
    }
  }
  const carried = new Set([
    'transport',
    'url',
    'headers',
    'authKind',
    'headerName',
    'valuePrefix',
    'toolPrefix',
    'timeoutMs',
    'appsEnabled',
    ...Object.keys(RECONNECT_DEFAULTS)
  ]);
  const other = Object.keys(values).filter(key => !carried.has(key) && !isEmpty(values[key]));
  if (other.length) return { reason: `${other.join(', ')} set (${def.id} has no such field)` };

  // The definition's fixed headers, overridden by the admin's, must be
  // exactly the headers the installation sends now.
  const own = parseHeaderLines(values.headers);
  const fixedHeaders = Object.fromEntries(
    Object.entries(fixed.headers || {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  if (!sameRecord({ ...fixedHeaders, ...own }, own)) {
    const missing = Object.keys(fixedHeaders).filter(name => !(name in own));
    return { reason: `${def.id} would add the header(s) ${missing.join(', ')}` };
  }

  const timeout = Number(values.timeoutMs);
  const hasTimeout = !isEmpty(values.timeoutMs) && Number.isFinite(timeout) && timeout !== 30000;
  if (hasTimeout && timeout > MAX_INSTANCE_TIMEOUT_MS) {
    return {
      reason: `timeoutMs ${timeout} is above the ${MAX_INSTANCE_TIMEOUT_MS} an installation may set`
    };
  }

  const instance = {
    ...inst,
    definition: def.id,
    definitionVersion: def.version,
    values:
      Array.isArray(values.headers) && values.headers.length ? { headers: values.headers } : {}
  };
  if (hasTimeout) instance.timeoutMs = timeout;
  return { folder, instance };
}

/**
 * Re-link the generic installations that qualify (see {@link relinkFor}) in
 * place; logs each one, and each that matched an endpoint but stays generic.
 * @returns {Promise<boolean>} whether any installation changed
 */
async function relinkGeneric(ctx, installed) {
  let changed = false;
  for (let i = 0; i < installed.length; i++) {
    const inst = installed[i];
    if (inst?.definition !== GENERIC_DEFINITION) continue;
    const result = relinkFor(inst);
    if (!result) continue;
    if (result.reason) {
      ctx.log(`${inst.id}: stays an installation of ${GENERIC_DEFINITION}: ${result.reason}`);
      continue;
    }
    const def = MOVED_DEFINITIONS[result.folder];
    const rel = `${DEFINITIONS_DIR}/${result.folder}/integration.json`;
    if (await ctx.fileExists(rel)) {
      let existing = null;
      try {
        existing = await ctx.readJson(rel);
      } catch {
        existing = null;
      }
      if (existing?.version !== def.version) {
        ctx.log(
          `${inst.id}: stays an installation of ${GENERIC_DEFINITION}: ${rel} holds version ${existing?.version ?? 'unknown'}, not ${def.version}`
        );
        continue;
      }
    }
    installed[i] = result.instance;
    changed = true;
    ctx.log(`${inst.id}: re-linked from ${GENERIC_DEFINITION} to ${def.id}`);
  }
  return changed;
}

export async function up(ctx) {
  const config = (await ctx.readJson(INTEGRATIONS_FILE)) || {};
  const installed = Array.isArray(config.installed) ? config.installed : [];
  if (await relinkGeneric(ctx, installed)) {
    await ctx.writeJson(INTEGRATIONS_FILE, { ...config, installed });
  }
  const used = new Map();
  for (const inst of installed) {
    const folder = FOLDER_BY_ID.get(inst?.definition);
    if (!folder) continue;
    if (!used.has(folder)) used.set(folder, []);
    used.get(folder).push(inst.id);
  }
  if (used.size === 0) {
    ctx.log('No installation uses a definition that moved to the marketplace');
    return;
  }

  const registries = (await ctx.fileExists(REGISTRIES_FILE))
    ? (await ctx.readJson(REGISTRIES_FILE)) || {}
    : {};
  const hasRegistry = (registries.registries || []).some(r => r?.id === REGISTRY_ID);
  const manifest = (await ctx.fileExists(INSTALLATIONS_FILE))
    ? (await ctx.readJson(INSTALLATIONS_FILE)) || {}
    : {};
  if (!manifest.installations || typeof manifest.installations !== 'object') {
    manifest.installations = {};
  }

  const write = writeText(ctx);
  const now = new Date().toISOString();
  let recorded = 0;
  for (const [folder, ids] of used) {
    const definition = MOVED_DEFINITIONS[folder];
    const rel = `${DEFINITIONS_DIR}/${folder}/integration.json`;
    if (await ctx.fileExists(rel)) {
      ctx.log(`${definition.id}: ${rel} exists already; left as it is (used by ${ids.join(', ')})`);
      continue;
    }
    await write(rel, `${JSON.stringify(definition, null, 2)}\n`);
    const key = `integration:${folder}`;
    if (hasRegistry && !manifest.installations[key]) {
      manifest.installations[key] = {
        type: 'integration',
        itemId: folder,
        registryId: REGISTRY_ID,
        version: definition.version,
        installedAt: now,
        installedBy: INSTALLED_BY,
        updatedAt: null,
        updateAvailable: null,
        sourceUrl: null
      };
      recorded++;
      ctx.log(`${definition.id}: installed from ${REGISTRY_ID} for ${ids.join(', ')}`);
    } else {
      ctx.warn(
        `${definition.id}: written as a local definition for ${ids.join(', ')}; ` +
          `the registry ${REGISTRY_ID} is not configured, so it gets no marketplace updates`
      );
    }
  }
  if (recorded > 0) await ctx.writeJson(INSTALLATIONS_FILE, manifest);
}
