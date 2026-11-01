// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  fetchInstalledIntegrations,
  fetchInstalledIntegration
} from '../../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../people-directories/formStyles';

/**
 * App editor section: which installed integrations the app binds, which of
 * their actions, and the default scope. Writes `app.integrations[instanceId]`
 * (the object that also carries the scope picker settings of #3050).
 *
 * @param {Object} props
 * @param {Object} props.integrations - `app.integrations`
 * @param {(next: Object) => void} props.onChange
 */
function IntegrationsConfigSection({ integrations, onChange }) {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState([]);
  const [details, setDetails] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const bindings = useMemo(
    () => (integrations && typeof integrations === 'object' ? integrations : {}),
    [integrations]
  );

  // Bindings to installations that are gone: the app is hidden from users
  // until they are unbound, so they are listed with a way to do that.
  const staleIds = useMemo(() => {
    if (loading || error) return [];
    const installedIds = new Set(installed.map(i => i.id));
    return Object.keys(bindings).filter(id => !installedIds.has(id));
  }, [bindings, installed, loading, error]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchInstalledIntegrations();
        if (!cancelled) setInstalled((res.items || []).filter(i => !i.definitionMissing));
      } catch (err) {
        if (!cancelled) setError(getAdminApiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the actions of every bound installation once it is bound.
  useEffect(() => {
    const boundIds = Object.keys(bindings).filter(id => !details[id]);
    if (boundIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      const loaded = {};
      await Promise.all(
        boundIds.map(async id => {
          try {
            loaded[id] = await fetchInstalledIntegration(id);
          } catch {
            loaded[id] = { actions: [], definition: null };
          }
        })
      );
      if (!cancelled) setDetails(prev => ({ ...prev, ...loaded }));
    })();
    return () => {
      cancelled = true;
    };
  }, [bindings, details]);

  const setBinding = (id, binding) => {
    const next = { ...bindings };
    if (binding === null) delete next[id];
    else next[id] = binding;
    onChange(Object.keys(next).length ? next : undefined);
  };

  const toggleInstance = (item, checked) => {
    if (checked) {
      const existing = bindings[item.id] || {};
      setBinding(item.id, { ...existing });
    } else {
      setBinding(item.id, null);
    }
  };

  // `actions` absent means every action; a list, even an empty one, means
  // exactly those (an empty list binds the installation for its scopes only).
  const toggleAction = (id, actionName, checked, allNames) => {
    const binding = bindings[id] || {};
    const current = Array.isArray(binding.actions) ? binding.actions : allNames;
    const next = checked
      ? [...new Set([...current, actionName])]
      : current.filter(n => n !== actionName);
    const sameAsAll = next.length === allNames.length && allNames.every(n => next.includes(n));
    const { actions: _drop, ...rest } = binding;
    setBinding(id, sameAsAll ? rest : { ...rest, actions: next });
  };

  const setScope = (id, patch) => {
    const binding = { ...(bindings[id] || {}), ...patch };
    for (const key of Object.keys(patch)) {
      if (patch[key] === '' || patch[key] === undefined) delete binding[key];
    }
    setBinding(id, binding);
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.integrations.title', 'Installed integrations')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.integrations.desc',
              'Bind integrations installed under Integrations → Installed. Narrow them to some actions, and set the scope users start with.'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-3">
          {loading && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('common.loading', 'Loading…')}
            </p>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {!loading && !error && installed.length === 0 && staleIds.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('admin.apps.edit.integrations.none', 'No integration is installed yet.')}{' '}
              <Link
                to="/admin/integrations/installed?tab=catalog"
                className="text-blue-700 dark:text-blue-300 hover:underline"
              >
                {t('admin.apps.edit.integrations.openCatalog', 'Open the catalog')}
              </Link>
            </p>
          )}
          {installed.map(item => {
            const bound = Boolean(bindings[item.id]);
            const binding = bindings[item.id] || {};
            const detail = details[item.id];
            const actions = (detail?.actions || []).filter(a => a.available);
            const allNames = actions.map(a => a.name);
            const selected = Array.isArray(binding.actions) ? binding.actions : allNames;
            const hasScopes = Boolean(detail?.definition?.scopes);
            const checkboxId = `app-integration-${item.id}`;
            return (
              <div
                key={item.id}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
              >
                <label htmlFor={checkboxId} className="flex items-start gap-3 cursor-pointer">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    className={`${CHECKBOX_CLASS} mt-1`}
                    checked={bound}
                    onChange={e => toggleInstance(item, e.target.checked)}
                  />
                  <span className="flex-1">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {item.label}
                    </span>
                    <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {item.id}
                    </span>
                    {item.enabled === false && (
                      <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300">
                        {t('admin.integrationCatalog.status.disabled', 'Disabled')}
                      </span>
                    )}
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {item.definitionName}
                    </span>
                  </span>
                </label>
                {bound && (
                  <div className="mt-3 pl-7 space-y-3">
                    <div>
                      <p className={LABEL_CLASS}>
                        {t('admin.apps.edit.integrations.actions', 'Actions')}
                      </p>
                      {!detail && <p className={HELP_CLASS}>{t('common.loading', 'Loading…')}</p>}
                      {detail && actions.length === 0 && (
                        <p className={HELP_CLASS}>
                          {t(
                            'admin.apps.edit.integrations.noActions',
                            'This installation offers no action right now.'
                          )}
                        </p>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {actions.map(action => (
                          <label
                            key={action.name}
                            className="inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
                          >
                            <input
                              type="checkbox"
                              className={`${CHECKBOX_CLASS} mt-0.5`}
                              checked={selected.includes(action.name)}
                              onChange={e =>
                                toggleAction(item.id, action.name, e.target.checked, allNames)
                              }
                            />
                            <span>
                              {action.title}
                              <span className="ml-1 font-mono text-xs text-gray-500 dark:text-gray-400">
                                {action.name}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                    {hasScopes && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label htmlFor={`${checkboxId}-default-scope`} className={LABEL_CLASS}>
                            {t('admin.apps.edit.integrations.defaultScope', 'Default {{scope}}', {
                              scope: detail.definition.scopes.label
                            })}
                          </label>
                          <input
                            id={`${checkboxId}-default-scope`}
                            className={`${INPUT_CLASS} font-mono`}
                            value={binding.defaultScope || ''}
                            onChange={e => setScope(item.id, { defaultScope: e.target.value })}
                            placeholder={t('admin.apps.edit.integrations.scopeAny', 'users pick')}
                          />
                        </div>
                        <div>
                          <label htmlFor={`${checkboxId}-pinned-scope`} className={LABEL_CLASS}>
                            {t('admin.apps.edit.integrations.pinnedScope', 'Pinned {{scope}}', {
                              scope: detail.definition.scopes.label
                            })}
                          </label>
                          <input
                            id={`${checkboxId}-pinned-scope`}
                            className={`${INPUT_CLASS} font-mono`}
                            value={binding.pinnedScope || ''}
                            onChange={e => setScope(item.id, { pinnedScope: e.target.value })}
                          />
                          <p className={HELP_CLASS}>
                            {t(
                              'admin.apps.edit.integrations.pinnedHelp',
                              'Fixes the scope; users cannot change it.'
                            )}
                          </p>
                        </div>
                        <div>
                          <label htmlFor={`${checkboxId}-picker`} className={LABEL_CLASS}>
                            {t('admin.apps.edit.integrations.scopePicker', 'Scope picker')}
                          </label>
                          <select
                            id={`${checkboxId}-picker`}
                            className={INPUT_CLASS}
                            value={binding.scopePicker || 'menu'}
                            onChange={e =>
                              setScope(item.id, {
                                scopePicker: e.target.value === 'menu' ? '' : e.target.value
                              })
                            }
                          >
                            <option value="menu">
                              {t('admin.apps.edit.integrations.picker.menu', 'In the menu')}
                            </option>
                            <option value="hidden">
                              {t('admin.apps.edit.integrations.picker.hidden', 'Hidden')}
                            </option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {staleIds.map(id => (
            <div
              key={id}
              data-testid={`stale-integration-${id}`}
              className="rounded-lg border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-2 flex items-start gap-3"
            >
              <div className="flex-1">
                <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{id}</span>
                <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300">
                  {t('admin.apps.edit.integrations.notInstalled', 'Not installed')}
                </span>
                <p className={HELP_CLASS}>
                  {t(
                    'admin.apps.edit.integrations.notInstalledHelp',
                    'This installation no longer exists, so the app is hidden from users. Unbind it to offer the app again.'
                  )}
                </p>
              </div>
              <button
                type="button"
                className={SECONDARY_BUTTON_CLASS}
                onClick={() => setBinding(id, null)}
              >
                {t('admin.apps.edit.integrations.unbind', 'Unbind')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default IntegrationsConfigSection;
