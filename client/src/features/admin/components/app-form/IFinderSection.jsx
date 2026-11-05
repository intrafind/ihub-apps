// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall, getAdminApiErrorMessage } from '../../../../api/adminApi';
import Switch from '../../../../shared/components/Switch';
import { CHECKBOX_CLASS, HELP_CLASS, LABEL_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { EnabledByDefaultCheckbox, RequiredCheckbox } from './IntegrationBindingOptions';
import { implicitActionNames, selectedActionNames, toggleBindingAction } from './bindingActions';
import { applyIFinderPickerMode, pickerModeOf, setStartProfile } from './iFinderBinding';

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * IFinderSection - iFinder integration card of the App form: the switch that
 * binds the `ifinder` installation (`app.integrations.ifinder`), the actions
 * the app takes, and which search profile the chat starts in and whether users
 * may switch it. The mapping onto the binding is in `iFinderBinding.js`.
 *
 * @param {Object} props
 * @param {Object|undefined} props.binding - `app.integrations.ifinder`; absent when unbound
 * @param {(binding: Object|null) => void} props.onBindingChange - null unbinds
 * @param {Object} [props.detail] - the installation as `GET …/installed/ifinder` returns it
 * @param {React.ReactNode} [props.notice] - e.g. that iFinder is not installed
 * @param {boolean} [props.installed] - whether the installation exists
 */
function IFinderSection({ binding, onBindingChange, detail, notice = null, installed = true }) {
  const { t } = useTranslation();
  // The profiles iFinder shows the signed-in admin; loaded on request,
  // because opening the app editor should not call iFinder.
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const bound = Boolean(binding);
  const current = binding || {};
  const mode = pickerModeOf(current);
  const installationDefault = meta?.defaultSearchProfile;
  const switchLocked = meta?.allowUserSearchProfileChange === false;
  const profiles = meta?.profiles ?? null;

  const actions = (detail?.actions || []).filter(action => action.available);
  const implicitNames = implicitActionNames(actions);
  const selected = selectedActionNames(current, implicitNames);

  const loadProfiles = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await makeAdminApiCall('/admin/integrations/ifinder/search-profiles');
      setMeta({
        profiles: response.data?.profiles ?? [],
        defaultSearchProfile: response.data?.defaultSearchProfile,
        allowUserSearchProfileChange: response.data?.allowUserSearchProfileChange
      });
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const startValue = current.defaultScope || '';
  const startKnown = !startValue || (profiles || []).some(profile => profile.id === startValue);

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.ifinder', 'iFinder')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.ifinderDesc',
              'Let the model search iFinder, and choose the search profile users search in'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
          {notice}
          <Switch
            id="ifinder-enabled"
            checked={bound}
            onChange={on => onBindingChange(on && installed ? { ...current } : null)}
            label={t('admin.apps.edit.ifinderEnabled', 'Enable iFinder')}
            labelPosition="start"
          />

          {bound && installed && (
            <div className="space-y-4 pl-1">
              {/* Actions */}
              <div>
                <p className={LABEL_CLASS}>
                  {t('admin.apps.edit.integrations.actions', 'Actions')}
                </p>
                {!detail && <p className={HELP_CLASS}>{t('common.loading', 'Loading…')}</p>}
                {detail && actions.length === 0 && (
                  <p className={HELP_CLASS}>
                    {t(
                      'admin.apps.edit.integrations.noActions',
                      'This installation offers no action right now.'
                    )}
                  </p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {actions.map(action => (
                    <label
                      key={action.name}
                      className="inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
                    >
                      <input
                        type="checkbox"
                        className={`${CHECKBOX_CLASS} mt-0.5`}
                        checked={selected.includes(action.name)}
                        onChange={e =>
                          onBindingChange(
                            toggleBindingAction(
                              binding,
                              implicitNames,
                              action.name,
                              e.target.checked
                            )
                          )
                        }
                      />
                      <span>
                        {action.title}
                        <span className="ml-1 font-mono text-xs text-gray-500 dark:text-gray-400">
                          {action.name}
                        </span>
                        {action.bindExplicitly && (
                          <span className={`${HELP_CLASS} block`}>
                            {t(
                              'admin.apps.edit.integrations.explicitAction',
                              'Only when ticked here; never part of "every action".'
                            )}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Search profile */}
              <fieldset className="space-y-3 border-t border-gray-200 dark:border-gray-700 pt-4">
                <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {t('admin.apps.edit.ifinderSearchProfile', 'Search profile')}
                </legend>

                <div>
                  <label
                    htmlFor="ifinder-start-profile"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.apps.edit.ifinderStartIn', 'Start in')}
                  </label>
                  <div className="mt-1 flex gap-2">
                    {profiles ? (
                      <select
                        id="ifinder-start-profile"
                        className={`${INPUT_CLASS} mt-0`}
                        value={startValue}
                        onChange={e =>
                          onBindingChange(
                            setStartProfile(binding, e.target.value, installationDefault)
                          )
                        }
                      >
                        <option value="">
                          {installationDefault
                            ? t(
                                'admin.apps.edit.ifinderInstallationDefaultNamed',
                                'Installation default ({{profile}})',
                                { profile: installationDefault }
                              )
                            : t(
                                'admin.apps.edit.ifinderInstallationDefault',
                                'Installation default'
                              )}
                        </option>
                        {!startKnown && <option value={startValue}>{startValue}</option>}
                        {profiles.map(profile => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name && profile.name !== profile.id
                              ? `${profile.name} (${profile.id})`
                              : profile.id}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="ifinder-start-profile"
                        type="text"
                        value={startValue}
                        onChange={e => onBindingChange(setStartProfile(binding, e.target.value))}
                        placeholder={t(
                          'admin.apps.edit.ifinderInstallationDefault',
                          'Installation default'
                        )}
                        className={`${INPUT_CLASS} mt-0 font-mono`}
                      />
                    )}
                    <button
                      type="button"
                      onClick={loadProfiles}
                      disabled={loading}
                      className={`${SECONDARY_BUTTON_CLASS} shrink-0`}
                    >
                      {loading
                        ? t('admin.apps.edit.ifinderLoading', 'Loading…')
                        : t('admin.apps.edit.ifinderLoad', 'Load from iFinder')}
                    </button>
                  </div>
                  <p className={HELP_CLASS}>
                    {t(
                      'admin.apps.edit.ifinderStartInDesc',
                      "The search profile a chat starts in. Empty: the installation's default search profile."
                    )}
                  </p>
                  {error && (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-1">
                      {t('admin.apps.edit.ifinderLoadFailed', {
                        defaultValue: 'The search profiles could not be loaded: {{error}}',
                        error
                      })}
                    </p>
                  )}
                  {profiles && profiles.length === 0 && (
                    <p className={HELP_CLASS}>
                      {t(
                        'admin.apps.edit.ifinderNoneVisible',
                        'iFinder shows you no search profiles. You can still enter an ID.'
                      )}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="ifinder-picker-mode"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.apps.edit.ifinderSwitch', 'Users may switch search profile')}
                  </label>
                  <select
                    id="ifinder-picker-mode"
                    className={INPUT_CLASS}
                    value={switchLocked ? 'fixed' : mode}
                    disabled={switchLocked}
                    onChange={e =>
                      onBindingChange(
                        applyIFinderPickerMode(binding, e.target.value, installationDefault)
                      )
                    }
                  >
                    <option value="menu">
                      {t('admin.apps.edit.ifinderSwitchMenu', 'In the menu')}
                    </option>
                    <option value="inline">
                      {t('admin.apps.edit.ifinderSwitchInline', 'In the chat input')}
                    </option>
                    <option value="fixed">
                      {t('admin.apps.edit.ifinderSwitchFixed', 'No, always use the start profile')}
                    </option>
                  </select>
                  {switchLocked && (
                    <p className={HELP_CLASS}>
                      {t(
                        'admin.apps.edit.ifinderSwitchLocked',
                        'The iFinder installation does not let users change the search profile ("Users may change the search profile" is off), so every app searches in its default.'
                      )}
                    </p>
                  )}
                </div>
              </fieldset>

              <RequiredCheckbox binding={binding} onBindingChange={onBindingChange} />
              <EnabledByDefaultCheckbox binding={binding} onBindingChange={onBindingChange} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default IFinderSection;
