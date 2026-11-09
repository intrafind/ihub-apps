// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat channel — projects the agent loop's streamed chunks onto SSE v2 frames
 * for the chat stream (`services/loop/RunStream.js`).
 *
 * One channel per turn. It carries the little per-turn state the projection
 * needs (whether any answer output was produced, whether the iAssistant
 * conversation id was announced) so the loop itself stays surface-agnostic.
 *
 * @module services/chat/chatChannel
 */
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import conversationStateManager from '../integrations/ConversationStateManager.js';
import { matchTool } from '../loop/toolArgs.js';
import { toolDisplayOf } from '../../utils/toolDisplay.js';

const PREPARING_UPDATE_MS = 1000;

function thoughtToDelta(thought) {
  if (typeof thought === 'string') return { content: thought };
  if (!thought || typeof thought !== 'object') return { content: String(thought ?? '') };
  const { content, ...rest } = thought;
  const meta = Object.keys(rest).length > 0 ? rest : undefined;
  return { content: typeof content === 'string' ? content : String(content ?? ''), meta };
}

/**
 * @param {Object} params
 * @param {string} params.chatId
 * @param {import('../loop/RunStream.js').RunStreamEmitter} params.stream
 * @returns {{ state: {answerOutput: boolean}, onChunk: Function, onSources: Function }}
 */
export function createChatChannel({ chatId, stream }) {
  const state = { answerOutput: false, conversationIdEmitted: false };
  const emit = (type, data) => stream?.emit(type, data);

  // iAssistant conversation adapter: search status, title, conversation id
  // and the response message id ride along with the chunks (its documents
  // come as `chunk.sources`, reported by the loop like every producer's).
  const emitConversationEvents = (chunk, request, ctx) => {
    if (chunk.sources && ctx.model?.provider === 'iassistant-conversation') {
      ctx.addKnowledgeSource('iassistant');
    }
    if (chunk.searchStatus) {
      emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
        step: ctx.iteration,
        phase: 'search.status',
        data: chunk.searchStatus
      });
    }
    if (chunk.conversationTitle) {
      emit(SSE_V2_EVENTS.META, { chatId, title: String(chunk.conversationTitle) });
    }
    const conversationId = request?._conversationId;
    if (conversationId && chunk.content?.length > 0 && !state.conversationIdEmitted) {
      emit(SSE_V2_EVENTS.META, { chatId, conversationId: String(conversationId) });
      state.conversationIdEmitted = true;
    }
    if (chunk.responseMessageId) {
      conversationStateManager.updateParentId(chatId, chunk.responseMessageId);
      emit(SSE_V2_EVENTS.META, { chatId, responseMessageId: String(chunk.responseMessageId) });
    }
  };

  // A tool call is announced as soon as its name streams in, not when its
  // arguments are complete: a long call (a whole web page for
  // `create_web_artifact`) otherwise streams for minutes behind a bare
  // spinner. `tool/started` follows once the call runs and replaces the row.
  // While the arguments stream, the same frame repeats at most once per
  // PREPARING_UPDATE_MS with how many characters are written so far: no
  // provider says how long the call will be or streams its token count.
  const announced = new Map();
  const announceToolCalls = (chunk, ctx) => {
    for (const delta of chunk.tool_calls || []) {
      if (delta?.index === undefined || delta?.index === null) continue;
      const key = `${ctx.iteration}:${delta.index}`;
      const seen = announced.get(key) || { chars: 0, sentAt: null };
      seen.id = seen.id || delta.id || null;
      seen.name = seen.name || delta.function?.name || delta.name || null;
      const args = delta.function?.arguments;
      if (typeof args === 'string') seen.chars += args.length;
      announced.set(key, seen);
      if (!seen.toolDef) seen.toolDef = seen.name ? matchTool(seen.name, ctx.tools) : null;
      if (!seen.toolDef) continue;
      const now = Date.now();
      if (seen.sentAt !== null && now - seen.sentAt < PREPARING_UPDATE_MS) continue;
      seen.sentAt = now;
      emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
        step: ctx.iteration,
        // The same id the call's `tool/started` will carry (`callIdOf` in chatSeams).
        callId: String(seen.id || delta.index),
        phase: 'tool.preparing',
        data: {
          toolId: String(seen.toolDef.id || seen.name),
          name: seen.name,
          ...toolDisplayOf(seen.toolDef),
          chars: seen.chars
        }
      });
    }
  };

  return {
    state,
    onChunk(chunk, ctx) {
      const step = ctx.iteration;
      if (chunk.tool_calls?.length) announceToolCalls(chunk, ctx);
      for (const text of chunk.content || []) {
        if (!text) continue;
        state.answerOutput = true;
        emit(SSE_V2_EVENTS.STEP_DELTA, { step, kind: 'text', content: text });
      }
      if (Array.isArray(chunk.images) && chunk.images.length > 0) {
        for (const image of chunk.images) {
          if (!image?.mimeType || !image?.data) continue;
          state.answerOutput = true;
          emit(SSE_V2_EVENTS.STEP_DELTA, {
            step,
            kind: 'image',
            image: {
              mimeType: String(image.mimeType),
              data: String(image.data),
              ...(image.thoughtSignature
                ? { thoughtSignature: String(image.thoughtSignature) }
                : {})
            }
          });
        }
      }
      for (const thought of chunk.thinking || []) {
        const { content, meta } = thoughtToDelta(thought);
        emit(SSE_V2_EVENTS.STEP_DELTA, {
          step,
          kind: 'thinking',
          content,
          ...(meta ? { meta } : {})
        });
      }
      if (chunk.groundingMetadata) {
        emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
          step,
          phase: 'grounding',
          data: chunk.groundingMetadata
        });
      }
      emitConversationEvents(chunk, ctx.stream?.meta?.request, ctx);
    },
    // Every producer's sources — tool calls, the iAssistant adapter,
    // provider-run web search — as the loop reported them (`ctx.addSources`).
    onSources(frame) {
      emit(SSE_V2_EVENTS.SOURCES_ADDED, frame);
    }
  };
}
