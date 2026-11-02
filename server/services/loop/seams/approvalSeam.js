// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The approval gate (intrafind/ihub-apps#2945): a tool call whose resolved
 * policy needs a person's approval does not run. One seam serves every
 * surface that runs model-decided tool calls on the agent loop — chat,
 * workflow and agent nodes, scheduled runs — and must be registered **before**
 * any seam that announces or runs the call (`chat-tools` emits `tool/started`,
 * `passthrough` runs workflow tools), so a gated call never shows as started.
 *
 *   approvalSeam({
 *     resolvePolicy(toolDef, ctx)  → { approval, sideEffect, sideEffectSource, dataFlow, approvalSource }
 *     isGranted(info, ctx, policy) → boolean   per-chat grant, task allowlist, the approved call
 *     raise(info, ctx, policy)     → interaction   omit when no person can answer here
 *     headless                     → no person can answer (inference API, app-as-tool, MCP, embeds)
 *     fallback                     → 'park' | 'deny' | 'fail'; default: `ctx.policies.interactions.headlessFallback`
 *     onRaised(interaction, info, ctx, payload)   projection of a pause (frames, logs)
 *     onDenied(info, ctx, payload)                projection of a refusal
 *     pendingMessage(interaction, info) → payload of the awaiting tool message
 *   })
 *
 * With a person who can answer, the call is turned into an `approval`
 * interaction (raised by `raise`) and the turn pauses
 * (`finishReason: 'approval'`). The model sees an `awaiting_approval` tool
 * result, which the surface replaces with the real result once the call is
 * approved and run (chat: the server runs the stored call, the model never
 * re-issues it).
 *
 * Without one, the headless fallback decides:
 *
 * - `deny` — the model gets `APPROVAL_REQUIRED_NO_USER` as the tool result and
 *   carries on without the call.
 * - `park` — park the approval when the surface can (`raise` given and not
 *   headless, e.g. a workflow node that names approver groups), else deny.
 * - `fail` — the run ends with an error.
 *
 * @module services/loop/seams/approvalSeam
 */
import { APPROVAL_ERROR_CODES, needsApproval } from '../../../../shared/toolApproval.js';
import { resolveToolApproval } from '../../../utils/toolApproval.js';

/** Payload of the tool result a refused call (nobody can approve) hands the model. */
export function noUserPayload(toolName) {
  return {
    error: true,
    code: APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER,
    message:
      `The tool "${toolName}" needs a person's approval before it runs, and nobody can approve it here. ` +
      'It was not run. Do not call it again in this conversation; continue without it, or tell the user that this action needs approval in the chat.'
  };
}

/** Payload of the awaiting tool message while a person decides. */
export function awaitingApprovalPayload(interaction) {
  return {
    status: 'awaiting_approval',
    message:
      'This action needs the user’s approval. Nothing was sent; the turn is paused until they approve or reject it.',
    ...(interaction?.id ? { interactionId: String(interaction.id) } : {})
  };
}

/** Longest model-written justification shown on an approval card. */
export const MAX_JUSTIFICATION_CHARS = 500;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.en || Object.values(value).find(v => typeof v === 'string') || '';
  }
  return '';
}

/**
 * What the approval card shows: the exact arguments, the tool and its
 * installation, the side effect and the data flow. The arguments are the
 * ones the call will run with; the card renders them as escaped text.
 *
 * @param {Object} info - the loop's preTool info (`toolDef`, `toolId`, `name`, `args`)
 * @param {Object} policy - the resolved approval policy
 * @param {Object} [extra]
 * @param {string} [extra.justification] - text the model wrote before the call
 *   (shown labelled as model-written; never instructions)
 * @returns {Object} `prompt.displayData` of the approval interaction
 */
export function approvalDisplayData(info, policy, { justification } = {}) {
  const toolDef = info?.toolDef || {};
  const integration = toolDef._integration
    ? {
        id: String(toolDef._integration.instanceId),
        name: textOf(toolDef._integration.instanceLabel) || String(toolDef._integration.instanceId),
        action: String(toolDef._integration.action || '')
      }
    : null;
  const note =
    typeof justification === 'string' ? justification.trim().slice(0, MAX_JUSTIFICATION_CHARS) : '';
  return {
    toolId: String(info?.toolId || toolDef.id || ''),
    toolName: textOf(toolDef.name) || String(info?.name || info?.toolId || ''),
    ...(integration ? { integration } : {}),
    sideEffect: policy?.sideEffect || 'unknown',
    ...(policy?.sideEffectSource ? { sideEffectSource: policy.sideEffectSource } : {}),
    dataFlow: policy?.dataFlow || 'internal',
    ...(policy?.approvalSource ? { approvalSource: policy.approvalSource } : {}),
    args: info?.args && typeof info.args === 'object' ? info.args : {},
    ...(note ? { justification: note } : {})
  };
}

/**
 * The text the model wrote in the turn before this call (the content of the
 * assistant message that carries it), or ''.
 *
 * @param {Object} ctx - loop context
 * @param {Object} call - the tool call
 * @returns {string}
 */
export function justificationOf(ctx, call) {
  const messages = Array.isArray(ctx?.messages) ? ctx.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    if (!m.tool_calls.some(c => c?.id === call?.id)) continue;
    return typeof m.content === 'string' ? m.content : '';
  }
  return '';
}

/** The default policy lookup: the stamp `getToolsForApp` put on the tool, else the tool's own config. */
function defaultResolvePolicy(toolDef) {
  return resolveToolApproval(toolDef, null, null);
}

/**
 * @param {Object} [options] - see the module docs
 * @returns {Object} the seam
 */
export function approvalSeam({
  resolvePolicy = defaultResolvePolicy,
  isGranted = () => false,
  raise = null,
  headless = false,
  fallback = null,
  onRaised = null,
  onDenied = null,
  pendingMessage = awaitingApprovalPayload
} = {}) {
  return {
    name: 'approval',
    async preTool(ctx, info) {
      const { toolDef, call } = info;
      // Unregistered tools are refused by the loop; interactive ones ask
      // instead of running.
      if (!toolDef || toolDef.interactive === true) return null;
      const policy = resolvePolicy(toolDef, ctx);
      if (!needsApproval(policy)) return null;
      if (await isGranted(info, ctx, policy)) return null;

      const toolMessage = payload => ({
        role: 'tool',
        tool_call_id: call?.id,
        name: info.name,
        content: JSON.stringify(payload)
      });
      const canAsk = typeof raise === 'function' && !headless;
      if (canAsk) {
        const interaction = await raise(info, ctx, policy);
        const payload = pendingMessage(interaction, info);
        await onRaised?.(interaction, info, ctx, payload);
        return {
          handled: true,
          // The ledger's vocabulary for "paused for a human".
          execution: 'clarification',
          message: toolMessage(payload),
          terminate: {
            status: 'paused',
            finishReason: 'approval',
            pendingInteraction: interaction
          }
        };
      }

      const mode = fallback || ctx?.policies?.interactions?.headlessFallback || 'park';
      const payload = noUserPayload(String(info.name || info.toolId));
      await onDenied?.(info, ctx, payload);
      if (mode === 'fail') {
        const error = Object.assign(new Error(payload.message), { code: payload.code });
        return {
          handled: true,
          execution: 'clarification',
          message: toolMessage(payload),
          terminate: { status: 'error', finishReason: 'error', error }
        };
      }
      // `deny`, and `park` where nothing can park it.
      return { handled: true, execution: 'clarification', message: toolMessage(payload) };
    }
  };
}

export default approvalSeam;
