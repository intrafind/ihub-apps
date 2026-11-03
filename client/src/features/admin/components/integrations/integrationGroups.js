// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The groups of Admin → Integrations: both the **Installed** and the
 * **Catalog** tab list their entries under the same headings, in this order.
 *
 * An entry is an installation (`GET /api/admin/integrations/installed`) or a
 * catalog definition (`GET /api/admin/integrations/catalog`); both carry
 * `type`, `protocol` and `builtIn`, so one rule sorts both:
 *
 * | Group               | Rule (first match wins)            |
 * | ------------------- | ---------------------------------- |
 * | People directories  | `type: "people-directory"`         |
 * | Web search          | `type: "web-search"`               |
 * | Storage providers   | `type: "storage"`                  |
 * | MCP servers         | `protocol: "mcp"`                  |
 * | Agents              | `protocol: "a2a"`                  |
 * | Custom              | definition `custom/<id>` (builder) |
 * | Built-in            | any other entry with `builtIn`     |
 * | From the catalog    | everything else                    |
 *
 * The module is pure (no React, no i18n): the components translate the
 * `titleKey` / `descriptionKey` pairs it hands out.
 *
 * @module features/admin/components/integrations/integrationGroups
 */

/**
 * The groups in display order. `icon` is an `Icon` name, `accent` the
 * Tailwind classes of the icon tile (light and dark).
 * @type {ReadonlyArray<{
 *   id: string,
 *   titleKey: string, titleDefault: string,
 *   descriptionKey: string, descriptionDefault: string,
 *   icon: string, accent: string
 * }>}
 */
export const INTEGRATION_GROUPS = Object.freeze([
  {
    id: 'people-directories',
    titleKey: 'admin.integrations.groups.peopleDirectories.title',
    titleDefault: 'People directories',
    descriptionKey: 'admin.integrations.groups.peopleDirectories.description',
    descriptionDefault: 'LDAP and Entra ID directories the model looks people up in.',
    icon: 'user-group',
    accent: 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300'
  },
  {
    id: 'web-search',
    titleKey: 'admin.integrations.groups.webSearch.title',
    titleDefault: 'Web search',
    descriptionKey: 'admin.integrations.groups.webSearch.description',
    descriptionDefault:
      'Search engines apps with web search on use; without one, models search natively where they can.',
    icon: 'globe',
    accent: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300'
  },
  {
    id: 'storage',
    titleKey: 'admin.integrations.groups.storage.title',
    titleDefault: 'Storage providers',
    descriptionKey: 'admin.integrations.groups.storage.description',
    descriptionDefault:
      'Cloud storage users browse and attach files from in the chat and in projects.',
    icon: 'cloud',
    accent: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
  },
  {
    id: 'mcp',
    titleKey: 'admin.integrations.groups.mcp.title',
    titleDefault: 'MCP servers',
    descriptionKey: 'admin.integrations.groups.mcp.description',
    descriptionDefault: 'Model Context Protocol servers; their tools are the actions.',
    icon: 'cpu-chip',
    accent: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
  },
  {
    id: 'agents',
    titleKey: 'admin.integrations.groups.agents.title',
    titleDefault: 'Agents',
    descriptionKey: 'admin.integrations.groups.agents.description',
    descriptionDefault:
      'Remote agents (A2A) the model hands tasks to; their skills are the actions.',
    icon: 'sparkles',
    accent: 'bg-fuchsia-100 dark:bg-fuchsia-900/40 text-fuchsia-700 dark:text-fuchsia-300'
  },
  {
    id: 'custom',
    titleKey: 'admin.integrations.groups.custom.title',
    titleDefault: 'Custom',
    descriptionKey: 'admin.integrations.groups.custom.description',
    descriptionDefault:
      'Integrations built here with "Add manually", and the tools migrated from the former Tools page.',
    icon: 'wrench',
    accent: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300'
  },
  {
    id: 'built-in',
    titleKey: 'admin.integrations.groups.builtIn.title',
    titleDefault: 'Built-in',
    descriptionKey: 'admin.integrations.groups.builtIn.description',
    descriptionDefault: 'Integrations that ship with iHub, such as iFinder, iAssistant and Jira.',
    icon: 'cog',
    accent: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
  },
  {
    id: 'catalog',
    titleKey: 'admin.integrations.groups.catalog.title',
    titleDefault: 'From the catalog',
    descriptionKey: 'admin.integrations.groups.catalog.description',
    descriptionDefault: 'Integrations from the catalog or a marketplace registry.',
    icon: 'link',
    accent: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300'
  }
]);

/** Group ids by integration `type`. */
const GROUP_BY_TYPE = Object.freeze({
  'people-directory': 'people-directories',
  'web-search': 'web-search',
  storage: 'storage'
});

/** Group ids by protocol. */
const GROUP_BY_PROTOCOL = Object.freeze({
  mcp: 'mcp',
  a2a: 'agents'
});

/**
 * Whether an installation or catalog definition is a custom integration
 * (`custom/<id>`): an installation names its definition in `definition`, a
 * catalog entry is the definition (`id`).
 *
 * @param {{ id?: string, definition?: string }} entry
 * @returns {boolean}
 */
export function isCustomEntry(entry) {
  const definitionId = typeof entry?.definition === 'string' ? entry.definition : entry?.id;
  return typeof definitionId === 'string' && definitionId.startsWith('custom/');
}

/**
 * The group an installation or catalog definition belongs to.
 *
 * @param {{ type?: string|null, protocol?: string|null, builtIn?: boolean }} entry
 * @returns {string} one of the `INTEGRATION_GROUPS` ids
 * @example
 *   integrationGroupOf({ type: 'storage', builtIn: true }); // 'storage'
 *   integrationGroupOf({ protocol: 'mcp', builtIn: true }); // 'mcp'
 *   integrationGroupOf({ protocol: 'openapi' });            // 'catalog'
 */
export function integrationGroupOf(entry) {
  if (!entry || typeof entry !== 'object') return 'catalog';
  if (entry.type && GROUP_BY_TYPE[entry.type]) return GROUP_BY_TYPE[entry.type];
  if (entry.protocol && GROUP_BY_PROTOCOL[entry.protocol]) return GROUP_BY_PROTOCOL[entry.protocol];
  if (isCustomEntry(entry)) return 'custom';
  if (entry.builtIn === true) return 'built-in';
  return 'catalog';
}

/** The group descriptor of a group id (the catalog group for an unknown id). */
export function integrationGroup(groupId) {
  return INTEGRATION_GROUPS.find(group => group.id === groupId) || INTEGRATION_GROUPS.at(-1);
}

/**
 * Entries sorted into the groups, in group order. Empty groups are left out;
 * inside a group the entries keep the order they came in (the server sorts
 * the catalog by name and lists installations in their stored order).
 *
 * @template T
 * @param {T[]} entries - installations or catalog definitions
 * @returns {Array<(typeof INTEGRATION_GROUPS)[number] & { items: T[] }>}
 */
export function groupIntegrations(entries) {
  const buckets = new Map(INTEGRATION_GROUPS.map(group => [group.id, []]));
  for (const entry of Array.isArray(entries) ? entries : []) {
    buckets.get(integrationGroupOf(entry)).push(entry);
  }
  return INTEGRATION_GROUPS.filter(group => buckets.get(group.id).length > 0).map(group => ({
    ...group,
    items: buckets.get(group.id)
  }));
}
