// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Knowledge-source accounting (chat behaviour): classify every tool that ran
 * into the source badge vocabulary (`websearch`, `ifinder`, `sources`,
 * `integration`, `grounding`, …) so the chat channel can emit `answer.source`
 * at the end of the turn.
 *
 * @module services/loop/seams/knowledgeSourceSeam
 */

import { getDefinitionTypes } from '../../integrations/integrationTypes.js';
import { classifyToolResult } from '../toolClassify.js';

/** iHub's own tools (scheduling, …) are not a connected system. */
const IHUB_DEFINITION = 'com.intrafind/ihub';

/**
 * The badge source of a tool, by its id alone: the built-in search and
 * retrieval tools.
 * @param {string} toolId
 * @returns {'websearch'|'ifinder'|'sources'|null}
 */
export function classifyKnowledgeSource(toolId) {
  const id = String(toolId || '').toLowerCase();
  if (!id) return null;
  // iFinder searches the organisation's own document index, not the web.
  if (id.startsWith('ifinder')) return 'ifinder';
  // The project knowledge tools search the organisation's projects.
  if (id.startsWith('knowledge_')) return 'sources';
  if (id === 'web-search' || id === 'websearch' || id.includes('search')) {
    if (id.includes('people') || id.includes('planner')) return null;
    if (id === 'deepresearch' || id === 'researchplanner') return null;
    return 'websearch';
  }
  if (id.startsWith('source_') || id.includes('retrieval')) return 'sources';
  return null;
}

/**
 * The badge source of a tool call. An installed integration, an MCP server or
 * a remote agent is a connected system (`integration`) — a directory lookup or
 * a Jira search is not a web search, whatever its id says — unless the
 * integration is a web search itself. Everything else is classified by id.
 * @param {string} toolId
 * @param {Object} [toolDef]
 * @returns {'websearch'|'ifinder'|'sources'|'integration'|null}
 */
export function classifyToolKnowledgeSource(toolId, toolDef) {
  // The loop's own tools (skills, tool search) inform nobody: `search_tools`
  // finds tools, not pages.
  if (toolDef?.isInternalTool) return null;
  const integration = toolDef?._integration;
  if (integration) {
    if (integration.definition === IHUB_DEFINITION) return null;
    const type = getDefinitionTypes()[integration.definition];
    if (type === 'web-search') return 'websearch';
    // Built-ins that kept their tool id (`iFinder_search`) keep their badge.
    return classifyKnowledgeSource(toolId) === 'ifinder' ? 'ifinder' : 'integration';
  }
  if (toolDef?._mcp || toolDef?._a2a) return 'integration';
  return classifyKnowledgeSource(toolId);
}

/** The tool that reads a source an earlier answer of the chat found (`tools/chatSources.js`). */
const RECALL_TOOL_ID = 'chat_sources_read';

/**
 * The badge source of one stored source, by the provider it was found
 * with: a page found on the web is web search however many turns ago it
 * was found. `web` covers the providers' own search (grounding) too; an
 * iAssistant document is an `ifinder` source.
 * @param {string} provider
 * @returns {'websearch'|'ifinder'|'sources'|'integration'}
 */
export function classifySourceProvider(provider) {
  const id = String(provider || '');
  if (id === 'web') return 'websearch';
  if (id === 'ifinder') return 'ifinder';
  if (id === 'project') return 'sources';
  if (id.startsWith('mcp:')) return 'integration';
  // Any other provider is the id of the tool that found it.
  return classifyKnowledgeSource(id) || 'integration';
}

/**
 * The badge sources of a recall: the providers the recalled sources were
 * found with. Listing earlier sources reads no content, so only a read counts.
 * @param {Object} outcome - The tool call's outcome (`sources` frame)
 * @returns {string[]}
 */
function recalledKnowledgeSources(outcome) {
  if (outcome.error) return [];
  const items = Array.isArray(outcome.sources?.items) ? outcome.sources.items : [];
  return [...new Set(items.map(item => classifySourceProvider(item.provider)))];
}

export const knowledgeSourceSeam = {
  name: 'knowledge-sources',
  postTool(ctx, info, outcome) {
    if (info.toolId === RECALL_TOOL_ID) {
      const recalled = recalledKnowledgeSources(outcome);
      for (const source of recalled) ctx.addKnowledgeSource(source);
      if (recalled.length) outcome.knowledgeSource = recalled[0];
      return;
    }
    const source = classifyToolKnowledgeSource(info.toolId, info.toolDef);
    if (!source) return;
    // A connected system that returned nothing but an error informed nothing.
    if (source === 'integration' && (outcome.error || classifyToolResult(outcome.message).failed)) {
      return;
    }
    ctx.addKnowledgeSource(source);
    outcome.knowledgeSource = source;
  },
  stepEnd(ctx, step) {
    if (step.result?.groundingMetadata) ctx.addKnowledgeSource('grounding');
  }
};
