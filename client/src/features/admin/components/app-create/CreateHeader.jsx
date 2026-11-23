// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { SCREENS, STEP_KEYS } from './createKeys';
import { LINK_BUTTON_CLASS } from './createStyles';

/**
 * The head of either screen of "New app": "Back" on the second screen, the
 * screen's one `h1`, which takes the focus when the screen changes, and the
 * step line ("Step 1 of 2: Start").
 *
 * @param {object} props
 * @param {string} props.heading - The heading of the screen.
 * @param {'start'|'essentials'} props.screen
 * @param {{ current: HTMLElement|null }} [props.headingRef]
 * @param {() => void} [props.onBack] - Shows "Back" when given.
 * @returns {JSX.Element}
 */
function CreateHeader({ heading, screen, headingRef, onBack }) {
  const { t } = useTranslation();
  return (
    <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      {onBack && (
        <div className="w-full">
          <button
            type="button"
            className={`${LINK_BUTTON_CLASS} inline-flex items-center gap-1`}
            onClick={onBack}
          >
            <Icon name="arrow-left" size="sm" aria-hidden="true" />
            {t('admin.apps.create.back')}
          </button>
        </div>
      )}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-semibold text-gray-900 dark:text-gray-100 focus:outline-hidden"
      >
        {heading}
      </h1>
      <nav aria-label={t('admin.apps.create.title')}>
        <span aria-current="step" className="text-sm text-gray-600 dark:text-gray-400">
          {t('admin.apps.create.stepOf', {
            current: SCREENS.indexOf(screen) + 1,
            total: SCREENS.length,
            name: t(STEP_KEYS[screen])
          })}
        </span>
      </nav>
    </div>
  );
}

export default CreateHeader;
