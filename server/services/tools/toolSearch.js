// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool search: when the tools of an app's integrations are too many to hand to
 * the model in full on every request, the largest integrations are left out of
 * the request's `tools`. The model gets two tools instead, and finds and runs
 * what it needs through them:
 *
 *  - `search_tools(query)` answers with the full description and parameters of
 *    the best matching tools (the same keyword ranking as `find_skill`);
 *  - `call_tool(name, arguments)` runs one of the left-out tools.
 *
 * The left-out tools are listed in the system prompt as `<available_tools>`,
 * by integration. The list depends only on the tools, never on the message, so
 * the prompt stays the same from turn to turn and caches.
 *
 * A model cannot call a tool that is not in the request's `tools`: strict
 * providers (OpenAI Responses, vLLM) refuse the call outright. That is why a
 * left-out tool runs through `call_tool`. The agent loop unwraps the call
 * before anything else looks at it (`createToolSearch().resolveCall`), so the
 * approval gate, the activity list, the run log and the usage logs all see the
 * real tool, never `call_tool`. `arguments` is JSON written as text because a
 * free-form object cannot be expressed on every provider (the OpenAI
 * Responses converter forces `additionalProperties: false` on every object,
 * the Google converter strips it), so an object parameter could only ever be
 * empty or unchecked; an object is accepted too.
 *
 * Only the tools of integrations are left out (see {@link isDeferrable}). What
 * the chat loop or a seam handles specially, and every other tool an app is
 * offered (skills, project knowledge, workflows, apps), stays loaded.
 *
 * @module services/tools/toolSearch
 */

import { estimateTokens } from '../../../shared/tokenEstimator.js';
import { getLocalizedString } from '../../utils/localize.js';
import { searchCatalog } from '../../utils/catalogSearch.js';
import { isInteractiveTool } from '../../utils/toolSelection.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { escapeXml } from '../skillAccess.js';
import { isWebSearchEngineTool } from '../search/webSearchEngines.js';
import { localized } from '../integrations/definitions/installedValues.js';
import { appendSystemBlock, buildIntegrationGuidance } from '../integrations/actionGuidance.js';
import { applyParameterDefaults, matchTool, repairToolArguments } from '../loop/toolArgs.js';
import { createOutputValidator, normalizeSchema } from '../inference/structuredOutput.js';

export const SEARCH_TOOLS_TOOL_ID = 'search_tools';

export const CALL_TOOL_TOOL_ID = 'call_tool';

export const TOOL_SEARCH_TOOL_IDS = Object.freeze([SEARCH_TOOLS_TOOL_ID, CALL_TOOL_TOOL_ID]);

/** Platform feature (Admin → Features) that switches tool search on. */
export const TOOL_SEARCH_FEATURE_ID = 'toolSearch';

/** Tokens the tool definitions of one request may take before integrations are left out. */
export const DEFAULT_MAX_TOOL_TOKENS = 6000;

/** The share of the model's context window the tool definitions may take at most. */
export const TOOL_BUDGET_CONTEXT_SHARE = 0.1;

/** The budget never gets smaller than this, however small the model's context window. */
export const MIN_TOOL_BUDGET_TOKENS = 500;

/** Tokens the `<available_tools>` list may take. */
export const MAX_INDEX_TOKENS = 1500;

/** Length a description is shortened to in the list. */
export const SHORT_DESCRIPTION_CHARS = 100;

/** Most tools one `search_tools` call returns. */
export const MAX_FOUND_TOOLS = 5;

/** Longest schema, in characters, an argument error quotes back to the model. */
const MAX_QUOTED_SCHEMA_CHARS = 4000;

/**
 * Whether a tool is one of the two tools tool search adds.
 *
 * @param {Object|null|undefined} tool
 * @returns {boolean}
 */
export function isToolSearchTool(tool) {
  return Boolean(tool) && TOOL_SEARCH_TOOL_IDS.includes(tool.id) && Boolean(tool.toolSearchRole);
}

/**
 * Whether an app uses tool search: the platform feature is on and the app did
 * not switch it off (`toolSearch.mode: 'off'`; absent = `auto`).
 *
 * @param {Object} app
 * @param {Object} [features] - `configCache.getFeatures()`
 * @returns {boolean}
 */
export function toolSearchEnabledFor(app, features) {
  return isFeatureEnabled(TOOL_SEARCH_FEATURE_ID, features) && app?.toolSearch?.mode !== 'off';
}

