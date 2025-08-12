import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Custom hook for managing chat messages
 * Messages will persist during page refreshes using sessionStorage
 * Each new browser tab will start with a new chat session
 *
 * @param {string} chatId - The ID of the current chat for storage purposes
 * @returns {Object} Chat message management functions and state
 */
function useChatMessages(chatId = 'default') {
  // Use sessionStorage for persistence during page refreshes
  const storageKey = `ai_hub_chat_messages_${chatId}`;

  // Track the previous chatId to detect changes
  const prevChatIdRef = useRef(chatId);

  // Initialize state from sessionStorage if available
  const loadInitialMessages = () => {
    try {
      const storedMessages = sessionStorage.getItem(storageKey);
      return storedMessages ? JSON.parse(storedMessages) : [];
    } catch (error) {
      console.error('Error loading messages from sessionStorage:', error);
      return [];
    }
  };

  const [messages, setMessages] = useState(loadInitialMessages);

  // Load messages when chatId changes (app switching)
  useEffect(() => {
    if (prevChatIdRef.current !== chatId && prevChatIdRef.current !== null) {
      console.log(
        '[useChatMessages] ChatId changed from',
        prevChatIdRef.current,
        'to',
        chatId,
        '- loading messages for new chat'
      );
      // Load messages for the new chatId
      const newStorageKey = `ai_hub_chat_messages_${chatId}`;
      try {
        const storedMessages = sessionStorage.getItem(newStorageKey);
        const newMessages = storedMessages ? JSON.parse(storedMessages) : [];
        setMessages(newMessages);
      } catch (error) {
        console.error('Error loading messages from sessionStorage for new chatId:', error);
        setMessages([]);
      }
    }
    prevChatIdRef.current = chatId;
  }, [chatId]);

  // Use a ref to store a copy of messages for read-only operations
  const messagesRef = useRef(messages);

  // Update the ref whenever state changes
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Save messages to sessionStorage whenever they change (exclude greeting messages)
  useEffect(() => {
    try {
      // Filter out greeting messages for persistence
      const persistableMessages = messages.filter(msg => !msg.isGreeting);

      // Only save if we have messages
      if (persistableMessages.length > 0) {
        sessionStorage.setItem(storageKey, JSON.stringify(persistableMessages));
      } else {
        // Clear storage if messages are empty
        sessionStorage.removeItem(storageKey);
      }
    } catch (error) {
      console.error('Error saving messages to sessionStorage:', error);
    }
  }, [messages, storageKey]);

  /**
   * Add a user message to the chat
   * @param {string} content - The content of the message
   * @param {Object} metadata - Additional metadata for the message
   * @returns {string} The ID of the created message
   */
  const addUserMessage = useCallback((content, metadata = {}) => {
    const { rawContent, imageData, fileData, ...rest } = metadata;
    const id = `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const userMessage = {
      id,
      role: 'user',
      content,
      imageData, // Add this
      fileData, // Add this
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
      console.log('✅ Setting message to completed state:', {
        id,
        contentLength: content?.length || 0
      });
    }

    setMessages(prev => {
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

      return updatedMessages;
    });
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
                preserveContent && msg.content
                  ? `${msg.content}\n\n_${errorMessage}_`
                  : `_${errorMessage}_`,
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
   * Get messages formatted for API requests (excludes greeting messages)
   * @param {boolean} includeFull - Whether to include the entire message history
   * @param {Object} additionalMessage - An additional message to include
   * @returns {Array} Messages formatted for API consumption
   */
  const getMessagesForApi = useCallback((includeFull = true, additionalMessage = null) => {
    // Using messagesRef instead of messages dependency
    // Filter out greeting messages for API requests
    let messagesForApi = includeFull ? messagesRef.current.filter(msg => !msg.isGreeting) : [];

    if (additionalMessage) {
      messagesForApi = [...messagesForApi, additionalMessage];
    }

    // Strip UI-specific properties that the API doesn't need
    return messagesForApi.map(msg => {
      const { rawContent, ...apiMsg } = msg;
      const content = rawContent !== undefined ? rawContent : apiMsg.content;
      return { ...apiMsg, content };
    });
  }, []); // No dependency on messages anymore

  return {
    messages,
    messagesRef,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    setMessageError,
    deleteMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi
  };
}

export default useChatMessages;
