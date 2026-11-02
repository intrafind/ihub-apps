// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from './configCache.js';
import {
  activeSkillsOf,
  describeSkillCatalog,
  getAssignedSkillIds,
  getUsableSkills,
  isModelInvocable,
  loadUsableSkill,
  searchSkillCatalog,
  skillsEnabledIn
} from './services/skillAccess.js';
import { actionTracker } from './actionTracker.js';
import { emitToolProgress } from './services/loop/RunStream.js';
import { isFeatureEnabled } from './featureRegistry.js';
import { isValidId } from './utils/pathSecurity.js';
import { isInteractiveTool, isToolSelected } from './utils/toolSelection.js';
import mcpClientManager from './services/mcp/McpClientManager.js';
import {
  installedIntegrationById,
  installedIntegrationRefs
} from './services/integrations/installedRefs.js';
import { stampToolApproval } from './utils/toolApproval.js';
import a2aClientManager from './services/a2a/A2aClientManager.js';
import { markAgentIdConflicts } from './services/a2a/a2aTools.js';
import { filterDirectoryToolsForUser } from './services/peopleDirectory/PeopleDirectoryService.js';
import { filterBrowserToolsForUser } from './services/peopleDirectory/LdapBrowserService.js';
import {
  getWebSearchEngine,
  isWebSearchEngineConfigured,
  listWebSearchEngines
} from './services/search/websearchConfig.js';
import {
  AUTO_ENGINE,
  WEB_SEARCH_ACTION,
  isWebSearchEngineTool
} from './services/search/webSearchEngines.js';
import { mayUseIntegration } from './services/integrations/integrationAccess.js';
import logger from './utils/logger.js';
import { getLocalizedString } from './utils/localize.js';
import { localizeTools } from './utils/toolLocalization.js';
import { filterSchedulingTools } from './services/scheduler/tasks/toolGate.js';
import {
  hasProjectScope,
  isKnowledgeTool,
  knowledgeToolsFor,
  runKnowledgeTool
} from './services/knowledge/knowledgeTools.js';
import { platformToolDefinitions } from './services/tools/platformTools.js';
import { mentionAccess } from './services/workflow/workflowAccess.js';
import {
  isSystemSkillTool,
  runSystemSkillTool,
  systemSkillToolsFor,
  usesDocumentTemplates
} from './services/systemSkillTools.js';

/**
 * Build JSON Schema parameters from a workflow's start node inputVariables
 * @param {Object} workflow - Workflow definition
 * @returns {Object} JSON Schema parameters object
 */
function buildWorkflowToolParams(workflow, language = 'en') {
  const properties = {
    input: {
      type: 'string',
      description: 'The user message or primary input for the workflow'
    }
  };
  const required = ['input'];

  // Extract input variables from the start node config
  const startNode = (workflow.nodes || []).find(n => n.type === 'start');
  const inputVariables = startNode?.config?.inputVariables;

  if (Array.isArray(inputVariables)) {
    for (const varDef of inputVariables) {
      if (typeof varDef === 'string') {
        if (varDef !== 'input') {
          properties[varDef] = { type: 'string', description: varDef };
        }
      } else if (varDef && varDef.name && varDef.name !== 'input') {
        // Skip file/image variables — they are injected via _fileData/inputFiles,
        // not passed as tool parameters by the LLM
        if (varDef.type === 'file' || varDef.type === 'image') {
          continue;
        }

        const VALID_JSON_SCHEMA_TYPES = new Set([
          'string',
          'number',
          'integer',
          'boolean',
          'array',
          'object'
        ]);
        const CUSTOM_TYPE_MAP = {
          file: 'string',
          select: 'string',
          multiselect: 'array',
          date: 'string',
          textarea: 'string'
        };

        const rawType = varDef.type || 'string';
        const schemaType = VALID_JSON_SCHEMA_TYPES.has(rawType)
          ? rawType
          : CUSTOM_TYPE_MAP[rawType] || 'string';

        const descriptionRaw = varDef.description || varDef.name;
        const prop = {
          type: schemaType,
          description:
            typeof descriptionRaw === 'string'
              ? descriptionRaw
              : getLocalizedString(descriptionRaw, language)
        };

        // Enrich select types with enum values so the LLM knows valid choices
        if (varDef.type === 'select' && Array.isArray(varDef.options)) {
          prop.enum = varDef.options
            .map(o => (typeof o === 'string' ? o : o.value))
            .filter(Boolean);
        }

        properties[varDef.name] = prop;
        if (varDef.required) {
          required.push(varDef.name);
        }
      }
    }
  }

  return {
    type: 'object',
    properties,
    required
  };
}

/**
 * Load tools defined locally in contents/tools/
 * @param {string} language - Optional language for localization
 */
export async function loadConfiguredTools(language = null) {
  // Try to get tools from cache first
  const { data: tools } = configCache.getTools();
  if (!tools) {
    logger.warn('Tools could not be loaded', { component: 'ToolLoader' });
    return [];
  }

  // Always localize tools to ensure nested multilingual fields (like descriptions in schemas)
  // are converted to strings. Use provided language or fall back to platform default.
  const platformConfig = configCache.getPlatform() || {};
  const effectiveLanguage = language || platformConfig?.defaultLanguage || 'en';
  const localized = localizeTools(tools, effectiveLanguage);

  // Derive LLM-facing parameters for OpenAPI tools from the referenced operation
  // so the model sees the correct argument schema. A broken/unreachable spec
  // disables the tool rather than crashing tool discovery.
  const openApiTools = localized.filter(t => t.type === 'openapi' && !t.parameters);
  if (openApiTools.length > 0) {
    const { getOpenApiToolParameters } = await import('./services/tools/OpenApiToolRunner.js');
    await Promise.all(
      openApiTools.map(async t => {
        try {
          t.parameters = await getOpenApiToolParameters(t);
        } catch (error) {
          logger.error('Failed to derive OpenAPI tool parameters; disabling tool', {
            component: 'ToolLoader',
            toolId: t.id,
            error: error?.message
          });
          t.enabled = false;
        }
      })
    );
  }

  return localized;
}

/** Agent ids whose id clash has been logged, so each is reported once. */
const reportedA2aIdConflicts = new Set();

/**
 * The tools the skills feature adds to an app with skills: load a skill's
 * instructions, read one of its files, and search the catalog when the list
 * in the prompt is shortened. They belong to skills, not to an integration.
 */
export const ACTIVATE_SKILL_TOOL_ID = 'activate_skill';
export const READ_SKILL_RESOURCE_TOOL_ID = 'read_skill_resource';
export const FIND_SKILL_TOOL_ID = 'find_skill';
export const SKILL_TOOL_IDS = Object.freeze([
  ACTIVATE_SKILL_TOOL_ID,
  READ_SKILL_RESOURCE_TOOL_ID,
  FIND_SKILL_TOOL_ID
]);

