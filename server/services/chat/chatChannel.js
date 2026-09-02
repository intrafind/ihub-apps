/**
 * Chat channel — projects the agent loop's streamed chunks onto the chat SSE
 * dialect (`actionTracker` → `fire-sse` → the client's EventSource).
 *
 * One channel per turn. It carries the little per-turn state the projection
 * needs (whether any answer output was produced, whether the iAssistant
 * conversation id was announced) so the loop itself stays surface-agnostic.
 *
 * @module services/chat/chatChannel
 */
import { actionTracker } from '../../actionTracker.js';
import conversationStateManager from '../integrations/ConversationStateManager.js';

function withAccessLinks(items, searchProfile) {
  if (!Array.isArray(items)) return items;
  return items.map(item =>
    item?.document_id && !Array.isArray(item.links)
      ? { ...item, links: [{ type: 'ACCESS', documentId: item.document_id, searchProfile }] }
      : item
  );
}

/**
 * @param {Object} params
 * @param {string} params.chatId
 * @returns {{ state: {answerOutput: boolean}, onChunk: Function }}
 */
export function createChatChannel({ chatId }) {
  const state = { answerOutput: false, conversationIdEmitted: false };

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
      actionTracker.trackCitation(chatId, chunk.citations);
    }
    if (chunk.searchStatus) {
      actionTracker.trackAction(chatId, { event: 'search.status', ...chunk.searchStatus });
    }
    if (chunk.conversationTitle) {
      actionTracker.trackAction(chatId, {
        event: 'conversation.title',
        title: chunk.conversationTitle
      });
    }
    const conversationId = request?._conversationId;
    if (conversationId && chunk.content?.length > 0 && !state.conversationIdEmitted) {
      actionTracker.trackAction(chatId, { event: 'conversation.id', conversationId });
      state.conversationIdEmitted = true;
    }
    if (chunk.responseMessageId) {
      conversationStateManager.updateParentId(chatId, chunk.responseMessageId);
      actionTracker.trackAction(chatId, {
        event: 'response.message.id',
        messageId: chunk.responseMessageId
      });
    }
  };

  return {
    state,
    onChunk(chunk, ctx) {
      for (const text of chunk.content || []) {
        if (!text) continue;
        state.answerOutput = true;
        actionTracker.trackChunk(chatId, { content: text });
      }
      if (Array.isArray(chunk.images) && chunk.images.length > 0) {
        state.answerOutput = true;
        for (const image of chunk.images) {
          actionTracker.trackImage(chatId, {
            mimeType: image.mimeType,
            data: image.data,
            thoughtSignature: image.thoughtSignature
          });
        }
      }
      for (const thought of chunk.thinking || []) {
        actionTracker.trackThinking(
          chatId,
          typeof thought === 'object' ? thought : { content: thought }
        );
      }
      if (chunk.groundingMetadata) {
        actionTracker.trackAction(chatId, {
          event: 'grounding',
          metadata: chunk.groundingMetadata
        });
      }
      emitConversationEvents(chunk, ctx.stream?.meta?.request, ctx);
    }
  };
}
