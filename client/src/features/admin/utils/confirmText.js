// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text helpers for named confirmations in the admin (`ConfirmDialog`).
 * Every destructive confirmation names the type and the item, and its
 * confirm button names the verb ("Delete", never "OK").
 */

/**
 * Names for a confirmation's bullet list: at most `max` names, then
 * "and {count} more".
 *
 * @param {string[]} names - Display names of the affected items.
 * @param {(key: string, options?: Object) => string} t - i18next `t`.
 * @param {number} [max=5] - How many names to show.
 * @returns {string[]}
 *
 * @example
 * namedList(['A', 'B', 'C', 'D', 'E', 'F', 'G'], t) // ['A', …, 'E', 'and 2 more']
 */
export function namedList(names, t, max = 5) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) {
    shown.push(t('admin.confirm.andMore', { count: rest, defaultValue: 'and {{count}} more' }));
  }
  return shown;
}

/**
 * The fields of a named delete confirmation: `Delete model "GPT-4o"?`, the
 * consequence, and a "Delete" button.
 *
 * @param {Object} options
 * @param {string} options.typeKey - Key under `admin.confirm.types` (`model`, `app`, …).
 * @param {string} options.typeFallback - English type noun, used when the key is missing.
 * @param {string} options.name - Display name (or id) of the item.
 * @param {(key: string, options?: Object) => string} options.t - i18next `t`.
 * @param {React.ReactNode} [options.message] - Consequence; defaults to
 *   "The {type} is removed for all users."
 * @returns {{ title: string, message: React.ReactNode, confirmLabel: string, danger: true }}
 */
export function deleteConfirmText({ typeKey, typeFallback, name, t, message }) {
  const type = t(`admin.confirm.types.${typeKey}`, typeFallback);
  return {
    title: t('admin.confirm.deleteTitle', {
      type,
      name,
      defaultValue: 'Delete {{type}} "{{name}}"?'
    }),
    message:
      message ??
      t('admin.confirm.deleteMessage', {
        type,
        defaultValue: 'The {{type}} is removed for all users.'
      }),
    confirmLabel: t('admin.confirm.delete', 'Delete'),
    danger: true
  };
}
