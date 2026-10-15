import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { chatIntegrationWarnings } from '../../workflows/utils/chatIntegration';

const OUTPUT_FORMATS = ['markdown', 'text', 'json'];

const inputClass =
  'mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-xs py-2 px-3 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300';
const helpClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/** Translation key and English default per warning code (chatIntegrationWarnings()). */
const WARNING_TEXTS = {
  assignedButDisabled: [
    'admin.workflows.chatIntegration.warnings.assignedButDisabled',
    'This workflow is assigned to the apps {{apps}}, but it is not available in chat, so it does not appear there.'
  ],
  endWithoutOutput: [
    'admin.workflows.chatIntegration.warnings.endWithoutOutput',
    'The end step {{nodes}} has no output. The workflow cannot be saved, and a run that reaches that step fails, until you set its Output in the visual editor.'
  ]
};

function WarningList({ warnings }) {
  const { t } = useTranslation();
  if (warnings.length === 0) return null;
  return (
    <output className="mb-4 block space-y-2">
      {warnings.map(warning => {
        const [key, fallback] = WARNING_TEXTS[warning.code] || [warning.code, warning.code];
        return (
          <div
            key={warning.code}
            className="flex bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-3"
          >
            <Icon name="exclamation-triangle" className="h-4 w-4 text-yellow-400 mt-0.5" />
            <p className="ml-2 text-sm text-yellow-800 dark:text-yellow-300">
              {t(key, fallback, warning.params)}
            </p>
          </div>
        );
      })}
    </output>
  );
}

function AvailableInChat({ enabled, onToggle, assignedApps }) {
  const { t } = useTranslation();
  const assignment =
    assignedApps &&
    (assignedApps.length > 0
      ? t('admin.workflows.chatIntegration.assignedApps', 'Assigned to: {{apps}}', {
          apps: assignedApps.map(app => app.id).join(', ')
        })
      : t(
          'admin.workflows.chatIntegration.noAssignedApps',
          'Not assigned to any app yet. Assign it under Admin → Apps → Workflows.'
        ));
  return (
    <div className="sm:col-span-2">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
            enabled ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
          }`}
          role="switch"
          aria-checked={enabled}
          aria-labelledby="workflow-chat-enabled-label"
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
        <span
          id="workflow-chat-enabled-label"
          className="ml-3 text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {t('admin.workflows.chatIntegration.enabled', 'Available in chat')}
        </span>
      </div>
      <p className={helpClass}>
        {t(
          'admin.workflows.chatIntegration.enabledHelp',
          'Users can start it with @ in the chat of the apps it is assigned to, and the app’s model can call it as a tool. It is also offered to MCP and A2A clients whose groups may run it.'
        )}
      </p>
      {assignment && <p className={helpClass}>{assignment}</p>}
    </div>
  );
}

function OutputFormatField({ value, onChange }) {
  const { t } = useTranslation();
  return (
    <div>
      <label htmlFor="workflow-output-format" className={labelClass}>
        {t('admin.workflows.chatIntegration.outputFormat', 'Output format')}
      </label>
      <select
        id="workflow-output-format"
        value={value || ''}
        onChange={e => onChange({ outputFormat: e.target.value || undefined })}
        className={inputClass}
      >
        <option value="">
          {t('admin.workflows.chatIntegration.outputFormatDefault', 'Default (Markdown)')}
        </option>
        {OUTPUT_FORMATS.map(format => (
          <option key={format} value={format}>
            {t(`admin.workflows.chatIntegration.formats.${format}`, format)}
          </option>
        ))}
      </select>
      <p className={helpClass}>
        {t(
          'admin.workflows.chatIntegration.outputFormatHelp',
          'How the chat shows the answer. An answer that is JSON is always shown as JSON.'
        )}
      </p>
    </div>
  );
}

function ToolDescriptionField({ value, onChange }) {
  const { t } = useTranslation();
  return (
    <div className="sm:col-span-2">
      <DynamicLanguageEditor
        label={t('admin.workflows.chatIntegration.toolDescription', 'Description for the model')}
        value={value || {}}
        // Kept as typed, empty languages included, so a newly added language
        // can be filled in; empty ones are dropped on save.
        onChange={next =>
          onChange({ toolDescription: next && Object.keys(next).length > 0 ? next : undefined })
        }
        type="textarea"
      />
      <p className={helpClass}>
        {t(
          'admin.workflows.chatIntegration.toolDescriptionHelp',
          'Tells the app’s model when to call this workflow. Leave empty to use the workflow description.'
        )}
      </p>
    </div>
  );
}

/**
 * Edits a workflow's `chatIntegration` block: whether the workflow is offered
 * in chat, how the answer is shown and the description the app's model sees.
 * What the answer is needs no setting here: it is the Output of the end step.
 *
 * `passthroughResult` is deliberately not offered: no code reads it — a
 * workflow called from chat always streams its answer as-is. It stays in the
 * JSON untouched.
 *
 * @param {object} props
 * @param {object} props.workflow - The workflow definition being edited
 * @param {(patch: object) => void} props.onChange - Merges `patch` into
 *   `chatIntegration`; a key set to `undefined` is removed
 * @param {Array<{id: string, name?: object}>} [props.assignedApps] - Apps that
 *   list this workflow, or null while unknown
 * @param {boolean} [props.disabled] - True while the JSON editor holds invalid
 *   JSON: changes here would be applied to the last valid version and
 *   overwrite what was typed there
 */
function WorkflowChatIntegrationSection({
  workflow,
  onChange,
  assignedApps = null,
  disabled = false
}) {
  const { t } = useTranslation();
  const chat = workflow?.chatIntegration || {};
  const warnings = useMemo(
    () => chatIntegrationWarnings(workflow, { assignedApps: assignedApps || [] }),
    [workflow, assignedApps]
  );

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 mb-6 border border-gray-200 dark:border-gray-700">
      <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
        {t('admin.workflows.chatIntegration.title', 'Chat integration')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t(
          'admin.workflows.chatIntegration.description',
          'How this workflow can be used from the chat of the apps it is assigned to. The chat shows the Output of its end step as the answer.'
        )}
      </p>
      <WarningList warnings={warnings} />
      {disabled && (
        <p className="mb-4 text-sm text-yellow-800 dark:text-yellow-300">
          {t(
            'admin.workflows.chatIntegration.jsonInvalid',
            'Fix the JSON below to change these settings.'
          )}
        </p>
      )}
      <fieldset
        disabled={disabled}
        className="grid min-w-0 grid-cols-1 gap-6 sm:grid-cols-2 disabled:opacity-60"
      >
        <AvailableInChat
          enabled={chat.enabled === true}
          onToggle={() => onChange({ enabled: chat.enabled !== true })}
          assignedApps={assignedApps}
        />
        <OutputFormatField value={chat.outputFormat} onChange={onChange} />
        <ToolDescriptionField value={chat.toolDescription} onChange={onChange} />
      </fieldset>
    </div>
  );
}

export default WorkflowChatIntegrationSection;