/**
 * Prefix of the tool a workflow with chat integration becomes in an app
 * (`workflow_<workflowId>`). Such tools belong to workflows.
 */
export const WORKFLOW_TOOL_ID_PREFIX = 'workflow_';

/**
 * Most skill names the skill tools list as allowed values. A longer list costs
 * more tokens in every request than it saves; the call is checked anyway.
 */
export const MAX_SKILL_NAME_ENUM = 100;

/**
 * Mark the skills of every A2A agent whose id is also a local tool's (base)
 * id or another installation's id (`_a2a.idConflict`), so that reference
 * never silently grants the remote agent; `a2a__<agentId>` still selects the
 * agent as a whole. The admin API refuses such ids; this covers a hand-edited
 * config and a tool or installation added after the agent.
 *
 * @param {Array<Object>} a2aTools - Discovered A2A tools
 * @param {Array<Object>} otherTools - Local and MCP tools
 * @returns {Array<Object>} The A2A tools, clashing ones marked
 */
function guardA2aAgentIds(a2aTools, otherTools) {
  if (!a2aTools.length) return a2aTools;
  // The agents are installations themselves; only the other installations
  // (MCP servers, catalog integrations) can take an agent's id.
  const agentIds = new Set(a2aTools.map(tool => tool._a2a?.agentId).filter(Boolean));
  const { tools, conflicts } = markAgentIdConflicts(a2aTools, {
    tools: otherTools,
    mcpServers: installedIntegrationRefs().filter(ref => !agentIds.has(ref.id))
  });
  for (const [agentId, conflict] of conflicts) {
    if (reportedA2aIdConflicts.has(agentId)) continue;
    reportedA2aIdConflicts.add(agentId);
    logger.warn(
      'A2A agent id is also a tool or installed integration id; select the agent as a2a__<agentId>',
      { component: 'ToolLoader', agentId, conflictKind: conflict.kind, conflictId: conflict.id }
    );
  }
  return tools;
}

/**
 * Tools of the installed integrations (Admin → Integrations → Installed).
 * Imported lazily: the integration services read configCache, which imports
 * this module.
 */
async function discoverIntegrationTools(language) {
  try {
    const { discoverIntegrationTools: discover } =
      await import('./services/integrations/integrationTools.js');
    return await discover(language);
  } catch (error) {
    logger.error('Error discovering integration tools', { component: 'ToolLoader', error });
    return [];
  }
}

/** Drop the integration tools the user's groups do not grant (lazy import, see above). */
async function filterIntegrationToolsForUser(tools, user) {
  if (!tools.some(t => t._integration)) return tools;
  const { filterIntegrationToolsForUser: filter } =
    await import('./services/integrations/integrationTools.js');
  return filter(tools, user);
}

/**
 * The platform tools — the workflow and agent tools (agent workspace,
 * evidence; see `services/tools/platformTools.js`) — localized, as plain
 * tools. A file in `contents/tools/` with the same id takes the place of the
 * shipped definition whether it is enabled or not, as a configured tool did
 * before migration V199: an admin-edited file V199 kept keeps serving its
 * tool, and one switched off (`enabled: false`) keeps it off.
 *
 * @param {string|null} language
 * @returns {Object[]}
 */
function loadPlatformTools(language) {
  const { data: files } = configCache.getTools(true);
  const configuredIds = new Set((files || []).map(tool => tool?.id));
  const platformConfig = configCache.getPlatform() || {};
  const effectiveLanguage = language || platformConfig?.defaultLanguage || 'en';
  return localizeTools(
    platformToolDefinitions().filter(tool => !configuredIds.has(tool.id)),
    effectiveLanguage
  );
}

/**
 * iHub's local tools — every tool that is not an installed integration's: the
 * configured tools (`contents/tools/`) and the platform tools of workflows and
 * agents. The inbound MCP gateway offers these to the callers whose groups or
 * apps grant them, as it offered the tool files before migration V199.
 *
 * A leftover `contents/tools/knowledge.json` (an admin-edited copy V199 kept)
 * does not put a knowledge tool into the list: those ids are the projects'
 * (see {@link loadTools}).
 *
 * @param {string|null} [language] - Language for localization (platform default when absent)
 * @returns {Promise<Object[]>}
 */
export async function loadLocalTools(language = null) {
  const configured = await loadConfiguredTools(language);
  const platform = loadPlatformTools(language);
  return [...configured, ...platform].filter(tool => !isKnowledgeTool(tool.id));
}

/**
 * Load the tools a request can be offered by id: the configured tools
 * (`contents/tools/`), the platform tools of workflows and agents, and the
 * tools of the installed integrations (which include the MCP servers, the
 * remote A2A agents, the people directories and iHub's own `ask_user` and
 * scheduled-task tools). The first tool of an id wins, in that order.
 *
 * The project knowledge tools (`knowledge_*`) are never in this list: they
 * belong to projects and come with the request's project scope
 * (`getToolsForApp` → `knowledgeToolsFor`); `runTool` dispatches them itself.
 *
 * @param {string} language - Optional language for localization
 * @returns {Promise<Object[]>}
 */
export async function loadTools(language = null) {
  const local = await loadLocalTools(language);
  // Installed integrations include the MCP servers, the remote A2A agents and
  // the people directories (their tools keep `_mcp`, `_a2a` and
  // `_peopleDirectory`).
  const discoveredIntegrationTools = await discoverIntegrationTools(language);
  const otherTools = discoveredIntegrationTools.filter(t => !t._a2a);
  const a2aTools = guardA2aAgentIds(
    discoveredIntegrationTools.filter(t => t._a2a),
    [...local, ...otherTools]
  );
  const discovered = [...otherTools, ...a2aTools];
  const all = [];
  const seen = new Set();
  for (const tool of [...local, ...discovered]) {
    // A discovered tool of a knowledge id does not put a knowledge tool into
    // the list either.
    if (seen.has(tool.id) || isKnowledgeTool(tool.id)) continue;
    seen.add(tool.id);
    all.push(tool);
  }
  return all;
}

/**
 * Model providers that can run web search themselves (server-side), without
 * a script-backed tool. Native search is a request-time capability the
 * adapter enables directly on the provider request — never a "tool" the
 * generic tool-calling pipeline has to know about or convert.
 * @type {Set<string>}
 */
const NATIVE_WEB_SEARCH_PROVIDERS = new Set(['google', 'openai-responses', 'anthropic']);

