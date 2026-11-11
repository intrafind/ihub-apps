// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { usePlatformConfig } from '../../../../shared/contexts/platformConfigContextValue';

/** Whether the EU AI Act features are on, from the public platform config (on while unknown). */
export function useEuAiActEnabled() {
  const context = usePlatformConfig();
  return context?.platformConfig?.euAiAct?.enabled !== false;
}

/**
 * The one note that tells an admin where a setting stands with the EU AI Act
 * master switch, on the settings surfaces outside the EU AI Act page (Advanced
 * cards, model and app editors, users page). One component keeps wording and
 * styling from drifting. Fields stay editable: preparing text is harmless.
 *
 * @param {Object} props
 * @param {string} [props.offText] - Replaces the default "saved but no effect" sentence
 * @param {boolean} [props.hideWhenOn] - Show only while the features are off
 */
export default function EuAiActStateNote({ offText, hideWhenOn = false, className = '' }) {
  const { t } = useTranslation();
  const enabled = useEuAiActEnabled();
  if (enabled && hideWhenOn) return null;
  const tone = enabled
    ? 'bg-gray-50 border-gray-200 text-gray-700 dark:bg-gray-900/40 dark:border-gray-700 dark:text-gray-300'
    : 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-100';
  return (
    <div
      data-testid="eu-ai-act-state-note"
      data-state={enabled ? 'on' : 'off'}
      className={`rounded-lg border px-4 py-3 text-sm flex gap-3 ${tone} ${className}`}
    >
      <Icon
        name={enabled ? 'information-circle' : 'exclamation-triangle'}
        size="md"
        className="shrink-0 mt-0.5"
      />
      <p>
        {enabled
          ? t(
              'admin.euAiAct.master.advOn',
              'EU AI Act features are on. Switch them on or off on the EU AI Act page.'
            )
          : offText ||
            t(
              'admin.euAiAct.master.advOff',
              'EU AI Act features are switched off. These settings are saved but have no effect.'
            )}{' '}
        <Link
          to="/admin/eu-ai-act#conformity"
          className="font-medium underline text-indigo-700 dark:text-indigo-300 focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
        >
          {t('admin.euAiAct.master.advLink', 'Manage on the EU AI Act page')}
        </Link>
      </p>
    </div>
  );
}
