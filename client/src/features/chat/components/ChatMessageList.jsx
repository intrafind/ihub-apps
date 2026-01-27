import { useRef, useEffect } from 'react';
import ChatMessage from './ChatMessage';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import IntegrationAuthPrompts from '../../../shared/components/integrations/IntegrationAuthPrompts';

/**
 * A reusable component to display chat messages with smart auto-scrolling
 * Only auto-scrolls if user is already at the bottom
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
  app = null // App configuration for custom response rendering
}) => {
  const chatContainerRef = useRef(null);
  const { uiConfig } = useUIConfig();

  const assistantIcon = uiConfig?.icons?.assistantMessage || 'apps-svg-logo';
  const userIcon = uiConfig?.icons?.userMessage || 'user';
  const errorIcon = uiConfig?.icons?.errorMessage || 'exclamation-circle';

  // Smart auto-scroll: only scroll if user is already at the bottom
  useEffect(() => {
    if (chatContainerRef.current) {
      const container = chatContainerRef.current;
      const isNearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 100;

      // Only auto-scroll if user is near the bottom (within 100px)
      if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [messages]);

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
