import { useRef, useEffect, useState } from 'react';
import ChatMessage from './ChatMessage';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import IntegrationAuthPrompts from '../../../shared/components/integrations/IntegrationAuthPrompts';

/**
 * A reusable component to display chat messages with smart auto-scrolling
 * Auto-scrolls to new messages and during streaming unless user manually scrolls up
 * Only renders when there are actual messages to display
 */
const ChatMessageList = ({
  messages,
  outputFormat = 'markdown',
  onDelete,
  onEdit,
  onResend,
  appId,
  chatId,
  modelId,
  editable = false,
  compact = false,
  onOpenInCanvas,
  onInsert,
  canvasEnabled = false,
  // Integration auth props
  requiredIntegrations = [],
  onConnectIntegration,
  app = null, // App configuration for custom response rendering
  models = [] // Available models to pass to ChatMessage for link generation
}) => {
  const chatContainerRef = useRef(null);
  const { uiConfig } = useUIConfig();
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const isUserScrollingRef = useRef(false);
  const prevMessageCountRef = useRef(0);

  const assistantIcon = uiConfig?.icons?.assistantMessage || 'apps-svg-logo';
  const userIcon = uiConfig?.icons?.userMessage || 'user';
  const errorIcon = uiConfig?.icons?.errorMessage || 'exclamation-circle';

  // Detect manual scrolling by the user
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Check if user is near the bottom (within 50px)
      const isNearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 50;

      // If user scrolls away from bottom, disable auto-scroll
      // If user scrolls back to bottom, re-enable auto-scroll
      if (!isUserScrollingRef.current) {
        isUserScrollingRef.current = true;
        setTimeout(() => {
          isUserScrollingRef.current = false;
        }, 100);
      }

      setShouldAutoScroll(isNearBottom);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Always scroll to show user's new message, regardless of shouldAutoScroll
  // This ensures the user can see their input was sent
  useEffect(() => {
    if (!chatContainerRef.current || messages.length === 0) return;

    const container = chatContainerRef.current;
    const prevCount = prevMessageCountRef.current;
    const newMessagesCount = messages.length - prevCount;

    // Check if any of the newly added messages is a user message
    // (user message and assistant placeholder may be added together)
    const hasNewUserMessage =
      newMessagesCount > 0 && messages.slice(-newMessagesCount).some(msg => msg.role === 'user');

    // Always scroll when a new user message is added
    // Use requestAnimationFrame to ensure DOM has been updated with the new message
    if (hasNewUserMessage) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
      // Re-enable auto-scroll for the upcoming assistant response
      setShouldAutoScroll(true);
    }
    // For assistant messages (streaming), only scroll if shouldAutoScroll is true
    else if (shouldAutoScroll) {
      container.scrollTop = container.scrollHeight;
    }

    prevMessageCountRef.current = messages.length;
  }, [messages, shouldAutoScroll]);

  // Don't render anything if there are no messages
  if (messages.length === 0) {
    return null;
  }

  return (
    <div ref={chatContainerRef} className="flex-1 mb-4 p-4 overflow-y-auto space-y-4 rounded-lg">
      {messages.map((message, index) => (
        <div key={message.id}>
          <div
            className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
          >
            {/* Message sender icon */}
            <div className="flex-shrink-0 mt-1">
              {message.role === 'assistant' ? (
                <Icon name={assistantIcon} size="2xl" className="text-blue-500" />
              ) : message.role === 'user' ? (
                <Icon name={userIcon} size="xl" className="text-gray-500" />
              ) : (
                <Icon name={errorIcon} size="2xl" className="text-yellow-500" />
              )}
            </div>

            {/* Message content */}
            <div className={`max-w-[80%] ${message.role === 'user' ? '' : ''}`}>
              <ChatMessage
                message={message}
                outputFormat={outputFormat}
                onDelete={onDelete}
                onEdit={onEdit}
                onResend={onResend}
                editable={editable}
                appId={appId}
                chatId={chatId}
                modelId={modelId}
                compact={compact}
                onOpenInCanvas={onOpenInCanvas}
                onInsert={onInsert}
                canvasEnabled={canvasEnabled}
                app={app}
                models={models}
              />
            </div>
          </div>

          {/* Show integration auth prompts after the last assistant message if auth is required */}
          {index === messages.length - 1 &&
            message.role === 'assistant' &&
            requiredIntegrations.length > 0 && (
              <div className="mt-4 ml-12">
                <IntegrationAuthPrompts
                  requiredIntegrations={requiredIntegrations}
                  onConnect={onConnectIntegration}
                />
              </div>
            )}
        </div>
      ))}
    </div>
  );
};

export default ChatMessageList;
