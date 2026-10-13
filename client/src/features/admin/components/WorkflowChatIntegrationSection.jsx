import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import {
  automaticChatOutputFor,
  chatIntegrationWarnings,
  primaryOutputOptions
} from '../../workflows/utils/chatIntegration';

const OUTPUT_FORMATS = ['markdown', 'text', 'json'];

const inputClass =
  'mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-xs py-2 px-3 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm';

/**
 * Edits a workflow's `chatIntegration` block: whether the workflow is offered
 * in chat, which output is the answer, its format and the description the
 * app's model sees.
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
 */
function WorkflowChatIntegrationSection({ workflow, onChange, assignedApps = null }) {
  const { t } = useTranslation();
  const chat = workflow?.chatIntegration || {};
  const enabled = chat.enabled === true;
  const primaryOutput = typeof chat.primaryOutput === 'string' ? chat.primaryOutput : '';

  const options = useMemo(() => primaryOutputOptions(workflow), [workflow]);
  const automatic = useMemo(() => automaticChatOutputFor(workflow), [workflow]);
  const warnings = useMemo(
    () => chatIntegrationWarnings(workflow, { assignedApps: assignedApps || [] }),
    [workflow, assignedApps]
  );
  // A value set in the JSON that the end node does not pass on (or a dotted
  // path) stays selectable, so opening the page never rewrites it.
  const showCustomValue = primaryOutput && !options.some(o => o.value === primaryOutput);

  const warningText = warning => {
    switch (warning.code) {
      case 'assignedButDisabled':
        return t(
          'admin.workflows.chatIntegration.warnings.assignedButDisabled',
          'This workflow is assigned to the apps {{apps}}, but it is not available in chat, so it does not appear there.',
          warning.params
        );
      case 'primaryOutputUnknown':
        return t(
          'admin.workflows.chatIntegration.warnings.primaryOutputUnknown',
          'The end step does not pass on "{{name}}". The chat will show a fallback field or JSON instead.',
          warning.params
        );
      case 'endNodeFormatsOutput':
        return t(
          'admin.workflows.chatIntegration.warnings.endNodeFormatsOutput',
          'The end step "{{node}}" formats its output as "{{format}}", so the result shown in chat is ignored.',
          warning.params
        );
      case 'automaticShowsInput':
        return t(
          'admin.workflows.chatIntegration.warnings.automaticShowsInput',
          '"Automatic" shows "{{name}}", which is an input of this workflow, so the chat answers with the user\u2019s own text. Select the result to show, or stop passing the input on in the end step.',
          warning.params
        );
      case 'jsonFallback':
        return t(
          'admin.workflows.chatIntegration.warnings.jsonFallback',
          'No result is selected and no output has a name the chat recognizes, so the run answers with all outputs as JSON. The web chat shows them in the chosen output format; API, MCP and A2A callers receive the JSON.'
        );
      default:
        return warning.code;
    }
  };

  // What "Automatic" does for this workflow right now: the runner's rule,
  // applied to the variables its end step passes on, and how the web chat
  // shows the result in the chosen format (readableWorkflowAnswer()).
  const automaticExplanation = () => {
    if (automatic.mode === 'field') {
      return t(
        'admin.workflows.chatIntegration.automatic.field',
        'Automatic shows "{{name}}", because its name is one the chat treats as the answer (such as report, content or result).',
        { name: automatic.field }
      );
    }
    const format = chat.outputFormat || 'markdown';
    // The web chat leaves engine fields out, as on the execution page.
    const shown = automatic.mode === 'json' ? automatic.keys.filter(k => !k.startsWith('_')) : [];
    if (format === 'json' || shown.length === 0) {
      return t(
        'admin.workflows.chatIntegration.automatic.json',
        'Automatic looks for an output named like report, content or result. None of the outputs of the end step has such a name, so the chat shows the whole output as JSON.'
      );
    }
    if (shown.length === 1) {
      return t(
        'admin.workflows.chatIntegration.automatic.single',
        'Automatic looks for an output named like report, content or result. "{{name}}" is not one, so the run answers with the whole output as JSON; the web chat shows "{{name}}" on its own, the only variable the end step passes on. API, MCP and A2A callers receive the JSON.',
        { name: shown[0] }
      );
    }
    if (format === 'text') {
      return t(
        'admin.workflows.chatIntegration.automatic.lines',
        'Automatic looks for an output named like report, content or result. None of {{names}} is one, so the run answers with the whole output as JSON; the web chat shows each variable as a "name:" line followed by its value. API, MCP and A2A callers receive the JSON.',
        { names: shown.join(', ') }
      );
    }
    return t(
      'admin.workflows.chatIntegration.automatic.sections',
      'Automatic looks for an output named like report, content or result. None of {{names}} is one, so the run answers with the whole output as JSON; the web chat shows each variable as a section with its name as the heading. API, MCP and A2A callers receive the JSON.',
      { names: shown.join(', ') }
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 mb-6 border border-gray-200 dark:border-gray-700">
      <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
        {t('admin.workflows.chatIntegration.title', 'Chat integration')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t(
          'admin.workflows.chatIntegration.description',
          'How this workflow can be used from the chat of the apps it is assigned to.'
        )}
      </p>

      {warnings.length > 0 && (
        <div className="mb-4 space-y-2" role="status">
          {warnings.map(warning => (
            <div
              key={warning.code}
              className="flex bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-3"
            >
              <Icon name="exclamation-triangle" className="h-4 w-4 text-yellow-400 mt-0.5" />
              <p className="ml-2 text-sm text-yellow-800 dark:text-yellow-300">
                {warningText(warning)}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {/* Available in chat */}
        <div className="sm:col-span-2">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => onChange({ enabled: !enabled })}
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
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.workflows.chatIntegration.enabledHelp',
              'Users can start it with @ in the chat of the apps it is assigned to, and the app’s model can call it as a tool. It is also offered to MCP and A2A clients whose groups may run it.'
            )}
          </p>
          {assignedApps && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {assignedApps.length > 0
                ? t('admin.workflows.chatIntegration.assignedApps', 'Assigned to: {{apps}}', {
                    apps: assignedApps.map(app => app.id).join(', ')
                  })
                : t(
                    'admin.workflows.chatIntegration.noAssignedApps',
                    'Not assigned to any app yet. Assign it under Admin → Apps → Workflows.'
                  )}
            </p>
          )}
        </div>

        {/* Result shown in chat */}
        <div>
          <label
            htmlFor="workflow-primary-output"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('admin.workflows.chatIntegration.primaryOutput', 'Result shown in chat')}
          </label>
          <select
            id="workflow-primary-output"
            value={primaryOutput}
            onChange={e => onChange({ primaryOutput: e.target.value || undefined })}
            className={inputClass}
          >
            <option value="">
              {t('admin.workflows.chatIntegration.primaryOutputAuto', 'Automatic')}
            </option>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label ? `${option.value} — ${option.label}` : option.value}
              </option>
            ))}
            {showCustomValue && <option value={primaryOutput}>{primaryOutput}</option>}
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.workflows.chatIntegration.primaryOutputHelp',
              'Lists the variables the end step passes on.'
            )}
          </p>
          {!primaryOutput && (
            <div className="mt-2 flex rounded-md border border-indigo-100 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-900/20 p-2">
              <Icon name="information-circle" className="h-4 w-4 text-indigo-500 mt-0.5 shrink-0" />
              <p className="ml-2 text-xs text-indigo-800 dark:text-indigo-200">
                {automaticExplanation()}
              </p>
            </div>
          )}
        </div>

        {/* Output format */}
        <div>
          <label
            htmlFor="workflow-output-format"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('admin.workflows.chatIntegration.outputFormat', 'Output format')}
          </label>
          <select
            id="workflow-output-format"
            value={chat.outputFormat || ''}
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
        </div>

        {/* Description for the model */}
        <div className="sm:col-span-2">
          <DynamicLanguageEditor
            label={t(
              'admin.workflows.chatIntegration.toolDescription',
              'Description for the model'
            )}
            value={chat.toolDescription || {}}
            // Kept as typed, empty languages included, so a newly added
            // language can be filled in; empty ones are dropped on save.
            onChange={value =>
              onChange({
                toolDescription: value && Object.keys(value).length > 0 ? value : undefined
              })
            }
            type="textarea"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.workflows.chatIntegration.toolDescriptionHelp',
              'Tells the app’s model when to call this workflow. Leave empty to use the workflow description.'
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export default WorkflowChatIntegrationSection;