/**
 * Default cap on provider-run searches per model call. Anthropic bills every
 * search separately, so an uncapped research prompt can fan out into dozens of
 * billable searches for one answer. Overridable per app
 * (`websearch.maxSearches`) and per workflow node (`maxWebSearches`).
 */
export const DEFAULT_NATIVE_WEB_SEARCH_MAX_USES = 5;

/**
 * Native search providers whose requests take function tools next to the
 * search, so the page reader can be offered with it: the model searches with
 * the provider and opens a result, or a URL the user pasted, with the reader.
 *
 * Google is not one of them. Gemini drops every function declaration next to
 * `google_search` (see adapters/google.js); combining the two is a preview
 * feature for Gemini 3 only, and needs the server-side tool calls circulated
 * back through the conversation, which the adapter does not do.
 * @type {Set<string>}
 */
export const NATIVE_SEARCH_WITH_PAGE_READER = new Set(['anthropic', 'openai-responses']);

/**
 * The engine a native web search directive falls back to when the provider
 * turns native search down and no app says which engine to use (a workflow
 * node): the first engine the user may use.
 */
export const NATIVE_WEB_SEARCH_FALLBACK_ENGINE = AUTO_ENGINE;

/**
 * Page reader offered next to the engine's search tool, so the model can open
 * a result (or a URL the user gave it) in full instead of relying on the
 * search tool's short automatic excerpts. It belongs to the web search
 * feature, not to an engine: a platform tool (`services/tools/platformTools.js`).
 */
export const READ_URL_TOOL_ID = 'read_url';

/**
 * Whether an engine installation offers its search to a user: it is enabled
 * and the user's groups grant it (`permissions.integrations`: `*`, the
 * installation id, its definition id or `type:web-search`) — the checks
 * `runIntegrationTool` makes before it runs the search, so nothing is offered
 * that the call would then refuse.
 *
 * @param {Object|null} engine - the installation
 * @param {Object} [user]
 * @returns {boolean}
 */
function engineUsableBy(engine, user) {
  return Boolean(engine) && engine.enabled !== false && mayUseIntegration(engine, user);
}

/**
 * The `search` tool of an engine in a loaded tool list, or null (the
 * installation is off, or an admin switched its search action off).
 *
 * @param {{ id: string }} engine
 * @param {Object[]} tools - result of `loadTools()`
 * @returns {Object|null}
 */
function engineSearchTool(engine, tools) {
  return (
    tools.find(
      tool =>
        tool?._integration?.instanceId === engine.id &&
        tool._integration.action === WEB_SEARCH_ACTION
    ) || null
  );
}

/**
 * The web search engine an app's web search uses for a user.
 *
 * `provider` is `app.websearch.provider`:
 *
 * - `auto` (or unset): the first engine that is enabled and that the user's
 *   groups grant, in the order Brave, Staan, Qwant, then every other
 *   installation of type `web-search` by id (`sortWebSearchEngines`);
 * - an installation id: that engine, and nothing when it is missing, disabled
 *   or not granted to the user. It never falls back to another engine, so an
 *   app set to one engine does not silently answer from another.
 *
 * No engine means no tool-based search; native search is not affected (it is
 * the app's own feature and needs no engine, see {@link resolveAppNativeWebSearch}).
 *
 * @param {string} [provider='auto'] - `app.websearch.provider`
 * @param {Object} [options]
 * @param {Object} [options.user] - The acting user; none means the anonymous principal
 * @param {Object[]} [options.tools] - The loaded tools: when given, an engine
 *   counts only when its `search` tool is among them, so `auto` passes over an
 *   engine whose search action an admin switched off
 * @returns {Object|null} The engine installation, or null
 * @example
 * // brave disabled, staan not granted to the user, qwant enabled and granted
 * resolveWebSearchEngine('auto', { user })?.id;  // → 'qwant'
 * resolveWebSearchEngine('brave', { user });     // → null (no fallback)
 */
export function resolveWebSearchEngine(provider = AUTO_ENGINE, { user, tools } = {}) {
  const usable = engine =>
    engineUsableBy(engine, user) && (!tools || Boolean(engineSearchTool(engine, tools)));
  if (provider && provider !== AUTO_ENGINE) {
    const engine = getWebSearchEngine(provider);
    return usable(engine) ? engine : null;
  }
  return listWebSearchEngines().find(usable) || null;
}

/**
 * Whether a tool-based web search engine is available to a user: the engine
 * `provider` resolves to exists, is enabled and is granted to the user's
 * groups. Native search does not depend on it.
 *
 * @param {Object} [user] - The acting user; none means the anonymous principal
 * @param {string} [provider='auto'] - `app.websearch.provider`
 * @returns {boolean}
 */
export function isWebSearchAvailableTo(user, provider = AUTO_ENGINE) {
  return Boolean(resolveWebSearchEngine(provider, { user }));
}

/**
 * The `search` tool of the engine an app's web search uses, from the loaded
 * tool list (see {@link resolveWebSearchEngine}).
 *
 * @param {string} [provider='auto'] - `app.websearch.provider`
 * @param {Object[]} allTools - result of `loadTools()`
 * @param {Object} [user]
 * @returns {Object|null} The tool definition (`braveSearch`, `acme__search`, …), or null
 */
export function resolveWebSearchEngineTool(provider, allTools, user) {
  const engine = resolveWebSearchEngine(provider, { user, tools: allTools });
  return engine ? engineSearchTool(engine, allTools) : null;
}

/**
 * The tool id of the engine a workflow node's generic `webSearch` falls back
 * to on a model without native search (see `PromptNodeExecutor`).
 *
 * @param {string} [provider='auto']
 * @param {{ user?: Object, language?: string }} [options]
 * @returns {Promise<string|null>} e.g. `braveSearch`; null when no engine is available
 */
export async function resolveWebSearchEngineToolId(
  provider = AUTO_ENGINE,
  { user, language } = {}
) {
  const allTools = await loadTools(language);
  return resolveWebSearchEngineTool(provider, allTools, user)?.id || null;
}

/**
 * Whether web search can work for an app, as the chat's model picker needs to
 * know it: which providers run it natively (when the app allows native
 * search), and whether the app's engine is available to the user and has
 * what it needs to answer (Brave and Staan need a key; Qwant needs none). A
 * model supports web search in the app when it is on one of the native
 * providers, or when it can call tools and an engine works.
 *
 * @param {Object} app - App configuration
 * @param {Object} [user] - The user asking; the engine's group grant applies
 * @returns {Promise<{native: string[], script: boolean}|null>} null when the app has no web search
 */
