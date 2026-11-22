// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The seams of a run, in their order.
 *
 * The order is not a detail: the approval seam is always the first, so a call
 * that needs a person's approval is decided before any other seam announces it,
 * runs it (passthrough) or records it (the host's seams). A host adds its own
 * seams at the end and never in front of the approval seam.
 *
 * `interactions: 'none'` is a run nobody can answer (an app called as a tool,
 * the MCP gateway, an A2A task): a call that needs approval is refused
 * (`APPROVAL_REQUIRED_NO_USER`) and never becomes a pending approval, and a
 * question to the user is refused instead of pausing the run. A run with a
 * person who answers builds its seams in the chat host until the chat turn
 * runs on the run service.
 *
 * @module services/run/seamProfiles
 */

import { approvalSeam, imageLiftSeam, passthroughSeam, questionSeam } from '../loop/seams/index.js';
import {
  chatApprovalOptions,
  chatPassthroughOptions,
  chatQuestionOptions
} from '../chat/chatSeams.js';

/** Who can answer the interactions of a run. */
export const INTERACTIONS = Object.freeze(['none']);

/**
 * The ordered seams of a run.
 *
 * @param {Object} params
 * @param {'none'} params.interactions - who can answer an approval or a question
 * @param {Object|null} [params.structuredOutput] - the run's output contract seam, if any
 * @param {{seams?: (bindings: Object) => Array<Object>}} params.host - the host; its seams come last
 * @param {Object} params.bindings - what the seams act on:
 * @param {string} params.bindings.chatId
 * @param {Object} params.bindings.app
 * @param {Object} params.bindings.principal - the identity the run acts as
 * @param {Readonly<Object>} params.bindings.run - the run context
 * @param {Object} [params.bindings.platform]
 * @param {Array} [params.bindings.userFileData]
 * @param {Object} [params.bindings.integrationScopes]
 * @param {Function} params.bindings.buildLogData
 * @param {Function} params.bindings.logInteraction
 * @param {Object} params.bindings.toolRunner
 * @param {string} [params.bindings.origin='subagent'] - the run kind, for the runner's log
 * @returns {Array<Object>} the seams, approval first
 */
export function build({ interactions, structuredOutput = null, host, bindings }) {
  if (!INTERACTIONS.includes(interactions)) {
    throw new Error(
      `Unknown interactions "${interactions}": a run with a person who answers builds its seams in the chat host`
    );
  }
  const {
    chatId,
    app,
    principal,
    run,
    platform = null,
    userFileData,
    integrationScopes = {},
    buildLogData,
    logInteraction,
    toolRunner,
    origin = 'subagent'
  } = bindings;
  const seams = [
    // Nobody can approve here: a gated call is refused (APPROVAL_REQUIRED_NO_USER), never parked.
    approvalSeam({
      ...chatApprovalOptions({
        chatId,
        app,
        platform,
        headless: true,
        buildLogData,
        logInteraction
      }),
      fallback: 'deny'
    }),
    questionSeam(
      chatQuestionOptions({
        chatId,
        appId: app?.id,
        buildLogData,
        logInteraction,
        headless: true,
        getCount: () => 0,
        incrementCount: () => 1
      })
    ),
    passthroughSeam(
      chatPassthroughOptions({
        chatId,
        user: principal,
        app,
        integrationScopes,
        userFileData,
        streaming: false,
        buildLogData,
        logInteraction,
        toolRunner,
        origin,
        run
      })
    ),
    imageLiftSeam,
    ...(structuredOutput ? [structuredOutput] : [])
  ];
  const hostSeams = typeof host?.seams === 'function' ? host.seams({ chatId, principal, run }) : [];
  return [...seams, ...(Array.isArray(hostSeams) ? hostSeams.filter(Boolean) : [])];
}

export default { build, INTERACTIONS };
