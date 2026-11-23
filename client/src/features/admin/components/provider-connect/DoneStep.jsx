// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../../api/adminApi';
import { translateModelTestMessage } from '../../utils/modelTestMessages';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, STEP_INTRO, STEP_TITLE } from './connectStyles';

/**
 * One-prompt smoke test of a created model, through the existing
 * `POST /admin/models/{id}/_test`, which sends a short prompt and returns the answer.
 */
function SmokeTest({ modelId }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ running: false, answer: null, error: null });

  const run = async () => {
    setState({ running: true, answer: null, error: null });
    try {
      const response = await makeAdminApiCall(
        `/admin/models/${encodeURIComponent(modelId)}/_test`,
        {
          method: 'POST'
        }
      );
      setState({ running: false, answer: response.data?.response || '', error: null });
    } catch (err) {
      const body = err?.response?.data || {};
      setState({
        running: false,
        answer: null,
        error: {
          message: translateModelTestMessage(
            t,
            body.details?.messageKey,
            body.detail || getAdminApiErrorMessage(err)
          ),
          remediation: body.details?.remediation
        }
      });
    }
  };

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t(
            'admin.providers.connect.done.smokeIntro',
            'Send one short prompt to {{model}} to check that it answers.',
            { model: modelId }
          )}
        </p>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={run}
          disabled={state.running}
          data-testid="connect-smoke-test"
        >
          <Icon
            name={state.running ? 'refresh' : 'play'}
            className={`mr-2 h-4 w-4 ${state.running ? 'animate-spin' : ''}`}
          />
          {state.running
            ? t('admin.providers.connect.done.smokeRunning', 'Sending…')
            : t('admin.providers.connect.done.smokeRun', 'Send a test prompt')}
        </button>
      </div>
      {state.answer !== null && (
        <div role="status" className="mt-3 text-sm text-green-800 dark:text-green-300">
          <p className="font-medium">
            {t('admin.providers.connect.done.smokeOk', 'The model answered:')}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-gray-800 dark:text-gray-200">
            {state.answer}
          </p>
        </div>
      )}
      {state.error && (
        <div role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          <p className="font-medium">{state.error.message}</p>
          {state.error.remediation && <p className="mt-1">{state.error.remediation}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Last step: what was created, a one-prompt smoke test, and where to go next
 * (the provider page, the models list, a new app).
 *
 * @param {Object} props
 * @param {string} props.providerId
 * @param {string} props.providerName
 * @param {{ providerError: string|null, models: Array<Object>, groups: Array<Object> }} props.outcome
 * @param {string|null} props.smokeModelId - Created chat model to test
 * @param {string|null} props.defaultId - New default model, if one was chosen
 */
function DoneStep({ providerId, providerName, outcome, smokeModelId, defaultId }) {
  const { t } = useTranslation();
  const created = outcome.models.filter(m => m.ok);
  const failed = outcome.models.filter(m => !m.ok);
  const failedGroups = outcome.groups.filter(g => !g.ok);
  const allOk = !outcome.providerError && failed.length === 0 && failedGroups.length === 0;

  if (outcome.providerError) {
    return (
      <div role="alert" className="space-y-2">
        <h2 className={STEP_TITLE}>
          {t('admin.providers.connect.done.providerFailedTitle', 'The provider was not saved')}
        </h2>
        <p className="text-sm text-red-700 dark:text-red-400">{outcome.providerError}</p>
        <p className={STEP_INTRO}>
          {t(
            'admin.providers.connect.done.providerFailedHint',
            'Nothing else was created. Go back, fix the connection and try again.'
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="connect-done">
      <div className="flex items-start gap-3">
        <Icon
          name={allOk ? 'check-circle' : 'exclamation-triangle'}
          className={`h-6 w-6 shrink-0 ${allOk ? 'text-green-500' : 'text-amber-500'}`}
        />
        <div>
          <h2 className={STEP_TITLE}>
            {t(
              'admin.providers.connect.done.title',
              '{{count}} models connected through {{provider}}',
              {
                count: created.length,
                provider: providerName
              }
            )}
          </h2>
          <ul className="mt-1 list-disc pl-5 text-sm text-gray-700 dark:text-gray-300">
            <li>
              {t(
                'admin.providers.connect.done.linked',
                'The models use the endpoint and key of the provider.'
              )}
            </li>
            {defaultId && created.some(m => m.id === defaultId) && (
              <li>
                {t('admin.providers.connect.done.default', '{{model}} is the default model.', {
                  model: defaultId
                })}
              </li>
            )}
            {outcome.groups.some(g => g.ok) && (
              <li>
                {t('admin.providers.connect.done.groups', 'Granted to: {{groups}}.', {
                  groups: outcome.groups
                    .filter(g => g.ok)
                    .map(g => g.groupId)
                    .join(', ')
                })}
              </li>
            )}
          </ul>
        </div>
      </div>

      {(failed.length > 0 || failedGroups.length > 0) && (
        <ul className="space-y-1 text-sm">
          {failed.map(m => (
            <li
              key={m.id}
              className="rounded-md bg-red-50 dark:bg-red-900/20 p-2 text-red-700 dark:text-red-300"
            >
              <span className="font-medium">{m.id}</span>: {m.error}
            </li>
          ))}
          {failedGroups.map(g => (
            <li
              key={g.groupId}
              className="rounded-md bg-red-50 dark:bg-red-900/20 p-2 text-red-700 dark:text-red-300"
            >
              {t('admin.providers.connect.done.groupFailed', 'Group {{group}}: {{error}}', {
                group: g.groupId,
                error: g.error
              })}
            </li>
          ))}
        </ul>
      )}

      {smokeModelId && <SmokeTest modelId={smokeModelId} />}

      <div className="flex flex-wrap items-center gap-3">
        <Link to="/admin/apps/new" className={PRIMARY_BUTTON}>
          {t('admin.providers.connect.done.createApp', 'Create an app with this model')}
        </Link>
        <Link
          to={`/admin/providers/${encodeURIComponent(providerId)}`}
          className={SECONDARY_BUTTON}
        >
          {t('admin.providers.connect.done.openProvider', 'Open the provider')}
        </Link>
        <Link to="/admin/models" className={SECONDARY_BUTTON}>
          {t('admin.providers.connect.done.openModels', 'Go to models')}
        </Link>
      </div>
    </div>
  );
}

export default DoneStep;
