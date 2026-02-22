import { useState, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import useChatMessages from './useChatMessages';
import useEventSource from '../../../shared/hooks/useEventSource';
import { sendAppChatMessage } from '../../../api/api';
import { buildApiUrl } from '../../../utils/runtimeBasePath';

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
  const chatId = initialChatId || `chat-${uuidv4()}`;
  const [processing, setProcessing] = useState(false);

  // Clarification state - tracks when a clarification question is pending
  const [clarificationPending, setClarificationPending] = useState(false);
  const activeClarificationRef = useRef(null); // Store active clarification data

  // Refs to keep mutable values between renders without relying on window
  const lastMessageIdRef = useRef(null);
  const pendingMessageDataRef = useRef(null);
  const lastUserMessageRef = useRef(null);
  const isCancellingRef = useRef(false);
  const messageMetadataRef = useRef(null); // Store metadata for the current message

  const {
    messages,
    messagesRef,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    deleteMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi
  } = useChatMessages(chatId); // Now this will properly react to chatId changes

  const cleanupEventSourceRef = useRef();

  const handleEvent = useCallback(
    async event => {
      const { type, fullContent, data } = event;
      switch (type) {
        case 'connected':
          if (pendingMessageDataRef.current) {
            try {
              const { appId, chatId, messages, params } = pendingMessageDataRef.current;
              await sendAppChatMessage(appId, chatId, messages, params);
              pendingMessageDataRef.current = null;
            } catch (error) {
              if (lastMessageIdRef.current && !isCancellingRef.current) {
                // Only show error if this wasn't a manual cancellation
                let errorMessage;

                // Check if this is a session expiration error (401)
                if (error.isAuthRequired || error.status === 401) {
                  errorMessage = t(
                    'error.sessionExpired',
                    'Your session has expired. Please log in again to continue.'
                  );
                  console.log('🔐 Session expired during chat message send');
                  // The authTokenExpired event should already be dispatched by the API client
                  // which will trigger the auto-redirect flow in AuthContext
                } else {
                  // Use the userFriendlyMessage from the enhanced error, or fall back to a generic message
                  errorMessage =
                    error.userFriendlyMessage ||
                    error.message ||
                    t(
                      'error.failedToGenerateResponse',
                      'Failed to generate response. Please try again or select a different model.'
                    );
                }

                // Preserve any streamed content that might have been accumulated
                const currentMessage = messagesRef.current.find(
                  m => m.id === lastMessageIdRef.current
                );
                updateAssistantMessage(
                  lastMessageIdRef.current,
                  (currentMessage?.content || '') + '\n\n' + errorMessage,
                  false
                );
              }
              cleanupEventSourceRef.current?.();
              setProcessing(false);
            }
          }
          break;
        case 'chunk':
          if (lastMessageIdRef.current) {
            updateAssistantMessage(lastMessageIdRef.current, fullContent, true);
          }
          break;
        case 'image':
          if (lastMessageIdRef.current) {
            // Add image to the current assistant message
            const currentMessage = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
            const existingImages = currentMessage?.images || [];
            updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
              images: [
                ...existingImages,
                {
                  mimeType: data?.mimeType,
                  data: data?.data,
                  thoughtSignature: data?.thoughtSignature
                }
              ]
            });
          }
          break;
        case 'thinking':
          if (lastMessageIdRef.current) {
            // Add thinking content to the current assistant message
            const currentMessage = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
            const existingThoughts = currentMessage?.thoughts || [];
            updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
              thoughts: [...existingThoughts, data?.content]
            });
          }
          break;
        case 'clarification':
          if (lastMessageIdRef.current && data) {
            console.log('📝 Clarification event received:', data);
            // Store the clarification data and set pending state
            activeClarificationRef.current = data;
            setClarificationPending(true);
            // Update the assistant message with clarification data
            // Keep loading=true since we're waiting for user input
            updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
              clarification: {
                questionId: data.questionId,
                question: data.question,
                inputType: data.inputType || 'text',
                options: data.options || [],
                allowOther: data.allowOther || false,
                allowSkip: data.allowSkip || false,
                context: data.context
              },
              awaitingInput: true
            });
          }
          break;
        case 'workflow.step': {
          if (lastMessageIdRef.current && data) {
            const currentMessage = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
            const prevSteps = currentMessage?.workflowSteps || [];

            const newStep = {
              nodeName: data.nodeName,
              nodeType: data.nodeType,
              status: data.status,
              workflowName: data.workflowName,
              chatVisible: data.chatVisible
            };

            let updatedSteps;
            if (data.status === 'running') {
              // Mark any previous "running" step as "completed", then add the new one
              updatedSteps = prevSteps.map(s =>
                s.status === 'running' ? { ...s, status: 'completed' } : s
              );
              updatedSteps = [...updatedSteps, newStep];
            } else {
              // Update existing step status (completed/error)
              const exists = prevSteps.some(s => s.nodeName === data.nodeName);
              updatedSteps = exists
                ? prevSteps.map(s => (s.nodeName === data.nodeName ? newStep : s))
                : [...prevSteps, newStep];
            }

            updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
              workflowSteps: updatedSteps,
              workflowStep: data.status === 'running' ? newStep : null
            });
          }
          break;
        }
        case 'workflow.result':
          if (lastMessageIdRef.current && data) {
            const currentMsg = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
            const prevSteps = currentMsg?.workflowSteps || [];
            // Mark any still-running steps based on workflow result status
            const finalSteps = prevSteps.map(s => {
              if (s.status === 'running') {
                // If workflow failed, mark running steps as error
                // If workflow cancelled or completed, mark as completed
                return {
                  ...s,
                  status: data.status === 'failed' ? 'error' : 'completed'
                };
              }
              return s;
            });

            updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
              workflowStep: null,
              workflowSteps: finalSteps,
              workflowResult: {
                status: data.status,
                executionId: data.executionId,
                workflowName: data.workflowName
              },
              outputFormat: data.outputFormat || 'markdown'
            });
          }
          break;
        case 'skill.activation':
          if (lastMessageIdRef.current && data) {
            const currentMsg = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
            const prevSkills = currentMsg?.activeSkills || [];
            updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
              activeSkills: [...prevSkills, { name: data.skillName, description: data.description }]
            });
          }
          break;
        case 'done':
          if (lastMessageIdRef.current) {
            // Include stored metadata (customResponseRenderer, outputFormat) in the message
            // Preserve workflow-set outputFormat — don't let app default overwrite it
            const currentMsg = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
            const metadata = {
              finishReason: data?.finishReason,
              ...(messageMetadataRef.current || {}),
              ...(currentMsg?.outputFormat && { outputFormat: currentMsg.outputFormat })
            };

            // Check if this is a clarification finish reason
            if (data?.finishReason === 'clarification') {
              console.log('📝 Done event with clarification finish reason');
              // Keep the message in awaiting input state, don't mark as complete
              updateAssistantMessage(lastMessageIdRef.current, fullContent, false, {
                ...metadata,
                awaitingInput: true
              });
              // Processing stops but clarification is still pending
              setProcessing(false);
              // Don't call onMessageComplete yet - wait for clarification response
              break;
            }

            updateAssistantMessage(lastMessageIdRef.current, fullContent, false, metadata);
            if (onMessageComplete) {
              onMessageComplete(fullContent, lastUserMessageRef.current);
            }
          }
          setProcessing(false);
          // Reset clarification state when done normally
          setClarificationPending(false);
          activeClarificationRef.current = null;
          break;
        case 'error':
          if (lastMessageIdRef.current && !isCancellingRef.current) {
            // Only show error if this wasn't a manual cancellation
            // Preserve any streamed content that was accumulated before the error
            const currentMessage = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
            const errorMessage =
              data?.message || t('error.streamingError', 'An error occurred during streaming');
            updateAssistantMessage(
              lastMessageIdRef.current,
              (currentMessage?.content || '') + '\n\n' + errorMessage,
              false
            );
          }
          setProcessing(false);
          break;
        default:
          // TODO Implement proper handling of unknown messages as well as display them in the frontend
          // if (data?.message) {
          //   addSystemMessage('🔍 ' + data.message, false);
          // }
          console.log('🔍 Unknown event type:', type, data);
      }
    },
    [pendingMessageDataRef, updateAssistantMessage, onMessageComplete, t, messagesRef]
  );

  const { initEventSource, cleanupEventSource } = useEventSource({
    appId,
    chatId: chatId,
    onEvent: handleEvent,
    onProcessingChange: setProcessing
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
   * @param {Object} messageMetadata - Metadata to attach to the assistant message (e.g., customResponseRenderer)
   */
  const sendMessage = useCallback(
    ({ displayMessage, apiMessage, params, sendChatHistory = true, messageMetadata = null }) => {
      try {
        // Reset cancellation flag when starting a new message
        isCancellingRef.current = false;

        cleanupEventSource();
        setProcessing(true);
        const exchangeId = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        lastMessageIdRef.current = exchangeId;

        // Store the user message content for the onMessageComplete callback
        lastUserMessageRef.current = apiMessage.content;

        // Store message metadata (customResponseRenderer, outputFormat) for completion
        messageMetadataRef.current = messageMetadata;

        // Ensure we extract content properly and default to empty string if needed
        const contentToAdd =
          typeof displayMessage === 'string' ? displayMessage : displayMessage?.content || '';

        addUserMessage(contentToAdd, {
          ...(displayMessage?.meta || {}),
          imageData: apiMessage.imageData,
          fileData: apiMessage.fileData,
          audioData: apiMessage.audioData
        });
        addAssistantMessage(exchangeId);

        const messagesForAPI = getMessagesForApi(sendChatHistory, {
          role: 'user',
          content: apiMessage.content,
          promptTemplate: apiMessage.promptTemplate || null,
          variables: apiMessage.variables || {},
          messageId: exchangeId,
          imageData: apiMessage.imageData,
          fileData: apiMessage.fileData,
          audioData: apiMessage.audioData
        });

        pendingMessageDataRef.current = {
          appId,
          chatId: chatId,
          messages: messagesForAPI,
          params
        };

        initEventSource(buildApiUrl(`apps/${appId}/chat/${chatId}`));
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
    [
      cleanupEventSource,
      addUserMessage,
      addAssistantMessage,
      getMessagesForApi,
      initEventSource,
      addSystemMessage,
      t,
      appId,
      chatId
    ]
  );

  /**
   * Prepare content for resending a previous message.
   * Returns an object with content and variables to restore.
   */
  const resendMessage = useCallback(
    (messageId, editedContent) => {
      const messageToResend = messages.find(m => m.id === messageId);
      if (!messageToResend)
        return { content: '', variables: null, imageData: null, fileData: null, audioData: null };

      let contentToResend = editedContent;
      let variablesToRestore = null;
      let imageDataToRestore = null;
      let fileDataToRestore = null;
      let audioDataToRestore = null;

      if (messageToResend.role === 'assistant') {
        const idx = messages.findIndex(m => m.id === messageId);
        const prevUser = [...messages.slice(0, idx)].reverse().find(m => m.role === 'user');
        if (!prevUser)
          return { content: '', variables: null, imageData: null, fileData: null, audioData: null };
        imageDataToRestore = prevUser.imageData || null;
        fileDataToRestore = prevUser.fileData || null;
        audioDataToRestore = prevUser.audioData || null;
        // If there's file/audio data, use rawContent to avoid including file HTML in the text
        // Otherwise fall back to content for backward compatibility
        contentToResend =
          imageDataToRestore || fileDataToRestore || audioDataToRestore
            ? prevUser.rawContent || ''
            : prevUser.rawContent || prevUser.content;
        variablesToRestore = prevUser.meta?.variables || null;
        deleteMessage(prevUser.id);
      } else {
        deleteMessage(messageId);
        if (contentToResend === undefined) {
          imageDataToRestore = messageToResend.imageData || null;
          fileDataToRestore = messageToResend.fileData || null;
          audioDataToRestore = messageToResend.audioData || null;
          // If there's file/audio data, use rawContent to avoid including file HTML in the text
          // Otherwise fall back to content for backward compatibility
          contentToResend =
            imageDataToRestore || fileDataToRestore || audioDataToRestore
              ? messageToResend.rawContent || ''
              : messageToResend.rawContent || messageToResend.content;
        }
        variablesToRestore = messageToResend.meta?.variables || null;
        if (!imageDataToRestore) imageDataToRestore = messageToResend.imageData || null;
        if (!fileDataToRestore) fileDataToRestore = messageToResend.fileData || null;
        if (!audioDataToRestore) audioDataToRestore = messageToResend.audioData || null;
      }

      // Return content, variables, and file data
      return {
        content: contentToResend || '',
        variables: variablesToRestore,
        imageData: imageDataToRestore,
        fileData: fileDataToRestore,
        audioData: audioDataToRestore
      };
    },
    [messages, deleteMessage]
  );

  const cancelGeneration = useCallback(() => {
    // Set flag to prevent error messages during manual cancellation
    isCancellingRef.current = true;

    cleanupEventSource();

    if (lastMessageIdRef.current) {
      const currentMessage = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
      updateAssistantMessage(
        lastMessageIdRef.current,
        (currentMessage?.content || '') +
          t('message.generationCancelled', ' [Generation cancelled]'),
        false
      );
    }

    setProcessing(false);
    setClarificationPending(false);
    activeClarificationRef.current = null;

    // Reset the cancellation flag after a short delay to allow cleanup to complete
    setTimeout(() => {
      isCancellingRef.current = false;
    }, 100);
  }, [cleanupEventSource, updateAssistantMessage, t, messagesRef]);

  /**
   * Submit a response to a clarification question.
   * Updates the current message with the response and continues the conversation.
   *
   * @param {Object|string} rawResponse - The clarification response (object or simple value)
   * @param {string} rawResponse.questionId - ID of the question being answered
   * @param {boolean} rawResponse.answered - Whether the question was answered (vs skipped)
   * @param {boolean} rawResponse.skipped - Whether the question was skipped
   * @param {*} rawResponse.value - The actual response value
   * @param {string} rawResponse.displayText - Human-readable display text
   * @param {Object} params - Parameters for the continuation request
   */
  const submitClarificationResponse = useCallback(
    (rawResponse, params = {}) => {
      console.log('📝 Submitting clarification response:', rawResponse);

      if (!activeClarificationRef.current) {
        console.warn('No active clarification to respond to');
        return;
      }

      const clarificationData = activeClarificationRef.current;
      const messageId = lastMessageIdRef.current;

      // Normalize response - handle both object and simple value formats
      // ClarificationCard may pass either an object or just the value depending on whether questionId was set
      let response;
      if (typeof rawResponse === 'object' && rawResponse !== null && 'value' in rawResponse) {
        // Full response object
        response = rawResponse;
      } else {
        // Simple value - convert to full response object
        const value = rawResponse;
        const displayText = Array.isArray(value) ? value.join(', ') : String(value);
        response = {
          questionId: clarificationData.questionId,
          answered: true,
          skipped: false,
          value,
          displayText
        };
      }

      // Update the assistant message to mark clarification as responded
      // Just store a flag - the answer is shown in the user message below
      if (messageId) {
        const currentMessage = messagesRef.current.find(m => m.id === messageId);
        if (currentMessage) {
          updateAssistantMessage(messageId, currentMessage.content || '', false, {
            clarification: currentMessage.clarification,
            clarificationAnswered: true,
            awaitingInput: false,
            loading: false
          });
        }
      }

      // Clear clarification state
      setClarificationPending(false);
      activeClarificationRef.current = null;

      // Create user message content - just the answer (question is shown on assistant message)
      const userMessageContent = response.skipped
        ? t('clarification.skipped', 'Skipped')
        : response.displayText;

      // Continue the conversation with the response
      // The response is sent as a special message that the server will process
      try {
        isCancellingRef.current = false;
        cleanupEventSource();
        setProcessing(true);

        const exchangeId = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        lastMessageIdRef.current = exchangeId;

        // Add a user message with minimal clarification metadata (questionId links to the question in previous message)
        addUserMessage(userMessageContent, {
          clarificationResponse: {
            questionId: response.questionId,
            value: response.value,
            skipped: response.skipped
          },
          isClarificationAnswer: true
        });

        // Add placeholder for assistant response
        addAssistantMessage(exchangeId);

        // Build the messages for API - just the answer value (question context is in chat history)
        const messagesForAPI = getMessagesForApi(true, {
          role: 'user',
          content: response.skipped ? '[Skipped]' : String(response.value),
          messageId: exchangeId,
          clarificationResponse: {
            questionId: response.questionId,
            value: response.value,
            skipped: response.skipped
          }
        });

        pendingMessageDataRef.current = {
          appId,
          chatId: chatId,
          messages: messagesForAPI,
          params: {
            ...params,
            clarificationResponse: {
              questionId: response.questionId,
              value: response.value,
              skipped: response.skipped
            }
          }
        };

        initEventSource(buildApiUrl(`apps/${appId}/chat/${chatId}`));
      } catch (err) {
        console.error('Error submitting clarification response:', err);
        addSystemMessage(
          `Error: ${t('error.clarificationFailed', 'Failed to submit clarification response.')} ${
            err.message || t('error.tryAgain', 'Please try again.')
          }`,
          true
        );
        setProcessing(false);
        setClarificationPending(false);
      }
    },
    [
      cleanupEventSource,
      updateAssistantMessage,
      addUserMessage,
      addAssistantMessage,
      getMessagesForApi,
      initEventSource,
      addSystemMessage,
      messagesRef,
      t,
      appId,
      chatId
    ]
  );

  return {
    chatId: chatId,
    messages,
    processing,
    clarificationPending,
    sendMessage,
    resendMessage,
    deleteMessage,
    editMessage,
    clearMessages,
    cancelGeneration,
    addSystemMessage,
    submitClarificationResponse
  };
}

export default useAppChat;
