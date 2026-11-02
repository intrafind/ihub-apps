// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import { buildPath } from '../../../../utils/runtimeBasePath';
import { createExampleApp, fetchExampleApps } from '../../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import { PanelMessage, TestChat } from '../AppTestPanel';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  RADIO_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';

/** App ids as the server accepts them (`shared/validationPatterns.js`). */
const APP_ID_PATTERN = /^[a-z0-9._-]{1,50}$/;

const ICON_BUTTON =
  'p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';

/**
 * The chat apps among the apps that use the installation, enabled ones first.
 *
 * @param {Array<{ id: string, name: string }>} boundApps - `appsBindingInstallation`
 * @param {Object[]} apps - every app config
 * @returns {Array<{ id: string, name: string, enabled: boolean }>}
 */
export function testableApps(boundApps, apps) {
  const byId = new Map((apps || []).map(app => [app.id, app]));
  return (boundApps || [])
    .map(bound => ({ ...bound, config: byId.get(bound.id) }))
    .filter(bound => (bound.config?.type || 'chat') === 'chat')
    .map(bound => ({ id: bound.id, name: bound.name, enabled: bound.config?.enabled !== false }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

/**
 * The form that creates the example app: which template (when the definition
 * ships several), the app id and whether users see the app right away.
 */
function ExampleAppForm({ instanceId, info, onCreated, onCancel }) {
  const { t } = useTranslation();
  const formId = useId();
  const templates = info.templates || [];
  const [templateKey, setTemplateKey] = useState(templates[0]?.key || '');
  const template = templates.find(entry => entry.key === templateKey) || templates[0];
  const [appId, setAppId] = useState(template?.suggestedId || '');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const chooseTemplate = key => {
    setTemplateKey(key);
    setAppId(templates.find(entry => entry.key === key)?.suggestedId || '');
  };

  const idValid = APP_ID_PATTERN.test(appId);

  const submit = async event => {
    event.preventDefault();
    if (!idValid || !template) return;
    setBusy(true);
    setError(null);
    try {
      const app = await createExampleApp(instanceId, { template: template.key, appId, enabled });
      onCreated(app);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setBusy(false);
    }
  };

  const sourceLabel = entry =>
    entry.source === 'generated'
      ? t('admin.integrations.testChat.generated', 'Generated from the integration')
      : t('admin.integrations.testChat.shipped', 'Ships with the integration');

  return (
    <form
      onSubmit={submit}
      className="flex-1 overflow-y-auto p-4 space-y-4"
      data-testid="example-app-form"
      aria-labelledby={`${formId}-title`}
    >
      <div>
        <h3
          id={`${formId}-title`}
          className="text-sm font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.integrations.testChat.createTitle', 'Create an example app')}
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.integrations.testChat.createIntro',
            'The chat runs an app that uses this installation. Create one from the example: it is bound to this installation and you can change it in the app editor afterwards.'
          )}
        </p>
      </div>

      {templates.length > 1 ? (
        <fieldset>
          <legend className={LABEL_CLASS}>
            {t('admin.integrations.testChat.template', 'Example app')}
          </legend>
          <div className="space-y-2">
            {templates.map(entry => (
              <label
                key={entry.key}
                className="flex items-start gap-2 rounded-md border border-gray-200 dark:border-gray-700 p-3 cursor-pointer"
              >
                <input
                  type="radio"
                  name={`${formId}-template`}
                  className={`${RADIO_CLASS} mt-0.5`}
                  checked={entry.key === template?.key}
                  onChange={() => chooseTemplate(entry.key)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    {entry.name}
                  </span>
                  {entry.description && (
                    <span className="block text-sm text-gray-600 dark:text-gray-400">
                      {entry.description}
                    </span>
                  )}
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {sourceLabel(entry)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        template && (
          <div
            className="flex items-start gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-3"
            data-testid="example-app-template"
          >
            <div
              className="shrink-0 p-2 rounded-md text-white"
              style={{ backgroundColor: template.color || '#4F46E5' }}
              aria-hidden="true"
            >
              <Icon name={template.icon || 'link'} className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {template.name}
              </p>
              {template.description && (
                <p className="text-sm text-gray-600 dark:text-gray-400">{template.description}</p>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400">{sourceLabel(template)}</p>
            </div>
          </div>
        )
      )}

      <div>
        <label htmlFor={`${formId}-id`} className={LABEL_CLASS}>
          {t('admin.integrations.testChat.appId', 'App id')}
        </label>
        <input
          id={`${formId}-id`}
          type="text"
          className={`${INPUT_CLASS} font-mono`}
          value={appId}
          onChange={event => setAppId(event.target.value.trim())}
          aria-invalid={!idValid}
          aria-describedby={`${formId}-id-help`}
          required
        />
        <p id={`${formId}-id-help`} className={HELP_CLASS}>
          {t(
            'admin.integrations.testChat.appIdHelp',
            'Lowercase letters, digits, dots, underscores and hyphens; at most 50 characters.'
          )}
        </p>
      </div>

      <div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className={`${CHECKBOX_CLASS} mt-0.5`}
            checked={enabled}
            onChange={event => setEnabled(event.target.checked)}
            aria-describedby={`${formId}-enabled-help`}
          />
          <span className="text-sm text-gray-900 dark:text-gray-100">
            {t('admin.integrations.testChat.enabled', 'Available to users now')}
          </span>
        </label>
        <p id={`${formId}-enabled-help`} className={`${HELP_CLASS} ml-6`}>
          {enabled
            ? t(
                'admin.integrations.testChat.enabledHelp',
                'Users whose groups may use all apps see it right away. Disable it in the app editor when you are done testing.'
              )
            : t(
                'admin.integrations.testChat.disabledHelp',
                'The app is created disabled, so nobody sees it — and the chat cannot run it either until you enable it in the app editor.'
              )}
        </p>
      </div>

      {error && (
        <div role="alert" className={CALLOUT_CLASS.danger}>
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={PRIMARY_BUTTON_CLASS}
          disabled={busy || !idValid || !template}
        >
          <Icon name="beaker" size="sm" />
          {enabled
            ? t('admin.integrations.testChat.createAndTest', 'Create and test')
            : t('admin.integrations.testChat.create', 'Create app')}
        </button>
        {onCancel && (
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Test mode of an installation (issue #3128): the real chat of an app that
 * uses the installation, beside the installation page — the panel of the
 * app editor's test mode (#2510) with an app picker and, when no app uses the
 * installation yet, the example app the definition ships (or one generated
 * from it), created with one click.
 *
 * It runs the saved configuration of both: the installation page restarts
 * the chat after every save through `reloadKey`.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation (`id`, `label`, `enabled`)
 * @param {Array<{ id: string, name: string }>} props.boundApps - apps that use it
 * @param {Object[]} props.apps - every app config
 * @param {number} props.reloadKey - changes whenever the installation was saved
 * @param {(app: Object) => Promise<void>|void} props.onAppCreated - reload the apps
 * @param {Function} props.onClose
 */
function IntegrationTestPanel({ instance, boundApps, apps, reloadKey, onAppCreated, onClose }) {
  const { t } = useTranslation();
  const selectId = useId();
  const [info, setInfo] = useState(null);
  const [infoError, setInfoError] = useState(null);
  const [created, setCreated] = useState([]);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [restarts, setRestarts] = useState(0);
  // Bumped after a create, so the next suggested id is a free one.
  const [infoVersion, setInfoVersion] = useState(0);
  const title = t('admin.integrations.testChat.title', 'Test in chat');

  useEffect(() => {
    let cancelled = false;
    fetchExampleApps(instance.id).then(
      result => !cancelled && setInfo(result),
      err => !cancelled && setInfoError(getAdminApiErrorMessage(err))
    );
    return () => {
      cancelled = true;
    };
  }, [instance.id, reloadKey, infoVersion]);

  // The apps that use the installation, plus the ones created here before the
  // page reloaded its app list.
  const candidates = useMemo(() => {
    const list = testableApps(boundApps, apps);
    for (const app of created) {
      if (!list.some(entry => entry.id === app.id)) {
        list.push({ id: app.id, name: app.id, enabled: app.enabled !== false });
      }
    }
    return list;
  }, [boundApps, apps, created]);

  const current = candidates.find(entry => entry.id === selected) || candidates[0] || null;
  const showForm = creating || (!current && info);

  const onCreated = async app => {
    setCreated(list => [...list, app]);
    setSelected(app.id);
    setCreating(false);
    setInfoVersion(n => n + 1);
    await onAppCreated?.(app);
  };

  return (
    <aside
      aria-label={title}
      data-testid="integration-test-panel"
      className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 lg:static lg:z-auto lg:h-full lg:w-[45%] lg:min-w-[26rem] lg:max-w-3xl lg:shrink-0 lg:border-l lg:border-gray-200 lg:dark:border-gray-700"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <Icon name="beaker" className="h-5 w-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {title}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {t(
              'admin.integrations.testChat.subtitle',
              'Runs a saved app that uses this installation, as users see it'
            )}
          </p>
        </div>
        {current?.enabled && !showForm && (
          <>
            <button
              type="button"
              onClick={() => setRestarts(n => n + 1)}
              className={ICON_BUTTON}
              title={t('admin.apps.test.restart', 'Restart with a new chat')}
              aria-label={t('admin.apps.test.restart', 'Restart with a new chat')}
            >
              <Icon name="refresh" className="h-4 w-4" />
            </button>
            <a
              href={buildPath(`/apps/${encodeURIComponent(current.id)}`)}
              target="_blank"
              rel="noopener noreferrer"
              className={ICON_BUTTON}
              title={t('admin.apps.openAppHint', 'Open the app in a new tab')}
              aria-label={t('admin.apps.openApp', 'Open app')}
            >
              <Icon name="external-link" className="h-4 w-4" />
            </a>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          className={ICON_BUTTON}
          title={t('admin.integrations.testChat.close', 'Close test panel')}
          aria-label={t('admin.integrations.testChat.close', 'Close test panel')}
        >
          <Icon name="x-mark" className="h-4 w-4" />
        </button>
      </div>

      {current && !showForm && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <label htmlFor={selectId} className="text-sm text-gray-700 dark:text-gray-300">
            {t('admin.integrations.testChat.app', 'App')}
          </label>
          <select
            id={selectId}
            className={`${INPUT_CLASS} w-auto min-w-0 flex-1 py-1`}
            value={current.id}
            onChange={event => setSelected(event.target.value)}
            data-testid="test-app-select"
          >
            {candidates.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.enabled
                  ? entry.name
                  : t('admin.integrations.testChat.disabledOption', '{{name}} (disabled)', {
                      name: entry.name
                    })}
              </option>
            ))}
          </select>
          <Link
            to={`/admin/apps/${encodeURIComponent(current.id)}`}
            className="text-sm text-indigo-700 dark:text-indigo-300 hover:underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('admin.integrations.testChat.editApp', 'Edit app')}
          </Link>
          {info && (
            <button
              type="button"
              className="text-sm text-indigo-700 dark:text-indigo-300 hover:underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
              onClick={() => setCreating(true)}
            >
              {t('admin.integrations.testChat.newExample', 'New example app')}
            </button>
          )}
        </div>
      )}

      {(instance.enabled === false || info?.grantedToYou === false) && (
        <div className="px-4 py-2 space-y-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
          {instance.enabled === false && (
            <div role="status" className={`${CALLOUT_CLASS.warning} py-2 text-xs`}>
              {t(
                'admin.integrations.testChat.installationDisabled',
                'This installation is disabled: an app that requires it is hidden, others run without its actions. Enable it to test.'
              )}
            </div>
          )}
          {info?.grantedToYou === false && (
            <div role="status" className={`${CALLOUT_CLASS.warning} py-2 text-xs`}>
              {t(
                'admin.integrations.testChat.notGranted',
                'Your groups do not grant this installation, so the chat runs without its actions. Grant it under Admin → Groups.'
              )}{' '}
              <Link to="/admin/groups" className="underline">
                {t('admin.integrations.testChat.openGroups', 'Open groups')}
              </Link>
            </div>
          )}
        </div>
      )}

      {infoError && !current ? (
        <PanelMessage icon="exclamation-triangle">{infoError}</PanelMessage>
      ) : showForm ? (
        <ExampleAppForm
          key={`${reloadKey}-${infoVersion}`}
          instanceId={instance.id}
          info={info}
          onCreated={onCreated}
          onCancel={current ? () => setCreating(false) : null}
        />
      ) : !current ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        </div>
      ) : current.enabled ? (
        <TestChat key={`${current.id}-${reloadKey}-${restarts}`} appId={current.id} />
      ) : (
        <PanelMessage icon="eye-slash">
          {t(
            'admin.integrations.testChat.appDisabled',
            'This app is disabled, so it cannot be opened in the chat. Enable it in the app editor to test it.'
          )}
        </PanelMessage>
      )}
    </aside>
  );
}

export default IntegrationTestPanel;
