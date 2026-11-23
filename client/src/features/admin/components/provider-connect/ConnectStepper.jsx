// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

/** Short label per step, for the progress list. */
function stepLabels(t) {
  return {
    vendor: t('admin.providers.connect.steps.vendor', 'Service'),
    connection: t('admin.providers.connect.steps.connection', 'Connection'),
    test: t('admin.providers.connect.steps.test', 'Test'),
    models: t('admin.providers.connect.steps.models', 'Models'),
    default: t('admin.providers.connect.steps.default', 'Default'),
    access: t('admin.providers.connect.steps.access', 'Access'),
    done: t('admin.providers.connect.steps.done', 'Done')
  };
}

/**
 * Where the admin is in the flow: the steps of the chosen tile, done ones
 * ticked, the current one marked with `aria-current="step"`.
 *
 * @param {Object} props
 * @param {string[]} props.steps
 * @param {string} props.current
 */
function ConnectStepper({ steps, current }) {
  const { t } = useTranslation();
  const labels = stepLabels(t);
  const currentIndex = steps.indexOf(current);

  return (
    <ol
      aria-label={t('admin.providers.connect.steps.label', 'Progress')}
      className="flex flex-wrap gap-x-4 gap-y-2"
    >
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <li
            key={step}
            aria-current={isCurrent ? 'step' : undefined}
            className="flex items-center gap-2 text-sm"
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                done
                  ? 'bg-green-600 text-white'
                  : isCurrent
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {done ? <Icon name="check" className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span
              className={
                isCurrent
                  ? 'font-medium text-gray-900 dark:text-gray-100'
                  : 'text-gray-600 dark:text-gray-400'
              }
            >
              {labels[step]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default ConnectStepper;