/**
 * The token budget of the tool definitions in one request: the app's
 * `toolSearch.maxToolTokens` or {@link DEFAULT_MAX_TOOL_TOKENS}, at most
 * {@link TOOL_BUDGET_CONTEXT_SHARE} of the model's context window (a small
 * local model cannot afford the tools of a big app), at least
 * {@link MIN_TOOL_BUDGET_TOKENS}.
 *
 * @param {Object} app
 * @param {Object} [model] - The resolved model (`contextWindow`)
 * @returns {number}
 */
export function maxToolTokensFor(app, model) {
  const configured = app?.toolSearch?.maxToolTokens;
  const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_TOOL_TOKENS;
  const window = model?.contextWindow;
  const share =
    Number.isFinite(window) && window > 0
      ? Math.floor(window * TOOL_BUDGET_CONTEXT_SHARE)
      : Infinity;
  return Math.max(MIN_TOOL_BUDGET_TOKENS, Math.min(base, share));
}

/**
 * What a tool definition costs in the request: its name, description and
 * parameter schema, which is what every provider receives.
 *
 * @param {Object} tool
 * @returns {number}
 */
export function toolDefinitionTokens(tool) {
  return estimateTokens(
    JSON.stringify({ name: tool.id, description: tool.description, parameters: tool.parameters })
  );
}

/**
 * Whether a tool may be left out of the request: the action of an installed
 * integration, except the ones the loop or a seam handles itself — a question
 * to the user (`ask_user`), a passthrough tool, the search of a web search
 * engine (the page reader and native search stay with it).
 *
 * @param {Object} tool
 * @returns {boolean}
 */
export function isDeferrable(tool) {
  return (
    Boolean(tool?._integration?.instanceId) &&
    !isInteractiveTool(tool) &&
    tool.interactive !== true &&
    tool.passthrough !== true &&
    tool.isInternalTool !== true &&
    !isWebSearchEngineTool(tool)
  );
}

/**
 * Split an app's tools into the ones sent in full and the ones left out. Whole
 * integrations are left out, the biggest first, until what is sent fits the
 * budget: a model that needs one tool of an integration usually needs several,
 * and one list entry per integration is cheaper than one per tool. An
 * integration the app binds with `alwaysLoaded: true` is never left out, and
 * nothing is left out when everything fits.
 *
 * @param {Array<Object>} tools - The turn's tools, in order
 * @param {Object} options
 * @param {number} options.maxTokens - {@link maxToolTokensFor}
 * @param {Set<string>} [options.alwaysLoaded] - Installation ids that stay loaded
 * @param {number} [options.reservedTokens] - Tokens the two search tools will need
 * @returns {{loaded: Array<Object>, deferred: Array<Object>}} Both in the original order
 */
export function splitTools(tools, { maxTokens, alwaysLoaded = new Set(), reservedTokens = 0 }) {
  const list = Array.isArray(tools) ? tools : [];
  const costs = new Map(list.map(tool => [tool, toolDefinitionTokens(tool)]));
  const total = [...costs.values()].reduce((sum, cost) => sum + cost, 0);
  if (total <= maxTokens) return { loaded: list, deferred: [] };

  // Integrations that may be left out, with what they cost and where they come first.
  const groups = new Map();
  list.forEach((tool, index) => {
    if (!isDeferrable(tool) || alwaysLoaded.has(tool._integration.instanceId)) return;
    const id = tool._integration.instanceId;
    const group = groups.get(id) || { id, tokens: 0, first: index };
    group.tokens += costs.get(tool);
    groups.set(id, group);
  });

  const leftOut = new Set();
  let sent = total + reservedTokens;
  for (const group of [...groups.values()].sort(
    (a, b) => b.tokens - a.tokens || a.first - b.first
  )) {
    if (sent <= maxTokens) break;
    leftOut.add(group.id);
    sent -= group.tokens;
  }
  if (leftOut.size === 0) return { loaded: list, deferred: [] };
  return {
    loaded: list.filter(tool => !leftOut.has(tool._integration?.instanceId) || !isDeferrable(tool)),
    deferred: list.filter(tool => leftOut.has(tool._integration?.instanceId) && isDeferrable(tool))
  };
}

