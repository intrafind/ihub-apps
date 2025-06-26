import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import useChatMessages from './useChatMessages';
import useEventSource from './useEventSource';
import { sendAppChatMessage } from '../api/api';

/**
 * High level hook combining chat message management with streaming
 * communication for both chat and canvas pages.
 */
function useAppChat({ appId, chatId: initialChatId }) {
  const { t } = useTranslation();
  const chatIdRef = useRef(initialChatId || `chat-${Date.now()}`);
  const [processing, setProcessing] = useState(false);

  const {
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
    getMessagesForApi,
  } = useChatMessages(chatIdRef.current);

  // Use refs to store the latest callback functions to avoid recreating EventSource
  const callbacksRef = useRef({});
  
  // Update callbacks ref
  callbacksRef.current = {
    onChunk: (fullContent) => {
      if (window.lastMessageId) {
        updateAssistantMessage(window.lastMessageId, fullContent, true);
      }
    },
    onDone: (finalContent, info) => {
      console.log('✅ Message completed:', { contentLength: finalContent?.length || 0, finishReason: info.finishReason, messageId: window.lastMessageId });
      if (window.lastMessageId) {
        updateAssistantMessage(window.lastMessageId, finalContent, false, {
          finishReason: info.finishReason,
        });
      } else {
        console.warn('❌ No lastMessageId found in onDone callback');
      }
      setProcessing(false);
    },
    onError: (error) => {
      if (window.lastMessageId) {
        setMessageError(window.lastMessageId, error.message);
      }
      setProcessing(false);
    },
    onConnected: async () => {
      try {
        if (window.pendingMessageData) {
          const { appId, chatId, messages, params } = window.pendingMessageData;
          await sendAppChatMessage(appId, chatId, messages, params);
          window.pendingMessageData = null;
        }
      } catch (error) {
        if (window.lastMessageId) {
          setMessageError(
            window.lastMessageId,
            t(
              'error.failedToGenerateResponse',
              'Error: Failed to generate response. Please try again or select a different model.'
            )
          );
        }
        // Use the cleanup function from the hook
        cleanupEventSourceRef.current?.();
        setProcessing(false);
      }
    }
  };

  // Create stable callback wrappers that call the ref functions
  const stableOnChunk = useCallback((fullContent) => {
    callbacksRef.current.onChunk(fullContent);
  }, []);
  
  const stableOnDone = useCallback((finalContent, info) => {
    callbacksRef.current.onDone(finalContent, info);
  }, []);
  
  const stableOnError = useCallback((error) => {
    callbacksRef.current.onError(error);
  }, []);
  
  const stableOnConnected = useCallback(async () => {
    await callbacksRef.current.onConnected();
  }, []);

  const cleanupEventSourceRef = useRef();

  const { initEventSource, cleanupEventSource } = useEventSource({
    appId,
    chatId: chatIdRef.current,
    onChunk: stableOnChunk,
    onDone: stableOnDone,
    onError: stableOnError,
    onConnected: stableOnConnected,
    onProcessingChange: setProcessing,
  });

  // Store cleanup function in ref for access in callbacks
  cleanupEventSourceRef.current = cleanupEventSource;

  /**
   * Send a chat message and start streaming the response.
   *
   * @param {Object} displayMessage - Message shown in the UI
   * @param {Object} apiMessage - Message payload for the API
   * @param {Object} params - Parameters for the request (model, style ...)
   * @param {boolean} sendChatHistory - Include full chat history in request
   */
  const sendMessage = useCallback(
    ({ displayMessage, apiMessage, params, sendChatHistory = true }) => {
      try {
        cleanupEventSource();
        setProcessing(true);
        const exchangeId = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        window.lastMessageId = exchangeId;

        addUserMessage(displayMessage.content || displayMessage, displayMessage.meta || {});
        addAssistantMessage(exchangeId);

        const messagesForAPI = getMessagesForApi(sendChatHistory, {
          role: 'user',
          content: apiMessage.content,
          promptTemplate: apiMessage.promptTemplate || null,
          variables: apiMessage.variables || {},
          messageId: exchangeId,
          imageData: apiMessage.imageData,
          fileData: apiMessage.fileData,
        });

        window.pendingMessageData = {
          appId,
          chatId: chatIdRef.current,
          messages: messagesForAPI,
          params,
        };

        initEventSource(`/api/apps/${appId}/chat/${chatIdRef.current}`);
      } catch (err) {
        console.error('Error sending message:', err);
        addSystemMessage(
          `Error: ${t('error.sendMessageFailed', 'Failed to send message.')} ${
            err.message || t('error.tryAgain', 'Please try again.')
          }`,
          true
        );
        setProcessing(false);
      }
    },
    [cleanupEventSource, addUserMessage, addAssistantMessage, getMessagesForApi, initEventSource, addSystemMessage, t, appId]
  );

  /**
   * Prepare content for resending a previous message.
   * Returns the text that should be put in the input field.
   */
  const resendMessage = useCallback(
    (messageId, editedContent) => {
      const messageToResend = messages.find((m) => m.id === messageId);
      if (!messageToResend) return '';

      let contentToResend = editedContent;

      if (messageToResend.role === 'assistant') {
        const idx = messages.findIndex((m) => m.id === messageId);
        const prevUser = [...messages.slice(0, idx)]
          .reverse()
          .find((m) => m.role === 'user');
        if (!prevUser) return '';
        contentToResend = prevUser.rawContent || prevUser.content;
        deleteMessage(prevUser.id);
      } else {
        deleteMessage(messageId);
        if (contentToResend === undefined) {
          contentToResend = messageToResend.rawContent || messageToResend.content;
        }
      }

      return contentToResend;
    },
    [messages, deleteMessage]
  );

  const cancelGeneration = useCallback(() => {
    cleanupEventSource();
    if (window.lastMessageId) {
      const currentMessage = messagesRef.current.find((m) => m.id === window.lastMessageId);
      updateAssistantMessage(
        window.lastMessageId,
        (currentMessage?.content || '') + t('message.generationCancelled', ' [Generation cancelled]'),
        false
      );
    }
    setProcessing(false);
  }, [cleanupEventSource, updateAssistantMessage, t]);

  return {
    chatId: chatIdRef.current,
    messages,
    processing,
    sendMessage,
    resendMessage,
    deleteMessage,
    editMessage,
    clearMessages,
    cancelGeneration,
    addSystemMessage,
  };
}

export default useAppChat;
