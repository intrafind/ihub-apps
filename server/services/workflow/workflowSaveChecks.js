// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Checks a workflow must pass before it is saved, beyond its schema: settings
 * the schema accepts but no run can get past.
 *
 * Only the save routes (`POST /api/workflows`, `PUT /api/workflows/{id}`)
 * apply them. Loading a stored workflow does not, so a file that already
 * holds such a step still loads and can be fixed in the editor.
 *
 * @module services/workflow/workflowSaveChecks
 */

/** A step's name for a message: its English name, any name, or its id. */
function stepLabel(node) {
  const name = node?.name;
  if (typeof name === 'string' && name.trim()) return name;
  if (name && typeof name === 'object') {
    const text = name.en || Object.values(name).find(v => typeof v === 'string' && v.trim());
    if (text) return text;
  }
  return node?.id || 'unnamed';
}

/**
 * "Ask a Person" (`human`) steps with an empty `options` list (AX-B4). The
 * person is offered no button, the answer form cannot be sent, and the run
 * waits until it is cancelled or times out. A step without `options` is fine:
 * the engine offers a single "Continue" then.
 *
 * @param {Object} workflow - A workflow definition that passed the schema.
 * @returns {Array<{path: string, code: string, message: string}>} One issue per
 *   such step, `path` pointing at its `options` (`nodes.3.config.options`).
 *
 * @example
 * findUnanswerableHumanSteps({ nodes: [{ id: 'ok', type: 'human', name: { en: 'Approve' }, config: { options: [] } }] });
 * // → [{ path: 'nodes.0.config.options', code: 'too_small', message: 'Step "Approve" …' }]
 */
export function findUnanswerableHumanSteps(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const issues = [];
  nodes.forEach((node, index) => {
    if (node?.type !== 'human') return;
    const options = node.config?.options;
    if (!Array.isArray(options) || options.length > 0) return;
    issues.push({
      path: `nodes.${index}.config.options`,
      code: 'too_small',
      message: `Step "${stepLabel(node)}" (Ask a Person) needs at least one option. Without one, nobody can answer it and the run waits until it is cancelled.`
    });
  });
  return issues;
}