/** A label that may still be a localized object, as text. */
function labelOf(tool) {
  const label = tool?._integration?.instanceLabel;
  return (
    (typeof label === 'string' ? label : localized(label, 'en', '')) ||
    String(tool?._integration?.instanceId || '')
  );
}

/** `text` cut to about `max` characters at a word boundary, on one line. */
function shorten(text, max = SHORT_DESCRIPTION_CHARS) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

const INDEX_INTRO =
  'Some tools are not loaded, to keep the request small. They are listed here by integration. To use one, call search_tools with a few keywords to get its description and parameters, then run it with call_tool (name and arguments).';
const INDEX_SHORTENED_NOTE = 'The descriptions are shortened.';
const INDEX_NAMES_NOTE = 'Only the tool names are listed.';
const INDEX_COUNTS_NOTE =
  'Only the integrations are listed; search_tools finds the tools of each of them by name or task.';

/** The tools of the integration `id`, grouped in the order the integrations first appear. */
function groupByIntegration(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const id = tool._integration.instanceId;
    if (!groups.has(id)) groups.set(id, { id, label: labelOf(tool), tools: [] });
    groups.get(id).tools.push(tool);
  }
  return [...groups.values()];
}

/**
 * The `<available_tools>` list for the system prompt, within `maxTokens`.
 * Over the budget it gets shorter step by step:
 *
 * 1. every tool with its description, shortened to {@link SHORT_DESCRIPTION_CHARS};
 * 2. the tool names only;
 * 3. the integrations with the number of their tools.
 *
 * @param {Array<Object>} deferred - The tools left out of the request
 * @param {Object} [options]
 * @param {number} [options.maxTokens]
 * @returns {{text: string, level: 'descriptions'|'names'|'integrations'}} `text` is
 *   empty when nothing is left out
 */
export function buildToolIndex(deferred, { maxTokens = MAX_INDEX_TOKENS } = {}) {
  const groups = groupByIntegration(Array.isArray(deferred) ? deferred : []);
  if (groups.length === 0) return { text: '', level: 'descriptions' };

  const render = (note, body) =>
    `${INDEX_INTRO}${note ? ` ${note}` : ''}\n<available_tools>\n${groups
      .map(
        group =>
          `  <integration name="${escapeXml(group.label)}" id="${escapeXml(group.id)}"${body(group)}`
      )
      .join('\n')}\n</available_tools>`;

  const withDescriptions = render(
    INDEX_SHORTENED_NOTE,
    group =>
      `>\n${group.tools
        .map(
          tool =>
            `    <tool name="${escapeXml(tool.id)}">${escapeXml(shorten(tool.description))}</tool>`
        )
        .join('\n')}\n  </integration>`
  );
  if (estimateTokens(withDescriptions) <= maxTokens) {
    return { text: withDescriptions, level: 'descriptions' };
  }

  const names = render(
    INDEX_NAMES_NOTE,
    group => ` tools="${escapeXml(group.tools.map(tool => tool.id).join(', '))}"/>`
  );
  if (estimateTokens(names) <= maxTokens) return { text: names, level: 'names' };

  return {
    text: render(INDEX_COUNTS_NOTE, group => ` tools="${group.tools.length}"/>`),
    level: 'integrations'
  };
}

/**
 * The two tools the model gets when tools are left out.
 *
 * @param {string} [language]
 * @returns {Array<Object>} `[search_tools, call_tool]`
 */
export function toolSearchToolDefinitions(language = 'en') {
  const lang = language || 'en';
  return [
    {
      id: SEARCH_TOOLS_TOOL_ID,
      name: getLocalizedString({ en: 'Search tools', de: 'Tools suchen' }, lang),
      description: getLocalizedString(
        {
          en: 'Search the tools that are not loaded. Give a few keywords (a tool name, a system such as "jira", or the task) and get the full description and parameters of the best matches. Then run a tool with call_tool.',
          de: 'Durchsuche die nicht geladenen Tools nach Stichworten (Tool-Name, System oder Aufgabe) und erhalte Beschreibung und Parameter der besten Treffer. Führe ein Tool danach mit call_tool aus.'
        },
        lang
      ),
      isInternalTool: true,
      readOnly: true,
      toolSearchRole: 'search',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A few keywords for the tool or the task, e.g. "create jira ticket"'
          }
        },
        required: ['query']
      }
    },
    {
      id: CALL_TOOL_TOOL_ID,
      name: getLocalizedString({ en: 'Call tool', de: 'Tool aufrufen' }, lang),
      description: getLocalizedString(
        {
          en: 'Run a tool that is not loaded. Find it first with search_tools (or take its name from <available_tools>). Pass its name and its arguments as a JSON object written as text.',
          de: 'Führe ein nicht geladenes Tool aus. Finde es zuerst mit search_tools (oder nimm den Namen aus <available_tools>). Übergib Name und Argumente als JSON-Objekt in Textform.'
        },
        lang
      ),
      isInternalTool: true,
      toolSearchRole: 'call',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The name of the tool, exactly as search_tools or <available_tools> gives it'
          },
          arguments: {
            type: 'string',
            description:
              'The tool arguments as a JSON object written as text, e.g. {"query":"open bugs"}. {} for a tool without parameters.'
          }
        },
        required: ['name', 'arguments']
      }
    }
  ];
}

