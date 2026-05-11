import { useRef, useCallback, useEffect } from 'react';
import { checkAppChatStatus, stopAppChatStream } from '../../api/api';
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
function useEventSource({ appId, chatId, timeoutDuration = 60000, onEvent, onProcessingChange }) {
  // Stores the AbortController for the active fetch stream — non-null == connected
  const abortControllerRef = useRef(null);
  // Exposed as eventSourceRef for backward-compatible isConnected check by callers
  const eventSourceRef = abortControllerRef;

  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const fullContentRef = useRef('');

  const cleanupEventSource = useCallback(async () => {
    const ac = abortControllerRef.current;
    if (!ac) return;

    abortControllerRef.current = null;

    // Clear timers
    try {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    } catch (err) {
      console.error('Error clearing heartbeat interval:', err);
    }

    try {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    } catch (err) {
      console.error('Error clearing connection timeout:', err);
    }

    // Tell the server to stop streaming
    try {
      if (appId && chatId) {
        await stopAppChatStream(appId, chatId);
      }
    } catch (err) {
      console.warn('Failed to stop chat stream:', err);
    }

    // Abort the fetch
    try {
      ac.abort();
    } catch (err) {
      console.error('Error aborting SSE fetch:', err);
    }
  }, [appId, chatId]);

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

  /**
   * Open the SSE stream to the given URL.
   * Caller does not need to await — errors are reported via onEvent.
   *
   * @param {string} url - SSE endpoint URL (absolute or relative)
   */
  const initEventSource = useCallback(
    async url => {
      // Clean up any existing stream first
      if (abortControllerRef.current) {
        await cleanupEventSource();
      }

      fullContentRef.current = '';
      if (onProcessingChange) onProcessingChange(true);

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
        let res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...getAuthHeaders()
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
              ...getAuthHeaders()
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
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
        startHeartbeat();

        const handleSseEvent = (name, data) => {
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupEventSource();
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    };
  }, [cleanupEventSource]);

  return {
    initEventSource,
    cleanupEventSource,
    eventSourceRef,
    isConnected: !!abortControllerRef.current
  };
}

export default useEventSource;
