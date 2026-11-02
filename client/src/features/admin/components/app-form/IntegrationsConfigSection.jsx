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
import { HELP_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import AppMigrationWarnings from '../integrations/AppMigrationWarnings';
import {
  appMigrationWarnings,
  warningsByBindingKey
} from '../integrations/appMigrationWarningRules';
import IntegrationBindingRow from './IntegrationBindingRow';
import WebSearchSection from './WebSearchSection';
import IAssistantSection from './IAssistantSection';
import { storageBindingRows } from './storageBindingRows';
import { webSearchEnginesOf } from './webSearchEngines';

/** The built-in installation that has its own panel instead of a row. */
const IASSISTANT_INSTANCE_ID = 'iassistant';
const TYPE_PREFIX = 'type:';

/**
 * The groups of the remaining rows, in order. `match` decides by the
 * installation's type, protocol and built-in flag (as `GET …/installed`
 * reports them).
 */
const ROW_GROUPS = [
  { id: 'mcp', match: item => item.protocol === 'mcp' },
  { id: 'a2a', match: item => item.protocol === 'a2a' },
  { id: 'builtIn', match: item => item.builtIn === true },
  { id: 'catalog', match: () => true }
];

/** Whether an installation belongs on a dedicated panel or nowhere in the editor. */
function hasOwnPanel(item) {
  if (item.id === IASSISTANT_INSTANCE_ID) return true;
  // Web search engines are picked in the web search panel; storage providers
  // have their own card (they bring files, no model actions).
  return item.type === 'web-search' || item.type === 'storage';
}

/**
 * One detail for a row from the details of one or more installations: the
 * first one's definition, and every action once (by name), the first
 * installation that offers it winning.
 * @param {Array<Object>} results - `GET …/installed/:id` responses
 * @returns {{ actions: Object[], definition: Object|null }}
 */
export function mergeInstallationDetails(results) {
  if (results.length === 0) return { actions: [], definition: null };
  const actions = new Map();
  for (const result of results) {
    for (const action of result.actions || []) {
      if (!actions.has(action.name)) actions.set(action.name, action);
    }
  }
  return { ...results[0], actions: [...actions.values()] };
}

/** Load one installation, or null when it fails. */
function loadInstallation(instanceId) {
  return fetchInstalledIntegration(instanceId).catch(() => null);
}

/**
 * The detail of one row: the installations it covers, loaded together and
 * merged (see {@link mergeInstallationDetails}).
 * @param {string[]} instanceIds
 */
async function loadRowDetail(instanceIds) {
  const results = await Promise.all(instanceIds.map(loadInstallation));
  return mergeInstallationDetails(results.filter(Boolean));
}

function Card({ title, description, children, testId }) {
  return (
    <div
      className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6"
      data-testid={testId}
    >
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {title}
          </h3>
          {description && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
          )}
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-3">{children}</div>
      </div>
    </div>
  );
}

/**
 * App editor: everything an app takes from installed integrations, grouped
 * the way the admin Integrations page groups them, each integration in one
 * place only.
 *
 * - **Web search** keeps its own panel (`app.websearch`), shown for every
 *   chat app: native search needs no engine. Its engine select lists Auto
 *   and the installed engines (installations of type `web-search`); the
 *   engines never appear as rows.
 * - **iAssistant** keeps its own panel (`app.iassistant`) with the binding of
 *   the `iassistant` installation inside it, shown while iAssistant is
 *   installed or the app already uses it.
 * - **People directories**: "All people directories" (`type:people-directory`)
 *   and each directory.
 * - **Storage providers**: "All storage providers" (`type:storage`), "All …
 *   installations" of a provider with several, and each installation; no
 *   action list (they bring files for the chat's file picker, not actions),
 *   a new binding starts optional. Shown while a storage provider is
 *   installed or the app binds one (`storageBindingRows.js`). Replaces the
 *   former upload switch `upload.cloudStorageUpload`.
 * - **Integrations**: every other installation, grouped into MCP servers,
 *   agents, built-in and catalog integrations (the LDAP browsers are built-in:
 *   they have no type; a browser binding without `actions` binds all three
 *   browse actions); a definition with several installations also gets
 *   "All … installations" (`app.integrations[<definition id>]`).
 *
 * A binding a definition migration changed (an action it named was removed,
 * or a type binding names a renamed action or scope) shows the warning next
 * to its row (`appMigrationWarnings`); a warning about a binding without a
 * row here shows at the top of the Integrations card.
 *
 * @param {Object} props
 * @param {Object} props.app - the app being edited
 * @param {(app: Object) => void} props.onChange - receives the whole changed app
 */
