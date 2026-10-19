// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { hasEndOutput } from '../../../../../shared/workflowEndOutput.js';

const isText = value => typeof value === 'string' && value.trim() !== '';

/**
 * The end steps of the workflow that have no output. Every end step needs one:
 * it is the answer of the workflow, which the chat shows as it is.
 *
 * @param {object} workflow - Workflow definition
 * @returns {string[]} The ids of those end steps
 */
export function endStepsWithoutOutput(workflow) {
  return (Array.isArray(workflow?.nodes) ? workflow.nodes : [])
    .filter(node => node?.type === 'end' && !hasEndOutput(node.config?.output))
    .map(node => node.id);
}

/**
 * Configuration problems that make a workflow behave differently in chat
 * than its author expects. None of them blocks saving here: a workflow without
 * an end output is refused by the server when it is saved.
 *
 * @param {object} workflow - Workflow definition
 * @param {object} [context]
 * @param {Array<{id: string}>} [context.assignedApps] - Apps listing this workflow
 * @returns {Array<{code: string, params?: object}>}
 */
export function chatIntegrationWarnings(workflow, { assignedApps = [] } = {}) {
  const warnings = [];
  // Assigned to apps, yet not offered in their chat
  if (!workflow?.chatIntegration?.enabled && assignedApps.length > 0) {
    warnings.push({
      code: 'assignedButDisabled',
      params: { apps: assignedApps.map(app => app.id).join(', ') }
    });
  }
  const withoutOutput = endStepsWithoutOutput(workflow);
  if (withoutOutput.length > 0) {
    warnings.push({ code: 'endWithoutOutput', params: { nodes: withoutOutput.join(', ') } });
  }
  return warnings;
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The languages of a tool description that have text, and whether that is all of them. */
function languagesWithText(description) {
  const entries = Object.entries(description);
  const kept = entries.filter(([, text]) => isText(text));
  return { kept, complete: kept.length === entries.length };
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
  if (!isPlainObject(description)) return workflow;

  const { kept, complete } = languagesWithText(description);
  // `{}` passes the schema but would still replace the workflow description
  // with an empty one, so it is removed as well.
  if (complete && kept.length > 0) return workflow;

  const chatIntegration = { ...workflow.chatIntegration };
  delete chatIntegration.toolDescription;
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
