// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import useChatMessages from './useChatMessages';
import useEventSource from '../../../shared/hooks/useEventSource';
import { sendAppChatMessage, checkAppChatStatus } from '../../../api';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { setConversationId } from '../../../utils/chatId';
import { debugLog } from '../../../utils/debugLog';
import {
  createStreamState,
  reduceRunEvent,
  getRun,
  RUN_EVENTS,
  getRuns
} from '../../../../../shared/run/runReducer.js';
import { projectMessageRuns } from '../runToMessage';
import { toolApprovalAnswer } from '../toolApprovalAnswer';
import { fetchAllLedgerEvents } from '../../../shared/run/ledgerPages';
import { fetchWithAuthRetry } from '../../../shared/utils/openSseStream';
import { takeMcpAppModelContext } from '../mcpApps/modelContextStore';
import { splitFilesForWire } from '../utils/chatFileUpload';
import { refreshMyUsage } from '../../../shared/hooks/useMyUsage';
import { useAiAcknowledgement } from '../../../shared/hooks/useAiAcknowledgement';

/**
 * Refusals of the chat request the user can do something about, by the code
 * the server answers with: translation key and English fallback.
 */
/** Frames that show an approval answer's turn got going (the decision is used). */
const APPROVAL_USED_EVENTS = new Set([
  RUN_EVENTS.TOOL_STARTED,
  RUN_EVENTS.TOOL_COMPLETED,
  RUN_EVENTS.STEP_DELTA
]);

/** Refusals after which an approval card must not ask again: the decision is final. */
const APPROVAL_FINAL_CODES = new Set(['APPROVAL_ALREADY_ANSWERED', 'APPROVAL_NOT_PENDING']);

