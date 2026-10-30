// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import AdminTabs from '../components/AdminTabs';
import AdminLoadError from '../components/AdminLoadError';
import IntegrationTestResults from '../components/IntegrationTestResults';
import IntegrationInstallDialog from '../components/integrations/IntegrationInstallDialog';
import IntegrationConnectionsDialog from '../components/integrations/IntegrationConnectionsDialog';
import {
  CALLOUT_CLASS,
  DANGER_BUTTON_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/people-directories/formStyles';
import {
  deleteInstalledIntegration,
  fetchInstalledIntegrations,
  fetchIntegrationCatalog,
  reloadIntegrationCatalog,
  setInstalledIntegrationEnabled,
  testInstalledIntegration
} from '../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../api/adminApi';

const TABS = ['installed', 'catalog'];

/** Marketplace item names are definition folder names: `/` became `__`. */
function definitionIdFromParam(value) {
  return value ? value.replace('__', '/') : null;
}

function Pill({ tone = 'gray', children }) {
  const tones = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
    yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
    blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300',
    gray: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tones[tone] || tones.gray}`}
    >
      {children}
    </span>
  );
}

/**
 * Admin → Integrations → Installed: the installed instances of catalog
 * definitions (test, edit, enable, remove) and the catalog to install from.
 * The install wizard is built from each definition's install fields.
 */
function AdminInstalledIntegrationsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = TABS.includes(tabParam) ? tabParam : 'installed';
  const installParam = searchParams.get('install');

  const [installed, setInstalled] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null); // { definitionId, instanceId? }
  const [connectionsFor, setConnectionsFor] = useState(null); // an installation that signs users in
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [installedRes, catalogRes] = await Promise.all([
        fetchInstalledIntegrations(),
        fetchIntegrationCatalog()
      ]);
      setInstalled(installedRes.items || []);
      setCatalog(catalogRes.items || []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep link from the marketplace: /admin/integrations/installed?install=<folder name>
  useEffect(() => {
    const definitionId = definitionIdFromParam(installParam);
    if (definitionId && !loading) {
      setDialog({ definitionId });
      const next = new URLSearchParams(searchParams);
      next.delete('install');
      setSearchParams(next, { replace: true });
    }
  }, [installParam, loading, searchParams, setSearchParams]);

  const setTab = next => {
    const params = new URLSearchParams(searchParams);
    if (next === 'installed') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const takenIds = useMemo(() => installed.map(i => i.id), [installed]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      item =>
        item.name?.toLowerCase().includes(q) ||
        item.id?.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        (item.categories || []).some(c => c.toLowerCase().includes(q))
    );
  }, [catalog, search]);

  const flash = (type, text) => {
    setMessage({ type, text });
    window.setTimeout(() => setMessage(null), 6000);
  };

  const onSaved = instance => {
    setDialog(null);
    flash(
      'success',
      t('admin.integrationCatalog.saved', 'Integration "{{id}}" saved.', { id: instance.id })
    );
    load();
  };

  const toggle = async item => {
    setBusy(item.id);
    try {
      await setInstalledIntegrationEnabled(item.id, item.enabled === false);
      await load();
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const runTest = async item => {
    setBusy(item.id);
    setTestResult(null);
    try {
      const result = await testInstalledIntegration(item.id);
      setTestResult({ id: item.id, label: item.label, result });
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const item = confirmDelete;
    setConfirmDelete(null);
    if (!item) return;
    setBusy(item.id);
    try {
      await deleteInstalledIntegration(item.id);
      flash(
        'success',
        t('admin.integrationCatalog.removed', 'Integration "{{id}}" removed.', { id: item.id })
      );
      await load();
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reload = async () => {
    try {
      await reloadIntegrationCatalog();
      await load();
      flash('success', t('admin.integrationCatalog.reloaded', 'Catalog reloaded.'));
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    }
  };

  const tabs = [
    {
      id: 'installed',
      label: t('admin.integrationCatalog.tabs.installed', 'Installed'),
      count: installed.length
    },
    {
      id: 'catalog',
      label: t('admin.integrationCatalog.tabs.catalog', 'Catalog'),
      count: catalog.length
    }
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <AdminBreadcrumb
        crumbs={[
          { label: t('admin.nav.integrations', 'Integrations'), href: '/admin/integrations' },
          { label: t('admin.nav.installedIntegrations', 'Installed integrations') }
        ]}
      />
      <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.integrationCatalog.title', 'Installed integrations')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.integrationCatalog.subtitle',
              'Install an integration from the catalog, point it at your system and bind it to apps. Each installation brings its actions to the model.'
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={reload}>
            <Icon name="refresh" size="sm" />
            {t('admin.integrationCatalog.reload', 'Reload catalog')}
          </button>
          <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={() => setTab('catalog')}>
            <Icon name="plus" size="sm" />
            {t('admin.integrationCatalog.install', 'Install')}
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`mb-4 ${message.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success}`}
          role="status"
        >
          {message.text}
        </div>
      )}
      {error && <AdminLoadError message={error} className="mb-4" />}

      <AdminTabs
        tabs={tabs}
        activeId={tab}
        onChange={setTab}
        ariaLabel={t('admin.integrationCatalog.title', 'Installed integrations')}
      />

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : tab === 'installed' ? (
        <div role="tabpanel" id="tabpanel-installed" className="mt-6">
          {installed.length === 0 ? (
            <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
              <Icon name="link" size="lg" className="mx-auto text-gray-400" />
              <h2 className="mt-3 text-lg font-medium text-gray-900 dark:text-gray-100">
                {t('admin.integrationCatalog.empty.title', 'Nothing installed yet')}
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {t(
                  'admin.integrationCatalog.empty.description',
                  'Pick an integration from the catalog, enter its settings and test it before you save.'
                )}
              </p>
              <button
                type="button"
                className={`${PRIMARY_BUTTON_CLASS} mt-4`}
                onClick={() => setTab('catalog')}
              >
                {t('admin.integrationCatalog.empty.cta', 'Open the catalog')}
              </button>
            </div>
          ) : (
            <ul className="bg-white dark:bg-gray-800 shadow-sm overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
              {installed.map(item => (
                <li key={item.id} className="px-4 py-4 sm:px-6 flex flex-wrap items-start gap-4">
                  <div className="flex-1 min-w-[240px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {item.label}
                      </span>
                      <Pill tone={item.enabled === false ? 'yellow' : 'green'}>
                        {item.enabled === false
                          ? t('admin.integrationCatalog.status.disabled', 'Disabled')
                          : t('admin.integrationCatalog.status.enabled', 'Enabled')}
                      </Pill>
                      {item.definitionMissing && (
                        <Pill tone="red">
                          {t(
                            'admin.integrationCatalog.status.definitionMissing',
                            'Definition missing'
                          )}
                        </Pill>
                      )}
                      {item.auth?.mode && item.auth.mode !== 'none' && (
                        <Pill tone="blue">
                          {t(
                            `admin.integrationCatalog.authModes.short.${item.auth.mode}`,
                            item.auth.mode
                          )}
                        </Pill>
                      )}
                      {item.status && item.enabled !== false && (
                        <Pill
                          tone={
                            item.status.unhealthy
                              ? 'red'
                              : item.status.connected || item.status.perUser
                                ? 'green'
                                : 'gray'
                          }
                        >
                          {item.status.unhealthy
                            ? t('admin.integrationCatalog.status.unhealthy', 'Unreachable')
                            : item.status.perUser
                              ? t(
                                  'admin.integrationCatalog.status.userConnections',
                                  '{{count}} connected users',
                                  { count: item.status.userConnections || 0 }
                                )
                              : item.status.connected
                                ? t('admin.integrationCatalog.status.connected', 'Connected')
                                : t(
                                    'admin.integrationCatalog.status.notConnected',
                                    'Not connected'
                                  )}
                          {typeof item.status.toolCount === 'number' &&
                            ` · ${t('admin.integrationCatalog.status.toolCount', '{{count}} tools', { count: item.status.toolCount })}`}
                        </Pill>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                      {item.definitionName}
                      <span className="mx-1.5 text-gray-400">·</span>
                      <span className="font-mono text-xs">{item.id}</span>
                      {item.values?.baseUrl && (
                        <>
                          <span className="mx-1.5 text-gray-400">·</span>
                          <span className="font-mono text-xs">{String(item.values.baseUrl)}</span>
                        </>
                      )}
                    </p>
                    {item.allowedGroups?.length > 0 && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {t('admin.integrationCatalog.groupsLine', 'Groups: {{groups}}', {
                          groups: item.allowedGroups.join(', ')
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {item.perUser && (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON_CLASS}
                        onClick={() => setConnectionsFor(item)}
                        aria-label={t(
                          'admin.integrationCatalog.actions.connections',
                          'Connected users of {{id}}',
                          { id: item.id }
                        )}
                        title={t('admin.integrationCatalog.connections.title', 'Connected users')}
                      >
                        <Icon name="users" size="sm" />
                      </button>
                    )}
                    <button
                      type="button"
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() => runTest(item)}
                      disabled={busy === item.id || item.definitionMissing}
                      aria-label={t('admin.integrationCatalog.actions.test', 'Test {{id}}', {
                        id: item.id
                      })}
                      title={t('admin.integrationCatalog.actions.testTitle', 'Test connection')}
                    >
                      <Icon name="play" size="sm" />
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() =>
                        setDialog({ definitionId: item.definition, instanceId: item.id })
                      }
                      disabled={item.definitionMissing}
                      aria-label={t('admin.integrationCatalog.actions.edit', 'Edit {{id}}', {
                        id: item.id
                      })}
                      title={t('common.edit', 'Edit')}
                    >
                      <Icon name="pencil" size="sm" />
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() => toggle(item)}
                      disabled={busy === item.id}
                      aria-pressed={item.enabled !== false}
                      aria-label={
                        item.enabled === false
                          ? t('admin.integrationCatalog.actions.enable', 'Enable {{id}}', {
                              id: item.id
                            })
                          : t('admin.integrationCatalog.actions.disable', 'Disable {{id}}', {
                              id: item.id
                            })
                      }
                      title={
                        item.enabled === false
                          ? t('admin.integrationCatalog.status.enable', 'Enable')
                          : t('admin.integrationCatalog.status.disable', 'Disable')
                      }
                    >
                      <Icon name={item.enabled === false ? 'check' : 'pause'} size="sm" />
                    </button>
                    <button
                      type="button"
                      className={DANGER_BUTTON_CLASS}
                      onClick={() => setConfirmDelete(item)}
                      disabled={busy === item.id}
                      aria-label={t('admin.integrationCatalog.actions.remove', 'Remove {{id}}', {
                        id: item.id
                      })}
                      title={t('common.delete', 'Delete')}
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {testResult && (
            <div className="mt-6">
              <IntegrationTestResults
                title={t('admin.integrationCatalog.testResultsFor', 'Test results: {{label}}', {
                  label: testResult.label
                })}
                result={testResult.result}
              />
            </div>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="tabpanel-catalog" className="mt-6">
          <div className="mb-4">
            <label htmlFor="integration-catalog-search" className="sr-only">
              {t('admin.integrationCatalog.searchPlaceholder', 'Search the catalog')}
            </label>
            <input
              id="integration-catalog-search"
              type="search"
              className="w-full sm:max-w-md rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
              placeholder={t('admin.integrationCatalog.searchPlaceholder', 'Search the catalog')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {filteredCatalog.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.integrationCatalog.catalogEmpty',
                'No definitions match. Integrations can also be installed from the Marketplace.'
              )}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCatalog.map(item => (
                <div
                  key={item.id}
                  className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-5 flex flex-col"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                      {item.name}
                    </h3>
                    <Pill tone={item.source === 'installed' ? 'blue' : 'gray'}>
                      {item.source === 'installed'
                        ? t('admin.integrationCatalog.source.installed', 'From registry')
                        : t('admin.integrationCatalog.source.shipped', 'Shipped')}
                    </Pill>
                  </div>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
                    {item.description}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <dt>{t('admin.integrationCatalog.facts.protocol', 'Protocol')}</dt>
                    <dd className="font-mono">{item.protocol}</dd>
                    <dt>{t('admin.integrationCatalog.facts.signIn', 'Sign-in')}</dt>
                    <dd>
                      {(item.authModes || [])
                        .map(m => t(`admin.integrationCatalog.authModes.short.${m}`, m))
                        .join(', ')}
                    </dd>
                    <dt>{t('admin.integrationCatalog.facts.actions', 'Actions')}</dt>
                    <dd>{item.actionCount}</dd>
                    <dt>{t('admin.integrationCatalog.facts.publisher', 'Publisher')}</dt>
                    <dd>{item.publisher?.name || '—'}</dd>
                  </dl>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {item.runsCode && (
                        <Pill tone="yellow">
                          {t('admin.integrationCatalog.runsCode', 'Runs code on this server')}
                        </Pill>
                      )}{' '}
                      {item.installedInstances?.length
                        ? t('admin.integrationCatalog.installedCount', '{{count}} installed', {
                            count: item.installedInstances.length
                          })
                        : t('admin.integrationCatalog.notInstalled', 'Not installed')}
                    </span>
                    <button
                      type="button"
                      className={PRIMARY_BUTTON_CLASS}
                      disabled={!item.supported}
                      title={
                        item.supported
                          ? undefined
                          : t(
                              'admin.integrationCatalog.unsupportedShort',
                              'Protocol not supported yet'
                            )
                      }
                      onClick={() => setDialog({ definitionId: item.id })}
                    >
                      {t('admin.integrationCatalog.install', 'Install')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {connectionsFor && (
        <IntegrationConnectionsDialog
          instance={connectionsFor}
          onClose={() => setConnectionsFor(null)}
        />
      )}

      {dialog && (
        <IntegrationInstallDialog
          definitionId={dialog.definitionId}
          instanceId={dialog.instanceId}
          takenIds={takenIds}
          onClose={() => setDialog(null)}
          onSaved={onSaved}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmDelete)}
        title={t('admin.integrationCatalog.confirmRemove.title', 'Remove integration?')}
        message={t(
          'admin.integrationCatalog.confirmRemove.message',
          'Apps that bind "{{id}}" lose its actions. A stored service-account token is deleted with it.',
          { id: confirmDelete?.id }
        )}
        confirmLabel={t('common.delete', 'Delete')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={remove}
        onDeny={() => setConfirmDelete(null)}
      />
    </div>
  );
}

export default AdminInstalledIntegrationsPage;
