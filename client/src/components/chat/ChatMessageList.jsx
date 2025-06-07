import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ChatMessage from './ChatMessage';
import Icon from '../Icon';
import { useUIConfig } from '../UIConfigContext';

/**
 * A reusable component to display chat messages with auto-scrolling
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
  compact = false
}) => {
  const { t } = useTranslation();
  const chatContainerRef = useRef(null);
  const { uiConfig } = useUIConfig();

  const assistantIcon = uiConfig?.icons?.assistantMessage || 'academic-cap';
  const userIcon = uiConfig?.icons?.userMessage || 'user';
  const errorIcon = uiConfig?.icons?.errorMessage || 'exclamation-circle';
  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      ref={chatContainerRef}
      className="flex-1 overflow-y-auto mb-4 space-y-4 p-4 bg-gray-50 rounded-lg md:max-h-none"
    >
      {messages.length > 0 ? (
        messages.map((message) => (
          <div key={message.id} className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
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
              />
            </div>
          </div>
        ))
      ) : (
        <div className="text-center text-gray-500 py-8">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <p>{t('pages.appChat.startConversation', 'Start the conversation by sending a message below.')}</p>
        </div>
      )}
    </div>
  );
};

export default ChatMessageList;