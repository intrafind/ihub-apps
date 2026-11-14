// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat-surface seams for the agent loop.
 *
 * Everything the chat turn adds on top of the shared loop is a seam here:
 * tool frames and interaction logs, per-call usage/metrics, the upload/email
 * knowledge sources, the clarification (ask_user) projection and the
 * passthrough (workflow) projection. Frames go out as SSE v2 through the
 * turn's `RunStreamEmitter` (`ctx.meta.stream`); the loop stays surface-agnostic.
 *
 * @module services/chat/chatSeams
 */
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import logger from '../../utils/logger.js';
import { MAX_CLARIFICATIONS_PER_CONVERSATION, validateAskUserParams } from '../../tools/askUser.js';
import * as defaultTelemetry from './chatTelemetry.js';
import defaultInteractionService from '../loop/InteractionService.js';
import defaultRunLog from '../loop/RunLog.js';
import { buildQuestionPrompt } from '../loop/questionPrompt.js';
import { buildViewDescriptor, findEmbeddedView, toViewToolResult } from '../mcp/mcpApps.js';
import { isSchedulingToolDef, proposalOf } from '../scheduler/tasks/proposals.js';
import { liftMcpResultEarly, settleToolOutputs } from './toolOutputFiles.js';
import { generatedFilesOf } from '../../../shared/generatedFiles.js';
import { heldGeneratedFileData } from '../documents/generatedFiles.js';
import crypto from 'node:crypto';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';
import { redactApprovalArgs, resolveToolApproval } from '../../utils/toolApproval.js';
import {
  approvalDisplayData,
  justificationOf,
  oneShotGrant,
  sameArgs
} from '../loop/seams/approvalSeam.js';
import { startedDisplayOf } from '../../utils/toolDisplay.js';
import { PROGRESS_PHASES } from '../../../shared/run/argProgress.js';
import {
  chunkHasReasoning,
  chunkShowsOutput,
  createToolArgTracker,
  createWaitingLine
} from './toolArgProgress.js';

/**
 * A clarification nobody answers expires after a day, so abandoned chats do
 * not accumulate pending interactions.
 */
export const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const COMPONENT = 'ChatService';
const PREVIEW_CHARS = 4096;

/**
 * Blocks `PromptService` renders for host email or meeting context (see
 * shared/promptContext.js). The seam sees the rendered messages, so their
 * presence marks the turn as answered from the user's own email. Source text
 * is escaped there, so an email cannot fake one.
 */
export const EMAIL_CONTEXT_MARKERS = ['<content type="email"', '<content type="meeting"'];

/**
 * Knowledge sources implied by the prompt itself: Office email/meeting
 * context, uploaded files/images and audio recordings sent as audio.
 * @param {Array} messages
 * @returns {Array<'email'|'file'|'audio'>}
 */
export function detectContextSources(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sources = [];
  const carries = value => Boolean(value) && (Array.isArray(value) ? value.length > 0 : true);
  const hasEmail = list.some(msg => {
    const content = typeof msg?.content === 'string' ? msg.content : '';
    return EMAIL_CONTEXT_MARKERS.some(marker => content.includes(marker));
  });
  const hasFiles = list.some(msg => carries(msg?.fileData) || carries(msg?.imageData));
  const hasAudio = list.some(msg => carries(msg?.audioData));
  if (hasEmail) sources.push('email');
  if (hasFiles) sources.push('file');
  if (hasAudio) sources.push('audio');
  return sources;
}

/**
 * Bounded, JSON-safe preview of a tool result for the wire (the full result
 * stays in the transcript the model sees, never on the client).
 */
export function previewToolResult(value) {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > PREVIEW_CHARS
      ? `${value.slice(0, PREVIEW_CHARS)}…[truncated ${value.length - PREVIEW_CHARS} chars]`
      : value;
  }
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
  if (typeof text !== 'string') return null;
  if (text.length <= PREVIEW_CHARS) return value;
  return `${text.slice(0, PREVIEW_CHARS)}…[truncated ${text.length - PREVIEW_CHARS} chars]`;
}

function emit(ctx, type, data) {
  return ctx?.meta?.stream?.emit?.(type, data) ?? null;
}

function callIdOf(info) {
  return String(info.call?.id || (info.call?.index ?? '0'));
}

