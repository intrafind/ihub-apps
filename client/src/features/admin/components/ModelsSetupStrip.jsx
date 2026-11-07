// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getSetupSteps } from '../utils/modelsArea';

/**
 * The route from a fresh install to a usable model, as three steps with the one
 * action that completes the first open step. Shown until every step is done.
 * The state is read from what is configured; nothing is stored.
 *
 * @param {Object} props
 * @param {Object} props.keyStatuses - Provider key statuses by provider id
 * @param {Array<Object>} props.models
 * @param {() => void} [props.onConnect] - Open the Providers tab; absent when the admin may not open it,
 *   in which case the import dialog is offered instead (it creates a provider and stores its key)
 * @param {() => void} props.onImport - Open the import dialog
 * @param {() => void} props.onShowEnabled - Filter the list to what can be enabled
 */
function ModelsSetupStrip({ keyStatuses, models, onConnect, onImport, onShowEnabled }) {
  const { t } = useTranslation();
  const { steps, complete } = getSetupSteps({ keyStatuses, models });
  if (complete) return null;

  const labels = {
    connect: t('admin.models.setup.connect', 'Connect a provider'),
    enable: t('admin.models.setup.enable', 'Enable models'),
    default: t('admin.models.setup.default', 'Choose a default model')
  };
  const next = steps.find(step => !step.done);
  const cta = {
    connect: onConnect
      ? { label: t('admin.models.setup.connectAction', 'Add a provider key'), onClick: onConnect }
      : { label: t('admin.models.setup.enableAction', 'Import models'), onClick: onImport },
    enable: {
      label: t('admin.models.setup.enableAction', 'Import models'),
      onClick: onImport
    },
    default: {
      label: t('admin.models.setup.defaultAction', 'Show enabled models'),
      onClick: onShowEnabled
    }
  }[next.id];
  const hints = {
    connect: t(
      'admin.models.setup.connectHint',
      'Models need a provider with an API key (or an endpoint that needs none).'
    ),
    enable: t(
      'admin.models.setup.enableHint',
      'Import the models of a provider, or switch on one below.'
    ),
    default: t(
      'admin.models.setup.defaultHint',
      'Open a model and tick “Default” so apps without a model of their own have one.'
    )
  };

  return (
    <section
      aria-labelledby="models-setup-title"
      data-testid="models-setup"
      className="mb-6 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 p-4"
    >
      <h2
        id="models-setup-title"
        className="text-sm font-semibold text-gray-900 dark:text-gray-100"
      >
        {t('admin.models.setup.title', 'Set up your models')}
      </h2>
      <ol className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-6">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.id === next.id ? 'step' : undefined}
            className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200"
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                step.done
                  ? 'bg-green-600 text-white'
                  : step.id === next.id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {step.done ? <Icon name="check" className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className={step.done ? 'text-gray-600 dark:text-gray-400' : 'font-medium'}>
              {labels[step.id]}
            </span>
            <span className="text-xs text-gray-600 dark:text-gray-400">
              {step.done
                ? t('admin.models.setup.done', '(done)')
                : t('admin.models.setup.todo', '(to do)')}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={cta.onClick}
          className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          {cta.label}
        </button>
        <p className="text-xs text-gray-700 dark:text-gray-300">{hints[next.id]}</p>
      </div>
    </section>
  );
}

export default ModelsSetupStrip;
