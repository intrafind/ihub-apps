// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
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
  typeKey,
  unlistedKeys
} from '../utils/groupIntegrationAccess';

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

/** The i18n key and English default of each type's "All …" row. */
const TYPE_ROW_LABELS = {
  'people-directory': ['admin.groups.integrations.allPeopleDirectories', 'All people directories'],
  'web-search': ['admin.groups.integrations.allWebSearch', 'All web search engines'],
  storage: ['admin.groups.integrations.allStorage', 'All storage providers']
};

/**
 * One row: a checkbox for a key. A row covered by a broader key (the group's
 * own or an inherited one) shows ticked and cannot be unticked here; the note
 * says where the grant comes from ("via users", "with All integrations").
 */
function GrantRow({ id, label, detail, ownChecked, coverNote, onToggle }) {
  const covered = Boolean(coverNote);
  const noteId = covered ? `${id}-note` : undefined;
  return (
    <div className="flex items-start gap-2 py-1">
      <input
        id={id}
        type="checkbox"
        checked={ownChecked || covered}
        disabled={covered && !ownChecked}
        onChange={event => onToggle(event.target.checked)}
        aria-describedby={noteId}
        className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded-sm disabled:opacity-60"
      />
      <label htmlFor={id} className="text-sm text-gray-900 dark:text-gray-100">
        <span className={covered && !ownChecked ? 'text-gray-600 dark:text-gray-400' : ''}>
          {label}
        </span>
        {detail && <span className="block text-xs text-gray-500 dark:text-gray-400">{detail}</span>}
        {covered && (
          <span id={noteId} className="block text-xs italic text-gray-500 dark:text-gray-400">
            {coverNote}
          </span>
        )}
      </label>
    </div>
  );
}

/**
 * Group editor: which installed integrations members of the group may use
 * (`permissions.integrations`, #3093). Offers `*` (every integration, the ones
 * installed later included), the installations grouped like the admin
 * Integrations page, an "All …" row per integration type
 * (`type:people-directory`, `type:web-search`, `type:storage`) and per
 * definition with several installations, and shows what the group inherits
 * read-only ("via users").
 *
 * @param {Object} props
 * @param {Object} props.group - The group being edited (`permissions.integrations`, `inherits`)
 * @param {Object<string, Object>} [props.groups] - Every group (`GET /api/admin/groups` → `groups`), for inheritance
 * @param {(keys: string[]) => void} props.onChange - Receives the group's new list
 */
