// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Knowledge-source accounting (chat behaviour): classify every tool that ran
 * into the source vocabulary (`websearch`, `ifinder`, `project`, `sources`,
 * `integration`, `grounding`, …) so the chat channel can name the answer's
 * basis (`run/ended.answerBasis`) at the end of the turn.
 *
 * @module services/loop/seams/knowledgeSourceSeam
 */

import { classifyToolResult } from '../toolClassify.js';
import { integrationLabelOf } from '../../../utils/toolIntegrationLabel.js';
import { activityOriginOfSource } from '../../chat/answerBasis.js';
import { categoryOf } from '../../tools/toolCategory.js';

/**
 * The knowledge source an origin stands for (the inverse of the footer's
 * `KIND_OF_SOURCE`): what the badge and the answer basis count.
 */
const SOURCE_OF_ORIGIN = Object.freeze({
  web: 'websearch',
  ifinder: 'ifinder',
  iassistant: 'iassistant',
  project: 'project',
  documents: 'documents',
  integration: 'integration'
});

/**
 * The source of a tool call: where the tool looks (its category,
 * `services/tools/toolCategory`), never its id. A connected system (an
 * installed integration, an MCP server, a remote agent) is `integration` — a
 * directory lookup or a Jira search is not a web search, whatever its id says —
 * unless it declares another origin.
 * @param {Object} [toolDef]
 * @returns {'websearch'|'ifinder'|'iassistant'|'project'|'documents'|'integration'|null}
 */
export function classifyToolKnowledgeSource(toolDef) {
  const { origin } = categoryOf(toolDef);
  return (origin && SOURCE_OF_ORIGIN[origin]) || null;
}

/** The tool that reads a source an earlier answer of the chat found (`tools/chatSources.js`). */
export const RECALL_TOOL_ID = 'chat_sources_read';

/**
 * The source of one stored source, by the provider it was found with: a page
 * found on the web is web search however many turns ago it was found. `web`
 * covers the providers' own search (grounding) too; an iAssistant document is
 * an `ifinder` source.
 * @param {string} provider
 * @returns {'websearch'|'ifinder'|'project'|'integration'}
 */
export function classifySourceProvider(provider) {
  const id = String(provider || '');
  if (id === 'web') return 'websearch';
  if (id === 'ifinder') return 'ifinder';
  if (id === 'project') return 'project';
  // Any other provider is a connected system (a declared `provider`, an MCP server).
  return 'integration';
}

/**
 * The sources of a recall: the providers the recalled sources were
 * found with. Listing earlier sources reads no content, so only a read counts.
 * @param {Object} outcome - The tool call's outcome (`sources` frame)
 * @returns {string[]}
 */
function recalledKnowledgeSources(outcome) {
  if (outcome.error) return [];
  const items = Array.isArray(outcome.sources?.items) ? outcome.sources.items : [];
  return [...new Set(items.map(item => classifySourceProvider(item.provider)))];
}

/** Whether a project knowledge call handed back a document or passage of a project. */
function returnedProjectContent(outcome) {
  const items = Array.isArray(outcome.sources?.items) ? outcome.sources.items : [];
  return items.some(item => item?.provider === 'project');
}

export const knowledgeSourceSeam = {
  name: 'knowledge-sources',
  postTool(ctx, info, outcome) {
    if (info.toolId === RECALL_TOOL_ID) {
      const recalled = recalledKnowledgeSources(outcome);
      for (const source of recalled) ctx.addKnowledgeSource(source);
      if (recalled.length) outcome.knowledgeSource = recalled[0];
      // The origin of what it recalled, when that is one place; the call
      // started without one, only the result tells.
      // Each recalled source says where it was found (`origin`, set by the server
      // when it was first found); only a source stored before that is placed by
      // the provider it was found with.
      const items = Array.isArray(outcome.sources?.items) ? outcome.sources.items : [];
      const origins = [
        ...new Set(
          items.map(
            item =>
              item?.origin?.kind || activityOriginOfSource(classifySourceProvider(item?.provider))
          )
        )
      ].filter(Boolean);
      if (origins.length === 1) outcome.activityOrigin = origins[0];
      return;
    }
    const source = classifyToolKnowledgeSource(info.toolDef);
    if (!source) return;
    // A connected system that returned nothing but an error informed nothing.
    if (source === 'integration' && (outcome.error || classifyToolResult(outcome.message).failed)) {
      return;
    }
    // A page read that delivered no text (a failed fetch, an offset at the end
    // of the page, a refusal) informed nothing: the answer does not rest on the web.
    if (
      source === 'websearch' &&
      categoryOf(info.toolDef).kind === 'fetch' &&
      outcome.readOutcome !== 'opened'
    ) {
      return;
    }
    // A project search that found nothing, or a listing, read no project: the
    // answer does not rest on it.
    if (source === 'project' && (outcome.error || !returnedProjectContent(outcome))) return;
    ctx.addKnowledgeSource(source);
    // Each connected system is named on its own: "Jira" and "Munich AD" are two entries.
    if (source === 'integration') ctx.addIntegration(integrationLabelOf(info.toolDef) || '');
    outcome.knowledgeSource = source;
  },
  stepEnd(ctx, step) {
    if (step.result?.groundingMetadata) ctx.addKnowledgeSource('grounding');
  }
};
