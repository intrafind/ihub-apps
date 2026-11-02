// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rows of the app editor's **Storage providers** card
 * (`IntegrationsConfigSection`), as pure data: which bindings an admin can
 * tick. Labels are added by the component.
 *
 * An app binds storage providers in `app.integrations` like any integration
 * (see `shared/storageBindings.js`):
 *
 * 1. **All storage providers** — `type:storage`, every installation of every
 *    storage definition, the ones installed later included;
 * 2. **All … installations** — a definition id (`com.intrafind/nextcloud`),
 *    offered for a definition with two or more installations, or one the app
 *    already binds;
 * 3. each installation by its id.
 *
 * The card exists while a storage provider is installed or the app binds one;
 * otherwise there are no rows.
 *
 * @module features/admin/components/app-form/storageBindingRows
 */

/** The binding key of every storage provider. */
export const STORAGE_TYPE_KEY = 'type:storage';

/** The storage definitions iHub ships, so a binding of one shows even with no installation left. */
export const SHIPPED_STORAGE_DEFINITIONS = Object.freeze({
  'com.intrafind/office365': 'Microsoft Office 365',
  'com.intrafind/google-drive': 'Google Drive',
  'com.intrafind/nextcloud': 'Nextcloud'
});

/**
 * @typedef {Object} StorageBindingRow
 * @property {string} id - the binding key
 * @property {'type'|'definition'|'instance'} kind
 * @property {number} [count] - installations covered now (type and definition rows)
 * @property {string} [name] - the definition's name (definition rows)
 * @property {boolean} enabled - whether one of the covered installations is enabled
 */

/**
 * The rows of the Storage providers card.
 *
 * @param {Array<Object>} installed - `GET /api/admin/integrations/installed` items
 *   (`id`, `definition`, `definitionName`, `type`, `enabled`, `label`)
 * @param {Object<string, Object>} bindings - `app.integrations`
 * @returns {Array<StorageBindingRow|Object>} the type row, the definition rows, then each
 *   installation (the installed item with `kind: 'instance'`); empty when the card is hidden
 *
 * @example
 *   storageBindingRows(
 *     [{ id: 'nc-a', definition: 'com.intrafind/nextcloud', type: 'storage' },
 *      { id: 'nc-b', definition: 'com.intrafind/nextcloud', type: 'storage' }],
 *     {}
 *   ).map(row => row.id);
 *   // → ['type:storage', 'com.intrafind/nextcloud', 'nc-a', 'nc-b']
 */
export function storageBindingRows(installed, bindings = {}) {
  const providers = (Array.isArray(installed) ? installed : []).filter(
    item => item?.type === 'storage'
  );
  const has = key => Object.hasOwn(bindings || {}, key);

  const byDefinition = new Map();
  for (const item of providers) {
    if (!item.definition) continue;
    const entry = byDefinition.get(item.definition) || {
      name: item.definitionName || SHIPPED_STORAGE_DEFINITIONS[item.definition] || item.definition,
      items: []
    };
    entry.items.push(item);
    byDefinition.set(item.definition, entry);
  }
  // A shipped definition the app binds stays visible with no installation left.
  for (const [definitionId, name] of Object.entries(SHIPPED_STORAGE_DEFINITIONS)) {
    if (has(definitionId) && !byDefinition.has(definitionId)) {
      byDefinition.set(definitionId, { name, items: [] });
    }
  }

  const bindsStorage =
    has(STORAGE_TYPE_KEY) ||
    providers.some(item => has(item.id)) ||
    [...byDefinition.keys()].some(has);
  if (providers.length === 0 && !bindsStorage) return [];

  const anyEnabled = items => items.some(item => item.enabled !== false);
  const definitionRows = [...byDefinition.entries()]
    .filter(([definitionId, entry]) => entry.items.length > 1 || has(definitionId))
    .map(([definitionId, entry]) => ({
      id: definitionId,
      kind: 'definition',
      name: entry.name,
      count: entry.items.length,
      enabled: anyEnabled(entry.items)
    }));

  return [
    {
      id: STORAGE_TYPE_KEY,
      kind: 'type',
      count: providers.length,
      enabled: anyEnabled(providers)
    },
    ...definitionRows,
    ...providers.map(item => ({ ...item, kind: 'instance' }))
  ];
}