function toolCallRecords(toolCalls) {
  return (toolCalls || []).map(c => ({
    id: c.id || `${c.index}`,
    index: c.index,
    type: c.type || 'function',
    name: c.function?.name,
    arguments: c.function?.arguments || '',
    ...(c.metadata ? { metadata: c.metadata } : {})
  }));
}

/**
 * Per-turn bookkeeping: prompt-implied knowledge sources on the first step,
 * metrics for every model call, and the `step/completed` frame. Usage
 * analytics are recorded by `LLMClient` for every call, not here.
 */
export function chatTurnSeam({
  chatId,
  buildLogData,
  streaming,
  telemetry = defaultTelemetry,
  contextTracker = null
}) {
  // The context window as the server counts it, sent with every model call
  // and after each reply: tool results (pages a research read) fill it, and
  // only the server holds them.
  const reportContext = (ctx, state) => {
    if (state) emit(ctx, SSE_V2_EVENTS.CONTEXT_USAGE, { ...state, step: ctx.iteration });
  };
  return {
    name: 'chat-turn',
    async preStep(ctx) {
      if (ctx.iteration === 1) {
        for (const source of detectContextSources(ctx.messages)) ctx.addKnowledgeSource(source);
      }
      if (contextTracker) reportContext(ctx, contextTracker.estimate(ctx.messages));
      await telemetry.recordChatCallStart({
        baseLog: buildLogData(streaming),
        chatId,
        model: ctx.model,
        messages: ctx.messages
      });
    },
    async stepEnd(ctx, step) {
      await telemetry.recordChatCallEnd({
        baseLog: buildLogData(streaming),
        model: ctx.model,
        outcome: 'completed'
      });
      if (contextTracker) {
        reportContext(ctx, contextTracker.recordStep(step.result?.usage, ctx.messages.length));
      }
      emit(ctx, SSE_V2_EVENTS.STEP_COMPLETED, {
        step: ctx.iteration,
        content: step.result?.content || '',
        toolCalls: toolCallRecords(step.toolCalls),
        finishReason: step.result?.finishReason ?? null,
        ...(step.result?.usage ? { usage: step.result.usage } : {}),
        sources: [...ctx.knowledgeSources],
        ...(step.result?.groundingMetadata
          ? { groundingMetadata: step.result.groundingMetadata }
          : {})
      });
    }
  };
}

/**
 * The `_mcp` marker of a tool that renders an MCP App view, or null.
 * @param {Object} info - Loop tool info
 * @returns {Object|null}
 */
function mcpAppOf(info) {
  const mcp = info?.toolDef?._mcp;
  return mcp?.ui?.resourceUri ? mcp : null;
}

/**
 * MCP App view for a finished call: what to render plus the data to render it
 * with — the tool input and the full CallToolResult (the model only ever sees
 * its text; the view gets structured content and `_meta` too). A call that
 * failed without a result (timeout, transport error) is marked cancelled so
 * the view can say so.
 */
function mcpAppViewFor(info, mcp) {
  const raw = info.mcpAppResult;
  return buildViewDescriptor({
    callId: callIdOf(info),
    toolId: String(info.toolId),
    mcp,
    args: info.args,
    ...(raw ? { toolResult: toViewToolResult(raw) } : { cancelled: true })
  });
}

/**
 * MCP App view of a tool that declares none but whose result embeds a view
 * page (`ui://…` HTML, as mcp-ui servers return it), or null. Only a server
 * with MCP Apps enabled hands its raw result back (`mcpAppResult`), so a
 * disabled server never gets a view this way.
 */
function embeddedMcpAppViewFor(info) {
  const mcp = info?.toolDef?._mcp;
  const raw = info?.mcpAppResult;
  if (!mcp?.serverId || mcp.ui?.resourceUri || !raw) return null;
  const embedded = findEmbeddedView(raw);
  if (!embedded) return null;
  return buildViewDescriptor({
    callId: callIdOf(info),
    toolId: String(info.toolId),
    mcp,
    embeddedUri: embedded.uri,
    args: info.args,
    toolResult: toViewToolResult(raw)
  });
}

/** Longest string kept from an auth-required result (ids, names, scopes). */
const AUTH_REQUIRED_FIELD_CHARS = 512;

/** Most scopes kept from an auth-required result. */
const AUTH_REQUIRED_MAX_SCOPES = 20;

