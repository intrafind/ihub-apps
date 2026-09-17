import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useTechnicalDetailsToggle } from '../hooks/useTechnicalDetailsToggle';

/**
 * Inline switch that flips the persistent "show technical details" preference.
 * When OFF (default), execution IDs, token counts, model badges, raw JSON,
 * and internal node-type stickers are hidden across the workflow UI.
 */
function TechnicalDetailsToggle({ className = '' }) {
  const { t } = useTranslation();
  const [showTechnical, setShowTechnical] = useTechnicalDetailsToggle();

  const tooltip = t(
    'workflows.technicalDetails.tooltip',
    'Show execution IDs, tokens, model info, and raw data'
  );
  const label = showTechnical
    ? t('workflows.technicalDetails.hide', 'Hide technical details')
    : t('workflows.technicalDetails.show', 'Show technical details');

  return (
    <label
      className={`inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none ${className}`}
      title={tooltip}
    >
      <span className="flex items-center gap-1.5">
        <Icon name="cog" className="w-4 h-4" aria-hidden="true" />
        {label}
      </span>
      <span className="relative inline-flex">
        <input
          type="checkbox"
          checked={showTechnical}
          onChange={event => setShowTechnical(event.target.checked)}
          className="sr-only peer"
          aria-label={label}
        />
        <span
          aria-hidden="true"
          className="w-9 h-5 bg-gray-300 dark:bg-gray-600 rounded-full peer peer-checked:bg-indigo-600 transition-colors relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-4"
        />
      </span>
    </label>
  );
}

export default TechnicalDetailsToggle;
