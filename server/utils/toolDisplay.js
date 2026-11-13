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
 *    `web` or the organisation's `documents` (kept for older clients; the
 *    chat reads `activityOrigin`)
 *  - `activityOrigin`: where the call looked, in the footer's vocabulary of
 *    answer-basis kinds (`project`, `web`, `ifinder`, `documents`,
 *    `integration`); absent when the server does not know
 *  - `outputKind`: for the built-in creators of a file or a document (a web
 *    artifact, a PDF, a workbook …), what they produce. It is sent on the
 *    `args` progress frames while the arguments still stream, where the chat
 *    words "Creating {{what}}…"; `tool/started` and the run ledger do not carry
 *    it ({@link startedDisplayOf})
 *
 * @module utils/toolDisplay
 */

import { classifyToolKnowledgeSource } from '../services/loop/seams/knowledgeSourceSeam.js';
import { boundedText, integrationLabelOf } from './toolIntegrationLabel.js';
import { activityOriginOfSource } from '../services/chat/answerBasis.js';
import { ACTIVITY_ORIGINS } from '../../shared/runEvents.js';

export { ACTIVITY_ORIGINS };

/** Built-in tools that read one page or document. */
const FETCH_TOOL_IDS = new Set(['read_url', 'ifinder_getcontent', 'knowledge_read']);

const text = boundedText;

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
  if (source === 'ifinder' || source === 'sources' || source === 'project') return 'documents';
  const id = String(toolId || '').toLowerCase();
  return id.startsWith('ifinder') || id.startsWith('source_') || id.startsWith('knowledge_')
    ? 'documents'
    : 'web';
}

/**
 * Where a call looked, decided by the server: the footer's kind for the tool's
 * knowledge source (the page reader is the web). `undefined` for a call the server cannot place (loop-internal
 * tools, creators, a search it cannot classify): the chat then says nothing
 * about where it looked and never guesses.
 *
 * @param {Object|null|undefined} toolDef - the resolved tool definition
 * @returns {'project'|'web'|'ifinder'|'iassistant'|'documents'|'integration'|undefined}
 */
export function activityOriginOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object' || toolDef.isInternalTool) return undefined;
  return activityOriginOfSource(classifyToolKnowledgeSource(toolDef.id, toolDef));
}

export { activityOriginOfSource };

/** What the built-in creator tools produce; the chat words each one. */
export const OUTPUT_KINDS = Object.freeze([
  'webArtifact',
  'document',
  'presentation',
  'workbook',
  'pdf',
  'file',
  'archive'
]);

/**
 * What a tool produces, when it is one of the built-in creators of a file or a
 * document. The kind is data on the tool definition (`outputKind`, set by the
 * creator's own definition and carried over by `systemSkillToolsFor`), never
 * guessed from the tool id; only a system-skill tool counts, so a tool an admin
 * or an MCP server provides cannot claim one.
 *
 * @param {Object|null|undefined} toolDef - the resolved tool definition
 * @returns {'webArtifact'|'document'|'presentation'|'workbook'|'pdf'|'file'|'archive'|undefined}
 *   `undefined` for every other tool (also `preview_pdf`, which creates nothing)
 */
export function outputKindOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object' || toolDef.isSystemSkillTool !== true) {
    return undefined;
  }
  return OUTPUT_KINDS.includes(toolDef.outputKind) ? toolDef.outputKind : undefined;
}

/**
 * @param {Object|null|undefined} toolDef - the resolved (localized) tool definition
 * @returns {{title?: string, integration?: string, activityKind?: string, activityScope?: string, activityOrigin?: string, outputKind?: string}}
 *   the fields that are known; nothing for an unknown tool (a plain call)
 */
export function toolDisplayOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') return {};
  let title = null;
  const integration = integrationLabelOf(toolDef);

  if (toolDef._integration) {
    title = text(toolDef._integration.actionTitle);
  } else if (toolDef._mcp) {
    title = text(toolDef._mcp.title) || text(toolDef._mcp.originalName);
  } else if (toolDef._a2a) {
    title = text(toolDef._a2a.skillName);
  }

  // Any other tool: its configured (localized) name, when it says more than its id.
  if (!title && !integration) {
    const name = text(toolDef.name);
    if (name && name !== toolDef.id) title = name;
  }

  const source = classifyToolKnowledgeSource(toolDef.id, toolDef);
  // The loop's own tools (skills, tool search) are plain calls, whatever their id says.
  const activityKind = toolDef.isInternalTool ? 'tool' : activityKindOf(toolDef.id, source);

  const outputKind = outputKindOf(toolDef);
  const activityOrigin = activityOriginOf(toolDef);

  return {
    ...(title ? { title } : {}),
    ...(integration ? { integration } : {}),
    activityKind,
    ...(activityKind === 'tool' ? {} : { activityScope: activityScopeOf(toolDef.id, source) }),
    ...(activityOrigin ? { activityOrigin } : {}),
    ...(outputKind ? { outputKind } : {})
  };
}

/**
 * The display fields `tool/started` and the run ledger's `tool/call` carry:
 * {@link toolDisplayOf} without `outputKind`. Those frames, and the stored
 * activity built from them, are the same as before the arguments progress
 * existed; the kind rides on the `args` progress frames only.
 *
 * @param {Object|null|undefined} toolDef
 * @returns {{title?: string, integration?: string, activityKind?: string, activityScope?: string, activityOrigin?: string}}
 */
export function startedDisplayOf(toolDef) {
  const display = toolDisplayOf(toolDef);
  delete display.outputKind;
  return display;
}
