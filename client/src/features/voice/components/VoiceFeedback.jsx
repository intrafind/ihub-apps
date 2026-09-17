import { useTranslation } from 'react-i18next';

const wavesCount = 3;

const VoiceFeedback = props => {
  const { isActive, setIsActive, transcript = '', mode = 'automatic', errorMessage = '' } = props;
  const { t } = useTranslation();

  const onClose = () => {
    setIsActive(false);
  };

  const hasError = !!errorMessage;

  return (
    <div
      id="voice-feedback"
      className={`voice-feedback ${isActive ? 'active' : ''} ${hasError ? 'error' : ''}`}
    >
      <div className="voice-feedback-content">
        {hasError ? (
          <>
            <div className="voice-error-icon" aria-hidden="true">
              !
            </div>
            <h3 className="voice-text">{t('voiceInput.errorTitle', 'Voice input error')}</h3>
            <span className="voice-error-message" role="alert">
              {errorMessage}
            </span>
          </>
        ) : (
          <>
            <div className="voice-waves">
              {Array.from(Array(wavesCount).keys()).map((_, index) => (
                <div key={`wave-${index}`} className="wave" />
              ))}
            </div>
            <h3 className="voice-text">{t('voiceInput.listening', 'Listening...')}</h3>
            <span className="voice-mode">
              {mode === 'manual'
                ? t('voiceInput.modeManual', 'Manual mode - click close when finished')
                : t('voiceInput.modeAutomatic', 'Automatic mode - stops when you stop speaking')}
            </span>
            <span className="voice-instructions">
              {t('voiceInput.instructions', 'Speak clearly and naturally')}
            </span>
            {transcript && <div className="voice-transcript">{transcript}</div>}
          </>
        )}
        <button className="voice-close" onClick={onClose} type="button">
          &times;
        </button>
      </div>
    </div>
  );
};

export default VoiceFeedback;
