import React from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../utils/localizeContent';
import Icon from '../Icon';

/**
 * A reusable header component for chat interfaces
 */
const ChatHeader = ({
  title,
  description,
  color,
  icon,
  showClearButton = false,
  showConfigButton = true,
  onClearChat,
  onToggleConfig,
  actions = [],
  currentLanguage,
  isMobile = false
}) => {
  const { t } = useTranslation();
  
  // Default icon if none provided
  const defaultIcon = <Icon name="chat" className="text-white" />;

  return (
    <div className="flex flex-col mb-4 pb-4 border-b">
      <div className="flex items-center mb-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center mr-3"
          style={{ backgroundColor: color }}
        >
          {icon || defaultIcon}
        </div>
        <div>
          <h1 className="text-2xl font-bold">
            {typeof title === 'object' 
              ? getLocalizedContent(title, currentLanguage) 
              : title}
          </h1>
          <p className="text-gray-600 text-sm">
            {typeof description === 'object'
              ? getLocalizedContent(description, currentLanguage) 
              : description}
          </p>
        </div>
      </div>

      {isMobile ? (
        <div className="flex flex-wrap gap-2">
          {showConfigButton && (
            <button
              onClick={onToggleConfig}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center text-sm"
            >
              <Icon name="settings" size="sm" className="mr-1" />
              {t('settings.title')}
            </button>
          )}
          {showClearButton && (
            <button
              onClick={onClearChat}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center text-sm"
              title={t('pages.appChat.clearChat')}
            >
              <Icon name="trash" size="sm" className="mr-1" />
              {t('pages.appChat.clear')}
            </button>
          )}
          {/* Action buttons for mobile */}
          {actions.length > 0 &&
            actions.map(action => (
              <button
                key={action.id}
                onClick={() => action.onClick(action.id)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded flex items-center text-sm"
              >
                {typeof action.label === 'object' 
                  ? getLocalizedContent(action.label, currentLanguage) 
                  : action.label}
              </button>
            ))}
        </div>
      ) : (
        <div className="hidden md:flex space-x-2 ml-auto">
          {showClearButton && (
            <button
              onClick={onClearChat}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
              title={t('pages.appChat.clearChat')}
            >
              <Icon name="trash" size="md" className="mr-1" />
              {t('pages.appChat.clear')}
            </button>
          )}
          {showConfigButton && (
            <button
              onClick={onToggleConfig}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
            >
              <Icon name="settings" size="md" className="mr-1" />
              {t('settings.title')}
            </button>
          )}
          {/* Action buttons for desktop */}
          {actions.length > 0 &&
            actions.map(action => (
              <button
                key={action.id}
                onClick={() => action.onClick(action.id)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded flex items-center"
              >
                {typeof action.label === 'object' 
                  ? getLocalizedContent(action.label, currentLanguage) 
                  : action.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
};

export default ChatHeader;