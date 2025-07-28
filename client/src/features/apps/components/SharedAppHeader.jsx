import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ChatHeader from '../../chat/components/ChatHeader';
import AppConfigForm from './AppConfigForm';
import Icon from '../../../shared/components/Icon';
import { useTranslation } from 'react-i18next';

/**
 * Shared app header component for both chat and canvas modes
 * Handles header display and configuration panel
 */
const SharedAppHeader = ({
  app,
  appId,
  chatId,
  mode = 'chat', // 'chat' or 'canvas'
  messages = [],
  editorContent = '',
  variables = {},
  onClearChat,
  onClearCanvas,
  currentLanguage,

  // Settings props
  models,
  styles,
  selectedModel,
  selectedStyle,
  selectedOutputFormat,
  sendChatHistory,
  temperature,
  onModelChange,
  onStyleChange,
  onOutputFormatChange,
  onSendChatHistoryChange,
  onTemperatureChange,

  // Config panel state
  showConfig,
  onToggleConfig,

  // Chat-specific props
  onToggleParameters,
  showParameters,
  onShare,
  showShareButton = false
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handleToggleCanvas = () => {
    if (mode === 'chat') {
      navigate(`/apps/${appId}/canvas`);
    } else {
      navigate(`/apps/${appId}`);
    }
  };

  const handleClear = () => {
    if (mode === 'canvas') {
      onClearCanvas?.();
    } else {
      onClearChat?.();
    }
  };

  // Close settings panel with ESC when open
  useEffect(() => {
    if (!showConfig) return;
    const handleKeyDown = e => {
      if (e.key === 'Escape') {
        onToggleConfig();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showConfig, onToggleConfig]);

  // Determine if we should show the clear button
  const showClearButton =
    mode === 'canvas' ? messages.length > 0 || editorContent.trim() : messages.length > 0;

  // App icon based on mode
  const appIcon = (
    <Icon name={mode === 'canvas' ? 'edit' : 'chat'} size="lg" className="text-white" />
  );

  const exportSettings = {
    model: selectedModel,
    style: selectedStyle,
    outputFormat: selectedOutputFormat,
    temperature,
    variables
  };

  return (
    <>
      {/* Header */}
      <div className="flex-shrink-0">
        <ChatHeader
          title={app?.name}
          description={app?.description}
          color={app?.color}
          icon={appIcon}
          showClearButton={showClearButton}
          showConfigButton={true}
          showParametersButton={mode === 'chat' && app?.variables && app.variables.length > 0}
          showCanvasButton={mode === 'chat' && app?.features?.canvas === true}
          showBackToChatButton={mode === 'canvas'}
          onClearChat={handleClear}
          onToggleConfig={onToggleConfig}
          onToggleCanvas={handleToggleCanvas}
          onToggleParameters={onToggleParameters}
          currentLanguage={currentLanguage}
          isMobile={mode === 'chat' ? window.innerWidth < 768 : undefined}
          parametersVisible={showParameters}
          onShare={onShare}
          showShareButton={showShareButton}
          messages={messages}
          exportSettings={exportSettings}
          appId={appId}
          chatId={chatId}
        />
      </div>

      {/* Configuration Panel */}
      {showConfig && (
        <div
          className={`relative flex-shrink-0 bg-white p-4 rounded-lg mb-4 shadow-sm border border-gray-200 ${
            mode === 'canvas' ? 'canvas-config-panel' : 'bg-gray-100'
          }`}
        >
          <button
            onClick={onToggleConfig}
            className="absolute top-2 right-2 text-gray-500 hover:text-gray-700 p-1"
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="close" size="lg" className="text-current" />
          </button>
          <AppConfigForm
            app={app}
            models={models}
            styles={styles}
            selectedModel={selectedModel}
            selectedStyle={selectedStyle}
            selectedOutputFormat={selectedOutputFormat}
            sendChatHistory={sendChatHistory}
            temperature={temperature}
            onModelChange={onModelChange}
            onStyleChange={onStyleChange}
            onOutputFormatChange={onOutputFormatChange}
            onSendChatHistoryChange={onSendChatHistoryChange}
            onTemperatureChange={onTemperatureChange}
            currentLanguage={currentLanguage}
          />
        </div>
      )}
    </>
  );
};

export default SharedAppHeader;
