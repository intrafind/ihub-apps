import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * AI Disclaimer Banner Component
 * Displays a short disclaimer below the chat input that links to full disclaimer
 */
const AIDisclaimerBanner = () => {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const currentLanguage = i18n.language;

  // Get the disclaimer link and hint from ui config
  const disclaimerLink = uiConfig?.disclaimer?.link;
  const disclaimerHint = getLocalizedContent(uiConfig?.disclaimer?.hint, currentLanguage);

  const handleClick = () => {
    if (disclaimerLink) {
      window.open(disclaimerLink, '_blank', 'noopener,noreferrer');
    }
  };

  // Determine if the element should be clickable
  const isClickable = !!disclaimerLink;
  const ElementTag = isClickable ? 'button' : 'div';

  // Dynamic classes based on whether element is clickable
  const baseClasses =
    'flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400';
  const clickableClasses = isClickable
    ? 'hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer'
    : 'cursor-default';

  return (
    <div className="flex items-center justify-center mt-1 mb-2">
      <ElementTag
        onClick={isClickable ? handleClick : undefined}
        className={`${baseClasses} ${clickableClasses} rounded-lg transition-colors`}
        title={t('disclaimer.title', 'Disclaimer')}
      >
        <Icon name="informationCircle" size="sm" className="flex-shrink-0" />
        <span>
          {disclaimerHint ||
            t(
              'disclaimer.defaultMessage',
              'iHub uses AI and can make mistakes. Please verify results carefully.'
            )}
        </span>
      </ElementTag>
    </div>
  );
};

export default AIDisclaimerBanner;
