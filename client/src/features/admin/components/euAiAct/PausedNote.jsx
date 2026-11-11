// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

/**
 * Top of a card on the EU AI Act page while the master switch is off: why the
 * card is read-only, and a link back to the switch. Normal text colours, never
 * `opacity` on text.
 */
export default function PausedNote({ children, className = '' }) {
  const { t } = useTranslation();
  return (
    <p
      data-testid="paused-note"
      className={`mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-700 dark:text-gray-300 ${className}`}
    >
      <Icon name="minus-circle" size="sm" className="shrink-0" />
      <span>
        {children ||
          t('admin.euAiAct.master.paused', 'Paused while EU AI Act features are switched off.')}
      </span>
      <a
        href="#conformity"
        className="font-medium underline text-indigo-700 dark:text-indigo-300 focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
      >
        {t('admin.euAiAct.master.pausedLink', 'Switch on again')}
      </a>
    </p>
  );
}
