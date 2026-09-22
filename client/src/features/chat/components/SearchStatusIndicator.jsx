import { useTranslation } from 'react-i18next';

/**
 * The phase an iAssistant turn is currently in — "Analyzing current
 * knowledge", "Starting search", "Generating answer".
 *
 * This is the turn's *only* loading indicator while it is showing: it carries
 * the animated dots itself, so the generic three-dot row in ChatMessage stands
 * down whenever a phase is known. Two sets of bouncing dots on one message is
 * what the duplicate indicator looked like.
 *
 * What the turn searched for and found lives in SearchSummary instead, because
 * that outlives the answer and this does not.
 *
 * @param {Object} props
 * @param {Object} props.status - Search status event { event: string, ... }
 */
function SearchStatusIndicator({ status }) {
  const { t } = useTranslation();

  if (!status) return null;

  // Derive phase and message from the event name (e.g. "assess.started")
  const eventName = status.name || status.event || '';
  const phase = eventName.split('.')[0];

  // Translate phase name: t('thoughts.phase.assess') → "Bewertung"
  const translatedPhase = phase ? t(`thoughts.phase.${phase}`, { defaultValue: '' }) : '';

  // Translate status message: t('thoughts.assess.started') → "Analyse des aktuellen Wissens"
  const translatedMessage = eventName ? t(`thoughts.${eventName}`, { defaultValue: '' }) : '';

  // Use translated message, fall back to server message, then phase name
  const message = translatedMessage || status.message || translatedPhase;

  if (!message) return null;

  return (
    <div className="text-sm text-gray-500 dark:text-gray-400 py-1">
      <div className="flex items-center gap-2">
        <div className="flex space-x-1">
          <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
          <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
          <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" />
        </div>
        <span>{message}</span>
      </div>
    </div>
  );
}

export default SearchStatusIndicator;
