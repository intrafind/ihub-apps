import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * ModelHintBanner component displays important hints for selected models
 * Supports four severity levels: hint, info, warning, alert
 * Alert level requires explicit acknowledgment before use
 */
const ModelHintBanner = ({ hint, currentLanguage, onAcknowledge }) => {
  const { t } = useTranslation();
  const [isDismissed, setIsDismissed] = useState(false);
  const [isAcknowledged, setIsAcknowledged] = useState(false);

  if (!hint || isDismissed || (hint.level === 'alert' && isAcknowledged)) {
    return null;
  }

  const message = getLocalizedContent(hint.message, currentLanguage);
  const level = hint.level || 'hint';
  const dismissible = hint.dismissible !== false && (level === 'hint' || level === 'info');

  // Define styling based on level
  const levelConfig = {
    hint: {
      bgColor: 'bg-blue-50 dark:bg-blue-900/20',
      borderColor: 'border-blue-200 dark:border-blue-800',
      textColor: 'text-blue-800 dark:text-blue-300',
      iconColor: 'text-blue-600 dark:text-blue-400',
      iconName: 'informationCircle'
    },
    info: {
      bgColor: 'bg-cyan-50 dark:bg-cyan-900/20',
      borderColor: 'border-cyan-200 dark:border-cyan-800',
      textColor: 'text-cyan-800 dark:text-cyan-300',
      iconColor: 'text-cyan-600 dark:text-cyan-400',
      iconName: 'informationCircle'
    },
    warning: {
      bgColor: 'bg-yellow-50 dark:bg-yellow-900/20',
      borderColor: 'border-yellow-200 dark:border-yellow-800',
      textColor: 'text-yellow-800 dark:text-yellow-300',
      iconColor: 'text-yellow-600 dark:text-yellow-400',
      iconName: 'exclamationTriangle'
    },
    alert: {
      bgColor: 'bg-red-50 dark:bg-red-900/20',
      borderColor: 'border-red-200 dark:border-red-800',
      textColor: 'text-red-800 dark:text-red-300',
      iconColor: 'text-red-600 dark:text-red-400',
      iconName: 'exclamationTriangle'
    }
  };

  const config = levelConfig[level] || levelConfig.hint;

  const handleDismiss = () => {
    setIsDismissed(true);
  };

  const handleAcknowledge = () => {
    setIsAcknowledged(true);
    if (onAcknowledge) {
      onAcknowledge();
    }
  };

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg border ${config.bgColor} ${config.borderColor} ${config.textColor} text-sm`}
      role="alert"
    >
      <Icon
        name={config.iconName}
        size="md"
        className={`flex-shrink-0 mt-0.5 ${config.iconColor}`}
      />

      <div className="flex-1 min-w-0">
        {level === 'alert' && (
          <div className="font-semibold mb-1">
            {t('pages.appChat.modelSelector.hint.alertTitle', 'Important Notice')}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{message}</div>
      </div>

      {dismissible && (
        <button
          type="button"
          onClick={handleDismiss}
          className={`flex-shrink-0 p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors ${config.iconColor}`}
          title={t('pages.appChat.modelSelector.hint.dismiss', 'Dismiss')}
        >
          <Icon name="xMark" size="sm" />
        </button>
      )}

      {level === 'alert' && (
        <button
          type="button"
          onClick={handleAcknowledge}
          className="flex-shrink-0 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded transition-colors"
        >
          {t('pages.appChat.modelSelector.hint.acknowledge', 'I Understand')}
        </button>
      )}
    </div>
  );
};

export default ModelHintBanner;
