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
 *
 * Isomorphic and pure: no Node import, no function modifies its argument.
 *
 * Design: concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md,
 * sections 2.2 and 2.3.
 *
 * @module shared/appRevision
 */

import { USER_APP_CONTENT_KEYS } from './userAppContent.js';

/** The two targets of a revision: an admin app (`apps/*.json`) and a personal app. */
export const REVISE_TARGETS = Object.freeze(['admin', 'personal']);

/** The content keys of an admin app a revision reads and may change. */
const ADMIN_REVISION_KEYS = Object.freeze([
  'name',
  'description',
  'system',
  'prompt',
  'messagePlaceholder',
  'variables',
  'starterPrompts',
  'category',
  'color',
  'icon'
]);

/**
 * The content keys of a personal app a revision reads and may change: the
 * content keys without the model and the capabilities, which the author sets
 * in the form only.
 */
const PERSONAL_REVISION_KEYS = Object.freeze(
  USER_APP_CONTENT_KEYS.filter(key => key !== 'preferredModel' && key !== 'capabilities')
);

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
