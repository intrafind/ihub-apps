// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { ApprovalModeSelect } from '../ToolApprovalFields';

/** Whether the model decides to use the app's tools or must call one first. */
function ToolChoiceSelect({ toolChoice, onChange }) {
  const { t } = useTranslation();

  return (
    <div>
      <label
        htmlFor="app-tool-choice"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        {t('admin.apps.edit.toolChoice', 'Tool use')}
      </label>
      <select
        id="app-tool-choice"
        value={toolChoice || 'auto'}
        onChange={e => onChange(e.target.value === 'auto' ? undefined : e.target.value)}
        className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        aria-describedby="app-tool-choice-help"
      >
        <option value="auto">
          {t('admin.apps.edit.toolChoiceAuto', 'Model decides (default)')}
        </option>
        <option value="required">
          {t('admin.apps.edit.toolChoiceRequired', 'Use a tool first')}
        </option>
      </select>
      <p id="app-tool-choice-help" className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.toolChoiceRequiredHelp',
          "The first answer step of every message must call one of the app's tools; the model can then answer from the result. Not every model can be forced by the provider - for those the model is asked in words instead."
        )}
      </p>
    </div>
  );
}

/**
 * The app's tool approval override (#2945): it can only make the admin's
 * settings stricter, so the choices are "no override", "ask unless it only
 * reads" and "always ask". Per-tool overrides (`toolApproval.tools`) are kept
 * as they are and edited in the JSON.
 */
function ToolApprovalOverride({ toolApproval, onChange }) {
  const { t } = useTranslation();
  const setDefault = mode => {
    const next = { ...(toolApproval || {}) };
    if (mode) next.default = mode;
    else delete next.default;
    if (next.tools && Object.keys(next.tools).length === 0) delete next.tools;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="mt-6">
      <ApprovalModeSelect
        label={t('admin.apps.edit.toolApproval', 'Approval before tool calls')}
        value={toolApproval?.default}
        inheritLabel={t('admin.apps.edit.toolApprovalInherit', 'As the admin settings (default)')}
        modes={['writes', 'always']}
        onChange={setDefault}
        help={t(
          'admin.apps.edit.toolApprovalHelp',
          'Makes the approval stricter for this app. It can never relax the platform, tool or integration settings: a looser value is ignored.'
        )}
      />
    </div>
  );
}

function ToolsConfigSection({
  toolChoice,
  onToolChoiceChange,
  toolApproval,
  onToolApprovalChange
}) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.tools', 'Tools')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.toolsDesc',
              'How the model uses the tools of the integrations this app binds'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2">
          <ToolChoiceSelect toolChoice={toolChoice} onChange={onToolChoiceChange} />
          {onToolApprovalChange && (
            <ToolApprovalOverride toolApproval={toolApproval} onChange={onToolApprovalChange} />
          )}
        </div>
      </div>
    </div>
  );
}

export default ToolsConfigSection;
