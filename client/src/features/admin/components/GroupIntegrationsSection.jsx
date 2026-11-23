// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchInstalledIntegrations } from '../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import {
  ALL_INTEGRATIONS,
  grantingKey,
  inheritedGrants,
  labelOf,
  sectionsOf,
  toggleKey,
  typeKey
} from '../utils/groupIntegrationAccess';
import { INPUT_CLASS } from './formStyles';

/** The i18n key and English default of each section title. */
const SECTION_TITLES = {
  peopleDirectories: ['admin.groups.integrations.sections.peopleDirectories', 'People directories'],
  webSearch: ['admin.groups.integrations.sections.webSearch', 'Web search'],
  storage: ['admin.groups.integrations.sections.storage', 'Storage providers'],
  mcp: ['admin.groups.integrations.sections.mcp', 'MCP servers'],
  a2a: ['admin.groups.integrations.sections.a2a', 'Agents'],
  builtIn: ['admin.groups.integrations.sections.builtIn', 'Built-in'],
  catalog: ['admin.groups.integrations.sections.catalog', 'From the catalog']
};

/** The i18n key and English default of each type's "All …" entry. */
const TYPE_ROW_LABELS = {
  'people-directory': ['admin.groups.integrations.allPeopleDirectories', 'All people directories'],
  'web-search': ['admin.groups.integrations.allWebSearch', 'All web search engines'],
  storage: ['admin.groups.integrations.allStorage', 'All storage providers']
};

const CHIP_CLASS = {
  all: 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300',
  own: 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300',
  inherited: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
};

/**
 * Group editor: which installed integrations members of the group may use
 * (`permissions.integrations`, #3093).
 *
 * Shows only what the group has been given, as chips, and an "Add integration"
 * list of what it has not. Nothing is listed for a group without integrations;
 * "All integrations" (`*`, the ones installed later included) is one chip and
 * hides the individual entries and the list. What the group inherits ("via
 * users") is shown read-only. Entries are installation ids, definition ids
 * (every installation of it) or type keys (`type:web-search`).
 *
 * @param {Object} props
 * @param {Object} props.group - The group being edited (`permissions.integrations`, `inherits`)
 * @param {Object<string, Object>} [props.groups] - Every group (`GET /api/admin/groups` → `groups`), for inheritance
 * @param {(keys: string[]) => void} props.onChange - Receives the group's new list
 */
