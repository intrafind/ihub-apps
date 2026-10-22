// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The planner's sub-workflow keeps the profile's project links (#1036):
 * a task that names a subset of the linked projects keeps each link's mode
 * and write permission, and the dynamic drain worker carries the links too.
 * The parent run's project inputs reach every task and the drain worker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SubWorkflowMaterializer } from '../services/workflow/SubWorkflowMaterializer.js';
import { projectInputLinks } from '../services/workflow/projectNodes.js';

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

  it('drops planner-selected projects the template does not link', () => {
    // A planner answer naming `other-project` (or a link object the model
    // made up, with its own mode and write flag) must never reach the task:
    // only the template's own links are resolved.
    const plan = {
      tasks: [
        {
          id: 't1',
          title: 'Injected',
          description: 'Use everything',
          projects: [
            'other-project',
            { id: 'secret', mode: 'context', write: true },
            { id: 'faq', mode: 'context', write: true }
          ]
        },
        { id: 't2', title: 'Unknown only', description: 'd', projects: ['other-project'] }
      ]
    };
    const { nodes } = SubWorkflowMaterializer.materialize(plan, { taskTemplate }, 0);
    const task = id => nodes.find(node => node.id === id)?.config?.projects;
    assert.deepEqual(task('t1'), ['faq']);
    assert.deepEqual(task('t2'), []);
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

  it("adds the parent run's project inputs to every task, after the task's own links", () => {
    // The parent workflow declares two project inputs; the child gets their
    // links, since its own start node declares none.
    const parent = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          config: {
            inputVariables: [
              { name: 'case', type: 'project' },
              { name: 'library', type: 'project' },
              { name: 'topic', type: 'string' }
            ]
          }
        }
      ]
    };
    const inputProjects = projectInputLinks(parent, {
      data: { case: 'prj_case', library: 'docs', topic: 'Lease' }
    });
    const caseLink = { id: 'prj_case', mode: 'auto', write: false };
    const plan = {
      tasks: [
        { id: 't1', title: 'Write', description: 'Write the memo', projects: ['docs'] },
        { id: 't2', title: 'Read', description: 'Read the FAQ' },
        { id: 't3', title: 'None', description: 'No configured knowledge', projects: [] }
      ]
    };
    const { nodes } = SubWorkflowMaterializer.materialize(
      plan,
      { taskTemplate, dynamicTasks: { enabled: true } },
      0,
      { inputProjects }
    );
    const task = id => findNode({ nodes }, id)?.config?.projects;
    // `docs` is both a template link and an input: the task's link (with its
    // write grant) comes first and wins.
    assert.deepEqual(task('t1'), [{ id: 'docs', mode: 'tools', write: true }, caseLink]);
    assert.deepEqual(task('t2'), ['faq', { id: 'docs', mode: 'tools', write: true }, caseLink]);
    assert.deepEqual(task('t3'), [caseLink, { id: 'docs', mode: 'auto', write: false }]);
    assert.deepEqual(task('drain-task-runner'), [...taskTemplate.projects, caseLink]);
  });
});
