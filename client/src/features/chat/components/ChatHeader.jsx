import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import { useNavigate } from 'react-router-dom';
import ChatActionsMenu from './ChatActionsMenu';
import ExportDialog from './ExportDialog';
import { useAuth } from '../../../shared/contexts/AuthContext';

/**
 * A reusable header component for chat interfaces
 */
function ChatHeader({
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
  isMobile = false,
  messages = [],
  exportSettings = {},
  appId,
  chatId,
  conversationTitle = null
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Default icon if none provided
  const defaultIcon = <Icon name="chat" className="text-white" />;

  // Toggle visibility of the description tooltip on mobile
  const [showDescription, setShowDescription] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Auto hide description tooltip on mobile after 3 seconds
  useEffect(() => {
    if (isMobile && showDescription) {
      const timer = setTimeout(() => setShowDescription(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isMobile, showDescription]);

  const handleBack = () => {
    console.log('Start custom back button handler');
    localStorage.setItem('CAIIframSrc', "")
    console.log('CAIIframSrc set to ""');
    try {
      console.log('obtaining href from top window');
      const href = window.top.location.href;
      console.log('href', href);
      window.open(href, '_self', 'noopener,noreferrer');
    } catch (error) {
      console.log('Error getting href from top window:', error);
    }
    
    if (window.self !== window.top) {
      window.parent.postMessage({ type: 'IHUB_APP_RETURN' }, '*');
      console.log('sent postMessage "{type: "IHUB_APP_RETURN"}');
    } else {
      console.log('no iframe, default behavior, navigating to /')
      navigate('/');
    }
  };

  return (
    <div className="flex flex-col mb-4 pb-4 border-b">
      <div className="flex items-center justify-between">
        <div className="flex items-center">
          <button
            onClick={handleBack}
            className="mr-3 bg-gray-200 hover:bg-gray-300 text-gray-800 p-2 rounded-full flex items-center justify-center h-10 w-10"
            title={t('pages.appChat.backToApps')}
            aria-label={t('common.backToAppsList', 'Back to apps list')}
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
                  aria-label={t('common.appInfo', 'App info')}
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
            {conversationTitle && (
              <p className="text-indigo-600 dark:text-indigo-400 text-xs mt-0.5 truncate max-w-xs">
                {conversationTitle}
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
        <div className="flex items-center gap-2">
          {/* Desktop action buttons - hidden on mobile */}
          <div className="hidden md:flex items-center gap-2">
            {showBackToChatButton && (
              <button
                onClick={onToggleCanvas}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 p-2 rounded-full flex items-center justify-center h-10 w-10"
                title={t('pages.appCanvas.backToChat', 'Back to Chat')}
                aria-label={t('pages.appCanvas.backToChat', 'Back to Chat')}
              >
                <Icon name="chat" size="sm" />
              </button>
            )}
            {showCanvasButton && (
              <button
                onClick={onToggleCanvas}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 p-2 rounded-full flex items-center justify-center h-10 w-10"
                title={t('pages.appChat.canvasMode', 'Canvas Mode')}
                aria-label={t('pages.appChat.canvasMode', 'Canvas Mode')}
              >
                <Icon name="document-text" size="sm" />
              </button>
            )}
            {showClearButton && (
              <button
                onClick={onClearChat}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 p-2 rounded-full flex items-center justify-center h-10 w-10"
                title={t('pages.appChat.newChat', 'New Chat')}
                aria-label={t('pages.appChat.newChat', 'New Chat')}
              >
                <Icon name="trash" size="sm" />
              </button>
            )}
            {messages && messages.length > 0 && exportSettings && (
              <button
                onClick={() => setShowExportDialog(true)}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 p-2 rounded-full flex items-center justify-center h-10 w-10"
                title={t('common.export', 'Export')}
                aria-label={t('common.export', 'Export')}
              >
                <Icon name="download" size="sm" />
              </button>
            )}
            {showShareButton && (
              <button
                onClick={onShare}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 p-2 rounded-full flex items-center justify-center h-10 w-10"
                title={t('pages.appChat.share', 'Share')}
                aria-label={t('pages.appChat.share', 'Share')}
              >
                <Icon name="share" size="sm" />
              </button>
            )}
            {user?.isAdmin && appId && (
              <button
                onClick={() => navigate(`/admin/apps/${appId}`)}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 p-2 rounded-full flex items-center justify-center h-10 w-10"
                title={t('pages.appChat.editApp', 'Edit App')}
                aria-label={t('pages.appChat.editApp', 'Edit App')}
              >
                <Icon name="edit" size="sm" />
              </button>
            )}
            {showConfigButton && (
              <button
                onClick={onToggleConfig}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 p-2 rounded-full flex items-center justify-center h-10 w-10"
                title={t('settings.title')}
                aria-label={t('settings.title')}
              >
                <Icon name="settings" size="sm" />
              </button>
            )}
          </div>

          {/* Mobile burger menu - shown on mobile/tablet */}
          <div className="md:hidden">
            <ChatActionsMenu
              onClearChat={onClearChat}
              onToggleConfig={onToggleConfig}
              onShare={onShare}
              showShareButton={showShareButton}
              showConfigButton={showConfigButton}
              showClearButton={showClearButton}
              messages={messages}
              exportSettings={exportSettings}
              onToggleCanvas={onToggleCanvas}
              showCanvasButton={showCanvasButton}
              onToggleParameters={onToggleParameters}
              showParametersButton={showParametersButton}
              parametersVisible={parametersVisible}
              appId={appId}
              chatId={chatId}
            />
          </div>
        </div>
      </div>

      {/* Export Dialog */}
      <ExportDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        messages={messages}
        settings={exportSettings}
        appId={appId}
        chatId={chatId}
      />
    </div>
  );
}
export default ChatHeader;