const AUTH_REQUIRED_REASONS = new Set(['not_connected', 'expired', 'insufficient_scope']);

/**
 * The installation a tool belongs to: an installed integration's
 * (`_integration.instanceId`, which every MCP, native and OpenAPI action
 * carries) or, for an MCP tool listed without it, its server's.
 *
 * @param {Object|null|undefined} toolDef
 * @returns {string|null}
 */
function installationOfTool(toolDef) {
  const id = toolDef?._integration?.instanceId || toolDef?._mcp?.serverId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The Connect card of a tool result that says "connect first"
 * (`{ error: 'INTEGRATION_AUTH_REQUIRED', integration, reason, connectUrl,
 * scopes? }`, see services/integrations/auth/integrationAuthRequired.js), or
 * null.
 *
 * Only a result about the tool's **own** installation counts, so an unrelated
 * tool's result cannot spoof a card for an integration it has no relation to.
 * Results of calls that failed inside the adapter or on the transport are
 * not this shape and never produce a card (and so are never retried after a
 * connect).
 *
 * @param {*} rawResult - The tool's result as the loop saw it
 * @param {Object} toolDef - The tool's definition
 * @returns {{integration: string, name: string, reason: string, action?: string, scopes?: string[]}|null}
 *
 * @example
 * authRequiredOf(
 *   { error: 'INTEGRATION_AUTH_REQUIRED', integration: 'jira', reason: 'not_connected' },
 *   { _integration: { instanceId: 'jira', instanceLabel: 'Jira', actionTitle: 'Search issues' } }
 * ); // → { integration: 'jira', name: 'Jira', reason: 'not_connected', action: 'Search issues' }
 */
export function authRequiredOf(rawResult, toolDef) {
  if (!rawResult || typeof rawResult !== 'object') return null;
  if (rawResult.error !== 'INTEGRATION_AUTH_REQUIRED') return null;
  const own = installationOfTool(toolDef);
  if (!own || rawResult.integration !== own) return null;
  const reason = AUTH_REQUIRED_REASONS.has(rawResult.reason) ? rawResult.reason : 'not_connected';
  const name = String(toolDef?._integration?.instanceLabel || own).slice(
    0,
    AUTH_REQUIRED_FIELD_CHARS
  );
  const action = toolDef?._integration?.actionTitle;
  const scopes = Array.isArray(rawResult.scopes)
    ? rawResult.scopes
        .filter(scope => typeof scope === 'string' && scope)
        .slice(0, AUTH_REQUIRED_MAX_SCOPES)
        .map(scope => scope.slice(0, AUTH_REQUIRED_FIELD_CHARS))
    : [];
  return {
    integration: own.slice(0, AUTH_REQUIRED_FIELD_CHARS),
    name,
    reason,
    ...(typeof action === 'string' && action
      ? { action: action.slice(0, AUTH_REQUIRED_FIELD_CHARS) }
      : {}),
    ...(scopes.length > 0 ? { scopes } : {})
  };
}

/**
 * Tool call projection: `tool/started` / `tool/completed` frames, the
 * interaction log, and the rich error envelope the chat model has always been
 * handed back on a failed tool.
 *
 * MCP App tools also announce their view on `tool/started` (so the client can
 * mount it while the tool runs) and ship the view's data on `tool/completed`;
 * the views are collected on `mcpAppViews` for the stored answer. A tool that
 * declares no view but returns an embedded view page gets its view on
 * `tool/completed` only (`mcpApp.embedded`).
 *
 * A tool whose caller has no usable connection to its integration returns
 * `INTEGRATION_AUTH_REQUIRED` before it runs; the Connect card for it rides on
 * `tool/completed` as `authRequired` and is collected on `authPrompts` (one
 * per integration) for the stored answer.
 *
 * Before any of that, while the model is still writing a call's arguments (a
 * whole web artifact, a document) or says nothing at all, the seam reports
 * live `tool/progress` frames: `args` / `args.ended` for the call being
 * written and `model.waiting` for the silence (`onChunk`, `streamEnd`,
 * `preStep`; the rules are in `toolArgProgress.js`, the frames in
 * `docs/sse-v2.md`). They are not stored. `streamProgress: false` (a turn
 * nobody watches live) leaves them out.
 */
export function chatToolSeam({
  chatId,
  buildLogData,
  logInteraction,
  mcpAppViews = null,
  authPrompts = null,
  scheduledTaskProposals = null,
  generatedFiles = null,
  generatedImages = null,
  fileStore = null,
  streamProgress = true
}) {
  const recordView = view => {
    if (Array.isArray(mcpAppViews)) mcpAppViews.push(view);
    return view;
  };
  const recordAuthPrompt = prompt => {
    if (
      Array.isArray(authPrompts) &&
      !authPrompts.some(p => p.integration === prompt.integration)
    ) {
      authPrompts.push(prompt);
    }
    return prompt;
  };
  // Live progress while the model produces a call's arguments, and while it
  // is silent (see the module doc of `toolArgProgress.js`).
  const argTracker = createToolArgTracker();
  let waitingCtx = null;
  const waiting = createWaitingLine({
    isSuppressed: () => argTracker.hasOpenCalls(),
    onWaiting: ({ elapsedMs, reasoning }) =>
      emit(waitingCtx, SSE_V2_EVENTS.TOOL_PROGRESS, {
        step: waitingCtx.iteration,
        phase: PROGRESS_PHASES.MODEL_WAITING,
        data: { elapsedMs, ...(reasoning ? { reasoning: true } : {}) }
      })
  });
  /** Whether this model call's progress goes anywhere: a streamed chat turn whose tools the server runs. */
  const progressLive = ctx =>
    streamProgress && ctx?.request?.toolExecution !== 'caller' && !!ctx?.meta?.stream?.emit;
  const emitFrames = (ctx, frames) => {
    for (const frame of frames) {
      emit(ctx, SSE_V2_EVENTS.TOOL_PROGRESS, {
        step: ctx.iteration,
        callId: frame.callId,
        toolId: frame.toolId,
        phase: frame.phase,
        data: frame.data
      });
    }
  };
  /** A display-only hook must never take a turn down. */
  const guarded = (what, fn) => {
    try {
      fn();
    } catch (err) {
      logger.warn(`Tool argument progress failed (${what})`, {
        component: COMPONENT,
        chatId,
        error: err?.message
      });
    }
  };

  return {
    name: 'chat-tools',
    preStep(ctx) {
      if (!progressLive(ctx)) return;
      waitingCtx = ctx;
      waiting.arm();
    },
    onChunk(ctx, chunk) {
      if (!progressLive(ctx)) return;
      guarded('chunk', () => {
        if (chunkShowsOutput(chunk)) waiting.visible();
        if (chunkHasReasoning(chunk)) waiting.thinking();
        const early = chunk.toolCallProgress;
        if (!Array.isArray(early) || early.length === 0) return;
        const frames = argTracker.observe(early, name => ctx.resolveTool?.(name));
        if (frames.length === 0) return;
        // A row on screen: the waiting line stands down.
        waiting.visible();
        emitFrames(ctx, frames);
      });
    },
    streamEnd(ctx, { outcome, result }) {
      waiting.stop();
      guarded('end', () => {
        const frames = argTracker.close({ outcome, result });
        emitFrames(ctx, frames);
        for (const frame of frames) {
          logger.debug('Tool arguments streamed', {
            component: COMPONENT,
            chatId,
            toolId: frame.toolId,
            ...frame.data
          });
        }
      });
    },
    liftResult(ctx, info, holder) {
      return liftMcpResultEarly(
        { toolDef: info.toolDef, chatId, ownerId: ctx?.refs?.userId || null, store: fileStore },
        holder
      );
    },
    preTool(ctx, info) {
      logger.info('Chat tool call', {
        component: COMPONENT,
        chatId,
        toolId: info.toolId,
        isWorkflow: String(info.toolId).startsWith('workflow_'),
        argKeys: Object.keys(info.args || {}).join(', ')
      });
      const mcp = mcpAppOf(info);
      emit(ctx, SSE_V2_EVENTS.TOOL_STARTED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(info.toolId),
        name: String(info.name || info.toolId),
        // What the user reads instead of the id: the action and the system it ran against.
        ...startedDisplayOf(info.toolDef),
        args: info.args,
        execution: info.toolDef?.passthrough
          ? 'passthrough'
          : info.toolDef?.interactive
            ? 'clarification'
            : 'server',
        ...(mcp
          ? {
              mcpApp: {
                serverId: mcp.serverId,
                toolName: mcp.originalName,
                resourceUri: mcp.ui.resourceUri
              }
            }
          : {})
      });
      return null;
    },
    async postTool(ctx, info, outcome) {
      const { toolId, args } = info;
      const mcp = mcpAppOf(info);
      // A call that never reached its integration ("connect first") has no
      // view to show: the Connect card stands in for it.
      let mcpApp =
        mcp && !(!outcome.error && authRequiredOf(outcome.rawResult, info.toolDef))
          ? recordView(mcpAppViewFor(info, mcp))
          : null;
      if (!mcp && !outcome.error) {
        const embedded = embeddedMcpAppViewFor(info);
        if (embedded) mcpApp = recordView(embedded);
      }
      if (outcome.error) {
        const err = outcome.error;
        const causeMessage =
          err?.cause?.message || (typeof err?.cause === 'string' ? err.cause : undefined);
        const causeCode = err?.cause?.code;
        const errorResult = {
          error: true,
          message: `Tool execution failed: ${err.message || 'Unknown error'}`,
          toolId,
          code: err?.code || causeCode,
          cause: causeMessage,
          details: err?.stack || String(err)
        };
        outcome.rawResult = errorResult;
        outcome.message.content = JSON.stringify(errorResult);
        emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
          step: ctx.iteration,
          callId: callIdOf(info),
          toolId: String(toolId),
          name: String(info.name || toolId),
          resultPreview: previewToolResult({ error: true, message: errorResult.message }),
          error: {
            ...(errorResult.code ? { code: String(errorResult.code) } : {}),
            message: errorResult.message
          },
          ...(Number.isInteger(outcome.durationMs) ? { durationMs: outcome.durationMs } : {}),
          ...(mcpApp ? { mcpApp } : {})
        });
        await logInteraction(
          'tool_error',
          buildLogData(true, { toolId, toolInput: args, error: errorResult })
        );
        return;
      }
      const authRequired = authRequiredOf(outcome.rawResult, info.toolDef);
      if (authRequired) recordAuthPrompt(authRequired);
      // Only the scheduling tools may draw a confirmation card; any other
      // tool's result carrying the same field is ignored.
      const scheduledTaskProposal = isSchedulingToolDef(info.toolDef)
        ? proposalOf(outcome.rawResult)
        : null;
      if (scheduledTaskProposal && Array.isArray(scheduledTaskProposals)) {
        scheduledTaskProposals.push(scheduledTaskProposal);
      }
      // Only the built-in tools of system skills (and the skills of remote A2A
      // agents) hand the user a file (a download card); the same field on any
      // other tool's result is ignored. The result names the file without its
      // bytes, so the model never sees them: they were held for this turn, and
      // go to the client here and to the stored answer (as an artifact)
      // through `generatedFiles`. An MCP tool's binary blocks (`resource`
      // blob, `image`) are stored here and replaced by `{ fileId, name,
      // mimeType, bytes }` descriptors before the model reads the result.
      const lifted = await settleToolOutputs(outcome, {
        toolDef: info.toolDef,
        chatId,
        ownerId: ctx?.refs?.userId || null,
        store: fileStore
      });
      const files = lifted.files;
      if (files.length && Array.isArray(generatedFiles)) generatedFiles.push(...files);
      for (const image of lifted.images) {
        if (Array.isArray(generatedImages)) generatedImages.push(image);
        emit(ctx, SSE_V2_EVENTS.STEP_DELTA, {
          step: ctx.iteration,
          kind: 'image',
          image: { mimeType: image.mimeType, data: image.data }
        });
      }
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(toolId),
        name: String(info.name || toolId),
        resultPreview: previewToolResult(outcome.rawResult),
        ...(Number.isInteger(outcome.durationMs) ? { durationMs: outcome.durationMs } : {}),
        ...(outcome.knowledgeSource ? { knowledgeSource: outcome.knowledgeSource } : {}),
        ...(outcome.activityOrigin ? { activityOrigin: outcome.activityOrigin } : {}),
        ...(Number.isInteger(outcome.resultCount) ? { resultCount: outcome.resultCount } : {}),
        ...(outcome.readOutcome ? { readOutcome: outcome.readOutcome } : {}),
        ...(mcpApp ? { mcpApp } : {}),
        ...(authRequired ? { authRequired } : {}),
        ...(scheduledTaskProposal ? { scheduledTaskProposal } : {}),
        ...(files.length ? { files } : {})
      });
      await logInteraction(
        'tool_usage',
        buildLogData(true, { toolId, toolInput: args, toolOutput: outcome.rawResult })
      );
    }
  };
}

