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
import { fetchAllLedgerEvents } from '../../../shared/run/ledgerPages';
import { fetchWithAuthRetry } from '../../../shared/utils/openSseStream';

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
 * @param {boolean} options.serverBacked - When true, the durable chat store owns the
 *   transcript: the request carries only the new message (a persisted chat rejects a
 *   longer array with `CLIENT_HISTORY_NOT_ALLOWED`), an edit or a regenerate travels as
 *   `replaceFromMessageId`, and the turn is not flagged ephemeral on the wire. Every
 *   other surface keeps posting its whole local history exactly as before.
 */
function useAppChat({
  appId,
  chatId: initialChatId,
  onMessageComplete,
  persistConversationId = true,
  ephemeral = false,
  serverBacked = false
}) {
  const { t } = useTranslation();
  // Use the chatId directly instead of storing it in a ref
  // This allows the useChatMessages hook to properly react to chatId changes.
  //
  // The fallback is minted once and then kept. Evaluating `chat-${uuidv4()}`
  // inline made every render of a caller with a falsy chatId a *different*
  // chat: a fresh sessionStorage key, a reset stream state, and a new chat id
  // on the wire for every keystroke that re-rendered the surface.
  const [fallbackChatId] = useState(() => `chat-${uuidv4()}`);
  const chatId = initialChatId || fallbackChatId;
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
  // Stored id of the message an edit, a regenerate or a delete replaces.
  // Latched by `deleteFromMessage`, consumed by the next send. It survives an
  // abandoned resend on purpose: the local transcript was already truncated,
  // so forking the stored one at the same point is what puts the two back in
  // agreement.
  const pendingReplaceFromRef = useRef(null);
  // The run this surface re-attached to after reopening the chat, and what to
  // do when it settles. Set by `reattachToRun`, consumed once by `handleEvent`.
  const reattachedRunRef = useRef(null);

  // Never persist the iAssistant conversationId for ephemeral chats.
  const shouldPersistConversationId = persistConversationId && !ephemeral;

  // Reacts to chatId changes, and owns which of the three transcript modes
  // (browser-persisted, ephemeral, server-backed) is in force.
  const {
    messages,
    messagesRef,
    hydrating,
    finishHydration,
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
  } = useChatMessages(chatId, { ephemeral, serverBacked });

  const cleanupEventSourceRef = useRef();

  // Per-chat SSE v2 stream state (one reducer for every surface). Kept in a
  // ref: it is the authoritative accumulation and is folded synchronously per
  // envelope, so no React batching race can drop a frame.
  const streamStateRef = useRef(createStreamState(chatId));
  // runId → assistant message id (bound on run/started via refs.messageId).
  const runMessageMapRef = useRef(new Map());

  // `/apps/:appId/c/:chatId` swaps chats without remounting this hook, so a
  // chat change has to tear the current turn down the way `clearChat` does.
  // The first run is the mount, where there is nothing to tear down.
  const chatMountedRef = useRef(false);
  useEffect(() => {
    streamStateRef.current = createStreamState(chatId);
    runMessageMapRef.current = new Map();
    // A pending fork belongs to the chat it was latched in.
    pendingReplaceFromRef.current = null;
    if (!chatMountedRef.current) {
      chatMountedRef.current = true;
      return;
    }
    // Leaving a chat mid-turn: `useEventSource` has already released this
    // surface's stream slot, but nothing else knows the turn is over. Without
    // this the composer of the chat just opened stays disabled behind a Stop
    // button, and a queued-but-unsent message would be posted to the wrong
    // chat as soon as the new stream connected.
    setProcessing(false);
    setClarificationPending(false);
    activeClarificationRef.current = null;
    lastMessageIdRef.current = null;
    // The prompt of the chat being left. It used to survive the switch, and
    // `reattachToRun` folds a ledger replay through the *live* `handleEvent` —
    // so a replayed `run/ended` for the chat just opened reached
    // `onMessageComplete(content, lastUserMessageRef.current)` carrying the
    // previous chat's question. On a canvas-enabled app that is enough to
    // navigate the user out of the chat they just opened, into canvas, with
    // one chat's answer under another's prompt.
    lastUserMessageRef.current = null;
    pendingMessageDataRef.current = null;
    isCancellingRef.current = false;
  }, [chatId]);

  /**
   * The protocol fields every send shares, consumed once per request.
   *
   * @param {boolean} [sendChatHistory=true] - The viewer's "Include chat history in
   *   requests" setting. A server-backed chat no longer communicates it by
   *   truncating the array it posts — it posts one message either way — so it
   *   has to travel as a field of its own.
   * @returns {Object} Extra request params.
   */
  const takeProtocolParams = useCallback(
    (sendChatHistory = true) => {
      const replaceFromMessageId = pendingReplaceFromRef.current;
      pendingReplaceFromRef.current = null;
      return {
        // A turn the server must not store. Every surface that is not running
        // the server-backed protocol has to say so, because it still posts its
        // whole local history and a persisted chat rejects that outright with
        // `CLIENT_HISTORY_NOT_ALLOWED`. That covers the incognito toggle, the
        // compare panels and the canvas — the last two mint their own chat ids
        // (`compare-<uuid>`, `canvas-<uuid>`) and fan a single user submit out
        // to several of them, so they never belong in a history list either.
        ...(serverBacked ? {} : { ephemeral: true }),
        // Edit and regenerate no longer speak through a truncated array: the
        // server forks its stored history here instead.
        ...(serverBacked && replaceFromMessageId ? { replaceFromMessageId } : {}),
        // "Include chat history in requests". Every other mode says this by
        // posting a one-element array; a server-backed chat posts one message
        // whatever the setting, so without this field the server would keep
        // prepending the stored transcript and the opt-out would be inert.
        //
        // Sent in *both* directions, not only when off. The chat document
        // merges settings, so a turn that omits the key leaves the stored
        // value alone — which meant the toggle could be turned off and never
        // back on: every later reopen restored `false` from the document, and
        // ticking it on again recorded nothing. `sessionRoutes` only tests
        // `=== false`, so the wire behaviour is unchanged; only what gets
        // recorded is fixed.
        ...(serverBacked ? { sendChatHistory: sendChatHistory !== false } : {})
      };
    },
    [serverBacked]
  );

  /**
   * Truncate the transcript from `messageId` (inclusive) — the local half of a
   * delete, an edit or a regenerate.
   *
   * That truncated array used to be the whole message to the server, since the
   * client posted it. A server-backed chat posts only the new message, so the
   * same intent has to travel explicitly: latch the id the stored history knows
   * this message by and let the next send carry it as `replaceFromMessageId`.
   *
   * A hydrated message carries the store's own id on `serverId`. A turn made in
   * this same session has none — no stream frame reports the id the store
   * minted for it — but the store did record the exchange id this client sent
   * as `clientMessageId`, and the fork lookup accepts either. Without that the
   * majority case (regenerate the answer you just got) would send no fork id at
   * all and the server would append the retry onto the untouched history,
   * duplicating the exchange in the stored transcript on every retry.
   *
   * @param {string} messageId - Message to truncate from.
   */
  const deleteFromMessage = useCallback(
    messageId => {
      if (serverBacked) {
        const target = messagesRef.current.find(m => m.id === messageId);
        const forkFrom =
          typeof target?.serverId === 'string'
            ? target.serverId
            : typeof target?.clientMessageId === 'string'
              ? target.clientMessageId
              : null;
        pendingReplaceFromRef.current = forkFrom;
      }
      deleteMessage(messageId);
    },
    [deleteMessage, messagesRef, serverBacked]
  );

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

  /**
   * Settle a re-attached run once, when it reaches a terminal frame.
   *
   * Guarded on the run id: a chat can have several runs in flight (a workflow
   * child, a superseded turn), and only the one this surface re-attached to
   * should trigger the caller's re-read.
   *
   * @param {string} runId - The run that just reached a terminal frame
   */
  const settleReattachedRun = useCallback(runId => {
    const pending = reattachedRunRef.current;
    if (!pending || pending.runId !== runId) return;
    reattachedRunRef.current = null;
    pending.onSettled?.();
  }, []);

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
          // A re-attached turn is settled: hand back to the caller so it can
          // re-read the stored transcript. The replay and the live stream meet
          // at a fetch boundary, so what is on screen may be missing a delta
          // that fell in it; the store is what the answer actually was.
          settleReattachedRun(rootRun.runId);
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
          settleReattachedRun(rootRun.runId);
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
      settleReattachedRun,
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
    // A stored chat's turn outlives this surface: leaving it must not stop it.
    durable: serverBacked,
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
          // The exchange id is what the store files this turn under
          // (`clientMessageId`), so it is the only handle an edit or a
          // regenerate of a turn made in this session can fork the stored
          // history by. Only server-backed chats have a store to address.
          ...(serverBacked ? { clientMessageId: exchangeId } : {}),
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
            ...(requestedSkill ? { requestedSkill } : {}),
            ...takeProtocolParams(sendChatHistory)
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
      takeProtocolParams,
      serverBacked,
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
        deleteFromMessage(prevUser.id);
      } else {
        deleteFromMessage(messageId);
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
    [messages, deleteFromMessage]
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
          isClarificationAnswer: true,
          // Same reason as `sendMessage`: the store files this turn under the
          // exchange id, so an edit of it later has something to fork from.
          ...(serverBacked ? { clientMessageId: exchangeId } : {})
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
            },
            // Same protocol as `sendMessage`: this path builds its own body
            // and would otherwise fork away from it.
            ...takeProtocolParams()
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
      takeProtocolParams,
      serverBacked,
      t,
      appId,
      chatId
    ]
  );

  const resetConversationState = useCallback(() => {
    setConversationTitle(null);
  }, []);

  /**
   * Re-attach to a turn that is still running on the server.
   *
   * A durable chat outlives the browser: its turn keeps generating after the
   * tab closes, and the answer is written to the store when it ends. Until
   * this existed, reopening such a chat showed the stored transcript — the
   * question, and nothing after it — and then sat there. The stream was never
   * connected, so no frame could arrive, and the partial answer already in the
   * ledger was never asked for. The chat looked stuck until the turn ended and
   * the page was reloaded a second time.
   *
   * Two steps, in this order:
   *
   * 1. **Replay the ledger.** The run's events are fetched and folded through
   *    the same `handleEvent` the live stream uses, so tool calls, progress
   *    and partial text are reconstructed exactly as they were rendered the
   *    first time rather than through a second, parallel projection.
   * 2. **Then connect.** Connecting first would interleave live frames with
   *    replayed ones out of order. This way every live frame folds on top of a
   *    finished replay.
   *
   * The window between the two is a fetch apart, and a delta emitted inside it
   * is not in the replay and not yet on the stream. `onSettled` is the answer
   * to that: the caller re-reads the stored transcript when the turn ends, and
   * the store is the authority on what the answer finally was.
   *
   * @param {string} runId - The run the chat document reports as active
   * @param {Object} [options]
   * @param {Function} [options.onSettled] - Called once the turn is no longer running
   * @returns {Promise<boolean>} Whether the surface attached to a live turn
   */
  const reattachToRun = useCallback(
    async (runId, { onSettled } = {}) => {
      if (!runId || !appId || !chatId) return false;

      // The replay needs somewhere to write. `bindRunToMessage` falls back to
      // `lastMessageIdRef` for a run whose `run/started` names no message id —
      // which is every run replayed from the ledger, since the message id it
      // referenced belongs to the browser session that started the turn.
      const placeholderId = addAssistantMessage();
      lastMessageIdRef.current = placeholderId;
      setProcessing(true);

      let ended = false;
      try {
        const { events } = await fetchAllLedgerEvents(async (after, limit) => {
          const res = await fetchWithAuthRetry(
            buildApiUrl(
              `runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}&view=sse`
            ),
            { method: 'GET', headers: { Accept: 'application/json' } }
          );
          if (!res.ok) throw new Error(`Run replay failed (${res.status})`);
          return res.json();
        });
        for (const envelope of events) {
          if (!envelope || envelope.v !== 2) continue;
          // The ledger numbers a run's own events; the live stream numbers the
          // chat's. Folding a ledger seq would poison gap detection with a
          // counter from the wrong space.
          const { seq: _ledgerSeq, ...live } = envelope;
          if (live.type === RUN_EVENTS.RUN_ENDED) ended = true;
          await handleEvent({ envelope: live });
        }
      } catch (err) {
        console.warn('Could not replay the running turn:', err.message);
      }

      if (ended) {
        // It finished between the chat document being read and this replay.
        // Nothing to attach to, and the store already has the answer.
        setProcessing(false);
        onSettled?.();
        return false;
      }

      reattachedRunRef.current = { runId, onSettled };
      initEventSource(buildApiUrl(`apps/${appId}/chat/${chatId}`));
      return true;
    },
    [appId, chatId, addAssistantMessage, handleEvent, initEventSource]
  );

  return {
    chatId: chatId,
    messages,
    processing,
    // True while a server-backed transcript is still being fetched, so a
    // surface can render a loading state instead of flashing its greeting.
    hydrating,
    finishHydration,
    clarificationPending,
    conversationTitle,
    sendMessage,
    resendMessage,
    deleteMessage: deleteFromMessage,
    editMessage,
    clearMessages,
    cancelGeneration,
    addSystemMessage,
    submitClarificationResponse,
    loadServerMessages,
    reattachToRun,
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
