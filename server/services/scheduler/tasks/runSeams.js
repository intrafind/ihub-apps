// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Loop seams that only a scheduled run carries.
 *
 * **Approval gate.** A tool whose resolved approval policy asks for a person
 * (#2945: platform default, tool or installation, action, app — the policy
 * `getToolsForApp` stamps on every tool) does not run unattended. Unless the
 * task's owner allowed it for this task ("Always allow for this task") or
 * already approved it in this run, the call is not executed: a durable
 * `approval` interaction is raised and the turn pauses. The owner answers from
 * the run's chat or the task page; an approval queues a continuation of the
 * run, a rejection or a timeout ends it. The gate is the shared
 * `approvalSeam`, so it runs before the chat seams announce the call.
 *
 * **Integration check.** A tool that reports its integration needs signing
 * in again (the structured `INTEGRATION_AUTH_REQUIRED` result, or a message
 * such as "JIRA authentication expired. Please reconnect your account.") is
 * recorded, so the run fails with an actionable reason instead of reading as
 * a success whose answer apologises.
 *
 * @module services/scheduler/tasks/runSeams
 */
import { SSE_V2_EVENTS } from '../../../../shared/runEvents.js';
import { approvalSeam } from '../../loop/seams/approvalSeam.js';
import { resolveToolApproval, toolNeedsApproval } from '../../../utils/toolApproval.js';

/** Tool error codes that mean "sign in to the integration again". */
const REAUTH_ERROR = /(^|_)(AUTH_REQUIRED|AUTHENTICATION_REQUIRED|NOT_CONNECTED|REAUTH_REQUIRED)$/i;
const REAUTH_MESSAGE = /reconnect|re-authenticat|sign in again|not (connected|authenticated)/i;

function emit(ctx, type, data) {
  return ctx?.meta?.stream?.emit?.(type, data) ?? null;
}

/**
 * Whether a tool needs the owner's approval before it runs in a scheduled
 * run: its resolved approval policy (see `utils/toolApproval.js`).
 *
 * @param {Object} toolDef - a tool as `getToolsForApp` offers it (stamped)
 * @returns {boolean}
 */
export function requiresApproval(toolDef) {
  return toolNeedsApproval(toolDef);
}

/**
 * What a tool result says about its integration, or null when it is fine.
 *
 * @param {string} toolId
 * @param {unknown} raw
 * @returns {{toolId: string, message: string, integration?: string, reason?: string, connectUrl?: string}|null}
 */
export function integrationIssueOf(toolId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code =
    typeof raw.error === 'string' ? raw.error : typeof raw.code === 'string' ? raw.code : '';
  const message = typeof raw.message === 'string' ? raw.message : '';
  // The one structured "connect first" result (INTEGRATION_AUTH_REQUIRED).
  const structured = {
    ...(typeof raw.integration === 'string' ? { integration: raw.integration } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {})
  };
  const marker = raw.authRequired && typeof raw.authRequired === 'object' ? raw.authRequired : null;
  if (marker) {
    return {
      toolId,
      message: `Connect ${marker.serverName || marker.serverId || 'the integration'} again`,
      ...structured,
      ...(typeof marker.connectUrl === 'string' ? { connectUrl: marker.connectUrl } : {})
    };
  }
  if ((code && REAUTH_ERROR.test(code)) || (raw.error && REAUTH_MESSAGE.test(message))) {
    const connectUrl =
      typeof raw.connectUrl === 'string'
        ? raw.connectUrl
        : typeof raw.authUrl === 'string'
          ? raw.authUrl
          : null;
    return {
      toolId,
      message: message || 'The integration needs to be connected again',
      ...structured,
      ...(connectUrl ? { connectUrl } : {})
    };
  }
  return null;
}

/**
 * The approval gate of one scheduled run (the shared `approvalSeam`).
 *
 * @param {Object} options
 * @param {Set<string>} options.allowedTools - Tools this run may call without asking.
 * @param {(info: Object, ctx: Object) => Promise<Object>} options.raiseApproval - Raise the
 *   approval interaction; returns it.
 * @returns {Object} the seam (register it before every other preTool seam)
 */
export function scheduledApprovalSeam({ allowedTools, raiseApproval }) {
  return approvalSeam({
    resolvePolicy: toolDef => resolveToolApproval(toolDef, null, null),
    isGranted: info => allowedTools.has(String(info.toolId || info.toolDef?.id)),
    raise: (info, ctx) => raiseApproval(info, ctx),
    pendingMessage: interaction => ({
      status: 'awaiting_approval',
      message:
        'This action needs the task owner’s approval. The run is paused until they approve or reject it.',
      interactionId: interaction?.id
    }),
    // The run page shows the gated call closed with the awaiting payload.
    onRaised(interaction, info, ctx, payload) {
      const toolId = String(info.toolId || info.toolDef?.id);
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: String(info.call?.id || (info.call?.index ?? '0')),
        toolId,
        name: String(info.name || toolId),
        resultPreview: payload
      });
    }
  });
}

/**
 * The seams of one scheduled run.
 *
 * @param {Object} options
 * @param {Set<string>} options.allowedTools - Tools this run may call without asking.
 * @param {(info: Object, ctx: Object) => Promise<Object>} options.raiseApproval - Raise the
 *   approval interaction; returns it.
 * @param {(issue: Object) => void} [options.onIntegrationIssue]
 * @returns {{approvalGate: Object, seams: Object[]}} the approval gate (handed to
 *   `ChatService.runTurn` as `approvalGate`, so it runs first) and the other seams
 */
export function scheduledRunSeams({ allowedTools, raiseApproval, onIntegrationIssue }) {
  return {
    approvalGate: scheduledApprovalSeam({ allowedTools, raiseApproval }),
    seams: [
      {
        name: 'scheduled-run-integrations',
        async postTool(ctx, info, outcome) {
          if (!onIntegrationIssue || outcome?.error) return;
          const issue = integrationIssueOf(String(info.toolId), outcome?.rawResult);
          if (issue) onIntegrationIssue(issue);
        }
      }
    ]
  };
}
