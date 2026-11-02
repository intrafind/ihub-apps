// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import AdminTabs from '../components/AdminTabs';
import AdminLoadError from '../components/AdminLoadError';
import IntegrationTestResults from '../components/IntegrationTestResults';
import IntegrationConnectionsDialog from '../components/integrations/IntegrationConnectionsDialog';
import IntegrationInstallForm from '../components/integrations/IntegrationInstallForm';
import IntegrationReleaseNotes from '../components/integrations/IntegrationReleaseNotes';
import IntegrationFactList from '../components/integrations/IntegrationFactList';
import { InstallationStatusPills, Pill } from '../components/integrations/IntegrationPills';
import { SideEffectBadge } from '../components/integrations/ActionToggleList';
import { pickText } from '../components/integrations/ConfigFieldInput';
import { installationFacts } from '../components/integrations/integrationFacts';
import { integrationGroup, integrationGroupOf } from '../components/integrations/integrationGroups';
import { appsBindingInstallation } from '../components/integrations/integrationBindings';
import {
  InstallationEditor,
  editorInstance,
  hasDedicatedEditor
} from '../components/integrations/editors';
import {
  CALLOUT_CLASS,
  DANGER_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/formStyles';
import {
  deleteInstalledIntegration,
  fetchInstalledIntegration,
  fetchInstalledIntegrations,
  fetchIntegrationDefinitionFile,
  setInstalledIntegrationEnabled,
  testInstalledIntegration
} from '../../../api/integrationsAdminApi';
import { fetchAdminApps, fetchAdminGroups, getAdminApiErrorMessage } from '../../../api/adminApi';
import { groupsGranting } from '../utils/groupIntegrationAccess';
import { GrantedGroups } from '../components/integrations/editors/InstallationEditorParts';

/** The tabs of the page; Releases only when the definition has a release history. */
const TABS = new Set(['overview', 'settings', 'releases']);

/** On the page the facts list everything known, not only the tile's top four. */
const PAGE_FACT_LIMIT = 12;

const CARD_CLASS =
  'bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-5';
const CARD_TITLE_CLASS = 'text-base font-semibold text-gray-900 dark:text-gray-100 mb-3';

/**
 * The tab to show: the one `?tab=` names when the page has it (Releases only
 * with a release history), else Overview.
 *
 * @param {string|null} tabParam - the `tab` search parameter
 * @param {boolean} hasReleases - the definition has a release history
 * @returns {'overview'|'settings'|'releases'}
 */
function activeTab(tabParam, hasReleases) {
  if (!TABS.has(tabParam)) return 'overview';
  if (tabParam === 'releases' && !hasReleases) return 'overview';
  return tabParam;
}

/**
 * How a bound app reaches the installation, for the "Apps that use it" list:
 * by its id, by its definition id, by its type, or (web search engines) as
 * its named engine or through web search on Auto.
 *
 * @param {{ via: string }} app - an entry of `appsBindingInstallation`
 * @param {Object} instance - the installation
 * @param {Function} t - the translation function
 * @returns {string}
 */
function bindingViaLabel(app, instance, t) {
  switch (app.via) {
    case 'installation':
      return t('admin.integrations.page.via.installation', 'by this installation');
    case 'definition':
      return t('admin.integrations.page.via.definition', 'every {{name}} installation', {
        name: instance.definitionName || instance.definition
      });
    case 'webSearch':
      return t('admin.integrations.page.via.webSearch', 'its web search engine');
    case 'webSearchAuto':
      return t(
        'admin.integrations.page.via.webSearchAuto',
        'web search on Auto (the first engine a user may use)'
      );
    default:
      return t('admin.integrations.page.via.type', 'every installation of its type');
  }
}

/**
 * Admin → Integrations → one installation (`/admin/integrations/:instanceId`).
 *
 * Header: label, definition, id, every status pill of the tile (version,
 * update, incompatible, live status, …) and the actions Test, Enable /
 * Disable (asks first when apps bind it), Connected users (per-user sign-in)
 * and Remove. Tabs:
 *
 * - **Overview**: the key facts of its values (never a secret), description,
 *   docs link, groups, the actions with their side effects and the apps that
 *   bind it (by installation id, by definition id or by `type:<type>`).
 * - **Settings**: the dedicated editor of its definition (`editors/index.js`),
 *   or the generic form built from the install fields.
 * - **Releases**: the definition's release history, when it has one.
 *
 * Reads `GET /api/admin/integrations/installed/:id`, the installation list
 * (to name the installation an `instance` field points at) and the apps.
 */
function AdminInstallationPage() {
  const { instanceId } = useParams();
  // A new id starts from a clean state (no stale detail, test result or dialog).
  return <InstallationPageContent key={instanceId} instanceId={instanceId} />;
}

/**
 * The page of one installation; see `AdminInstallationPage`.
 *
 * @param {Object} props
 * @param {string} props.instanceId
 */
function InstallationPageContent({ instanceId }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [detail, setDetail] = useState(null);
  const [installations, setInstallations] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'disable' | 'remove'
  const [showConnections, setShowConnections] = useState(false);
  // Bumped after a save or a cancel: remounts the editor with the stored values.
  const [editorKey, setEditorKey] = useState(0);
  // The groups (id → group), for who grants the installation; null when unknown.
  const [groups, setGroups] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detailResult, listResult, appList, groupsResult] = await Promise.all([
        fetchInstalledIntegration(instanceId),
        fetchInstalledIntegrations().catch(() => ({ items: [] })),
        fetchAdminApps().catch(() => []),
        fetchAdminGroups().catch(() => null)
      ]);
      setDetail(detailResult);
      setGroups(
        groupsResult?.groups && typeof groupsResult.groups === 'object' ? groupsResult.groups : null
      );
      setInstallations(listResult?.items || []);
      setApps(Array.isArray(appList) ? appList : []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const instance = detail?.instance || null;
  const definition = detail?.definition || null;
  const hasReleases = (definition?.releases?.length || 0) > 0;
  const tabParam = searchParams.get('tab');
  const tab = activeTab(tabParam, hasReleases);

  const setTab = next => {
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  // The installation with its effective values: what the facts and the editors read.
  const effective = useMemo(() => (detail ? editorInstance(detail) : null), [detail]);
  const facts = useMemo(
    () =>
      effective
        ? installationFacts(effective, { installations, definition, limit: PAGE_FACT_LIMIT })
        : [],
    [effective, installations, definition]
  );
  const boundApps = useMemo(
    () => (instance ? appsBindingInstallation(apps, instance, lang) : []),
    [apps, instance, lang]
  );
  const preloaded = useMemo(
    () => (detail && definition ? { definition, existing: detail } : null),
    [detail, definition]
  );

  const flash = (type, text) => {
    setMessage({ type, text });
    window.setTimeout(() => setMessage(null), 6000);
  };

  const runTest = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      setTestResult(await testInstalledIntegration(instance.id));
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      await setInstalledIntegrationEnabled(instance.id, instance.enabled === false);
      await load();
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Disabling hides every app that binds the installation: ask first when there is one.
  const requestToggle = () => {
    if (instance.enabled !== false && boundApps.length > 0) setConfirm('disable');
    else void toggle();
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteInstalledIntegration(instance.id);
      navigate('/admin/integrations', {
        state: {
          flash: {
            type: 'success',
            text: t('admin.integrationCatalog.removed', 'Integration "{{id}}" removed.', {
              id: instance.id
            })
          }
        }
      });
    } catch (err) {
      flash('error', getAdminApiErrorMessage(err));
      setBusy(false);
    }
  };

  const onSaved = async saved => {
    flash(
      'success',
      t('admin.integrationCatalog.saved', 'Integration "{{id}}" saved.', {
        id: saved?.id || instance.id
      })
    );
    // Reload first, then remount the editor: it starts from what the server stored.
    await load();
    setEditorKey(key => key + 1);
  };

  const onCancel = () => {
    setEditorKey(key => key + 1);
    setTab('overview');
  };

  const crumbs = [
    { label: t('admin.nav.integrations', 'Integrations'), href: '/admin/integrations' },
    { label: instance?.label || instanceId }
  ];

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !instance) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminBreadcrumb crumbs={crumbs} />
        <AdminLoadError
          framed={false}
          title={t('admin.integrations.page.loadError', 'Could not load the installation')}
          message={error || ''}
          action={{
            label: t('admin.integrations.backToIntegrations', 'Back to Integrations'),
            onClick: () => navigate('/admin/integrations')
          }}
        />
      </div>
    );
  }

  const group = integrationGroup(integrationGroupOf(instance));
  const enabled = instance.enabled !== false;
  const unusable = instance.definitionMissing || instance.incompatible;
  const description = pickText(instance.description, lang) || definition?.description || '';
  const tabs = [
    { id: 'overview', label: t('admin.integrations.page.tabs.overview', 'Overview') },
    { id: 'settings', label: t('admin.integrations.page.tabs.settings', 'Settings') },
    ...(hasReleases
      ? [
          {
            id: 'releases',
            label: t('admin.integrations.page.tabs.releases', 'Releases'),
            count: definition.releases.length
          }
        ]
      : [])
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8" data-testid="installation-page">
      <AdminBreadcrumb crumbs={crumbs} />

      <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`shrink-0 p-2.5 rounded-lg ${group.accent}`} aria-hidden="true">
            <Icon name={group.icon} className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 break-words">
              {instance.label}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-0.5">
              {instance.definitionName || instance.definition}
              <span className="mx-1.5 text-gray-400" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-sm">{instance.id}</span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <InstallationStatusPills item={instance} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {instance.perUser && (
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => setShowConnections(true)}
            >
              <Icon name="users" size="sm" />
              {t('admin.integrationCatalog.connections.title', 'Connected users')}
            </button>
          )}
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={runTest}
            disabled={busy || unusable}
          >
            <Icon name="play" size="sm" />
            {t('admin.integrationCatalog.actions.testTitle', 'Test connection')}
          </button>
          {!instance.locked && (
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={requestToggle}
              disabled={busy}
              aria-pressed={enabled}
            >
              <Icon name={enabled ? 'pause' : 'check'} size="sm" />
              {enabled
                ? t('admin.integrationCatalog.status.disable', 'Disable')
                : t('admin.integrationCatalog.status.enable', 'Enable')}
            </button>
          )}
          {!instance.locked && (
            <button
              type="button"
              className={DANGER_BUTTON_CLASS}
              onClick={() => setConfirm('remove')}
              disabled={busy}
            >
              <Icon name="trash" size="sm" />
              {t('admin.integrations.page.remove', 'Remove')}
            </button>
          )}
        </div>
      </div>

      {message && (
        <output
          className={`mb-4 block ${message.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success}`}
        >
          {message.text}
        </output>
      )}
      {instance.incompatible && instance.incompatibleReason && (
        <div className={`mb-4 ${CALLOUT_CLASS.danger}`} data-testid="incompatible-reason">
          {t(
            'admin.integrationCatalog.incompatibleReason',
            'This installation offers no actions: its definition {{reason}}.',
            { reason: instance.incompatibleReason }
          )}
        </div>
      )}
      {instance.definitionMissing && (
        <div className={`mb-4 ${CALLOUT_CLASS.danger}`}>
          {t(
            'admin.integrations.page.definitionMissing',
            'The definition "{{definition}}" of this installation is not loaded: it offers no actions and cannot be edited. Install the definition again from the marketplace, or remove the installation.',
            { definition: instance.definition }
          )}
        </div>
      )}
      {testResult && (
        <div className="mb-6" data-testid="installation-test-results">
          <IntegrationTestResults
            title={t('admin.integrationCatalog.testResultsFor', 'Test results: {{label}}', {
              label: instance.label
            })}
            result={testResult}
          />
        </div>
      )}

      <AdminTabs
        tabs={tabs}
        activeId={tab}
        onChange={setTab}
        ariaLabel={t('admin.integrations.page.tabsLabel', 'Installation')}
      />

      {tab === 'overview' && (
        <div
          role="tabpanel"
          id="tabpanel-overview"
          aria-labelledby="tab-overview"
          className="grid grid-cols-1 lg:grid-cols-3 gap-5"
        >
          <div className="lg:col-span-2 space-y-5">
            <section className={CARD_CLASS} aria-labelledby="installation-facts-title">
              <h2 id="installation-facts-title" className={CARD_TITLE_CLASS}>
                {t('admin.integrations.page.facts', 'Configuration')}
              </h2>
              {facts.length > 0 ? (
                <IntegrationFactList facts={facts} variant="page" />
              ) : (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('admin.integrations.page.noFacts', 'Nothing configured beyond the defaults.')}
                </p>
              )}
              {!unusable && (
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON_CLASS} mt-4`}
                  onClick={() => setTab('settings')}
                >
                  <Icon name="pencil" size="sm" />
                  {t('admin.integrations.page.editSettings', 'Edit settings')}
                </button>
              )}
            </section>

            <section className={CARD_CLASS} aria-labelledby="installation-actions-title">
              <h2 id="installation-actions-title" className={CARD_TITLE_CLASS}>
                {t('admin.integrations.page.actions', 'Actions')}
                <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                  ({(detail.actions || []).length})
                </span>
              </h2>
              {(detail.actions || []).length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {definition?.dynamicActions
                    ? t(
                        'admin.integrations.page.noLiveActions',
                        'The system lists its actions when iHub connects. Test the connection to see them.'
                      )
                    : t(
                        'admin.integrations.page.noActions',
                        'This integration offers no actions to the model; apps use it through their own settings.'
                      )}
                </p>
              ) : (
                <ul
                  className="divide-y divide-gray-200 dark:divide-gray-700"
                  data-testid="installation-actions"
                >
                  {detail.actions.map(action => (
                    <li key={action.name} className="py-2 flex flex-wrap items-start gap-2">
                      <div className="flex-1 min-w-[200px]">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {action.title || action.name}
                        </span>
                        <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                          {action.toolId || action.name}
                        </span>
                        {action.description && (
                          <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                            {action.description}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <SideEffectBadge sideEffect={action.sideEffect} />
                        {action.enabled === false ? (
                          <Pill tone="gray">{t('admin.integrations.page.actionOff', 'Off')}</Pill>
                        ) : (
                          action.available === false && (
                            <Pill tone="yellow" title={action.error || undefined}>
                              {t('admin.integrations.page.actionUnavailable', 'Unavailable')}
                            </Pill>
                          )
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="space-y-5">
            <section className={CARD_CLASS} aria-labelledby="installation-about-title">
              <h2 id="installation-about-title" className={CARD_TITLE_CLASS}>
                {t('admin.integrations.page.about', 'About')}
              </h2>
              {description && (
                <p className="text-sm text-gray-700 dark:text-gray-300">{description}</p>
              )}
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-gray-500 dark:text-gray-400">
                  {t('admin.integrationCatalog.facts.protocol', 'Protocol')}
                </dt>
                <dd className="font-mono text-gray-800 dark:text-gray-200">
                  {instance.protocol || '—'}
                </dd>
                <dt className="text-gray-500 dark:text-gray-400">
                  {t('admin.integrationCatalog.facts.signIn', 'Sign-in')}
                </dt>
                <dd className="text-gray-800 dark:text-gray-200">
                  {t(
                    `admin.integrationCatalog.authModes.short.${instance.auth?.mode || 'none'}`,
                    instance.auth?.mode || 'none'
                  )}
                </dd>
                <dt className="text-gray-500 dark:text-gray-400">
                  {t('admin.integrations.page.groups', 'Groups')}
                </dt>
                <dd className="text-gray-800 dark:text-gray-200">
                  <GrantedGroups
                    grantedTo={
                      groups
                        ? groupsGranting(
                            {
                              id: instance.id,
                              definition: instance.definition,
                              type: definition?.type
                            },
                            groups
                          )
                        : null
                    }
                  />
                </dd>
                {definition?.publisher?.name && (
                  <>
                    <dt className="text-gray-500 dark:text-gray-400">
                      {t('admin.integrationCatalog.facts.publisher', 'Publisher')}
                    </dt>
                    <dd className="text-gray-800 dark:text-gray-200">
                      {definition.publisher.name}
                    </dd>
                  </>
                )}
              </dl>
              {definition?.docsUrl && (
                <a
                  href={definition.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-sm text-indigo-700 dark:text-indigo-300 hover:underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <Icon name="book-open" size="sm" />
                  {t('admin.integrations.page.docs', 'Documentation')}
                  <span className="sr-only">
                    {t('admin.integrations.page.opensInNewTab', '(opens in a new tab)')}
                  </span>
                </a>
              )}
            </section>

            <section className={CARD_CLASS} aria-labelledby="installation-apps-title">
              <h2 id="installation-apps-title" className={CARD_TITLE_CLASS}>
                {t('admin.integrations.page.apps', 'Apps that use it')}
                <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                  ({boundApps.length})
                </span>
              </h2>
              {boundApps.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t(
                    'admin.integrations.page.noApps',
                    'No app binds this installation yet. Bind it in an app’s Integrations section.'
                  )}
                </p>
              ) : (
                <ul className="space-y-1.5 text-sm" data-testid="installation-bound-apps">
                  {boundApps.map(app => (
                    <li key={app.id} className="flex flex-wrap items-baseline gap-x-2">
                      <Link
                        to={`/admin/apps/${encodeURIComponent(app.id)}`}
                        className="text-indigo-700 dark:text-indigo-300 hover:underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        {app.name}
                      </Link>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {bindingViaLabel(app, instance, t)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings">
          <InstallationSettings
            instance={instance}
            definition={definition}
            effective={effective}
            preloaded={preloaded}
            unusable={unusable}
            editorKey={editorKey}
            onSaved={onSaved}
            onCancel={onCancel}
          />
        </div>
      )}

      {tab === 'releases' && hasReleases && (
        <div
          role="tabpanel"
          id="tabpanel-releases"
          aria-labelledby="tab-releases"
          className={CARD_CLASS}
        >
          <IntegrationReleaseNotes
            releases={definition.releases}
            loadFile={path => fetchIntegrationDefinitionFile(definition.id, path)}
            installedVersion={instance.definitionVersion || undefined}
          />
        </div>
      )}

      {showConnections && (
        <IntegrationConnectionsDialog
          instance={instance}
          onClose={() => setShowConnections(false)}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirm)}
        title={
          confirm === 'disable'
            ? t('admin.integrationCatalog.confirmDisable.title', 'Disable integration?')
            : t('admin.integrationCatalog.confirmRemove.title', 'Remove integration?')
        }
        message={
          <>
            <p>
              {confirm === 'disable'
                ? t(
                    'admin.integrationCatalog.confirmDisable.message',
                    'Apps that bind "{{id}}" are hidden from users while it is disabled.',
                    { id: instance.id }
                  )
                : t(
                    'admin.integrationCatalog.confirmRemove.message',
                    'Apps that bind "{{id}}" lose its actions and are hidden from users until the binding is removed. A stored service-account token is deleted with it.',
                    { id: instance.id }
                  )}
            </p>
            {boundApps.length > 0 && (
              <p className="mt-2" data-testid="bound-apps">
                {t('admin.integrationCatalog.boundApps', 'Bound by: {{apps}}', {
                  apps: boundApps.map(app => app.name).join(', ')
                })}
              </p>
            )}
          </>
        }
        confirmLabel={
          confirm === 'disable'
            ? t('admin.integrationCatalog.status.disable', 'Disable')
            : t('common.delete', 'Delete')
        }
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (current === 'disable') void toggle();
          else if (current === 'remove') void remove();
        }}
        onDeny={() => setConfirm(null)}
      />
    </div>
  );
}

/**
 * The content of the Settings tab: the dedicated editor of the installation's
 * definition (`editors/index.js`), else the generic form built from the
 * install fields; a notice instead while the definition is missing or
 * incompatible. A new `editorKey` remounts the editor with the stored values.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation as the detail lists it
 * @param {Object|null} props.definition - its definition, null when missing
 * @param {Object|null} props.effective - the installation with its effective values
 * @param {{ definition: Object, existing: Object }|null} props.preloaded - for the generic form
 * @param {boolean} props.unusable - the definition is missing or incompatible
 * @param {number} props.editorKey
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function InstallationSettings({
  instance,
  definition,
  effective,
  preloaded,
  unusable,
  editorKey,
  onSaved,
  onCancel
}) {
  const { t } = useTranslation();
  if (unusable || !definition) {
    return (
      <div className={CALLOUT_CLASS.warning}>
        {t(
          'admin.integrations.page.notEditable',
          'This installation cannot be edited while its definition is missing or incompatible.'
        )}
      </div>
    );
  }
  if (hasDedicatedEditor(instance.definition)) {
    return (
      <InstallationEditor
        key={editorKey}
        definitionId={instance.definition}
        instance={effective}
        definition={definition}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    );
  }
  return (
    <IntegrationInstallForm
      key={editorKey}
      variant="page"
      definitionId={instance.definition}
      instanceId={instance.id}
      preloaded={preloaded}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

export default AdminInstallationPage;