const CHAT_REFUSAL_MESSAGES = {
  CHAT_STORAGE_UNAVAILABLE: [
    'error.chatStorageUnavailable',
    'Chats cannot be stored right now, so this message was not sent. Please try again later or contact your administrator.'
  ],
  CLIENT_HISTORY_NOT_ALLOWED: [
    'error.clientHistoryNotAllowed',
    'This page is out of date. Reload it to continue the chat.'
  ],
  APPROVAL_NOT_PENDING: [
    'chat.toolApproval.notPending',
    'This approval is no longer open (it was answered, or a newer message replaced it).'
  ],
  APPROVAL_ALREADY_ANSWERED: [
    'chat.toolApproval.alreadyAnswered',
    'This approval was already answered.'
  ],
  GUEST_COOKIE_MISSING: [
    'error.guestCookieMissing',
    'This chat cannot be continued because your browser does not keep cookies for this site. Allow cookies for this site to continue chats here.'
  ]
};

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
 * @param {Function} [options.onMessageAccepted] - Called with the chat id once the server has
 *   accepted a turn's request — the moment the chat is in the store
 * @param {Function} [options.onRunStarted] - Called with the chat id when a turn's run starts
 *   on the stream. The server announces a run only once its question is stored, so this is
 *   the earliest moment the chat is in the store; a turn's request
 *   itself is only answered when the turn ends.
 * @param {boolean} options.persistConversationId - Whether to persist iAssistant conversationId
 *   to localStorage (keyed by appId). Disable for ephemeral chats (e.g. compare mode panels)
 *   that share an appId so they don't race/overwrite each other. Defaults to true.
 * @param {boolean} options.ephemeral - When true, a chat this surface starts is a temporary
 *   one (never listed in the history, deleted `chats.temporaryRetentionHours` after its
 *   last activity) and no conversationId is stored. The chat is stored on the server
 *   either way: the request
 *   carries only the new message, an edit or a regenerate travels as
 *   `replaceFromMessageId`, and the server assembles the history.
 * @param {boolean} [options.hydrates=true] - Whether the transcript has to be fetched
 *   from the store before the surface can tell an empty chat from one still loading
 *   (see `useChatMessages`). False for a surface that only ever opens new chats.
 * @param {boolean} [options.toolApprovals=false] - The surface draws tool approval cards
 *   and answers them with `submitToolApproval` (#2945). It tells the server so with every
 *   request (`toolApprovalCapable`); a surface that does not is treated as headless and a
 *   tool call that needs approval is refused instead of waiting for a card nobody sees.
 */
function useAppChat({
  appId,
  chatId: initialChatId,
  onMessageComplete,
  onMessageAccepted,
  onRunStarted,
  persistConversationId = true,
  ephemeral = false,
  hydrates = true,
  toolApprovals = false,
  onSendRefused
}) {
  const { t } = useTranslation();
  // The AI-use acknowledgement gate; null outside its provider (then the server decides).
  const acknowledgement = useAiAcknowledgement();
  // The last send, to roll back and retry once when the server answers 428.
  const lastSendRef = useRef(null);
  const initEventSourceRef = useRef(null);
  const onSendRefusedRef = useRef(onSendRefused);
  onSendRefusedRef.current = onSendRefused;
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
  // Latest `onMessageAccepted`, read when a send resolves rather than bound
  // into the send callbacks.
  const onMessageAcceptedRef = useRef(onMessageAccepted);
  const onRunStartedRef = useRef(onRunStarted);
  useEffect(() => {
    onMessageAcceptedRef.current = onMessageAccepted;
    onRunStartedRef.current = onRunStarted;
  });
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
  // The approval card a sent decision came from, until its turn gets going:
  // `{ messageId, toolApproval }` (#2945). A turn refused before that reopens it.
  const approvalRetryRef = useRef(null);
  // The run this surface re-attached to after reopening the chat, and what to
  // do when it settles. Set by `reattachToRun`, consumed once by `handleEvent`.
  const reattachedRunRef = useRef(null);

  // Never persist the iAssistant conversationId for ephemeral chats.
  const shouldPersistConversationId = persistConversationId && !ephemeral;

  // Reacts to chatId changes; the transcript itself comes from the store.
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
    removeMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi,
    loadServerMessages
  } = useChatMessages(chatId, { hydrates });

  const detachEventSourceRef = useRef();

  // Per-chat SSE v2 stream state (one reducer for every surface). Kept in a
  // ref: it is the authoritative accumulation and is folded synchronously per
  // envelope, so no React batching race can drop a frame.
  const streamStateRef = useRef(createStreamState(chatId));
  // runId → assistant message id (bound on run/started via refs.messageId).
  const runMessageMapRef = useRef(new Map());

  // The chat on screen, for work that outlives the render it started in. A
  // re-attach replays a run's ledger over several awaits and then connects;
  // if the user moves to another chat meanwhile, the rest of that replay (and
  // the stream after it) belongs to the chat that was left and must not be
  // folded into the one now open. Set in a layout effect so the switch is
  // visible before any awaited replay step can resume.
  const currentChatIdRef = useRef(chatId);
  useLayoutEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

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
   *   requests" setting. A turn posts one message either way, so it travels as a
   *   field of its own.
   * @returns {Object} Extra request params.
   */
  const takeProtocolParams = useCallback(
    (sendChatHistory = true) => {
      const replaceFromMessageId = pendingReplaceFromRef.current;
      pendingReplaceFromRef.current = null;
      return {
        // A chat the user does not want kept: the incognito toggle, the
        // compare panels and the canvas — the last two mint their own chat ids
        // (`compare-<uuid>`, `canvas-<uuid>`) and fan a single user submit out
        // to several of them, so they never belong in a history list. Only the
        // turn that creates the chat decides; the server ignores it after.
        ...(ephemeral ? { ephemeral: true } : {}),
        // Edit and regenerate do not speak through a truncated array: the
        // server forks its stored history here instead.
        ...(replaceFromMessageId ? { replaceFromMessageId } : {}),
        // "Include chat history in requests". A turn posts one message
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
        sendChatHistory: sendChatHistory !== false
      };
    },
    [ephemeral]
  );

  /**
   * Truncate the transcript from `messageId` (inclusive) — the local half of a
   * delete, an edit or a regenerate.
   *
   * That truncated array used to be the whole message to the server, since the
   * client posted it. A turn posts only the new message, so the same intent has
   * to travel explicitly: latch the id the stored history knows
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
      const target = messagesRef.current.find(m => m.id === messageId);
      pendingReplaceFromRef.current =
        typeof target?.serverId === 'string'
          ? target.serverId
          : typeof target?.clientMessageId === 'string'
            ? target.clientMessageId
            : null;
      deleteMessage(messageId);
    },
    [deleteMessage, messagesRef]
  );

  /**
   * Put the approval card back to asking after the turn carrying its
   * decision failed before it started (#2945): the server kept the approval
   * open, so the same decision can be sent again. A final refusal (already
   * answered, no longer pending) leaves the card as it is.
   *
   * @param {string} [code] - the error code the turn failed with
   */
  const reopenToolApproval = useCallback(
    code => {
      const retry = approvalRetryRef.current;
      approvalRetryRef.current = null;
      if (!retry || APPROVAL_FINAL_CODES.has(code)) return;
      const owner = messagesRef.current.find(m => m.id === retry.messageId);
      if (!owner) return;
      updateAssistantMessage(owner.id, owner.content || '', false, {
        toolApproval: retry.toolApproval,
        awaitingInput: true,
        loading: false
      });
    },
    [messagesRef, updateAssistantMessage]
  );

  /**
   * Send the message queued by sendMessage / submitClarificationResponse once
   * the stream is connected. On failure the error is rendered into the
   * assistant placeholder (401 → session expired) and the stream is closed.
   */
  const sendPendingMessage = useCallback(async () => {
    if (!pendingMessageDataRef.current) return;
    const { appId, chatId, messages, params } = pendingMessageDataRef.current;
    try {
      await sendAppChatMessage(
        appId,
        chatId,
        messages,
        toolApprovals ? { ...params, toolApprovalCapable: true } : params
      );
      pendingMessageDataRef.current = null;
      // The server has the turn — the chat is in the store from here on.
      onMessageAcceptedRef.current?.(chatId);
    } catch (error) {
      // The POST is answered when the turn ends, so a turn longer than the
      // request timeout (axios, the ingress's proxy-read-timeout) loses the
      // reply, not the turn: the server keeps running it and the open stream
      // still carries every frame. Keep listening instead of reporting a failure.
      const lostReply = error?.isTimeout || error?.status === 502 || error?.status === 504;
      if (lostReply && !isCancellingRef.current) {
        const status = await checkAppChatStatus(appId, chatId).catch(() => null);
        if (status?.processing) {
          pendingMessageDataRef.current = null;
          onMessageAcceptedRef.current?.(chatId);
          return;
        }
      }
      const pendingSend = pendingMessageDataRef.current;
      if (
        error?.code === 'AI_ACKNOWLEDGEMENT_REQUIRED' &&
        acknowledgement &&
        pendingSend &&
        !pendingSend.acknowledgementRetried
      ) {
        // Not an error to show: ask the user to confirm the AI-use notice, then send
        // the very same prepared request once more. The prepared request, not
        // arguments rebuilt from it, so what a first attempt consumed (the stored-history
        // fork of an edit or regenerate) is still on it, and a clarification answer or
        // a tool approval is retried as itself.
        const own = lastSendRef.current?.pending === pendingSend ? lastSendRef.current : null;
        const placeholderId = lastMessageIdRef.current;
        const originChatId = pendingSend.chatId;
        detachEventSourceRef.current?.();
        setProcessing(false);
        void acknowledgement.handleAcknowledgementRequired().then(ok => {
          if (ok && currentChatIdRef.current === originChatId) {
            pendingSend.acknowledgementRetried = true;
            pendingMessageDataRef.current = pendingSend;
            setProcessing(true);
            initEventSourceRef.current?.(
              buildApiUrl(`apps/${pendingSend.appId}/chat/${pendingSend.chatId}`)
            );
            return;
          }
          // Declined, or the user moved to another chat meanwhile: take the turn back.
          pendingMessageDataRef.current = null;
          if (own) {
            removeMessage(own.userMessageId);
            if (placeholderId) removeMessage(placeholderId);
            // The fork of an edit or regenerate was consumed by the first attempt: put it back,
            // so the send the user makes after confirming still replaces the stored exchange.
            const fork = pendingSend.params?.replaceFromMessageId;
            if (fork) pendingReplaceFromRef.current = fork;
            if (ok === false) onSendRefusedRef.current?.(own.args);
          } else {
            // A tool approval or a clarification answer: stop the placeholder's spinner and
            // give the approval card its question back.
            const placeholder = messagesRef.current.find(m => m.id === placeholderId);
            if (placeholder)
              updateAssistantMessage(placeholderId, placeholder.content || '', false);
            reopenToolApproval('AI_ACKNOWLEDGEMENT_REQUIRED');
          }
        });
        return;
      }
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
        } else if (CHAT_REFUSAL_MESSAGES[error.code]) {
          // A refusal of the chat itself, not of this message: the server's
          // English reason would tell the user nothing they can act on.
          const [key, fallback] = CHAT_REFUSAL_MESSAGES[error.code];
          errorMessage = t(key, fallback);
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
      detachEventSourceRef.current?.();
      setProcessing(false);
      reopenToolApproval(error?.code);
    }
  }, [
    t,
    messagesRef,
    updateAssistantMessage,
    toolApprovals,
    reopenToolApproval,
    acknowledgement,
    removeMessage,
    reopenToolApproval
  ]);

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
   * `transportFailure` is the exception, and it has to be: a stream-level
   * error carries the *chat* id as its `runId` (`syntheticStreamError` stamps
   * `runId: streamId`), so there is no run to match against. Re-attaching is
   * the case that needs it most — the turn it follows outlived the browser
   * that started it, so the connection dropping or timing out is the ordinary
   * ending, not an exceptional one. Without it the attachment stayed latched
   * forever: `onSettled` never ran, the caller never re-read the store, and
   * the chat kept a partial projection and a running badge until a reload.
   *
   * @param {string|null} runId - The run that reached a terminal frame
   * @param {Object} [options]
   * @param {boolean} [options.transportFailure=false] - Settle whatever is
   *   attached, because the stream itself failed and named no run
   */
  const settleReattachedRun = useCallback((runId, { transportFailure = false } = {}) => {
    const pending = reattachedRunRef.current;
    if (!pending || (!transportFailure && pending.runId !== runId)) return;
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

      // A tool approval answer (#2945) is used once its turn does something;
      // a turn that failed before that left the approval open, so its card
      // asks again.
      if (approvalRetryRef.current) {
        if (APPROVAL_USED_EVENTS.has(type)) {
          approvalRetryRef.current = null;
        } else if (type === RUN_EVENTS.STREAM_ERROR) {
          reopenToolApproval(data?.code);
        }
      }

      const messageId = bindRunToMessage(envelope);
      const run = getRun(streamState, runId);

      // A turn's own run (not a workflow a tool started inside it) is under way,
      // and its question is stored.
      if (type === RUN_EVENTS.RUN_STARTED && !data?.parentRunId) {
        onRunStartedRef.current?.(chatId);
      }

      if (type === RUN_EVENTS.META) {
        if (data?.title) setConversationTitle(data.title);
        if (data?.conversationId && appId && shouldPersistConversationId) {
          setConversationId(appId, data.conversationId);
        }
      }

      // Stream-level error (transport failure / error before any run started):
      // nothing to project, append the error message to the reply.
      if (type === RUN_EVENTS.STREAM_ERROR && !run) {
        // Before the early return below, which is what used to strand a
        // re-attached turn: the stream names the chat rather than the run, so
        // nothing further down could ever have matched it.
        settleReattachedRun(null, { transportFailure: true });
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
            // The turn hands control back to the user (finishReason
            // 'clarification', which the server still sends); processing stops but the clarification stays pending.
            setProcessing(false);
          }
          break;

        case RUN_EVENTS.RUN_ENDED: {
          // The answer used tokens: the usage limits shown update.
          if (!rootRun.parentRunId) void refreshMyUsage();
          // A re-attached turn is settled: hand back to the caller so it can
          // re-read the stored transcript. The replay and the live stream meet
          // at a fetch boundary, so what is on screen may be missing a delta
          // that fell in it; the store is what the answer actually was.
          settleReattachedRun(rootRun.runId);
          // Include stored metadata (customResponseRenderer, outputFormat) in the message.
          // Preserve workflow-set outputFormat — don't let the app default overwrite it.
          const metadata = {
            finishReason: rootRun.finishReason,
            ...messageMetadataRef.current,
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
            // A failed run: content already carries the stream/error message.
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
          // A refused (or failed) call may have used tokens or hit a limit.
          void refreshMyUsage();
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
      chatId,
      bindRunToMessage,
      sendPendingMessage,
      reopenToolApproval,
      settleReattachedRun,
      updateAssistantMessage,
      onMessageComplete,
      t,
      messagesRef,
      shouldPersistConversationId
    ]
  );

  const { initEventSource, detachEventSource, stopEventSource } = useEventSource({
    appId,
    chatId: chatId,
    onEvent: handleEvent,
    onProcessingChange: setProcessing,
    // True only while this surface is following a turn it did not start, which
    // is what makes the heartbeat's "nothing is running on this chat" answer
    // safe to act on. A turn this surface sent itself is briefly connected
    // before its POST lands, and acting on it there would cancel it.
    isFollowingExistingRun: () => reattachedRunRef.current !== null
  });

  // Store the detach function in a ref for access in callbacks
  detachEventSourceRef.current = detachEventSource;
  initEventSourceRef.current = initEventSource;

  /**
   * Send a chat message and start streaming the response.
   *
   * @param {Object} displayMessage - Message shown in the UI
   * @param {Object} apiMessage - Message payload for the API
   * @param {Object} params - Parameters for the request (model, style ...)
   * @param {boolean} sendChatHistory - Include full chat history in request
   * @param {Object} messageMetadata - Metadata to attach to the assistant message (e.g., customResponseRenderer)
   * @param {string[]} [requestedSkills] - Skills to pre-activate for this turn (slash command)
   */
  const sendMessage = useCallback(
    args => {
      const {
        displayMessage,
        apiMessage,
        params,
        sendChatHistory = true,
        messageMetadata = null,
        requestedSkills = null
      } = args;
      try {
        // Reset cancellation flag when starting a new message
        isCancellingRef.current = false;

        // Detach only: the server supersedes a turn still running on this chat
        // when the new message arrives, and says so in what it records.
        detachEventSource();
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

        const userMessageId = addUserMessage(contentToAdd, {
          ...displayMessage?.meta,
          // The exchange id is what the store files this turn under
          // (`clientMessageId`), so it is the only handle an edit or a
          // regenerate of a turn made in this session can fork the stored
          // history by.
          clientMessageId: exchangeId,
          imageData: apiMessage.imageData,
          fileData: apiMessage.fileData,
          audioData: apiMessage.audioData
        });
        addAssistantMessage(exchangeId);

        // Documents the server already stores (pre-uploaded from the composer,
        // or kept from an earlier turn) travel as ids; the rest inline.
        const wireFiles = splitFilesForWire(apiMessage.fileData);
        const messagesForAPI = getMessagesForApi({
          role: 'user',
          content: apiMessage.content,
          promptTemplate: apiMessage.promptTemplate || null,
          variables: apiMessage.variables || {},
          messageId: exchangeId,
          imageData: apiMessage.imageData,
          fileData: wireFiles.fileData,
          ...(wireFiles.fileIds.length > 0 ? { fileIds: wireFiles.fileIds } : {}),
          audioData: apiMessage.audioData,
          // The host item (Outlook email/meeting, the extension's page); the
          // server renders it as tagged blocks around `content`.
          ...(apiMessage.hostContext ? { hostContext: apiMessage.hostContext } : {})
        });

        // What open MCP App views reported since the last message; the server
        // hands it to the model with this turn only.
        const mcpAppContext = takeMcpAppModelContext(chatId);

        pendingMessageDataRef.current = {
          appId,
          chatId: chatId,
          messages: messagesForAPI,
          params: {
            ...params,
            ...(requestedSkills?.length ? { requestedSkills } : {}),
            ...(mcpAppContext.length > 0 ? { mcpAppContext } : {}),
            ...takeProtocolParams(sendChatHistory)
          }
        };

        lastSendRef.current = { args, userMessageId, pending: pendingMessageDataRef.current };

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
      detachEventSource,
      addUserMessage,
      addAssistantMessage,
      getMessagesForApi,
      initEventSource,
      addSystemMessage,
      takeProtocolParams,
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
        variablesToRestore = prevUser.variables || null;
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
        variablesToRestore = messageToResend.variables || null;
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

  // Read at stop time, so a turn running with no stream attached is still
  // stopped without making the callback change with every `processing` flip.
  const processingRef = useRef(false);
  // After commit, not during render: a render React discards must not leave a
  // value here that the committed state never had.
  useLayoutEffect(() => {
    processingRef.current = processing;
  }, [processing]);

  /**
   * A person stopped the turn: the one place this hook tells the server to.
   *
   * @param {string} [source] - The control that asked; anything else (a click
   *   event handed over by `onClick={cancelGeneration}`) records as the Stop button.
   */
  const cancelGeneration = useCallback(
    source => {
      // Set flag to prevent error messages during manual cancellation
      isCancellingRef.current = true;

      // Not awaited: it reports its own failure, and the UI must not wait on the network.
      stopEventSource({
        source: typeof source === 'string' ? source : 'stop-button',
        force: processingRef.current
      });

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
    },
    [stopEventSource, appendToAssistantMessage, t]
  );

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
        detachEventSource();
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
          clientMessageId: exchangeId
        });

        // Add placeholder for assistant response
        addAssistantMessage(exchangeId);

        // Build the messages for API - just the answer value (question context is in chat history)
        const messagesForAPI = getMessagesForApi({
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
      detachEventSource,
      updateAssistantMessage,
      addUserMessage,
      addAssistantMessage,
      getMessagesForApi,
      initEventSource,
      addSystemMessage,
      messagesRef,
      takeProtocolParams,
      t,
      appId,
      chatId
    ]
  );

  /**
   * Answer a tool approval (#2945): Approve, Approve and allow the tool for
   * this chat, or Reject. The decision travels as the next message
   * (`approvalResponse`); the server answers the approval exactly once and,
   * on approve, runs the stored call with the arguments shown on the card,
   * then the assistant continues in a new answer.
   *
   * @param {Object} answer
   * @param {string} answer.interactionId - The approval's interaction id
   * @param {'approve'|'reject'} answer.decision
   * @param {'chat'|null} [answer.grant] - `'chat'`: allow this tool for the rest of the chat
   * @param {Object} [params] - Parameters for the continuation request (model, style, …)
   */
  const submitToolApproval = useCallback(
    (answer, params = {}) => {
      const decided = toolApprovalAnswer(answer);
      if (!decided) return;
      const { outcome, approvalResponse } = decided;
      const { interactionId } = approvalResponse;
      const owner = messagesRef.current.find(m => m.toolApproval?.interactionId === interactionId);
      if (!owner || owner.toolApproval.decision) return;
      const toolName = owner.toolApproval.toolName || owner.toolApproval.toolId;
      // The card shows the decision instead of its buttons from here on —
      // unless the turn fails before it starts (`reopenToolApproval`).
      approvalRetryRef.current = { messageId: owner.id, toolApproval: owner.toolApproval };
      updateAssistantMessage(owner.id, owner.content || '', false, {
        toolApproval: { ...owner.toolApproval, decision: outcome },
        awaitingInput: false,
        loading: false
      });

      const displayText =
        outcome === 'rejected'
          ? t('chat.toolApproval.rejectedMessage', 'Rejected: {{tool}}', { tool: toolName })
          : outcome === 'approvedForChat'
            ? t('chat.toolApproval.approvedForChatMessage', 'Approved for this chat: {{tool}}', {
                tool: toolName
              })
            : t('chat.toolApproval.approvedMessage', 'Approved: {{tool}}', { tool: toolName });
      try {
        isCancellingRef.current = false;
        detachEventSource();
        setProcessing(true);
        const exchangeId = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        lastMessageIdRef.current = exchangeId;
        addUserMessage(displayText, {
          approvalResponse,
          isApprovalAnswer: true,
          clientMessageId: exchangeId
        });
        addAssistantMessage(exchangeId);
        pendingMessageDataRef.current = {
          appId,
          chatId,
          messages: getMessagesForApi({
            role: 'user',
            content: displayText,
            messageId: exchangeId,
            approvalResponse
          }),
          params: { ...params, ...takeProtocolParams() }
        };
        initEventSource(buildApiUrl(`apps/${appId}/chat/${chatId}`));
      } catch (err) {
        console.error('Error submitting tool approval:', err);
        addSystemMessage(
          `Error: ${t('chat.toolApproval.submitFailed', 'The decision could not be sent.')} ${
            err.message || t('error.tryAgain', 'Please try again.')
          }`,
          true
        );
        setProcessing(false);
      }
    },
    [
      detachEventSource,
      updateAssistantMessage,
      addUserMessage,
      addAssistantMessage,
      getMessagesForApi,
      initEventSource,
      addSystemMessage,
      messagesRef,
      takeProtocolParams,
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

      // Still the chat this replay was started for? The chat switch itself has
      // already reset the stream state and the busy flag for the new chat.
      const stillCurrent = () => currentChatIdRef.current === chatId;

      let ended = false;
      try {
        const { events } = await fetchAllLedgerEvents(async (cursor, limit) => {
          const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
          const res = await fetchWithAuthRetry(
            buildApiUrl(
              `runs/${encodeURIComponent(runId)}/events?limit=${limit}${cursorParam}&view=sse`
            ),
            { method: 'GET', headers: { Accept: 'application/json' } }
          );
          if (!res.ok) throw new Error(`Run replay failed (${res.status})`);
          return res.json();
        });
        for (const envelope of events) {
          if (!stillCurrent()) return false;
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

      if (!stillCurrent()) return false;

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
    // True while the stored transcript is still being fetched, so a
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
    submitToolApproval,
    loadServerMessages,
    reattachToRun,
    resetConversationState,
    // Local turns built outside the chat pipeline: a transcription model's
    // turn (the audio's name, then the transcript as the answer), whose audio
    // goes over the realtime socket rather than the chat request.
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    removeMessage
  };
}

export default useAppChat;
