/**
 * Microsoft 365 Copilot agent package for iHub.
 *
 * The package makes iHub a *declarative agent* in Microsoft 365 Copilot —
 * Copilot Chat, and the Copilot pane in Outlook, Teams, Word and the other
 * Microsoft 365 apps. The agent has one action: iHub's MCP gateway
 * (`/mcp`, see `routes/mcpServer.js`), reached with the user's own iHub
 * sign-in through OAuth. Copilot discovers the gateway's tools at runtime —
 * each iHub app is a tool (`app__<id>`), next to the workflows and tools the
 * gateway exposes — so the package does not change when apps do.
 *
 * Three JSON documents plus two icons, zipped flat:
 *
 *   manifest.json          Microsoft 365 app manifest (schema 1.30)
 *   declarativeAgent.json  the agent: name, instructions, starters (v1.8)
 *   ihub-plugin.json       the action: a RemoteMCPServer runtime (v2.4)
 *   color.png              192 × 192
 *   outline.png            32 × 32, white on transparent
 *
 * The OAuth sign-in is registered once in the Teams Developer Portal, which
 * hands back an OAuth client registration ID; the plugin refers to it as
 * `reference_id`. Microsoft offers no API for that step, so the admin pastes
 * the ID into iHub and the package is built with it.
 *
 * Pure functions only — the route (`routes/admin/copilotAgent.js`) gathers
 * the URLs and the configuration and zips what these return.
 *
 * @module utils/copilotAgentPackage
 */

export const APP_MANIFEST_SCHEMA =
  'https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json';
export const APP_MANIFEST_VERSION = '1.30';
export const DECLARATIVE_AGENT_SCHEMA =
  'https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.8/schema.json';
export const DECLARATIVE_AGENT_VERSION = 'v1.8';
export const PLUGIN_SCHEMA =
  'https://developer.microsoft.com/json-schemas/copilot/plugin/v2.4/schema.json';
export const PLUGIN_SCHEMA_VERSION = 'v2.4';

/** File names inside the package. */
export const PACKAGE_FILES = Object.freeze({
  manifest: 'manifest.json',
  agent: 'declarativeAgent.json',
  plugin: 'ihub-plugin.json',
  color: 'color.png',
  outline: 'outline.png'
});

/** Where Copilot's OAuth service returns the user after signing in. */
export const TEAMS_OAUTH_REDIRECT_URI =
  'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect';

/**
 * Scopes the Copilot OAuth client is created with, and the scope string the
 * Teams Developer Portal registration asks for. The `mcp:*` scopes let the
 * agent list and call the gateway's tools, run apps and run workflows.
 */
export const COPILOT_OAUTH_SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'mcp:tools:read',
  'mcp:tools:call',
  'mcp:apps:invoke',
  'mcp:workflows:run'
]);

/** Field limits, from the Microsoft 365 app and declarative agent schemas. */
export const LIMITS = Object.freeze({
  name: 30, // manifest name.short
  shortDescription: 80, // manifest description.short
  description: 1000, // declarative agent description (≤ 4000 in the app manifest)
  instructions: 8000,
  starters: 12,
  starterTitle: 50,
  starterText: 500,
  referenceId: 512,
  pluginName: 20, // name_for_human
  pluginDescription: 100 // description_for_human
});

export const DEFAULT_COPILOT_AGENT_CONFIG = Object.freeze({
  enabled: false,
  appId: '',
  oauthClientId: '',
  oauthReferenceId: '',
  name: 'iHub Apps',
  description:
    "Use your organization's iHub apps — assistants, writing aids and knowledge search — right in Microsoft 365 Copilot.",
  instructions: '',
  conversationStarters: []
});

/**
 * What the agent is told when the admin wrote nothing of their own.
 *
 * The gateway names each iHub app `app__<appId>` and takes the request as
 * `message`; the model needs to know that is the point, and that the apps,
 * not its own knowledge, are where the organization's answers live.
 */
