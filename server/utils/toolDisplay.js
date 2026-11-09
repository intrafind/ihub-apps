// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How a tool call shows in the chat's activity list, decided here and sent on
 * `tool/started` — the client draws what it is told and infers nothing:
 *
 *  - `title`: the action it ran ("Search people"), instead of the id the model
 *    called it by (`muc-ad__search_people`)
 *  - `integration`: the system it ran against ("Munich AD")
 *  - `activityKind`: the row it is — a `search` (query and the sources it
 *    found), a `fetch` (the page or document it read) or a plain `tool` call
 *  - `activityScope`: for a search or fetch, whether it looked at the public
 *    `web` or the organisation's `documents`
 *
 * @module utils/toolDisplay
 */

import { classifyToolKnowledgeSource } from '../services/loop/seams/knowledgeSourceSeam.js';

const MAX_LENGTH = 120;

/** Built-in tools that read one page or document. */
const FETCH_TOOL_IDS = new Set(['read_url', 'ifinder_getcontent', 'knowledge_read']);

function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_LENGTH) : null;
}

/**
 * The row a call is. A connected system — an integration, MCP server or
 * remote agent — is a plain call even when its id says "search"
 * (`jira_searchTickets`): it finds records, not pages or documents. So is a
 * people-directory search. The built-in search, page reader and source
 * lookups are searches and fetches.
 * @param {string} toolId
 * @param {string|null} source - see `classifyToolKnowledgeSource`
 * @returns {'search'|'fetch'|'tool'}
 */
export function activityKindOf(toolId, source) {
  if (source === 'integration') return 'tool';
  const id = String(toolId || '').toLowerCase();
  if (FETCH_TOOL_IDS.has(id)) return 'fetch';
  if (id.includes('people')) return 'tool';
  if (id.includes('search') || id.startsWith('source_') || id === 'knowledge_list') return 'search';
  return 'tool';
}

/**
 * Where a search or fetch looks: the organisation's own documents (iFinder,
 * project knowledge, a configured source) or the public web.
 * @param {string} toolId
 * @param {string|null} source - see `classifyToolKnowledgeSource`
 * @returns {'web'|'documents'}
 */
export function activityScopeOf(toolId, source) {
  if (source === 'websearch') return 'web';
  if (source === 'ifinder' || source === 'sources') return 'documents';
  const id = String(toolId || '').toLowerCase();
  return id.startsWith('ifinder') || id.startsWith('source_') || id.startsWith('knowledge_')
    ? 'documents'
    : 'web';
}

/**
 * @param {Object|null|undefined} toolDef - the resolved (localized) tool definition
 * @returns {{title?: string, integration?: string, activityKind?: string, activityScope?: string}}
 *   the fields that are known; nothing for an unknown tool (a plain call)
 */
export function toolDisplayOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') return {};
  let title = null;
  let integration = null;

  if (toolDef._integration) {
    title = text(toolDef._integration.actionTitle);
    integration = text(toolDef._integration.instanceLabel);
  } else if (toolDef._mcp) {
    title = text(toolDef._mcp.title) || text(toolDef._mcp.originalName);
    integration = text(toolDef._mcp.serverName) || text(toolDef._mcp.serverId);
  } else if (toolDef._a2a) {
    title = text(toolDef._a2a.skillName);
    integration = text(toolDef._a2a.agentName) || text(toolDef._a2a.agentId);
  }

  // Any other tool: its configured (localized) name, when it says more than its id.
  if (!title && !integration) {
    const name = text(toolDef.name);
    if (name && name !== toolDef.id) title = name;
  }

  const source = classifyToolKnowledgeSource(toolDef.id, toolDef);
  // The loop's own tools (skills, tool search) are plain calls, whatever their id says.
  const activityKind = toolDef.isInternalTool ? 'tool' : activityKindOf(toolDef.id, source);

  return {
    ...(title ? { title } : {}),
    ...(integration ? { integration } : {}),
    activityKind,
    ...(activityKind === 'tool' ? {} : { activityScope: activityScopeOf(toolDef.id, source) })
  };
}
