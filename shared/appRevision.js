// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the server and the client share about revising an app in a
 * conversation (`POST /api/admin/apps/_revise`, `POST /api/apps/_revise`,
 * `server/services/appRevision.js`, issue #3898).
 *
 * - {@link appRevisionKeys}: the content keys a revision may read and change,
 *   per target.
 * - The limits of a request and of an answer (`REVISE_*`).
 * - {@link REVISE_REPLIES}, {@link REVISE_WARNINGS}: the values of `reply` and
 *   the warning codes only a revision has.
 * - {@link applyRevisionPatch}: how the client merges a `patch` into its form.
 * - {@link revisionLanguageKey}: under which key of a localized text a
 *   revision reads and writes.
 *
 * Isomorphic and pure: no Node import, no function modifies its argument.
 *
 * Design: concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md,
 * sections 2.2 and 2.3.
 *
 * @module shared/appRevision
 */

import { USER_APP_LIMITS } from './userAppContent.js';
import { fieldKeysToPropose, fieldKeysToRevise } from './userAppFields.js';

/** The two targets of a revision: an admin app (`apps/*.json`) and a personal app. */
export const REVISE_TARGETS = Object.freeze(['admin', 'personal']);

/**
 * The content keys of an admin app a revision reads and may change. Derived
 * from the registry of configurable keys (`shared/userAppFields.js`).
 */
const ADMIN_REVISION_KEYS = fieldKeysToRevise('admin');

/**
 * The content keys of a personal app a revision reads and may change: the
 * keys of the registry that list the target `personal`. The model and the
 * capabilities are not among them; the author sets those in the form, and the
 * builder only suggests them.
 */
const PERSONAL_REVISION_KEYS = fieldKeysToRevise('personal');

/**
 * The key of a change under which a model proposes the settings of the
 * registry (`shared/userAppFields.js`, `propose`): `change.settings`. Each
 * value is checked per key on the server.
 */
export const REVISE_SETTINGS_KEY = 'settings';

/**
 * The keys a change may set through `change.settings` for a target. They are
 * not content keys of {@link appRevisionKeys}: a text, an input field or a
 * conversation starter has a sanitiser of its own, a setting is checked
 * against the schema of its key.
 *
 * @param {'admin'|'personal'} target
 * @returns {readonly string[]}
 * @example
 * appSettingsKeys('personal').includes('autoStart'); // → true
 */
export function appSettingsKeys(target) {
  return fieldKeysToPropose(target === 'personal' ? 'personal' : 'admin');
}

/** The keys whose value is one text per language. */
export const REVISE_LOCALIZED_KEYS = Object.freeze([
  'name',
  'description',
  'system',
  'prompt',
  'messagePlaceholder'
]);

/**
 * The content keys a revision reads from the draft and may put into `patch`.
 * `allowEmptyContent` is not among them: an admin patch may carry it, but the
 * server derives it from the message template; it is never read from the
 * model or the request.
 *
 * @param {'admin'|'personal'} target
 * @returns {readonly string[]}
 * @example
 * appRevisionKeys('personal').includes('category'); // → false
 */
export function appRevisionKeys(target) {
  return target === 'personal' ? PERSONAL_REVISION_KEYS : ADMIN_REVISION_KEYS;
}

/** Entries of `conversation`, the latest author message included. */
export const REVISE_CONVERSATION_MAX = 12;

/** The longest text of an author entry of `conversation`, counted after trimming. */
export const REVISE_AUTHOR_TEXT_MAX = 1000;

/** The longest text of a builder entry of `conversation`. */
export const REVISE_BUILDER_TEXT_MAX = 500;

/** The longest instructions (`system`, in the request's language) a turn can revise. */
export const REVISE_SYSTEM_MAX = 8000;

/** The longest `text` of an answer, and of a question. */
export const REVISE_TEXT_MAX = 300;

/** The most choices of a question. */
export const REVISE_CHOICES_MAX = 6;

/** The longest choice of a question. */
export const REVISE_CHOICE_MAX = 100;

/**
 * Builder questions since the last change after which the server turns a
 * further question into a `message`: the server counts, not the brief.
 */
export const REVISE_QUESTION_CAP = 3;

/** The values of `reply` in the answer. */
export const REVISE_REPLIES = Object.freeze(['question', 'change', 'message']);

/** The roles of a `conversation` entry. */
export const REVISE_ROLES = Object.freeze(['author', 'builder']);

/**
 * The `kind` of a builder entry of `conversation`: what the builder answered
 * in that turn. The server counts questions since the last change.
 */
export const REVISE_BUILDER_KINDS = REVISE_REPLIES;

/**
 * The warning codes only a revision has, next to those of the draft generator
 * (`APP_GENERATOR_WARNINGS` in `shared/appGenerator.js`, which a revision also
 * answers with for the keys it changed). A warning is `{ code, field }`.
 */
export const REVISE_WARNINGS = Object.freeze({
  /** The model answered with a change that changes nothing; the reply is a `message`. */
  NO_CHANGE: 'NO_CHANGE',
  /**
   * A key with texts in several languages changed in the request's language
   * only; the other languages keep their text (`field` is the key).
   */
  OTHER_LANGUAGES_UNCHANGED: 'OTHER_LANGUAGES_UNCHANGED'
});

/**
 * How much of each content key a revision request may carry, per target: the
 * texts in the language of the revision (the ones the model sees), the number
 * of input fields, options and conversation starters, and the short values
 * (`category`, `color`, `icon`, a field's `name` and `type`). A request over a
 * limit is refused before the turn counts against the limiter
 * (`APP_REVISE_TOO_LONG`, `details.field` names the key), so the content a
 * model call gets stays bounded. A change is sanitised with the same limits
 * (`limits` of `sanitizeGeneratedApp`), so it never cuts content the request
 * was allowed to carry.
 *
 * - `personal`: the limits of the personal-app schema (`USER_APP_LIMITS`), so a
 *   personal app that can be saved can always be revised.
 * - `admin`: an admin app has no length limits in its schema. These are large
 *   enough for every app shipped in `server/defaults/apps` (the largest: 6
 *   input fields, 6 starters, 12 options, a default value of about 1,000
 *   characters) and small enough to keep one turn's content bounded.
 *   `system` is {@link REVISE_SYSTEM_MAX} for both: the model writes the
 *   instructions out in full, and a longer text would be cut off.
 */
export const REVISE_CONTENT_LIMITS = Object.freeze({
  personal: Object.freeze({
    name: USER_APP_LIMITS.name,
    description: USER_APP_LIMITS.description,
    system: REVISE_SYSTEM_MAX,
    prompt: USER_APP_LIMITS.prompt,
    messagePlaceholder: USER_APP_LIMITS.messagePlaceholder,
    variables: USER_APP_LIMITS.variables,
    variableName: 100,
    variableLabel: USER_APP_LIMITS.variableLabel,
    variableDefault: USER_APP_LIMITS.variableDefault,
    options: USER_APP_LIMITS.options,
    optionValue: USER_APP_LIMITS.optionValue,
    optionLabel: USER_APP_LIMITS.optionLabel,
    starterPrompts: USER_APP_LIMITS.starterPrompts,
    starterTitle: USER_APP_LIMITS.starterTitle,
    starterMessage: USER_APP_LIMITS.starterMessage,
    shortValue: 200
  }),
  admin: Object.freeze({
    name: 200,
    description: 1000,
    system: REVISE_SYSTEM_MAX,
    prompt: 8000,
    messagePlaceholder: 500,
    variables: 12,
    variableName: 100,
    variableLabel: 200,
    variableDefault: 2000,
    options: 30,
    optionValue: 200,
    optionLabel: 200,
    starterPrompts: 12,
    starterTitle: 200,
    starterMessage: 1000,
    shortValue: 200
  })
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A deep copy of a JSON value. */
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * The form after a revision: `patch` merged over `form`. Each key of the
 * patch holds the whole new value of that key (a localized text keeps its
 * other languages inside the value, not by merging), and `null` removes the
 * key. Keys the patch does not name stay as they are.
 *
 * @param {object} form - The form state (an app config or the content of a personal app).
 * @param {object|null|undefined} patch - `patch` of a `change` answer.
 * @returns {object} A new object; neither argument is modified.
 * @example
 * applyRevisionPatch(
 *   { system: { de: 'Alt', en: 'Old' }, prompt: { de: 'X' } },
 *   { system: { de: 'Neu', en: 'Old' }, prompt: null }
 * );
 * // → { system: { de: 'Neu', en: 'Old' } }
 */
export function applyRevisionPatch(form, patch) {
  const result = isPlainObject(form) ? copy(form) : {};
  if (!isPlainObject(patch)) return result;
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete result[key];
    else result[key] = copy(value);
  }
  return result;
}

/**
 * `de` for `de-DE`; `en` for anything that is not a language tag. The rule of
 * `baseLanguage` in `server/services/appGenerator.js`, which uses this one.
 *
 * @param {string} tag
 * @returns {string}
 */
export function revisionBaseLanguage(tag) {
  const base = String(tag ?? '')
    .split(/[-_]/)[0]
    .trim()
    .toLowerCase();
  return /^[a-z]{2}$/.test(base) ? base : 'en';
}

/**
 * The key of a localized value that a revision in `language` reads and
 * writes: `language` itself when the value has text under exactly that key
 * (`de-DE` for `{ 'de-DE': '…' }`), else the base language (`de`). The server
 * writes a changed text back under this key, so an app kept under a region
 * tag does not get a second, base-language copy beside it, and the client
 * reads the proposed text from the same key.
 *
 * @param {unknown} value - A localized object (`{ en: '…' }`), a string or nothing.
 * @param {string} language - The language of the revision (`de`, `de-DE`).
 * @returns {string}
 * @example
 * revisionLanguageKey({ 'de-DE': 'Hallo' }, 'de-DE'); // → 'de-DE'
 * revisionLanguageKey({ de: 'Hallo' }, 'de-DE'); // → 'de'
 * revisionLanguageKey(undefined, 'de-DE'); // → 'de'
 */
export function revisionLanguageKey(value, language) {
  if (
    isPlainObject(value) &&
    typeof language === 'string' &&
    typeof value[language] === 'string' &&
    value[language].trim()
  ) {
    return language;
  }
  return revisionBaseLanguage(language);
}
