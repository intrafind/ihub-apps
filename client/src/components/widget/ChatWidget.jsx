import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useUIConfig } from '../UIConfigContext';
import { v4 as uuidv4 } from 'uuid';
import { sendAppChatMessage } from '../../api/api';

// Import existing chat components
import ChatMessageList from '../chat/ChatMessageList';
import ChatInput from '../chat/ChatInput';
import Icon from '../Icon';

// Import hooks
import useEventSource from '../../hooks/useEventSource';
import useChatMessages from '../../hooks/useChatMessages';

// Widget-specific styling
import './ChatWidget.css';

const ChatWidget = ({ 
  forcedOpen, 
  onClose, 
  configuredAppId,
  triggerElement,
  autoOpenTrigger,
  triggerOffset = 300,
  position = 'right',
  isIframe = false
}) => {
  const { uiConfig, isLoading } = useUIConfig();
  const [isOpen, setIsOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [input, setInput] = useState('');
  const [processing, setProcessing] = useState(false);
  const messagesEndRef = useRef(null);
  const greetingAddedRef = useRef(false);
  const containerRef = useRef(null);
  const lastMessageIdRef = useRef(null);
  const pendingMessageDataRef = useRef(null);
  
  // Create a chat ID
  const [chatId] = useState(() => uuidv4());
  
  // Use widget config options
  const widgetConfig = uiConfig?.widget || {};
  const appId = configuredAppId || widgetConfig.defaultApp || 'general-assistant';

  const [useMaxTokens, setUseMaxTokens] = useState(false);
  
  // Log the app ID being used
  useEffect(() => {
    console.log('[ChatWidget] Using app ID:', appId);
  }, [appId]);
  
  // Handle forcedOpen prop changes
  useEffect(() => {
    if (forcedOpen !== undefined) {
      setIsOpen(forcedOpen);
    }
  }, [forcedOpen]);
  
  // Use the existing chat message management hook
  const {
    messages,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    setMessageError,
    deleteMessage,
    editMessage,
    clearMessages,
    getMessagesForApi,
    addSystemMessage
  } = useChatMessages(chatId);
  
  // Initialize chat session with greeting message ONLY when widget is opened
  useEffect(() => {
    // Only add greeting message when widget is opened, config is loaded, and we haven't added it yet
    if (isOpen && !isLoading && uiConfig && widgetConfig.greeting && !greetingAddedRef.current) {
      console.log('[ChatWidget] Adding greeting message from config when widget opened');
      
      const userLanguage = navigator.language.split('-')[0].toLowerCase();
      const greeting = widgetConfig.greeting[userLanguage] || widgetConfig.greeting.en;
      
      if (greeting) {
        // Clear any existing messages first to ensure fresh state when opening
        if (messages.length > 0) {
          clearMessages();
        }
        
        // Create a greeting message using the addAssistantMessage method
        // We'll use it to add the greeting, then immediately update it to set loading: false
        const greetingId = addAssistantMessage();
        
        // Update the message to include the greeting content and set loading to false
        updateAssistantMessage(greetingId, greeting, false);
        
        greetingAddedRef.current = true;
      }
    }
    
    // Reset the greeting flag when widget is closed so it will show again on next open
    if (!isOpen) {
      greetingAddedRef.current = false;
    }
  }, [isOpen, isLoading, uiConfig, widgetConfig, messages.length, clearMessages, addAssistantMessage, updateAssistantMessage]);
  
  // Scroll to bottom of chat on new messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);
  
  // Use refs to store the latest callback functions to avoid recreating EventSource
  const callbacksRef = useRef({});
  const cleanupEventSourceRef = useRef();
  
  // Update callbacks ref
  callbacksRef.current = {
    onChunk: (fullContent) => {
      if (lastMessageIdRef.current) {
        updateAssistantMessage(lastMessageIdRef.current, fullContent, true);
      }
    },
    onDone: (finalContent, info) => {
      if (lastMessageIdRef.current) {
        updateAssistantMessage(lastMessageIdRef.current, finalContent, false, {
          finishReason: info.finishReason
        });
      }
      setProcessing(false);
      setUseMaxTokens(false);
    },
    onError: (error) => {
      if (lastMessageIdRef.current) {
        setMessageError(lastMessageIdRef.current, error.message);
      }
      setProcessing(false);
      setUseMaxTokens(false);
    },
    onConnected: async (event) => {
      try {
        if (pendingMessageDataRef.current) {
          const { appId, chatId, messages, params } = pendingMessageDataRef.current;
          
          // Send the message to the API
          await sendAppChatMessage(appId, chatId, messages, params);
          
          // Clear the pending data after sending
          pendingMessageDataRef.current = null;
        }
      } catch (error) {
        console.error('Error sending message on connection:', error);
        
        if (lastMessageIdRef.current) {
          setMessageError(lastMessageIdRef.current, 'Error: Failed to generate response');
        }
        
        cleanupEventSourceRef.current?.();
        setProcessing(false);
      }
    }
  };

  // Create stable callback wrappers
  const stableOnChunk = useCallback((fullContent) => {
    callbacksRef.current.onChunk(fullContent);
  }, []);
  
  const stableOnDone = useCallback((finalContent, info) => {
    callbacksRef.current.onDone(finalContent, info);
  }, []);
  
  const stableOnError = useCallback((error) => {
    callbacksRef.current.onError(error);
  }, []);
  
  const stableOnConnected = useCallback(async (event) => {
    await callbacksRef.current.onConnected(event);
  }, []);

  // Use the existing EventSource hook for streaming
  const {
    initEventSource,
    cleanupEventSource,
    isConnected
  } = useEventSource({
    appId,
    chatId,
    onChunk: stableOnChunk,
    onDone: stableOnDone,
    onError: stableOnError,
    onConnected: stableOnConnected,
    onProcessingChange: setProcessing
  });

  // Store cleanup function in ref
  cleanupEventSourceRef.current = cleanupEventSource;
  
  // Helper functions for localized content
  const getUserLanguage = () => {
    return navigator.language.split('-')[0].toLowerCase();
  };
  
  // Check for trigger element visibility and scroll position
  useEffect(() => {
    const checkTriggers = () => {
      // Function to check if an element is visible
      const isElementVisible = (selector) => {
        if (!selector) return false;
        
        // Decode the selector if it's URL-encoded
        const decodedSelector = decodeURIComponent(selector);
        
        const element = document.querySelector(decodedSelector);
        if (element) {
          const rect = element.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= window.innerHeight;
        }
        return false;
      };
      
      // Handle widget visibility based on trigger element
      if (triggerElement) {
        const isVisible = isElementVisible(triggerElement);
        setIsVisible(isVisible);
      } else {
        // Check scroll position for visibility
        const scrolled = window.scrollY || window.pageYOffset;
        setIsVisible(scrolled > triggerOffset);
      }
      
      // Handle auto-open trigger
      if (autoOpenTrigger && !isOpen) {
        const isAutoTriggerVisible = isElementVisible(autoOpenTrigger);
        if (isAutoTriggerVisible) {
          setIsOpen(true);
        }
      }
    };
    
    // Add scroll and resize listeners
    window.addEventListener('scroll', checkTriggers);
    window.addEventListener('resize', checkTriggers);
    
    // Initial check
    checkTriggers();
    
    // Clean up
    return () => {
      window.removeEventListener('scroll', checkTriggers);
      window.removeEventListener('resize', checkTriggers);
    };
  }, [triggerElement, autoOpenTrigger, triggerOffset, isOpen]);
  
  const getPlaceholderText = () => {
    const language = getUserLanguage();
    return widgetConfig.placeholder?.[language] || 
           widgetConfig.placeholder?.en || 
           'Type your message...';
  };
  
  const getButtonText = () => {
    const language = getUserLanguage();
    return widgetConfig.sendButtonText?.[language] || 
           widgetConfig.sendButtonText?.en || 
           'Send';
  };
  
  const getWidgetTitle = () => {
    const language = getUserLanguage();
    return widgetConfig.title?.[language] || 
           widgetConfig.title?.en || 
           'Chat';
  };
  
  // Handle toggle open/closed
  const toggleWidget = () => {
    // If we have a forcedOpen prop and an onClose callback, use that
    if (forcedOpen !== undefined && onClose && isOpen) {
      console.log('Calling onClose callback');
      onClose();
      return;
    }
    
    // Otherwise, handle toggle locally
    if (forcedOpen === undefined) {
      setIsOpen(!isOpen);
    }
  };
  
  const handleInputChange = (e) => {
    setInput(e.target.value);
  };
  
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };
  
  // Handle message resending
  const handleResendMessage = (messageId, editedContent, useMaxTokens = false) => {
    const messageToResend = messages.find((msg) => msg.id === messageId);
    if (!messageToResend) return;

    let contentToResend = editedContent;
    let variablesToRestore = null;

    if (messageToResend.role === 'assistant') {
      const idx = messages.findIndex((msg) => msg.id === messageId);
      const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
      if (!prevUser) return;
      contentToResend = prevUser.rawContent || prevUser.content;
      variablesToRestore = prevUser.meta?.variables || null;
      // remove the user message and everything after it (including the assistant)
      deleteMessage(prevUser.id);
    } else {
      deleteMessage(messageId);
      if (contentToResend === undefined) {
        contentToResend = messageToResend.rawContent || messageToResend.content;
      }
      variablesToRestore = messageToResend.meta?.variables || null;
    }

    // Allow resending even with empty content (for variable-only messages)
    setInput(contentToResend || '');
    
    // Restore variables if they exist
    if (variablesToRestore) {
      setVariables(variablesToRestore);
    }
    
    if (useMaxTokens) {
      setUseMaxTokens(true);
    }

    setTimeout(() => {
      handleSubmit({ preventDefault: () => {} });
    }, 100);
  };
  
  // Handle message submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Don't send empty messages or while processing
    if (!input.trim() || processing) return;
    
    try {
      // Clean up any existing connections
      cleanupEventSource();
      setProcessing(true);
      
      // Add user message to UI
      const userMessageId = addUserMessage(input);
      setInput('');
      
      // Create a unique ID for the assistant's response message
      const assistantMessageId = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      lastMessageIdRef.current = assistantMessageId;
      
      // Add placeholder message for the assistant's response with empty content (no loading text)
      addAssistantMessage(assistantMessageId, '', true);
      
      // Create message for API
      const messageForAPI = {
        role: 'user',
        content: input,
        messageId: userMessageId,
      };
      
      // Get messages for the API including chat history
      const messagesForAPI = getMessagesForApi(true, messageForAPI);
      
      // Store the request parameters for use in the onConnected callback
      pendingMessageDataRef.current = {
        appId,
        chatId,
        messages: messagesForAPI,
        params: {
          modelId: null, // Will use app's default model
          style: 'normal',
          temperature: 0.7, // Default temperature
          outputFormat: 'markdown',
          language: getUserLanguage(),
          ...(useMaxTokens ? { useMaxTokens: true } : {})
        }
      };
      
      // Initialize SSE connection
      initEventSource(`/api/apps/${appId}/chat/${chatId}`);
      
    } catch (error) {
      console.error('Error sending message:', error);
      
      // Display error message
      if (lastMessageIdRef.current) {
        setMessageError(lastMessageIdRef.current, `Error: ${error.message || 'Failed to send message'}`);
      }
      
      setProcessing(false);
    }
  };

  return (
    <div className={`chat-widget-container ${!isVisible ? 'hidden' : ''} ${isIframe ? 'iframe-mode' : ''}`} 
      style={{
        '--primary-color': widgetConfig?.style?.primaryColor || 'rgb(0, 53, 87)',
        '--secondary-color': widgetConfig?.style?.secondaryColor || '#f3f4f6',
        '--font-family': widgetConfig?.style?.fontFamily || 'Inter, system-ui, sans-serif',
        '--border-radius': widgetConfig?.style?.borderRadius || '8px',
        ...(isIframe && {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          height: '100vh',
          display: 'block', // Remove flexbox
        })
      }}
      ref={containerRef}
    >
      {/* Toggle button - hide in iframe mode */}
      {!isIframe && (
        <button 
          className="chat-widget-toggle"
          onClick={toggleWidget}
          aria-label={isOpen ? "Close chat" : "Open chat"}
        >
          {isOpen ? (
            <Icon name="close" size="lg" />
          ) : (
            <Icon name="chat" size="lg" />
          )}
        </button>
      )}
      
      {/* Widget panel - apply special styles for iframe mode */}
      <div 
        className={`chat-widget-panel ${isOpen ? 'open' : ''} ${isIframe ? 'iframe-mode' : ''}`}
        style={isIframe ? {
          position: 'relative',
          height: '100vh',
          width: '100%',
          maxHeight: 'none',
          bottom: 'auto',
          right: 'auto',
          boxShadow: 'none',
          borderRadius: '0',
        } : {}}
      >
        {/* Header */}
        <div className="chat-widget-header">
          <div className="chat-widget-header-left">
            <h3>{getWidgetTitle()}</h3>
          </div>
          <div className="chat-widget-header-right">
            <button 
              className="chat-widget-close"
              onClick={toggleWidget}
              aria-label="Close chat"
            >
              <Icon name="close" size="md" />
            </button>
          </div>
        </div>
        
        {/* Messages container with improved styling for iframe mode */}
        <div 
          className="chat-widget-messages"
          style={isIframe ? {
            height: 'calc(100vh - 130px)',
            minHeight: '0',
            overflowY: 'auto',
          } : {}}
        >
          {isLoading ? (
            <div className="flex justify-center items-center h-full">
              <div className="loading-spinner"></div>
            </div>
          ) : (
            <>
              <ChatMessageList
                messages={messages}
                outputFormat="markdown"
                onDelete={deleteMessage}
                onEdit={editMessage}
                onResend={handleResendMessage}
                editable={true}
                appId={appId}
                chatId={chatId}
                compact={true} // Set compact mode for the limited widget space
              />
              {/* Only show typing indicator when processing AND there are no loading messages */}
              {processing && !messages.some(msg => msg.loading) && (
                <div className="chat-widget-typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        {/* Custom input area with improved styling for iframe mode */}
        <div 
          className="chat-widget-input"
          style={isIframe ? {
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            background: 'white',
          } : {}}
        >
          <textarea autoComplete="off" data-lpignore="true" data-1p-ignore="true"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholderText()}
            rows={1}
            disabled={processing}
          />
          <button 
            onClick={handleSubmit}
            disabled={!input.trim() || processing}
            aria-label="Send message"
          >
            {getButtonText()}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatWidget;