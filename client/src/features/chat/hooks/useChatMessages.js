import { useState, useCallback, useRef, useEffect } from 'react';
import { debugLog } from '../../../utils/debugLog';

/**
 * One message of a stored chat transcript, as the chat UI renders it.
 *
 * Shape on the wire (`GET /api/chats/:chatId` → `messages[]`):
 * `{ id, role, content, ts, runId, clientMessageId?, usage?, finishReason?,
 * error?, attachments? }`.
 *
 * The stored id is adopted as the message id and kept a second time on
 * `serverId`: `replaceFromMessageId` addresses the server's history by that
 * id, and a locally minted `user-<ts>-<rand>` means nothing to the store.
 *
 * @param {Object} msg - Stored message.
 * @returns {Object} Chat message.
 */
function transformStoredMessage(msg) {
  const message = {
    id: msg.id,
    serverId: msg.id,
    role: msg.role === 'user' || msg.role === 'system' ? msg.role : 'assistant',
    content: typeof msg.content === 'string' ? msg.content : '',
    loading: false,
    fromServer: true
  };

  if (msg.ts) message.ts = msg.ts;
  if (msg.runId) message.runId = msg.runId;
  if (msg.usage) message.usage = msg.usage;
  if (msg.finishReason) message.finishReason = msg.finishReason;
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    message.attachments = msg.attachments;
  }
  if (msg.error) {
    // A stopped turn kept whatever it had already produced — that is a
    // cancelled message, not a failed one. `error` is only ever read as a
    // strict boolean (`ChatMessage.jsx`), so the stored `{ code, message }`
    // must not be handed through as-is.
    if (msg.error.code === 'ABORTED') message.cancelled = true;
    else message.error = true;
  }

  return message;
}

/**
 * One message of an iAssistant conversation, as the chat UI renders it.
 * Shape on the wire: `{ id?, type: 'USER'|'ERROR'|…, content, references?,
 * result_items? }`.
 *
 * @param {Object} msg - Conversation message.
 * @returns {Object} Chat message.
 */
