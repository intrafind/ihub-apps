import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import ChatMessageList from './ChatMessageList';
import ModelSelector from './ModelSelector';

/**
 * Side-by-side comparison view for two model outputs
 * @param {Object} props
 * @param {Object} props.app - App configuration
 * @param {Array} props.models - Available models
 * @param {string} props.currentLanguage - Current language
 * @param {string} props.leftModel - Selected left model ID
 * @param {string} props.rightModel - Selected right model ID
 * @param {Function} props.onLeftModelChange - Callback for left model change
 * @param {Function} props.onRightModelChange - Callback for right model change
 * @param {Array} props.leftMessages - Messages for left chat
 * @param {Array} props.rightMessages - Messages for right chat
 * @param {string} props.outputFormat - Output format (markdown, text, etc.)
 * @param {Function} props.onDelete - Message delete callback
 * @param {Function} props.onEdit - Message edit callback
 * @param {Function} props.onResend - Message resend callback
 * @param {string} props.appId - App ID
 * @param {string} props.leftChatId - Left chat ID
 * @param {string} props.rightChatId - Right chat ID
 */
function CompareModeView({
  app,
  models,
  currentLanguage,
  leftModel,
  rightModel,
  onLeftModelChange,
  onRightModelChange,
  leftMessages,
  rightMessages,
  outputFormat,
  onDelete,
  onEdit,
  onResend,
  appId,
  leftChatId,
  rightChatId,
  onOpenInCanvas,
  canvasEnabled,
  requiredIntegrations,
  onConnectIntegration,
  onClarificationSubmit,
  onClarificationSkip,
  onDocumentAction
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col md:flex-row gap-4 h-full overflow-hidden">
      {/* Left Panel */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200 dark:border-gray-700 pr-4">
        <div className="flex-shrink-0 mb-3 pb-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {t('chat.compareMode.modelA')}
            </span>
          </div>
          <ModelSelector
            app={app}
            models={models}
            selectedModel={leftModel}
            onModelChange={onLeftModelChange}
            currentLanguage={currentLanguage}
            dropdownDirection="down"
          />
        </div>
        <div className="flex-1 overflow-hidden">
          <ChatMessageList
            messages={leftMessages}
            outputFormat={outputFormat}
            onDelete={onDelete}
            onEdit={onEdit}
            onResend={onResend}
            editable={true}
            appId={appId}
            chatId={leftChatId}
            modelId={leftModel}
            onOpenInCanvas={onOpenInCanvas}
            canvasEnabled={canvasEnabled}
            requiredIntegrations={requiredIntegrations}
            onConnectIntegration={onConnectIntegration}
            app={app}
            models={models}
            onClarificationSubmit={onClarificationSubmit}
            onClarificationSkip={onClarificationSkip}
            onDocumentAction={onDocumentAction}
            compact={true}
          />
        </div>
      </div>

      {/* Right Panel */}
      <div className="flex-1 flex flex-col min-w-0 pl-4">
        <div className="flex-shrink-0 mb-3 pb-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {t('chat.compareMode.modelB')}
            </span>
          </div>
          <ModelSelector
            app={app}
            models={models}
            selectedModel={rightModel}
            onModelChange={onRightModelChange}
            currentLanguage={currentLanguage}
            dropdownDirection="down"
          />
        </div>
        <div className="flex-1 overflow-hidden">
          <ChatMessageList
            messages={rightMessages}
            outputFormat={outputFormat}
            onDelete={onDelete}
            onEdit={onEdit}
            onResend={onResend}
            editable={true}
            appId={appId}
            chatId={rightChatId}
            modelId={rightModel}
            onOpenInCanvas={onOpenInCanvas}
            canvasEnabled={canvasEnabled}
            requiredIntegrations={requiredIntegrations}
            onConnectIntegration={onConnectIntegration}
            app={app}
            models={models}
            onClarificationSubmit={onClarificationSubmit}
            onClarificationSkip={onClarificationSkip}
            onDocumentAction={onDocumentAction}
            compact={true}
          />
        </div>
      </div>
    </div>
  );
}

export default CompareModeView;
