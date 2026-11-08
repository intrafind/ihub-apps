// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall, getAdminApiErrorMessage } from '../../../../api/adminApi';
import Switch from '../../../../shared/components/Switch';
import { CHECKBOX_CLASS, HELP_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { RequiredCheckbox } from './IntegrationBindingOptions';
import { implicitActionNames, selectedActionNames, toggleBindingAction } from './bindingActions';
import {
  applyPickerMode,
  legacyScopeSettings,
  pickerModeOf,
  resetLegacyScopeSettings,
  setAllowAllSearchProfiles,
  syncPinnedScope
} from './iAssistantBinding';

const BINDING_KEY = 'iassistant';
const ASK_ACTION = 'ask';

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * IAssistantSection - iAssistant integration configuration card for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice.
 * Rendered by IntegrationsConfigSection.
 *
 * The switch is the app's use of iAssistant: IntegrationsConfigSection binds
 * the `iassistant` installation (`app.integrations.iassistant`) with it and
 * keeps `app.iassistant.enabled` in step. While it is on, the panel shows the
 * iAssistant settings (`app.iassistant`) and, below them, how users choose an
 * iAssistant in the chat and the binding's other settings (Required, the `ask`
 * action). Those write `app.integrations.iassistant`; the mapping is in
 * `iAssistantBinding.js`.
 *
 * @param {Object} props
 * @param {Object} props.app - the app being edited
 * @param {(app: Object) => void} props.onChange - receives the whole changed app
 * @param {boolean} props.enabled - whether the app uses iAssistant
 * @param {(enabled: boolean) => void} props.onEnabledChange - turns iAssistant on or off
 * @param {React.ReactNode} [props.notice] - e.g. that iAssistant is not installed
 * @param {Object} [props.binding] - `app.integrations.iassistant`
 * @param {((binding: Object) => void)|null} [props.onBindingChange] - receives the changed
 *   binding; null while iAssistant is not installed (no binding settings are shown)
 * @param {Object[]} [props.bindingActions] - the installation's actions (`details.iassistant.actions`)
 */
