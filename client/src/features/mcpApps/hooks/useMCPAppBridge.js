import { useEffect, useRef, useCallback, useState } from 'react';
import { isValidMessage, createInitMessage } from '../utils/mcpAppSecurity';
import { callTool } from '../../../api/api';

/**
 * Custom hook for managing MCP App message bridge
 * Handles bidirectional communication between host and MCP App iframe
 */
export default function useMCPAppBridge({ iframeRef, toolResult, chatId, onError }) {
  const [isInitialized, setIsInitialized] = useState(false);
  const pendingRequestsRef = useRef(new Map());
  const requestIdRef = useRef(0);

  /**
   * Send message to MCP App iframe
   */
  const sendMessage = useCallback(
    message => {
      if (!iframeRef?.current?.contentWindow) {
        console.warn('Cannot send message: iframe not ready');
        return;
      }

      try {
        iframeRef.current.contentWindow.postMessage(message, '*');
      } catch (error) {
        console.error('Error sending message to MCP App:', error);
        onError?.(error);
      }
    },
    [iframeRef, onError]
  );

  /**
   * Handle tool call request from MCP App
   */
  const handleToolCall = useCallback(
    async (message) => {
      const { id, params } = message;
      const { name, arguments: args } = params;

      try {
        // Call the tool via the API
        const result = await callTool(name, args, chatId);

        // Send response back to app
        sendMessage({
          jsonrpc: '2.0',
          id,
          result
        });
      } catch (error) {
        console.error('Error calling tool from MCP App:', error);

        // Send error response
        sendMessage({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: error.message || 'Internal error'
          }
        });
      }
    },
    [chatId, sendMessage]
  );

  /**
   * Handle log message from MCP App
   */
  const handleLog = useCallback((params) => {
    const { level = 'info', message, data } = params;
    console.log(`[MCP App ${level.toUpperCase()}]`, message, data || '');
  }, []);

  /**
   * Handle incoming messages from MCP App
   */
  const handleMessage = useCallback(
    (event) => {
      // Validate message structure
      const msg = event.data;
      
      if (!isValidMessage(msg)) {
        return; // Ignore invalid messages
      }

      // Handle requests from app
      if (msg.method && msg.id !== undefined) {
        switch (msg.method) {
          case 'tools/call':
            handleToolCall(msg);
            break;
          case 'ui/log':
            handleLog(msg.params);
            // Send acknowledgment
            sendMessage({
              jsonrpc: '2.0',
              id: msg.id,
              result: { acknowledged: true }
            });
            break;
          default:
            // Method not found
            sendMessage({
              jsonrpc: '2.0',
              id: msg.id,
              error: {
                code: -32601,
                message: `Method '${msg.method}' not found`
              }
            });
        }
      }
      // Handle notifications (no response expected)
      else if (msg.method) {
        switch (msg.method) {
          case 'ui/log':
            handleLog(msg.params);
            break;
          default:
            console.warn('Unknown notification method:', msg.method);
        }
      }
      // Handle responses to our requests
      else if (msg.id !== undefined) {
        const pending = pendingRequestsRef.current.get(String(msg.id));
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequestsRef.current.delete(String(msg.id));

          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'Unknown error'));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    },
    [handleToolCall, handleLog, sendMessage]
  );

  /**
   * Initialize MCP App with tool result
   */
  const initialize = useCallback(() => {
    if (!iframeRef?.current?.contentWindow || isInitialized) {
      return;
    }

    // Send initialization message
    const initMessage = createInitMessage(toolResult);
    sendMessage(initMessage);
    setIsInitialized(true);
  }, [iframeRef, toolResult, isInitialized, sendMessage]);

  /**
   * Setup message listener
   */
  useEffect(() => {
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      
      // Clean up any pending requests
      pendingRequestsRef.current.forEach(({ timeout }) => clearTimeout(timeout));
      pendingRequestsRef.current.clear();
    };
  }, [handleMessage]);

  /**
   * Initialize when iframe loads
   */
  useEffect(() => {
    const iframe = iframeRef?.current;
    if (!iframe) return;

    const handleLoad = () => {
      // Small delay to ensure iframe is fully ready
      setTimeout(() => {
        initialize();
      }, 100);
    };

    iframe.addEventListener('load', handleLoad);

    return () => {
      iframe.removeEventListener('load', handleLoad);
    };
  }, [iframeRef, initialize]);

  return {
    sendMessage,
    isInitialized
  };
}
