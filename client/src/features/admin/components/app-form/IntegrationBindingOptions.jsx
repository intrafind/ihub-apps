// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../formStyles';

/**
 * The Required checkbox of a binding: absent `required` means required, only
 * an explicit `false` is optional. Shared by the generic binding rows and the
 * iAssistant and iFinder panels.
 *
 * @param {Object} props
 * @param {Object|undefined} props.binding - the binding (`app.integrations[key]`)
 * @param {(binding: Object) => void} props.onBindingChange - receives the changed binding
 * @param {string} [props.requiredHelp] - replaces the help text
 */
export function RequiredCheckbox({ binding, onBindingChange, requiredHelp }) {
  const { t } = useTranslation();
  const current = binding || {};
  const setRequired = required => {
    const rest = { ...current };
    delete rest.required;
    onBindingChange(required ? rest : { ...rest, required: false });
  };
  return (
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
  );
}

/**
 * The "On by default" checkbox of a binding: absent `enabledByDefault` means
 * a new chat starts with the integration on, only an explicit `false` makes it
 * available only (offered in the chat's "+" menu, off until the user switches
 * it on), the way web search's "Enabled by default" works.
 *
 * @param {Object} props
 * @param {Object|undefined} props.binding - the binding (`app.integrations[key]`)
 * @param {(binding: Object) => void} props.onBindingChange - receives the changed binding
 */
export function EnabledByDefaultCheckbox({ binding, onBindingChange }) {
  const { t } = useTranslation();
  const current = binding || {};
  const setEnabledByDefault = enabled => {
    const rest = { ...current };
    delete rest.enabledByDefault;
    onBindingChange(enabled ? rest : { ...rest, enabledByDefault: false });
  };
  return (
    <label className="inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
      <input
        type="checkbox"
        className={`${CHECKBOX_CLASS} mt-0.5`}
        checked={current.enabledByDefault !== false}
        onChange={e => setEnabledByDefault(e.target.checked)}
      />
      <span>
        {t('admin.apps.edit.integrations.enabledByDefault', 'On by default')}
        <span className={`${HELP_CLASS} block`}>
          {t(
            'admin.apps.edit.integrations.enabledByDefaultHelp',
            'New chats start with this integration switched on. Off: it is only available, and users switch it on in the chat\'s "+" menu when they need it.'
          )}
        </span>
      </span>
    </label>
  );
}

/**
 * The "Always loaded" checkbox of a binding (tool search): `alwaysLoaded: true`
 * sends the integration's tools to the model in full on every request, never
 * left to `search_tools`. Absent means tool search may leave them out when the
 * app's tools exceed the budget. Only shown while the platform's tool search
 * feature is on.
 *
 * @param {Object} props
 * @param {Object|undefined} props.binding - the binding (`app.integrations[key]`)
 * @param {(binding: Object) => void} props.onBindingChange - receives the changed binding
 */
export function AlwaysLoadedCheckbox({ binding, onBindingChange }) {
  const { t } = useTranslation();
  const current = binding || {};
  const setAlwaysLoaded = alwaysLoaded => {
    const rest = { ...current };
    delete rest.alwaysLoaded;
    onBindingChange(alwaysLoaded ? { ...rest, alwaysLoaded: true } : rest);
  };
  return (
    <label className="inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
      <input
        type="checkbox"
        className={`${CHECKBOX_CLASS} mt-0.5`}
        checked={current.alwaysLoaded === true}
        onChange={e => setAlwaysLoaded(e.target.checked)}
      />
      <span>
        {t('admin.apps.edit.integrations.alwaysLoaded', 'Always loaded')}
        <span className={`${HELP_CLASS} block`}>
          {t(
            'admin.apps.edit.integrations.alwaysLoadedHelp',
            "Always send this integration's tools to the model in full. Off: when the app's tools are too many for one request, the model finds them with a search instead."
          )}
        </span>
      </span>
    </label>
  );
}

/**
 * The settings of one bound integration in the app editor: the Required
 * and On-by-default switches, the tool search switch while that feature is
 * on and, when the integration has scopes, the default scope, the pinned
 * scope and the scope picker. Used by every generic binding row and by the
 * panels that bind an integration with a switch of their own (people
 * directories). The iAssistant and iFinder panels have purpose-built scope
 * settings and only share {@link RequiredCheckbox}.
 *
 * @param {Object} props
 * @param {string} props.idPrefix - unique prefix for the ids of the inputs
 * @param {Object} props.binding - the binding (`app.integrations[key]`)
 * @param {(binding: Object) => void} props.onBindingChange - receives the changed binding
 * @param {{ label: string }|null|undefined} [props.scopes] - the definition's scopes
 * @param {string} [props.requiredHelp] - replaces the help text of the Required switch
 * @param {boolean} [props.toolSearchEnabled] - the platform's tool search feature is on: show "Always loaded"
 */
function IntegrationBindingOptions({
  idPrefix,
  binding,
  onBindingChange,
  scopes,
  requiredHelp,
  toolSearchEnabled = false
}) {
  const { t } = useTranslation();
  const current = binding || {};

  const setScope = patch => {
    const next = { ...current, ...patch };
    for (const key of Object.keys(patch)) {
      if (patch[key] === '' || patch[key] === undefined) delete next[key];
    }
    onBindingChange(next);
  };

  return (
    <>
      <RequiredCheckbox
        binding={current}
        onBindingChange={onBindingChange}
        requiredHelp={requiredHelp}
      />
      <EnabledByDefaultCheckbox binding={current} onBindingChange={onBindingChange} />
      {toolSearchEnabled && (
        <AlwaysLoadedCheckbox binding={current} onBindingChange={onBindingChange} />
      )}
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
