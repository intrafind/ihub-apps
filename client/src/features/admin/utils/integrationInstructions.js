// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  baseLanguage,
  textInLanguage,
  withLanguageText
} from '../components/integrations/actionTestForm';

/**
 * The integration-level model guidance an installation page shows
 * (`detail.instructions`): the effective text, where it comes from, and the admin's own
 * override (`{ en, de }` or a plain string) when there is one.
 *
 * @typedef {Object} InstallationInstructions
 * @property {string} text
 * @property {string|null} source - `admin`, `definition`, `server` or null
 * @property {Object|string|null} own
 */

/** @type {InstallationInstructions} */
const NONE = { text: '', source: null, own: null };

/**
 * The text the editor starts from: the admin's own text for the current language, else what
 * the model gets now.
 *
 * @param {InstallationInstructions|null|undefined} instructions
 * @param {string} language - The UI language (`de-DE` counts as `de`)
 * @returns {string}
 */
export function instructionsStartText(instructions, language) {
  const current = instructions || NONE;
  return textInLanguage(current.own, baseLanguage(language)) || current.text || '';
}

/**
 * The override to store after the admin typed `draft` for the current language: the stored
 * override with that one language replaced; null when nothing is left (the integration's own
 * guidance applies again).
 *
 * @param {InstallationInstructions|null|undefined} instructions
 * @param {string} language
 * @param {string} draft
 * @returns {Object|null}
 */
export function instructionsPayload(instructions, language, draft) {
  const current = instructions || NONE;
  return withLanguageText(current.own, baseLanguage(language), draft);
}
