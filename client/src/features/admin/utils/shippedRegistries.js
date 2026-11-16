// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Ids of the marketplace registries iHub ships in
 * `server/defaults/config/registries.json`. Deleting one has no "restore
 * default" in the UI, so its delete confirmation asks the admin to type the
 * registry id (AX-B14: the official registry was deleted through an unnamed
 * confirm). `tests/unit/client/admin-confirmations.test.jsx` keeps this list
 * in sync with the defaults file.
 */
export const SHIPPED_REGISTRY_IDS = Object.freeze(['ihub-official']);

/**
 * Whether a registry is one iHub ships (and therefore gets a typed confirm).
 *
 * @param {{ id?: string }} registry
 * @returns {boolean}
 */
export function isShippedRegistry(registry) {
  return Boolean(registry?.id) && SHIPPED_REGISTRY_IDS.includes(registry.id);
}