/**
 * Build the `question` interaction for a chat `ask_user` call (the shared
 * prompt from `questionPrompt.js` plus the chat source).
 */
export function buildQuestionInteraction(
  args = {},
  { runId, step, chatId, appId, toolCallId, toolId, ordinal, max }
) {
  const prompt = buildQuestionPrompt(args);
  return {
    id: `clarify-${chatId}-${ordinal}-${Date.now()}`,
    runId,
    step: Number.isInteger(step) ? step : 0,
    kind: 'question',
    origin: 'tool',
    prompt,
    policy: {},
    status: 'pending',
    source: {
      ...(toolCallId ? { toolCallId: String(toolCallId) } : {}),
      toolId: String(toolId || 'ask_user'),
      chatId,
      ...(appId ? { appId } : {})
    },
    createdAt: new Date().toISOString(),
    ordinal,
    /** Cap for the UI ("question 2 of 10"). */
    maxClarifications: max
  };
}

/**
 * Options for the shared `questionSeam`: the chat projection of a
 * clarification (interaction frame, tool frames, interaction log, per-chat
 * counter).
 */
export function chatQuestionOptions({
  chatId,
  appId,
  buildLogData,
  logInteraction,
  headless,
  getCount,
  incrementCount,
  interactionService = defaultInteractionService,
  runLog = defaultRunLog
}) {
  const max = MAX_CLARIFICATIONS_PER_CONVERSATION;
  return {
    maxQuestions: max,
    headless,
    getCount,
    incrementCount,
    validate: validateAskUserParams,
    async onRejected(reason, info, ctx, payload) {
      if (reason === 'limit') {
        logger.warn('Clarification limit reached', {
          component: COMPONENT,
          chatId,
          maxAllowed: max
        });
      } else if (reason === 'invalid') {
        logger.error('Invalid ask_user parameters', {
          component: COMPONENT,
          chatId,
          error: payload.message
        });
      }
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(info.toolId),
        name: String(info.name || info.toolId),
        resultPreview: payload,
        error: { code: String(payload.code || 'CLARIFICATION_REJECTED'), message: payload.message }
      });
      if (reason === 'limit') {
        await logInteraction(
          'tool_usage',
          buildLogData(true, {
            toolId: info.toolId,
            toolInput: info.args,
            toolOutput: payload,
            rateLimited: true
          })
        );
      }
    },
    async raise(info, ctx) {
      const draft = buildQuestionInteraction(info.args, {
        runId: ctx.runId || chatId,
        step: ctx.iteration,
        chatId,
        appId,
        toolCallId: info.call?.id,
        toolId: info.toolId,
        ordinal: info.ordinal,
        max: info.max
      });
      logger.info('Clarification requested', {
        component: COMPONENT,
        chatId,
        clarificationNumber: info.ordinal,
        inputType: draft.prompt.inputType,
        question: draft.prompt.message.substring(0, 100)
      });
      // The UI-only cap is not part of the contract; the frame carries the
      // persisted interaction (pending store + `interaction/raised` on the
      // ledger) so the answer — the next chat message, or the answer endpoint —
      // resolves the same record.
      const { maxClarifications, ...wire } = draft;
      let interaction;
      try {
        const runMeta = runLog.getRunMeta(wire.runId);
        const principalId = runMeta?.principalId || null;
        const identityMode = runMeta?.identityMode || null;
        interaction = await interactionService.raise({
          id: wire.id,
          runId: wire.runId,
          step: wire.step,
          kind: wire.kind,
          origin: wire.origin,
          prompt: wire.prompt,
          policy: { timeoutMs: CLARIFICATION_TTL_MS, onTimeout: 'fail', fallback: 'park' },
          source: {
            ...wire.source,
            ...(principalId ? { principalId: String(principalId) } : {}),
            ...(identityMode ? { identityMode } : {}),
            ...(runMeta?.anonymous ? { anonymous: true } : {})
          },
          ordinal: wire.ordinal
        });
      } catch (raiseErr) {
        // Nothing could answer a question that is not on record (the answer
        // endpoint and the next message look it up by id): fail the call
        // instead of pausing the run on a draft.
        logger.error('Clarification could not be persisted as an interaction', {
          component: COMPONENT,
          chatId,
          error: raiseErr.message
        });
        throw Object.assign(new Error(`Clarification could not be raised: ${raiseErr.message}`), {
          code: 'INTERACTION_RAISE_FAILED',
          cause: raiseErr
        });
      }
      emit(ctx, SSE_V2_EVENTS.INTERACTION_RAISED, { interaction });
      await logInteraction(
        'clarification_request',
        buildLogData(true, {
          toolId: info.toolId,
          toolInput: info.args,
          clarificationNumber: info.ordinal,
          maxClarifications
        })
      );
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(info.toolId),
        name: String(info.name || info.toolId),
        resultPreview: { clarificationRequested: true, clarificationNumber: info.ordinal }
      });
      return { ...interaction, maxClarifications };
    }
  };
}

