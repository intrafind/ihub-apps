import { useState, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import useAppChat from './useAppChat';

/**
 * Hook for managing compare mode - allows comparing two model responses side-by-side
 * @param {Object} options - Configuration options
 * @param {string} options.appId - The app ID
 * @param {boolean} options.enabled - Whether compare mode is enabled
 * @param {Function} options.onMessageComplete - Callback fired when a message is completed (optional)
 * @returns {Object} Compare mode state and functions
 */
function useCompareMode({ appId, enabled, onMessageComplete }) {
  const [leftModel, setLeftModel] = useState(null);
  const [rightModel, setRightModel] = useState(null);

  // Create separate chat IDs for left and right comparisons
  const leftChatId = useRef(`compare-left-${uuidv4()}`);
  const rightChatId = useRef(`compare-right-${uuidv4()}`);

  // Left chat state
  const leftChat = useAppChat({
    appId,
    chatId: leftChatId.current,
    onMessageComplete
  });

  // Right chat state
  const rightChat = useAppChat({
    appId,
    chatId: rightChatId.current,
    onMessageComplete
  });

  /**
   * Send message to both models simultaneously
   * @param {Object} messageStructure - The complete message structure with displayMessage, apiMessage, params, etc.
   */
  const sendToCompare = useCallback(
    async messageStructure => {
      if (!enabled || !leftModel || !rightModel) {
        return { success: false, error: 'Compare mode not properly configured' };
      }

      try {
        // Send to left model with its specific model selection
        const leftParams = { ...messageStructure.params, selectedModel: leftModel };
        const leftPromise = leftChat.sendMessage({
          displayMessage: messageStructure.displayMessage,
          apiMessage: messageStructure.apiMessage,
          params: leftParams,
          sendChatHistory: messageStructure.sendChatHistory,
          messageMetadata: messageStructure.messageMetadata
        });

        // Send to right model with its specific model selection
        const rightParams = { ...messageStructure.params, selectedModel: rightModel };
        const rightPromise = rightChat.sendMessage({
          displayMessage: messageStructure.displayMessage,
          apiMessage: messageStructure.apiMessage,
          params: rightParams,
          sendChatHistory: messageStructure.sendChatHistory,
          messageMetadata: messageStructure.messageMetadata
        });

        // Wait for both to complete (they stream independently)
        await Promise.all([leftPromise, rightPromise]);

        return { success: true };
      } catch (error) {
        console.error('Error sending to compare mode:', error);
        return { success: false, error: error.message };
      }
    },
    [enabled, leftModel, rightModel, leftChat, rightChat]
  );

  /**
   * Clear both chats
   */
  const clearBothChats = useCallback(() => {
    leftChat.clearMessages();
    rightChat.clearMessages();
  }, [leftChat, rightChat]);

  /**
   * Cancel generation in both chats
   */
  const cancelBothGenerations = useCallback(() => {
    leftChat.cancelGeneration();
    rightChat.cancelGeneration();
  }, [leftChat, rightChat]);

  /**
   * Check if either chat is processing
   */
  const isProcessing = leftChat.processing || rightChat.processing;

  /**
   * Reset compare mode (regenerate chat IDs)
   */
  const resetCompareMode = useCallback(() => {
    leftChatId.current = `compare-left-${uuidv4()}`;
    rightChatId.current = `compare-right-${uuidv4()}`;
    leftChat.resetConversationState();
    rightChat.resetConversationState();
  }, [leftChat, rightChat]);

  return {
    // Model selection
    leftModel,
    rightModel,
    setLeftModel,
    setRightModel,

    // Chat states
    leftChat,
    rightChat,

    // Chat IDs for reference
    leftChatId: leftChatId.current,
    rightChatId: rightChatId.current,

    // Combined functions
    sendToCompare,
    clearBothChats,
    cancelBothGenerations,
    resetCompareMode,

    // Combined state
    isProcessing,
    hasMessages: leftChat.messages.length > 0 || rightChat.messages.length > 0
  };
}

export default useCompareMode;