export const DEFAULT_INSTRUCTIONS = [
  "You are iHub Apps, the gateway to the organization's own AI apps in iHub.",
  '',
  "Every tool whose name starts with `app__` is one iHub app: an assistant the organization configured for a task — answering from internal knowledge, drafting and reviewing text, translating, summarizing, and more. Its description says what it is for. Tools that start with `workflow__` run multi-step iHub workflows; the others are iHub's own tools.",
  '',
  "- When the user's request matches an app, call that app with the user's request as `message`, in the user's words and language. Include the text the user wants worked on — an email, a document passage — in `message` as well.",
  "- Fill in an app's other parameters only when the user said what they should be; otherwise leave them out and let the app use its defaults.",
  "- Prefer the organization's apps over your own general knowledge for anything about the organization, its documents or its processes.",
  '- If several apps could fit, pick the most specific one. If none fits, say so and answer from your own knowledge, making clear that it is not from iHub.',
  "- Present the app's answer to the user as it is, keeping its sources and links. Do not invent sources."
].join('\n');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a GUID, the only id shape the app manifest accepts. */
export const isGuid = value => typeof value === 'string' && GUID_RE.test(value);

const clip = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * The package version for a download made at `date`: `year.month.DDHHmmss`
 * (UTC). Microsoft 365 wants a higher version on every re-upload of the same
 * app, and the package is built on demand, so a timestamp does that without
 * anyone having to remember to bump it. Down to the second, so downloading,
 * changing a setting and downloading again still gives a higher version.
 *
 * @param {Date} [date]
 * @returns {string} e.g. `2026.10.6153000` for 6 October 2026, 15:30:00 UTC
 */
