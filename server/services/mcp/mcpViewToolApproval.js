// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool approval for the calls an MCP App view makes itself (#2945).
 *
 * A view's `tools/call` reaches its MCP server through
 * `POST /api/mcp-apps/tools/call`. When the called tool needs a person's
 * approval, the call does not run:
 *
 * 1. {@link requestViewToolCall} raises an `approval` interaction for the
 *    chat that hosts the view (the same interaction, display data and
 *    redaction as a model's call) and the route answers `202` with it. The
 *    hosting chat shows the `ApprovalCard` beside the view; the view itself
 *    shows nothing and keeps waiting for its call.
 * 2. {@link answerViewToolApproval} takes the decision
 *    (`POST /api/mcp-apps/tools/call/approval`), answers the interaction
 *    exactly once and, on approve, runs the stored call — the arguments the
 *    person saw — and returns its result to the view. Reject and expiry come
 *    back as a structured tool error (`USER_REJECTED`, `APPROVAL_EXPIRED`).
 *
 * A host that cannot show the card (no chat, an embed without the approval
 * card) gets `APPROVAL_REQUIRED_NO_USER`, as on the MCP gateway.
 *
 * @module services/mcp/mcpViewToolApproval
 */
import crypto from 'node:crypto';
import defaultInteractionService from '../loop/InteractionService.js';
import { newRunId } from '../loop/RunLog.js';
import { resolvePrincipal } from '../loop/runIdentity.js';
import { approvalDisplayData } from '../loop/seams/approvalSeam.js';
import { needsApproval, resolveToolApproval } from '../../utils/toolApproval.js';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';
import { toViewToolResult } from './mcpApps.js';

/** How long a view's approval waits for an answer. */
export const VIEW_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Interaction states that mean "nobody will answer this any more". */
const LAPSED = new Set(['expired', 'cancelled']);

/**
 * The iHub-facing id of a tool on the view's server: the server's tool prefix
 * (the one the view's own tool carries) and the server's tool name — the id
 * an app's per-tool approval override names.
 */
function appFacingToolId(viewTool, name) {
  const viewId = typeof viewTool?.id === 'string' ? viewTool.id : '';
  const viewName = viewTool?._mcp?.originalName;
  if (typeof viewName === 'string' && viewName && viewId.endsWith(viewName)) {
    return `${viewId.slice(0, viewId.length - viewName.length)}${name}`;
  }
  return name;
}

/** The tool definition a view's call is resolved as (approval, side effect, names). */
export function viewCallToolDef({ serverId, name, target, viewTool }) {
  return {
    id: appFacingToolId(viewTool, name),
    name: target?.title || name,
    _mcp: {
      serverId,
      originalName: name,
      ...(viewTool?._mcp?.serverName ? { serverName: viewTool._mcp.serverName } : {}),
      ...(target?.annotations ? { annotations: target.annotations } : {})
    },
    _integration: {
      instanceId: serverId,
      action: name,
      ...(viewTool?._integration?.instanceLabel
        ? { instanceLabel: viewTool._integration.instanceLabel }
        : {})
    }
  };
}

/** A tool error the view understands (MCP CallToolResult with `isError`). */
export function viewToolError(code, message) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: code, message },
    isError: true
  };
}

/** True for an approval raised for an MCP App view's own call. */
export function isViewToolApproval(interaction) {
  return !!interaction?.source?.viewCall && interaction.kind === 'approval';
}

/**
 * Decide what happens with a view's call to a tool.
 *
 * @param {Object} params
 * @param {Object} params.user - the caller
 * @param {string} params.appId
 * @param {Object|null} [params.app] - the app's configuration: its tool approval
 *   overrides tighten the gate as they do for a model's call
 * @param {Object} params.viewTool - the tool whose call rendered the view
 * @param {string} params.serverId
 * @param {string} params.name - the server's own tool name the view calls
 * @param {Object} params.args
 * @param {Object|null} params.target - the app tool (`getAppTool`), for annotations
 * @param {string|null} [params.chatId] - the chat that hosts the view
 * @param {boolean} [params.canApprove] - the host draws the approval card
 * @param {Object|null} [params.platform]
 * @param {(id: string) => Object|null} [params.getInstallation]
 * @param {Object} [params.interactionService]
 * @returns {Promise<{status: 'run'}|{status: 'refused', code: string, message: string}|
 *   {status: 'awaiting', interaction: Object}>}
 */
