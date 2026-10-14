import { collectUpstreamVariables, workflowToFlow } from '../editor/workflowEditorUtils';
import { automaticChatOutput } from '../../../../../shared/workflowChatOutput.js';

/**
 * How an end node builds its output, in the order of precedence
 * EndNodeExecutor applies: `outputMapping`, `includeFields`, `excludeFields`,
 * `outputVariables`, else every state variable that reaches the node.
 * `explicit` says whether the keys are fixed by the configuration; when they
 * are not, the output also carries input and engine fields at run time.
 */
const END_OUTPUT_RULES = [
  {
    applies: cfg => cfg.outputMapping && typeof cfg.outputMapping === 'object',
    keys: (cfg, named) => named(Object.keys(cfg.outputMapping)),
    explicit: true
  },
  {
    applies: cfg => Array.isArray(cfg.includeFields),
    keys: (cfg, named) => named(cfg.includeFields),
    explicit: true
  },
  {
    applies: cfg => Array.isArray(cfg.excludeFields),
    keys: (cfg, _named, available) => {
      const excluded = new Set(cfg.excludeFields);
      return available.filter(v => !excluded.has(v.value));
    },
    explicit: false
  },
  {
    applies: cfg => Array.isArray(cfg.outputVariables),
    keys: (cfg, named) => named(cfg.outputVariables),
    explicit: true
  }
];

/**
 * Whether an end node's `outputFormat` turns its output into a single value,
 * so there is no named field left to pick. Mirrors `formatOutput()` in
 * server/services/workflow/executors/EndNodeExecutor.js: `text` always yields
 * text; `raw` yields the value only of an output with exactly one key —
 * `includeNodeOutputs` and `includeMetadata` add a key each.
 */
function flattens(cfg, keys, explicit) {
  if (cfg.outputFormat === 'text') return true;
  if (cfg.outputFormat !== 'raw' || !explicit) return false;
  const extraKeys = (cfg.includeNodeOutputs ? 1 : 0) + (cfg.includeMetadata ? 1 : 0);
  return keys.length + extraKeys === 1;
}

/**
 * What one end node passes on: its output keys and whether its output format
 * flattens them into a single value.
 *
 * @param {object} endNode - React Flow end node
 * @param {Array<{value: string, label: string}>} available - Variables visible at the node
 * @returns {{id: string, format: string|undefined, keys: Array<{value: string, label: string}>, flattens: boolean}}
 */
function describeEndNode(endNode, available) {
  const cfg = endNode.data?.nodeConfig || {};
  const labelOf = name => available.find(v => v.value === name)?.label || '';
  const named = names =>
    names
      .filter(name => typeof name === 'string' && name.trim())
      .map(name => ({ value: name.trim(), label: labelOf(name.trim()) }));
  const rule = END_OUTPUT_RULES.find(r => r.applies(cfg));
  const keys = rule ? rule.keys(cfg, named, available) : available;
  return {
    id: endNode.id,
    format: cfg.outputFormat,
    keys,
    flattens: flattens(cfg, keys, Boolean(rule?.explicit))
  };
}

/** Every end node of the workflow, described. */
function endNodesOf(workflow) {
  const { nodes, edges } = workflowToFlow(workflow);
  return nodes
    .filter(node => node.data?.nodeType === 'end')
    .map(endNode => describeEndNode(endNode, collectUpstreamVariables(nodes, edges, endNode.id)));
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
  const options = new Map();
  endNodesOf(workflow).forEach(end =>
    end.keys.forEach(option => {
      if (!options.has(option.value)) options.set(option.value, option);
    })
  );
  return [...options.values()];
}

/**
 * What "Automatic" (no `primaryOutput`) shows in chat for this workflow,
 * decided from the end step's configuration the way the runner decides it
 * from the values (`chatAnswerOf()` in shared/workflowChatOutput.js). An end
 * step that flattens its output answers with that single value.
 *
 * @param {object} workflow - Workflow definition
 * @returns {{mode: 'flattened', node: string, format: string} | {mode: 'field', field: string} | {mode: 'json', keys: string[]} | {mode: 'none'}}
 */
export function automaticChatOutputFor(workflow) {
  const ends = endNodesOf(workflow);
  const flattening = ends.find(end => end.flattens);
  if (flattening) return { mode: 'flattened', node: flattening.id, format: flattening.format };
  return automaticChatOutput(primaryOutputOptions(workflow).map(option => option.value));
}

function assignmentWarnings(assignedApps) {
  if (assignedApps.length === 0) return [];
  return [
    { code: 'assignedButDisabled', params: { apps: assignedApps.map(app => app.id).join(', ') } }
  ];
}

function selectionWarnings(primaryOutput, keys, flattening) {
  const warnings = [];
  // A dotted path (`_report.markdown`) names a field inside an output.
  if (!keys.includes(primaryOutput.split('.')[0])) {
    warnings.push({ code: 'primaryOutputUnknown', params: { name: primaryOutput } });
  }
  if (flattening) {
    warnings.push({
      code: 'endNodeFormatsOutput',
      params: { node: flattening.id, format: flattening.format }
    });
  }
  return warnings;
}

function automaticWarnings(workflow, keys) {
  const automatic = automaticChatOutput(keys);
  if (automatic.mode !== 'field') return [{ code: 'jsonFallback' }];
  const inputs = new Set(
    (workflow.nodes || [])
      .filter(n => n.type === 'start')
      .flatMap(n => n.config?.inputVariables || [])
      .map(v => v?.name)
  );
  // `text` is a conventional answer name and a common input name: an end
  // step that passes the input on answers with the user's own text.
  return inputs.has(automatic.field)
    ? [{ code: 'automaticShowsInput', params: { name: automatic.field } }]
    : [];
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
  // The other checks are about the answer in chat, which a workflow that is
  // not in chat does not give.
  if (!chat.enabled) return assignmentWarnings(assignedApps);

  const ends = endNodesOf(workflow);
  const flattening = ends.find(end => end.flattens);
  const keys = primaryOutputOptions(workflow).map(option => option.value);
  const primaryOutput = typeof chat.primaryOutput === 'string' ? chat.primaryOutput.trim() : '';
  if (primaryOutput) return selectionWarnings(primaryOutput, keys, flattening);
  // A flattened output is the answer as it is; Automatic picks nothing.
  return flattening ? [] : automaticWarnings(workflow, keys);
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
  const entries = Object.entries(description);
  const kept = entries.filter(([, text]) => typeof text === 'string' && text.trim());
  // `{}` passes the schema but would still replace the workflow description
  // with an empty one, so it is removed as well.
  if (kept.length > 0 && kept.length === entries.length) return workflow;

  const { toolDescription: _dropped, ...chatIntegration } = workflow.chatIntegration;
  return {
    ...workflow,
    chatIntegration:
      kept.length > 0
        ? { ...chatIntegration, toolDescription: Object.fromEntries(kept) }
        : chatIntegration
  };
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
