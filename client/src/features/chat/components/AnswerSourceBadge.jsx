import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Component to display the source of an AI answer (LLM, websearch, sources, etc.)
 * Shows a non-intrusive badge indicating where the information came from
 */
function AnswerSourceBadge({ answerSource }) {
  const { t } = useTranslation();

  if (!answerSource || !answerSource.sources) {
    // No external sources used - show LLM-only badge
    return (
      <div
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400 border border-gray-200 dark:border-gray-700"
        title={t('chatMessage.answerSource.llmOnly')}
      >
        <Icon name="sparkles" className="w-3 h-3" />
        <span>{t('chatMessage.answerSource.llmOnly')}</span>
      </div>
    );
  }

  const { sources } = answerSource;

  // Determine the primary source to display
  let displayText = t('chatMessage.answerSource.mixed');
  let iconName = 'document-text';
  let colorClasses =
    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800';

  if (sources.length === 1) {
    const source = sources[0];
    switch (source) {
      case 'websearch':
        displayText = t('chatMessage.answerSource.websearch');
        iconName = 'globe-alt';
        colorClasses =
          'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800';
        break;
      case 'sources':
        displayText = t('chatMessage.answerSource.sources');
        iconName = 'document-text';
        colorClasses =
          'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border-purple-200 dark:border-purple-800';
        break;
      case 'iassistant':
        displayText = t('chatMessage.answerSource.iassistant');
        iconName = 'book-open';
        colorClasses =
          'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800';
        break;
      case 'grounding':
        displayText = t('chatMessage.answerSource.grounding');
        iconName = 'search';
        colorClasses =
          'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300 border-teal-200 dark:border-teal-800';
        break;
      default:
        // Keep default mixed styling
        break;
    }
  } else if (sources.length > 1) {
    // Multiple sources - show mixed with tooltip listing all sources
    displayText = t('chatMessage.answerSource.mixed');
  }

  // Create tooltip text listing all sources
  const tooltipText =
    sources.length > 1
      ? `${t('chatMessage.answerSource.tooltip')}\n${sources.map(s => `• ${t(`chatMessage.answerSource.${s}`, s)}`).join('\n')}`
      : displayText;

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs border ${colorClasses}`}
      title={tooltipText}
    >
      <Icon name={iconName} className="w-3 h-3" />
      <span>{displayText}</span>
    </div>
  );
}

export default AnswerSourceBadge;
