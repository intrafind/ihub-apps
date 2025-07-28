import { useRef, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { VoiceInputComponent } from '../../voice/components';
import Icon from '../../../shared/components/Icon';
import MagicPromptLoader from '../../../shared/components/MagicPromptLoader';
import { UnifiedUploader } from '../../upload/components';
import PromptSearch from '../../prompts/components/PromptSearch';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

/**
 * A reusable chat input component for chat interfaces
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
  disabled = false,
  uploadConfig = {},
  selectedFile = null, // Add this prop to pass from parent
  showUploader: externalShowUploader = undefined,
  onToggleUploader = null,
  magicPromptEnabled = false,
  onMagicPrompt = null,
  showUndoMagicPrompt = false,
  onUndoMagicPrompt = null,
  magicPromptLoading = false
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

  let defaultPlaceholder = isProcessing
    ? t('pages.appChat.thinking')
    : customPlaceholder
      ? customPlaceholder
      : allowEmptySubmit
        ? t('pages.appChat.optionalMessagePlaceholder', 'Type here (optional)...')
        : t('pages.appChat.messagePlaceholder', 'Type here...');

  // Store the current placeholder in a ref to ensure it persists

  // Debug logging
  // useEffect(() => {
  //   console.log("ChatInput placeholder state:", {
  //     customPlaceholder,
  //     defaultPlaceholder,
  //     placeholderRef: placeholderRef.current,
  //     appPlaceholder: app?.messagePlaceholder,
  //     currentLanguage: i18n.language,
  //     isUsingCustom: Boolean(customPlaceholder),
  //     isProcessing,
  //     allowEmptySubmit
  //   });
  // }, [customPlaceholder, defaultPlaceholder, isProcessing, allowEmptySubmit, i18n.language, app?.messagePlaceholder]);

  const focusInputAtEnd = useCallback(() => {
    if (actualInputRef.current) {
      const el = actualInputRef.current;
      el.focus();
      const len = el.value.length;
      // Move cursor to the end so users can continue typing
      el.setSelectionRange(len, len);
    }
  }, [actualInputRef]);

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
    <div className="chat-input-container">
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
          disabled={disabled || isProcessing}
          fileData={selectedFile} // Pass the actual selectedFile value from parent
          config={uploadConfig}
        />
      )}

      <form onSubmit={handleSubmit} autoComplete="off" className="flex space-x-2 items-center">
        <textarea
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          type="text"
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          disabled={disabled || isProcessing}
          className="w-full p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500 pr-10"
          placeholder={defaultPlaceholder}
          ref={actualInputRef}
          style={{
            resize: multilineMode ? 'vertical' : 'none',
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
        <span className="sr-only"></span>
        <div className="flex-1 relative">
          {value && (
            <button
              type="button"
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 h-fit"
              onClick={handleClearInput}
              title={t('common.clear', 'Clear')}
            >
              <Icon name="clearCircle" size="sm" />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1 justify-start">
          {uploadConfig?.enabled === true && (
            <button
              type="button"
              onClick={toggleUploader}
              disabled={disabled || isProcessing}
              className={`image-upload-button ${showUploader ? 'active' : ''} h-fit`}
              title={t('common.toggleUpload', 'Toggle file upload')}
              aria-label={t('common.toggleUpload', 'Toggle file upload')}
            >
              <Icon name="paper-clip" size="md" />
            </button>
          )}

          {magicPromptEnabled && !showUndoMagicPrompt && (
            <button
              type="button"
              onClick={onMagicPrompt}
              disabled={disabled || isProcessing}
              className="image-upload-button h-fit"
              title={t('common.magicPrompt', 'Magic prompt')}
              aria-label={t('common.magicPrompt', 'Magic prompt')}
            >
              {magicPromptLoading ? <MagicPromptLoader /> : <Icon name="sparkles" size="md" />}
            </button>
          )}

          {showUndoMagicPrompt && (
            <button
              type="button"
              onClick={onUndoMagicPrompt}
              disabled={disabled || isProcessing}
              className="image-upload-button h-fit"
              title={t('common.undo', 'Undo')}
              aria-label={t('common.undo', 'Undo')}
            >
              <Icon name="arrowLeft" size="md" />
            </button>
          )}

          {onVoiceInput && (
            <VoiceInputComponent
              app={app}
              onSpeechResult={onVoiceInput}
              inputRef={actualInputRef}
              disabled={disabled || isProcessing}
              onCommand={onVoiceCommand}
            />
          )}
        </div>

        <button
          type="button"
          onClick={isProcessing ? handleCancel : handleSubmit}
          disabled={disabled || (!allowEmptySubmit && !value.trim() && !isProcessing)}
          className={`px-4 py-3 rounded-lg font-medium flex items-center justify-center h-fit ${
            disabled || (!allowEmptySubmit && !value.trim() && !isProcessing)
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : isProcessing
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-indigo-600 text-white hover:bg-indigo-700'
          }`}
        >
          {isProcessing ? (
            <>
              <Icon name="close" size="sm" className="mr-1" />
              <span>{t('common.cancel')}</span>
            </>
          ) : (
            <>
              <span>{t('common.send')}</span>
              {/* Display shortcut hint */}
              <span className="ml-1 text-xs opacity-70 hidden sm:inline">
                {multilineMode ? '⌘↵' : '↵'}
              </span>
            </>
          )}
        </button>
      </form>
    </div>
  );
};

export default ChatInput;
