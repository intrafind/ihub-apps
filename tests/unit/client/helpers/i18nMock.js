// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A `t` that reads the real English strings from `shared/i18n/en.json`, so a
 * test fails when a key the UI uses is missing there. It understands both call
 * shapes the client uses — `t(key, 'Fallback {{x}}', { x })` and
 * `t(key, { x, defaultValue })` — and i18next's `_one` / `_other` plurals.
 *
 * Use it from a `jest.mock` factory:
 *
 * @example
 * jest.mock('react-i18next', () => {
 *   const { enT } = require('./helpers/i18nMock');
 *   const translation = { t: enT, i18n: { language: 'en' } };
 *   return { useTranslation: () => translation };
 * });
 */
const en = require('../../../../shared/i18n/en.json');

const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);

/**
 * @param {string} key
 * @param {string|Object} [fallbackOrOptions]
 * @param {Object} [maybeOptions]
 * @returns {string}
 */
function enT(key, fallbackOrOptions, maybeOptions) {
  const options =
    typeof fallbackOrOptions === 'object' && fallbackOrOptions !== null
      ? fallbackOrOptions
      : maybeOptions || {};
  const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : options.defaultValue;
  let text = lookup(key);
  if (typeof text !== 'string' && typeof options.count === 'number') {
    text = lookup(`${key}_${options.count === 1 ? 'one' : 'other'}`);
  }
  if (typeof text !== 'string') text = fallback;
  if (typeof text !== 'string') return key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
}

module.exports = { enT };