export async function describeWebSearchAvailability(app, user) {
  if (!app?.websearch?.enabled) return null;
  const engine = resolveWebSearchEngine(app.websearch.provider, { user });
  return {
    native: app.websearch.useNativeSearch === false ? [] : [...NATIVE_WEB_SEARCH_PROVIDERS],
    script: Boolean(engine) && isWebSearchEngineConfigured(engine)
  };
}

function normalizeMaxUses(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_NATIVE_WEB_SEARCH_MAX_USES;
}

/**
 * Resolve the native web search directive for a model.
 *
 * Native search is a request-time capability the adapter enables directly on
 * the provider request — never a "tool" the generic tool-calling pipeline has
 * to know about. A model config can opt out with `nativeWebSearch.enabled:
 * false` (an Anthropic-compatible gateway without the server tool, an older
 * model); callers then use the app's web search engine, the same one the loop
 * switches to when the provider rejects the directive.
 *
 * @param {string} modelProvider - Provider of the selected model
 * @param {Object} [options]
 * @param {Object} [options.model] - Full model config (per-model opt-out)
 * @param {number} [options.maxUses] - Per-call search cap (Anthropic `max_uses`)
 * @returns {{provider: string, maxUses: number, fallback: string} | null} `fallback`
 *   is the engine to fall back to when no app names one (`auto`)
 */
export function resolveNativeWebSearchProvider(modelProvider, { model, maxUses } = {}) {
  if (!NATIVE_WEB_SEARCH_PROVIDERS.has(modelProvider)) return null;
  if (model?.nativeWebSearch?.enabled === false) return null;
  return {
    provider: modelProvider,
    maxUses: normalizeMaxUses(maxUses),
    fallback: NATIVE_WEB_SEARCH_FALLBACK_ENGINE
  };
}

/**
 * Resolve native web search for an app's unified `websearch` config + model provider.
 *
 * Native search is the app's own web search, run by the model's provider: it
 * needs no engine installation and no integration grant, so an app with web
 * search on searches natively on Google, OpenAI Responses and Anthropic
 * models even while no engine is installed. Returns null when native search
 * doesn't apply — the caller (getToolsForApp) uses the app's engine then.
 *
 * @param {Object} app - App configuration with optional websearch field
 * @param {string} modelProvider - Provider of the selected model (e.g. 'google', 'openai-responses')
 * @param {boolean|undefined} websearchEnabled - User toggle: undefined = use enabledByDefault, false = disabled
 * @param {Object} [model] - Full model config (per-model opt-out)
 * @returns {{provider: string, maxUses: number, fallback: string} | null}
 */
export function resolveAppNativeWebSearch(app, modelProvider, websearchEnabled, model) {
  if (!app?.websearch?.enabled) return null;

  const { enabledByDefault = false, useNativeSearch = true } = app.websearch;

  // When websearchEnabled is undefined (client didn't send a toggle value),
  // fall back to the admin-configured enabledByDefault setting.
  const effectiveEnabled = websearchEnabled !== undefined ? websearchEnabled : enabledByDefault;
  if (!effectiveEnabled || !useNativeSearch) return null;

  return resolveNativeWebSearchProvider(modelProvider, {
    model,
    maxUses: app.websearch.maxSearches
  });
}

/**
 * Clone an engine's search tool definition with an app's `websearch`
 * parameter defaults applied (never mutates the cached definition).
 *
 * Each engine's tool declares its own bounds — Qwant returns at most 10
 * results per search where Brave allows 20 — so an admin value is clamped to
 * what the chosen tool accepts instead of being written through verbatim and
 * failing schema validation at call time. A parameter the engine does not
 * declare (a third-party engine without `extractContent`) is left alone.
 *
 * @param {Object} toolDef - The engine's search tool (braveSearch, staanSearch, qwantSearch, …)
 * @param {Object} [websearch] - app.websearch config
 * @returns {Object} tool definition ready to offer to the model
 */
function buildWebsearchTool(toolDef, websearch = {}) {
  const { maxResults = 5, extractContent = true, contentMaxLength = 3000 } = websearch || {};
  const cloned = JSON.parse(JSON.stringify(toolDef));
  const props = cloned.parameters?.properties || {};

  // Override parameter defaults with admin-configured websearch values
  if (props.maxResults) props.maxResults.default = clampToSchema(maxResults, props.maxResults);
  if (props.extractContent) props.extractContent.default = extractContent;
  if (props.contentMaxLength) {
    props.contentMaxLength.default = clampToSchema(contentMaxLength, props.contentMaxLength);
  }

  return cloned;
}

/**
 * Clamp a number into a JSON Schema property's `minimum`/`maximum`.
 * @param {number} value
 * @param {{minimum?: number, maximum?: number}} schema
 * @returns {number}
 */
function clampToSchema(value, schema) {
  let n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (Number.isFinite(schema?.minimum)) n = Math.max(schema.minimum, n);
  if (Number.isFinite(schema?.maximum)) n = Math.min(schema.maximum, n);
  return n;
}

/**
 * Tools to offer instead of a native web search directive the provider turned
 * down (see services/loop/nativeWebSearchFallback.js): the search tool of the
 * engine the app names (`auto` without an app: the first engine the user may
 * use) with the page reader. Empty when no engine is available to the user —
 * the retry then runs without web search.
 *
 * @param {{fallback?: string}|null} directive - the rejected directive
 * @param {{app?: Object, language?: string, user?: Object}} [context]
 * @returns {Promise<Object[]>}
 */
export async function resolveNativeWebSearchFallbackTools(directive, { app, language, user } = {}) {
  // With an app in hand, fall back to the engine that app is configured for —
  // an app set to Qwant should not silently answer from Brave just because
  // the model turned native search down.
  const provider = app?.websearch
    ? app.websearch.provider
    : directive?.fallback || NATIVE_WEB_SEARCH_FALLBACK_ENGINE;
  const allTools = await loadTools(language);
  const engineTool = resolveWebSearchEngineTool(provider, allTools, user);
  if (!engineTool) {
    logger.info('No web search engine to fall back to from native search', {
      component: 'ToolLoader',
      provider: provider || AUTO_ENGINE
    });
    return [];
  }
  return withPageReader(
    app?.websearch ? buildWebsearchTool(engineTool, app.websearch) : engineTool,
    allTools
  );
}

/**
 * Pair an engine's search tool with the page reader, so the model can open
 * what it found. The reader is left out when an admin switched it off (a
 * `contents/tools/read_url.json` with `enabled: false`; `loadTools` keeps
 * such a file out of the list).
 * @param {Object} searchTool - Search tool definition to offer
 * @param {Object[]} allTools - All available tool definitions
 * @returns {Object[]} The search tool, followed by the page reader when available
 */