function IntegrationsConfigSection({ app, onChange }) {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState([]);
  // Every installation (also those whose definition is missing), for the migration warnings.
  const [allInstalled, setAllInstalled] = useState([]);
  const [details, setDetails] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const bindings = useMemo(
    () => (app.integrations && typeof app.integrations === 'object' ? app.integrations : {}),
    [app.integrations]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchInstalledIntegrations();
        if (!cancelled) {
          setAllInstalled(res.items || []);
          setInstalled((res.items || []).filter(i => !i.definitionMissing));
        }
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

  const setBinding = (id, binding) => {
    const next = { ...bindings };
    if (binding === null) delete next[id];
    else next[id] = binding;
    onChange({ ...app, integrations: Object.keys(next).length ? next : undefined });
  };

  // Rows of the People directories card: the type row, then each directory.
  const directories = useMemo(
    () => installed.filter(item => item.type === 'people-directory'),
    [installed]
  );
  const directoryRows = useMemo(() => {
    const key = `${TYPE_PREFIX}people-directory`;
    if (directories.length === 0 && !Object.hasOwn(bindings, key)) return [];
    return [
      {
        id: key,
        kind: 'type',
        label: t('admin.apps.edit.integrations.allPeopleDirectories', 'All people directories'),
        definitionName: t(
          'admin.apps.edit.integrations.allOfTypeHelp',
          'Every installation of this kind, including ones installed later ({{count}} now).',
          { count: directories.length }
        ),
        enabled: directories.some(i => i.enabled !== false)
      },
      ...directories.map(item => ({ ...item, kind: 'instance' }))
    ];
  }, [directories, bindings, t]);

  // Definition rows ("All … installations"): definitions with two or more
  // installations, and any definition the app already binds.
  const definitionRows = useMemo(() => {
    const byDefinition = new Map();
    for (const item of installed) {
      if (!item.definition || hasOwnPanel(item)) continue;
      const row = byDefinition.get(item.definition) || {
        id: item.definition,
        name: item.definitionName,
        type: item.type,
        protocol: item.protocol,
        builtIn: item.builtIn,
        instances: []
      };
      row.instances.push(item);
      byDefinition.set(item.definition, row);
    }
    return [...byDefinition.values()]
      .filter(row => row.instances.length > 1 || Object.hasOwn(bindings, row.id))
      .map(row => ({
        id: row.id,
        kind: 'definition',
        type: row.type,
        protocol: row.protocol,
        builtIn: row.builtIn,
        instanceIds: row.instances.map(instance => instance.id),
        label: t('admin.apps.edit.integrations.allInstallations', 'All {{name}} installations', {
          name: row.name || row.id
        }),
        definitionName: t(
          'admin.apps.edit.integrations.allInstallationsHelp',
          'Every installation of this integration, including ones installed later ({{count}} now).',
          { count: row.instances.length }
        ),
        enabled: row.instances.some(i => i.enabled !== false)
      }));
  }, [installed, bindings, t]);

  // Every other installation, by group.
  const groupedRows = useMemo(() => {
    const rest = [
      ...definitionRows.filter(row => row.type !== 'people-directory'),
      ...installed
        .filter(item => !hasOwnPanel(item) && item.type !== 'people-directory')
        .map(item => ({ ...item, kind: 'instance' }))
    ];
    return ROW_GROUPS.map(group => ({
      id: group.id,
      rows: rest.filter(item => ROW_GROUPS.find(g => g.match(item))?.id === group.id)
    })).filter(group => group.rows.length > 0);
  }, [definitionRows, installed]);

  // A definition row of the LDAP directories stays in the directories card.
  const directoryDefinitionRows = definitionRows.filter(row => row.type === 'people-directory');

  // Rows of the Storage providers card: all, all of one provider, each one.
  const storageRows = useMemo(() => {
    const storageRequiredHelp = t(
      'admin.apps.edit.integrations.storageRequiredHelp',
      'Hide the app while this storage provider is disabled or missing. Off: the app stays available and the file picker offers the providers that are there.'
    );
    return storageBindingRows(installed, bindings).map(row => {
      const common = {
        noActions: true,
        newBinding: { required: false },
        requiredHelp: storageRequiredHelp
      };
      if (row.kind === 'type') {
        return {
          ...row,
          ...common,
          label: t('admin.apps.edit.integrations.allStorageProviders', 'All storage providers'),
          definitionName: t(
            'admin.apps.edit.integrations.allOfTypeHelp',
            'Every installation of this kind, including ones installed later ({{count}} now).',
            { count: row.count }
          )
        };
      }
      if (row.kind === 'definition') {
        return {
          ...row,
          ...common,
          label: t('admin.apps.edit.integrations.allInstallations', 'All {{name}} installations', {
            name: row.name
          }),
          definitionName: t(
            'admin.apps.edit.integrations.allInstallationsHelp',
            'Every installation of this integration, including ones installed later ({{count}} now).',
            { count: row.count }
          )
        };
      }
      return { ...row, ...common };
    });
  }, [installed, bindings, t]);
  const storageRowIds = useMemo(() => new Set(storageRows.map(row => row.id)), [storageRows]);

  // Load the actions of every bound installation or definition once bound.
  // A definition row merges the actions of all its installations (an MCP
  // server lists its own tools, so two installations of one definition can
  // differ); one installation that fails to load does not hide the others.
  // Type rows offer no actions.
  useEffect(() => {
    // Storage providers have no actions to load.
    const ids = Object.keys(bindings).filter(
      id => !id.startsWith(TYPE_PREFIX) && !details[id] && !storageRowIds.has(id)
    );
    if (ids.length === 0 || loading) return;
    let cancelled = false;
    void (async () => {
      const loaded = {};
      await Promise.all(
        ids.map(async id => {
          const row = definitionRows.find(entry => entry.id === id);
          loaded[id] = await loadRowDetail(row ? row.instanceIds : [id]);
        })
      );
      if (!cancelled) setDetails(prev => ({ ...prev, ...loaded }));
    })();
    return () => {
      cancelled = true;
    };
  }, [bindings, details, definitionRows, storageRowIds, loading]);

  // Bindings to installations that are gone: the app is hidden from users
  // until they are unbound, so they are listed with a way to do that.
  const staleIds = useMemo(() => {
    if (loading || error) return [];
    const known = new Set([
      ...installed.map(i => i.id),
      ...definitionRows.map(row => row.id),
      ...directoryRows.map(row => row.id),
      ...storageRowIds
    ]);
    return Object.keys(bindings).filter(id => !known.has(id));
  }, [bindings, installed, definitionRows, directoryRows, storageRowIds, loading, error]);

  // The web search engines in Auto's order; null while unknown (not loaded).
  const webSearchEngines = useMemo(
    () => (loading || error ? null : webSearchEnginesOf(installed)),
    [installed, loading, error]
  );
  // What definition migrations left on this app's bindings, by binding key.
  const migrationWarnings = useMemo(
    () => warningsByBindingKey(appMigrationWarnings(allInstalled, app)),
    [allInstalled, app]
  );
  const iAssistantInstallation = installed.find(i => i.id === IASSISTANT_INSTANCE_ID);
  const showIAssistant =
    Boolean(iAssistantInstallation) ||
    app.iassistant?.enabled === true ||
    Object.hasOwn(bindings, IASSISTANT_INSTANCE_ID);

  const notInstalledNotice = name => (
    <output className="block text-sm rounded-md px-3 py-2 bg-yellow-50 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
      {t(
        'admin.apps.edit.integrations.panelNotInstalled',
        '{{name}} is not installed. Install it under Integrations to use these settings.',
        { name }
      )}
    </output>
  );

  const groupTitle = id =>
    ({
      mcp: t('admin.apps.edit.integrations.groups.mcp', 'MCP servers'),
      a2a: t('admin.apps.edit.integrations.groups.a2a', 'Agents'),
      builtIn: t('admin.apps.edit.integrations.groups.builtIn', 'Built-in'),
      catalog: t('admin.apps.edit.integrations.groups.catalog', 'From the catalog')
    })[id];

  const renderRow = item => (
    <IntegrationBindingRow
      key={item.id}
      item={item}
      binding={bindings[item.id]}
      detail={details[item.id]}
      onBindingChange={binding => setBinding(item.id, binding)}
      notice={
        migrationWarnings.has(item.id) ? (
          <AppMigrationWarnings warnings={migrationWarnings.get(item.id)} />
        ) : null
      }
    />
  );

  // Warnings about bindings that have no row of their own here (a web search
  // engine, a binding to an installation that is gone): shown on top.
  const rowIds = new Set(
    [
      ...directoryRows,
      ...directoryDefinitionRows,
      ...storageRows,
      ...groupedRows.flatMap(group => group.rows)
    ].map(row => row.id)
  );
  if (iAssistantInstallation) rowIds.add(IASSISTANT_INSTANCE_ID);
  const unplacedWarnings = [...migrationWarnings.entries()]
    .filter(([key]) => !rowIds.has(key))
    .flatMap(([, warnings]) => warnings);

  return (
    <>
      {!loading && <WebSearchSection app={app} onChange={onChange} engines={webSearchEngines} />}

      {!loading && showIAssistant && (
        <IAssistantSection
          app={app}
          onChange={onChange}
          notice={
            iAssistantInstallation
              ? null
              : notInstalledNotice(t('admin.apps.edit.iassistant', 'iAssistant'))
          }
        >
          {iAssistantInstallation &&
            renderRow({
              ...iAssistantInstallation,
              kind: 'instance',
              label: t('admin.apps.edit.integrations.iassistantBinding', 'Use in this app')
            })}
        </IAssistantSection>
      )}

      {(directoryRows.length > 0 || directoryDefinitionRows.length > 0) && (
        <Card
          testId="app-integrations-people-directories"
          title={t('admin.apps.edit.integrations.peopleDirectoriesTitle', 'People directories')}
          description={t(
            'admin.apps.edit.integrations.peopleDirectoriesDesc',
            'Let the model look people up in the directories: all of them, or single ones.'
          )}
        >
          {directoryRows.slice(0, 1).map(renderRow)}
          {directoryDefinitionRows.map(renderRow)}
          {directoryRows.slice(1).map(renderRow)}
        </Card>
      )}

      {storageRows.length > 0 && (
        <Card
          testId="app-integrations-storage-providers"
          title={t('admin.apps.edit.integrations.storageProvidersTitle', 'Storage providers')}
          description={t(
            'admin.apps.edit.integrations.storageProvidersDesc',
            'Let users pick files for the chat from the storage providers: all of them, or single ones. Users see the ones their groups grant; picked files follow the upload settings.'
          )}
        >
          {storageRows.map(renderRow)}
        </Card>
      )}

      <Card
        testId="app-integrations"
        title={t('admin.apps.edit.integrations.title', 'Integrations')}
        description={t(
          'admin.apps.edit.integrations.desc',
          'Bind installed integrations. Narrow them to some actions, and set the scope users start with.'
        )}
      >
        {loading && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading…')}
          </p>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <AppMigrationWarnings warnings={unplacedWarnings} />
        {!loading && !error && groupedRows.length === 0 && staleIds.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.integrations.none', 'No integration is installed yet.')}{' '}
            <Link
              to="/admin/integrations?tab=catalog"
              className="text-blue-700 dark:text-blue-300 hover:underline"
            >
              {t('admin.apps.edit.integrations.openCatalog', 'Open the catalog')}
            </Link>
          </p>
        )}
        {groupedRows.map(group => (
          <section key={group.id} aria-labelledby={`app-integrations-group-${group.id}`}>
            <h4
              id={`app-integrations-group-${group.id}`}
              className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2"
            >
              {groupTitle(group.id)}
            </h4>
            <div className="space-y-3">{group.rows.map(renderRow)}</div>
          </section>
        ))}
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
                {bindings[id]?.required === false
                  ? t(
                      'admin.apps.edit.integrations.notInstalledOptionalHelp',
                      'This installation no longer exists. The app stays available without it; unbind it to tidy up.'
                    )
                  : t(
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
      </Card>
    </>
  );
}

export default IntegrationsConfigSection;
