import { useTranslation } from 'react-i18next';
import './VoiceMode.css';

/**
 * The waveform icon. Heroicons has no waveform, and an icon of five bars is
 * what ChatGPT and Claude use for this button, so it is drawn here. The bars
 * move while voice mode is open.
 */
export function VoiceWaveIcon({ active = false, className = 'h-5 w-5' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={`voice-wave-icon ${className}`}
      data-active={active ? 'true' : 'false'}
    >
      <rect x="2.5" y="10" width="2.2" height="4" rx="1.1" />
      <rect x="6.9" y="6.5" width="2.2" height="11" rx="1.1" />
      <rect x="11.3" y="3" width="2.2" height="18" rx="1.1" />
      <rect x="15.7" y="7.5" width="2.2" height="9" rx="1.1" />
      <rect x="20.1" y="10" width="2.2" height="4" rx="1.1" />
    </svg>
  );
}

/**
 * Starts (or, while it is open, ends) voice mode. Sits right next to the Send
 * button of the chat input. Clicking it is what lets the browser ask for the
 * microphone and unlock audio, so it must call `onClick` directly.
 *
 * @param {Object} props
 * @param {() => void} props.onClick
 * @param {boolean} [props.active] - Voice mode is open.
 * @param {boolean} [props.disabled]
 */
export default function VoiceModeButton({ onClick, active = false, disabled = false }) {
  const { t } = useTranslation();
  const label = active
    ? t('voiceMode.button.end', 'End voice mode')
    : t('voiceMode.button.start', 'Start voice mode');
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      data-testid="voice-mode-button"
      className={`flex items-center justify-center rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:p-2.5 ${
        active
          ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/50 dark:text-indigo-300 dark:hover:bg-indigo-900/70'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
      }`}
    >
      <VoiceWaveIcon active={active} />
    </button>
  );
}
