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

/**
 * A clarification nobody answers expires after a day, so abandoned chats do
 * not accumulate pending interactions.
 */
export const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const COMPONENT = 'ChatService';
const PREVIEW_CHARS = 4096;

/** Markers the Office add-in puts around email / meeting context. */
export const EMAIL_CONTEXT_MARKERS = [
  '--- Current email ---',
  '--- Pinned emails',
  '--- Current meeting ---'
];

/**
 * Knowledge sources implied by the prompt itself: Office email/meeting
 * context and uploaded files/images.
 * @param {Array} messages
 * @returns {Array<'email'|'file'>}
 */
export function detectContextSources(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sources = [];
  const hasEmail = list.some(msg => {
    const content = typeof msg?.content === 'string' ? msg.content : '';
    return EMAIL_CONTEXT_MARKERS.some(marker => content.includes(marker));
  });
  const hasFiles = list.some(
    msg =>
      (msg?.fileData && (Array.isArray(msg.fileData) ? msg.fileData.length > 0 : true)) ||
      (msg?.imageData && (Array.isArray(msg.imageData) ? msg.imageData.length > 0 : true))
  );
  if (hasEmail) sources.push('email');
  if (hasFiles) sources.push('file');
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
 * usage/metrics for every model call, and the `step/completed` frame.
 */
export function chatTurnSeam({ chatId, buildLogData, streaming, telemetry = defaultTelemetry }) {
  return {
    name: 'chat-turn',
    async preStep(ctx) {
      if (ctx.iteration === 1) {
        for (const source of detectContextSources(ctx.messages)) ctx.addKnowledgeSource(source);
      }
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
        usage: step.result?.usage || null,
        content: step.result?.content || '',
        outcome: 'completed'
      });
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
 * Tool call projection: `tool/started` / `tool/completed` frames, the
 * interaction log, and the rich error envelope the chat model has always been
 * handed back on a failed tool.
 */
export function chatToolSeam({ chatId, buildLogData, logInteraction }) {
  return {
    name: 'chat-tools',
    preTool(ctx, info) {
      logger.info('Chat tool call', {
        component: COMPONENT,
        chatId,
        toolId: info.toolId,
        isWorkflow: String(info.toolId).startsWith('workflow_'),
        argKeys: Object.keys(info.args || {}).join(', ')
      });
      emit(ctx, SSE_V2_EVENTS.TOOL_STARTED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(info.toolId),
        name: String(info.name || info.toolId),
        args: info.args,
        execution: info.toolDef?.passthrough
          ? 'passthrough'
          : info.toolDef?.interactive
            ? 'clarification'
            : 'server'
      });
      return null;
    },
    async postTool(ctx, info, outcome) {
      const { toolId, args } = info;
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
          ...(Number.isInteger(outcome.durationMs) ? { durationMs: outcome.durationMs } : {})
        });
        await logInteraction(
          'tool_error',
          buildLogData(true, { toolId, toolInput: args, error: errorResult })
        );
        return;
      }
      emit(ctx, SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: ctx.iteration,
        callId: callIdOf(info),
        toolId: String(toolId),
        name: String(info.name || toolId),
        resultPreview: previewToolResult(outcome.rawResult),
        ...(Number.isInteger(outcome.durationMs) ? { durationMs: outcome.durationMs } : {}),
        ...(outcome.knowledgeSource ? { knowledgeSource: outcome.knowledgeSource } : {})
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

/**
 * Options for the shared `passthroughSeam`: run the tool with the chat
 * context, stream its text as `step/delta` frames, close with `tool/completed`
 * and the tool/interaction log.
 */
export function chatPassthroughOptions({
  chatId,
  user,
  app,
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
      const params = { ...args, chatId, user, passthrough: true, appConfig: app };
      // Workflow tools receive the upload so their inputFiles mechanism can
      // inject file content into agent node messages.
      if (String(info.toolId).startsWith('workflow_') && userFileData)
        params._fileData = userFileData;
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
