import { useRef, useCallback, useEffect } from 'react';
import { checkAppChatStatus, stopAppChatStream } from '../../api';
import { parseSseStream } from '../utils/parseSseStream';
import { getRefreshToken, refreshTokenOrExpireSession } from '../../features/office/api/officeAuth';

/**
 * Hook for handling Server Sent Events via fetch + ReadableStream.
 *
 * Uses fetch instead of native EventSource so that custom Authorization headers
 * can be injected (required for Office add-in Bearer token auth and any other
 * token-based auth flows). Includes connection timeout, heartbeat, and cleanup
 * matching the robustness of native EventSource usage.
 *
 * @param {Object} options
 * @param {string} options.appId - App ID (used for heartbeat + cleanup)
 * @param {string} options.chatId - Chat session ID (used for heartbeat + cleanup)
 * @param {number} [options.timeoutDuration=60000] - Connection timeout in ms
 * @param {Function} options.onEvent - Called for each SSE event: ({ type, data, fullContent })
 * @param {Function} [options.onProcessingChange] - Called with true/false as stream starts/stops
 */
// How many times a dropped stream auto-reconnects (with Last-Event-ID) before
// giving up and surfacing an error to the user, and the backoff between tries.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS_MS = [500, 1500, 3000];

function useEventSource({ appId, chatId, timeoutDuration = 60000, onEvent, onProcessingChange }) {
  // Stores the AbortController for the active fetch stream — non-null == connected
  const abortControllerRef = useRef(null);
  // Exposed as eventSourceRef for backward-compatible isConnected check by callers
  const eventSourceRef = abortControllerRef;

  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const fullContentRef = useRef('');

  // Last SSE `id:` seen, sent back as `Last-Event-ID` on an auto-reconnect so
  // the server can replay whatever was buffered while the connection was down.
  const lastEventIdRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  // Bumped on every explicit initEventSource()/cleanup so a reconnect that was
  // scheduled against a now-abandoned stream knows to no-op instead of firing.
  const generationRef = useRef(0);

  // Synchronously release the connection slot: abort the fetch and clear timers.
  // Kept separate from cleanupEventSource so callers (and initEventSource) can
  // tear the slot down without awaiting a 30s axios round-trip — that delay
  // re-opened the original leak window (an in-flight fetch keeps holding its
  // HTTP/1.1 slot until ac.abort() actually runs).
  const abortAndClearTimers = useCallback(() => {
    const ac = abortControllerRef.current;
    abortControllerRef.current = null;
    generationRef.current += 1;

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
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
   * Build auth headers for the SSE fetch request.
   * Mirrors the behavior of apiClient's request interceptor:
   * - Reads `authToken` from localStorage (main app session)
   * - Falls back to `office_ihubtoken` (Office add-in PKCE token)
   */
  const getAuthHeaders = useCallback(() => {
    const token =
      localStorage.getItem('office_ihubtoken') || localStorage.getItem('authToken') || null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  // Holds the latest attemptConnect so a setTimeout-scheduled reconnect always
  // calls the current closure, not a stale one from the render that scheduled it.
  const attemptConnectRef = useRef(null);

  /**
   * Open (or resume) the SSE stream at url.
   * `isReconnect: true` sends `Last-Event-ID` (if we have one) so the server
   * replays whatever was buffered while the connection was down, and skips
   * resetting fullContentRef/lastEventIdRef so accumulated state carries over.
   * `generation` is the generationRef snapshot this attempt belongs to — if it
   * no longer matches generationRef.current when a retry would fire, the
   * stream has been superseded (new initEventSource call, explicit stop, or
   * unmount) and the scheduled retry silently no-ops.
   */
  const attemptConnect = useCallback(
    async (url, { isReconnect = false, generation } = {}) => {
      const ac = new AbortController();
      abortControllerRef.current = ac;

      let connectionEstablished = false;

      connectionTimeoutRef.current = setTimeout(() => {
        if (!connectionEstablished) {
          console.error('SSE connection timeout');
          cleanupEventSource();
          if (onEvent) {
            onEvent({
              type: 'error',
              data: { message: 'Connection timeout. Please try again.' },
              fullContent: fullContentRef.current
            });
          }
          if (onProcessingChange) onProcessingChange(false);
        }
      }, timeoutDuration);

      try {
        const resumeHeaders =
          isReconnect && lastEventIdRef.current != null
            ? { 'Last-Event-ID': String(lastEventIdRef.current) }
            : {};

        let res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...getAuthHeaders(),
            ...resumeHeaders
          },
          credentials: 'include',
          signal: ac.signal
        });

        // For the Office add-in: attempt a silent token refresh on 401 and retry once.
        // Keyed off getRefreshToken() so the refresh is attempted even when the
        // access token is already gone (expired and removed) but a refresh token exists.
        // refreshTokenOrExpireSession() invokes the session-expired callback and throws
        // if the refresh itself fails, letting the outer catch report the error.
        if (res.status === 401 && getRefreshToken()) {
          await refreshTokenOrExpireSession();
          res = await fetch(url, {
            method: 'GET',
            headers: {
              Accept: 'text/event-stream',
              ...getAuthHeaders(),
              ...resumeHeaders
            },
            credentials: 'include',
            signal: ac.signal
          });
        }

        if (!res.ok) {
          let body = null;
          try {
            body = await res.json();
          } catch {
            // ignore parse error
          }
          throw Object.assign(
            new Error((body && body.message) || `SSE connection failed (${res.status})`),
            { status: res.status, body }
          );
        }

        if (!res.body) {
          throw new Error('SSE response has no readable body');
        }

        connectionEstablished = true;
        // A fresh successful connection resets the retry budget — only
        // *consecutive* drops should count against MAX_RECONNECT_ATTEMPTS.
        reconnectAttemptRef.current = 0;
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
        startHeartbeat();

        const handleSseEvent = (name, data, id) => {
          if (id !== undefined) {
            lastEventIdRef.current = id;
          }
          if (name === 'connected') {
            connectionEstablished = true;
          }
          if (name === 'chunk' && data && data.content) {
            fullContentRef.current += data.content;
          }
          if (onEvent) {
            onEvent({ type: name, data, fullContent: fullContentRef.current });
          }
          if (name === 'done' || name === 'error') {
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
          }
        };

        await parseSseStream(res.body, handleSseEvent, ac.signal);
      } catch (err) {
        // AbortError means we cancelled intentionally — not an error to report
        if (err.name === 'AbortError') return;

        const stillCurrent = generationRef.current === generation;
        const canRetry = stillCurrent && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS;

        if (canRetry) {
          const attempt = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = attempt;
          const delay =
            RECONNECT_DELAYS_MS[attempt - 1] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
          console.warn(
            `SSE stream interrupted, reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms:`,
            err.message
          );
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            if (generationRef.current !== generation) return; // superseded — no-op
            attemptConnectRef.current?.(url, { isReconnect: true, generation });
          }, delay);
          return;
        }

        console.error('SSE stream error:', err);
        if (onEvent) {
          onEvent({
            type: 'error',
            data: { message: err.message || 'Streaming connection failed. Please try again.' },
            fullContent: fullContentRef.current
          });
        }
        if (onProcessingChange) onProcessingChange(false);
      } finally {
        // Always abort the controller — release the HTTP/1.1 connection slot.
        // The handleSseEvent 'done'/'error' path already aborts on the happy
        // path; this finally covers the failure paths (mid-stream network
        // error, malformed event, exception thrown by the consumer's onEvent
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
      cleanupEventSource,
      onProcessingChange,
      onEvent,
      startHeartbeat,
      timeoutDuration,
      getAuthHeaders
    ]
  );

  useEffect(() => {
    attemptConnectRef.current = attemptConnect;
  }, [attemptConnect]);

  /**
   * Open the SSE stream to the given URL.
   * Caller does not need to await — errors are reported via onEvent.
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

      fullContentRef.current = '';
      lastEventIdRef.current = null;
      reconnectAttemptRef.current = 0;
      if (onProcessingChange) onProcessingChange(true);

      await attemptConnect(url, { isReconnect: false, generation: generationRef.current });
    },
    [abortAndClearTimers, appId, chatId, onProcessingChange, attemptConnect]
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
