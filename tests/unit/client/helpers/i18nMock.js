// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A `t` that reads the real English strings from `shared/i18n/en.json`. A
 * key missing there comes back as the key itself, so a test that looks for the
 * English text fails. A call with a fallback (`t(key, 'Fallback')` or a
 * `defaultValue`) skips that check: it gets the fallback when the key is
 * missing, as i18next does. It understands both call
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
    fallbackOrOptions && typeof fallbackOrOptions === 'object'
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
