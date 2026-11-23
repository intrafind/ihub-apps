// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedContent } from '../../../../utils/localizeContent';

/**
 * The models the app editor offers for Preferred Model and Allowed Models, as
 * `{ id, name }` with the status in the name: "GPT-4o (disabled)",
 * "Mistral Small (default)". The editor lists the admin's model list (AI-B9), so
 * a disabled model can be chosen before it is switched on for everyone; the
 * mark keeps the admin from mistaking it for a live one.
 *
 * A `<select>` option holds text only, so the status is part of the label
 * rather than a badge beside it.
 *
 * @param {Array<{id: string, name?: string|Object, enabled?: boolean, default?: boolean}>} models
 * @param {(key: string, options?: Object) => string} t - i18next `t`
 * @param {string} [language] - Base language of the UI.
 * @returns {Array<{id: string, name: string, enabled: boolean}>}
 *
 * @example
 * modelChoices([{ id: 'gpt', name: { en: 'GPT' }, enabled: false }], t, 'en');
 * // [{ id: 'gpt', name: 'GPT (disabled)', enabled: false }]
 */
export function modelChoices(models, t, language) {
  return (models || []).map(model => {
    const name = getLocalizedContent(model.name, language) || model.id;
    const enabled = model.enabled !== false;
    let label = name;
    if (!enabled) {
      label = t('admin.apps.edit.modelChoice.disabled', {
        name,
        defaultValue: '{{name}} (disabled)'
      });
    } else if (model.default === true) {
      label = t('admin.apps.edit.modelChoice.default', {
        name,
        defaultValue: '{{name}} (default)'
      });
    }
    return { id: model.id, name: label, enabled };
  });
}

/**
 * True when no model can answer in a chat app: the list is known and none of
 * its models is enabled. `null` (not loaded) is not "no model".
 *
 * @param {Array<Object>|null} models
 * @returns {boolean}
 */
export function hasNoUsableModel(models) {
  return Array.isArray(models) && !models.some(model => model.enabled !== false);
}