/** Whether two argument objects are the same JSON value (see `approvalSeam.sameArgs`). */
export { sameArgs };

/**
 * Options for the shared `approvalSeam` in a chat turn (#2945): the
 * resolved policy of each tool (stamped by `getToolsForApp`, else resolved
 * for this app), the chat's grants ("allow for this chat") and the one call a
 * person just approved, the `approval` interaction with its frames, and the
 * refusal where nobody can approve.
 *
 * @param {Object} options
 * @param {string} options.chatId
 * @param {Object} [options.app]
 * @param {Object} [options.platform]
 * @param {boolean} options.headless - nobody can answer an approval card here
 * @param {string[]} [options.grants] - tool ids the user allowed for this chat
 * @param {{callId: string, args: Object}|null} [options.approvedCall] - the call being resumed
 * @param {Function} options.buildLogData
 * @param {Function} options.logInteraction
 * @returns {Object} options for `approvalSeam`
 */
export function chatApprovalOptions({
  chatId,
  app = null,
  platform = null,
  headless,
  grants = [],
  approvedCall = null,
  buildLogData,
  logInteraction,
  interactionService = defaultInteractionService,
  runLog = defaultRunLog
}) {
  const granted = new Set((Array.isArray(grants) ? grants : []).map(String));
  const approvedOnce = oneShotGrant(approvedCall);
  return {
    headless,
    resolvePolicy: toolDef => resolveToolApproval(toolDef, app, platform),
    isGranted(info) {
      const toolId = String(info.toolId || info.toolDef?.id);
      if (granted.has(toolId)) return true;
      // The call a person approved runs once, with exactly those arguments.
      return approvedOnce(info);
    },
    async raise(info, ctx, policy) {
      const runId = ctx.runId || chatId;
      const runMeta = runLog?.getRunMeta?.(runId) || null;
      const principalId = runMeta?.principalId || null;
      const identityMode = runMeta?.identityMode || null;
      const displayData = approvalDisplayData(info, policy, {
        justification: justificationOf(ctx, info.call)
      });
      let interaction;
      try {
        interaction = await interactionService.raise({
          id: `approve-${chatId}-${crypto.randomUUID()}`,
          runId,
          step: Number.isInteger(ctx.iteration) ? ctx.iteration : 0,
          kind: 'approval',
          origin: 'tool',
          prompt: {
            title: `Run ${displayData.toolName}?`,
            message:
              `The assistant wants to run "${displayData.toolName}". ` +
              'Nothing is sent until you choose.',
            inputType: 'confirm',
            displayData
          },
          policy: { timeoutMs: CLARIFICATION_TTL_MS, onTimeout: 'deny', fallback: 'deny' },
          source: {
            ...(info.call?.id ? { toolCallId: String(info.call.id) } : {}),
            toolId: displayData.toolId,
            chatId,
            ...(app?.id ? { appId: app.id } : {}),
            ...(principalId ? { principalId: String(principalId) } : {}),
            ...(identityMode ? { identityMode } : {}),
            ...(runMeta?.anonymous ? { anonymous: true } : {})
          }
        });
      } catch (raiseErr) {
        // An approval nobody can find again could never be answered: fail the
        // call (the model sees the error) instead of pausing on a draft.
        logger.error('Tool approval could not be persisted as an interaction', {
          component: COMPONENT,
          chatId,
          toolId: info.toolId,
          error: raiseErr.message
        });
        throw Object.assign(new Error(`Approval could not be raised: ${raiseErr.message}`), {
          code: 'INTERACTION_RAISE_FAILED',
          cause: raiseErr
        });
      }
      logger.info('Tool approval requested', {
        component: COMPONENT,
        chatId,
        toolId: displayData.toolId,
        sideEffect: displayData.sideEffect,
        dataFlow: displayData.dataFlow,
        approvalSource: displayData.approvalSource
      });
      // `interaction/raised` is sent by the turn once the paused turn is kept
      // with the chat (ChatService), so the card never appears before an
      // answer to it could be accepted.
      return interaction;
    },
    async onDenied(info, ctx, payload) {
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(info.toolId),
        name: String(info.name || info.toolId),
        resultPreview: payload,
        error: { code: payload.code, message: payload.message }
      });
      await logInteraction(
        'tool_error',
        buildLogData(true, {
          toolId: info.toolId,
          // A refused call never ran: its arguments are logged redacted.
          toolInput: redactApprovalArgs(info.args),
          error: payload
        })
      );
    }
  };
}

