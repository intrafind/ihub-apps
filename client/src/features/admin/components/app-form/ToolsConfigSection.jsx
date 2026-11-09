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

const TOOL_SEARCH_INPUT_CLASS =
  'mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm';

/**
 * Tool search (the platform's `toolSearch` feature): when the tools of the
 * integrations this app binds are too many for one request, the biggest
 * integrations are listed in the prompt and found by the model with a search
 * instead of being sent in full. Per app: switch it off, or set how many
 * tokens of tool definitions one request may take. An integration that must
 * always be sent in full is set on its binding ("Always loaded").
 */
function ToolSearchSettings({ toolSearch, onChange }) {
  const { t } = useTranslation();
  const setField = patch => {
    const next = { ...toolSearch, ...patch };
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined || patch[key] === '') delete next[key];
    }
    if (next.mode === 'auto') delete next.mode;
    onChange(Object.keys(next).length ? next : undefined);
  };
  const off = toolSearch?.mode === 'off';
  return (
    <div className="mt-6">
      <label
        htmlFor="app-tool-search"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        {t('admin.apps.edit.toolSearch', 'Tool search')}
      </label>
      <select
        id="app-tool-search"
        value={off ? 'off' : 'auto'}
        onChange={e => setField({ mode: e.target.value })}
        className={TOOL_SEARCH_INPUT_CLASS}
        aria-describedby="app-tool-search-help"
      >
        <option value="auto">{t('admin.apps.edit.toolSearchAuto', 'Automatic (default)')}</option>
        <option value="off">{t('admin.apps.edit.toolSearchOff', 'Off: send every tool')}</option>
      </select>
      <p id="app-tool-search-help" className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.toolSearchHelp',
          'When the tools of this app are too many for one request, the biggest integrations are left out and listed in the prompt; the model finds a tool with search_tools and runs it with call_tool. Keeps requests small and tool choice sharp. Set "Always loaded" on an integration to keep it out of the search.'
        )}
      </p>
      {!off && (
        <div className="mt-3">
          <label
            htmlFor="app-tool-search-budget"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('admin.apps.edit.toolSearchBudget', 'Token budget for tool definitions')}
          </label>
          <input
            id="app-tool-search-budget"
            type="number"
            min={500}
            max={100000}
            step={500}
            value={toolSearch?.maxToolTokens ?? ''}
            onChange={e =>
              setField({
                maxToolTokens: e.target.value === '' ? undefined : Number(e.target.value)
              })
            }
            placeholder="6000"
            className={TOOL_SEARCH_INPUT_CLASS}
            aria-describedby="app-tool-search-budget-help"
          />
          <p
            id="app-tool-search-budget-help"
            className="mt-1 text-sm text-gray-500 dark:text-gray-400"
          >
            {t(
              'admin.apps.edit.toolSearchBudgetHelp',
              "Tokens the tool definitions of one request may take before integrations are left to the search. Default 6000; never more than a tenth of the model's context window."
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function ToolsConfigSection({
  toolChoice,
  onToolChoiceChange,
  toolApproval,
  onToolApprovalChange,
  toolSearch,
  onToolSearchChange
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
          {onToolSearchChange && (
            <ToolSearchSettings toolSearch={toolSearch} onChange={onToolSearchChange} />
          )}
        </div>
      </div>
    </div>
  );
}

export default ToolsConfigSection;
