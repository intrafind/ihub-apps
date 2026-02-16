import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

/**
 * AI Disclaimer Banner Component
 * Displays a short disclaimer below the chat input that links to full disclaimer
 */
const AIDisclaimerBanner = () => {
  const { t } = useTranslation();
  const { uiConfig } = useUIConfig();

  // Get the disclaimer link from ui config
  const disclaimerLink = uiConfig?.disclaimer?.link;

  const handleClick = () => {
    if (disclaimerLink) {
      window.open(disclaimerLink, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="flex items-center justify-center mt-1 mb-2">
      <button
        onClick={handleClick}
        className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
        title={t('disclaimer.title', 'Disclaimer')}
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