function withPageReader(searchTool, allTools) {
  const reader = allTools.find(t => t.id === READ_URL_TOOL_ID);
  return reader ? [searchTool, reader] : [searchTool];
}

/**
 * The web search tools of an app for one request: native search on the
 * model's provider wins (it is passed straight to the adapter by
 * resolveAppNativeWebSearch, not through the tools pipeline), with the page
 * reader next to it where the provider accepts function tools; otherwise the
 * search tool of the app's engine (`app.websearch.provider`, see
 * {@link resolveWebSearchEngine}) with the page reader. Overrides the engine
 * tool's parameter defaults with the values from app.websearch config.
 *
 * @param {Object} app - App configuration with optional websearch field
 * @param {string} modelProvider - Provider of the selected model
 * @param {Array} allTools - All available tool definitions
 * @param {boolean|undefined} websearchEnabled - User toggle: undefined = use enabledByDefault, false = disabled
 * @param {Object} [model] - Full model config (per-model native search opt-out)
 * @param {Object} [user] - The acting user; the engine's group grant applies
 * @returns {Array} No tools, the search tool followed by the page reader, or — with
 *   native search on a provider in {@link NATIVE_SEARCH_WITH_PAGE_READER} — the reader alone
 */
function resolveWebsearchTool(app, modelProvider, allTools, websearchEnabled, model, user) {
  if (!app.websearch?.enabled) return [];

  const { enabledByDefault = false } = app.websearch;

  const effectiveEnabled = websearchEnabled !== undefined ? websearchEnabled : enabledByDefault;
  if (!effectiveEnabled) return [];

  // Native search handles this app/model combination — no search tool needed,
  // but the page reader still is where the provider accepts function tools.
  // It needs no engine.
  const native = resolveAppNativeWebSearch(app, modelProvider, websearchEnabled, model);
  if (native) {
    if (!NATIVE_SEARCH_WITH_PAGE_READER.has(native.provider)) return [];
    const reader = allTools.find(t => t.id === READ_URL_TOOL_ID);
    return reader ? [reader] : [];
  }

  const engineTool = resolveWebSearchEngineTool(app.websearch.provider, allTools, user);
  if (!engineTool) {
    logger.debug('No web search engine available for the app', {
      component: 'ToolLoader',
      appId: app.id,
      provider: app.websearch.provider || AUTO_ENGINE
    });
    return [];
  }

  return withPageReader(buildWebsearchTool(engineTool, app.websearch), allTools);
}

/**
 * Get tools applicable to a specific app
 * @param {Object} app - app configuration object
 * @param {string} language - Optional language for localization
 * @param {Object} context - Context object (user, chatId, etc.) for source tool generation
 */
