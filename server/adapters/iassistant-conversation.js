/**
 * iAssistant Conversation API adapter for iHub Apps
 * Handles multi-turn conversations with SSE streaming via the iFinder Conversation API.
 * Uses JWT authentication and conversation state management for message threading.
 *
 * Provider name: "iassistant-conversation"
 */
import { BaseAdapter } from './BaseAdapter.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import conversationApiService from '../services/integrations/ConversationApiService.js';
import conversationStateManager from '../services/integrations/ConversationStateManager.js';
import iAssistantService from '../services/integrations/iAssistantService.js';
import logger from '../utils/logger.js';

class IAssistantConversationAdapterClass extends BaseAdapter {
  /**
   * Use the line-delimited SSE parser from BaseAdapter.
   * The conversation API emits multi-event blocks separated by `\n\n` and
   * expects whole-block interpretation in processResponseBuffer.
   */
  async *parseResponseStream(response) {
    yield* this.parseLineDelimitedSseStream(response);
  }

  /**
   * Format messages for the conversation API.
   * The conversation API handles history via parent_id, so we only extract the last user message.
   */
  formatMessages(messages) {
    const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');
    if (!lastUserMessage) {
      throw new Error('No user message found for iAssistant conversation query');
    }
    return lastUserMessage.content;
  }

  /**
   * Resolve effective configuration from app config, model config, and service defaults.
   */
  resolveConfig(model, options) {
    const appConfig = options.appConfig?.iassistant || {};
    const modelConfig = model.config || {};
    const serviceConfig = iAssistantService.getConfig();

    return {
      baseUrl: appConfig.baseUrl || modelConfig.baseUrl || serviceConfig.baseUrl,
      profileId: appConfig.profileId || modelConfig.profileId || serviceConfig.defaultProfileId,
      searchProfile:
        appConfig.searchProfile ||
        modelConfig.searchProfile ||
        serviceConfig.defaultSearchProfile ||
        'searchprofile-standard',
      filter: appConfig.filter || modelConfig.filter || serviceConfig.defaultFilter,
      tools: appConfig.tools || modelConfig.tools || [],
      scope: appConfig.scope || modelConfig.scope,
      labels: appConfig.labels || modelConfig.labels,
      ephemeral: appConfig.ephemeral ?? modelConfig.ephemeral ?? false,
      extraContext: appConfig.extraContext || modelConfig.extraContext,
      systemPromptPreamble: appConfig.systemPromptPreamble || modelConfig.systemPromptPreamble
    };
  }

  /**
   * Create a completion request for the conversation API.
   * This is async because it may need to create a conversation lazily.
   *
   * @param {Object} model - Model configuration
   * @param {Array} messages - Messages array
   * @param {string} apiKey - Not used (JWT auth)
   * @param {Object} options - { user, chatId, appConfig, ... }
   * @returns {Promise<Object>} Request object { url, method, headers, body }
   */
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const content = this.formatMessages(messages);
    const { user, chatId } = options;

    if (!user || user.id === 'anonymous') {
      throw new Error('iAssistant Conversation requires authenticated user access');
    }

    const config = this.resolveConfig(model, options);
    let state = conversationStateManager.getState(chatId);

    // Lazy conversation creation: create on first message if no conversation exists
    if (!state?.conversationId) {
      logger.info('Creating new conversation', {
        component: 'IAssistantConversationAdapter',
        chatId,
        profileId: config.profileId
      });

      // Build labels array - include "ihub" and app ID
      const labels = ['ihub'];
      if (options.appConfig?.id) {
        labels.push(options.appConfig.id);
      }
      // Add any additional labels from config
      if (config.labels) {
        if (Array.isArray(config.labels)) {
          labels.push(...config.labels);
        } else if (typeof config.labels === 'string') {
          labels.push(config.labels);
        }
      }

      const createParams = {
        user,
        baseUrl: config.baseUrl,
        searchProfile: config.searchProfile,
        labels,
        ephemeral: config.ephemeral
      };

      // Support document-scoped conversations
      const documentIds = options.appConfig?.documentIds;
      if (documentIds && documentIds.length > 0) {
        createParams.retrievalScope = { document_ids: documentIds };
      }

      // Add response_generation options if configured
      if (config.extraContext || config.systemPromptPreamble) {
        createParams.responseGeneration = {};
        if (config.extraContext) {
          createParams.responseGeneration.extra_context = config.extraContext;
        }
        if (config.systemPromptPreamble) {
          createParams.responseGeneration.system_prompt_preamble = config.systemPromptPreamble;
        }
      }

      const conversation = await conversationApiService.createConversation(createParams);

      state = {
        conversationId: conversation.id,
        lastParentId: null,
        title: conversation.title || null,
        baseUrl: config.baseUrl,
        profileId: config.profileId
      };
      conversationStateManager.setState(chatId, state);

      logger.info('Conversation created', {
        component: 'IAssistantConversationAdapter',
        chatId,
        conversationId: conversation.id
      });
    }

