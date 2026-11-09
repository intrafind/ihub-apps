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
import TypeBindingCard from './TypeBindingCard';
import WebSearchSection from './WebSearchSection';
import IAssistantSection from './IAssistantSection';
import IFinderSection from './IFinderSection';
import { STORAGE_TYPE_KEY, storageBindingRows } from './storageBindingRows';
import { webSearchEnginesOf } from './webSearchEngines';

/** The built-in installations that have their own panel instead of a row. */
const IASSISTANT_INSTANCE_ID = 'iassistant';
const IFINDER_INSTANCE_ID = 'ifinder';
const TYPE_PREFIX = 'type:';
const PEOPLE_DIRECTORY_TYPE_KEY = `${TYPE_PREFIX}people-directory`;

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

/** Whether an installation is switched on (absent `enabled` means on). */
const isEnabled = item => item.enabled !== false;

/** Whether an installation belongs on a dedicated panel or nowhere in the editor. */
function hasOwnPanel(item) {
  if (item.id === IASSISTANT_INSTANCE_ID || item.id === IFINDER_INSTANCE_ID) return true;
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
 * - **iAssistant** keeps its own panel (`app.iassistant`), shown while
 *   iAssistant is installed or the app already uses it. Its switch binds the
 *   `iassistant` installation (and keeps `app.iassistant.enabled` in step);
 *   the binding's Required and scope settings sit inside the panel.
 * - **iFinder** has its own panel too (`IFinderSection`): its switch binds the
 *   `ifinder` installation, with the actions and the search profile settings
 *   (start profile, whether users may switch it) inside.
 * - **People directories** and **Storage providers** are type cards
 *   (`TypeBindingCard`): a switch, then "All …" (`type:people-directory`,
 *   `type:storage`, with its Required setting) or "Only selected …", then the
 *   rows: "All … installations" of a definition with several, and each
 *   installation. Storage providers have no action list (they bring files for
 *   the chat's file picker, not actions) and a new binding starts optional;
 *   their card shows while a storage provider is installed or the app binds
 *   one (`storageBindingRows.js`).
 * - **Integrations**: every other installation, grouped into MCP servers,
 *   agents, built-in and catalog integrations (the LDAP browsers are built-in:
 *   they have no type; a browser binding without `actions` binds all three
 *   browse actions); a definition with several installations also gets
 *   "All … installations" (`app.integrations[<definition id>]`).
 *
 * A disabled installation is offered nowhere (no row, no engine, no
 * iAssistant panel, not counted in "… now") unless the app binds it by its
 * own id; a note in the Integrations card says how many are left out. A
 * definition or type binding still covers the disabled installations once
 * they are enabled.
 *
 * A binding a definition migration changed (an action it named was removed,
 * or a type binding names a renamed action or scope) shows the warning next
 * to its row (`appMigrationWarnings`); a warning about a binding without a
 * row here shows at the top of the Integrations card.
 *
 * @param {Object} props
 * @param {Object} props.app - the app being edited
 * @param {(app: Object) => void} props.onChange - receives the whole changed app
 * @param {boolean} [props.toolSearchEnabled] - the platform's tool search feature is on:
 *   the rows offer "Always loaded"
 */
function IntegrationsConfigSection({ app, onChange, toolSearchEnabled = false }) {
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

  /** The integrations with `patch` applied (null removes a key), or undefined when empty. */
  const patchedBindings = patch => {
    const next = { ...bindings };
    for (const [id, binding] of Object.entries(patch)) {
      if (binding === null) delete next[id];
      else next[id] = binding;
    }
    return Object.keys(next).length ? next : undefined;
  };
  const setBindings = patch => onChange({ ...app, integrations: patchedBindings(patch) });
  const setBinding = (id, binding) => setBindings({ [id]: binding });

  // The installations the editor offers: the enabled ones, and a disabled one
  // only while the app binds it by its id (so it can be unbound).
  const shown = useMemo(
    () => installed.filter(item => isEnabled(item) || Object.hasOwn(bindings, item.id)),
    [installed, bindings]
  );
  const hiddenCount = installed.length - shown.length;

  // The installations of the People directories card (its type binding is the card's switch).
  const directories = useMemo(
    () => shown.filter(item => item.type === 'people-directory'),
    [shown]
  );
  const enabledDirectoryCount = installed.filter(
    item => item.type === 'people-directory' && isEnabled(item)
  ).length;

  // Definition rows ("All … installations"): definitions with two or more
  // enabled installations, and any definition the app already binds. The
  // actions come from every installation of the definition.
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
      .map(row => ({ ...row, enabledCount: row.instances.filter(isEnabled).length }))
      .filter(row => row.enabledCount > 1 || Object.hasOwn(bindings, row.id))
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
          { count: row.enabledCount }
        ),
        enabled: row.enabledCount > 0
      }));
  }, [installed, bindings, t]);

  // Every other installation, by group.
  const groupedRows = useMemo(() => {
    const rest = [
      ...definitionRows.filter(row => row.type !== 'people-directory'),
      ...shown
        .filter(item => !hasOwnPanel(item) && item.type !== 'people-directory')
        .map(item => ({ ...item, kind: 'instance' }))
    ];
    return ROW_GROUPS.map(group => ({
      id: group.id,
      rows: rest.filter(item => ROW_GROUPS.find(g => g.match(item))?.id === group.id)
    })).filter(group => group.rows.length > 0);
  }, [definitionRows, shown]);

  // The rows of the People directories card: "All … installations" of a
  // directory definition with several, then each directory.
  const directoryRows = useMemo(
    () => [
      ...definitionRows.filter(row => row.type === 'people-directory'),
      ...directories.map(item => ({ ...item, kind: 'instance' }))
    ],
    [definitionRows, directories]
  );
  const showDirectories =
    directoryRows.length > 0 || Object.hasOwn(bindings, PEOPLE_DIRECTORY_TYPE_KEY);

  // Rows of the Storage providers card: all (the card's switch), all of one
  // provider, each one.
  const storageAllRows = useMemo(() => {
    const storageRequiredHelp = t(
      'admin.apps.edit.integrations.storageRequiredHelp',
      'Hide the app while this storage provider is disabled or missing. Off: the app stays available and the file picker offers the providers that are there.'
    );
    return storageBindingRows(shown, bindings).map(row => {
      const common = {
        noActions: true,
        newBinding: { required: false },
        requiredHelp: storageRequiredHelp
      };
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
  }, [shown, bindings, t]);
  const storageTypeRow = storageAllRows.find(row => row.kind === 'type');
  const storageRows = storageAllRows.filter(row => row.kind !== 'type');
  const storageRowIds = useMemo(() => new Set(storageAllRows.map(row => row.id)), [storageAllRows]);
  const storageRequiredHelp = storageTypeRow?.requiredHelp;

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

  const iAssistantInstallation = installed.find(i => i.id === IASSISTANT_INSTANCE_ID);
  const showIAssistant =
    Boolean(iAssistantInstallation && isEnabled(iAssistantInstallation)) ||
    app.iassistant?.enabled === true ||
    Object.hasOwn(bindings, IASSISTANT_INSTANCE_ID);
  const iAssistantBinding = bindings[IASSISTANT_INSTANCE_ID];
  const iAssistantOn = Boolean(iAssistantBinding) || app.iassistant?.enabled === true;
  // The switch is the binding; `app.iassistant.enabled` follows it.
  const setIAssistantEnabled = on => {
    const binding = on && iAssistantInstallation ? { ...iAssistantBinding } : null;
    onChange({
      ...app,
      iassistant: { ...app.iassistant, enabled: on },
      integrations: patchedBindings({ [IASSISTANT_INSTANCE_ID]: binding })
    });
  };

  const iFinderInstallation = installed.find(i => i.id === IFINDER_INSTANCE_ID);
  const iFinderBinding = bindings[IFINDER_INSTANCE_ID];
  const showIFinder =
    Boolean(iFinderInstallation && isEnabled(iFinderInstallation)) ||
    Object.hasOwn(bindings, IFINDER_INSTANCE_ID);

  // Bindings to installations that are gone: the app is hidden from users
  // until they are unbound, so they are listed with a way to do that.
  const staleIds = useMemo(() => {
    if (loading || error) return [];
    // The server also honours a binding by definition id or by `type:<type>`
    // while a matching installation exists, including the ones shown in their
    // own panels (web search, storage) rather than as rows here.
    const known = new Set([
      ...installed.map(i => i.id),
      ...installed.map(i => i.definition).filter(Boolean),
      ...installed.filter(i => i.type).map(i => `${TYPE_PREFIX}${i.type}`),
      ...definitionRows.map(row => row.id),
      // Their cards show while the app binds them, installed or not.
      PEOPLE_DIRECTORY_TYPE_KEY,
      ...storageRowIds
    ]);
    return Object.keys(bindings).filter(id => !known.has(id));
  }, [bindings, installed, definitionRows, storageRowIds, loading, error]);

  // The web search engines in Auto's order; null while unknown (not loaded).
  const webSearchEngines = useMemo(
    () =>
      loading || error
        ? null
        : webSearchEnginesOf(installed).filter(
            engine => isEnabled(engine) || engine.id === app.websearch?.provider
          ),
    [installed, loading, error, app.websearch?.provider]
  );
  // What definition migrations left on this app's bindings, by binding key.
  const migrationWarnings = useMemo(
    () => warningsByBindingKey(appMigrationWarnings(allInstalled, app)),
    [allInstalled, app]
  );

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
      toolSearchEnabled={toolSearchEnabled}
      notice={
        migrationWarnings.has(item.id) ? (
          <AppMigrationWarnings warnings={migrationWarnings.get(item.id)} />
        ) : null
      }
    />
  );

  // The warnings a definition migration left on a binding shown by a panel.
  const typeNotice = key =>
    migrationWarnings.has(key) ? (
      <AppMigrationWarnings warnings={migrationWarnings.get(key)} />
    ) : null;

  // Warnings about bindings that have no row of their own here (a web search
  // engine, a binding to an installation that is gone): shown on top.
  const rowIds = new Set(
    [...directoryRows, ...storageAllRows, ...groupedRows.flatMap(group => group.rows)].map(
      row => row.id
    )
  );
  if (showDirectories) rowIds.add(PEOPLE_DIRECTORY_TYPE_KEY);
  if (showIAssistant) rowIds.add(IASSISTANT_INSTANCE_ID);
  if (showIFinder) rowIds.add(IFINDER_INSTANCE_ID);
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
          enabled={iAssistantOn}
          onEnabledChange={setIAssistantEnabled}
          notice={
            <>
              {!iAssistantInstallation &&
                notInstalledNotice(t('admin.apps.edit.iassistant', 'iAssistant'))}
              {typeNotice(IASSISTANT_INSTANCE_ID)}
            </>
          }
          binding={iAssistantBinding}
          onBindingChange={
            iAssistantInstallation ? binding => setBinding(IASSISTANT_INSTANCE_ID, binding) : null
          }
          bindingActions={details[IASSISTANT_INSTANCE_ID]?.actions}
        />
      )}

      {!loading && showIFinder && (
        <IFinderSection
          binding={iFinderBinding}
          onBindingChange={binding => setBinding(IFINDER_INSTANCE_ID, binding)}
          detail={details[IFINDER_INSTANCE_ID]}
          installed={Boolean(iFinderInstallation)}
          notice={
            <>
              {!iFinderInstallation && notInstalledNotice(t('admin.apps.edit.ifinder', 'iFinder'))}
              {typeNotice(IFINDER_INSTANCE_ID)}
            </>
          }
        />
      )}

      {!loading && showDirectories && (
        <TypeBindingCard
          testId="app-integrations-people-directories"
          title={t('admin.apps.edit.integrations.peopleDirectoriesTitle', 'People directories')}
          description={t(
            'admin.apps.edit.integrations.peopleDirectoriesDesc',
            'Let the model look people up in the directories: all of them, or single ones.'
          )}
          enableLabel={t(
            'admin.apps.edit.integrations.enablePeopleDirectories',
            'Enable people directories'
          )}
          allLabel={t(
            'admin.apps.edit.integrations.allPeopleDirectories',
            'All people directories'
          )}
          allHelp={t(
            'admin.apps.edit.integrations.allOfTypeHelp',
            'Every installation of this kind, including ones installed later ({{count}} now).',
            { count: enabledDirectoryCount }
          )}
          someLabel={t(
            'admin.apps.edit.integrations.selectedPeopleDirectories',
            'Only selected directories'
          )}
          typeKey={PEOPLE_DIRECTORY_TYPE_KEY}
          bindings={bindings}
          rows={directoryRows}
          renderRow={renderRow}
          onBindingsChange={setBindings}
          notice={typeNotice(PEOPLE_DIRECTORY_TYPE_KEY)}
          toolSearchEnabled={toolSearchEnabled}
        />
      )}

      {!loading && storageTypeRow && (
        <TypeBindingCard
          testId="app-integrations-storage-providers"
          title={t('admin.apps.edit.integrations.storageProvidersTitle', 'Storage providers')}
          description={t(
            'admin.apps.edit.integrations.storageProvidersDesc',
            'Let users pick files for the chat from the storage providers: all of them, or single ones. Users see the ones their groups grant; picked files follow the upload settings.'
          )}
          enableLabel={t(
            'admin.apps.edit.integrations.enableStorageProviders',
            'Enable storage providers'
          )}
          allLabel={t('admin.apps.edit.integrations.allStorageProviders', 'All storage providers')}
          allHelp={t(
            'admin.apps.edit.integrations.allOfTypeHelp',
            'Every installation of this kind, including ones installed later ({{count}} now).',
            {
              count: installed.filter(item => item.type === 'storage' && isEnabled(item)).length
            }
          )}
          someLabel={t(
            'admin.apps.edit.integrations.selectedStorageProviders',
            'Only selected storage providers'
          )}
          typeKey={STORAGE_TYPE_KEY}
          bindings={bindings}
          rows={storageRows}
          renderRow={renderRow}
          onBindingsChange={setBindings}
          newBinding={storageTypeRow.newBinding}
          requiredHelp={storageRequiredHelp}
          notice={typeNotice(STORAGE_TYPE_KEY)}
        />
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
        {!loading &&
          !error &&
          groupedRows.length === 0 &&
          staleIds.length === 0 &&
          hiddenCount === 0 && (
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
        {!loading && !error && hiddenCount > 0 && (
          <p
            className="text-sm text-gray-500 dark:text-gray-400"
            data-testid="app-integrations-hidden"
          >
            {t(
              'admin.apps.edit.integrations.disabledHidden',
              'Disabled integrations are not offered here ({{count}}). Enable one under Integrations to bind it to this app.',
              { count: hiddenCount }
            )}{' '}
            <Link
              to="/admin/integrations"
              className="text-blue-700 dark:text-blue-300 hover:underline"
            >
              {t('admin.apps.edit.integrations.openIntegrations', 'Open Integrations')}
            </Link>
          </p>
        )}
      </Card>
    </>
  );
}

export default IntegrationsConfigSection;