function IAssistantSection({
  app,
  onChange,
  enabled,
  onEnabledChange,
  notice = null,
  binding,
  onBindingChange = null,
  bindingActions = []
}) {
  const { t, i18n } = useTranslation();
  // The iAssistants iFinder shows the signed-in admin; loaded on request,
  // because opening the app editor should not call iFinder.
  const [assistants, setAssistants] = useState(null);
  const [loadingAssistants, setLoadingAssistants] = useState(false);
  const [assistantsError, setAssistantsError] = useState('');

  const assistantId = app.iassistant?.assistantId ?? '';
  const usesAssistant = assistantId.trim() !== '';
  const allSearchProfiles = app.iassistant?.allSearchProfiles === true;
  const selectedAssistant = assistants?.find(assistant => assistant.id === assistantId);

  const loadAssistants = async () => {
    setLoadingAssistants(true);
    setAssistantsError('');
    try {
      const response = await makeAdminApiCall(
        `/admin/integrations/ifinder/assistants?lang=${encodeURIComponent(i18n.language || 'en')}`
      );
      setAssistants(response.data?.items ?? []);
    } catch (err) {
      setAssistantsError(getAdminApiErrorMessage(err));
    } finally {
      setLoadingAssistants(false);
    }
  };

  // One change of the whole app: while the choice is fixed, the pinned scope
  // follows the iAssistant settings, so it cannot drift.
  const handleIAssistantChange = updates => {
    const iassistant = { ...app.iassistant, ...updates };
    const synced = syncPinnedScope(binding, iassistant);
    onChange({
      ...app,
      iassistant,
      ...(synced !== binding
        ? { integrations: { ...app.integrations, [BINDING_KEY]: synced } }
        : {})
    });
  };

  const current = binding || {};
  const mode = pickerModeOf(current);
  const legacy = legacyScopeSettings(binding, app.iassistant);
  const implicitNames = implicitActionNames(bindingActions);
  const asksOthers = selectedActionNames(current, implicitNames).includes(ASK_ACTION);

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.iassistant', 'iAssistant')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.iassistantDesc', 'Configure iAssistant integration for this app')}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
          {notice}
          <Switch
            id="iassistant-enabled"
            checked={enabled}
            onChange={onEnabledChange}
            label={t('admin.apps.edit.iassistantEnabled', 'Enable iAssistant')}
            labelPosition="start"
          />

          {/* iAssistant settings - only shown when enabled */}
          {enabled && (
            <div className="space-y-4 pl-1">
              {/* iFinder iAssistant */}
              <div>
                <label
                  htmlFor="iassistant-assistant-id"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.apps.edit.iassistantAssistantId', 'iFinder iAssistant')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantAssistantIdDesc',
                    'An iAssistant from iFinder. It sets both the conversation profile and the search profile, and only users who have its search profile can use it. Leave empty to set the profiles below.'
                  )}
                </p>
                <div className="mt-1 flex gap-2">
                  <input
                    id="iassistant-assistant-id"
                    type="text"
                    list="iassistant-assistant-options"
                    value={assistantId}
                    onChange={e => handleIAssistantChange({ assistantId: e.target.value.trim() })}
                    placeholder="legal-advisor"
                    className={`${INPUT_CLASS} mt-0`}
                  />
                  <datalist id="iassistant-assistant-options">
                    {(assistants ?? []).map(assistant => (
                      <option key={assistant.id} value={assistant.id}>
                        {assistant.name}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    onClick={loadAssistants}
                    disabled={loadingAssistants}
                    className="shrink-0 inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-60"
                  >
                    {loadingAssistants
                      ? t('admin.apps.edit.iassistantAssistantLoading', 'Loading…')
                      : t('admin.apps.edit.iassistantAssistantLoad', 'Load from iFinder')}
                  </button>
                </div>
                {assistantsError && (
                  <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-1">
                    {t('admin.apps.edit.iassistantAssistantLoadFailed', {
                      defaultValue: 'The iAssistants could not be loaded: {{error}}',
                      error: assistantsError
                    })}
                  </p>
                )}
                {assistants && assistants.length === 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t(
                      'admin.apps.edit.iassistantAssistantNoneVisible',
                      'iFinder shows you no iAssistants. You can still enter an ID.'
                    )}
                  </p>
                )}
                {selectedAssistant && (
                  <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">
                    {selectedAssistant.name} —{' '}
                    {t('admin.apps.edit.iassistantAssistantProfiles', {
                      defaultValue:
                        'Conversation profile: {{conversationProfile}} · Search profile: {{searchProfile}}',
                      conversationProfile: selectedAssistant.conversationProfileId || '–',
                      searchProfile: selectedAssistant.searchProfileId || '–'
                    })}
                  </p>
                )}
              </div>

              {/* Profile ID */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantProfileId', 'Profile ID')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantProfileIdDesc',
                    'The iAssistant profile to use for this app (e.g., iassistant-workspace)'
                  )}
                </p>
                <input
                  type="text"
                  value={app.iassistant?.profileId ?? ''}
                  onChange={e => handleIAssistantChange({ profileId: e.target.value })}
                  placeholder="iassistant-workspace"
                  disabled={usesAssistant}
                  className={INPUT_CLASS}
                />
                {usesAssistant && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('admin.apps.edit.iassistantAssistantOverrides', 'Set by the iAssistant.')}
                  </p>
                )}
              </div>

              {/* Search Profile */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantSearchProfile', 'Search Profile')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantSearchProfileDesc',
                    'The search profile to use for retrieval using iFinder (e.g., searchprofile-standard)'
                  )}
                </p>
                <input
                  type="text"
                  value={app.iassistant?.searchProfile ?? ''}
                  onChange={e => handleIAssistantChange({ searchProfile: e.target.value })}
                  placeholder="searchprofile-standard"
                  disabled={usesAssistant || allSearchProfiles}
                  className={INPUT_CLASS}
                />
                {usesAssistant && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('admin.apps.edit.iassistantAssistantOverrides', 'Set by the iAssistant.')}
                  </p>
                )}
              </div>

              {/* All search profiles of the user */}
              <div className="flex items-start gap-3">
                <input
                  id="iassistant-all-search-profiles"
                  type="checkbox"
                  checked={allSearchProfiles}
                  disabled={usesAssistant}
                  onChange={e => handleIAssistantChange({ allSearchProfiles: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-60"
                />
                <div>
                  <label
                    htmlFor="iassistant-all-search-profiles"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t(
                      'admin.apps.edit.iassistantAllSearchProfiles',
                      "Search all of the user's search profiles"
                    )}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.apps.edit.iassistantAllSearchProfilesDesc',
                      'Sends no search profile, so iFinder searches everything the user may see through any of their search profiles. Requires iFinder 6.9 or later.'
                    )}
                  </p>
                </div>
              </div>

              {/* Extra Context */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantExtraContext', 'Extra Context')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantExtraContextDesc',
                    'Additional context to be added to the response state prompt. Supports prompt variables like {{user_name}}, {{user_email}}, {{date}} and custom global variables. Use with care as changes can impact answer quality.'
                  )}
                </p>
                <textarea
                  value={app.iassistant?.extraContext ?? ''}
                  onChange={e => handleIAssistantChange({ extraContext: e.target.value })}
                  rows={3}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>

              {/* System Prompt Preamble */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantSystemPromptPreamble', 'System Prompt Preamble')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantSystemPromptPreambleDesc',
                    'The prompt preamble used in the response state system prompt. This is ideal for changing the identity of the iAssistant. Supports prompt variables like {{user_name}}, {{user_email}}, {{date}} and custom global variables. Use with care.'
                  )}
                </p>
                <textarea
                  value={app.iassistant?.systemPromptPreamble ?? ''}
                  onChange={e => handleIAssistantChange({ systemPromptPreamble: e.target.value })}
                  rows={3}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>

              {onBindingChange && (
                <fieldset className="space-y-3 border-t border-gray-200 dark:border-gray-700 pt-4">
                  <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t('admin.apps.edit.iassistantChoosing', 'Choosing an iAssistant in the chat')}
                  </legend>

                  <div>
                    <label
                      htmlFor="iassistant-picker-mode"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                      {t('admin.apps.edit.iassistantSwitch', 'Users may switch iAssistant')}
                    </label>
                    <select
                      id="iassistant-picker-mode"
                      className={INPUT_CLASS}
                      value={mode}
                      onChange={e =>
                        onBindingChange(applyPickerMode(binding, e.target.value, app.iassistant))
                      }
                    >
                      <option value="menu">
                        {t('admin.apps.edit.iassistantSwitchMenu', 'In the menu')}
                      </option>
                      <option value="inline">
                        {t('admin.apps.edit.iassistantSwitchInline', 'In the chat input')}
                      </option>
                      <option value="fixed">
                        {t(
                          'admin.apps.edit.iassistantSwitchFixed',
                          "No, always use this app's setting"
                        )}
                      </option>
                    </select>
                  </div>

                  {mode !== 'fixed' && (
                    <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                      <input
                        id="iassistant-offer-all"
                        type="checkbox"
                        className={`${CHECKBOX_CLASS} mt-0.5 disabled:opacity-60`}
                        checked={allSearchProfiles || current.allowAllSearchProfiles === true}
                        disabled={allSearchProfiles}
                        onChange={e =>
                          onBindingChange(setAllowAllSearchProfiles(binding, e.target.checked))
                        }
                      />
                      <span>
                        {t(
                          'admin.apps.edit.iassistantOfferAll',
                          'Also offer "All my search profiles"'
                        )}
                        <span className={`${HELP_CLASS} block`}>
                          {allSearchProfiles
                            ? t(
                                'admin.apps.edit.iassistantOfferAllOn',
                                "Always offered, because this app searches all of the user's search profiles."
                              )
                            : t(
                                'admin.apps.edit.iassistantOfferAllDesc',
                                'Users can then ask across every search profile they have.'
                              )}
                        </span>
                      </span>
                    </label>
                  )}

                  {legacy.length > 0 && (
                    <div
                      data-testid="iassistant-legacy-scope"
                      className="rounded-md px-3 py-2 text-sm bg-yellow-50 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200 flex items-start gap-3"
                    >
                      <p className="flex-1">
                        {t(
                          'admin.apps.edit.iassistantLegacyScope',
                          'This app sets scope values the panel does not manage: {{values}}.',
                          { values: legacy.map(item => `${item.key}: ${item.value}`).join(', ') }
                        )}
                      </p>
                      <button
                        type="button"
                        className={SECONDARY_BUTTON_CLASS}
                        onClick={() =>
                          onBindingChange(resetLegacyScopeSettings(binding, app.iassistant))
                        }
                      >
                        {t('admin.apps.edit.iassistantLegacyReset', 'Reset')}
                      </button>
                    </div>
                  )}

                  <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <input
                      id="iassistant-ask-action"
                      type="checkbox"
                      className={`${CHECKBOX_CLASS} mt-0.5`}
                      checked={asksOthers}
                      onChange={e =>
                        onBindingChange(
                          toggleBindingAction(binding, implicitNames, ASK_ACTION, e.target.checked)
                        )
                      }
                    />
                    <span>
                      {t(
                        'admin.apps.edit.iassistantAskAction',
                        'Let other models ask this iAssistant'
                      )}
                      <span className={`${HELP_CLASS} block`}>
                        {t(
                          'admin.apps.edit.iassistantAskActionDesc',
                          'For apps whose model is not the iAssistant: the model gets a tool to put questions to it. Off unless ticked.'
                        )}
                      </span>
                    </span>
                  </label>

                  <RequiredCheckbox binding={binding} onBindingChange={onBindingChange} />
                </fieldset>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default IAssistantSection;
