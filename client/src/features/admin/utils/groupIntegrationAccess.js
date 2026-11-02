// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pure helpers of the group editor's Integrations section (#3093): which
 * installed integrations a group's `permissions.integrations` grants, how the
 * installations are grouped, and what the group inherits.
 *
 * A key grants an installation when it is `*`, the installation id, its
 * definition id or its type key (`type:people-directory`) — the same rule the
 * server applies (`server/services/integrations/integrationAccess.js`).
 *
 * @module features/admin/utils/groupIntegrationAccess
 */

/** The key that grants every installation, the ones installed later included. */
export const ALL_INTEGRATIONS = '*';

/** Prefix of a key that grants every installation of a type. */
export const TYPE_PREFIX = 'type:';

/**
 * The sections of the editor, in order (the admin Integrations page groups
 * the same way). A type section has an "All …" row granting `type:<type>`.
 * `match` decides by what `GET /api/admin/integrations/installed` reports.
 */
export const INTEGRATION_SECTIONS = Object.freeze([
  {
    id: 'peopleDirectories',
    type: 'people-directory',
    match: item => item.type === 'people-directory'
  },
  { id: 'webSearch', type: 'web-search', match: item => item.type === 'web-search' },
  { id: 'storage', type: 'storage', match: item => item.type === 'storage' },
  { id: 'mcp', match: item => item.protocol === 'mcp' },
  { id: 'a2a', match: item => item.protocol === 'a2a' },
  { id: 'builtIn', match: item => item.builtIn === true },
  { id: 'catalog', match: () => true }
]);

/**
 * The type key of a type (`people-directory` → `type:people-directory`).
 * @param {string} type
 * @returns {string}
 */
export function typeKey(type) {
  return `${TYPE_PREFIX}${type}`;
}

/**
 * The keys that grant one installation: its id, its definition id and its
 * type key. `*` grants every installation and is not listed.
 * @param {{ id: string, definition?: string, type?: string|null }} item
 * @returns {string[]}
 */
export function grantKeysOf(item) {
  if (!item?.id) return [];
  const keys = [item.id];
  if (item.definition) keys.push(item.definition);
  if (item.type) keys.push(typeKey(item.type));
  return keys;
}

/**
 * The key of a set that grants an installation, broadest first (`*`, then
 * the type, the definition, the id), or null.
 * @param {{ id: string, definition?: string, type?: string|null }} item
 * @param {Iterable<string>} keys
 * @returns {string|null}
 */
export function grantingKey(item, keys) {
  const granted = keys instanceof Set ? keys : new Set(keys || []);
  if (granted.has(ALL_INTEGRATIONS)) return ALL_INTEGRATIONS;
  return [...grantKeysOf(item)].reverse().find(key => granted.has(key)) || null;
}

/**
 * The installations in the editor's sections, empty sections left out. A
 * definition with two or more installations outside the type sections also
 * gets a definition row ("All … installations", key = definition id).
 *
 * @param {Array<Object>} items - `GET /api/admin/integrations/installed` → `items`
 * @returns {Array<{ id: string, type?: string, items: Object[], definitions: Array<{ id: string, name: string, count: number }> }>}
 */
export function sectionsOf(items) {
  const usable = (items || []).filter(item => item?.id && !item.definitionMissing);
  const sections = INTEGRATION_SECTIONS.map(section => ({
    id: section.id,
    type: section.type,
    items: [],
    definitions: []
  }));
  for (const item of usable) {
    const index = INTEGRATION_SECTIONS.findIndex(section => section.match(item));
    sections[index].items.push(item);
  }
  for (const section of sections) {
    if (section.type) continue;
    const byDefinition = new Map();
    for (const item of section.items) {
      if (!item.definition) continue;
      const entry = byDefinition.get(item.definition) || {
        id: item.definition,
        name: item.definitionName || item.definition,
        count: 0
      };
      entry.count += 1;
      byDefinition.set(item.definition, entry);
    }
    section.definitions = [...byDefinition.values()].filter(entry => entry.count > 1);
  }
  return sections.filter(section => section.items.length > 0 || section.type);
}

/**
 * The integration keys a group inherits, each with the nearest groups it
 * comes from (`inherits`, transitively; the group's own keys left out).
 *
 * @param {string} groupId - The group being edited
 * @param {Object<string, Object>} groups - `GET /api/admin/groups` → `groups`
 * @param {string[]} [inherits] - The group's current `inherits` (defaults to the saved one)
 * @returns {Map<string, string[]>} key → ids of the groups that grant it
 *
 * @example
 * inheritedGrants('admins', groups); // Map { '*' => ['users'] }
 */
export function inheritedGrants(groupId, groups, inherits) {
  const out = new Map();
  const all = groups && typeof groups === 'object' ? groups : {};
  const start = Array.isArray(inherits) ? inherits : all[groupId]?.inherits || [];
  const seen = new Set([groupId]);
  const queue = [...start];
  while (queue.length > 0) {
    const id = queue.shift();
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const group = all[id];
    if (!group) continue;
    for (const key of group.permissions?.integrations || []) {
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(id);
    }
    queue.push(...(group.inherits || []));
  }
  return out;
}

/**
 * A localized label of an installation as the admin API reports it.
 * @param {Object} item
 * @param {string} [language]
 * @returns {string}
 */
export function labelOf(item, language = 'en') {
  const label = item?.label;
  if (typeof label === 'string' && label) return label;
  if (label && typeof label === 'object') {
    return label[language] || label.en || Object.values(label).find(Boolean) || item.id;
  }
  return item?.id || '';
}

/**
 * The keys of a list no row of the editor shows (definition ids without a
 * row, installations that are gone, unknown type keys), so they stay visible
 * and removable.
 * @param {string[]} keys
 * @param {Array<Object>} sections - from {@link sectionsOf}
 * @returns {string[]}
 */
export function unlistedKeys(keys, sections) {
  const shown = new Set([ALL_INTEGRATIONS]);
  for (const section of sections) {
    if (section.type) shown.add(typeKey(section.type));
    for (const item of section.items) shown.add(item.id);
    for (const definition of section.definitions) shown.add(definition.id);
  }
  return (keys || []).filter(key => !shown.has(key));
}

/**
 * The list with a key switched on or off. Switching `*` on replaces the list.
 * @param {string[]} keys
 * @param {string} key
 * @param {boolean} on
 * @returns {string[]}
 */
export function toggleKey(keys, key, on) {
  const list = Array.isArray(keys) ? keys : [];
  if (on) {
    if (key === ALL_INTEGRATIONS) return [ALL_INTEGRATIONS];
    return list.includes(key) ? list : [...list, key];
  }
  return list.filter(entry => entry !== key);
}

/**
 * The groups whose own grants (`permissions.integrations`) include an
 * installation: `*`, its id, its definition id or its type key. Groups that
 * only inherit the grant are not listed; their members get it through the
 * listed group.
 * @param {{ id: string, definition?: string, type?: string|null }} item
 * @param {Object<string, Object>} groups - `GET /api/admin/groups` → `groups`
 * @returns {string[]} group ids, sorted
 */
export function groupsGranting(item, groups) {
  if (!item?.id || !groups || typeof groups !== 'object') return [];
  return Object.entries(groups)
    .filter(([, group]) => grantingKey(item, group?.permissions?.integrations || []))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}
