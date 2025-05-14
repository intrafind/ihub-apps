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
  
  // Use a ref to store a copy of messages for read-only operations
  const messagesRef = useRef(messages);
  
  // Update the ref whenever state changes
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Save messages to sessionStorage whenever they change
  useEffect(() => {
    try {
      // Only save if we have messages
      if (messages.length > 0) {
        sessionStorage.setItem(storageKey, JSON.stringify(messages));
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
    const id = `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const userMessage = {
      id,
      role: 'user',
      content,
      ...metadata
    };
    
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
        loading: true,
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
  const updateAssistantMessage = useCallback((id, content, isLoading = true) => {
    setMessages(prev => 
      prev.map(msg => 
        msg.id === id
          ? { 
              ...msg, 
              content, 
              loading: isLoading,
              _timestamp: Date.now(), // Add timestamp to force new object reference
              _contentLength: content.length // Track content length to ensure React detects changes
            }
          : msg
      )
    );
  }, []);

  /**
   * Set an error on a message
   * @param {string} id - The ID of the message to update
   * @param {string} errorMessage - The error message
   */
  const setMessageError = useCallback((id, errorMessage) => {
    setMessages(prev => 
      prev.map(msg => 
        msg.id === id
          ? { ...msg, content: `Error: ${errorMessage}`, loading: false, error: true }
          : msg
      )
    );
  }, []);

  /**
   * Delete a message and all subsequent messages
   * @param {string} messageId - The ID of the message to delete
   */
  const deleteMessage = useCallback((messageId) => {
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
          ? { ...message, content: newContent } 
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
   * Get messages formatted for API requests
   * @param {boolean} includeFull - Whether to include the entire message history
   * @param {Object} additionalMessage - An additional message to include
   * @returns {Array} Messages formatted for API consumption
   */
  const getMessagesForApi = useCallback((includeFull = true, additionalMessage = null) => {
    // Using messagesRef instead of messages dependency
    let messagesForApi = includeFull ? [...messagesRef.current] : [];
    
    if (additionalMessage) {
      messagesForApi = [...messagesForApi, additionalMessage];
    }
    
    // Strip UI-specific properties that the API doesn't need
    return messagesForApi.map(msg => {
      const { id, loading, error, isErrorMessage, ...apiMsg } = msg;
      return apiMsg;
    });
  }, []); // No dependency on messages anymore

  return {
    messages,
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