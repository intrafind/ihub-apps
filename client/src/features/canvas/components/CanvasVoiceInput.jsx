import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { VoiceFeedback } from '../../voice/components';
import useVoiceRecognition from '../../voice/hooks/useVoiceRecognition';
import Icon from '../../../shared/components/Icon';
import '../../voice/components/VoiceInput.css';

const CanvasVoiceInput = ({ app, onSpeechResult, disabled = false, quillRef }) => {
  const { t } = useTranslation();
  const dummyInputRef = useRef(null);

  const { isListening, transcript, toggleListening, stopListening, microphoneMode } =
    useVoiceRecognition({
      app,
      inputRef: dummyInputRef,
      onSpeechResult: (text, skipAppend = false) => {
        // Insert text directly into the Quill editor
        if (quillRef?.current && text.trim()) {
          const quill = quillRef.current.getEditor();
          const range = quill.getSelection(true);

          if (range) {
            quill.insertText(range.index, text + ' ', 'user');
            // Move cursor to end of inserted text
            quill.setSelection(range.index + text.length + 1);
          } else {
            // If no selection, append to end
            const length = quill.getLength();
            quill.insertText(length - 1, text + ' ', 'user');
            quill.setSelection(length + text.length);
          }

          // Focus the editor
          quill.focus();

          // Call the callback to update parent state
          if (onSpeechResult) {
            onSpeechResult(text);
          }

          // Reset the dummy input to prevent accumulation for next voice input
          if (dummyInputRef.current) {
            dummyInputRef.current.value = '';
          }
        }
      },
      disabled
    });

  // Custom toggle function that resets the dummy input before starting
  const handleToggleListening = () => {
    if (!isListening) {
      // Reset dummy input before starting new voice recognition
      if (dummyInputRef.current) {
        dummyInputRef.current.value = '';
      }
    }
    toggleListening();
  };

  // Handle keyboard shortcut for canvas voice input
  useEffect(() => {
    const handleKeyDown = e => {
      // Only handle shortcut if the editor is focused or cursor is in canvas area
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        const activeElement = document.activeElement;
        const isInCanvas =
          activeElement?.closest('.canvas-editor-container') ||
          activeElement?.classList.contains('ql-editor');

        if (isInCanvas) {
          e.preventDefault();
          handleToggleListening();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleToggleListening]);

  return (
    <>
      <VoiceFeedback
        isActive={isListening}
        setIsActive={() => stopListening()}
        transcript={
          app?.inputMode?.microphone?.showTranscript || app?.microphone?.showTranscript
            ? transcript
            : ''
        }
        mode={microphoneMode}
      />
      <button
        className={`modern-btn voice-input-button ${isListening ? 'active' : ''}`}
        onClick={e => {
          e.preventDefault();
          handleToggleListening();
        }}
        type="button"
        disabled={disabled}
        title={
          microphoneMode === 'manual'
            ? t('canvas.voiceInput.tooltipManual', 'Dictate to editor (Ctrl+M) - manual')
            : t('canvas.voiceInput.tooltipAutomatic', 'Dictate to editor (Ctrl+M) - automatic')
        }
        aria-label={t('canvas.voiceInput.ariaLabel', 'Dictate text to editor')}
      >
        <Icon name="microphone" size="sm" />
      </button>
      {/* Hidden dummy input for voice recognition hook compatibility */}
      <input ref={dummyInputRef} type="text" style={{ display: 'none' }} readOnly />
    </>
  );
};

export default CanvasVoiceInput;
