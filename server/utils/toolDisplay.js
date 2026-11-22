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
 *  - `activityOrigin`: where the call looked, in the footer's vocabulary of
 *    answer-basis kinds (`project`, `web`, `ifinder`, `documents`,
 *    `integration`); absent when the server does not know
 *  - `publicHits`: `true` when what the call found is on the open web (a shipped
 *    web search engine); a share keeps those hits and drops every other call's
 *  - `outputKind`: for the built-in creators of a file or a document (a web
 *    artifact, a dashboard, a PDF, a workbook …), what they produce. It is sent on the
 *    `args` progress frames while the arguments still stream, where the chat
 *    words "Creating {{what}}…"; `tool/started` and the run ledger do not carry
 *    it ({@link startedDisplayOf})
 *
 * @module utils/toolDisplay
 */

import { categoryOf } from '../services/tools/toolCategory.js';
import { hasPublicHits } from '../services/sources/producers/web.js';
import { boundedText, integrationLabelOf } from './toolIntegrationLabel.js';
import { ACTIVITY_ORIGINS } from '../../shared/runEvents.js';

export { ACTIVITY_ORIGINS };

const text = boundedText;

/**
 * Where a call looked, decided by the server from the tool's category
 * (`services/tools/toolCategory`): a connected system is `integration`, the
 * built-in search and readers say `web`, `ifinder` or `project`. `undefined`
 * for a call the server cannot place (loop-internal tools, creators, a tool
 * that declares nothing): the chat then says nothing about where it looked and
 * never guesses.
 *
 * @param {Object|null|undefined} toolDef - the resolved tool definition
 * @returns {'project'|'web'|'ifinder'|'iassistant'|'documents'|'integration'|undefined}
 */
export function activityOriginOf(toolDef) {
  return categoryOf(toolDef).origin;
}

export { activityOriginOfSource } from '../services/chat/answerBasis.js';

/** What the built-in creator tools produce; the chat words each one. */
export const OUTPUT_KINDS = Object.freeze([
  'webArtifact',
  'dashboard',
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
 * @returns {'webArtifact'|'dashboard'|'document'|'presentation'|'workbook'|'pdf'|'file'|'archive'|undefined}
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
 * @returns {{title?: string, integration?: string, activityKind?: string, activityOrigin?: string, publicHits?: true, outputKind?: string}}
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
  } else if (toolDef.isAppAsTool === true) {
    // An app called as a tool: the app's localized name alone, not "App: <name>".
    title = text(toolDef.appName);
  }

  // Any other tool: its configured (localized) name, when it says more than its id.
  if (!title && !integration) {
    const name = text(toolDef.name);
    if (name && name !== toolDef.id) title = name;
  }

  // What the call is and where it looked: the tool's own category.
  const { kind: activityKind, origin: activityOrigin } = categoryOf(toolDef);

  const outputKind = outputKindOf(toolDef);
  const publicHits = hasPublicHits(toolDef);

  return {
    ...(title ? { title } : {}),
    ...(integration ? { integration } : {}),
    activityKind,
    ...(activityOrigin ? { activityOrigin } : {}),
    ...(publicHits ? { publicHits: true } : {}),
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
 * @returns {{title?: string, integration?: string, activityKind?: string, activityOrigin?: string}}
 */
export function startedDisplayOf(toolDef) {
  const display = toolDisplayOf(toolDef);
  delete display.outputKind;
  return display;
}

/** The row a message the person sent into the running answer makes in the activity list. */
export const APPLIED_MESSAGE_ACTIVITY_KIND = 'user_message';

/**
 * The display fields of `steer/applied` for a message read at a step: the
 * activity item the chat draws at that step, live and from the stored turn
 * ("Read your message"). The server decides it; the client draws what it is
 * told and never works it out from the text or the id.
 *
 * @returns {{activityKind: 'user_message'}}
 */
export function appliedMessageDisplayOf() {
  return { activityKind: APPLIED_MESSAGE_ACTIVITY_KIND };
}
