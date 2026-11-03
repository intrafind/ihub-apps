// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../formStyles';

/**
 * The settings of one bound integration in the app editor: the Required
 * switch and, when the integration has scopes, the default scope, the pinned
 * scope and the scope picker. Used by every binding row and by the panels
 * that bind an integration with a switch of their own (iAssistant, people
 * directories).
 *
 * @param {Object} props
 * @param {string} props.idPrefix - unique prefix for the ids of the inputs
 * @param {Object} props.binding - the binding (`app.integrations[key]`)
 * @param {(binding: Object) => void} props.onBindingChange - receives the changed binding
 * @param {{ label: string }|null|undefined} [props.scopes] - the definition's scopes
 * @param {string} [props.requiredHelp] - replaces the help text of the Required switch
 */
function IntegrationBindingOptions({ idPrefix, binding, onBindingChange, scopes, requiredHelp }) {
  const { t } = useTranslation();
  const current = binding || {};

  // Absent `required` means required; only an explicit `false` is optional.
  const setRequired = required => {
    const rest = { ...current };
    delete rest.required;
    onBindingChange(required ? rest : { ...rest, required: false });
  };

  const setScope = patch => {
    const next = { ...current, ...patch };
    for (const key of Object.keys(patch)) {
      if (patch[key] === '' || patch[key] === undefined) delete next[key];
    }
    onBindingChange(next);
  };

  return (
    <>
      <label className="inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
        <input
          type="checkbox"
          className={`${CHECKBOX_CLASS} mt-0.5`}
          checked={current.required !== false}
          onChange={e => setRequired(e.target.checked)}
        />
        <span>
          {t('admin.apps.edit.integrations.required', 'Required')}
          <span className={`${HELP_CLASS} block`}>
            {requiredHelp ||
              t(
                'admin.apps.edit.integrations.requiredHelp',
                'Hide the app while this integration is disabled or missing. Off: the app stays available without its actions.'
              )}
          </span>
        </span>
      </label>
      {scopes && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor={`${idPrefix}-default-scope`} className={LABEL_CLASS}>
              {t('admin.apps.edit.integrations.defaultScope', 'Default {{scope}}', {
                scope: scopes.label
              })}
            </label>
            <input
              id={`${idPrefix}-default-scope`}
              className={`${INPUT_CLASS} font-mono`}
              value={current.defaultScope || ''}
              onChange={e => setScope({ defaultScope: e.target.value })}
              placeholder={t('admin.apps.edit.integrations.scopeAny', 'users pick')}
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-pinned-scope`} className={LABEL_CLASS}>
              {t('admin.apps.edit.integrations.pinnedScope', 'Pinned {{scope}}', {
                scope: scopes.label
              })}
            </label>
            <input
              id={`${idPrefix}-pinned-scope`}
              className={`${INPUT_CLASS} font-mono`}
              value={current.pinnedScope || ''}
              onChange={e => setScope({ pinnedScope: e.target.value })}
            />
            <p className={HELP_CLASS}>
              {t(
                'admin.apps.edit.integrations.pinnedHelp',
                'Fixes the scope; users cannot change it.'
              )}
            </p>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-picker`} className={LABEL_CLASS}>
              {t('admin.apps.edit.integrations.scopePicker', 'Scope picker')}
            </label>
            <select
              id={`${idPrefix}-picker`}
              className={INPUT_CLASS}
              value={current.scopePicker || 'menu'}
              onChange={e =>
                setScope({ scopePicker: e.target.value === 'menu' ? '' : e.target.value })
              }
            >
              <option value="menu">
                {t('admin.apps.edit.integrations.picker.menu', 'In the menu')}
              </option>
              <option value="inline">
                {t('admin.apps.edit.integrations.picker.inline', 'In the chat input')}
              </option>
              <option value="hidden">
                {t('admin.apps.edit.integrations.picker.hidden', 'Hidden')}
              </option>
            </select>
          </div>
        </div>
      )}
    </>
  );
}

export default IntegrationBindingOptions;
