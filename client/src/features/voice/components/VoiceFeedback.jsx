import { useTranslation } from 'react-i18next';

const wavesCount = 3;

const VoiceFeedback = props => {
  const { isActive, setIsActive, transcript = '', mode = 'automatic', isModelLoading = false, loadingProgress = 0 } = props;
  const { t } = useTranslation();

  const onClose = () => {
    setIsActive(false);
  };

  return (
    <div id="voice-feedback" className={`voice-feedback ${isActive ? 'active' : ''}`}>
      <div className="voice-feedback-content">
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
        {isModelLoading && (
          <div className="mt-2">
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${Math.max(2, loadingProgress || 0)}%` }}
              />
            </div>
            <span className="text-sm text-gray-500 dark:text-gray-400 mt-1 block">
              {t('voiceInput.loadingModel', 'Loading speech model...')} {Math.round(loadingProgress || 0)}%
            </span>
          </div>
        )}
        {transcript && <div className="voice-transcript">{transcript}</div>}
        <button className="voice-close" onClick={onClose} type="button">
          &times;
        </button>
      </div>
    </div>
  );
};

export default VoiceFeedback;
