import React from 'react';
import { useTranslation } from 'react-i18next';
import ChatMessageList from '../chat/ChatMessageList';
import ChatInput from '../chat/ChatInput';
import Icon from '../Icon';

const CanvasChatPanel = ({
  messages,
  inputValue,
  onInputChange,
  onSubmit,
  isProcessing,
  onCancel,
  onDelete,
  onEdit,
  onResend,
  app,
  appId,
  chatId,
  selectedText,
  onClearSelection,
  width,
  cleanupEventSource,
  inputRef
}) => {
  const { t } = useTranslation();

  return (
    <div 
      className="canvas-chat-panel bg-white border border-gray-300 flex flex-col h-full min-h-0 rounded-lg overflow-hidden"
      style={{ width: `${width}%` }}
    >
      {/* Chat Messages */}
      <div className="canvas-chat-messages flex-1 min-h-0 overflow-y-auto bg-white">
        <div className="h-full">
          <ChatMessageList
            messages={messages}
            outputFormat="markdown"
            onDelete={onDelete}
            onEdit={onEdit}
            onResend={onResend}
            editable={false}
            appId={appId}
            chatId={chatId}
            compact={true}
          />
        </div>
      </div>

      {/* Chat Input */}
      <div className="canvas-chat-input flex-shrink-0 p-4 border-t border-gray-200 bg-white">
        {selectedText && (
          <div className="mb-3 p-3 bg-blue-50 rounded-lg border border-blue-200 relative">
            <button
              type="button"
              className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
              onClick={onClearSelection}
              title={t('common.clear', 'Clear')}
            >
              <Icon name="clearCircle" size="sm" />
            </button>
            <div className="flex items-center gap-2 mb-1">
              <Icon name="cursor-text" size="sm" className="text-blue-600" />
              <span className="text-xs font-medium text-blue-800">Selected text:</span>
            </div>
            <p className="text-xs text-blue-700 line-clamp-2">"{selectedText}"</p>
          </div>
        )}
        <ChatInput
          app={app}
          value={inputValue}
          onChange={onInputChange}
          onSubmit={onSubmit}
          isProcessing={isProcessing}
          onCancel={onCancel}
          onVoiceInput={() => {}} // Voice input can be added later if needed
          selectedImage={null}
          selectedFile={null}
          imageUploadConfig={{}}
          showImageUploader={false}
          showFileUploader={false}
          inputRef={inputRef}
          placeholder={selectedText ?
            t('canvas.promptWithSelection', 'What would you like to do with the selected text?') :
            t('canvas.promptPlaceholder', 'Ask the AI to help with your document...')
          }
          allowEmptySubmit={false}
          appId={appId}
          fileUploadConfig={{ maxFileSize: 10, allowedFileTypes: [] }}
          cleanupEventSource={cleanupEventSource}
        />
      </div>
    </div>
  );
};

export default CanvasChatPanel;
