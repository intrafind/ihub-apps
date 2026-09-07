import { useRef, useCallback, useEffect } from 'react';
import { checkAppChatStatus, stopAppChatStream } from '../../api';
import {
  openSseStream,
  toRunEnvelope,
  syntheticStreamError,
  TRANSPORT_ERROR_CODES
} from '../utils/openSseStream';
import { RUN_EVENTS } from '../run/runReducer';

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
 * Also includes connection timeout, the chat heartbeat (`checkAppChatStatus`)
 * and `stopAppChatStream` on cleanup.
 *
 * @param {Object} options
 * @param {string} options.appId - App ID (used for heartbeat + cleanup)
 * @param {string} options.chatId - Chat session ID (stream id; heartbeat + cleanup)
 * @param {number} [options.timeoutDuration=60000] - Connection timeout in ms
 * @param {Function} options.onEvent - Called for each SSE v2 frame: ({ type, envelope })
 * @param {Function} [options.onProcessingChange] - Called with true/false as stream starts/stops
 */
function useEventSource({ appId, chatId, timeoutDuration = 60000, onEvent, onProcessingChange }) {
  // Stores the AbortController for the active fetch stream — non-null == connected
  const abortControllerRef = useRef(null);
  // Exposed as eventSourceRef for backward-compatible isConnected check by callers
  const eventSourceRef = abortControllerRef;

  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);

  // Synchronously release the connection slot: abort the fetch and clear timers.
  // Kept separate from cleanupEventSource so callers (and initEventSource) can
  // tear the slot down without awaiting a 30s axios round-trip — that delay
  // re-opened the original leak window (an in-flight fetch keeps holding its
  // HTTP/1.1 slot until ac.abort() actually runs).
  const abortAndClearTimers = useCallback(() => {
    const ac = abortControllerRef.current;
    abortControllerRef.current = null;

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }

    if (ac) {
      try {
        ac.abort();
      } catch {
        // already aborted — nothing to do
      }
    }

    return !!ac;
  }, []);

  const cleanupEventSource = useCallback(async () => {
    const wasActive = abortAndClearTimers();

    // Best-effort notification to the server. Fire-and-forget — the server
    // detects the disconnect via req.on('close') regardless, and we don't want
    // a slow /stop call to delay the next stream the caller may immediately
    // open (rapid send-button clicks would otherwise race; see B2 in audit).
    if (wasActive && appId && chatId) {
      try {
        await stopAppChatStream(appId, chatId);
      } catch (err) {
        console.warn('Failed to stop chat stream:', err);
      }
    }
  }, [appId, chatId, abortAndClearTimers]);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
    heartbeatIntervalRef.current = setInterval(async () => {
      if (!abortControllerRef.current || !appId || !chatId) return;
      try {
        const status = await checkAppChatStatus(appId, chatId);
        if (!status || !status.active) {
          cleanupEventSource();
          if (onProcessingChange) onProcessingChange(false);
        }
      } catch (err) {
        console.warn('Error checking chat status:', err);
      }
    }, 60000);
  }, [appId, chatId, cleanupEventSource, onProcessingChange]);

  /**
   * Open the SSE stream to the given URL.
   * Caller does not need to await — errors are reported via onEvent as
   * synthetic `stream/error` envelopes.
   *
   * @param {string} url - SSE endpoint URL (absolute or relative)
   */
  const initEventSource = useCallback(
    async url => {
      // Synchronously tear down any prior stream first. We deliberately do NOT
      // `await cleanupEventSource()` here — that awaits stopAppChatStream
      // (axios, 30s timeout), and during that window a re-entrant call would
      // see abortControllerRef.current === null and proceed in parallel,
      // orphaning the first controller (no ref left to abort it on unmount).
      const hadPrior = abortAndClearTimers();
      if (hadPrior && appId && chatId) {
        // Notify the server in the background; do not block the new stream.
        stopAppChatStream(appId, chatId).catch(err =>
          console.warn('Failed to stop prior chat stream:', err)
        );
      }

      if (onProcessingChange) onProcessingChange(true);

      const ac = new AbortController();
      abortControllerRef.current = ac;

      let connectionEstablished = false;
      // The run of this turn: first top-level `run/started` on this connection.
      // Only ITS `run/ended` closes the stream (a chat-launched child run
      // ending must not end the turn).
      let turnRunId = null;

      const emit = envelope => {
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
          cleanupEventSource();
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
      appId,
      chatId,
      cleanupEventSource,
      onProcessingChange,
      onEvent,
      startHeartbeat,
      timeoutDuration
    ]
  );

  // Cleanup on unmount — release the slot synchronously, then notify the server
  // in the background. Awaiting the public async cleanup here would race the
  // browser navigation; abortAndClearTimers is enough to free the connection.
  useEffect(() => {
    return () => {
      abortAndClearTimers();
      if (appId && chatId) {
        stopAppChatStream(appId, chatId).catch(() => {
          // server may be unreachable on tab close — best effort only
        });
      }
    };
  }, [abortAndClearTimers, appId, chatId]);

  return {
    initEventSource,
    cleanupEventSource,
    eventSourceRef,
    isConnected: !!abortControllerRef.current
  };
}

export default useEventSource;
