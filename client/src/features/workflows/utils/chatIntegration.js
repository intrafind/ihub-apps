import { collectUpstreamVariables, workflowToFlow } from '../editor/workflowEditorUtils';
import { automaticChatOutput } from '../../../../../shared/workflowChatOutput.js';

/**
 * End-node output formats that turn the output into something other than an
 * object of named fields, so `primaryOutput` has nothing to look up.
 * Mirrors `formatOutput()` in server/services/workflow/executors/EndNodeExecutor.js.
 */
const FLATTENING_END_FORMATS = new Set(['text', 'raw']);

/**
 * The output keys one end node passes on, in the order of precedence
 * EndNodeExecutor applies: `outputMapping`, `includeFields`, `excludeFields`,
 * `outputVariables`, else every state variable that reaches the node.
 *
 * @param {object} endNode - React Flow end node
 * @param {Array<{value: string, label: string}>} available - Variables visible at the node
 * @returns {Array<{value: string, label: string}>}
 */
function outputKeysOfEndNode(endNode, available) {
  const cfg = endNode.data?.nodeConfig || {};
  const labelOf = name => available.find(v => v.value === name)?.label || '';
  const named = (names, label) =>
    names
      .filter(name => typeof name === 'string' && name.trim())
      .map(name => ({ value: name.trim(), label: label ?? labelOf(name.trim()) }));

  if (cfg.outputMapping && typeof cfg.outputMapping === 'object') {
    return named(Object.keys(cfg.outputMapping), 'output mapping');
  }
  if (Array.isArray(cfg.includeFields)) return named(cfg.includeFields);
  if (Array.isArray(cfg.excludeFields)) {
    const excluded = new Set(cfg.excludeFields);
    return available.filter(v => !excluded.has(v.value));
  }
  if (Array.isArray(cfg.outputVariables)) return named(cfg.outputVariables);
  return available;
}

/**
 * The values `chatIntegration.primaryOutput` can name: the keys of the end
 * node's output, which is where the runner looks the answer up. A variable
 * an earlier step writes but the end node does not pass on is not offered —
 * naming it would silently fall back to the field-name list.
 *
 * A workflow with several end nodes (one per branch) offers the keys of all
 * of them.
 *
 * @param {object} workflow - Workflow definition
 * @returns {Array<{value: string, label: string}>}
 */
export function primaryOutputOptions(workflow) {
  const { nodes, edges } = workflowToFlow(workflow);
  const options = new Map();
  nodes
    .filter(node => node.data?.nodeType === 'end')
    .forEach(endNode => {
      const available = collectUpstreamVariables(nodes, edges, endNode.id);
      outputKeysOfEndNode(endNode, available).forEach(option => {
        if (!options.has(option.value)) options.set(option.value, option);
      });
    });
  return [...options.values()];
}

/**
 * What "Automatic" (no `primaryOutput`) shows in chat for this workflow,
 * decided from the end step's output names the way the runner decides it
 * from the values (`extractReadableOutput()` in server/tools/workflowRunner.js).
 *
 * @param {object} workflow - Workflow definition
 * @returns {{mode: 'field', field: string} | {mode: 'json', keys: string[]} | {mode: 'none'}}
 */
export function automaticChatOutputFor(workflow) {
  return automaticChatOutput(primaryOutputOptions(workflow).map(option => option.value));
}

/**
 * Configuration problems that make a workflow behave differently in chat
 * than its author expects. None of them blocks saving.
 *
 * @param {object} workflow - Workflow definition
 * @param {object} [context]
 * @param {Array<{id: string}>} [context.assignedApps] - Apps listing this workflow
 * @returns {Array<{code: string, params?: object}>}
 */
export function chatIntegrationWarnings(workflow, { assignedApps = [] } = {}) {
  const chat = workflow?.chatIntegration || {};
  const warnings = [];

  if (!chat.enabled) {
    if (assignedApps.length > 0) {
      warnings.push({
        code: 'assignedButDisabled',
        params: { apps: assignedApps.map(app => app.id).join(', ') }
      });
    }
    // The remaining checks are about the answer in chat, which a workflow
    // that is not in chat does not give.
    return warnings;
  }

  const options = primaryOutputOptions(workflow);
  const keys = options.map(option => option.value);
  const primaryOutput = typeof chat.primaryOutput === 'string' ? chat.primaryOutput.trim() : '';

  if (primaryOutput) {
    // A dotted path (`_report.markdown`) names a field inside an output.
    const root = primaryOutput.split('.')[0];
    if (!keys.includes(root)) {
      warnings.push({ code: 'primaryOutputUnknown', params: { name: primaryOutput } });
    }
    const flattening = (workflow.nodes || []).find(
      node => node.type === 'end' && FLATTENING_END_FORMATS.has(node.config?.outputFormat)
    );
    if (flattening) {
      warnings.push({
        code: 'endNodeFormatsOutput',
        params: { node: flattening.id, format: flattening.config.outputFormat }
      });
    }
  } else {
    const automatic = automaticChatOutput(keys);
    const inputs = new Set(
      (workflow.nodes || [])
        .filter(n => n.type === 'start')
        .flatMap(n => n.config?.inputVariables || [])
        .map(v => v?.name)
    );
    if (automatic.mode !== 'field') {
      warnings.push({ code: 'jsonFallback' });
    } else if (inputs.has(automatic.field)) {
      // `text` is a conventional answer name and a common input name: an end
      // step that passes the input on answers with the user's own text.
      warnings.push({ code: 'automaticShowsInput', params: { name: automatic.field } });
    }
  }

  return warnings;
}

/**
 * The workflow with the empty languages of `chatIntegration.toolDescription`
 * removed, and the description itself removed when no text is left.
 *
 * The form lets a language be added before its text is typed, but the schema
 * rejects an empty localized string, and an empty description would reach
 * the model as the tool's description. So the clean-up happens on save, not
 * while editing.
 *
 * @param {object} workflow - Workflow definition about to be saved
 * @returns {object} The same workflow when there is nothing to clean up
 */
export function withCleanToolDescription(workflow) {
  const description = workflow?.chatIntegration?.toolDescription;
  if (!description || typeof description !== 'object' || Array.isArray(description)) {
    return workflow;
  }
  const kept = Object.entries(description).filter(
    ([, text]) => typeof text === 'string' && text.trim()
  );
  // `{}` passes the schema but would still replace the workflow description
  // with an empty one, so it is removed as well.
  if (kept.length > 0 && kept.length === Object.keys(description).length) return workflow;

  const chatIntegration = { ...workflow.chatIntegration };
  if (kept.length > 0) chatIntegration.toolDescription = Object.fromEntries(kept);
  else delete chatIntegration.toolDescription;
  return { ...workflow, chatIntegration };
}

/**
 * The apps whose `workflows` list names this workflow. Matched without regard
 * to case, as the server resolves workflow ids.
 *
 * @param {Array<object>} apps - App configurations
 * @param {string} workflowId
 * @returns {Array<object>}
 */
export function appsUsingWorkflow(apps, workflowId) {
  if (!workflowId || !Array.isArray(apps)) return [];
  const wanted = workflowId.toLowerCase();
  return apps.filter(
    app =>
      Array.isArray(app?.workflows) &&
      app.workflows.some(id => typeof id === 'string' && id.toLowerCase() === wanted)
  );
}
