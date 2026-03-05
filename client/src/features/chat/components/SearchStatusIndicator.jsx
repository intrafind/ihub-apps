import { useTranslation } from 'react-i18next';

/**
 * SearchStatusIndicator shows animated status messages during iAssistant search phases.
 * Displayed in the assistant message bubble while the conversation API processes a request.
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

  const queries = status.queries;

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
      {queries && queries.length > 0 && (
        <div className="ml-5 mt-1 flex flex-wrap gap-1.5">
          {queries.map((q, i) => (
            <span
              key={i}
              className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700/50"
            >
              {q}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchStatusIndicator;