/**
 * The tool result the model gets for a gated call that did not run: the
 * person rejected it, or the approval expired.
 *
 * @param {'rejected'|'expired'} outcome
 * @param {string} toolName
 * @returns {Object}
 */
export function approvalRefusalPayload(outcome, toolName) {
  if (outcome === 'expired') {
    return {
      error: true,
      code: APPROVAL_ERROR_CODES.APPROVAL_EXPIRED,
      message: `The approval for "${toolName}" expired before anyone answered. It was not run. Continue without it, or ask the user whether to try again.`
    };
  }
  return {
    error: true,
    code: APPROVAL_ERROR_CODES.USER_REJECTED,
    message: `The user rejected "${toolName}". It was not run. Do not call it again with the same arguments; continue without it or ask the user how to proceed.`
  };
}

/**
 * Options for the shared `passthroughSeam`: run the tool with the chat
 * context, stream its text as `step/delta` frames, close with `tool/completed`
 * and the tool/interaction log.
 */
export function chatPassthroughOptions({
  chatId,
  chatStored = false,
  user,
  app,
  integrationScopes = {},
  userFileData,
  streaming,
  buildLogData,
  logInteraction,
  runTool
}) {
  return {
    runTool: (toolId, params) => runTool(toolId, params),
    buildParams(info) {
      // The run id of a chat-launched workflow is minted by the chat route, never
      // taken from the model's arguments.
      const { runId: _modelRunId, ...args } = info.args || {};
      const params = {
        ...args,
        chatId,
        user,
        passthrough: true,
        appConfig: app,
        integrationScopes
      };
      // Workflow tools receive the upload so their inputFiles mechanism can
      // inject file content into agent node messages.
      if (String(info.toolId).startsWith('workflow_') && userFileData)
        params._fileData = userFileData;
      // Whether the chat is stored, so the workflow's execution links back to
      // it only when there is a chat to go back to.
      if (String(info.toolId).startsWith('workflow_')) params._chatStored = chatStored;
      return params;
    },
    onChunk(text, info, ctx) {
      if (!streaming || !text) return;
      emit(ctx, SSE_V2_EVENTS.STEP_DELTA, { step: ctx.iteration, kind: 'text', content: text });
    },
    async onComplete(text, info, ctx) {
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(info.toolId),
        name: String(info.name || info.toolId),
        resultPreview: { answer: previewToolResult(text) }
      });
      await logInteraction(
        'tool_usage',
        buildLogData(true, {
          toolId: info.toolId,
          toolInput: info.args,
          toolOutput: { answer: text, streaming: true }
        })
      );
    },
    async onError(err, info, ctx) {
      logger.error('Passthrough tool execution failed', {
        component: COMPONENT,
        toolId: info.toolId,
        error: err
      });
      const errorResult = {
        error: true,
        message: `Passthrough tool execution failed: ${err.message || 'Unknown error'}`,
        toolId: info.toolId,
        details: err.stack || String(err)
      };
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(info.toolId),
        name: String(info.name || info.toolId),
        resultPreview: { error: true, message: errorResult.message },
        error: { message: errorResult.message }
      });
      await logInteraction(
        'tool_error',
        buildLogData(true, { toolId: info.toolId, toolInput: info.args, error: errorResult })
      );
    }
  };
}
