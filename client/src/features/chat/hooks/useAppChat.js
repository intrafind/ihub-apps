import { useState, useRef, useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import useChatMessages from './useChatMessages';
import useEventSource from '../../../shared/hooks/useEventSource';
import { sendAppChatMessage } from '../../../api';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { setConversationId } from '../../../utils/chatId';
import { debugLog } from '../../../utils/debugLog';
import {
  createStreamState,
  reduceRunEvent,
  getRun,
  RUN_EVENTS,
  getRuns
} from '../../../shared/run/runReducer';
import { projectMessageRuns } from '../runToMessage';

/**
 * High level hook combining chat message management with streaming
 * communication for both chat and canvas pages.
 *
 * Streaming dialect: SSE v2 envelopes (`{ v: 2, seq, runId, ts, type, data }`).
 * Every envelope is folded into a per-chat StreamState by the shared run
 * reducer; the run is bound to the assistant placeholder via
 * `run/started.data.refs.messageId` and projected onto the message with
 * `projectRunToMessage`. This hook never interprets event payloads itself.
 *
 * @param {Object} options - Configuration options
 * @param {string} options.appId - The app ID
 * @param {string} options.chatId - The chat session ID
 * @param {Function} options.onMessageComplete - Callback fired when a message is completed (optional)
 * @param {boolean} options.persistConversationId - Whether to persist iAssistant conversationId
 *   to localStorage (keyed by appId). Disable for ephemeral chats (e.g. compare mode panels)
 *   that share an appId so they don't race/overwrite each other. Defaults to true.
 * @param {boolean} options.ephemeral - When true, chat is never persisted to browser storage
 *   and no conversationId is stored.
 */
function useAppChat({
  appId,
  chatId: initialChatId,
  onMessageComplete,
  persistConversationId = true,
  ephemeral = false
}) {
  const { t } = useTranslation();
  // Use the chatId directly instead of storing it in a ref
  // This allows the useChatMessages hook to properly react to chatId changes
  const chatId = initialChatId || `chat-${uuidv4()}`;
  const [processing, setProcessing] = useState(false);
  const [conversationTitle, setConversationTitle] = useState(null);
  // Clarification state - tracks when a clarification question is pending
  const [clarificationPending, setClarificationPending] = useState(false);
  const activeClarificationRef = useRef(null); // Store active clarification data

  // Refs to keep mutable values between renders without relying on window
  const lastMessageIdRef = useRef(null);
  const pendingMessageDataRef = useRef(null);
  const lastUserMessageRef = useRef(null);
  const isCancellingRef = useRef(false);
  const messageMetadataRef = useRef(null); // Store metadata for the current message

  // Never persist the iAssistant conversationId for ephemeral chats.
  const shouldPersistConversationId = persistConversationId && !ephemeral;

  const {
    messages,
    messagesRef,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    appendToAssistantMessage,
    deleteMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi,
    loadServerMessages
  } = useChatMessages(chatId, { ephemeral }); // Now this will properly react to chatId changes

  const cleanupEventSourceRef = useRef();

  // Per-chat SSE v2 stream state (one reducer for every surface). Kept in a
  // ref: it is the authoritative accumulation and is folded synchronously per
  // envelope, so no React batching race can drop a frame.
  const streamStateRef = useRef(createStreamState(chatId));
  // runId → assistant message id (bound on run/started via refs.messageId).
  const runMessageMapRef = useRef(new Map());

  useEffect(() => {
    streamStateRef.current = createStreamState(chatId);
    runMessageMapRef.current = new Map();
  }, [chatId]);

  /**
   * Send the message queued by sendMessage / submitClarificationResponse once
   * the stream is connected. On failure the error is rendered into the
   * assistant placeholder (401 → session expired) and the stream is closed.
   */
  const sendPendingMessage = useCallback(async () => {
    if (!pendingMessageDataRef.current) return;
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
          debugLog('🔐 Session expired during chat message send');
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
        const currentMessage = messagesRef.current.find(m => m.id === lastMessageIdRef.current);
        updateAssistantMessage(
          lastMessageIdRef.current,
          (currentMessage?.content || '') + '\n\n' + errorMessage,
          false
        );
      }
      cleanupEventSourceRef.current?.();
      setProcessing(false);
    }
  }, [t, messagesRef, updateAssistantMessage]);

  /**
   * Resolve the assistant message a run belongs to. `run/started` binds the
   * run via `refs.messageId` (the exchange id we handed the server); anything
   * else falls back to the current placeholder.
   */
  const bindRunToMessage = useCallback(
    envelope => {
      const runId = envelope.runId;
      if (envelope.type === RUN_EVENTS.RUN_STARTED) {
        const refMessageId = envelope.data?.refs?.messageId;
        const known =
          typeof refMessageId === 'string' && messagesRef.current.some(m => m.id === refMessageId);
        // A child run (workflow launched by a tool inside the turn) belongs to
        // its parent's message.
        const parentMessageId = envelope.data?.parentRunId
          ? runMessageMapRef.current.get(envelope.data.parentRunId)
          : null;
        runMessageMapRef.current.set(
          runId,
          known ? refMessageId : parentMessageId || lastMessageIdRef.current
        );
      }
      return runMessageMapRef.current.get(runId) || lastMessageIdRef.current;
    },
    [messagesRef]
  );

  const handleEvent = useCallback(
    async event => {
      const envelope = event?.envelope;
      if (!envelope) {
        debugLog('🔍 Ignoring non-envelope stream event:', event?.type);
        return;
      }
      const { type, runId, data } = envelope;

      // Fold into the per-chat stream state. Turn boundaries legitimately skip
      // stream seqs (the server keeps emitting after we abort), so the chat
      // surface never re-syncs on a gap.
      const streamState = { ...reduceRunEvent(streamStateRef.current, envelope), gap: null };
      streamStateRef.current = streamState;

      if (type === RUN_EVENTS.STREAM_CONNECTED) {
        await sendPendingMessage();
        return;
      }

      const messageId = bindRunToMessage(envelope);
      const run = getRun(streamState, runId);

      if (type === RUN_EVENTS.META) {
        if (data?.title) setConversationTitle(data.title);
        if (data?.conversationId && appId && shouldPersistConversationId) {
          setConversationId(appId, data.conversationId);
        }
      }

      // Stream-level error (transport failure / error before any run started):
      // nothing to project, append the message like the legacy 'error' case.
      if (type === RUN_EVENTS.STREAM_ERROR && !run) {
        if (messageId && !isCancellingRef.current) {
          const currentMessage = messagesRef.current.find(m => m.id === messageId);
          const errorMessage =
            data?.message || t('error.streamingError', 'An error occurred during streaming');
          updateAssistantMessage(
            messageId,
            (currentMessage?.content || '') + '\n\n' + errorMessage,
            false
          );
        }
        setProcessing(false);
        return;
      }

      if (!run || !messageId) {
        debugLog('🔍 Stream event without a bound message:', type, runId);
        return;
      }

      if (type === RUN_EVENTS.STREAM_ERROR && isCancellingRef.current) {
        // Manual cancellation — don't render the error, just stop.
        setProcessing(false);
        return;
      }

      // A workflow launched by a tool inside the turn is its own run, a child
      // of the chat run (`parentRunId`). The message shows the chat run's
      // answer plus the workflow state of its children; a child's lifecycle
      // frames only refresh the message — the chat run completes it.
      const parentRun = run.parentRunId ? getRun(streamState, run.parentRunId) : null;
      const rootRun = parentRun || run;
      const isChildFrame = rootRun !== run;
      const childRuns = getRuns(streamState).filter(r => r.parentRunId === rootRun.runId);
      const { content, loading, extras } = projectMessageRuns(rootRun, childRuns, {
        fallbackErrorMessage: t('error.streamingError', 'An error occurred during streaming')
      });

      switch (isChildFrame ? 'child-frame' : type) {
        case RUN_EVENTS.INTERACTION_RAISED:
          if (extras.awaitingInput && extras.clarification) {
            debugLog('📝 Clarification raised:', extras.clarification);
            activeClarificationRef.current = extras.clarification;
            setClarificationPending(true);
          }
          updateAssistantMessage(messageId, content, loading, extras);
          break;

        case RUN_EVENTS.RUN_PAUSED:
          updateAssistantMessage(messageId, content, loading, extras);
          if (extras.awaitingInput) {
            // Legacy done{finishReason:'clarification'}: the turn hands control
            // back to the user; processing stops but the clarification stays pending.
            setProcessing(false);
          }
          break;

        case RUN_EVENTS.RUN_ENDED: {
          // Include stored metadata (customResponseRenderer, outputFormat) in the message.
          // Preserve workflow-set outputFormat — don't let the app default overwrite it.
          const metadata = {
            finishReason: rootRun.finishReason,
            ...(messageMetadataRef.current || {}),
            ...(extras.outputFormat && { outputFormat: extras.outputFormat })
          };

          if (extras.awaitingInput || rootRun.finishReason === 'clarification') {
            debugLog('📝 Run ended while a clarification is pending');
            // Keep the message in awaiting-input state, don't mark it complete
            updateAssistantMessage(messageId, content, false, {
              ...extras,
              ...metadata,
              awaitingInput: true
            });
            // Processing stops but clarification is still pending
            setProcessing(false);
            // Don't call onMessageComplete yet - wait for clarification response
            break;
          }

          updateAssistantMessage(messageId, content, false, { ...extras, ...metadata });

          if (rootRun.status === 'error' || rootRun.error) {
            // Legacy error path: content already carries the stream/error message.
            setProcessing(false);
            break;
          }

          if (onMessageComplete) {
            onMessageComplete(content, lastUserMessageRef.current);
          }
          setProcessing(false);
          // Reset clarification state when done normally
          setClarificationPending(false);
          activeClarificationRef.current = null;
          break;
        }

        case RUN_EVENTS.STREAM_ERROR:
          // Preserve any streamed content (the projection appends the error text)
          updateAssistantMessage(messageId, content, false, extras);
          setProcessing(false);
          break;

        default:
          updateAssistantMessage(messageId, content, loading, extras);
      }
    },
    [
      appId,
      bindRunToMessage,
      sendPendingMessage,
      updateAssistantMessage,
      onMessageComplete,
      t,
      messagesRef,
      shouldPersistConversationId
    ]
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
    ({
      displayMessage,
      apiMessage,
      params,
      sendChatHistory = true,
      messageMetadata = null,
      requestedSkill = null
    }) => {
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
          params: {
            ...params,
            ...(requestedSkill ? { requestedSkill } : {})
          }
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
      // Append the cancellation note via a functional setState updater so it
      // always concatenates onto the LATEST content — never an out-of-date
      // snapshot from messagesRef. Previously this read content from
      // messagesRef and passed `read + note` to updateAssistantMessage,
      // which wholesale-replaced the message. Any chunks that arrived
      // between the read and the write were lost, and if the read happened
      // before the first chunk landed the entire streamed body was erased.
      appendToAssistantMessage(
        lastMessageIdRef.current,
        t('message.generationCancelled', ' [Generation cancelled]'),
        { loading: false, cancelled: true }
      );
    }

    setProcessing(false);
    setClarificationPending(false);
    activeClarificationRef.current = null;

    // Reset the cancellation flag after a short delay to allow cleanup to complete
    setTimeout(() => {
      isCancellingRef.current = false;
    }, 100);
  }, [cleanupEventSource, appendToAssistantMessage, t]);

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
      debugLog('📝 Submitting clarification response:', rawResponse);

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

  const resetConversationState = useCallback(() => {
    setConversationTitle(null);
  }, []);

  return {
    chatId: chatId,
    messages,
    processing,
    clarificationPending,
    conversationTitle,
    sendMessage,
    resendMessage,
    deleteMessage,
    editMessage,
    clearMessages,
    cancelGeneration,
    addSystemMessage,
    submitClarificationResponse,
    loadServerMessages,
    resetConversationState,
    // Exposed so the transcription flow can render a transcript as a
    // locally-built assistant turn (streaming deltas), without going through the
    // chat LLM pipeline.
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage
  };
}

export default useAppChat;