function transformConversationMessage(msg) {
  const message = {
    id: msg.id || `server-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    role: msg.type === 'USER' ? 'user' : msg.type === 'ERROR' ? 'system' : 'assistant',
    content: msg.content || '',
    loading: false,
    fromServer: true
  };

  // Map citations
  if (msg.references || msg.result_items) {
    message.citations = {
      references: msg.references || [],
      resultItems: msg.result_items || []
    };
  }

  if (msg.type === 'ERROR') {
    message.error = true;
    message.isErrorMessage = true;
  }

  return message;
}

/**
 * Custom hook for managing chat messages
 * Messages will persist during page refreshes using sessionStorage
 * Each new browser tab will start with a new chat session
 *
 * Three modes, and only one of them owns the transcript:
 *   - **normal** — sessionStorage is the source of truth (the original behaviour)
 *   - **ephemeral** — nothing is stored anywhere
 *   - **server-backed** — the durable chat store is the source of truth: the
 *     transcript arrives by hydration, the browser copy is skipped entirely
 *     and a request carries only the new message, because a persisted chat
 *     rejects a longer array with `CLIENT_HISTORY_NOT_ALLOWED`.
 *
 * Anything that is not server-backed keeps the browser behaviour unchanged.
 *
 * @param {string} chatId - The ID of the current chat for storage purposes
 * @param {Object} [options] - Additional options
 * @param {boolean} [options.ephemeral] - When true, messages are never persisted to
 *   sessionStorage and are reset to empty whenever the chatId changes.
 * @param {boolean} [options.serverBacked] - When true, the chat is stored on the
 *   server: skip the sessionStorage copy, expose a `hydrating` state while the
 *   stored transcript is being fetched, and send only the new message to the API.
 * @returns {Object} Chat message management functions and state
 */
function useChatMessages(chatId = 'default', { ephemeral = false, serverBacked = false } = {}) {
  // Use sessionStorage for persistence during page refreshes
  const storageKey = `ai_hub_chat_messages_${chatId}`;

  // The browser copy exists only for the mode that has no other home for the
  // transcript. Ephemeral wants no copy at all; server-backed has the store.
  const browserPersisted = !ephemeral && !serverBacked;

  // Track the previous chatId to detect changes
  const prevChatIdRef = useRef(chatId);

  // Initialize state from sessionStorage if available
  const loadInitialMessages = () => {
    if (!browserPersisted) return [];
    try {
      const storedData = sessionStorage.getItem(storageKey);
      debugLog(
        '📂 Loading messages from sessionStorage for key',
        storageKey,
        ':',
        storedData ? `${storedData.length} bytes` : 'null'
      );

      const stored = storedData ? JSON.parse(storedData) : [];
      // No message can legitimately still be streaming across a page load —
      // normalize stale loading flags (e.g. a transcription or LLM stream that
      // was interrupted by the reload) so nothing spins forever.
      const messages = stored.map(m => (m?.loading ? { ...m, loading: false } : m));

      // Debug logging for loaded images
      const messagesWithImages = messages.filter(m => m.images && m.images.length > 0);
      if (messagesWithImages.length > 0) {
        debugLog('📂 Loading messages from sessionStorage:', {
          totalMessages: messages.length,
          messagesWithImages: messagesWithImages.length,
          imageDetails: messagesWithImages.map(m => ({
            id: m.id,
            imageCount: m.images.length,
            loading: m.loading,
            hasImageData: m.images.every(img => img.data && img.data.length > 100)
          }))
        });
      } else if (messages.length > 0) {
        debugLog('📂 Loading messages (no images):', {
          totalMessages: messages.length,
          messageIds: messages.map(m => ({ id: m.id, role: m.role, loading: m.loading }))
        });
      }

      return messages;
    } catch (error) {
      console.error('Error loading messages from sessionStorage:', error);
      return [];
    }
  };

  const [messages, setMessages] = useState(loadInitialMessages);

  // True while a server-backed transcript is still on its way. Callers need it
  // to hold back the greeting: an empty `messages` is indistinguishable from
  // "not fetched yet", so an async hydrate otherwise flashes the empty state
  // and the starter prompts for a paint before the history lands.
  // Derived rather than mirrored, so leaving server-backed mode — incognito
  // switched on, the capability gone — can never strand the surface in a
  // loading state. The messages already on screen stay put in that case:
  // flipping incognito mid-chat has always kept the visible conversation and
  // only stopped persisting it.
  const [hydrated, setHydrated] = useState(!serverBacked);

  // The mode can change after the first render: the persistence capability
  // rides on the platform config, which resolves asynchronously.
  const prevServerBackedRef = useRef(serverBacked);

  // The two effects below reset `hydrated` — but an effect runs *after* the
  // render that triggered it has painted, so on the frame a chat becomes
  // server-backed (or switches to another chat) `hydrated` is still the
  // previous mode's value and the surface renders one settled, empty
  // transcript. That single frame is the greeting flash hydration exists to
  // prevent, so both transitions are read straight from the refs here, in
  // render, where they are already visible. The refs still hold the previous
  // values until those effects run.
  const becomingServerBacked = serverBacked && !prevServerBackedRef.current;
  const switchingChat = prevChatIdRef.current !== chatId;
  const hydrating = serverBacked && (!hydrated || becomingServerBacked || switchingChat);

  useEffect(() => {
    const wasServerBacked = prevServerBackedRef.current;
    prevServerBackedRef.current = serverBacked;
    if (serverBacked && !wasServerBacked) {
      // Becoming server-backed hands the transcript to the store. Whatever
      // the sessionStorage initializer loaded before the capability resolved
      // is a stale shadow of it, and would otherwise sit above the hydrated
      // history as a second copy.
      setMessages([]);
      setHydrated(false);
    }
  }, [serverBacked]);

  /**
   * Mark hydration finished without replacing anything: the chat has no stored
   * transcript yet, or the fetch failed and the caller has already reported it.
   */
  const finishHydration = useCallback(() => {
    setHydrated(true);
  }, []);

  // Load messages when chatId changes (app switching)
  useEffect(() => {
    if (prevChatIdRef.current !== chatId && prevChatIdRef.current !== null) {
      debugLog(
        '[useChatMessages] ChatId changed from',
        prevChatIdRef.current,
        'to',
        chatId,
        '- loading messages for new chat'
      );
      if (!browserPersisted) {
        setMessages([]);
        // A different chat means a different stored transcript to fetch.
        setHydrated(false);
        prevChatIdRef.current = chatId;
        return;
      }
      // Load messages for the new chatId
      const newStorageKey = `ai_hub_chat_messages_${chatId}`;
      try {
        const storedMessages = sessionStorage.getItem(newStorageKey);
        const newMessages = storedMessages ? JSON.parse(storedMessages) : [];

        // Debug logging for loaded images on chatId change
        const messagesWithImages = newMessages.filter(m => m.images && m.images.length > 0);
        if (messagesWithImages.length > 0) {
          debugLog('📂 Loading messages for new chatId:', {
            chatId,
            totalMessages: newMessages.length,
            messagesWithImages: messagesWithImages.length,
            imageDetails: messagesWithImages.map(m => ({
              id: m.id,
              imageCount: m.images.length,
              loading: m.loading
            }))
          });
        }

        setMessages(newMessages);
      } catch (error) {
        console.error('Error loading messages from sessionStorage for new chatId:', error);
        setMessages([]);
      }
    }
    prevChatIdRef.current = chatId;
  }, [chatId, browserPersisted, serverBacked]);

  // Use a ref to store a copy of messages for read-only operations
  const messagesRef = useRef(messages);

  // Update the ref whenever state changes
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Save messages to sessionStorage whenever they change (exclude greeting messages)
  useEffect(() => {
    if (ephemeral) {
      // Ephemeral chats are never persisted; clear any stray data.
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
      return;
    }
    if (serverBacked) {
      // The chat store is the source of truth. A copy written here would go
      // stale the moment another tab — or a run that outlived this one —
      // appended a turn, and hydration would then be racing it. A key left
      // over from before the chat became server-backed is deliberately left
      // alone: `WorkflowExecutionPage` seeds one directly to hand a workflow
      // result into a chat, and deleting other people's data is not this
      // effect's job.
      return;
    }
    try {
      // Filter out greeting messages for persistence
      const persistableMessages = messages.filter(msg => !msg.isGreeting);

      // Strip image data to avoid sessionStorage quota issues
      // Images can be very large (base64 encoded) and exceed the ~5-10MB quota
      const messagesWithoutImageData = persistableMessages.map(msg => {
        if (msg.images && msg.images.length > 0) {
          // Keep metadata but remove the actual image data
          return {
            ...msg,
            images: msg.images.map(img => ({
              mimeType: img.mimeType,
              // Mark that image data was present but not persisted
              _hadImageData: true
            }))
          };
        }
        return msg;
      });

      // Debug logging for image persistence
      const messagesWithImages = persistableMessages.filter(m => m.images && m.images.length > 0);
      if (messagesWithImages.length > 0) {
        debugLog('💾 Saving messages to sessionStorage (images excluded to avoid quota issues):', {
          totalMessages: messagesWithoutImageData.length,
          messagesWithImages: messagesWithImages.length,
          imageDetails: messagesWithImages.map(m => ({
            id: m.id,
            imageCount: m.images.length,
            loading: m.loading
          }))
        });
      }

      // Only save if we have messages
      if (messagesWithoutImageData.length > 0) {
        sessionStorage.setItem(storageKey, JSON.stringify(messagesWithoutImageData));
      } else {
        // Clear storage if messages are empty
        sessionStorage.removeItem(storageKey);
      }
    } catch (error) {
      console.error('Error saving messages to sessionStorage:', error);
      // If we still get quota errors, try to save without any images at all
      if (error.name === 'QuotaExceededError') {
        console.warn(
          'SessionStorage quota exceeded even after removing images. Saving text-only messages.'
        );
        try {
          const textOnlyMessages = messages
            .filter(msg => !msg.isGreeting)
            .map(msg => {
              const { images: _images, ...rest } = msg;
              return rest;
            });
          if (textOnlyMessages.length > 0) {
            sessionStorage.setItem(storageKey, JSON.stringify(textOnlyMessages));
          }
        } catch (fallbackError) {
          console.error('Failed to save even text-only messages:', fallbackError);
        }
      }
    }
  }, [messages, storageKey, ephemeral, serverBacked]);

  /**
   * Add a user message to the chat
   * @param {string} content - The content of the message
   * @param {Object} metadata - Additional metadata for the message
   * @returns {string} The ID of the created message
   */
  const addUserMessage = useCallback((content, metadata = {}) => {
    const { rawContent, imageData, fileData, audioData, ...rest } = metadata;
    const id = `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const userMessage = {
      id,
      role: 'user',
      content,
      imageData,
      fileData,
      audioData,
      ...rest
    };

    if (rawContent !== undefined) {
      userMessage.rawContent = rawContent;
    }

    setMessages(prev => [...prev, userMessage]);
    return id;
  }, []);

  /**
   * Add a placeholder for an assistant message
   * @param {string} exchangeId - Optional ID to use for the message
   * @returns {string} The ID of the created message
   */
  const addAssistantMessage = useCallback((exchangeId = null) => {
    const id = exchangeId || `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    setMessages(prev => [
      ...prev,
      {
        id,
        role: 'assistant',
        content: '',
        loading: true
      }
    ]);

    return id;
  }, []);

  /**
   * Update an assistant message with new content
   * @param {string} id - The ID of the message to update
   * @param {string} content - The new content
   * @param {boolean} isLoading - Whether the message is still loading
   */
  const updateAssistantMessage = useCallback((id, content, isLoading = true, extra = {}) => {
    if (isLoading === false) {
      debugLog('✅ Setting message to completed state:', {
        id,
        contentLength: content?.length || 0,
        hasImages: !!extra.images,
        imageCount: extra.images?.length || 0
      });
    }

    setMessages(prev => {
      const currentMsg = prev.find(m => m.id === id);
      const updatedMessages = prev.map(msg =>
        msg.id === id
          ? {
              ...msg,
              content,
              loading: isLoading,
              ...extra,
              _timestamp: Date.now(), // Add timestamp to force new object reference
              _contentLength: content.length // Track content length to ensure React detects changes
            }
          : msg
      );

      // Debug logging to track image persistence
      const updatedMsg = updatedMessages.find(m => m.id === id);
      if (currentMsg?.images || extra.images || updatedMsg?.images) {
        debugLog('🖼️ Image update for message', id, ':', {
          previousImages: currentMsg?.images?.length || 0,
          extraImages: extra.images?.length || 0,
          resultImages: updatedMsg?.images?.length || 0,
          isLoading
        });
      }

      return updatedMessages;
    });
  }, []);

  /**
   * Append text to an assistant message's content using a functional state
   * update, guaranteeing the suffix lands on the LATEST content even if more
   * chunks arrived between the caller's read of `messagesRef` and this write.
   * Used by cancellation so an in-flight chunk never gets overwritten by a
   * stale-snapshot-based concat.
   *
   * @param {string} id - The message id
   * @param {string} suffix - Text to append (the caller is responsible for any leading separator)
   * @param {Object} [extra] - Extra fields to merge (e.g. `loading: false`)
   */
  const appendToAssistantMessage = useCallback((id, suffix, extra = {}) => {
    setMessages(prev =>
      prev.map(msg =>
        msg.id === id
          ? {
              ...msg,
              content: (msg.content || '') + suffix,
              ...extra,
              _timestamp: Date.now(),
              _contentLength: ((msg.content || '') + suffix).length
            }
          : msg
      )
    );
  }, []);

  /**
   * Append (or update) a workflow step on a message using a functional
   * state update.
   *
   * The previous implementation read `prevSteps` from a ref and passed
   * `[...prevSteps, newStep]` into `updateAssistantMessage`. When multiple
   * step events fire within the same React render tick (e.g. an executor
   * emits ten "Skipped (already searched): …" events back-to-back), every
   * event after the first sees the same stale snapshot and overwrites the
   * prior accumulation — dropping steps silently. Moving the merge inside
   * `setMessages(prev => …)` guarantees each event reads the latest live
   * state, so no step is lost regardless of how fast they arrive.
   *
   * Semantics match the old in-line handler:
   *   - status:'running'   → mark any other running step as completed, append new
   *   - status:'completed'/'error' → if a step with the same nodeName exists,
   *                                  replace it; otherwise append.
   *
   * @param {string} id - Message id to mutate
   * @param {Object} step - The step to append/update (nodeName, status, etc.)
   * @param {Object} [extra] - Additional message fields to merge (e.g. workflowStep)
   */
  const appendWorkflowStep = useCallback((id, step, extra = {}) => {
    setMessages(prev =>
      prev.map(msg => {
        if (msg.id !== id) return msg;
        const prevSteps = msg.workflowSteps || [];
        let updatedSteps;
        if (step?.status === 'running') {
          updatedSteps = prevSteps.map(s =>
            s.status === 'running' ? { ...s, status: 'completed' } : s
          );
          updatedSteps = [...updatedSteps, step];
        } else {
          const exists = prevSteps.some(s => s.nodeName === step.nodeName);
          updatedSteps = exists
            ? prevSteps.map(s => (s.nodeName === step.nodeName ? step : s))
            : [...prevSteps, step];
        }
        return {
          ...msg,
          workflowSteps: updatedSteps,
          ...extra,
          _timestamp: Date.now()
        };
      })
    );
  }, []);

  /**
   * Set an error on a message
   * @param {string} id - The ID of the message to update
   * @param {string} errorMessage - The error message
   * @param {boolean} preserveContent - Whether to preserve existing content (default: true)
   */
  const setMessageError = useCallback((id, errorMessage, preserveContent = true) => {
    setMessages(prev =>
      prev.map(msg =>
        msg.id === id
          ? {
              ...msg,
              content:
                preserveContent && msg.content && !msg.content.includes(errorMessage)
                  ? `${msg.content}\n\n${errorMessage}`
                  : errorMessage,
              loading: false,
              error: true
            }
          : msg
      )
    );
  }, []);

  /**
   * Delete a message and all subsequent messages
   * @param {string} messageId - The ID of the message to delete
   */
  const deleteMessage = useCallback(messageId => {
    // Using messagesRef instead of messages dependency
    const messageIndex = messagesRef.current.findIndex(msg => msg.id === messageId);
    if (messageIndex !== -1) {
      const newMessages = messagesRef.current.slice(0, messageIndex);
      setMessages(newMessages);
    }
  }, []); // No dependency on messages anymore

  /**
   * Edit a message's content
   * @param {string} messageId - The ID of the message to edit
   * @param {string} newContent - The new content for the message
   */
  const editMessage = useCallback((messageId, newContent) => {
    setMessages(prev =>
      prev.map(message =>
        message.id === messageId
          ? { ...message, content: newContent, rawContent: newContent }
          : message
      )
    );
  }, []);

  /**
   * Add a system message (for errors, notifications, etc.)
   * @param {string} content - The content of the system message
   * @param {boolean} isError - Whether this is an error message
   * @returns {string} The ID of the created message
   */
  const addSystemMessage = useCallback((content, isError = false) => {
    const id = `system-${Date.now()}`;

    setMessages(prev => [
      ...prev,
      {
        id,
        role: 'system',
        content,
        error: isError,
        isErrorMessage: isError
      }
    ]);

    return id;
  }, []);

  /**
   * Clear all messages
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  /**
   * Replace the whole transcript with one loaded from the server, and end
   * hydration.
   *
   * Two shapes arrive here and both are server truth: a stored chat
   * transcript (`GET /api/chats/:chatId`) and an iAssistant conversation
   * (`GET /api/apps/:appId/conversations/:id/messages`). `role` is the
   * discriminator — the conversation shape has only ever carried `type`.
   *
   * @param {Array} serverMessages - Messages from either endpoint
   * @returns {string|null} The last assistant message ID (for parent_id chaining)
   */
  const loadServerMessages = useCallback(serverMessages => {
    setHydrated(true);
    if (!serverMessages || serverMessages.length === 0) return null;

    let lastAssistantId = null;
    const transformed = serverMessages.map(msg => {
      const message =
        typeof msg?.role === 'string'
          ? transformStoredMessage(msg)
          : transformConversationMessage(msg);

      if (message.role === 'assistant') {
        lastAssistantId = message.id;
      }

      return message;
    });

    setMessages(transformed);
    return lastAssistantId;
  }, []);

  /**
   * Get messages formatted for API requests (excludes greeting messages)
   * @param {boolean} includeFull - Whether to include the entire message history
   * @param {Object} additionalMessage - An additional message to include
   * @returns {Array} Messages formatted for API consumption
   */
  const getMessagesForApi = useCallback(
    (includeFull = true, additionalMessage = null) => {
      // A server-backed chat posts exactly one message — the new one. The
      // server reads the rest back out of the store and rejects a longer array
      // with `CLIENT_HISTORY_NOT_ALLOWED`, so a client can no longer rewrite
      // what it already said. `includeFull` is still honoured server-side:
      // an app with `sendChatHistory: false` gets only the new message there
      // too. Every other mode keeps posting its whole array.
      // Using messagesRef instead of messages dependency
      // Filter out greeting messages for API requests
      let messagesForApi =
        includeFull && !serverBacked ? messagesRef.current.filter(msg => !msg.isGreeting) : [];

      if (additionalMessage) {
        messagesForApi = [...messagesForApi, additionalMessage];
      }

      // Strip UI-specific properties that the API doesn't need
      return messagesForApi.map(msg => {
        const { rawContent, ...apiMsg } = msg;
        const content = rawContent !== undefined ? rawContent : apiMsg.content;
        return { ...apiMsg, content };
      });
    },
    [serverBacked]
  ); // No dependency on messages anymore

  /**
   * Merge citation data into a message in a race-safe way.
   * Uses functional updater so concurrent references/resultItems events
   * don't overwrite each other.
   * @param {string} messageId - The ID of the message to update
   * @param {Object} newCitations - { references?, resultItems? }
   */
  const mergeCitations = useCallback((messageId, newCitations) => {
    setMessages(prev =>
      prev.map(msg => {
        if (msg.id !== messageId) return msg;
        const existing = msg.citations || {};
        return {
          ...msg,
          citations: {
            references: newCitations.references || existing.references || [],
            resultItems: newCitations.resultItems || existing.resultItems || []
          },
          _timestamp: Date.now()
        };
      })
    );
  }, []);

  return {
    messages,
    messagesRef,
    hydrating,
    finishHydration,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    appendToAssistantMessage,
    appendWorkflowStep,
    setMessageError,
    deleteMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi,
    loadServerMessages,
    mergeCitations
  };
}

export default useChatMessages;