export function copilotPackageVersion(date = new Date()) {
  const patch =
    date.getUTCDate() * 1000000 +
    date.getUTCHours() * 10000 +
    date.getUTCMinutes() * 100 +
    date.getUTCSeconds();
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${patch}`;
}

/**
 * Validate an admin's settings update.
 *
 * @param {Object} input - `{ oauthReferenceId?, name?, description?, instructions?, conversationStarters? }`
 * @returns {{ value: Object }|{ error: string }} Only the fields that were sent.
 */
export function validateCopilotAgentConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Body must be an object' };
  }
  const value = {};

  if (input.oauthReferenceId !== undefined) {
    if (typeof input.oauthReferenceId !== 'string') {
      return { error: 'oauthReferenceId must be a string' };
    }
    const referenceId = input.oauthReferenceId.trim();
    if (referenceId.length > LIMITS.referenceId || /\s/.test(referenceId)) {
      return { error: 'oauthReferenceId is not a valid OAuth client registration ID' };
    }
    value.oauthReferenceId = referenceId;
  }

  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      return { error: 'name must be a non-empty string' };
    }
    if (input.name.trim().length > LIMITS.name) {
      return { error: `name must be at most ${LIMITS.name} characters` };
    }
    value.name = input.name.trim();
  }

  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || !input.description.trim()) {
      return { error: 'description must be a non-empty string' };
    }
    if (input.description.trim().length > LIMITS.description) {
      return { error: `description must be at most ${LIMITS.description} characters` };
    }
    value.description = input.description.trim();
  }

  if (input.instructions !== undefined) {
    if (typeof input.instructions !== 'string') return { error: 'instructions must be a string' };
    if (input.instructions.trim().length > LIMITS.instructions) {
      return { error: `instructions must be at most ${LIMITS.instructions} characters` };
    }
    value.instructions = input.instructions.trim();
  }

  if (input.conversationStarters !== undefined) {
    if (!Array.isArray(input.conversationStarters)) {
      return { error: 'conversationStarters must be an array' };
    }
    const starters = [];
    for (const starter of input.conversationStarters) {
      const text = typeof starter?.text === 'string' ? starter.text.trim() : '';
      const title = typeof starter?.title === 'string' ? starter.title.trim() : '';
      if (!text && !title) continue;
      if (!text) return { error: 'Every conversation starter needs a text' };
      if (text.length > LIMITS.starterText || title.length > LIMITS.starterTitle) {
        return {
          error: `Conversation starters allow a title of ${LIMITS.starterTitle} and a text of ${LIMITS.starterText} characters`
        };
      }
      starters.push(title ? { title, text } : { text });
    }
    if (starters.length > LIMITS.starters) {
      return { error: `At most ${LIMITS.starters} conversation starters are allowed` };
    }
    value.conversationStarters = starters;
  }

  return { value };
}

/**
 * The three JSON documents of the package.
 *
 * @param {Object} options
 * @param {Object} options.config - `platform.copilotAgent`, merged over the defaults.
 * @param {string} options.baseUrl - Public base URL of this iHub, no trailing slash.
 * @param {string} options.mcpUrl - The MCP gateway's public URL.
 * @param {string} options.version - From {@link copilotPackageVersion}.
 * @returns {{ manifest: Object, declarativeAgent: Object, plugin: Object }}
 */
export function buildCopilotAgentManifests({ config, baseUrl, mcpUrl, version }) {
  const settings = { ...DEFAULT_COPILOT_AGENT_CONFIG, ...(config || {}) };
  if (!isGuid(settings.appId)) throw new Error('The Copilot agent has no app id');
  if (!settings.oauthReferenceId) {
    throw new Error('The Copilot agent has no OAuth client registration ID');
  }

  const name = clip(settings.name, LIMITS.name) || DEFAULT_COPILOT_AGENT_CONFIG.name;
  const description =
    clip(settings.description, LIMITS.description) || DEFAULT_COPILOT_AGENT_CONFIG.description;

  const manifest = {
    $schema: APP_MANIFEST_SCHEMA,
    manifestVersion: APP_MANIFEST_VERSION,
    version,
    id: settings.appId.toLowerCase(),
    developer: {
      name: 'intrafind',
      websiteUrl: baseUrl,
      privacyUrl: baseUrl,
      termsOfUseUrl: baseUrl
    },
    icons: { color: PACKAGE_FILES.color, outline: PACKAGE_FILES.outline },
    name: { short: name, full: clip(`${name} for Microsoft 365 Copilot`, 100) },
    description: {
      short: clip(description, LIMITS.shortDescription),
      full: description
    },
    accentColor: '#FFFFFF',
    copilotAgents: {
      declarativeAgents: [{ id: 'declarativeAgent', file: PACKAGE_FILES.agent }]
    },
    validDomains: []
  };

  const starters = Array.isArray(settings.conversationStarters)
    ? settings.conversationStarters.slice(0, LIMITS.starters)
    : [];
  const declarativeAgent = {
    $schema: DECLARATIVE_AGENT_SCHEMA,
    version: DECLARATIVE_AGENT_VERSION,
    name,
    description,
    instructions: clip(settings.instructions, LIMITS.instructions) || DEFAULT_INSTRUCTIONS,
    ...(starters.length > 0 ? { conversation_starters: starters } : {}),
    actions: [{ id: 'ihubMcp', file: PACKAGE_FILES.plugin }]
  };

  const plugin = {
    $schema: PLUGIN_SCHEMA,
    schema_version: PLUGIN_SCHEMA_VERSION,
    name_for_human: clip(name, LIMITS.pluginName),
    namespace: 'ihub',
    description_for_human: clip(
      "Your organization's iHub apps, workflows and tools",
      LIMITS.pluginDescription
    ),
    description_for_model:
      "iHub hosts the organization's own AI apps. Each tool named app__<id> runs one app with the user's request as `message`; workflow__<id> tools run iHub workflows. Use them for anything about the organization, its documents or its processes, and for the tasks the apps describe.",
    // Dynamic discovery: Copilot reads the gateway's `tools/list` at runtime,
    // so apps added or removed in iHub show up without a new package.
    functions: [],
    runtimes: [
      {
        type: 'RemoteMCPServer',
        auth: { type: 'OAuthPluginVault', reference_id: settings.oauthReferenceId },
        spec: { url: mcpUrl },
        run_for_functions: ['*']
      }
    ]
  };

  return { manifest, declarativeAgent, plugin };
}

/**
 * What the admin enters in the Teams Developer Portal's OAuth client
 * registration, and what the plugin's runtime must match.
 *
 * @param {Object} options
 * @param {string} options.baseUrl - Public base URL of this iHub, no trailing slash.
 * @param {string} options.mcpUrl - The MCP gateway's public URL.
 * @param {string} [options.clientId] - The Copilot OAuth client's id.
 * @returns {Object}
 */
export function describeCopilotOAuthRegistration({ baseUrl, mcpUrl, clientId }) {
  return {
    baseUrl: mcpUrl,
    clientId: clientId || '',
    authorizationEndpoint: `${baseUrl}/api/oauth/authorize`,
    tokenEndpoint: `${baseUrl}/api/oauth/token`,
    refreshEndpoint: `${baseUrl}/api/oauth/token`,
    scope: COPILOT_OAUTH_SCOPES.join(' '),
    redirectUri: TEAMS_OAUTH_REDIRECT_URI,
    pkce: true
  };
}
