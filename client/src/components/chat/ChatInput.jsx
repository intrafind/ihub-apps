import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import VoiceInputComponent from "../VoiceInputComponent";
import Icon from "../Icon";

/**
 * A reusable chat input component for chat interfaces
 */
const ChatInput = ({
  value,
  onChange,
  onSubmit,
  isProcessing,
  onCancel,
  onVoiceInput,
  onVoiceCommand,
  allowEmptySubmit = false,
  placeholder,
  inputRef = null,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const localInputRef = useRef(null);
  const actualInputRef = inputRef || localInputRef;

  const defaultPlaceholder = isProcessing
    ? t("pages.appChat.thinking")
    : allowEmptySubmit
    ? t(
        "pages.appChat.optionalMessagePlaceholder",
        "Type a message (optional)..."
      )
    : t("pages.appChat.messagePlaceholder", "Type your message here...");

  const handleSubmit = (e) => {
    e.preventDefault();
    if ((value.trim() || allowEmptySubmit) && !isProcessing) {
      onSubmit(e);
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

  return (
    <form onSubmit={handleSubmit} className="flex space-x-2">
      <div className="flex-1 relative">
        <textarea
          type="text"
          value={value}
          onChange={onChange}
          disabled={disabled || isProcessing}
          className="w-full p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500 pr-10"
          placeholder={placeholder || defaultPlaceholder}
          ref={actualInputRef}
        />
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

      {onVoiceInput && (
        <VoiceInputComponent
          onSpeechResult={onVoiceInput}
          inputRef={actualInputRef}
          disabled={disabled || isProcessing}
          onCommand={onVoiceCommand}
        />
      )}

      <button
        type="button"
        onClick={isProcessing ? handleCancel : handleSubmit}
        disabled={
          disabled || (!allowEmptySubmit && !value.trim() && !isProcessing)
        }
        className={`px-4 py-2 rounded-lg font-medium flex items-center justify-center h-fit ${
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
            <Icon name="arrowRight" size="sm" className="ml-1" />
          </>
        )}
      </button>
    </form>
  );
};

export default ChatInput;
