// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall, getAdminApiErrorMessage } from '../../../../api/adminApi';
import Switch from '../../../../shared/components/Switch';

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
 * iAssistant settings (`app.iassistant`) and the binding's settings
 * (`bindingSettings`: Required and the scope settings).
 *
 * @param {Object} props
 * @param {Object} props.app - the app being edited
 * @param {(app: Object) => void} props.onChange - receives the whole changed app
 * @param {boolean} props.enabled - whether the app uses iAssistant
 * @param {(enabled: boolean) => void} props.onEnabledChange - turns iAssistant on or off
 * @param {React.ReactNode} [props.notice] - e.g. that iAssistant is not installed
 * @param {React.ReactNode} [props.bindingSettings] - the binding's Required and scope settings
 */
function IAssistantSection({
  app,
  onChange,
  enabled,
  onEnabledChange,
  notice = null,
  bindingSettings = null
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
      setAssistants(response.data?.assistants ?? []);
    } catch (err) {
      setAssistantsError(getAdminApiErrorMessage(err));
    } finally {
      setLoadingAssistants(false);
    }
  };

  const handleIAssistantChange = updates => {
    onChange({
      ...app,
      iassistant: {
        ...app.iassistant,
        ...updates
      }
    });
  };

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

              {bindingSettings}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default IAssistantSection;