function GroupIntegrationsSection({ group, groups = {}, onChange }) {
  const { t, i18n } = useTranslation();
  const addId = useId();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchInstalledIntegrations();
        if (!cancelled) setItems(res.items || []);
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

  const keys = useMemo(
    () => (Array.isArray(group?.permissions?.integrations) ? group.permissions.integrations : []),
    [group?.permissions?.integrations]
  );
  const inherited = useMemo(
    () => inheritedGrants(group?.id, groups, group?.inherits),
    [group?.id, group?.inherits, groups]
  );
  const sections = useMemo(() => sectionsOf(items), [items]);
  const language = i18n?.language || 'en';

  const grantsAll = keys.includes(ALL_INTEGRATIONS);
  const inheritsAll = inherited.has(ALL_INTEGRATIONS);

  /** A readable name for a key; an entry the list does not know shows as it is stored. */
  const labelOfKey = useMemo(() => {
    const labels = new Map([
      [ALL_INTEGRATIONS, t('admin.groups.integrations.all', 'All integrations')]
    ]);
    for (const section of sections) {
      if (section.type && TYPE_ROW_LABELS[section.type]) {
        labels.set(typeKey(section.type), t(...TYPE_ROW_LABELS[section.type]));
      }
      for (const definition of section.definitions) {
        labels.set(
          definition.id,
          t('admin.groups.integrations.allInstallations', 'All {{name}} installations', {
            name: definition.name
          })
        );
      }
      for (const item of section.items) labels.set(item.id, labelOf(item, language));
    }
    return key => labels.get(key) || key;
  }, [sections, t, language]);

  /** The options of the "Add integration" list: what no key of the group or its parents covers. */
  const addGroups = useMemo(() => {
    if (grantsAll || inheritsAll) return [];
    const covered = new Set([...keys, ...inherited.keys()]);
    const groupsOut = [];
    for (const section of sections) {
      const options = [];
      if (section.type && !covered.has(typeKey(section.type))) {
        options.push({
          key: typeKey(section.type),
          label: t(...TYPE_ROW_LABELS[section.type])
        });
      }
      for (const definition of section.definitions) {
        if (!covered.has(definition.id)) {
          options.push({ key: definition.id, label: labelOfKey(definition.id) });
        }
      }
      for (const item of section.items) {
        if (grantingKey(item, covered)) continue;
        const name = labelOf(item, language);
        options.push({
          key: item.id,
          label:
            item.enabled === false
              ? `${name} (${t('admin.groups.integrations.disabled', 'disabled')})`
              : name
        });
      }
      if (options.length > 0) {
        groupsOut.push({ id: section.id, options });
      }
    }
    return groupsOut;
  }, [grantsAll, inheritsAll, keys, inherited, sections, t, language, labelOfKey]);

  const add = key => {
    if (key) onChange(toggleKey(keys, key, true));
  };
  const remove = key => onChange(toggleKey(keys, key, false));

  // "All integrations" makes every other own entry redundant: show it alone.
  const shownKeys = grantsAll ? [ALL_INTEGRATIONS] : keys;
  const inheritedEntries = [...inherited.entries()];
  const nothing = shownKeys.length === 0 && inheritedEntries.length === 0;
  const canAdd = !grantsAll && !inheritsAll;

  return (
    <div className="space-y-3" data-testid="group-integrations">
      <div>
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('admin.groups.integrations.title', 'Integrations')}
        </span>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.groups.integrations.help',
            'Which installed integrations members may use. An app that binds an integration offers it only to members of a group that grants it. Groups that inherit this one get the same.'
          )}
        </p>
      </div>

      <div className="min-h-8" data-testid="group-integrations-selected">
        {nothing ? (
          <p className="text-sm italic text-gray-500 dark:text-gray-400">
            {t('admin.groups.integrations.none', 'Members of this group may use no integration.')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {shownKeys.map(key => (
              <li
                key={key}
                className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                  key === ALL_INTEGRATIONS ? CHIP_CLASS.all : CHIP_CLASS.own
                }`}
              >
                {labelOfKey(key)}
                <button
                  type="button"
                  onClick={() => remove(key)}
                  aria-label={t('admin.groups.integrations.remove', 'Remove {{key}}', {
                    key: labelOfKey(key)
                  })}
                  className="ml-2 text-current hover:text-red-600 dark:hover:text-red-400"
                >
                  <Icon name="x" size="sm" />
                </button>
              </li>
            ))}
            {inheritedEntries.map(([key, from]) => (
              <li
                key={`inherited-${key}`}
                data-testid="group-integrations-inherited"
                className={`inline-flex items-center px-3 py-1 rounded-full text-sm ${CHIP_CLASS.inherited}`}
                title={t(
                  'admin.groups.integrations.inheritedHelp',
                  'Granted by a group this one inherits. Change it there.'
                )}
              >
                {labelOfKey(key)}
                <span className="ml-2 text-xs italic">
                  {t('admin.groups.integrations.via', 'via {{groups}}', {
                    groups: from.join(', ')
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {loading && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('admin.groups.integrations.loading', 'Loading integrations…')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t(
            'admin.groups.integrations.loadError',
            'Could not load the installed integrations: {{error}}',
            { error }
          )}
        </p>
      )}

      {!loading && canAdd && (
        <div>
          <label htmlFor={addId} className="sr-only">
            {t('admin.groups.integrations.addLabel', 'Add integration')}
          </label>
          <select
            id={addId}
            value=""
            onChange={event => add(event.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">
              {addGroups.length > 0 || error
                ? t('admin.groups.integrations.addPlaceholder', 'Add an integration…')
                : t(
                    'admin.groups.integrations.nothingToAdd',
                    'Everything installed has been added.'
                  )}
            </option>
            {addGroups.map(section => {
              const [titleKey, titleDefault] = SECTION_TITLES[section.id];
              return (
                <optgroup key={section.id} label={t(titleKey, titleDefault)}>
                  {section.options.map(option => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            {/* Last, not first: a stray arrow key on the closed list must not grant everything. */}
            <option value={ALL_INTEGRATIONS}>
              {t('admin.groups.integrations.all', 'All integrations')}
            </option>
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.groups.integrations.allHelp',
              '"All integrations" covers every installed integration, including ones installed later.'
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export default GroupIntegrationsSection;
