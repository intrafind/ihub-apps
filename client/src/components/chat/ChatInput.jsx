import React, { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import VoiceInputComponent from "../VoiceInputComponent";
import Icon from "../Icon";
import ImageUploader from "../ImageUploader";
import FileUploader from "../FileUploader";

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
  onImageSelect,
  onFileSelect,
  allowEmptySubmit = false,
  inputRef = null,
  disabled = false,
  imageUploadEnabled = false,
  fileUploadEnabled = false,
  fileUploadConfig = {},
  selectedImage = null, // Add this prop to pass from parent
  selectedFile = null, // Add this prop to pass from parent
  showImageUploader: externalShowImageUploader = undefined,
  showFileUploader: externalShowFileUploader = undefined,
  onToggleImageUploader = null,
  onToggleFileUploader = null,
}) => {
  const { t, i18n } = useTranslation();
  const localInputRef = useRef(null);
  const actualInputRef = inputRef || localInputRef;
  const [internalShowImageUploader, setInternalShowImageUploader] = useState(false);
  const [internalShowFileUploader, setInternalShowFileUploader] = useState(false);
  
  // Determine if multiline mode is enabled based on app config
  // Default to true (multiline) if not specified in app config
  const multilineMode = app?.inputMode == 'mulitline' || app?.inputMode === 'multiline';
  
  // Use external state if provided, otherwise use internal state
  const showImageUploader = externalShowImageUploader !== undefined ? 
    externalShowImageUploader : internalShowImageUploader;
    
  const showFileUploader = externalShowFileUploader !== undefined ? 
    externalShowFileUploader : internalShowFileUploader;
    
  // First check for direct placeholder prop, then app.messagePlaceholder, then default
  const customPlaceholder = app?.messagePlaceholder ? 
    (typeof app.messagePlaceholder === 'object' ? 
      app.messagePlaceholder[i18n.language] || app.messagePlaceholder.en : 
      app.messagePlaceholder) : null;

  let defaultPlaceholder = isProcessing
    ? t("pages.appChat.thinking")
    : customPlaceholder
    ? customPlaceholder
    : allowEmptySubmit
    ? t("pages.appChat.optionalMessagePlaceholder", "Type here (optional)...")
    : t("pages.appChat.messagePlaceholder", "Type here...");
  
  // Store the current placeholder in a ref to ensure it persists
  const placeholderRef = useRef(defaultPlaceholder);
  
  // Only update the placeholder ref when relevant dependencies change
  useEffect(() => {
    placeholderRef.current = defaultPlaceholder;
    
    // Set the placeholder on the input element directly when it changes
    if (actualInputRef.current) {
      actualInputRef.current.placeholder = defaultPlaceholder;
    }
  }, [isProcessing, allowEmptySubmit, customPlaceholder, i18n.language]);
  
  // Debug logging
  useEffect(() => {
    console.log("ChatInput placeholder state:", {
      customPlaceholder,
      defaultPlaceholder,
      placeholderRef: placeholderRef.current,
      appPlaceholder: app?.messagePlaceholder,
      currentLanguage: i18n.language,
      isUsingCustom: Boolean(customPlaceholder),
      isProcessing,
      allowEmptySubmit
    });
  }, [customPlaceholder, defaultPlaceholder, isProcessing, allowEmptySubmit, i18n.language, app?.messagePlaceholder]);

  // When processing finishes, refocus the input field
  useEffect(() => {
    if (!isProcessing && actualInputRef.current) {
      actualInputRef.current.focus();
    }
  }, [isProcessing]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if ((value.trim() || allowEmptySubmit) && !isProcessing) {
      onSubmit(e);
      // Keep focus on the input so the user can continue typing
      setTimeout(() => {
        if (actualInputRef.current) {
          actualInputRef.current.focus();
        }
      }, 0);
    }
  };

  const handleClearInput = () => {
    onChange({ target: { value: "" } });
  };

  const handleCancel = (e) => {
    e.preventDefault(); // Prevent any form submission
    if (onCancel && typeof onCancel === "function") {
      console.log("Cancel button clicked, executing onCancel");
      onCancel();
    } else {
      console.warn("Cancel handler is not properly defined");
    }
  };

  const toggleImageUploader = () => {
    if (onToggleImageUploader) {
      // Use the external toggle function if provided
      onToggleImageUploader();
    } else {
      // Otherwise use the internal state
      setInternalShowImageUploader((prev) => !prev);
    }
  };

  const toggleFileUploader = () => {
    if (onToggleFileUploader) {
      // Use the external toggle function if provided
      onToggleFileUploader();
    } else {
      // Otherwise use the internal state
      setInternalShowFileUploader((prev) => !prev);
    }
  };

  // Handle key events for the textarea
  const handleKeyDown = (e) => {
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
      {imageUploadEnabled && showImageUploader && (
        <ImageUploader
          onImageSelect={onImageSelect}
          disabled={disabled || isProcessing}
          imageData={selectedImage} // Pass the actual selectedImage value from parent
        />
      )}

      {fileUploadEnabled && showFileUploader && (
        <FileUploader
          onFileSelect={onFileSelect}
          disabled={disabled || isProcessing}
          fileData={selectedFile} // Pass the actual selectedFile value from parent
          config={fileUploadConfig}
        />
      )}

      <form onSubmit={handleSubmit} className="flex space-x-2 items-center">
        <textarea
          type="text"
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          disabled={disabled || isProcessing}
          className="w-full p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500 pr-10"
          placeholder={placeholderRef.current}
          ref={actualInputRef}
          rows={multilineMode ? "2" : "1"}
          style={{ resize: multilineMode ? "vertical" : "none" }}
          title={multilineMode ? 
            t("input.multilineTooltip", "Press Shift+Enter for new line, Cmd+Enter to send") : 
            t("input.singlelineTooltip", "Press Enter to send")}
        />
        <span className="sr-only">
          
        </span>
        <div className="flex-1 relative">
          {value && (
            <button
              type="button"
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 h-fit"
              onClick={handleClearInput}
              title={t("common.clear", "Clear")}
            >
              <Icon name="clearCircle" size="sm" />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1 justify-start">
          {imageUploadEnabled && (
            <button
              type="button"
              onClick={toggleImageUploader}
              disabled={disabled || isProcessing}
              className={`image-upload-button ${
                showImageUploader ? "active" : ""
              } h-fit`}
              title={t("common.toggleImageUpload", "Toggle image upload")}
              aria-label={t("common.toggleImageUpload", "Toggle image upload")}
            >
              <Icon name="camera" size="md" />
            </button>
          )}

          {fileUploadEnabled && (
            <button
              type="button"
              onClick={toggleFileUploader}
              disabled={disabled || isProcessing}
              className={`image-upload-button ${
                showFileUploader ? "active" : ""
              } h-fit`}
              title={t("common.toggleFileUpload", "Toggle file upload")}
              aria-label={t("common.toggleFileUpload", "Toggle file upload")}
            >
              <Icon name="paper-clip" size="md" />
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
          disabled={
            disabled || (!allowEmptySubmit && !value.trim() && !isProcessing)
          }
          className={`px-4 py-3 rounded-lg font-medium flex items-center justify-center h-fit ${
            disabled || (!allowEmptySubmit && !value.trim() && !isProcessing)
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : isProcessing
              ? "bg-red-600 text-white hover:bg-red-700"
              : "bg-indigo-600 text-white hover:bg-indigo-700"
          }`}
        >
          {isProcessing ? (
            <>
              <Icon name="close" size="sm" className="mr-1" />
              <span>{t("common.cancel")}</span>
            </>
          ) : (
            <>
              <span>{t("common.send")}</span>
              {/* Display shortcut hint */}
              <span className="ml-1 text-xs opacity-70 hidden sm:inline">
                {multilineMode ? "⌘↵" : "↵"}
              </span>
            </>
          )}
        </button>
      </form>
    </div>
  );
};

export default ChatInput;
