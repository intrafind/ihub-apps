// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { scopeActionLabel, scopeDisplayName, scopeHint } from '../../chat/utils/integrationScopes';

/**
 * Where a scheduled task's integrations search and whom they ask (#3057): one
 * picker per integration of the task's app, from the same list as the chat
 * (`useIntegrationScopes`). The task keeps the pick for every run, however
 * the chat it came from changes later.
 *
 * A saved scope the list no longer offers is named, since the task's runs
 * fail until another one is saved; the picker shows the integration's default
 * in its place. Renders nothing for an app whose integrations offer no picker.
 *
 * @param {Object} props
 * @param {Array<Object>} props.integrations - `useIntegrationScopes().integrations`
 * @param {Object<string, string>} [props.saved] - The task's stored scopes
 * @param {(integrationId: string, scopeId: string) => void} props.onChange
 * @param {string} [props.error] - The server's message for `integrationScopes`
 * @param {string} [props.className] - Section styling of the form
 * @param {string} [props.labelClassName]
 * @param {string} [props.inputClassName]
 */
export default function TaskScopesSection({
  integrations,
  saved = {},
  onChange,
  error,
  className = '',
  labelClassName = '',
  inputClassName = ''
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const shown = (integrations || []).filter(integration => integration.scopePicker !== 'hidden');
  if (shown.length === 0) return null;

  return (
    <section className={className}>
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t('scheduledTasks.fields.scopes', 'Where to search')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'scheduledTasks.fields.scopesHelp',
            'Every run searches here, even when the chat the task came from moves elsewhere later.'
          )}
        </p>
      </div>
      {shown.map(integration => {
        const id = `task-scope-${integration.id}`;
        const stored = saved?.[integration.id];
        const lost =
          typeof stored === 'string' && !integration.scopes?.some(scope => scope.id === stored);
        const hint = scopeHint(integration, t);
        return (
          <div key={integration.id}>
            <label htmlFor={id} className={labelClassName}>
              {scopeDisplayName(integration, language)}: {scopeActionLabel(integration, t)}
            </label>
            <select
              id={id}
              className={inputClassName}
              value={integration.current || ''}
              disabled={integration.fixed}
              onChange={event => onChange(integration.id, event.target.value)}
            >
              {(integration.scopes || []).map(scope => (
                <option key={scope.id} value={scope.id}>
                  {scopeDisplayName(scope, language)}
                </option>
              ))}
            </select>
            {integration.fixed && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('scheduledTasks.scopeFixed', 'Set by the app; it cannot be changed.')}
              </p>
            )}
            {lost && (
              <p role="alert" className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {t(
                  'scheduledTasks.scopeUnavailable',
                  '“{{scope}}” is no longer available to you, so runs fail. Saving uses the one picked here.',
                  { scope: stored }
                )}
              </p>
            )}
            {hint && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
          </div>
        );
      })}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
