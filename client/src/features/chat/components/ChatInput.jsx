import { useRef, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { UnifiedUploader } from '../../upload/components';
import PromptSearch from '../../prompts/components/PromptSearch';
import ChatInputActionsMenu from './ChatInputActionsMenu';
import ImageGenerationControls from './ImageGenerationControls';
import ModelSelector from './ModelSelector';
import { VoiceInputComponent } from '../../voice/components';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

/**
 * Chat input component following Claude's design
 * Two-line layout:
 * - Top line: User input (auto-expanding textarea)
 * - Bottom line: Actions menu (+), model selector, send/stop button
 */
const ChatInput = ({
  app,
  value,
  onChange,
  onSubmit,
  isProcessing,
  onCancel,
  onVoiceInput,
  onVoiceCommand,
  onFileSelect,
  allowEmptySubmit = false,
  inputRef = null,
  formRef = null,
  disabled = false,
  uploadConfig = {},
  selectedFile = null,
  showUploader: externalShowUploader = undefined,
  onToggleUploader = null,
  magicPromptEnabled = false,
  onMagicPrompt = null,
  showUndoMagicPrompt = false,
  onUndoMagicPrompt = null,
  magicPromptLoading = false,
  enabledTools = [],
  onEnabledToolsChange = null,
  // Model selection props
  models = [],
  selectedModel = null,
  onModelChange = null,
  currentLanguage = 'en',
  showModelSelector = true,
  // Image generation props
  model = null,
  imageAspectRatio = null,
  imageQuality = null,
  onImageAspectRatioChange = null,
  onImageQualityChange = null,
  // Clarification state
  clarificationPending = false // When true, input is disabled waiting for clarification answer
}) => {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const localInputRef = useRef(null);
  const actualInputRef = inputRef || localInputRef;
  const [internalShowUploader, setInternalShowUploader] = useState(false);
  const [showPromptSearch, setShowPromptSearch] = useState(false);
  const promptsListEnabled =
    uiConfig?.promptsList?.enabled !== false && app?.features?.promptsList !== false;

  // Determine input mode configuration
  const inputMode = app?.inputMode;
  const multilineMode = inputMode?.type === 'multiline' || inputMode === 'multiline';
  const inputRows = multilineMode ? inputMode?.rows || 2 : 1;

  // Use external state if provided, otherwise use internal state
  const showUploader =
    externalShowUploader !== undefined ? externalShowUploader : internalShowUploader;

  // First check for direct placeholder prop, then app.messagePlaceholder, then default
  const customPlaceholder = app?.messagePlaceholder
    ? typeof app.messagePlaceholder === 'object'
      ? app.messagePlaceholder[i18n.language] || app.messagePlaceholder.en
      : app.messagePlaceholder
    : null;

  // Determine placeholder text based on state
  let defaultPlaceholder;
  if (clarificationPending) {
    // When waiting for clarification response, show a helpful message
    defaultPlaceholder = t(
      'pages.appChat.answerQuestionAbove',
      'Please answer the question above to continue'
    );
  } else if (isProcessing) {
    defaultPlaceholder = t('pages.appChat.thinking');
  } else if (customPlaceholder) {
    defaultPlaceholder = customPlaceholder;
  } else if (allowEmptySubmit) {
    defaultPlaceholder = t('pages.appChat.optionalMessagePlaceholder', 'Type here (optional)...');
  } else {
    defaultPlaceholder = t('pages.appChat.messagePlaceholder', 'Type here...');
  }

  // Disable input when clarification is pending
  const isInputDisabled = disabled || clarificationPending;

  const focusInputAtEnd = useCallback(() => {
    if (actualInputRef.current) {
      const el = actualInputRef.current;
      el.focus();
      const len = el.value.length;
      // Move cursor to the end so users can continue typing
      el.setSelectionRange(len, len);
    }
  }, [actualInputRef]);

  // Calculate if single-action optimization is active in ChatInputActionsMenu
  // This logic mirrors the calculation in ChatInputActionsMenu.jsx
  const hasTools = app?.tools && app.tools.length > 0;
  const quickActionCount =
    (uploadConfig?.enabled === true ? 1 : 0) +
    (magicPromptEnabled && !showUndoMagicPrompt ? 1 : 0) +
    (showUndoMagicPrompt ? 1 : 0) +
    (onVoiceInput ? 1 : 0);
  const totalActions = quickActionCount + (hasTools ? 1 : 0);
  const isSingleActionOptimization = totalActions === 1 && quickActionCount === 1 && !hasTools;

  // When processing finishes, refocus the input field
  useEffect(() => {
    if (!isProcessing) {
      focusInputAtEnd();
    }
  }, [isProcessing, focusInputAtEnd]);

  // Auto-resize textarea
  useEffect(() => {
    if (actualInputRef.current) {
      const textarea = actualInputRef.current;

      const autoResize = () => {
        // Reset height to auto to get the correct scrollHeight
        textarea.style.height = 'auto';

        // Calculate the new height based on content
        const scrollHeight = textarea.scrollHeight;
        const minHeight = inputRows * 1.5 * 16; // Convert em to px (assuming 16px base font size)
        const maxHeight = (multilineMode ? 12 : 3) * 1.5 * 16 + 24; // 12 lines + padding (1.5rem = 24px)

        // Set the height to fit content, but respect min/max limits
        const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
        textarea.style.height = `${newHeight}px`;
      };

      // Initial resize
      autoResize();

      // Add event listener for input changes
      textarea.addEventListener('input', autoResize);

      return () => {
        textarea.removeEventListener('input', autoResize);
      };
    }
  }, [value, multilineMode, inputRows, actualInputRef]);

  const handleSubmit = e => {
    e.preventDefault();
    if ((value.trim() || allowEmptySubmit) && !isProcessing) {
      onSubmit(e);
      // Keep focus on the input so the user can continue typing
      setTimeout(() => {
        focusInputAtEnd();
      }, 0);
    }
  };

  const handleClearInput = () => {
    onChange({ target: { value: '' } });
  };

  const handleCancel = e => {
    e.preventDefault(); // Prevent any form submission
    if (onCancel && typeof onCancel === 'function') {
      console.log('Cancel button clicked, executing onCancel');
      onCancel();
    } else {
      console.warn('Cancel handler is not properly defined');
    }
  };

  const toggleUploader = () => {
    if (onToggleUploader) {
      // Use the external toggle function if provided
      onToggleUploader();
    } else {
      // Otherwise use the internal state
      setInternalShowUploader(prev => !prev);
    }
  };

  // Handle key events for the textarea
  const handleKeyDown = e => {
    if (promptsListEnabled && !showPromptSearch && e.key === '/' && value === '') {
      e.preventDefault();
      setShowPromptSearch(true);
      return;
    }

    if (showPromptSearch) {
      if (e.key === 'Escape') {
        setShowPromptSearch(false);
      }
      return;
    }

    // CMD+Enter or CTRL+Enter to submit
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e);
      return;
    }

    // In single-line mode, Enter key submits the form
    if (!multilineMode && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e);
      return;
    }
  };

  return (
    <div className="next-gen-chat-input-container">
      {promptsListEnabled && (
        <PromptSearch
          isOpen={showPromptSearch}
          appId={app?.id}
          onClose={() => setShowPromptSearch(false)}
          onSelect={p => {
            onChange({ target: { value: p.prompt.replace('[content]', '') } });
            setShowPromptSearch(false);
            setTimeout(() => {
              focusInputAtEnd();
            }, 0);
          }}
        />
      )}
      {uploadConfig?.enabled === true && showUploader && (
        <UnifiedUploader
          onFileSelect={onFileSelect}
          disabled={isInputDisabled || isProcessing}
          fileData={selectedFile}
          config={uploadConfig}
        />
      )}

      <form
        ref={formRef}
        onSubmit={handleSubmit}
        autoComplete="off"
        className="flex flex-col border border-gray-300 dark:border-gray-600 rounded-2xl bg-white dark:bg-gray-800 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500 mb-1"
      >
        {/* Top line: User input */}
        <div className="relative flex-1">
          <textarea
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            type="text"
            value={value}
            onChange={onChange}
            onKeyDown={handleKeyDown}
            disabled={isInputDisabled || isProcessing}
            className="w-full px-3 py-2 pr-10 bg-transparent border-0 focus:ring-0 focus:outline-none resize-none dark:text-gray-100"
            placeholder={defaultPlaceholder}
            ref={actualInputRef}
            style={{
              minHeight: multilineMode ? `${inputRows * 1.5}em` : undefined,
              maxHeight: multilineMode ? 'calc(11 * 1.5em + 1.5rem)' : undefined,
              overflowY: multilineMode ? 'auto' : 'hidden',
              height: multilineMode ? 'auto' : undefined
            }}
            title={
              multilineMode
                ? t('input.multilineTooltip', 'Press Shift+Enter for new line, Cmd+Enter to send')
                : t('input.singlelineTooltip', 'Press Enter to send')
            }
          />
          {value && (
            <button
              type="button"
              className="absolute right-3 top-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              onClick={handleClearInput}
              title={t('common.clear', 'Clear')}
            >
              <Icon name="clearCircle" size="sm" />
            </button>
          )}
        </div>

        {/* Bottom line: Actions menu, model selector, send/stop button */}
        <div className="flex items-center gap-2 px-3 pb-2 border-t border-gray-100 dark:border-gray-700/50 pt-2">
          {/* Chat Input Actions Menu */}
          <ChatInputActionsMenu
            app={app}
            enabledTools={enabledTools}
            onEnabledToolsChange={onEnabledToolsChange}
            uploadConfig={uploadConfig}
            onToggleUploader={onToggleUploader || toggleUploader}
            disabled={isInputDisabled}
            isProcessing={isProcessing}
            magicPromptEnabled={magicPromptEnabled}
            onMagicPrompt={onMagicPrompt}
            showUndoMagicPrompt={showUndoMagicPrompt}
            onUndoMagicPrompt={onUndoMagicPrompt}
            magicPromptLoading={magicPromptLoading}
            onVoiceInput={onVoiceInput}
            onVoiceCommand={onVoiceCommand}
            inputRef={actualInputRef}
            model={model}
            imageAspectRatio={imageAspectRatio}
            imageQuality={imageQuality}
            onImageAspectRatioChange={onImageAspectRatioChange}
            onImageQualityChange={onImageQualityChange}
          />

          {/* Upload icon - show directly on desktop if enabled and NOT in single-action mode */}
          {/* When single action, ChatInputActionsMenu shows it directly without a menu */}
          {uploadConfig?.enabled === true && !isSingleActionOptimization && (
            <button
              type="button"
              onClick={onToggleUploader || toggleUploader}
              disabled={isInputDisabled || isProcessing}
              title={t('chatActions.attachFile', 'Attach File')}
              className="hidden md:flex p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              <Icon name="paper-clip" size="md" />
            </button>
          )}

          {/* Microphone icon - show directly on desktop if enabled and NOT in single-action mode */}
          {/* When single action, ChatInputActionsMenu shows it directly without a menu */}
          {onVoiceInput && !isSingleActionOptimization && (
            <div className="hidden md:flex">
              <VoiceInputComponent
                app={app}
                onSpeechResult={onVoiceInput}
                inputRef={actualInputRef}
                disabled={isInputDisabled || isProcessing}
                onCommand={onVoiceCommand}
              />
            </div>
          )}

          {/* Image Generation Controls - Show on desktop only if model supports it */}
          {model?.supportsImageGeneration && (
            <div className="hidden md:flex gap-2">
              <ImageGenerationControls
                app={app}
                model={model}
                imageAspectRatio={imageAspectRatio}
                imageQuality={imageQuality}
                onImageAspectRatioChange={onImageAspectRatioChange}
                onImageQualityChange={onImageQualityChange}
                inline={true}
              />
            </div>
          )}

          <div className="flex-1"></div>

          {/* Warning when no models are available */}
          {showModelSelector && (!models || models.length === 0) && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <Icon name="exclamationTriangle" size="sm" />
              <span>{t('chat.modelSelector.noModels', 'No models available')}</span>
            </div>
          )}

          {/* Model Selector */}
          {showModelSelector && models && models.length > 0 && onModelChange && (
            <ModelSelector
              app={app}
              models={models}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              currentLanguage={currentLanguage}
              disabled={isInputDisabled || isProcessing}
            />
          )}

          {/* Send/Stop Button */}
          <button
            type="button"
            onClick={isProcessing ? handleCancel : handleSubmit}
            disabled={isInputDisabled || (!allowEmptySubmit && !value.trim() && !isProcessing)}
            className={`p-2.5 rounded-lg font-medium flex items-center justify-center transition-colors ${
              disabled || (!allowEmptySubmit && !value.trim() && !isProcessing)
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'
                : isProcessing
                  ? 'bg-red-500 text-white hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700'
                  : 'bg-indigo-500 text-white hover:bg-indigo-600 dark:bg-indigo-600 dark:hover:bg-indigo-700'
            }`}
            title={isProcessing ? t('common.cancel', 'Cancel') : t('common.send', 'Send')}
          >
            {isProcessing ? <Icon name="close" size="md" /> : <Icon name="arrow-up" size="md" />}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ChatInput;