export async function getToolsForApp(app, language = null, context = {}) {
  // Get static tools from tool definitions
  const allTools = await loadTools(language);
  let appTools = [];

  if (Array.isArray(app.tools) && app.tools.length > 0) {
    // An installed integration's tools come only through `app.integrations`
    // (below), where the group grant (`permissions.integrations`) and the
    // binding's action list are checked; an `app.tools` reference to one does not bypass that.
    //
    // Three exceptions keep old references working, each once the
    // installation's own enabled and group-grant checks pass
    // (`filterIntegrationToolsForUser` below): the search tool of a web search
    // engine, by its exact id (`braveSearch`, `staanSearch`, `qwantSearch`, a
    // third-party engine's `<id>__search`) — a workflow node, or an app, that
    // lists one keeps getting it while that engine is installed, enabled and
    // granted; the installation id selects nothing here; the people
    // directories, whose tools a directory id selects as before
    // (`isToolSelected`); and every other built-in action that kept its tool
    // id (`fixedToolId`: iHub's own `ask_user` and scheduled-task tools,
    // `iFinder_*`, `jira_*`, …), read as the plain tool it was — exact id or
    // base id (`iFinder`), never the installation id. The platform tools of
    // workflows and agents (`write_artifact`, `evidence_*`, …) and the page
    // reader `read_url` are plain tools and selected like any tool file. An
    // LDAP browser's tools come only through a binding.
    const selected = allTools.filter(t => {
      if (!t._integration) return isToolSelected(t, app.tools);
      if (t._peopleDirectory) return isToolSelected(t, app.tools);
      if (isWebSearchEngineTool(t)) return app.tools.includes(t.id);
      if (t._integration.fixedToolId) return isToolSelected({ id: t.id }, app.tools);
      return false;
    });
    appTools = filterBrowserToolsForUser(
      filterDirectoryToolsForUser(
        await filterIntegrationToolsForUser(selected, context.user),
        context.user
      ),
      context.user
    );

    // Filter by enabledTools if provided in context. Interactive clarification
    // tools (`ask_user`, anything `requiresUserInput`) are a system channel the
    // loop drives, not a user-selectable capability, so an app that grants one
    // keeps it whatever the chat's narrowing says — otherwise disabling it (or
    // a stale saved selection that predates it) strips the model's only way to
    // ask a question, and the interview loops instead of pausing for the user.
    if (
      context.enabledTools !== undefined &&
      context.enabledTools !== null &&
      Array.isArray(context.enabledTools)
    ) {
      appTools = appTools.filter(
        t => isInteractiveTool(t) || isToolSelected(t, context.enabledTools)
      );
    }
  }

  // Tools of the installed integrations the app binds under `app.integrations`
  // (#3061). The chat's narrowing applies to them like to any other tool.
  if (app.integrations && typeof app.integrations === 'object') {
    try {
      const { getIntegrationToolsForApp, isBoundToolEnabled } =
        await import('./services/integrations/integrationTools.js');
      // An LDAP browser's own rules (signed-in, non-delegated users, its
      // directory enabled) hold on top of the binding and the group grant.
      let bound = filterBrowserToolsForUser(
        filterDirectoryToolsForUser(
          getIntegrationToolsForApp(app, allTools, context),
          context.user
        ),
        context.user
      );
      if (Array.isArray(context.enabledTools)) {
        // By the key the app binds it with, too: a definition id or a type
        // key (`type:storage`) is what the chat's tools menu sends for it.
        bound = bound.filter(t => isBoundToolEnabled(app, t, context.enabledTools));
      }
      appTools = appTools.concat(bound.filter(t => !appTools.some(a => a.id === t.id)));
    } catch (error) {
      logger.error('Error adding integration tools', { component: 'ToolLoader', error });
    }
  }

  // Inject websearch tool resolved from app.websearch config + model provider
  const websearchTools = resolveWebsearchTool(
    app,
    context.modelProvider,
    allTools,
    context.websearchEnabled,
    context.model,
    context.user
  );
  // An app may also list the page reader in `tools` — offer it only once.
  appTools = appTools.concat(websearchTools.filter(t => !appTools.some(a => a.id === t.id)));

  // Add the project knowledge tools when the projects feature is on and the
  // request reaches a project (#1036): one shipped definition, a scope per
  // request in its description. They belong to projects, so neither `tools`
  // nor an integration adds or removes them.
  if (hasProjectScope(app) && context.user) {
    try {
      const knowledgeTools = await knowledgeToolsFor({
        app,
        user: context.user,
        language
      });
      appTools = appTools.concat(knowledgeTools.filter(t => !appTools.some(a => a.id === t.id)));
    } catch (error) {
      logger.error('Error adding the knowledge tools', { component: 'ToolLoader', error });
    }
  }

  // Add workflow tools (from dedicated app.workflows array)
  if (Array.isArray(app.workflows)) {
    for (const wfId of app.workflows) {
      try {
        if (typeof wfId !== 'string' || !wfId) continue;
        const wf = configCache.getWorkflowById(wfId);
        if (!wf || wf.enabled === false || !wf.chatIntegration?.enabled) continue;
        // The model acts for the person who chats, so it is only offered what
        // that person may run: the same rule as an `@mention` of the workflow.
        // The runner holds the line again when the tool is called.
        if (!mentionAccess({ user: context.user, app, workflow: wf }).allowed) continue;

        let toolDescription = getLocalizedString(
          wf.chatIntegration?.toolDescription || wf.description,
          language || 'en'
        );
        const toolName = getLocalizedString(wf.name, language || 'en');

        // If the workflow has file/image input variables, hint that attached files
        // are passed automatically so the LLM knows to call this tool
        const startNode = (wf.nodes || []).find(n => n.type === 'start');
        const hasFileInputs = (startNode?.config?.inputVariables || []).some(
          v => v.type === 'file' || v.type === 'image'
        );
        if (hasFileInputs) {
          toolDescription +=
            ' Any files attached to the user message are passed to this tool automatically.';
        }

        appTools.push({
          id: `${WORKFLOW_TOOL_ID_PREFIX}${wfId}`,
          name: toolName,
          description: toolDescription,
          script: 'workflowRunner.js',
          isWorkflowTool: true,
          workflowId: wfId,
          passthrough: true,
          parameters: buildWorkflowToolParams(wf, language || 'en')
        });
      } catch (error) {
        logger.error('Error generating workflow tool', {
          component: 'ToolLoader',
          workflowId: wfId,
          error
        });
      }
    }
  }

  // App-as-tool: surface other apps as synthetic `app__<id>` tools (the
  // "concierge" pattern — a bot delegating to specialist bots). Skipped for
  // principals that are themselves serving an app-as-tool call, so App→App
  // chains stop at one level of nesting.
  if (
    Array.isArray(app.apps) &&
    app.apps.length > 0 &&
    context.user?.isInvokedViaAppAsTool !== true &&
    isFeatureEnabled('appAsTool', configCache.getFeatures())
  ) {
    try {
      const { getAppAsTools } = await import('./services/chat/appToolsGateway.js');
      // Never expose an app to itself — a direct self-call can only loop.
      const targetAppIds = app.apps.filter(id => typeof id === 'string' && id && id !== app.id);
      const appAsTools = await getAppAsTools(targetAppIds, language || 'en', {
        user: context.user
      });
      appTools = appTools.concat(appAsTools);
    } catch (error) {
      logger.error('Error generating app-as-tool tools', {
        component: 'ToolLoader',
        appId: app.id,
        error
      });
    }
  }

  // Skill tools, while the skills feature is on and the app turned skills on
  // (`skillSettings.enabled`). `activate_skill` and
  // `read_skill_resource` come when there is a skill to load: one the model is
  // offered (the list in the system prompt) or one active in this turn
  // (`context.activeSkills`); their names are the only values the tools take.
  // `find_skill` comes when that list is shortened to fit its token budget.
  // A system skill (e.g. `pdf`) also brings built-in tools (`create_pdf`):
  // they come with the usable global skills.
  if (isFeatureEnabled('skills', configCache.getFeatures()) && skillsEnabledIn(app)) {
    const lang = language || 'en';
    const catalog = await describeSkillCatalog({ app, user: context.user });
    const active = Array.isArray(context.activeSkills) ? context.activeSkills : [];
    const skillNames = [
      ...new Set([...catalog.entries.map(entry => entry.name), ...active.map(skill => skill.name)])
    ];
    if (skillNames.length > 0) {
      const skillNameParameter = description => ({
        type: 'string',
        description,
        ...(skillNames.length <= MAX_SKILL_NAME_ENUM ? { enum: skillNames } : {})
      });
      const activateDesc = {
        en: 'Load the full instructions for a skill when it is relevant to the current task. Call this when you identify a task that matches an available skill from the <available_skills> list.',
        de: 'Lade die vollständigen Anweisungen für einen Skill, wenn er für die aktuelle Aufgabe relevant ist.'
      };
      const readDesc = {
        en: 'Read a referenced file from an activated skill (scripts, references, assets).',
        de: 'Lese eine referenzierte Datei aus einem aktivierten Skill.'
      };

      appTools.push({
        id: ACTIVATE_SKILL_TOOL_ID,
        name: getLocalizedString({ en: 'Activate Skill', de: 'Skill aktivieren' }, lang),
        description: getLocalizedString(activateDesc, lang),
        isInternalTool: true,
        parameters: {
          type: 'object',
          properties: {
            skill_name: skillNameParameter('The name of the skill to activate')
          },
          required: ['skill_name']
        }
      });

      appTools.push({
        id: READ_SKILL_RESOURCE_TOOL_ID,
        name: getLocalizedString({ en: 'Read Skill Resource', de: 'Skill-Ressource lesen' }, lang),
        description: getLocalizedString(readDesc, lang),
        isInternalTool: true,
        parameters: {
          type: 'object',
          properties: {
            skill_name: skillNameParameter('The name of the skill whose resource to read'),
            file_path: {
              type: 'string',
              description:
                "Relative path from the skill root, e.g. 'references/REFERENCE.md' or 'scripts/extract.py'"
            }
          },
          required: ['skill_name', 'file_path']
        }
      });

      if (catalog.compact) {
        appTools.push({
          id: FIND_SKILL_TOOL_ID,
          name: getLocalizedString({ en: 'Find Skill', de: 'Skill suchen' }, lang),
          description: getLocalizedString(
            {
              en: 'Search the available skills by keywords and get the full description of the best matches. Use it when the <available_skills> list is shortened and none of the listed names clearly fits the task.',
              de: 'Durchsuche die verfügbaren Skills nach Stichworten und erhalte die vollständige Beschreibung der besten Treffer.'
            },
            lang
          ),
          isInternalTool: true,
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'A few keywords for the task, e.g. "weekly newsletter draft"'
              }
            },
            required: ['query']
          }
        });
      }
    }

    const appSkills = await getUsableSkills({ skillIds: app.skills, user: context.user });
    // The document skills' tools follow the app's document template.
    const templates = usesDocumentTemplates(appSkills)
      ? await (
          await import('./services/documents/templates/DocumentTemplateService.js')
        ).documentTemplateContext({ app, language: lang })
      : null;
    const skillTools = systemSkillToolsFor(appSkills, {
      language: lang,
      model: context.model,
      templates
    });
    appTools = appTools.concat(skillTools.filter(t => !appTools.some(a => a.id === t.id)));
  }

  // The scheduling tools are listed by the apps that offer them, but only
  // reach a user who may use scheduled tasks — and a scheduled run never gets
  // the ones that would let a task create, delete or start tasks.
  //
  // Every tool leaves stamped with its approval policy (#2945): `approval`,
  // `sideEffect`, `dataFlow` and `approvalSource`, resolved from the platform
  // default, the tool or installation, the action and this app. The approval
  // seam of the chat, workflow nodes and scheduled runs reads the stamp.
  return stampToolApproval(
    filterSchedulingTools(appTools, context.user),
    app,
    configCache.getPlatform?.() || null,
    { getInstallation: installedIntegrationById }
  );
}

