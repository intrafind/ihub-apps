import { useRef, useCallback, useEffect } from 'react';
import { checkAppChatStatus, stopAppChatStream } from '../../api';
import {
  openSseStream,
  toRunEnvelope,
  syntheticStreamError,
  TRANSPORT_ERROR_CODES
} from '../utils/openSseStream';
import { RUN_EVENTS } from '../../../../shared/run/runReducer.js';

/**
 * Chat stream transport (SSE v2) on top of the shared fetch-based
 * `openSseStream` transport (Bearer header + 401 refresh for the Office
 * add-in, no native EventSource).
 *
 * Delivers every frame as `onEvent({ type, envelope })` where `envelope` is
 * the SSE v2 envelope `{ v: 2, seq, runId, ts, type, data }`. Transport
 * failures (timeout, network, non-OK response) are delivered as synthetic
 * `stream/error` envelopes so consumers only ever see one dialect.
 *
 * Terminal frames: `run/ended` of the turn's run and `stream/error` close the
 * fetch (release the HTTP/1.1 connection slot) and flip processing to false.
 * Also includes connection timeout and the chat heartbeat
 * (`checkAppChatStatus`).
 *
 * **This hook never stops a turn on its own.** A turn is stopped by a person
 * (the Stop button, through {@link stopEventSource}) or by the server. Timing
 * out, a failing heartbeat, replacing a stream, switching chats and unmounting
 * only *detach*: they close this surface's fetch and send nothing. The stop
 * endpoint is the unconditional abort — it ends a stored turn too — so a client
 * that sent it from those paths could cancel a scheduled run someone merely
 * opened. A turn nobody can read (an ephemeral chat) is ended by the server
 * when it sees the connection close.
 *
 * @param {Object} options
 * @param {string} options.appId - App ID (used for heartbeat + stop)
 * @param {string} options.chatId - Chat session ID (stream id; heartbeat + stop)
 * @param {number} [options.timeoutDuration=60000] - Connection timeout in ms
 * @param {Function} options.onEvent - Called for each SSE v2 frame: ({ type, envelope })
 * @param {Function} [options.onProcessingChange] - Called with true/false as stream starts/stops
 * @param {Function} [options.isFollowingExistingRun] - Whether this stream is
 *   following a turn it did not start. Only then does the heartbeat treat "the
 *   server is running nothing on this chat" as a reason to stop — see
 *   {@link startHeartbeat}.
 */
