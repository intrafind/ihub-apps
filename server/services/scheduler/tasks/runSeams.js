/**
 * Loop seams that only a scheduled run carries.
 *
 * **Approval gate.** A tool whose definition says `requiresApproval: true`
 * does not run unattended. Unless the task's owner allowed it for this task
 * ("Always allow for this task") or already approved it in this run, the
 * call is not executed: a durable `approval` interaction is raised and the
 * turn pauses. The owner answers from the run's chat or the task page; an
 * approval queues a continuation of the run, a rejection or a timeout ends it.
 *
 * **Integration check.** A tool that reports its integration needs signing
 * in again ("JIRA authentication expired. Please reconnect your account.")
 * is recorded, so the run fails with an actionable reason instead of reading
 * as a success whose answer apologises.
 *
 * @module services/scheduler/tasks/runSeams
 */
import { SSE_V2_EVENTS } from '../../../../shared/runEvents.js';

/** Tool error codes that mean "sign in to the integration again". */
const REAUTH_ERROR = /(^|_)(AUTH_REQUIRED|AUTHENTICATION_REQUIRED|NOT_CONNECTED|REAUTH_REQUIRED)$/i;
const REAUTH_MESSAGE = /reconnect|re-authenticat|sign in again|not (connected|authenticated)/i;

function emit(ctx, type, data) {
  return ctx?.meta?.stream?.emit?.(type, data) ?? null;
}

/**
 * Whether a tool definition needs the owner's approval before it runs in a
 * scheduled run.
 *
 * @param {Object} toolDef
 * @returns {boolean}
 */
export function requiresApproval(toolDef) {
  return toolDef?.requiresApproval === true;
}

/**
 * What a tool result says about its integration, or null when it is fine.
 *
 * @param {string} toolId
 * @param {unknown} raw
 * @returns {{toolId: string, message: string, connectUrl?: string}|null}
 */
export function integrationIssueOf(toolId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code =
    typeof raw.error === 'string' ? raw.error : typeof raw.code === 'string' ? raw.code : '';
  const message = typeof raw.message === 'string' ? raw.message : '';
  const marker = raw.authRequired && typeof raw.authRequired === 'object' ? raw.authRequired : null;
  if (marker) {
    return {
      toolId,
      message: `Connect ${marker.serverName || marker.serverId || 'the integration'} again`,
      ...(typeof marker.connectUrl === 'string' ? { connectUrl: marker.connectUrl } : {})
    };
  }
  if ((code && REAUTH_ERROR.test(code)) || (raw.error && REAUTH_MESSAGE.test(message))) {
    return {
      toolId,
      message: message || 'The integration needs to be connected again',
      ...(typeof raw.authUrl === 'string' ? { connectUrl: raw.authUrl } : {})
    };
  }
  return null;
}

/**
 * The seams of one scheduled run.
 *
 * @param {Object} options
 * @param {Set<string>} options.allowedTools - Tools this run may call without asking.
 * @param {(info: Object, ctx: Object) => Promise<Object>} options.raiseApproval - Raise the
 *   approval interaction; returns it.
 * @param {(issue: Object) => void} [options.onIntegrationIssue]
 * @returns {Object[]}
 */
export function scheduledRunSeams({ allowedTools, raiseApproval, onIntegrationIssue }) {
  return [
    {
      name: 'scheduled-run-approval',
      async preTool(ctx, info) {
        const { toolDef, call } = info;
        if (!requiresApproval(toolDef)) return null;
        const toolId = String(info.toolId || toolDef.id);
        if (allowedTools.has(toolId)) return null;
        const interaction = await raiseApproval(info, ctx);
        const payload = {
          status: 'awaiting_approval',
          message:
            'This action needs the task owner’s approval. The run is paused until they approve or reject it.',
          interactionId: interaction?.id
        };
        emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
          step: ctx.iteration,
          callId: String(call?.id || (call?.index ?? '0')),
          toolId,
          name: String(info.name || toolId),
          resultPreview: payload
        });
        return {
          handled: true,
          // The ledger's vocabulary for "paused for a human".
          execution: 'clarification',
          message: {
            role: 'tool',
            tool_call_id: call?.id,
            name: info.name,
            content: JSON.stringify(payload)
          },
          terminate: {
            status: 'paused',
            finishReason: 'approval',
            pendingInteraction: interaction
          }
        };
      },
      async postTool(ctx, info, outcome) {
        if (!onIntegrationIssue || outcome?.error) return;
        const issue = integrationIssueOf(String(info.toolId), outcome?.rawResult);
        if (issue) onIntegrationIssue(issue);
      }
    }
  ];
}