function GroupIntegrationsSection({ group, groups = {}, onChange }) {
  const { t, i18n } = useTranslation();
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
  const own = useMemo(() => new Set(keys), [keys]);
  const inherited = useMemo(
    () => inheritedGrants(group?.id, groups, group?.inherits),
    [group?.id, group?.inherits, groups]
  );
  const inheritedKeys = useMemo(() => new Set(inherited.keys()), [inherited]);
  const sections = useMemo(() => sectionsOf(items), [items]);
  const unlisted = useMemo(() => unlistedKeys(keys, sections), [keys, sections]);
  const language = i18n?.language || 'en';

  /** A readable name for a key, for the "with …" notes. */
  const keyLabels = useMemo(() => {
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
    return labels;
  }, [sections, t, language]);

  const setKey = (key, on) => onChange(toggleKey(keys, key, on));

  /**
   * The note of a row a broader key covers, or null: an inherited grant wins
   * (it cannot be changed here), then a broader key of the group's own.
   * @param {string|null} inheritedKey
   * @param {string|null} ownBroaderKey
   */
  const coverNoteOf = (inheritedKey, ownBroaderKey) => {
    if (inheritedKey) {
      return t('admin.groups.integrations.via', 'via {{groups}}', {
        groups: (inherited.get(inheritedKey) || []).join(', ')
      });
    }
    if (ownBroaderKey) {
      return t('admin.groups.integrations.with', 'with {{name}}', {
        name: keyLabels.get(ownBroaderKey) || ownBroaderKey
      });
    }
    return null;
  };

  /** Inherited or own broader key over a type or definition row (only `*` is broader). */
  const inheritedCover = key => {
    if (inheritedKeys.has(key)) return key;
    return inheritedKeys.has(ALL_INTEGRATIONS) ? ALL_INTEGRATIONS : null;
  };
  const broadRowNote = key =>
    coverNoteOf(
      inheritedCover(key),
      own.has(ALL_INTEGRATIONS) && key !== ALL_INTEGRATIONS ? ALL_INTEGRATIONS : null
    );

  const itemNote = item => {
    const ownWithoutItself = new Set([...own].filter(key => key !== item.id));
    return coverNoteOf(grantingKey(item, inheritedKeys), grantingKey(item, ownWithoutItself));
  };

  const rowId = key => `group-integration-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const nothing = keys.length === 0 && inherited.size === 0;

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
        {inherited.size > 0 && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.groups.integrations.inheritedHelp',
              'Ticked and greyed out: granted by a group this one inherits. Change it there.'
            )}
          </p>
        )}
      </div>

      <GrantRow
        id={rowId('all')}
        label={t('admin.groups.integrations.all', 'All integrations')}
        detail={t(
          'admin.groups.integrations.allHelp',
          'Every installed integration, including ones installed later.'
        )}
        ownChecked={own.has(ALL_INTEGRATIONS)}
        coverNote={broadRowNote(ALL_INTEGRATIONS)}
        onToggle={on => setKey(ALL_INTEGRATIONS, on)}
      />

      {nothing && (
        <p className="text-sm italic text-gray-500 dark:text-gray-400">
          {t('admin.groups.integrations.none', 'Members of this group may use no integration.')}
        </p>
      )}

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

      {!loading &&
        !error &&
        sections.map(section => {
          const [titleKey, titleDefault] = SECTION_TITLES[section.id];
          return (
            <fieldset
              key={section.id}
              className="rounded-md border border-gray-200 dark:border-gray-700 px-3 pb-2 pt-1"
              data-testid={`group-integrations-${section.id}`}
            >
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                {t(titleKey, titleDefault)}
              </legend>
              {section.type && TYPE_ROW_LABELS[section.type] && (
                <GrantRow
                  id={rowId(typeKey(section.type))}
                  label={t(...TYPE_ROW_LABELS[section.type])}
                  detail={t(
                    'admin.groups.integrations.allOfTypeHelp',
                    'Every installation of this kind, including ones installed later ({{count}} now).',
                    { count: section.items.length }
                  )}
                  ownChecked={own.has(typeKey(section.type))}
                  coverNote={broadRowNote(typeKey(section.type))}
                  onToggle={on => setKey(typeKey(section.type), on)}
                />
              )}
              {section.definitions.map(definition => (
                <GrantRow
                  key={definition.id}
                  id={rowId(definition.id)}
                  label={keyLabels.get(definition.id)}
                  detail={t(
                    'admin.groups.integrations.allInstallationsHelp',
                    'Every installation of this integration, including ones installed later ({{count}} now).',
                    { count: definition.count }
                  )}
                  ownChecked={own.has(definition.id)}
                  coverNote={broadRowNote(definition.id)}
                  onToggle={on => setKey(definition.id, on)}
                />
              ))}
              {section.items.map(item => (
                <GrantRow
                  key={item.id}
                  id={rowId(item.id)}
                  label={labelOf(item, language)}
                  detail={
                    item.enabled === false
                      ? `${item.id} · ${t('admin.groups.integrations.disabled', 'disabled')}`
                      : item.id
                  }
                  ownChecked={own.has(item.id)}
                  coverNote={itemNote(item)}
                  onToggle={on => setKey(item.id, on)}
                />
              ))}
              {section.items.length === 0 && (
                <p className="py-1 text-xs italic text-gray-500 dark:text-gray-400">
                  {t('admin.groups.integrations.noneInstalled', 'Nothing installed yet.')}
                </p>
              )}
            </fieldset>
          );
        })}

      {unlisted.length > 0 && (
        <div data-testid="group-integrations-other">
          <span className="block text-xs font-semibold text-gray-600 dark:text-gray-400">
            {t('admin.groups.integrations.other', 'Other entries')}
          </span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.groups.integrations.otherHelp',
              'Entries the list above does not show: definition ids, or installations that no longer exist.'
            )}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {unlisted.map(key => (
              <span
                key={key}
                className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/50 px-3 py-1 text-sm font-medium text-blue-800 dark:text-blue-300"
              >
                {key}
                <button
                  type="button"
                  onClick={() => setKey(key, false)}
                  aria-label={t('admin.groups.integrations.remove', 'Remove {{key}}', { key })}
                  className="ml-2 text-current hover:text-red-600 dark:hover:text-red-400"
                >
                  <Icon name="x" size="sm" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default GroupIntegrationsSection;
