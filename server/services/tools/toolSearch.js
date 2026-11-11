// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool search: when the tools of an app's integrations are too many to hand to
 * the model in full on every request, the largest integrations are left out of
 * the request's `tools` and the model gets one tool instead:
 *
 *  - `search_tools(query)` finds the best matching tools (the same keyword
 *    ranking as `find_skill`) and **loads them**: they join the request's
 *    `tools` from the model's next step on, and the model calls them like any
 *    other tool, with their own schema.
 *
 * The left-out tools are listed in the system prompt as `<available_tools>`,
 * by integration. The list depends only on the tools, never on the message, so
 * the prompt stays the same from turn to turn and caches; the request changes
 * only in a turn whose model searched.
 *
 * The agent loop owns the loading (`createToolSearch()` is its view of the
 * request): a found tool is pushed onto the loop's tool list, so the approval
 * gate, the activity list, the run log and the usage logs treat it as the
 * ordinary tool call it is. Only a tool left out of this request for this user
 * can be found. A tool is found by name or task, never called by name before:
 * until it is loaded it is not in `tools`, and the loop answers a call to it
 * like a call to any unknown tool.
 *
 * The chat history that goes to the model holds the prose of earlier turns,
 * never their tool calls, so a tool found in one turn is not carried into the
 * next: the model searches again when it needs it.
 *
 * Only the tools of integrations are left out (see {@link isDeferrable}). What
 * the chat loop or a seam handles specially, and every other tool an app is
 * offered (skills, project knowledge, workflows, apps), stays loaded.
 *
 * @module services/tools/toolSearch
 */

import { estimateTokensMemo } from '../../../shared/tokenEstimator.js';
import { getLocalizedString } from '../../utils/localize.js';
import { searchCatalog } from '../../utils/catalogSearch.js';
import { isInteractiveTool } from '../../utils/toolSelection.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { escapeXml } from '../skillAccess.js';
import { isWebSearchEngineTool } from '../search/webSearchEngines.js';
import { localized } from '../integrations/definitions/installedValues.js';
import { appendSystemBlock, buildIntegrationGuidance } from '../integrations/actionGuidance.js';
import { matchTool } from '../loop/toolArgs.js';

export const SEARCH_TOOLS_TOOL_ID = 'search_tools';

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

/** Most tools one `search_tools` call loads. */
export const MAX_FOUND_TOOLS = 5;

/** Most tools one run loads through `search_tools`, however often the model searches. */
export const MAX_LOADED_BY_SEARCH = 15;

/**
 * Whether a tool is the search tool tool search adds.
 *
 * @param {Object|null|undefined} tool
 * @returns {boolean}
 */