/** One tool as `search_tools` shows it: name, where it belongs, description, parameters. */
function describeFound(tool) {
  const integration = tool._integration || {};
  const title = integration.actionTitle ? `${labelOf(tool)}: ${integration.actionTitle}` : null;
  const lines = [`- ${tool.id}${title ? ` (${title})` : ''}`];
  if (tool.description) lines.push(`  ${String(tool.description).replace(/\s*\n\s*/g, ' ')}`);
  lines.push(
    `  Parameters (JSON Schema): ${JSON.stringify(tool.parameters || { type: 'object' })}`
  );
  return lines.join('\n');
}

/**
 * What `search_tools` answers: the best matches with their parameters, the
 * guidance of their integrations, and how to run them.
 *
 * @param {Array<Object>} deferred
 * @param {string} query
 * @returns {string}
 */
export function searchDeferredTools(deferred, query) {
  const words = typeof query === 'string' ? query.trim() : '';
  if (!words) {
    return 'Give a few keywords that describe the tool or the task, e.g. "create jira ticket".';
  }
  const entries = deferred.map(tool => ({
    name: tool.id,
    displayName: `${labelOf(tool)} ${tool._integration?.actionTitle || ''}`,
    description: tool.description || '',
    tool
  }));
  const matches = searchCatalog(entries, words, MAX_FOUND_TOOLS).map(entry => entry.tool);
  if (matches.length === 0) {
    return `No tool matches "${words}". Try other keywords: a tool name from <available_tools>, the system (e.g. "jira") or the task.`;
  }
  const guidance = buildIntegrationGuidance(matches);
  return [
    `Tools matching "${words}":`,
    matches.map(describeFound).join('\n'),
    'Run one with call_tool: name is the tool name above, arguments is a JSON object written as text that matches its parameters.',
    ...(guidance ? [guidance] : [])
  ].join('\n\n');
}

/** Why the arguments do not fit the tool's schema, for the model to correct. */
function argumentProblem(toolDef, args) {
  const schema = normalizeSchema(toolDef.parameters);
  if (!schema) return null;
  let verdict;
  try {
    verdict = createOutputValidator({ kind: 'json_schema', schema })(JSON.stringify(args));
  } catch {
    // A schema that does not compile (or cannot be checked in time): the
    // tool itself reports what it cannot use.
    return null;
  }
  if (verdict.valid) return null;
  const problems = (verdict.errors || [])
    .slice(0, 8)
    .map(error => `${error.path && error.path !== '/' ? `${error.path} ` : ''}${error.message}`)
    .join('; ');
  const quoted = JSON.stringify(toolDef.parameters || {});
  return (
    `The arguments do not match the parameters of ${toolDef.id}: ${problems}. ` +
    `Correct them and call call_tool again. Parameters (JSON Schema): ${
      quoted.length > MAX_QUOTED_SCHEMA_CHARS
        ? `${quoted.slice(0, MAX_QUOTED_SCHEMA_CHARS)}…`
        : quoted
    }`
  );
}

/**
 * The loop's view of tool search for one request: the tools left out, what
 * `search_tools` answers and how a `call_tool` call turns into the call of the
 * tool it names.
 *
 * @param {Object} options
 * @param {Array<Object>} options.deferred - The tools left out of the request
 * @param {Array<Object>} options.tools - The tools the request sends (loaded tools and the two search tools)
 * @returns {{
 *   deferred: Array<Object>,
 *   search: (args: Object) => string,
 *   resolveCall: (args: Object) => ({toolDef: Object, args: Object}|{unknown: string}|{refused: string}),
 *   findDeferred: (toolId: string) => (Object|null),
 *   without: (isWithheld: (tool: Object) => boolean) => Object
 * }}
 */