    // Build the message send request — conversation API expects plain-text profileId
    const profileId = config.profileId;
    const authHeader = getIFinderAuthorizationHeader(user, { scope: config.scope });

    const url = `${config.baseUrl.replace(/\/+$/, '')}/public-api/rag/api/v0/conversations/${state.conversationId}/messages`;

    const message = { content };
    if (profileId) message.profile_id = profileId;
    if (config.tools && config.tools.length > 0) message.tools = config.tools;

    const body = { message };
    if (state.lastParentId) body.parent_id = state.lastParentId;

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: authHeader,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    };

    return {
      url,
      method: 'POST',
      headers,
      body, // StreamingHandler will JSON.stringify
      // Attach metadata for StreamingHandler to use
      _conversationId: state.conversationId,
      _chatId: chatId,
      _searchProfile: config.searchProfile
    };
  }

  /**
   * Process conversation API SSE events from buffer.
   * The conversation API uses a different SSE format than the legacy iAssistant API.
   *
   * Events:
   *   answer           -> content delta
   *   references       -> citations.references[]
   *   result_items     -> citations.resultItems[]
   *   status           -> searchStatus
   *   ifinder_search_started/finished -> searchStatus
   *   response_message_id -> responseMessageId (for parent_id chaining)
   *   request_message_id  -> requestMessageId
   *   conversation_title  -> conversationTitle
   *   error            -> error handling
   *   done             -> completion
   */
  processResponseBuffer(buffer) {
    const result = {
      content: [],
      complete: false,
      finishReason: null,
      citations: null,
      searchStatus: null,
      responseMessageId: null,
      requestMessageId: null,
      conversationTitle: null,
      conversationId: null,
      thinking: [],
      tool_calls: []
    };

    if (!buffer || typeof buffer !== 'string') {
      return result;
    }

    const lines = buffer.split('\n');
    let currentEvent = null;
    let currentData = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('event:')) {
        if (currentEvent && currentData) {
          this.processEvent(currentEvent, currentData, result);
        }
        currentEvent = trimmedLine.substring(6).trim().toLowerCase();
        currentData = '';
      } else if (trimmedLine.startsWith('data:')) {
        currentData += trimmedLine.substring(5).trim();
      } else if (trimmedLine.startsWith('id:')) {
        // SSE ID - skip
        continue;
      } else if (trimmedLine === '') {
        if (currentEvent && currentData) {
          this.processEvent(currentEvent, currentData, result);
          currentEvent = null;
          currentData = '';
        }
      }
    }

    // Process final event if buffer doesn't end with empty line
    if (currentEvent && currentData) {
      this.processEvent(currentEvent, currentData, result);
    }

    return result;
  }

  /**
   * Process individual conversation API SSE event
   */
  processEvent(eventType, data, result) {
    try {
      switch (eventType) {
        case 'answer': {
          const parsed = this.safeJsonParse(data);
          if (parsed.delta) {
            result.content.push(parsed.delta);
          } else if (parsed.answer) {
            result.content.push(parsed.answer);
          } else if (typeof parsed === 'string') {
            result.content.push(parsed);
          }
          break;
        }

        case 'references': {
          const parsed = this.safeJsonParse(data);
          if (!result.citations) result.citations = {};
          if (parsed.references && Array.isArray(parsed.references)) {
            result.citations.references = parsed.references;
          } else if (Array.isArray(parsed)) {
            result.citations.references = parsed;
          }
          break;
        }

        case 'result_items': {
          const parsed = this.safeJsonParse(data);
          if (!result.citations) result.citations = {};
          if (parsed.result_items && Array.isArray(parsed.result_items)) {
            result.citations.resultItems = parsed.result_items;
          } else if (Array.isArray(parsed)) {
            result.citations.resultItems = parsed;
          }
          break;
        }

        case 'status': {
          const parsed = this.safeJsonParse(data);
          const name = parsed.name || '';

          // All status steps flow into the thinking chain
          if (parsed.message) {
            result.thinking.push(name ? { name, content: parsed.message } : parsed.message);
          }

          // Forward ALL status events to drive the SearchStatusIndicator
          // (previously only search-related events were forwarded)
          if (name) {
            const event = name.startsWith('search')
              ? name.includes('started') || name.includes('initializing')
                ? 'search.started'
                : name.includes('complete') || name.includes('finished')
                  ? 'search.finished'
                  : name
              : name; // Non-search events: use raw name (e.g. "assess.started")

            result.searchStatus = {
              event,
              ...parsed,
              ...(parsed.queries && { queries: parsed.queries }),
              ...(parsed.query && { queries: [parsed.query] })
            };
          }
          break;
        }

        case 'ifinder_search_started': {
          result.searchStatus = { event: 'search.started' };
          break;
        }

        case 'ifinder_search_finished': {
          result.searchStatus = { event: 'search.finished' };
          break;
        }

        case 'response_message_id': {
          const parsed = this.safeJsonParse(data, data);
          result.responseMessageId =
            parsed.id || parsed.message_id || (typeof parsed === 'string' ? parsed : null);
          break;
        }

        case 'request_message_id': {
          const parsed = this.safeJsonParse(data, data);
          result.requestMessageId =
            parsed.id || parsed.message_id || (typeof parsed === 'string' ? parsed : null);
          break;
        }

        case 'conversation_title': {
          const parsed = this.safeJsonParse(data, data);
          result.conversationTitle = parsed.title || (typeof parsed === 'string' ? parsed : null);
          break;
        }

        case 'error': {
          const parsed = this.safeJsonParse(data);
          const errorType = parsed.type || 'TECHNICAL';
          logger.error('Error event received', {
            component: 'IAssistantConversationAdapter',
            errorType,
            parsed
          });

          if (errorType === 'REFUSAL') {
            result.content.push(parsed.message || 'The request was refused by the system.');
            result.complete = true;
            result.finishReason = 'stop';
          } else {
            result.error = true;
            result.errorMessage = parsed.message || `Conversation API error: ${errorType}`;
            result.finishReason = 'error';
          }
          break;
        }

        case 'done':
        case 'end':
        case 'complete': {
          result.complete = true;
          result.finishReason = 'stop';
          break;
        }

        // Legacy iAssistant events for backward compatibility
        case 'passages': {
          const parsed = this.safeJsonParse(data);
          if (!result.citations) result.citations = {};
          const passages = parsed.passages || (Array.isArray(parsed) ? parsed : []);
          if (passages.length > 0) {
            result.citations.references = passages;
          }
          break;
        }

        case 'telemetry': {
          // Telemetry events - log but don't expose to client
          break;
        }

        case 'thinking':
        case 'reasoning': {
          const parsed = this.safeJsonParse(data);
          const content =
            parsed.content || parsed.text || (typeof parsed === 'string' ? parsed : null);
          if (content) {
            result.thinking.push(content);
          }
          break;
        }

        default: {
          // Log unhandled events for diagnostics
          logger.debug('Unhandled event', {
            component: 'IAssistantConversationAdapter',
            eventType,
            dataPreview: data.substring(0, 200)
          });
          // Check if the data itself contains completion info
          try {
            const parsed = JSON.parse(data);
            if (
              parsed.eventType === 'complete' ||
              parsed.eventType === 'done' ||
              parsed.eventType === 'end'
            ) {
              result.complete = true;
              result.finishReason = 'stop';
            }
          } catch {
            // Ignore parsing errors for unknown event types
          }
          break;
        }
      }
    } catch (error) {
      logger.error('Error processing event', {
        component: 'IAssistantConversationAdapter',
        eventType,
        error
      });
    }
  }

  /**
   * Get model information
   */
  getModelInfo() {
    return {
      provider: 'iassistant-conversation',
      supportsStreaming: true,
      supportsImages: false,
      supportsTools: false,
      maxTokens: null,
      contextWindow: null
    };
  }
}

const IAssistantConversationAdapter = new IAssistantConversationAdapterClass();
export default IAssistantConversationAdapter;
