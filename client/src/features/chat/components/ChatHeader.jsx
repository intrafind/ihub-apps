import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
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
  showShareButton = false,
  showCanvasButton = false,
  showBackToChatButton = false,
  parametersVisible = false,
  onClearChat,
  onToggleConfig,
  onToggleParameters,
  onToggleCanvas,
  onShare,
  currentLanguage,
  isMobile = false
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Default icon if none provided
  const defaultIcon = <Icon name="chat" className="text-white" />;

  // Toggle visibility of the description tooltip on mobile
  const [showDescription, setShowDescription] = useState(false);

  // Auto hide description tooltip on mobile after 3 seconds
  useEffect(() => {
    if (isMobile && showDescription) {
      const timer = setTimeout(() => setShowDescription(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isMobile, showDescription]);

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
          <div className="relative">
            <h1 className="text-2xl font-bold leading-tight flex items-center">
              {typeof title === 'object' ? getLocalizedContent(title, currentLanguage) : title}
              {isMobile && description && (
                <button
                  className="ml-1 text-gray-500"
                  onClick={() => setShowDescription(prev => !prev)}
                  onMouseEnter={() => setShowDescription(true)}
                  onMouseLeave={() => setShowDescription(false)}
                  aria-label="App info"
                  title={
                    typeof description === 'object'
                      ? getLocalizedContent(description, currentLanguage)
                      : description
                  }
                >
                  <Icon name="information-circle" size="sm" />
                </button>
              )}
            </h1>
            {!isMobile && (
              <p className="text-gray-600 text-sm">
                {typeof description === 'object'
                  ? getLocalizedContent(description, currentLanguage)
                  : description}
              </p>
            )}
            {isMobile && showDescription && (
              <div className="absolute z-10 mt-2 p-2 bg-white border rounded shadow text-xs max-w-xs">
                {typeof description === 'object'
                  ? getLocalizedContent(description, currentLanguage)
                  : description}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons on the right */}
        <div className="flex flex-col items-start space-y-2 sm:flex-row sm:items-center sm:space-y-0 sm:space-x-2">
          {showBackToChatButton && (
            <button
              onClick={onToggleCanvas}
              className="bg-blue-100 hover:bg-blue-200 text-blue-700 px-3 py-1 rounded flex items-center"
              title={t('pages.appCanvas.backToChat', 'Back to Chat')}
            >
              <Icon name="chat" size="sm" className="sm:mr-1" />
              <span className="hidden sm:inline">
                {t('pages.appCanvas.backToChat', 'Back to Chat')}
              </span>
            </button>
          )}
          {showCanvasButton && (
            <button
              onClick={onToggleCanvas}
              className="bg-indigo-100 hover:bg-indigo-200 text-indigo-700 px-3 py-1 rounded flex items-center"
              title={t('pages.appChat.canvasMode', 'Canvas Mode')}
            >
              <Icon name="document-text" size="sm" className="sm:mr-1" />
              <span className="hidden sm:inline">{t('pages.appChat.canvas', 'Canvas')}</span>
            </button>
          )}
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
          {showParametersButton && isMobile && (
            <button
              onClick={onToggleParameters}
              className={`text-gray-800 px-3 py-1 rounded flex items-center ${
                parametersVisible ? 'bg-gray-300' : 'bg-gray-200 hover:bg-gray-300'
              }`}
              aria-pressed={parametersVisible}
              title={t('pages.appChat.parameters')}
            >
              <Icon name="sliders" size="sm" className="sm:mr-1" />
              <span className="hidden sm:inline">
                {t('pages.appChat.parameters', 'Parameters')}
              </span>
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
          {showShareButton && (
            <button
              onClick={onShare}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
              title={t('common.share')}
            >
              <Icon name="share" size="sm" className="sm:mr-1" />
              <span className="hidden sm:inline">{t('common.share')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
export default ChatHeader;
