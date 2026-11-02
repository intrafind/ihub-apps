// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Switch from '../../../shared/components/Switch';
import { useTechnicalDetailsToggle } from '../hooks/useTechnicalDetailsToggle';

/**
 * Inline switch that flips the persistent "show technical details" preference.
 * When OFF (default), execution IDs, token counts, model badges, raw JSON,
 * and internal node-type stickers are hidden across the workflow UI.
 *
 * The visible text ("Show/Hide technical details") is a `<label>` of the
 * shared {@link Switch}, so it names the switch and a click on it toggles it.
 *
 * @param {Object} props
 * @param {string} [props.className] - Extra classes for the row.
 * @returns {JSX.Element}
 */
function TechnicalDetailsToggle({ className = '' }) {
  const { t } = useTranslation();
  const [showTechnical, setShowTechnical] = useTechnicalDetailsToggle();
  const switchId = `technical-details-${useId()}`;

  const tooltip = t(
    'workflows.technicalDetails.tooltip',
    'Show execution IDs, tokens, model info, and raw data'
  );
  const label = showTechnical
    ? t('workflows.technicalDetails.hide', 'Hide technical details')
    : t('workflows.technicalDetails.show', 'Show technical details');

  return (
    <div
      className={`inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 select-none ${className}`}
      title={tooltip}
    >
      <label htmlFor={switchId} className="flex items-center gap-1.5 cursor-pointer">
        <Icon name="cog" className="w-4 h-4" aria-hidden="true" />
        {label}
      </label>
      <Switch
        id={switchId}
        size="sm"
        checked={showTechnical}
        onChange={checked => setShowTechnical(checked)}
      />
    </div>
  );
}

export default TechnicalDetailsToggle;
