import { useRef, useCallback, useEffect } from 'react';
import { checkAppChatStatus, stopAppChatStream } from '../../api/api';

/**
 * Hook for handling Server Sent Events.
 * It forwards all received events to the provided onEvent callback.
 */
function useEventSource({ appId, chatId, timeoutDuration = 10000, onEvent, onProcessingChange }) {
  const eventSourceRef = useRef(null);
  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const fullContentRef = useRef('');

  const cleanupEventSource = useCallback(async () => {
    if (eventSourceRef.current) {
      const ev = eventSourceRef.current;
      eventSourceRef.current = null;

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

      try {
        if (appId && chatId) {
          await stopAppChatStream(appId, chatId);
        }
      } catch (err) {
        console.warn('Failed to stop chat stream:', err);
      }

      try {
        if (ev) {
          if (ev.__handlers && ev.__handlers.events) {
            ev.__handlers.events.forEach(evt =>
              ev.removeEventListener(evt, ev.__handlers.handleEvent)
            );
          }
          ev.onmessage = null;
          ev.onerror = null;
          ev.close();
        }
      } catch (err) {
        console.error('Error cleaning up event source:', err);
      }
    }
  }, [appId, chatId]);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
    heartbeatIntervalRef.current = setInterval(async () => {
      if (!eventSourceRef.current || !appId || !chatId) return;
      try {
        const status = await checkAppChatStatus(appId, chatId);
        if (!status || !status.active) {
          cleanupEventSource();
          if (onProcessingChange) onProcessingChange(false);
        }
      } catch (err) {
        console.warn('Error checking chat status:', err);
      }
    }, 30000);
  }, [appId, chatId, cleanupEventSource, onProcessingChange]);

  const initEventSource = useCallback(
    url => {
      cleanupEventSource();
      fullContentRef.current = '';
      if (onProcessingChange) onProcessingChange(true);

      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;
      let connectionEstablished = false;

      connectionTimeoutRef.current = setTimeout(() => {
        if (!connectionEstablished) {
          console.error('SSE connection timeout');
          eventSource.close();
          if (onEvent)
            onEvent({ type: 'error', data: { message: 'Connection timeout. Please try again.' } });
          if (onProcessingChange) onProcessingChange(false);
        }
      }, timeoutDuration);

      const handleEvent = event => {
        let data = null;
        if (event.data) {
          try {
            data = JSON.parse(event.data);
          } catch {
            data = event.data;
          }
        }
        if (event.type === 'chunk' && data && data.content) {
          fullContentRef.current += data.content;
        }
        if (event.type === 'connected') {
          connectionEstablished = true;
          clearTimeout(connectionTimeoutRef.current);
        } else if (event.type === 'done') {
          connectionEstablished = true;
        }
        if (onEvent) onEvent({ type: event.type, data, fullContent: fullContentRef.current });
        if (event.type === 'done' || event.type === 'error') {
          eventSource.close();
          eventSourceRef.current = null;
          if (onProcessingChange) onProcessingChange(false);
        }
      };

      const events = [
        'connected',
        'chunk',
        'done',
        'error',
        'processing',
        'research-start',
        'research-query-analysis',
        'research-round',
        'research-results',
        'research-fetch',
        'research-fetched',
        'research-refine',
        'research-refined',
        'research-complete',
        'research-error'
      ];

      events.forEach(evt => eventSource.addEventListener(evt, handleEvent));
      eventSource.onmessage = handleEvent;
      eventSource.onerror = handleEvent;
      eventSource.__handlers = { handleEvent, events };

      startHeartbeat();
      return eventSource;
    },
    [cleanupEventSource, onProcessingChange, onEvent, startHeartbeat, timeoutDuration]
  );

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
    isConnected: !!eventSourceRef.current
  };
}

export default useEventSource;
