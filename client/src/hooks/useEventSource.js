import { useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { checkAppChatStatus, stopAppChatStream } from '../api/api';

/**
 * A custom hook for managing EventSource (SSE) connections in chat applications
 * 
 * @param {Object} options - Configuration options for the event source
 * @param {string} options.appId - The ID of the application
 * @param {string} options.chatId - The ID of the chat session
 * @param {number} options.timeoutDuration - Timeout duration in milliseconds
 * @param {Function} options.onChunk - Callback for when a chunk of data is received
 * @param {Function} options.onDone - Callback for when the stream is complete. Receives (content, info)
 * @param {Function} options.onError - Callback for when an error occurs
 * @param {Function} options.onConnected - Callback for when the connection is established
 * @param {Function} options.onProcessingChange - Callback to update processing state
 * @returns {Object} The event source management methods and references
 */
function useEventSource({
  appId,
  chatId,
  timeoutDuration = 10000,
  onChunk,
  onDone,
  onError,
  onConnected,
  onProcessingChange
}) {
  const { t } = useTranslation();
  const eventSourceRef = useRef(null);
  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const fullContentRef = useRef('');
  const onConnectedRef = useRef(onConnected);

  // Update refs when callbacks change
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  // Clean up function to properly handle event source resources
  const cleanupEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      try {
        // Stop any running heartbeat checks
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }

        // Clear any pending connection timeouts
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }

        // Tell the server to stop processing this chat session
        if (appId && chatId) {
          stopAppChatStream(appId, chatId).catch((err) =>
            console.warn('Failed to stop chat stream:', err)
          );
        }

        // Close the event source connection
        const eventSource = eventSourceRef.current;
        eventSourceRef.current = null; // Set to null first to prevent potential recursion issues

        // Remove all event listeners to prevent memory leaks
        if (eventSource) {
          eventSource.removeEventListener('connected', eventSource.onconnected);
          eventSource.removeEventListener('chunk', eventSource.onchunk);
          eventSource.removeEventListener('done', eventSource.ondone);
          eventSource.removeEventListener('error', eventSource.onerror);

          // Finally close the connection
          eventSource.close();
          console.log('Successfully cleaned up event source for chat:', chatId);
        }
      } catch (err) {
        console.error('Error cleaning up event source:', err);
      }
    }
  }, [appId, chatId]);

  // Start a heartbeat check to ensure server connection is still alive
  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    heartbeatIntervalRef.current = setInterval(async () => {
      if (!eventSourceRef.current || !appId || !chatId) {
        return;
      }

      try {
        const status = await checkAppChatStatus(appId, chatId);
        if (!status || !status.active) {
          console.warn('Chat session no longer active on server, cleaning up');
          cleanupEventSource();
          if (onProcessingChange) {
            onProcessingChange(false);
          }
        }
      } catch (error) {
        console.warn('Error checking chat status:', error);
        // Don't cleanup on error check - it might be a temporary network issue
      }
    }, 30000); // Check every 30 seconds

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
  }, [appId, chatId, cleanupEventSource, onProcessingChange]);

  // Initialize an EventSource connection
  const initEventSource = useCallback((url, messageHandler) => {
    cleanupEventSource();
    
    fullContentRef.current = '';
    
    if (onProcessingChange) {
      onProcessingChange(true);
    }
    
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;
    
    let connectionEstablished = false;
    
    connectionTimeoutRef.current = setTimeout(() => {
      if (!connectionEstablished) {
        console.error('SSE connection timeout');
        eventSource.close();
        
        if (onError) {
          onError(new Error('Connection timeout. Please try again.'));
        }
        
        if (onProcessingChange) {
          onProcessingChange(false);
        }
      }
    }, timeoutDuration);
    
    eventSource.onconnected = (event) => {
      connectionEstablished = true;
      clearTimeout(connectionTimeoutRef.current);
      
      // Call the onConnected callback passed as a prop
      if (onConnectedRef.current) {
        console.log('Connection established, calling onConnected callback');
        onConnectedRef.current(event);
      }

      // Call the additional message handler if provided
      if (messageHandler && typeof messageHandler === 'function') {
        messageHandler(event);
      }
    };
    
    eventSource.addEventListener('connected', eventSource.onconnected);
    
    eventSource.onchunk = (event) => {
      try {
        const data = JSON.parse(event.data);
        fullContentRef.current += data.content || '';
        
        if (onChunk) {
          onChunk(fullContentRef.current, data);
        }
      } catch (error) {
        console.error('Error processing chunk:', error);
      }
    };
    
    eventSource.addEventListener('chunk', eventSource.onchunk);
    
    eventSource.ondone = (event) => {
      console.log('✅ SSE done event received');
      let info = {};
      if (event.data) {
        try {
          info = JSON.parse(event.data);
        } catch (e) {
          console.warn('❌ Failed to parse done event data:', e);
        }
      }
      
      if (onDone) {
        onDone(fullContentRef.current, info);
      }
      
      eventSource.close();
      eventSourceRef.current = null;
      
      if (onProcessingChange) {
        onProcessingChange(false);
      }
    };
    
    eventSource.addEventListener('done', eventSource.ondone);
    
    eventSource.onerror = (event) => {
      console.error('SSE Error:', event);
      clearTimeout(connectionTimeoutRef.current);

      let errorMessage = t('error.general', 'Error receiving response. Please try again.');

      try {
        if (event.data) {
          const errorData = JSON.parse(event.data);
          if (errorData.code) {
            const translated = t(`toolErrors.${errorData.code}`, `toolErrors.${errorData.code}`);
            if (translated && translated !== `toolErrors.${errorData.code}`) {
              errorMessage = translated;
            } else if (errorData.message) {
              errorMessage = errorData.message;
            }
          } else if (errorData.message) {
            errorMessage = errorData.message;
          }
        }
      } catch (e) {
        // Use default error message if parsing fails
      }
      
      if (onError) {
        onError(new Error(errorMessage), event);
      }
      
      eventSource.close();
      eventSourceRef.current = null;
      
      if (onProcessingChange) {
        onProcessingChange(false);
      }
    };
    
    eventSource.addEventListener('error', eventSource.onerror);
    
    // Start heartbeat to periodically check connection status
    startHeartbeat();
    
    return eventSource;
  }, [
    cleanupEventSource, 
    onChunk,
    onDone,
    onError,
    onProcessingChange,
    startHeartbeat,
    timeoutDuration
  ]);
  
  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      cleanupEventSource();
      
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    };
  }, [cleanupEventSource]);
  
  return {
    initEventSource,
    cleanupEventSource,
    eventSourceRef,
    isConnected: !!eventSourceRef.current,
    content: fullContentRef.current
  };
}

export default useEventSource;