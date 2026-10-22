// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The planner's sub-workflow keeps the profile's project links (#1036):
 * a task that names a subset of the linked projects keeps each link's mode
 * and write permission, and the dynamic drain worker carries the links too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SubWorkflowMaterializer } from '../services/workflow/SubWorkflowMaterializer.js';

const taskTemplate = {
  system: { en: 'Be useful.' },
  tools: ['web_search'],
  projects: ['faq', { id: 'docs', mode: 'tools', write: true }]
};

/** The node with `id` anywhere inside a (nested) node definition. */
function findNode(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.id === id && node.type) return node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findNode(entry, id);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findNode(value, id);
      if (found) return found;
    }
  }
  return null;
}

describe('sub-workflow project links', () => {
  it('resolves the projects a task names back to the template links', () => {
    const plan = {
      tasks: [
        { id: 't1', title: 'Write', description: 'Write the memo', projects: ['docs'] },
        { id: 't2', title: 'Read', description: 'Read the FAQ' },
        { id: 't3', title: 'None', description: 'No knowledge', projects: [] }
      ]
    };
    const { nodes } = SubWorkflowMaterializer.materialize(plan, { taskTemplate }, 0);
    const task = id => nodes.find(node => node.id === id)?.config?.projects;
    assert.deepEqual(task('t1'), [{ id: 'docs', mode: 'tools', write: true }]);
    assert.deepEqual(task('t2'), ['faq', { id: 'docs', mode: 'tools', write: true }]);
    assert.deepEqual(task('t3'), []);
  });

  it('gives the dynamic drain worker the template projects', () => {
    const plan = { tasks: [{ id: 't1', title: 'T', description: 'd' }] };
    const { nodes } = SubWorkflowMaterializer.materialize(
      plan,
      { taskTemplate, dynamicTasks: { enabled: true } },
      0
    );
    const drain = nodes.find(node => node.id === 'drain');
    assert.ok(drain, 'the drain loop exists when dynamic tasks are on');
    const runner = JSON.stringify(drain).includes('drain-task-runner')
      ? findNode(drain, 'drain-task-runner')
      : null;
    assert.ok(runner, 'the drain worker sits inside the loop');
    assert.deepEqual(runner.config.projects, taskTemplate.projects);
    assert.deepEqual(runner.config.tools, ['web_search']);
  });
});
