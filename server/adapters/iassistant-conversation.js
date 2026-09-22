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
import iAssistantProfileResolver from '../services/integrations/iAssistantProfileResolver.js';
import { composeExtraContext } from '../services/integrations/iAssistantGrounding.js';
import PromptService from '../services/PromptService.js';
import logger from '../utils/logger.js';

/**
 * Strings of an SSE array field, trimmed and with the empties dropped.
 * @param {*} value
 * @returns {string[]}
 */
function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(entry => String(entry ?? '').trim()).filter(Boolean);
}

/**
 * Distinct values of one metadata field across the search hits — the document
 * types ("application") or the originating systems ("sourceName") behind a
 * result set.
 *
 * iFinder publishes these under `additional_document_metadata`, with the set
 * of fields chosen per installation
 * (`intrafind.ragtime.agentic.sse.search-finished-event.fields`), and a field
 * may arrive as a single value or as an array. Comparison is
 * case-insensitive, but the first spelling seen is what is kept, so the UI
 * shows the value the way the index does.
 *
 * @param {Array} hits - `hits` from an ifinder_search_finished event
 * @param {string} field - metadata field name
 * @returns {string[]}
 */
function distinctMetadataValues(hits, field) {
  const seen = new Set();
  const values = [];
  for (const hit of hits || []) {
    const metadata = hit?.additional_document_metadata || {};
    const raw = Array.isArray(metadata[field]) ? metadata[field][0] : metadata[field];
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

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

    // extraContext / systemPromptPreamble support global prompt variables
    // ({{user_name}}, {{user_email}}, {{date}}, admin-defined custom
    // variables, …) so the conversation is personalized per requesting user
    // instead of carrying one hardcoded identity for everyone.
    let extraContext = appConfig.extraContext || modelConfig.extraContext;
    let systemPromptPreamble = appConfig.systemPromptPreamble || modelConfig.systemPromptPreamble;
    if (extraContext?.includes('{{') || systemPromptPreamble?.includes('{{')) {
      const variables = PromptService.resolveGlobalPromptVariables(
        options.user,
        model?.modelId || model?.id
      );
      extraContext = PromptService.substituteVariables(extraContext, variables);
      systemPromptPreamble = PromptService.substituteVariables(systemPromptPreamble, variables);
    }

    // Grounded-only answering is opt-in per app, falling back to the
    // installation default. `?? ` rather than `||` throughout: an app that
    // sets `false` is turning the platform default off, not leaving it unset.
    const groundedOnly =
      appConfig.groundedOnly ?? modelConfig.groundedOnly ?? serviceConfig.groundedOnly ?? false;

    return {
      baseUrl: appConfig.baseUrl || modelConfig.baseUrl || serviceConfig.baseUrl,
      profileId: appConfig.profileId || modelConfig.profileId || serviceConfig.defaultProfileId,
      // What the app/model/platform configured. The iAssistant profile gets
      // asked first at conversation-creation time and wins when it answers —
      // see resolveSearchProfile. The literal fallback that used to sit here
      // now lives once in iAssistantService.defaultSearchProfile.
      configuredSearchProfile:
        appConfig.searchProfile || modelConfig.searchProfile || serviceConfig.defaultSearchProfile,
      filter: appConfig.filter || modelConfig.filter || serviceConfig.defaultFilter,
      tools: appConfig.tools || modelConfig.tools || [],
      scope: appConfig.scope || modelConfig.scope,
      labels: appConfig.labels || modelConfig.labels,
      ephemeral:
        appConfig.ephemeral ?? options.appConfig?.ephemeral ?? modelConfig.ephemeral ?? false,
      groundedOnly,
      extraContext: composeExtraContext(extraContext, groundedOnly),
      systemPromptPreamble
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
  async createCompletionRequest(model, messages, apiKey, options = {}, { signal } = {}) {
    const content = this.formatMessages(messages);
    const { user, chatId } = options;

    if (!user || user.id === 'anonymous') {
      throw new Error('iAssistant Conversation requires authenticated user access');
    }

    const config = this.resolveConfig(model, options);
    // The durable read, not the cache-only `getState`: a chat whose first turn
    // landed on another worker (or before a restart) must thread onto the same
    // remote conversation instead of silently starting a second one.
    let state = await conversationStateManager.loadState(chatId, { ownerId: user.id });

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

      // Ask the iAssistant profile which search profile it belongs to, and
      // fall back to the configured one. Done here rather than in
      // resolveConfig because it is a network read, and because the answer is
      // only needed when a conversation is actually created: later turns read
      // it back off the state, so a profile edited mid-conversation cannot
      // silently move an existing conversation to a different corpus.
      const { searchProfile, source: searchProfileSource } =
        await iAssistantProfileResolver.resolveSearchProfile({
          profileId: config.profileId,
          configuredSearchProfile: config.configuredSearchProfile,
          user,
          baseUrl: config.baseUrl,
          signal
        });

      const createParams = {
        user,
        baseUrl: config.baseUrl,
        searchProfile,
        labels,
        ephemeral: config.ephemeral,
        signal
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
        profileId: config.profileId,
        // Pinned for the life of the conversation. The remote conversation
        // was created with this scope; later turns must report the same one
        // when they build document access links, or the links point into a
        // profile the conversation never searched.
        searchProfile: searchProfile || null,
        // Whose conversation this is. A chat id is a URL path segment, so
        // without an owner on the state a user holding someone else's id
        // would thread their turn onto that user's remote conversation.
        ownerId: user.id
      };
      conversationStateManager.setState(chatId, state);

      logger.info('Conversation created', {
        component: 'IAssistantConversationAdapter',
        chatId,
        conversationId: conversation.id,
        searchProfile: searchProfile || '(none)',
        searchProfileSource
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
      'Cache-Control': 'no-cache'
    };

    return {
      url,
      method: 'POST',
      headers,
      body, // LLMClient will JSON.stringify
      // Attach metadata for the chat channel to use
      _conversationId: state.conversationId,
      _chatId: chatId,
      // From the state, so every turn of a conversation reports the profile it
      // was created with. `configuredSearchProfile` is the fallback for state
      // written before this field existed.
      _searchProfile: state.searchProfile || config.configuredSearchProfile
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
   *   ifinder_search_started -> searchStatus (executed queries)
   *   ifinder_search_finished -> searchStatus (hit count, timing, provenance)
   *   generation_stopped -> terminal; the answered message was deleted
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
          // The payload carries the queries iFinder actually ran, split into
          // the lexical and the semantic formulation. Dropping it was why the
          // iAssistant webapp could show "searched for X, Y" and iHub could
          // not.
          const parsed = this.safeJsonParse(data);
          const lexicalQueries = toStringArray(parsed.lexical_queries);
          const semanticQueries = toStringArray(parsed.semantic_queries);
          result.searchStatus = {
            event: 'search.started',
            lexicalQueries,
            semanticQueries,
            // De-duplicated union, because the two formulations of one
            // question are usually the same string and showing it twice reads
            // like two searches.
            queries: [...new Set([...lexicalQueries, ...semanticQueries])]
          };
          break;
        }

        case 'ifinder_search_finished': {
          // `hits` are the retrieved documents with the metadata fields the
          // installation configured (intrafind.ragtime.agentic.sse
          // .search-finished-event.fields). Only the counts and the
          // provenance are kept: the documents themselves reach the client as
          // citations, and copying them here would send each one twice.
          const parsed = this.safeJsonParse(data);
          const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
          result.searchStatus = {
            event: 'search.finished',
            numberOfHits: Number.isFinite(parsed.number_of_hits)
              ? parsed.number_of_hits
              : hits.length,
            ...(Number.isFinite(parsed.time_ms) ? { timeMs: parsed.time_ms } : {}),
            applications: distinctMetadataValues(hits, 'application'),
            sources: distinctMetadataValues(hits, 'sourceName')
          };
          break;
        }

        case 'generation_stopped': {
          // Sent when the user message being answered was deleted. It is a
          // terminal event: without this case it fell through to `default`,
          // the stream never completed, and the turn hung on screen until the
          // idle ceiling fired.
          logger.info('Generation stopped by the conversation API', {
            component: 'IAssistantConversationAdapter'
          });
          result.complete = true;
          result.finishReason = 'stop';
          result.generationStopped = true;
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