export function createToolSearch({ deferred, tools }) {
  return {
    deferred,
    search: args => searchDeferredTools(deferred, args?.query),
    findDeferred: toolId => matchTool(toolId, deferred),
    /** The same search over the tools `isWithheld` does not name (a caller's own gate). */
    without: isWithheld =>
      createToolSearch({ deferred: deferred.filter(tool => !isWithheld(tool)), tools }),
    /**
     * `call_tool`'s arguments → the call to run. Only a tool left out of this
     * request can be run: any other name is answered like an unknown tool
     * (`unknown`), a tool the model has loaded is refused with a pointer to
     * calling it directly, and arguments that do not fit the tool's schema
     * are refused with the reason.
     */
    resolveCall(args) {
      const requested = typeof args?.name === 'string' ? args.name.trim() : '';
      if (!requested)
        return { refused: 'name is required: the tool to run, as search_tools gives it.' };
      const toolDef = matchTool(requested, deferred);
      if (!toolDef) {
        if (
          matchTool(
            requested,
            tools.filter(tool => !isToolSearchTool(tool))
          )
        ) {
          return { refused: `${requested} is loaded: call it directly, not through call_tool.` };
        }
        return { unknown: requested };
      }
      const parsed = repairToolArguments(args.arguments);
      if (parsed.failed || Array.isArray(parsed.args)) {
        return {
          refused: `arguments must be a JSON object written as text, e.g. {"query":"open bugs"}; {} for a tool without parameters.`
        };
      }
      const callArgs = applyParameterDefaults({ ...parsed.args }, toolDef);
      const problem = argumentProblem(toolDef, callArgs);
      return problem ? { refused: problem } : { toolDef, args: callArgs };
    }
  };
}

/**
 * Leave the tools an app has too many of out of the request, when the
 * platform feature and the app allow it. The caller applies it to a model that
 * calls tools only: for any other it changes nothing and should not be called.
 *
 * @param {Object} options
 * @param {Array<Object>} options.tools - The turn's tools
 * @param {Object} options.app
 * @param {Object} options.model - The resolved model
 * @param {Object} [options.features] - `configCache.getFeatures()`
 * @param {string} [options.language]
 * @param {Set<string>} [options.alwaysLoaded] - Installation ids the app keeps loaded
 * @returns {{tools: Array<Object>, toolSearch: Object|null, indexText: string}} `tools` is
 *   what the request sends; `toolSearch` is null (and `tools` unchanged) when nothing is left out
 */
export async function prepareToolSearch({ tools, app, model, features, language, alwaysLoaded }) {
  const unchanged = { tools, toolSearch: null, indexText: '' };
  if (!toolSearchEnabledFor(app, features)) return unchanged;

  // Imported here: the integration services read configCache, which reaches this module.
  const keepLoaded =
    alwaysLoaded ??
    (await import('../integrations/integrationTools.js')).alwaysLoadedInstanceIds(app);
  const searchTools = toolSearchToolDefinitions(language);
  const searchToolTokens = searchTools.reduce((sum, tool) => sum + toolDefinitionTokens(tool), 0);
  const { loaded, deferred } = splitTools(tools, {
    maxTokens: maxToolTokensFor(app, model),
    alwaysLoaded: keepLoaded,
    reservedTokens: searchToolTokens
  });
  if (deferred.length === 0) return unchanged;

  const index = buildToolIndex(deferred);
  // Searching must be cheaper than carrying the tools.
  const saved = deferred.reduce((sum, tool) => sum + toolDefinitionTokens(tool), 0);
  if (saved <= estimateTokens(index.text) + searchToolTokens) return unchanged;

  const sent = [...loaded, ...searchTools];
  return {
    tools: sent,
    toolSearch: createToolSearch({ deferred, tools: sent }),
    indexText: index.text
  };
}

/**
 * Add the `<available_tools>` list to the system message (idempotent).
 *
 * @param {Array<Object>} llmMessages
 * @param {string} indexText - {@link buildToolIndex}'s text
 * @returns {boolean} true when it was added
 */
export function appendToolIndex(llmMessages, indexText) {
  return indexText ? appendSystemBlock(llmMessages, indexText) : false;
}