/**
 * Export the localizeTools function for use by other modules
 * @param {Array} tools - Array of tool objects
 * @param {string} language - User language (e.g., 'en', 'de')
 * @returns {Array} - Localized tools
 */
export { localizeTools };

/**
 * Dynamically import and run a tool implementation securely.
 * Tool implementations live in `server/tools` and export a default async function.
 *
 * @param {string} toolId - Tool identifier
 * @param {object} params - Parameters passed to the tool
 * @param {object} [options]
 * @param {Function} [options.onMcpAppResult] - For an MCP tool that renders an
 *   MCP App view: receives the raw CallToolResult (structured content, `_meta`,
 *   `isError`) the view is drawn from. The return value stays the model-facing
 *   result either way.
 * @param {AbortSignal} [options.signal] - The chat turn's abort signal. Remote
 *   A2A agents honour it: a user stop aborts the request and cancels the task.
 */
export async function runTool(toolId, params = {}, options = {}) {
  logger.info('Running tool', { component: 'ToolLoader', toolId });
  if (!isValidId(toolId)) {
    throw new Error('Invalid tool id');
  }

  // Check if this is a skill activation tool
  if (toolId === ACTIVATE_SKILL_TOOL_ID) {
    const skillName = params.skill_name;
    if (!skillName) {
      throw new Error('skill_name parameter is required');
    }
    // A skill whose instructions this turn's system prompt already carries
    // (it is active in the chat) is not loaded a second time.
    const active = activeSkillsOf(params.appConfig).find(entry => entry.name === skillName);
    if (active?.full) {
      return `Skill '${skillName}' is already active: its instructions are in the <active_skill name="${skillName}"> block of the system prompt. Follow them; there is no need to load it again.`;
    }
    // Only a skill this app (or agent node) and this user may use loads; any
    // other name gets the same answer as a missing skill.
    const skill = await loadUsableSkill(skillName, {
      skillIds: getAssignedSkillIds(params.appConfig),
      user: params.user,
      app: params.appConfig
    });
    if (!skill) {
      logger.warn('Refused to activate a skill that is not available here', {
        component: 'ToolLoader',
        skillName
      });
      return `Skill '${skillName}' not found or could not be loaded.`;
    }
    // `disable-model-invocation`: only a user starts the skill, with `/name`.
    // Once they did, it is active and its instructions may be read.
    if (!active && !isModelInvocable(skill)) {
      logger.warn('Refused to activate a skill only users may start', {
        component: 'ToolLoader',
        skillName
      });
      return `Skill '${skillName}' can only be started by the user, by writing /${skill.displayName} in a message.`;
    }
    logger.info('Activating skill', { component: 'ToolLoader', skillName });
    // Emit skill activation SSE event for UI indicators. `skillId` is what
    // the next turns of the chat keep the skill active by; `activatedBy`
    // tells them the model chose it.
    const chatId = params.chatId;
    if (chatId) {
      emitToolProgress(chatId, {
        phase: 'skill.activation',
        message: skill.displayName,
        data: {
          skillName: skill.displayName,
          skillId: skill.name,
          activatedBy: 'model',
          description: skill.description
        }
      });
    }

    // Agent runs: persist the activated skill body to workflow state so
    // subsequent prompt nodes (planner re-iterations, task workers, the
    // synthesizer) automatically see it via the <active_skill> block.
    // Apps that aren't running under an agent workflow keep the existing
    // ephemeral tool-result-only behavior.
    const workflowState = params.appConfig?._workflowState;
    if (workflowState && workflowState.data) {
      workflowState.data._activatedSkills = workflowState.data._activatedSkills || {};
      workflowState.data._activatedSkills[skillName] = {
        body: skill.body,
        description: skill.description,
        // Persist the bundled-file paths so later workflow nodes render the
        // read_skill_resource hint in their <active_skill> block, not just the
        // body — the tool is exposed to them, the guidance must travel with it.
        resources: skill.resources,
        activatedAt: new Date().toISOString(),
        activatedBy: params.user?.isAgent ? `agent:${params.user.profileId || 'unknown'}` : 'llm'
      };
      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.skill.activated',
          chatId,
          skillName,
          description: skill.description,
          activatedBy: 'llm'
        });
      } catch {
        // Best effort.
      }
    }

    let result = skill.body;
    // List the files the skill bundles, and name the tool and skill_name to
    // read them with. These are skill-relative paths, not URLs or local files:
    // a web page reader given "references/x.md" fails with "Invalid URL", so
    // steer the model to read_skill_resource explicitly.
    if (skill.resources.length > 0) {
      result += `\n\n---\nThis skill bundles these files. Read one with the read_skill_resource tool (skill_name "${skill.name}", file_path the path below), never with another web, URL or file-reading tool:\n${skill.resources
        .map(r => `- ${r}`)
        .join('\n')}`;
    }
    return result;
  }

  // Check if this is a skill resource read tool
  if (toolId === READ_SKILL_RESOURCE_TOOL_ID) {
    const { skill_name: skillName, file_path: filePath } = params;
    if (!skillName || !filePath) {
      throw new Error('skill_name and file_path parameters are required');
    }
    const skill = await loadUsableSkill(skillName, {
      skillIds: getAssignedSkillIds(params.appConfig),
      user: params.user,
      app: params.appConfig
    });
    if (!skill) {
      logger.warn('Refused to read a resource of a skill that is not available here', {
        component: 'ToolLoader',
        skillName
      });
      return `Resource '${filePath}' not found in skill '${skillName}' or access denied.`;
    }
    logger.info('Reading skill resource', { component: 'ToolLoader', skillName, filePath });
    const content = typeof filePath === 'string' ? await skill.readFile(filePath) : null;
    if (content === null) {
      return `Resource '${filePath}' not found in skill '${skillName}' or access denied.`;
    }
    return content;
  }

  // Search the skills the model is offered, when their list in the system
  // prompt is shortened: the same catalog, so the same access rules.
  if (toolId === FIND_SKILL_TOOL_ID) {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return 'Give a few keywords that describe the task, e.g. "weekly newsletter draft".';
    }
    const { entries } = await describeSkillCatalog({ app: params.appConfig, user: params.user });
    const matches = searchSkillCatalog(entries, query);
    logger.info('Searching skills', {
      component: 'ToolLoader',
      query,
      matches: matches.length
    });
    if (matches.length === 0) {
      return `No skill matches "${query}". Try other keywords, or go ahead without a skill.`;
    }
    const lines = matches.map(entry => `- ${entry.name}: ${entry.description}`);
    return `Skills matching "${query}":\n${lines.join('\n')}\n\nCall activate_skill with a skill's name to load its instructions.`;
  }

  // Built-in tools of system skills (`create_pdf`, …). They are offered only
  // through a skill the app enables (see getToolsForApp); here a direct call
  // is checked against the user's skill permissions as well.
  if (isSystemSkillTool(toolId)) {
    const { data: userSkills } = await configCache.getSkillsForUser(
      params.user,
      configCache.getPlatform() || {}
    );
    const provided = userSkills.some(
      skill => skill.isSystem && skill.providedTools?.includes(toolId)
    );
    if (!isFeatureEnabled('skills', configCache.getFeatures()) || !provided) {
      throw new Error(`Tool ${toolId} is not available`);
    }
    return await runSystemSkillTool(toolId, params);
  }

  // App-as-tool (`app__<appId>`): invoke another iHub app through the shared
  // gateway. Runs the callee's full chat pipeline in-process (no REST hop);
  // permission, feature-flag, and nesting guards live in the gateway.
  if (toolId.startsWith('app__')) {
    const { invokeAppTool } = await import('./services/chat/appToolsGateway.js');
    const { chatId, user, appConfig, language, ...args } = params;
    return await invokeAppTool({
      toolId,
      args,
      user,
      chatId,
      language,
      callerAppId: appConfig?.id
    });
  }

  // Check if this is a workflow tool (starts with 'workflow_')
  if (toolId.startsWith(WORKFLOW_TOOL_ID_PREFIX)) {
    const mod = await import('./tools/workflowRunner.js');
    return await mod.default({
      ...params,
      workflowId: toolId.slice(WORKFLOW_TOOL_ID_PREFIX.length)
    });
  }

  // The project knowledge tools belong to projects and are not in the tool
  // list: the projects feature runs them, and the implementation resolves the
  // request's project scope (`params.appConfig`, `params.user`) on every call.
  if (isKnowledgeTool(toolId)) {
    return await runKnowledgeTool(toolId, params);
  }

  // Find tool definition to determine the script file
  const allTools = await loadTools();
  const tool = allTools.find(t => t.id === toolId);
  if (!tool) {
    throw new Error(`Tool ${toolId} not found`);
  }

  // Tools of installed integrations run through their protocol adapter.
  if (tool._integration) {
    logger.info('Dispatching integration tool call', {
      component: 'ToolLoader',
      toolId,
      instanceId: tool._integration.instanceId
    });
    const { runIntegrationTool } = await import('./services/integrations/integrationTools.js');
    return await runIntegrationTool(tool, params, options);
  }

  // MCP tools are dispatched through McpClientManager.callTool.
  if (tool._mcp) {
    logger.info('Dispatching MCP tool call', {
      component: 'ToolLoader',
      toolId,
      serverId: tool._mcp.serverId
    });
    return await mcpClientManager.callTool(toolId, params, {
      onRawResult: options.onMcpAppResult
    });
  }

  // Skills of remote A2A agents are dispatched through A2aClientManager.callTool.
  if (tool._a2a) {
    logger.info('Dispatching A2A agent tool call', {
      component: 'ToolLoader',
      toolId,
      agentId: tool._a2a.agentId
    });
    // `signal` is the chat turn's abort signal: a user stop ends the remote
    // request and cancels a running task.
    return await a2aClientManager.callTool(toolId, params, { signal: options.signal });
  }

  // OpenAPI tools are dispatched through the OpenApiToolRunner.
  if (tool.type === 'openapi') {
    logger.info('Dispatching OpenAPI tool call', { component: 'ToolLoader', toolId });
    const { runOpenApiTool } = await import('./services/tools/OpenApiToolRunner.js');
    const { chatId, user, appConfig, ...args } = params;
    return await runOpenApiTool(tool, args, { chatId, user, appConfig });
  }

  // Check if this is a special tool (like Google Search) that doesn't have a script
  if (tool.isSpecialTool) {
    // Special tools are handled by the model provider directly, not executed here
    logger.info('Special tool is handled by provider, skipping execution', {
      component: 'ToolLoader',
      toolId
    });
    return { handled_by_provider: true };
  }

  const scriptName = tool.script || `${toolId}.js`;
  if (!isValidId(scriptName.replace(/\.js$/, ''))) {
    throw new Error('Invalid script name');
  }

  try {
    const mod = await import(`./tools/${scriptName}`);
    const fn = tool.method ? mod[tool.method] : mod.default;
    if (typeof fn !== 'function') {
      throw new Error(`Tool ${toolId} does not export function ${tool.method || 'default'}`);
    }

    // Apply default parameter values defined in the tool schema
    if (tool.parameters && tool.parameters.properties) {
      for (const [key, prop] of Object.entries(tool.parameters.properties)) {
        if (params[key] === undefined && prop.default !== undefined) {
          params[key] = prop.default;
        }
      }
    }

    return await fn(params);
  } catch (error) {
    logger.error('Failed to execute tool', {
      component: 'ToolLoader',
      toolId,
      errorName: error?.name,
      errorMessage: error?.message,
      errorCode: error?.code,
      errorCause: error?.cause?.message || error?.cause,
      error
    });
    throw error;
  }
}
