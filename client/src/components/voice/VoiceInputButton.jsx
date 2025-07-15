import React from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';
import './VoiceInput.css';

const VoiceInputButton = ({ isListening, toggleListening, disabled, microphoneMode }) => {
  const { t } = useTranslation();
  return (
    <button
      className={`voice-input-button ${isListening ? 'active' : ''} h-fit`}
      onClick={e => {
        e.preventDefault();
        toggleListening();
      }}
      type="button"
      disabled={disabled}
      title={
        microphoneMode === 'manual'
          ? t('voiceInput.tooltipManual', 'Voice input (Ctrl+M) - manual')
          : t('voiceInput.tooltipAutomatic', 'Voice input (Ctrl+M) - automatic')
      }
      aria-label={t('voiceInput.ariaLabel', 'Toggle voice input')}
    >
      <Icon name="microphone" size="md" />
    </button>
  );
};

export default VoiceInputButton;
