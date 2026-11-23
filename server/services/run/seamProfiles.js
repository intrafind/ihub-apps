// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The seams of a run, in their order.
 *
 * The order is not a detail: the approval seam is always the first, so a call
 * that needs a person's approval is decided before any other seam announces it,
 * runs it (passthrough) or records it (the host's seams). A host adds its own
 * seams after it and never in front of it: the seams that project a tool call
 * onto the host's stream (`host.projectionSeams`) right after the approval, the
 * rest (`host.seams`) at the end.
 *
 * Who can answer the interactions of a run (`interactions`):
 *
 * - `none`: nobody (an app called as a tool, the MCP gateway, an A2A task, an
 *   app turn of the inference API). A call that needs approval is refused
 *   (`APPROVAL_REQUIRED_NO_USER`) and never becomes a pending approval, and a
 *   question to the user is refused instead of pausing the run.
 * - `person`: the person in the chat. A question pauses the run; a call that
 *   needs approval raises the approval card, unless the person's client cannot
 *   draw it or the turn is not stored (`bindings.approval.headless`), and then
 *   it is refused as above.
 * - `owner`: the owner of a scheduled task, later. A question is refused; the
 *   approval seam is the scheduled run's own (`bindings.approvalGate`), which
 *   lets the run wait for the owner.
 *
 * Order: approval, the host's projection seams, question, passthrough, image
 * lift, the output contract (if any), the host's seams.
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
export const INTERACTIONS = Object.freeze(['none', 'person', 'owner']);

/** The approval seam the interactions of the run call for. */
function approvalFor(interactions, bindings) {
  const {
    chatId,
    app,
    platform = null,
    buildLogData,
    logInteraction,
    approval = {},
    approvalGate = null
  } = bindings;
  if (interactions === 'owner') {
    if (!approvalGate) {
      throw new Error('A run whose owner answers its approvals brings its approval seam');
    }
    return approvalGate;
  }
  const { headless = false, ...extra } = approval;
  const options = chatApprovalOptions({
    chatId,
    app,
    platform,
    headless: interactions === 'none' || headless === true,
    buildLogData,
    logInteraction,
    ...extra
  });
  // Nobody can approve here: a gated call is refused (APPROVAL_REQUIRED_NO_USER), never parked.
  return interactions === 'none'
    ? approvalSeam({ ...options, fallback: 'deny' })
    : approvalSeam(options);
}

/**
 * The ordered seams of a run.
 *
 * @param {Object} params
 * @param {'none'|'person'|'owner'} params.interactions - who can answer an approval or a question
 * @param {Object|null} [params.structuredOutput] - the run's output contract seam, if any
 * @param {{seams?: (bindings: Object) => Array<Object>,
 *   projectionSeams?: (bindings: Object) => Array<Object>}} params.host - the host; its
 *   projection seams follow the approval seam, its other seams come last
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
 * @param {Object} [params.bindings.approval] - the chat's approval state: `grants`,
 *   `approvedCall`, `interactionService`, `runLog`, and `headless` when the person cannot
 *   approve (`person` only)
 * @param {Object} [params.bindings.approvalGate] - the approval seam of a run whose owner
 *   answers (`owner` only)
 * @param {Object} [params.bindings.question] - `getCount`, `incrementCount`,
 *   `interactionService` of the chat's clarification counter
 * @param {{chatStored?: boolean, streaming?: boolean}} [params.bindings.passthrough]
 * @returns {Array<Object>} the seams, approval first
 */
export function build({ interactions, structuredOutput = null, host, bindings }) {
  if (!INTERACTIONS.includes(interactions)) {
    throw new Error(`Unknown interactions "${interactions}"`);
  }
  const {
    chatId,
    app,
    principal,
    run,
    userFileData,
    integrationScopes = {},
    buildLogData,
    logInteraction,
    toolRunner,
    origin = 'subagent',
    question = {},
    passthrough = {}
  } = bindings;
  const hostBindings = { chatId, principal, run };
  const listOf = seams => (Array.isArray(seams) ? seams.filter(Boolean) : []);
  const projection =
    typeof host?.projectionSeams === 'function' ? listOf(host.projectionSeams(hostBindings)) : [];
  const seams = [
    approvalFor(interactions, bindings),
    ...projection,
    questionSeam(
      chatQuestionOptions({
        chatId,
        appId: app?.id,
        buildLogData,
        logInteraction,
        headless: interactions !== 'person',
        getCount: question.getCount || (() => 0),
        incrementCount: question.incrementCount || (() => 1),
        ...(question.interactionService ? { interactionService: question.interactionService } : {})
      })
    ),
    passthroughSeam(
      chatPassthroughOptions({
        chatId,
        ...(passthrough.chatStored === undefined ? {} : { chatStored: passthrough.chatStored }),
        user: principal,
        app,
        integrationScopes,
        userFileData,
        streaming: passthrough.streaming === true,
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
  const hostSeams = typeof host?.seams === 'function' ? listOf(host.seams(hostBindings)) : [];
  return [...seams, ...hostSeams];
}

export default { build, INTERACTIONS };
