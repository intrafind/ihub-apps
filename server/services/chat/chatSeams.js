/**
 * Chat-surface seams for the agent loop.
 *
 * Everything the chat turn adds on top of the shared loop is a seam here:
 * tool call events and interaction logs, per-call usage/metrics, the
 * upload/email knowledge sources, the clarification (ask_user) projection and
 * the passthrough (workflow) projection. The loop stays surface-agnostic.
 *
 * @module services/chat/chatSeams
 */
import { actionTracker } from '../../actionTracker.js';
import logger from '../../utils/logger.js';
import { MAX_CLARIFICATIONS_PER_CONVERSATION, validateAskUserParams } from '../../tools/askUser.js';
import * as defaultTelemetry from './chatTelemetry.js';

const COMPONENT = 'ChatService';

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
 * Per-turn bookkeeping: prompt-implied knowledge sources on the first step,
 * usage/metrics for every model call, and the "Using tool(s)" status line.
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
      if (streaming && step.toolCalls?.length > 0) {
        const toolNames = step.toolCalls.map(c => c.function.name).join(', ');
        actionTracker.trackAction(chatId, {
          action: 'processing',
          message: `Using tool(s): ${toolNames}...`
        });
      }
    }
  };
}

/**
 * Tool call projection: `tool.call.start` / `tool.call.end` events, the
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
      actionTracker.trackToolCallStart(chatId, { toolName: info.toolId, toolInput: info.args });
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
        actionTracker.trackToolCallEnd(chatId, {
          toolName: toolId,
          toolOutput: errorResult,
          error: true,
          errorCode: errorResult.code,
          errorMessage: errorResult.message
        });
        await logInteraction(
          'tool_error',
          buildLogData(true, { toolId, toolInput: args, error: errorResult })
        );
        return;
      }
      actionTracker.trackToolCallEnd(chatId, { toolName: toolId, toolOutput: outcome.rawResult });
      await logInteraction(
        'tool_usage',
        buildLogData(true, { toolId, toolInput: args, toolOutput: outcome.rawResult })
      );
    }
  };
}

const INPUT_TYPE_MAPPING = {
  select: 'single_select',
  multiselect: 'multi_select',
  confirm: 'single_select',
  text: 'text',
  number: 'number',
  date: 'date'
};

/**
 * The `clarification` event payload (camelCase, client vocabulary) for an
 * `ask_user` call.
 */
export function buildClarificationData(args = {}, { chatId, toolCallId, ordinal, max }) {
  const rawInputType = args.input_type || 'text';
  const data = {
    questionId: `clarify-${chatId}-${ordinal}-${Date.now()}`,
    toolCallId,
    question: args.question,
    inputType: INPUT_TYPE_MAPPING[rawInputType] || rawInputType,
    allowSkip: Boolean(args.allow_skip),
    allowOther: Boolean(args.allow_other),
    clarificationNumber: ordinal,
    maxClarifications: max,
    timestamp: new Date().toISOString()
  };
  if (Array.isArray(args.options) && args.options.length > 0) {
    data.options = args.options.map(opt => ({
      label: opt.label,
      value: opt.value !== undefined ? opt.value : opt.label
    }));
  }
  if (args.placeholder) data.placeholder = String(args.placeholder).substring(0, 200);
  if (args.validation) {
    data.validation = {};
    if (args.validation.pattern) data.validation.pattern = args.validation.pattern;
    if (args.validation.min !== undefined) data.validation.min = Number(args.validation.min);
    if (args.validation.max !== undefined) data.validation.max = Number(args.validation.max);
    if (args.validation.message) {
      data.validation.message = String(args.validation.message).substring(0, 200);
    }
  }
  if (args.context) data.context = String(args.context).substring(0, 500);
  return data;
}

/**
 * Options for the shared `questionSeam`: the chat projection of a
 * clarification (event, tool events, interaction log, per-chat counter).
 */
export function chatQuestionOptions({
  chatId,
  buildLogData,
  logInteraction,
  headless,
  getCount,
  incrementCount
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
      actionTracker.trackToolCallEnd(chatId, {
        toolName: info.toolId,
        toolOutput: payload,
        error: true
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
    async raise(info) {
      const clarificationData = buildClarificationData(info.args, {
        chatId,
        toolCallId: info.call.id,
        ordinal: info.ordinal,
        max: info.max
      });
      logger.info('Clarification requested', {
        component: COMPONENT,
        chatId,
        clarificationNumber: info.ordinal,
        inputType: clarificationData.inputType,
        question: clarificationData.question?.substring(0, 100)
      });
      actionTracker.trackClarification(chatId, clarificationData);
      await logInteraction(
        'clarification_request',
        buildLogData(true, {
          toolId: info.toolId,
          toolInput: info.args,
          clarificationNumber: info.ordinal,
          maxClarifications: info.max
        })
      );
      actionTracker.trackToolCallEnd(chatId, {
        toolName: info.toolId,
        toolOutput: { clarificationRequested: true, clarificationNumber: info.ordinal }
      });
      return clarificationData;
    }
  };
}

/**
 * Options for the shared `passthroughSeam`: run the tool with the chat
 * context, stream its text as `chunk{source:'tool'}` events, close with
 * `tool-stream-complete` and the tool/interaction log.
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
      const params = { ...info.args, chatId, user, passthrough: true, appConfig: app };
      // Workflow tools receive the upload so their inputFiles mechanism can
      // inject file content into agent node messages.
      if (String(info.toolId).startsWith('workflow_') && userFileData)
        params._fileData = userFileData;
      return params;
    },
    onChunk(text, info) {
      if (!streaming) return;
      actionTracker.trackChunk(chatId, { content: text, source: 'tool', toolName: info.toolId });
    },
    async onComplete(text, info) {
      actionTracker.trackToolStreamComplete(chatId, { toolName: info.toolId, content: text });
      actionTracker.trackToolCallEnd(chatId, {
        toolName: info.toolId,
        toolOutput: { answer: text }
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
    async onError(err, info) {
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
      actionTracker.trackToolCallEnd(chatId, {
        toolName: info.toolId,
        toolOutput: errorResult,
        error: true
      });
      await logInteraction(
        'tool_error',
        buildLogData(true, { toolId: info.toolId, toolInput: info.args, error: errorResult })
      );
    }
  };
}
