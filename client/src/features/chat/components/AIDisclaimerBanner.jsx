import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * AI Disclaimer Banner Component
 * Displays a short disclaimer below the chat input that can be clicked to show full disclaimer
 */
const AIDisclaimerBanner = ({ onOpenDisclaimer }) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-center mt-1 mb-2">
      <button
        onClick={onOpenDisclaimer}
        className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
        title={t('disclaimer.aiDisclaimer.fullTitle', 'AI Disclaimer')}
      >
        <Icon name="informationCircle" size="sm" className="flex-shrink-0" />
        <span>
          {t(
            'disclaimer.aiDisclaimer.shortText',
            'iHub uses AI and can make mistakes. Please verify results carefully.'
          )}
        </span>
      </button>
    </div>
  );
};

export default AIDisclaimerBanner;
