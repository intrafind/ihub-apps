// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * App IDs for the app builder: derive one from a name, check one, find a free
 * one. Pure; imported by the create page and by the server's draft generator.
 *
 * The character rule and the length limit come from
 * `shared/validationPatterns.js` and from nowhere else.
 *
 * @module shared/appId
 */

import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from './validationPatterns.js';

/**
 * IDs the admin API cannot address, because a route of the same name sits
 * beside `/api/admin/apps/{id}`, or because the create page lives at
 * `/admin/apps/new`.
 */
export const RESERVED_APP_IDS = ['new', 'templates', 'integration-status'];

/** The ID of an app whose name yields no usable character. */
const FALLBACK_APP_ID = 'app';

/** Characters {@link slugifyAppId} leaves free at the end, for a suffix such as `-12`. */
const SUFFIX_ROOM = 4;

/** The highest numeric suffix {@link uniqueAppId} tries. */
const MAX_SUFFIX = 9999;

/** Letters that have a spelling of their own; every other mark is stripped. */
const TRANSLITERATIONS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** A character an ID may contain and that is a letter or a digit. */
function isWordChar(char) {
  return APP_ID_PATTERN.test(char) && LETTER_OR_DIGIT.test(char);
}

/** Remove the separators (`-`, `.`, `_`) at both ends. */
function trimSeparators(text) {
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && !isWordChar(chars[start])) start += 1;
  while (end > start && !isWordChar(chars[end - 1])) end -= 1;
  return chars.slice(start, end).join('');
}

/**
 * An app ID made from a text, usually the app's name.
 *
 * ä, ö, ü and ß become ae, oe, ue and ss; other marks are stripped (é → e);
 * the text is lower-cased. A single `.` or `_` between letters or digits is
 * kept, every other run of characters an ID may not contain becomes one `-`.
 * Separators at both ends are removed. The result is cut so that a suffix
 * such as `-12` still fits into the length limit.
 *
 * The result is empty when the text has no usable character (a name in
 * another script, for example). It can be a reserved ID; {@link uniqueAppId}
 * handles both.
 *
 * @param {string} text
 * @returns {string} A string that is empty or matches `APP_ID_PATTERN`.
 *
 * @example
 * slugifyAppId('Übersetzer für Verträge'); // → 'uebersetzer-fuer-vertraege'
 * slugifyAppId('Résumé (v2.1)'); // → 'resume-v2.1'
 * slugifyAppId('要約'); // → ''
 */
export function slugifyAppId(text) {
  const plain = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[äöüß]/g, char => TRANSLITERATIONS[char])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');

  let slug = '';
  let run = '';
  const closeRun = () => {
    if (!run) return;
    // One separator the ID rule allows stays as typed; anything else is a hyphen.
    slug += run.length === 1 && APP_ID_PATTERN.test(run) ? run : '-';
    run = '';
  };
  for (const char of plain) {
    if (isWordChar(char)) {
      closeRun();
      slug += char;
    } else {
      run += char;
    }
  }
  closeRun();

  return trimSeparators(trimSeparators(slug).slice(0, APP_ID_MAX_LENGTH - SUFFIX_ROOM));
}

/**
 * Why a string cannot be the ID of a new app, or `null` when it can.
 *
 * - `required`: empty.
 * - `tooLong`: more than 50 characters.
 * - `format`: a character outside lowercase letters, digits, `.`, `_`, `-`.
 * - `reserved`: one of {@link RESERVED_APP_IDS}, or a leading `_`, which is
 *   the prefix of the action routes (`_generate`, `_reorder`, `_toggle`).
 *
 * @param {unknown} id
 * @returns {'required'|'tooLong'|'format'|'reserved'|null}
 *
 * @example
 * appIdProblem('new'); // → 'reserved'
 * appIdProblem('My App'); // → 'format'
 * appIdProblem('my-app'); // → null
 */
export function appIdProblem(id) {
  if (typeof id !== 'string' || id === '') return 'required';
  if (id.length > APP_ID_MAX_LENGTH) return 'tooLong';
  if (!APP_ID_PATTERN.test(id)) return 'format';
  if (id.startsWith('_') || RESERVED_APP_IDS.includes(id)) return 'reserved';
  return null;
}

/**
 * Whether a string can be the ID of a new app: it matches `APP_ID_PATTERN`,
 * has at most 50 characters, is not reserved and does not start with `_`.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidAppId(id) {
  return appIdProblem(id) === null;
}

/** `isTaken` as a function, whatever the caller handed over. */
function takenPredicate(isTaken) {
  if (typeof isTaken === 'function') return isTaken;
  if (isTaken && typeof isTaken[Symbol.iterator] === 'function') {
    const ids = new Set([...isTaken].map(id => String(id).toLowerCase()));
    return id => ids.has(id);
  }
  return () => false;
}

/**
 * A free, valid app ID: `base` when it is valid and free, else `base-2`,
 * `base-3` and so on. An empty base starts from `app`; a reserved one gets a
 * suffix; a base that is no ID at all is slugified first. A long base is
 * shortened so that the suffix fits.
 *
 * The caller's list is a snapshot. The server stays the authority and answers
 * 409 for an ID that was taken in the meantime.
 *
 * @param {string} base - A candidate, usually `slugifyAppId(name)`.
 * @param {((id: string) => boolean)|Iterable<string>} [isTaken] - Whether an
 *   ID is in use (it is asked in lower case), or the IDs in use.
 * @returns {string}
 *
 * @example
 * uniqueAppId('summary', id => id === 'summary'); // → 'summary-2'
 * uniqueAppId('', () => false); // → 'app'
 * uniqueAppId('new', () => false); // → 'new-2'
 */
export function uniqueAppId(base, isTaken) {
  const taken = takenPredicate(isTaken);
  const free = id => isValidAppId(id) && !taken(id);

  if (free(base)) return base;

  // A base that is an ID already (only taken or reserved) keeps its spelling.
  const problem = appIdProblem(base);
  const isId = (problem === null || RESERVED_APP_IDS.includes(base)) && trimSeparators(base) !== '';
  const root = isId ? base : slugifyAppId(base) || FALLBACK_APP_ID;
  if (root !== base && free(root)) return root;

  const withSuffix = suffix =>
    `${trimSeparators(root.slice(0, APP_ID_MAX_LENGTH - suffix.length))}${suffix}`;
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const candidate = withSuffix(`-${n}`);
    if (free(candidate)) return candidate;
  }
  return withSuffix(`-${Date.now().toString(36)}`);
}