export function isToolSearchTool(tool) {
  return tool?.isToolSearch === true;
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
  return estimateTokensMemo(
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
 * @param {number} [options.reservedTokens] - Tokens the search tool will need
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

/** `text` without the white space and punctuation at its end. */
function trimTrailingPunctuation(text) {
  let end = text.length;
  while (end > 0 && /[\s.,;:!?-]/.test(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/** `text` cut to about `max` characters at a word boundary, on one line. */
function shorten(text, max = SHORT_DESCRIPTION_CHARS) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${trimTrailingPunctuation(space > max / 2 ? cut.slice(0, space) : cut)}…`;
}

const INDEX_INTRO =
  'Some tools are not loaded, to keep the request small. They are listed here by integration. To use one, call search_tools with a few keywords: the tools it finds are added to your tools, and you can call them in your next step.';
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
    `${INDEX_INTRO}${note ? ' ' + note : ''}\n<available_tools>\n${groups
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
  if (estimateTokensMemo(withDescriptions) <= maxTokens) {
    return { text: withDescriptions, level: 'descriptions' };
  }

  const names = render(
    INDEX_NAMES_NOTE,
    group => ` tools="${escapeXml(group.tools.map(tool => tool.id).join(', '))}"/>`
  );
  if (estimateTokensMemo(names) <= maxTokens) return { text: names, level: 'names' };

  return {
    text: render(INDEX_COUNTS_NOTE, group => ` tools="${group.tools.length}"/>`),
    level: 'integrations'
  };
}

/**
 * The tool the model gets when tools are left out.
 *
 * @param {string} [language]
 * @returns {Object} `search_tools`
 */
export function toolSearchToolDefinition(language = 'en') {
  const lang = language || 'en';
  return {
    id: SEARCH_TOOLS_TOOL_ID,
    name: getLocalizedString({ en: 'Search tools', de: 'Tools suchen' }, lang),
    description: getLocalizedString(
      {
        en: 'Search the tools that are not loaded. Give a few keywords (a tool name, a system such as "jira", or the task). The best matches are added to your tools, and you can call them in your next step.',
        de: 'Durchsuche die nicht geladenen Tools nach Stichworten (Tool-Name, System oder Aufgabe). Die besten Treffer werden deinen Tools hinzugefügt, und du kannst sie im nächsten Schritt aufrufen.'
      },
      lang
    ),
    isInternalTool: true,
    readOnly: true,
    isToolSearch: true,
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
  };
}

/** One loaded tool as `search_tools` reports it: name, where it belongs, description. */
function describeFound(tool) {
  const integration = tool._integration || {};
  const title = integration.actionTitle ? `${labelOf(tool)}: ${integration.actionTitle}` : null;
  const lines = [title ? `- ${tool.id} (${title})` : `- ${tool.id}`];
  // One line. `\s+` runs in linear time; `\s*\n\s*` is quadratic on a long run of
  // white space, and a remote MCP server writes these descriptions.
  if (tool.description) lines.push(`  ${shorten(tool.description, 300)}`);
  return lines.join('\n');
}

/**
 * What `search_tools` answers, and which tools it loads: the best matches
 * among the tools left out, with the guidance of their integrations.
 *
 * @param {Array<Object>} deferred - The tools still left out
 * @param {string} query
 * @param {number} [limit] - Most tools to load
 * @returns {{text: string, found: Array<Object>}} `found` is what the loop adds to its tools
 */
export function searchDeferredTools(deferred, query, limit = MAX_FOUND_TOOLS) {
  const words = typeof query === 'string' ? query.trim() : '';
  if (!words) {
    return {
      text: 'Give a few keywords that describe the tool or the task, e.g. "create jira ticket".',
      found: []
    };
  }
  if (limit <= 0) {
    return {
      text: `Enough tools are loaded (${MAX_LOADED_BY_SEARCH}). Use the tools you have.`,
      found: []
    };
  }
  const entries = deferred.map(tool => ({
    name: tool.id,
    displayName: `${labelOf(tool)} ${tool._integration?.actionTitle || ''}`,
    description: tool.description || '',
    tool
  }));
  const found = searchCatalog(entries, words, limit).map(entry => entry.tool);
  if (found.length === 0) {
    return {
      text: `No tool matches "${words}". Try other keywords: a tool name from <available_tools>, the system (e.g. "jira") or the task.`,
      found: []
    };
  }
  const guidance = buildIntegrationGuidance(found);
  return {
    text: [
      `These tools match "${words}" and are now loaded. Call them directly in your next step:`,
      found.map(describeFound).join('\n'),
      ...(guidance ? [guidance] : [])
    ].join('\n\n'),
    found
  };
}

/**
 * The loop's view of tool search for one request: the tools still left out,
 * what `search_tools` answers and which tools it loads. The object keeps what
 * is left out, so a tool found once is not found again.
 *
 * @param {Object} options
 * @param {Array<Object>} options.deferred - The tools left out of the request
 * @returns {{
 *   deferred: Array<Object>,
 *   search: (args: Object) => {text: string, found: Array<Object>},
 *   take: (toolId: string) => (Object|null),
 *   without: (isWithheld: (tool: Object) => boolean) => Object
 * }} `search` loads the tools it finds (at most {@link MAX_LOADED_BY_SEARCH} per
 *   run): they leave `deferred`, and the caller adds them to its tool list.
 *   `take` loads one tool by name (the call a person approved, resumed in a
 *   later request), or null when it is not left out.
 */
export function createToolSearch({ deferred }) {
  const remaining = [...deferred];
  let loaded = 0;
  const load = found => {
    for (const tool of found) remaining.splice(remaining.indexOf(tool), 1);
  };
  return {
    get deferred() {
      return remaining;
    },
    search(args) {
      const answer = searchDeferredTools(
        remaining,
        args?.query,
        Math.min(MAX_FOUND_TOOLS, MAX_LOADED_BY_SEARCH - loaded)
      );
      load(answer.found);
      loaded += answer.found.length;
      return answer;
    },
    take(toolId) {
      const tool = matchTool(toolId, remaining);
      if (tool) load([tool]);
      return tool;
    },
    /** The same search over the tools `isWithheld` does not name (a caller's own gate). */
    without: isWithheld =>
      createToolSearch({ deferred: remaining.filter(tool => !isWithheld(tool)) })
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
  const searchTool = toolSearchToolDefinition(language);
  const searchToolTokens = toolDefinitionTokens(searchTool);
  const { loaded, deferred } = splitTools(tools, {
    maxTokens: maxToolTokensFor(app, model),
    alwaysLoaded: keepLoaded,
    reservedTokens: searchToolTokens
  });
  if (deferred.length === 0) return unchanged;

  const index = buildToolIndex(deferred);
  // Searching must be cheaper than carrying the tools.
  const saved = deferred.reduce((sum, tool) => sum + toolDefinitionTokens(tool), 0);
  if (saved <= estimateTokensMemo(index.text) + searchToolTokens) return unchanged;

  return {
    tools: [...loaded, searchTool],
    toolSearch: createToolSearch({ deferred }),
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