function useEventSource({
  appId,
  chatId,
  timeoutDuration = 60000,
  onEvent,
  onProcessingChange,
  isFollowingExistingRun
}) {
  // Stores the AbortController for the active fetch stream — non-null == connected
  const abortControllerRef = useRef(null);
  // Exposed as eventSourceRef for backward-compatible isConnected check by callers
  const eventSourceRef = abortControllerRef;

  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  // The stream whose Stop is on its way to the server: it delivers no more
  // frames, but stays open until the server has the stop (see stopEventSource).
  const stoppingRef = useRef(null);

  // Synchronously release the connection slot: abort the fetch and clear timers.
  // Kept separate from cleanupEventSource so callers (and initEventSource) can
  // tear the slot down without awaiting a 30s axios round-trip — that delay
  // re-opened the original leak window (an in-flight fetch keeps holding its
  // HTTP/1.1 slot until ac.abort() actually runs).
  const clearTimers = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
  }, []);

  const abortAndClearTimers = useCallback(() => {
    const ac = abortControllerRef.current;
    abortControllerRef.current = null;
    clearTimers();

    if (ac) {
      try {
        ac.abort();
      } catch {
        // already aborted — nothing to do
      }
    }

    return !!ac;
  }, [clearTimers]);

  /**
   * Let go of the stream: close this surface's fetch and drop its timers. The
   * server is told nothing — it sees the connection close, and a stored turn
   * keeps running.
   */
  const detachEventSource = abortAndClearTimers;

  /**
   * Stop the turn on the server, because a person asked to (the Stop button).
   * The only path in this hook that sends the stop request.
   *
   * @param {Object} [options]
   * @param {string} [options.source='stop-button'] - The control that asked; the server records it
   * @param {boolean} [options.force=false] - Also send it when this surface has no stream open
   *   (a turn running with nobody attached still has to be stoppable)
   */
  const stopEventSource = useCallback(
    async ({ source = 'stop-button', force = false } = {}) => {
      // The server gets the stop while this stream is still open. A turn that
      // is not stored ends the moment the server sees its stream close, and that
      // end is recorded as "the browser disconnected" — closing first would let
      // it win over the attributed stop. Frames stop being delivered at once, so
      // the UI does not keep drawing a turn the user stopped.
      const ac = abortControllerRef.current;
      stoppingRef.current = ac;
      clearTimers();
      if ((ac || force) && appId && chatId) {
        try {
          await stopAppChatStream(appId, chatId, { source });
        } catch (err) {
          console.warn('Failed to stop chat stream:', err);
        }
      }
      // Close the stream that was open when Stop was pressed, not one opened since.
      if (abortControllerRef.current === ac) abortAndClearTimers();
      if (stoppingRef.current === ac) stoppingRef.current = null;
    },
    [appId, chatId, abortAndClearTimers, clearTimers]
  );

  /**
   * Poll the server for whether this chat's stream is still worth holding.
   *
   * `active` answers whether the server still has this client's stream, which
   * is the original question. `processing` answers whether anything is
   * actually producing on the chat, and it is only trustworthy as a stop
   * signal for a stream that is *following* a turn it did not start.
   *
   * That distinction matters. A stream this surface opened for its own turn is
   * briefly connected before the turn's POST reaches the server, and treating
   * `processing: false` as terminal there would cancel the turn the user just
   * sent. But a surface re-attached to a chat the store says is running has
   * nothing of its own in flight, and "the server is running nothing" is then
   * the whole answer: the turn ended in a process that died before it could
   * write a terminal frame. Without this the SSE connects, no frame ever
   * arrives, and the chat renders as generating — with the composer disabled
   * behind a Stop button — on every single open, forever.
   */
  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
    heartbeatIntervalRef.current = setInterval(async () => {
      if (!abortControllerRef.current || !appId || !chatId) return;
      try {
        const status = await checkAppChatStatus(appId, chatId);
        const idle =
          status?.active && status.processing === false && isFollowingExistingRun?.() === true;
        if (!status || !status.active || idle) {
          // Detach only: the server has nothing running on this chat (or no
          // longer holds this stream), so there is nothing to stop.
          detachEventSource();
          if (onProcessingChange) onProcessingChange(false);
        }
      } catch (err) {
        console.warn('Error checking chat status:', err);
      }
    }, 60000);
  }, [appId, chatId, detachEventSource, onProcessingChange, isFollowingExistingRun]);

  /**
   * Open the SSE stream to the given URL.
   * Caller does not need to await — errors are reported via onEvent as
   * synthetic `stream/error` envelopes.
   *
   * @param {string} url - SSE endpoint URL (absolute or relative)
   */
  const initEventSource = useCallback(
    async url => {
      // Synchronously detach any prior stream first. Only detach: the server
      // sees the old connection close, and the turn the new stream follows or
      // starts supersedes whatever was still running. Telling it to stop here
      // would abort a stored turn this surface is merely re-attaching to.
      abortAndClearTimers();

      if (onProcessingChange) onProcessingChange(true);

      const ac = new AbortController();
      abortControllerRef.current = ac;

      let connectionEstablished = false;
      // The run of this turn: first top-level `run/started` on this connection.
      // Only ITS `run/ended` closes the stream (a chat-launched child run
      // ending must not end the turn).
      let turnRunId = null;

      const emit = envelope => {
        if (stoppingRef.current === ac) return;
        if (onEvent) onEvent({ type: envelope.type, envelope });
      };

      const releaseSlot = () => {
        abortControllerRef.current = null;
        if (onProcessingChange) onProcessingChange(false);
        // Release the browser's HTTP/1.1 connection slot. Without this the
        // fetch sits in the pool until TCP keep-alive times out; opening 2
        // streams per round in compare mode hits the 6-connection limit by
        // the third message and the whole UI appears to hang.
        try {
          ac.abort();
        } catch {
          // already aborted — nothing to do
        }
      };

      connectionTimeoutRef.current = setTimeout(() => {
        if (!connectionEstablished) {
          console.error('SSE connection timeout');
          detachEventSource();
          emit(
            syntheticStreamError(
              chatId,
              'Connection timeout. Please try again.',
              TRANSPORT_ERROR_CODES.TIMEOUT
            )
          );
          if (onProcessingChange) onProcessingChange(false);
        }
      }, timeoutDuration);

      try {
        await openSseStream(url, {
          signal: ac.signal,
          onOpen: () => {
            connectionEstablished = true;
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
            startHeartbeat();
          },
          onEvent: (name, data) => {
            const envelope = toRunEnvelope(name, data, chatId);
            if (!envelope) return;

            if (envelope.type === RUN_EVENTS.STREAM_CONNECTED) {
              connectionEstablished = true;
            }
            if (
              envelope.type === RUN_EVENTS.RUN_STARTED &&
              !turnRunId &&
              !envelope.data?.parentRunId
            ) {
              turnRunId = envelope.runId;
            }

            emit(envelope);

            const isTurnEnd =
              envelope.type === RUN_EVENTS.RUN_ENDED &&
              (!turnRunId || envelope.runId === turnRunId);
            if (isTurnEnd || envelope.type === RUN_EVENTS.STREAM_ERROR) {
              releaseSlot();
            }
          }
        });
      } catch (err) {
        // AbortError means we cancelled intentionally — not an error to report
        if (err.name === 'AbortError') return;

        console.error('SSE stream error:', err);
        emit(
          syntheticStreamError(
            chatId,
            err.message || 'Streaming connection failed. Please try again.',
            err.status ? TRANSPORT_ERROR_CODES.HTTP : TRANSPORT_ERROR_CODES.CONNECTION,
            err.status ? { status: err.status, body: err.body ?? null } : undefined
          )
        );
        if (onProcessingChange) onProcessingChange(false);
      } finally {
        // Always abort the controller — release the HTTP/1.1 connection slot.
        // The terminal-frame path already aborts on the happy path; this
        // finally covers the failure paths (mid-stream network error,
        // malformed event, exception thrown by the consumer's onEvent
        // callback) that would otherwise leave the fetch hanging in the
        // browser's connection pool until TCP keep-alive expires.
        try {
          ac.abort();
        } catch {
          // already aborted — nothing to do
        }
        // Ensure we don't hold a stale abort controller after the stream ends
        if (abortControllerRef.current === ac) {
          abortControllerRef.current = null;
        }
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
      }
    },
    [
      abortAndClearTimers,
      chatId,
      detachEventSource,
      onProcessingChange,
      onEvent,
      startHeartbeat,
      timeoutDuration
    ]
  );

  // Whether this hook is still mounted. Declared before the teardown effect so
  // its cleanup runs first: React destroys effects in declaration order, so by
  // the time the teardown below runs on a real unmount this is already false,
  // while a mere dependency change leaves it true.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Read through a ref so the teardown below stays keyed on the stream's
  // identity alone: an unstable callback in the dependency array would abort a
  // live stream on an unrelated re-render.
  const onProcessingChangeRef = useRef(onProcessingChange);
  onProcessingChangeRef.current = onProcessingChange;

  // Teardown. This effect is keyed on the stream's identity, so it also runs
  // when the surface stays mounted and simply switches to another chat —
  // `/apps/:appId/c/:chatId` does exactly that.
  //
  // Both cases only detach: release the HTTP slot and drop the timers, and on a
  // switch report the turn as no longer processing *here*, so the composer of
  // the chat just opened is not stuck behind a Stop button. Nothing is sent to
  // the server. A stored chat's turn must outlive this surface; an ephemeral
  // one has nobody left to read it, and the server ends it when it sees the
  // connection close. Only the Stop button (`stopEventSource`) tells the server
  // to stop.
  useEffect(() => {
    return () => {
      const wasActive = abortAndClearTimers();
      if (mountedRef.current && wasActive) onProcessingChangeRef.current?.(false);
    };
  }, [abortAndClearTimers, appId, chatId]);

  return {
    initEventSource,
    detachEventSource,
    stopEventSource,
    eventSourceRef,
    isConnected: !!abortControllerRef.current
  };
}

export default useEventSource;
