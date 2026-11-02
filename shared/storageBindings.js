// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which storage providers an app offers, read the same way on the server and
 * in the browser.
 *
 * An app binds storage providers like any other integration, in
 * `app.integrations` (Admin → Apps → Edit → Integrations → Storage providers):
 *
 * - `"type:storage"` — every storage provider, the ones installed later
 *   included ("All storage providers");
 * - a definition id, e.g. `"com.intrafind/nextcloud"` — every installation of
 *   that provider;
 * - an installation id, e.g. `"nextcloud-hq"` — that installation.
 *
 * The binding replaced the app switch `upload.cloudStorageUpload.enabled`
 * (migration V206). The chat's file picker offers the providers the app binds
 * AND the user's groups grant: the server lists only granted providers in
 * `/api/auth/status` → `cloudStorage.providers`, and this module narrows that
 * list to the app's bindings.
 *
 * Pure and tolerant of missing input.
 *
 * @module shared/storageBindings
 */

/** The `app.integrations` key that binds every storage provider. */
export const STORAGE_TYPE_BINDING = 'type:storage';

/**
 * The bindings object of an app, or an empty object.
 * @param {Object|null|undefined} app
 * @returns {Object<string, Object>}
 */
function bindingsOf(app) {
  const bindings = app?.integrations;
  return bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {};
}

/**
 * Whether an app binds a storage provider: by its installation id, its
 * definition id or `type:storage`.
 *
 * @param {Object|null|undefined} app - The app configuration
 * @param {{ id?: string, definition?: string }|null|undefined} provider - A provider
 *   as `/api/auth/status` lists it (`id` is the installation id)
 * @returns {boolean}
 *
 * @example
 *   appBindsStorageProvider(
 *     { integrations: { 'com.intrafind/nextcloud': { required: false } } },
 *     { id: 'nextcloud-hq', definition: 'com.intrafind/nextcloud' }
 *   ); // → true
 */
export function appBindsStorageProvider(app, provider) {
  if (!provider?.id) return false;
  const bindings = bindingsOf(app);
  return (
    Object.hasOwn(bindings, provider.id) ||
    (typeof provider.definition === 'string' && Object.hasOwn(bindings, provider.definition)) ||
    Object.hasOwn(bindings, STORAGE_TYPE_BINDING)
  );
}

/**
 * The providers of a list that an app binds, in list order. Disabled
 * providers are left out unless `includeDisabled` is set.
 *
 * @param {Object|null|undefined} app - The app configuration
 * @param {Array<{ id: string, definition?: string, enabled?: boolean }>|null|undefined} providers
 * @param {{ includeDisabled?: boolean }} [options]
 * @returns {Array<Object>}
 */
export function storageProvidersBoundBy(app, providers, { includeDisabled = false } = {}) {
  if (!Array.isArray(providers)) return [];
  return providers.filter(
    provider =>
      provider &&
      (includeDisabled || provider.enabled !== false) &&
      appBindsStorageProvider(app, provider)
  );
}

/**
 * Whether an app binds storage at all, by `type:storage`, one of the given
 * definition ids or one of the given installation ids. For callers without
 * the providers' details (the usage guide).
 *
 * @param {Object|null|undefined} app
 * @param {{ definitionIds?: Iterable<string>, installationIds?: Iterable<string> }} [known]
 * @returns {boolean}
 */
export function appBindsStorage(app, { definitionIds = [], installationIds = [] } = {}) {
  const bindings = bindingsOf(app);
  if (Object.hasOwn(bindings, STORAGE_TYPE_BINDING)) return true;
  for (const id of [...definitionIds, ...installationIds]) {
    if (Object.hasOwn(bindings, id)) return true;
  }
  return false;
}
