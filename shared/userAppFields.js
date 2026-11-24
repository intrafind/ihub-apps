// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The registry of the keys of a personal app that an author can configure.
 *
 * One descriptor per key. The lists the rest of the code needs are derived
 * from it, so a new setting is one entry here and not an edit in seven
 * places: the content keys of a stored app, the localized and required keys,
 * the verdicts of `USER_APP_FIELD_POLICY` for `content` and `capability`, and
 * the keys a conversational revision may read and change per target.
 *
 * A descriptor has:
 *
 * - `key`: the name of the key.
 * - `store`: where an author's value lives.
 *   - `content`: a top-level key of the stored content.
 *   - `capabilities`: a key inside the stored `capabilities` object.
 *   - `ceiling`: no stored value; the ceiling writes it for every run.
 *   - `admin`: a key of an admin app only; a personal app stores nothing.
 * - `verdict`: what a personal app does with the app-schema keys in `appKeys`:
 *   `content` (copied from the record), `capability` (written by the ceiling)
 *   or `never` (cannot be stored).
 * - `appKeys`: the keys of the app schema (`server/validators/appConfigSchema.js`)
 *   the descriptor produces in the app object of a run.
 * - `localized` and `required`: the value is one text per language; an app
 *   cannot be saved without it.
 * - `revise`: the targets (`admin`, `personal`) for which a revision reads the
 *   key and puts a change to it into its `patch`.
 * - `proposal`: how the builder offers a change. `direct` is part of the
 *   patch the author applies. `confirm` is a separate unticked item, because
 *   the key adds cost, data reach or access (design 07, section 2.6).
 * - `gate`: the key of `platform.userApps.capabilities` that switches it on,
 *   or null when no admin switch is needed.
 *
 * Pure data and pure functions. The Zod schemas stay hand-written in
 * `server/validators/userAppSchema.js`; a test (`user-app-fields.test.js`)
 * fails when a descriptor and a schema, the ceiling, the content picker or
 * the form disagree.
 *
 * Design: concepts/app-builder-rework-2026-11/07-configurable-personal-apps.md,
 * section 2.1.
 *
 * @module shared/userAppFields
 */

/** The two targets of a revision: an admin app and a personal app. */
export const USER_APP_FIELD_TARGETS = Object.freeze(['admin', 'personal']);

const BOTH = Object.freeze(['admin', 'personal']);
const NONE = Object.freeze([]);

function describe(descriptor) {
  return Object.freeze({
    localized: false,
    required: false,
    revise: NONE,
    proposal: null,
    gate: null,
    ...descriptor,
    appKeys: Object.freeze([...(descriptor.appKeys || [])])
  });
}

/**
 * Every configurable key, in the order of a revision's content (the order of
 * the keys of an admin revision) and then of the capabilities.
 */
export const USER_APP_FIELDS = Object.freeze([
  describe({
    key: 'name',
    store: 'content',
    verdict: 'content',
    appKeys: ['name'],
    localized: true,
    required: true,
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'description',
    store: 'content',
    verdict: 'content',
    appKeys: ['description'],
    localized: true,
    required: true,
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'system',
    store: 'content',
    verdict: 'content',
    appKeys: ['system'],
    localized: true,
    required: true,
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'prompt',
    store: 'content',
    verdict: 'content',
    appKeys: ['prompt'],
    localized: true,
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'messagePlaceholder',
    store: 'content',
    verdict: 'content',
    appKeys: ['messagePlaceholder'],
    localized: true,
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'variables',
    store: 'content',
    verdict: 'content',
    appKeys: ['variables'],
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'starterPrompts',
    store: 'content',
    verdict: 'content',
    appKeys: ['starterPrompts'],
    revise: BOTH,
    proposal: 'direct'
  }),
  // An admin app has a category; a personal app has none.
  describe({
    key: 'category',
    store: 'admin',
    verdict: 'never',
    appKeys: ['category'],
    revise: ['admin'],
    proposal: 'direct'
  }),
  describe({
    key: 'color',
    store: 'content',
    verdict: 'content',
    appKeys: ['color'],
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'icon',
    store: 'content',
    verdict: 'content',
    appKeys: ['icon'],
    revise: BOTH,
    proposal: 'direct'
  }),
  describe({
    key: 'preferredModel',
    store: 'content',
    verdict: 'capability',
    appKeys: ['preferredModel'],
    gate: 'modelChoice'
  }),
  // The container of the switches below; it has no app-schema key of its own.
  describe({ key: 'capabilities', store: 'content', verdict: 'capability' }),
  describe({
    key: 'upload',
    store: 'capabilities',
    verdict: 'capability',
    appKeys: ['upload'],
    gate: 'upload'
  }),
  describe({
    key: 'webSearch',
    store: 'capabilities',
    verdict: 'capability',
    appKeys: ['websearch'],
    gate: 'webSearch'
  }),
  describe({
    key: 'skills',
    store: 'capabilities',
    verdict: 'capability',
    appKeys: ['skills', 'skillSettings'],
    gate: 'skills'
  }),
  describe({
    key: 'integrations',
    store: 'capabilities',
    verdict: 'capability',
    appKeys: ['integrations'],
    gate: 'integrations'
  }),
  // Written by the ceiling for every run, whoever the author is.
  describe({
    key: 'toolApproval',
    store: 'ceiling',
    verdict: 'capability',
    appKeys: ['toolApproval']
  })
]);

/** The descriptor of a key, or undefined. */
export function userAppField(key) {
  return USER_APP_FIELDS.find(field => field.key === key);
}

/** The keys of the descriptors that match `predicate`, in registry order. */
function keysWhere(predicate) {
  return Object.freeze(USER_APP_FIELDS.filter(predicate).map(field => field.key));
}

/** The top-level keys of the stored content of a personal app. */
export const USER_APP_STORED_CONTENT_KEYS = keysWhere(field => field.store === 'content');

/** The stored content keys that hold one text per language. */
export const USER_APP_STORED_LOCALIZED_KEYS = keysWhere(
  field => field.store === 'content' && field.localized
);

/** The stored content keys an app cannot be saved without. */
export const USER_APP_STORED_REQUIRED_KEYS = keysWhere(
  field => field.store === 'content' && field.required
);

/**
 * The keys of a revision's `patch` for a target, in registry order.
 *
 * @param {'admin'|'personal'} target
 * @returns {readonly string[]}
 * @example
 * fieldKeysToRevise('personal').includes('category'); // → false
 */
export function fieldKeysToRevise(target) {
  return keysWhere(field => field.revise.includes(target));
}

/**
 * The verdicts of the keys of the app schema that the registry decides:
 * `{ [appKey]: 'content' | 'capability' | 'never' }`, in registry order.
 * `USER_APP_FIELD_POLICY` adds the `fixed` keys and the `never` keys that have
 * no descriptor.
 *
 * @returns {Record<string, 'content'|'capability'|'never'>}
 */
export function appKeyVerdicts() {
  const verdicts = {};
  for (const field of USER_APP_FIELDS) {
    for (const appKey of field.appKeys) verdicts[appKey] = field.verdict;
  }
  return verdicts;
}
