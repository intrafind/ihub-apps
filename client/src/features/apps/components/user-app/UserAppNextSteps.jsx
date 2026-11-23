// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

const LINK_CLASS =
  'rounded-sm text-left text-sm font-medium text-admin-accent dark:text-admin-accent-fg-dark underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent';

/**
 * What to do with a new personal app, as a list of links: test it, add input
 * fields, share it. A link opens the part of the editor it names; the steps
 * do not tick themselves. The card of the admin editor is not used: its steps
 * name "Who can use this app" and "Publish", which a personal app does not
 * have in that form.
 *
 * @param {object} props
 * @param {() => void} props.onTest - "Test it with a real example".
 * @param {() => void} props.onInputFields - "Add input fields".
 * @param {() => void} [props.onShare] - "Share it"; left out for someone who may not share.
 * @param {() => void} props.onDismiss - "Hide these steps".
 * @param {boolean} [props.focusHeading=false] - Move the focus to the heading when the card
 *   appears (the author just arrived from creating the app).
 * @returns {JSX.Element}
 */
function UserAppNextSteps({ onTest, onInputFields, onShare, onDismiss, focusHeading = false }) {
  const { t } = useTranslation();
  const headingId = useId();
  const headingRef = useRef(null);

  useEffect(() => {
    if (focusHeading) headingRef.current?.focus();
  }, [focusHeading]);

  const steps = [
    { id: 'test', label: t('admin.apps.create.done.steps.test'), onSelect: onTest },
    {
      id: 'inputFields',
      label: t('admin.apps.create.done.steps.inputFields'),
      onSelect: onInputFields
    },
    onShare && { id: 'share', label: t('userApps.edit.steps.share'), onSelect: onShare }
  ].filter(Boolean);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="user-app-next-steps"
      className="mt-6 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4"
    >
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-start gap-2 rounded-sm text-base font-semibold text-gray-900 dark:text-gray-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent"
      >
        <Icon
          name="check-circle"
          className="mt-0.5 shrink-0 text-green-700 dark:text-green-400"
          aria-hidden="true"
        />
        <span>{t('admin.apps.create.done.heading')}</span>
      </h2>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
        {t('admin.apps.create.done.body')}
      </p>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-gray-700 dark:text-gray-300">
        {steps.map(step => (
          <li key={step.id}>
            <button type="button" className={`${LINK_CLASS} align-top`} onClick={step.onSelect}>
              {step.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end">
        <button type="button" className={LINK_CLASS} onClick={onDismiss}>
          {t('admin.apps.create.done.dismiss')}
        </button>
      </div>
    </section>
  );
}

export default UserAppNextSteps;
