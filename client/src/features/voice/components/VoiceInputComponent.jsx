import { useEffect } from 'react';
import VoiceFeedback from './VoiceFeedback';
import useVoiceRecognition from '../hooks/useVoiceRecognition';
import VoiceInputButton from './VoiceInputButton';

const VoiceInputComponent = ({
  app,
  onSpeechResult,
  inputRef,
  disabled = false,
  onCommand = null
}) => {
  const {
    isListening,
    transcript,
    errorMessage,
    clearError,
    toggleListening,
    stopListening,
    microphoneMode
  } = useVoiceRecognition({ app, inputRef, onSpeechResult, onCommand, disabled });

  useEffect(() => {
    const handleKeyDown = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        toggleListening();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggleListening]);

  const handleOnFeedbackOverlayClose = () => {
    stopListening();
    clearError();
  };

  return (
    <>
      <VoiceFeedback
        isActive={isListening || !!errorMessage}
        setIsActive={handleOnFeedbackOverlayClose}
        transcript={
          app?.inputMode?.microphone?.showTranscript || app?.microphone?.showTranscript
            ? transcript
            : ''
        }
        mode={microphoneMode}
        errorMessage={errorMessage}
      />
      <VoiceInputButton
        isListening={isListening}
        toggleListening={toggleListening}
        disabled={disabled}
        microphoneMode={microphoneMode}
      />
    </>
  );
};

export default VoiceInputComponent;