export async function requestViewToolCall({
  user,
  appId,
  app = null,
  viewTool,
  serverId,
  name,
  args,
  target,
  chatId = null,
  canApprove = false,
  platform = null,
  getInstallation,
  interactionService = defaultInteractionService
}) {
  const toolDef = viewCallToolDef({ serverId, name, target, viewTool });
  const installation = getInstallation ? getInstallation(serverId) : null;
  const policy = resolveToolApproval(toolDef, app, platform, { installation });
  if (!needsApproval(policy)) return { status: 'run' };
  if (!chatId || !canApprove) {
    return {
      status: 'refused',
      code: APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER,
      message: `Tool ${name} needs a person's approval, and this view's host cannot show it`
    };
  }
  const displayData = approvalDisplayData(
    { toolDef, toolId: name, name, args: args || {} },
    policy
  );
  const principal = await resolvePrincipal(user);
  const interaction = await interactionService.raise({
    id: `approve-view-${crypto.randomUUID()}`,
    runId: newRunId('chat'),
    kind: 'approval',
    origin: 'tool',
    prompt: {
      title: `Run ${displayData.toolName}?`,
      message: `An app view in this chat wants to run "${displayData.toolName}". Nothing is sent until you choose.`,
      inputType: 'confirm',
      displayData
    },
    policy: { timeoutMs: VIEW_APPROVAL_TTL_MS, onTimeout: 'deny', fallback: 'deny' },
    source: {
      chatId,
      appId,
      toolId: name,
      viewCall: { appId, viewToolId: viewTool?.id || '', serverId, name },
      ...(principal?.id && !principal.anonymous ? { principalId: String(principal.id) } : {}),
      identityMode: principal?.mode || 'default'
    }
  });
  return { status: 'awaiting', interaction };
}

/**
 * Answer a view's approval and, on approve, run the stored call.
 *
 * @param {Object} params
 * @param {Object} params.interaction - the view's approval (already authorized)
 * @param {'approve'|'reject'} params.decision
 * @param {Object} params.user - who answers
 * @param {(name: string, args: Object) => Promise<Object>} params.call - runs the
 *   server's tool on the caller's connection
 * @param {Object} [params.interactionService]
 * @returns {Promise<{status: number, body: Object}>}
 */
export async function answerViewToolApproval({
  interaction,
  decision,
  user,
  call,
  interactionService = defaultInteractionService
}) {
  const expired = () => ({
    status: 200,
    body: viewToolError(
      APPROVAL_ERROR_CODES.APPROVAL_EXPIRED,
      'The approval expired before anyone answered. The call was not run.'
    )
  });
  if (!interaction || LAPSED.has(interaction.status)) return expired();
  if (interaction.status === 'answered') {
    return {
      status: 409,
      body: { error: 'This approval was already answered', code: 'APPROVAL_ALREADY_ANSWERED' }
    };
  }
  try {
    await interactionService.answer(
      interaction.id,
      decision === 'approve'
        ? { decision: 'approve' }
        : { decision: 'reject', reason: 'Rejected in the chat' },
      { user, channel: 'chat' }
    );
  } catch (error) {
    if (error?.code === 'EXPIRED' || error?.code === 'NOT_FOUND') return expired();
    if (error?.code === 'NOT_PENDING' || error?.code === 'ANSWER_IN_PROGRESS') {
      const current = await interactionService.get(interaction.id).catch(() => null);
      if (current && LAPSED.has(current.status)) return expired();
      return {
        status: 409,
        body: { error: 'This approval was already answered', code: 'APPROVAL_ALREADY_ANSWERED' }
      };
    }
    throw error;
  }
  if (decision !== 'approve') {
    return {
      status: 200,
      body: viewToolError(
        APPROVAL_ERROR_CODES.USER_REJECTED,
        'The user rejected this call. It was not run.'
      )
    };
  }
  // The arguments the person saw and approved, as stored with the approval.
  const { name } = interaction.source.viewCall;
  const args = interaction.prompt?.displayData?.args || {};
  return { status: 200, body: toViewToolResult(await call(name, args)) };
}
