import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../utils/localizeContent';
import Icon from '../Icon';
import { useNavigate } from 'react-router-dom';

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
  showParametersButton = false,
  onClearChat,
  onToggleConfig,
  onToggleParameters,
  currentLanguage,
  isMobile = false
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  
  // Default icon if none provided
  const defaultIcon = <Icon name="chat" className="text-white" />;

  const handleBack = () => {
    navigate('/');
  };

  return (
    <div className="flex flex-col mb-4 pb-4 border-b">
      <div className="flex items-center justify-between">
        <div className="flex items-center">
          <button
            onClick={handleBack}
            className="mr-3 bg-gray-200 hover:bg-gray-300 text-gray-800 p-2 rounded-full flex items-center justify-center h-10 w-10"
            title={t('pages.appChat.backToApps')}
            aria-label="Back to apps list"
          >
            <Icon name="arrowLeft" size="sm" />
          </button>          
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center mr-3"
            style={{ backgroundColor: color }}
          >
            {icon || defaultIcon}
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">
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

        {/* Action buttons on the right */}
        <div className="flex items-center space-x-2">
          {showClearButton && (
            <button
              onClick={onClearChat}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
              title={t('pages.appChat.clearChat')}
            >
              <Icon name="trash" size="sm" className="sm:mr-1" />
              <span className="hidden sm:inline">{t('pages.appChat.clear')}</span>
            </button>
          )}
          {showParametersButton && (
            <button
              onClick={onToggleParameters}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
              title={t('pages.appChat.parameters')}
            >
              <Icon name="sliders" size="sm" className="sm:mr-1" />
              <span className="hidden sm:inline">{t('pages.appChat.parameters', 'Parameters')}</span>
            </button>
          )}
          {showConfigButton && (
            <button
              onClick={onToggleConfig}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
              title={t('settings.title')}
            >
              <Icon name="settings" size="sm" className="sm:mr-1" />
              <span className="hidden sm:inline">{t('settings.title')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatHeader;