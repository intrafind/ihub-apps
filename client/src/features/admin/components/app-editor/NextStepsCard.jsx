// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { NEXT_STEPS } from './nextSteps';

const LINK_CLASS =
  'rounded-sm text-left text-sm font-medium text-admin-accent dark:text-admin-accent-fg-dark underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

/**
 * What to do with a new app, as a list of links: test it, add input fields
 * and conversation starters, check who can use it, publish it. A link opens
 * the part of the editor it names; the steps do not tick themselves.
 *
 * The card knows no path and no group: it reports the step, and the page
 * decides what the step opens.
 *
 * @param {object} props
 * @param {(step: {id: string, group?: string}) => void} props.onStep - The author chose a step.
 * @param {() => void} props.onDismiss - "Hide these steps".
 * @param {boolean} [props.published=false] - The app is published; "Publish" is then left out.
 * @param {boolean} [props.focusHeading=false] - Move the focus to the heading when the card
 *   appears (the author just arrived from creating the app).
 * @param {string|null} [props.guideHref] - The guide "Build your first app", for someone who
 *   may open it; opens in a new tab so that the editor stays as it is.
 * @returns {JSX.Element}
 */
function NextStepsCard({
  onStep,
  onDismiss,
  published = false,
  focusHeading = false,
  guideHref = null
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const headingRef = useRef(null);

  useEffect(() => {
    if (focusHeading) headingRef.current?.focus();
  }, [focusHeading]);

  const steps = NEXT_STEPS.filter(step => !(published && step.id === 'publish'));

  return (
    <section
      aria-labelledby={headingId}
      className="mt-6 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4"
    >
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-start gap-2 text-base font-semibold text-gray-900 dark:text-gray-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark rounded-sm"
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
            <button type="button" className={LINK_CLASS} onClick={() => onStep(step)}>
              {t(step.labelKey)}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {guideHref ? (
          <a href={guideHref} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            {t('admin.apps.create.done.guide')}
          </a>
        ) : (
          <span />
        )}
        <button type="button" className={LINK_CLASS} onClick={onDismiss}>
          {t('admin.apps.create.done.dismiss')}
        </button>
      </div>
    </section>
  );
}

export default NextStepsCard;
