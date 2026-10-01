import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { toggle, stop } from '../utils/readAloud';

/**
 * Read-aloud control in a chat message's action row: play → pause ⇄ resume,
 * plus a stop button while the message is playing or paused. Clicking while
 * the first audio is still loading cancels.
 *
 * @param {Object} props
 * @param {string} props.messageId
 * @param {string} props.text - What to read (Markdown; the server strips it).
 * @param {string|null} [props.modelId] - TTS model; null uses the platform default.
 * @param {{ state: string, error: string|null }} props.playback - From `useReadAloudPlayback`.
 */
function ReadAloudButton({ messageId, text, modelId = null, playback }) {
  const { t, i18n } = useTranslation();
  const { state, error } = playback;

  let icon = 'speaker-wave';
  let label = t('chatMessage.readAloud', 'Read aloud');
  let className = 'hover:text-gray-700';
  if (state === 'loading') {
    icon = 'spinner';
    label = t('chatMessage.readAloudLoading', 'Loading audio… click to cancel');
    className = 'text-indigo-600 hover:text-indigo-700';
  } else if (state === 'playing') {
    icon = 'pause';
    label = t('chatMessage.readAloudPause', 'Pause');
    className = 'text-indigo-600 hover:text-indigo-700';
  } else if (state === 'paused') {
    icon = 'play';
    label = t('chatMessage.readAloudResume', 'Resume');
    className = 'text-indigo-600 hover:text-indigo-700';
  } else if (state === 'error') {
    label = t('chatMessage.readAloudError', 'Read aloud failed: {{error}}', {
      error: error || ''
    });
    className = 'text-red-500 hover:text-red-600';
  }

  const active = state === 'playing' || state === 'paused';

  return (
    <>
      <button
        type="button"
        onClick={() =>
          toggle(messageId, { text, modelId: modelId || undefined, language: i18n.language })
        }
        className={`flex items-center gap-1 transition-colors duration-150 ${className}`}
        title={label}
        aria-label={label}
        aria-pressed={active}
      >
        <Icon name={icon} size="sm" className={state === 'loading' ? 'animate-spin' : undefined} />
      </button>
      {active && (
        <button
          type="button"
          onClick={() => stop(messageId)}
          className="flex items-center gap-1 text-indigo-600 hover:text-indigo-700 transition-colors duration-150"
          title={t('chatMessage.readAloudStop', 'Stop reading')}
          aria-label={t('chatMessage.readAloudStop', 'Stop reading')}
        >
          <Icon name="stop" size="sm" />
        </button>
      )}
    </>
  );
}

export default ReadAloudButton;
