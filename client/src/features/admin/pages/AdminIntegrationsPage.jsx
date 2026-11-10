// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import AdminTabs from '../components/AdminTabs';
import AdminLoadError from '../components/AdminLoadError';
import IntegrationTestResults from '../components/IntegrationTestResults';
import IntegrationInstallDialog from '../components/integrations/IntegrationInstallDialog';
import IntegrationConnectionsDialog from '../components/integrations/IntegrationConnectionsDialog';
import IntegrationGroupSection from '../components/integrations/IntegrationGroupSection';
import InstallationTile from '../components/integrations/InstallationTile';
import CatalogTile from '../components/integrations/CatalogTile';
import InboundIntegrations, {
  ClientsSection
} from '../components/integrations/InboundIntegrations';
import {
  CLIENT_INTEGRATIONS,
  matchesInboundQuery
} from '../components/integrations/inboundChannels';
import IntegrationRequestsPanel from '../components/integrations/IntegrationRequestsPanel';
import WebsiteCorpusDomainsPanel from '../components/integrations/WebsiteCorpusDomainsPanel';
import { announceIntegrationRequestCount } from '../hooks/useIntegrationRequestCount';
import {
  MigrationConfirmDialog,
  MigrationOutcome
} from '../components/integrations/MigrationParts';
import useMigrationActions from '../components/integrations/useMigrationActions';
import { groupIntegrations } from '../components/integrations/integrationGroups';
import { appsBindingInstallation } from '../components/integrations/integrationBindings';
import { groupsGranting } from '../utils/groupIntegrationAccess';
import {
  CALLOUT_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/formStyles';
import {
  approveIntegrationRequest,
  declineIntegrationRequest,
  deleteInstalledIntegration,
  fetchInstalledIntegrations,
  fetchIntegrationCatalog,
  fetchIntegrationRequests,
  reloadIntegrationCatalog,
  setInstalledIntegrationEnabled,
  showHiddenIntegration,
  testInstalledIntegration
} from '../../../api/integrationsAdminApi';
import {
  fetchAdminApps,
  fetchAdminGroups,
  fetchAdminPlatformConfig,
  getAdminApiErrorMessage,
  installMarketplaceItem,
  refreshMarketplaceRegistry
} from '../../../api/adminApi';

const TABS = new Set(['installed', 'catalog', 'requests', 'inbound']);

/** Marketplace item names are definition folder names: `/` became `__`. */
export function definitionIdFromParam(value) {
  return value ? value.replace('__', '/') : null;
}

/**
 * Prefilled install values from a deep link: `v.<key>=<value>` parameters
 * (`?install=com.intrafind__ldap-directory&v.authProvider=corp-ad`) and the
 * `label` parameter. Another page (the LDAP sign-in providers) opens the
 * install dialog this way with its own context filled in.
 *
 * @param {URLSearchParams} params
 * @returns {{ values: Object<string,string>, label: string }}
 */
export function prefillFromParams(params) {
  const values = {};
  for (const [key, value] of params.entries()) {
    if (key.startsWith('v.') && key.length > 2) values[key.slice(2)] = value;
  }
  const label = params.get('label') || '';
  return { values, label };
}

/**
 * Whether an installation or catalog definition matches the search text
 * (label, name, id, definition, description, categories).
 *
 * @param {Object} entry
 * @param {string} query - lower-cased, trimmed
 * @returns {boolean}
 */
export function matchesIntegrationQuery(entry, query) {
  if (!query) return true;
  const texts = [
    entry.label,
    entry.name,
    entry.id,
    entry.definition,
    entry.definitionName,
    entry.description,
    ...(entry.categories || [])
  ];
  return texts.some(text => typeof text === 'string' && text.toLowerCase().includes(query));
}

/**
 * Admin → Integrations (`/admin/integrations`): the one page of the
 * integrations iHub calls out to and of the channels that connect to iHub.
 *
 * Tabs (`?tab=`):
 *
 * - **Installed** (default): first the **Clients** section, the channels
 *   users work in (Outlook add-in, browser extension, Microsoft 365 Copilot,
 *   Nextcloud embed), each linking to its page with its status; then every
 *   installation as a tile, grouped (people directories, web search, storage
 *   providers, MCP servers, agents, built-in, from the catalog). The search
 *   filters both. A tile opens the installation's page
 *   (`/admin/integrations/:instanceId`); its quick actions test, enable /
 *   disable (asking first when apps bind it), remove and list the connected
 *   users. An installation with a migration state also offers the actions
 *   of that state (Migrate now, Re-run migration, Restore backup, Adopt
 *   current version); their outcome shows above the groups with a link to
 *   the installation's page.
 * - **Catalog**: the definitions to install from, in the same groups.
 *   Install opens the install dialog; so does the deep link
 *   `?install=<folder name>` with `v.<key>=` and `label` prefills (the
 *   marketplace, the LDAP sign-in providers).
 * - **Requests**: what users asked for from the catalog (#2926). Approve
 *   opens the install dialog for the definition; Decline and Decline and
 *   hide ask for a note. The count of open requests is the tab's badge and
 *   the sidebar's.
 * - **Inbound**: Outlook add-in, browser extension, Microsoft 365 Copilot,
 *   Nextcloud embed and the MCP gateway, each with its status.
 */
function AdminIntegrationsPage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const featureFlags = useFeatureFlags();
  const integrationsEnabled = featureFlags.isEnabled('integrations', true);
  const tabParam = searchParams.get('tab');
  const tab = TABS.has(tabParam) ? tabParam : 'installed';
  const installParam = searchParams.get('install');

  const [installed, setInstalled] = useState([]);
  const [catalog, setCatalog] = useState([]);
  // Whether the marketplace feeds the catalog, and its registries ({ id, name, fetchedAt }).
  const [marketplace, setMarketplace] = useState(null);
  // Registries without a cached catalog are refreshed once per visit.
  const refreshedRegistriesRef = useRef(false);
  const [apps, setApps] = useState([]);
  // The groups (id → group), for who grants each installation; null when unknown.
  const [groups, setGroups] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // A message handed over by the page we came from (e.g. "removed" from an installation's page).
  const [message, setMessage] = useState(() => location.state?.flash || null);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null); // { definitionId, prefill? }
  const [connectionsFor, setConnectionsFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'remove' | 'disable', item }
  const [busy, setBusy] = useState(null);
  const [testResult, setTestResult] = useState(null);
  // The outcome of the last migration action (log entry or error), until dismissed.
  const [migrationOutcome, setMigrationOutcome] = useState(null);
  // The users' requests: { requests, hidden, openCount }; null while unknown.
  const [requestQueue, setRequestQueue] = useState(null);
  const [requestsFailed, setRequestsFailed] = useState(false);

  const loadRequests = useCallback(async () => {
    try {
      const queue = await fetchIntegrationRequests();
      setRequestQueue(queue);
      setRequestsFailed(false);
      announceIntegrationRequestCount(queue?.openCount || 0);
    } catch {
      setRequestsFailed(true);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [installedRes, catalogRes] = await Promise.all([
        fetchInstalledIntegrations(),
        fetchIntegrationCatalog()
      ]);
      setInstalled(installedRes?.items || []);
      setCatalog(catalogRes?.items || []);
      setMarketplace(catalogRes?.marketplace || null);
      // Which apps bind each installation (for the remove and disable
      // warnings) and which groups grant it (for the tiles); the page works
      // without either list.
      const [appList, groupsResult] = await Promise.all([
        fetchAdminApps().catch(() => null),
        fetchAdminGroups().catch(() => null)
      ]);
      setApps(Array.isArray(appList) ? appList : []);
      setGroups(
        groupsResult?.groups && typeof groupsResult.groups === 'object' ? groupsResult.groups : null
      );
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The marketplace's integrations come from the registries' cached
  // catalogs; a registry that was never refreshed is fetched once, so the
  // catalog lists its integrations without a trip to the Marketplace page.
  useEffect(() => {
    if (refreshedRegistriesRef.current || !marketplace?.enabled) return;
    const missing = (marketplace.registries || []).filter(registry => !registry.fetchedAt);
    refreshedRegistriesRef.current = true;
    if (missing.length === 0) return;
    void Promise.allSettled(missing.map(registry => refreshMarketplaceRegistry(registry.id))).then(
      results => {
        if (results.some(result => result.status === 'fulfilled')) void load();
      }
    );
  }, [marketplace, load]);

  // The queue is read on its own: the page works without it.
  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  // The inbound channels' switches live in platform.json; without it every
  // card shows "Available".
  useEffect(() => {
    let cancelled = false;
    fetchAdminPlatformConfig()
      .then(result => {
        if (!cancelled) setPlatform(result);
      })
      .catch(() => {
        if (!cancelled) setPlatform(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The handed-over message is shown once: drop it from the history entry so a
  // reload does not show it again.
  useEffect(() => {
    if (location.state?.flash) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
  }, [location.state, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  /**
   * Install a definition from the catalog: a marketplace entry is first
   * installed from its registry (the marketplace's own install and checks),
   * then the setup dialog opens for it like for any loaded definition.
   */
  const startInstall = useCallback(
    async (definitionId, prefill) => {
      const item = catalog.find(entry => entry.id === definitionId);
      if (item?.source !== 'marketplace') {
        setDialog({ definitionId, prefill });
        return;
      }
      setBusy(definitionId);
      try {
        await installMarketplaceItem(
          item.marketplace.registryId,
          'integration',
          item.marketplace.name
        );
        await load();
        setDialog({ definitionId, prefill });
      } catch (err) {
        setMessage({
          type: 'error',
          text: t(
            'admin.integrationCatalog.marketplaceInstallFailed',
            '{{name}} could not be installed from {{registry}}: {{error}}',
            {
              name: item.name,
              registry: item.marketplace.registryName,
              error: getAdminApiErrorMessage(err)
            }
          )
        });
      } finally {
        setBusy(null);
      }
    },
    [catalog, load, t]
  );

  // Deep link: /admin/integrations?install=<folder name>[&label=…][&v.<key>=…]
  useEffect(() => {
    const definitionId = definitionIdFromParam(installParam);
    if (!definitionId || loading) return;
    void startInstall(definitionId, prefillFromParams(searchParams));
    const next = new URLSearchParams(searchParams);
    next.delete('install');
    next.delete('label');
    // Iterate the original: deleting from `next` while iterating it would skip keys.
    for (const key of searchParams.keys()) if (key.startsWith('v.')) next.delete(key);
    setSearchParams(next, { replace: true });
  }, [installParam, loading, searchParams, setSearchParams, startInstall]);

  const setTab = next => {
    const params = new URLSearchParams(searchParams);
    if (next === 'installed') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const takenIds = useMemo(() => installed.map(item => item.id), [installed]);
  const query = search.trim().toLowerCase();
  const installedGroups = useMemo(
    () => groupIntegrations(installed.filter(item => matchesIntegrationQuery(item, query))),
    [installed, query]
  );
  // The Clients section above the installations; `t` gives the search the
  // titles and descriptions in the current language.
  const clientEntries = useMemo(
    () => CLIENT_INTEGRATIONS.filter(entry => matchesInboundQuery(entry, query, t)),
    [query, t]
  );
  const catalogGroups = useMemo(
    () => groupIntegrations(catalog.filter(item => matchesIntegrationQuery(item, query))),
    [catalog, query]
  );

  /** The names of the apps that bind an installation. */
  const boundAppNames = useCallback(
    item => appsBindingInstallation(apps, item, i18n.language).map(app => app.name),
    [apps, i18n.language]
  );

  const flash = (type, text) => setMessage({ type, text });

  const migration = useMigrationActions({
    onDone: async outcome => {
      setMigrationOutcome(outcome);
      await load();
    }
  });

  const onInstalled = instance => {
    setDialog(null);
    flash(
      'success',
      t('admin.integrationCatalog.saved', 'Integration "{{id}}" saved.', { id: instance.id })
    );
    setTab('installed');
    void load();
    // Installing closes the requests it serves.
    void loadRequests();
  };

  const approveRequest = async request => {
    setBusy(request.id);
    try {
      if (request.status === 'open') await approveIntegrationRequest(request.id);
      await loadRequests();
      setDialog({ definitionId: request.definition });
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const declineRequest = async (request, { note, hide }) => {
    setBusy(request.id);
    try {
      await declineIntegrationRequest(request.id, { note, hide });
      flash(
        'success',
        hide
          ? t(
              'admin.integrations.requests.declinedHidden',
              'Request declined; {{name}} is hidden from users.',
              { name: request.definitionName }
            )
          : t('admin.integrations.requests.declined', 'Request for {{name}} declined.', {
              name: request.definitionName
            })
      );
      await loadRequests();
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const showHidden = async definition => {
    setBusy(definition);
    try {
      await showHiddenIntegration(definition);
      await loadRequests();
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
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

  // Disabling takes the installation from every app that uses it, and hides an app
  // that requires it: ask first when there is one.
  const requestToggle = item => {
    if (item.enabled !== false && boundAppNames(item).length > 0) {
      setConfirm({ kind: 'disable', item });
    } else {
      void toggle(item);
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

  const remove = async item => {
    setBusy(item.id);
    try {
      await deleteInstalledIntegration(item.id);
      flash(
        'success',
        t('admin.integrationCatalog.removed', 'Integration "{{id}}" removed.', { id: item.id })
      );
      if (testResult?.id === item.id) setTestResult(null);
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
      if (marketplace?.enabled) {
        await Promise.allSettled(
          (marketplace.registries || []).map(registry => refreshMarketplaceRegistry(registry.id))
        );
      }
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
    },
    {
      id: 'requests',
      label: t('admin.integrations.requests.tab', 'Requests'),
      ...(requestQueue ? { count: requestQueue.openCount || 0 } : {})
    },
    { id: 'inbound', label: t('admin.integrations.tabs.inbound', 'Inbound') }
  ];

  const searchBox = (
    <div className="mb-6">
      <label htmlFor="integrations-search" className="sr-only">
        {t('admin.integrations.searchPlaceholder', 'Search integrations…')}
      </label>
      <div className="relative w-full sm:max-w-md">
        <Icon
          name="search"
          size="sm"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
        />
        <input
          id="integrations-search"
          type="search"
          className={`${INPUT_CLASS} pl-9`}
          placeholder={t('admin.integrations.searchPlaceholder', 'Search integrations…')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
    </div>
  );

  const noMatch = (
    <output className="block text-sm text-gray-600 dark:text-gray-400">
      {t('admin.integrations.noMatch', 'Nothing matches "{{query}}".', { query: search.trim() })}
    </output>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {!integrationsEnabled && (
        <div className={`mb-6 ${CALLOUT_CLASS.warning}`}>
          {t(
            'admin.integrations.featureFlagOff',
            'The "integrations" feature flag is off. Enable it under Admin → Features to surface integration endpoints to clients.'
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.integrations.title', 'Integrations')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1 max-w-3xl">
            {t(
              'admin.integrations.subtitle',
              'The systems iHub works with: install an integration from the catalog, point it at your system and bind it to apps. Inbound lists what connects to iHub.'
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={reload}>
            <Icon name="refresh" size="sm" />
            {t('admin.integrationCatalog.reload', 'Reload catalog')}
          </button>
          <Link to="/admin/integrations/builder/new" className={SECONDARY_BUTTON_CLASS}>
            <Icon name="wrench" size="sm" />
            {t('admin.integrationBuilder.addManually', 'Add manually')}
          </Link>
          <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={() => setTab('catalog')}>
            <Icon name="plus" size="sm" />
            {t('admin.integrationCatalog.install', 'Install')}
          </button>
        </div>
      </div>

      {message && (
        <output
          className={`mb-4 block ${message.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success}`}
        >
          {message.text}
        </output>
      )}
      {error && <AdminLoadError message={error} framed={false} className="mb-4" />}

      <AdminTabs
        tabs={tabs}
        activeId={tab}
        onChange={setTab}
        ariaLabel={t('admin.integrations.title', 'Integrations')}
      />

      {loading && (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      )}
      {!loading && tab === 'installed' && (
        <div role="tabpanel" id="tabpanel-installed" aria-labelledby="tab-installed">
          {testResult && (
            <div className="mb-6" data-testid="tile-test-results">
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS}
                  onClick={() => setTestResult(null)}
                >
                  <Icon name="x" size="sm" />
                  {t('admin.integrations.closeTestResults', 'Close test results')}
                </button>
              </div>
              <IntegrationTestResults
                title={t('admin.integrationCatalog.testResultsFor', 'Test results: {{label}}', {
                  label: testResult.label
                })}
                result={testResult.result}
              />
            </div>
          )}
          {migrationOutcome && (
            <div className="mb-6">
              <MigrationOutcome
                outcome={migrationOutcome}
                onDismiss={() => setMigrationOutcome(null)}
                linkToInstallation
              />
            </div>
          )}
          {/* Without a search box (nothing installed) the Clients section is shown whole. */}
          {installed.length === 0 && (
            <div className="mb-8">
              <ClientsSection entries={CLIENT_INTEGRATIONS} platform={platform} />
            </div>
          )}
          {installed.length === 0 ? (
            <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700">
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
            <>
              {searchBox}
              {installedGroups.length === 0 && clientEntries.length === 0 ? (
                noMatch
              ) : (
                <div className="space-y-8">
                  <ClientsSection entries={clientEntries} platform={platform} />
                  {installedGroups.map(group => (
                    <IntegrationGroupSection key={group.id} group={group} scope="installed">
                      {group.items.map(item => (
                        <InstallationTile
                          key={item.id}
                          item={item}
                          installations={installed}
                          grantedTo={groups ? groupsGranting(item, groups) : null}
                          busy={busy === item.id || migration.running === item.id}
                          onTest={runTest}
                          onToggle={requestToggle}
                          onRemove={target => setConfirm({ kind: 'remove', item: target })}
                          onConnections={setConnectionsFor}
                          onMigrationAction={migration.request}
                        />
                      ))}
                    </IntegrationGroupSection>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {!loading && tab === 'catalog' && (
        <div role="tabpanel" id="tabpanel-catalog" aria-labelledby="tab-catalog">
          <div
            className={`mb-6 flex flex-wrap items-center justify-between gap-3 ${CALLOUT_CLASS.info}`}
          >
            <p>
              {t(
                'admin.integrationBuilder.catalogHint',
                'Not in the catalog? Build it from an OpenAPI document, HTTP requests, a script, an MCP server or an A2A agent.'
              )}
            </p>
            <Link to="/admin/integrations/builder/new" className={SECONDARY_BUTTON_CLASS}>
              <Icon name="wrench" size="sm" />
              {t('admin.integrationBuilder.addManually', 'Add manually')}
            </Link>
          </div>
          {marketplace && !marketplace.enabled && (
            <p className={`mb-6 ${CALLOUT_CLASS.info}`} data-testid="catalog-marketplace-off">
              {t(
                'admin.integrationCatalog.marketplaceOff',
                'The catalog also lists the integrations of the marketplace (hosted MCP servers such as GitHub, Linear or Stripe) when the Marketplace feature is on under Admin → Features.'
              )}
            </p>
          )}
          {searchBox}
          {catalogGroups.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.integrationCatalog.catalogEmpty',
                'No definitions match. Integrations can also be installed from the Marketplace.'
              )}
            </p>
          ) : (
            <div className="space-y-8">
              {catalogGroups.map(group => (
                <IntegrationGroupSection key={group.id} group={group} scope="catalog">
                  {group.items.map(item => (
                    <CatalogTile
                      key={item.id}
                      item={item}
                      busy={busy === item.id}
                      onInstall={definitionId => void startInstall(definitionId)}
                    />
                  ))}
                </IntegrationGroupSection>
              ))}
            </div>
          )}
        </div>
      )}
      {!loading && tab === 'requests' && (
        <div role="tabpanel" id="tabpanel-requests" aria-labelledby="tab-requests">
          {requestsFailed && (
            <AdminLoadError
              message={t(
                'admin.integrations.requests.loadFailed',
                'The requests could not be loaded.'
              )}
              framed={false}
              className="mb-4"
            />
          )}
          {requestQueue ? (
            <IntegrationRequestsPanel
              requests={requestQueue.requests || []}
              hidden={requestQueue.hidden || []}
              busyId={busy}
              onApprove={approveRequest}
              onDecline={declineRequest}
              onShow={showHidden}
            />
          ) : (
            !requestsFailed && (
              <div className="flex justify-center py-16">
                <LoadingSpinner size="lg" />
              </div>
            )
          )}
          {installed.some(item => item.definition === 'com.intrafind/website-corpus') && (
            <WebsiteCorpusDomainsPanel />
          )}
        </div>
      )}
      {!loading && tab === 'inbound' && (
        <div role="tabpanel" id="tabpanel-inbound" aria-labelledby="tab-inbound">
          <InboundIntegrations platform={platform} />
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
          takenIds={takenIds}
          prefill={dialog.prefill}
          onClose={() => setDialog(null)}
          onSaved={onInstalled}
        />
      )}

      <MigrationConfirmDialog
        pending={migration.pending}
        onConfirm={migration.confirm}
        onCancel={migration.cancel}
        onSelectBackup={migration.selectBackup}
      />

      <ConfirmDialog
        isOpen={Boolean(confirm)}
        title={
          confirm?.kind === 'disable'
            ? t('admin.integrationCatalog.confirmDisable.title', 'Disable integration?')
            : t('admin.integrationCatalog.confirmRemove.title', 'Remove integration?')
        }
        message={
          <>
            <p>
              {confirm?.kind === 'disable'
                ? t(
                    'admin.integrationCatalog.confirmDisable.message',
                    'Apps that use "{{id}}" go without it while it is disabled. An app that requires it is hidden from users.',
                    { id: confirm?.item.id }
                  )
                : t(
                    'admin.integrationCatalog.confirmRemove.message',
                    'Apps that use "{{id}}" lose its actions. An app that requires it is hidden from users until its configuration changes. A stored service-account token is deleted with it.',
                    { id: confirm?.item.id }
                  )}
            </p>
            {confirm && boundAppNames(confirm.item).length > 0 && (
              <p className="mt-2" data-testid="bound-apps">
                {t('admin.integrationCatalog.boundApps', 'Used by: {{apps}}', {
                  apps: boundAppNames(confirm.item).join(', ')
                })}
              </p>
            )}
          </>
        }
        confirmLabel={
          confirm?.kind === 'disable'
            ? t('admin.integrationCatalog.status.disable', 'Disable')
            : t('common.delete', 'Delete')
        }
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (!current) return;
          if (current.kind === 'disable') void toggle(current.item);
          else void remove(current.item);
        }}
        onDeny={() => setConfirm(null)}
      />
    </div>
  );
}

export default AdminIntegrationsPage;
