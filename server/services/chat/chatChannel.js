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

function withAccessLinks(items, searchProfile) {
  if (!Array.isArray(items)) return items;
  return items.map(item =>
    item?.document_id && !Array.isArray(item.links)
      ? { ...item, links: [{ type: 'ACCESS', documentId: item.document_id, searchProfile }] }
      : item
  );
}

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
 * @returns {{ state: {answerOutput: boolean}, onChunk: Function }}
 */
export function createChatChannel({ chatId, stream }) {
  const state = { answerOutput: false, conversationIdEmitted: false };
  const emit = (type, data) => stream?.emit(type, data);

  // iAssistant conversation adapter: citations, search status, title,
  // conversation id and the response message id ride along with the chunks.
  const emitConversationEvents = (chunk, request, ctx) => {
    if (chunk.citations) {
      const searchProfile = request?._searchProfile;
      if (searchProfile) {
        if (chunk.citations.references) {
          chunk.citations.references = withAccessLinks(chunk.citations.references, searchProfile);
        }
        if (chunk.citations.resultItems) {
          chunk.citations.resultItems = withAccessLinks(chunk.citations.resultItems, searchProfile);
        }
      }
      ctx.addKnowledgeSource('iassistant');
      ctx.addCitation(chunk.citations);
      emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
        step: ctx.iteration,
        phase: 'citation',
        data: chunk.citations
      });
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

  return {
    state,
    onChunk(chunk, ctx) {
      const step = ctx.iteration;
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
    }
  };
}
