import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import useChatMessages from './useChatMessages';
import useEventSource from './useEventSource';
import { sendAppChatMessage } from '../api/api';

/**
 * High level hook combining chat message management with streaming
 * communication for both chat and canvas pages.
 * 
 * @param {Object} options - Configuration options
 * @param {string} options.appId - The app ID
 * @param {string} options.chatId - The chat session ID
 * @param {Function} options.onMessageComplete - Callback fired when a message is completed (optional)
 */
function useAppChat({ appId, chatId: initialChatId, onMessageComplete }) {
  const { t } = useTranslation();
  // Use the chatId directly instead of storing it in a ref
  // This allows the useChatMessages hook to properly react to chatId changes
  const chatId = initialChatId || `chat-${Date.now()}`;
  const [processing, setProcessing] = useState(false);

  // Refs to keep mutable values between renders without relying on window
  const lastMessageIdRef = useRef(null);
  const pendingMessageDataRef = useRef(null);
  const lastUserMessageRef = useRef(null);

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
  } = useChatMessages(chatId); // Now this will properly react to chatId changes

  // Use refs to store the latest callback functions to avoid recreating EventSource
  const callbacksRef = useRef({});
  
  // Update callbacks ref
  callbacksRef.current = {
    onChunk: (fullContent) => {
      if (lastMessageIdRef.current) {
        updateAssistantMessage(lastMessageIdRef.current, fullContent, true);
      }
    },
    onDone: (finalContent, info) => {
      console.log('✅ Message completed:', { contentLength: finalContent?.length || 0, finishReason: info.finishReason, messageId: lastMessageIdRef.current });
      if (lastMessageIdRef.current) {
        updateAssistantMessage(lastMessageIdRef.current, finalContent, false, {
          finishReason: info.finishReason,
        });

        // Trigger onMessageComplete callback if provided
        if (onMessageComplete && typeof onMessageComplete === 'function') {
          console.log('🔄 Calling onMessageComplete with:', {
            contentLength: finalContent?.length || 0,
            userMessage: lastUserMessageRef.current,
            hasCallback: !!onMessageComplete
          });
          onMessageComplete(finalContent, lastUserMessageRef.current);
        } else {
          console.log('⚠️  No onMessageComplete callback provided or not a function:', {
            hasCallback: !!onMessageComplete,
            typeOfCallback: typeof onMessageComplete
          });
        }
      } else {
        console.warn('❌ No lastMessageId found in onDone callback');
      }
      setProcessing(false);
    },
    onError: (error) => {
      if (lastMessageIdRef.current) {
        setMessageError(lastMessageIdRef.current, error.message);
      }
      setProcessing(false);
    },
    onConnected: async () => {
      try {
        if (pendingMessageDataRef.current) {
          const { appId, chatId, messages, params } = pendingMessageDataRef.current;
          await sendAppChatMessage(appId, chatId, messages, params);
          pendingMessageDataRef.current = null;
        }
      } catch (error) {
        if (lastMessageIdRef.current) {
          setMessageError(
            lastMessageIdRef.current,
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
    chatId: chatId,
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
        lastMessageIdRef.current = exchangeId;

        // Store the user message content for the onMessageComplete callback
        lastUserMessageRef.current = apiMessage.content;

        // Ensure we extract content properly and default to empty string if needed
        const contentToAdd = typeof displayMessage === 'string' 
          ? displayMessage 
          : (displayMessage?.content || '');
        
        addUserMessage(contentToAdd, displayMessage?.meta || {});
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

        pendingMessageDataRef.current = {
          appId,
          chatId: chatId,
          messages: messagesForAPI,
          params,
        };

        initEventSource(`/api/apps/${appId}/chat/${chatId}`);
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
   * Returns an object with content and variables to restore.
   */
  const resendMessage = useCallback(
    (messageId, editedContent) => {
      const messageToResend = messages.find((m) => m.id === messageId);
      if (!messageToResend) return { content: '', variables: null };

      let contentToResend = editedContent;
      let variablesToRestore = null;

      if (messageToResend.role === 'assistant') {
        const idx = messages.findIndex((m) => m.id === messageId);
        const prevUser = [...messages.slice(0, idx)]
          .reverse()
          .find((m) => m.role === 'user');
        if (!prevUser) return { content: '', variables: null };
        contentToResend = prevUser.rawContent || prevUser.content;
        variablesToRestore = prevUser.meta?.variables || null;
        deleteMessage(prevUser.id);
      } else {
        deleteMessage(messageId);
        if (contentToResend === undefined) {
          contentToResend = messageToResend.rawContent || messageToResend.content;
        }
        variablesToRestore = messageToResend.meta?.variables || null;
      }

      // Return both content and variables
      return {
        content: contentToResend || '',
        variables: variablesToRestore
      };
    },
    [messages, deleteMessage]
  );

  const cancelGeneration = useCallback(() => {
    cleanupEventSource();
    if (lastMessageIdRef.current) {
      const currentMessage = messagesRef.current.find((m) => m.id === lastMessageIdRef.current);
      updateAssistantMessage(
        lastMessageIdRef.current,
        (currentMessage?.content || '') + t('message.generationCancelled', ' [Generation cancelled]'),
        false
      );
    }
    setProcessing(false);
  }, [cleanupEventSource, updateAssistantMessage, t]);

  return {
    chatId: chatId,
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
