// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The item kind registry (spec 1 §4).
 *
 * A project item comes from a **kind**: upload, URL, page, iFinder document
 * or query, OneDrive and SharePoint, Google Drive, Nextcloud, and later Jira,
 * Confluence or MCP resources. Each kind registers once, at startup, what the
 * project code needs to know about it and nothing else:
 *
 *  - how its `ref` is shaped (`refSchema`) and how to describe one without a
 *    fetch (`describe`);
 *  - how its content is held in each tier (`storage`), and whose credentials
 *    a fetch runs with (`credentials`);
 *  - which picker the client renders for it (`picker`);
 *  - whether it is available on this installation (`enabled`);
 *  - how to fetch its content (`fetch`) and test a reference (`test`) —
 *    both optional for a kind whose content is handed in rather than
 *    fetched, such as an upload.
 *
 * Integrations plug in through {@link registerItemKind}; the client reads the
 * enabled kinds with their picker descriptors from `GET /api/projects/_config`.
 *
 * @module services/projects/kinds/registry
 */
import { isValidId } from '../../../utils/pathSecurity.js';

/** Storage rules a kind may declare per tier. */
export const STORAGE_RULES = Object.freeze(['text', 'link']);

/** Whose credentials a fetch runs with. */
export const CREDENTIAL_RULES = Object.freeze(['none', 'picking-user', 'reading-user']);

/** Picker types the client has a component for. */
export const PICKER_TYPES = Object.freeze(['upload', 'url', 'page', 'ifinder', 'cloud']);

/**
 * @typedef {Object} ItemKind
 * @property {string} id - Registry id, a safe id.
 * @property {Object<string, string>} name - Localized display name.
 * @property {string} [icon] - Icon name for the client.
 * @property {{ihub: 'text'|'link', ifinder?: string}} storage - Storage rule per tier.
 * @property {'none'|'picking-user'|'reading-user'} credentials - Credential rule.
 * @property {{type: string, [key: string]: any}} picker - Picker descriptor.
 * @property {import('zod').ZodTypeAny} refSchema - Validates `item.ref`.
 * @property {(ctx: {platform: Object, features: Object}) => boolean} [enabled]
 * @property {(ref: Object, lang?: string) => {name?: string, url?: string, site?: string}} [describe]
 * @property {(item: Object, ctx: Object) => Promise<Object>} [fetch]
 * @property {(ref: Object, ctx: Object) => Promise<Object>} [test]
 */

const kinds = new Map();

/**
 * Register one item kind. Registering an id twice replaces the earlier
 * definition, so a test can swap a kind for a fake.
 *
 * @param {ItemKind} kind
 * @returns {ItemKind}
 */
export function registerItemKind(kind) {
  if (!kind || typeof kind.id !== 'string' || !isValidId(kind.id)) {
    throw new TypeError('An item kind needs a safe id');
  }
  if (!kind.storage || !STORAGE_RULES.includes(kind.storage.ihub)) {
    throw new TypeError(`Item kind ${kind.id} needs a storage rule for the ihub tier`);
  }
  if (!CREDENTIAL_RULES.includes(kind.credentials)) {
    throw new TypeError(`Item kind ${kind.id} needs a credential rule`);
  }
  if (!kind.picker || !PICKER_TYPES.includes(kind.picker.type)) {
    throw new TypeError(`Item kind ${kind.id} needs a picker descriptor`);
  }
  if (!kind.refSchema || typeof kind.refSchema.safeParse !== 'function') {
    throw new TypeError(`Item kind ${kind.id} needs a refSchema`);
  }
  const definition = Object.freeze({ ...kind });
  kinds.set(kind.id, definition);
  return definition;
}

/**
 * One kind by id, or null.
 *
 * @param {string} id
 * @returns {ItemKind|null}
 */
export function getItemKind(id) {
  return typeof id === 'string' && kinds.has(id) ? kinds.get(id) : null;
}

/**
 * Every registered kind, in registration order.
 *
 * @returns {ItemKind[]}
 */
export function listItemKinds() {
  return [...kinds.values()];
}

/**
 * Whether a kind is available on this installation: registered, its
 * integration configured (`enabled`), and not switched off by the admin in
 * `platform.projects.kinds`.
 *
 * @param {string} id - Kind id.
 * @param {{platform?: Object, features?: Object, settings?: Object}} [ctx]
 * @returns {boolean}
 */
export function isItemKindEnabled(id, ctx = {}) {
  const kind = getItemKind(id);
  if (!kind) return false;
  const switched = ctx.settings?.kinds?.[id];
  if (switched === false) return false;
  if (typeof kind.enabled === 'function') {
    try {
      return kind.enabled({ platform: ctx.platform || {}, features: ctx.features || {} }) !== false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The kinds the client may offer right now, with their picker descriptors.
 *
 * @param {{platform?: Object, features?: Object, settings?: Object}} [ctx]
 * @returns {Array<{id: string, name: Object, icon?: string, picker: Object, storage: string, credentials: string}>}
 */
export function enabledItemKinds(ctx = {}) {
  return listItemKinds()
    .filter(kind => isItemKindEnabled(kind.id, ctx))
    .map(kind => ({
      id: kind.id,
      name: kind.name,
      icon: kind.icon || null,
      picker: kind.picker,
      storage: kind.storage.ihub,
      credentials: kind.credentials
    }));
}

/** Test hook: forget every kind. */
export function resetItemKinds() {
  kinds.clear();
}
