import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ChatMessage from './ChatMessage';
import Icon from '../Icon';
import { useUIConfig } from '../UIConfigContext';
import { getLocalizedContent } from '../../utils/localizeContent';

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
  compact = false,
  starterPrompts = [],
  onSelectPrompt = null
}) => {
  const { t, i18n } = useTranslation();
  const chatContainerRef = useRef(null);
  const { uiConfig } = useUIConfig();

  const assistantIcon = uiConfig?.icons?.assistantMessage || 'apps-svg-logo';
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
        <div className="text-center text-gray-500 py-8 space-y-6">
          {starterPrompts.length > 0 ? (
            <>
              <div className="space-y-2">
                <svg
                  className="w-12 h-12 mx-auto mb-3 text-indigo-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                  />
                </svg>
                <h3 className="text-xl font-semibold text-gray-700 mb-1">
                  {t('pages.appChat.starterPromptsTitle', 'Starter Prompts')}
                </h3>
                <p className="text-sm text-gray-500 max-w-md mx-auto">
                  {t('pages.appChat.starterPromptsSubtitle', 'Choose a prompt below to get started quickly')}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl mx-auto">
                {starterPrompts.map((sp, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="group relative p-4 text-left bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:border-indigo-300 transition-all duration-200 transform hover:-translate-y-0.5 h-full min-h-[100px] flex flex-col"
                    onClick={() =>
                      onSelectPrompt &&
                      onSelectPrompt({
                        ...sp,
                        message: getLocalizedContent(sp.message, i18n.language),
                      })
                    }
                  >
                    <div className="flex items-start space-x-3 h-full">
                      <div className="flex-shrink-0 w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center group-hover:bg-indigo-200 transition-colors mt-0.5">
                        <svg
                          className="w-4 h-4 text-indigo-600"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                          />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0 flex flex-col justify-start">
                        <p className="font-semibold text-gray-900 text-sm leading-5 mb-1">
                          {getLocalizedContent(sp.title, i18n.language)}
                        </p>
                        <p className="text-xs text-gray-500 leading-4 overflow-hidden" style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical'
                        }}>
                          {getLocalizedContent(sp.message, i18n.language)}
                        </p>
                      </div>
                    </div>
                    <div className="absolute inset-0 rounded-xl border border-transparent group-hover:border-indigo-200 transition-colors pointer-events-none"></div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
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
              <p>
                {t('pages.appChat.startConversation', 'Start the conversation by sending a message below.')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ChatMessageList;