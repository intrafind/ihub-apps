// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an answer is based on (`run/ended.answerBasis`): the server names the
 * kinds of source, the chat draws them. A project counts only when it
 * contributed (`knowledge/scope.projects[].contributed`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerBasisOf,
  boundAnswerBasis,
  projectIdsReadBy,
  settleKnowledgeScope
} from '../services/chat/answerBasis.js';
import { scopeSummary } from '../services/knowledge/KnowledgeScopePlanner.js';
import { knowledgeSourceSeam } from '../services/loop/seams/knowledgeSourceSeam.js';
import { toolDisplayOf } from '../utils/toolDisplay.js';
import { integrationLabelOf } from '../utils/toolIntegrationLabel.js';

test('a project alone is the kind Project, never "configured sources"', () => {
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['project'] }), [{ kind: 'project' }]);
  // `sources` keeps only what an admin configured.
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['sources'] }), [{ kind: 'documents' }]);
});

test('project and web search are two kinds, the project first', () => {
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['websearch', 'project'] }), [
    { kind: 'project' },
    { kind: 'web' }
  ]);
});

test('the provider’s own search (grounding) is the web as well, once', () => {
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['grounding', 'websearch'] }), [
    { kind: 'web' }
  ]);
});

test('every source maps onto one kind; the model marker is not a source', () => {
  assert.deepEqual(
    answerBasisOf({
      knowledgeSources: ['audio', 'file', 'email', 'iassistant', 'ifinder', 'llm', 'unknown']
    }),
    [
      { kind: 'ifinder' },
      { kind: 'iassistant' },
      { kind: 'email' },
      { kind: 'file' },
      { kind: 'audio' }
    ]
  );
});

test('each connected system is an entry of its own, named by its label', () => {
  assert.deepEqual(
    answerBasisOf({
      knowledgeSources: ['integration', 'project'],
      integrations: ['Jira', 'Munich AD', 'Jira']
    }),
    [
      { kind: 'project' },
      { kind: 'integration', label: 'Jira' },
      { kind: 'integration', label: 'Munich AD' }
    ]
  );
  // A system without a name is one unnamed entry.
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['integration'], integrations: [''] }), [
    { kind: 'integration' }
  ]);
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['integration'] }), [{ kind: 'integration' }]);
});

test('nothing used: the model’s own knowledge, alone', () => {
  assert.deepEqual(answerBasisOf({ knowledgeSources: [] }), [{ kind: 'model' }]);
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['llm'] }), [{ kind: 'model' }]);
  assert.deepEqual(answerBasisOf(), [{ kind: 'model' }]);
});

test('a passthrough answer is the tool’s output: it has a basis only when it used something', () => {
  assert.deepEqual(answerBasisOf({ knowledgeSources: [], byModel: false }), []);
  assert.deepEqual(answerBasisOf({ knowledgeSources: ['websearch'], byModel: false }), [
    { kind: 'web' }
  ]);
});

test('a stored basis keeps known kinds and bounded labels only', () => {
  assert.equal(boundAnswerBasis(undefined), undefined);
  assert.equal(boundAnswerBasis([{ kind: 'nope' }]), undefined);
  assert.deepEqual(
    boundAnswerBasis([
      { kind: 'project', label: 'ignored: only an integration has a label' },
      { kind: 'integration', label: `  ${'x'.repeat(500)}  ` },
      { kind: 'web', extra: true }
    ]),
    [{ kind: 'project' }, { kind: 'integration', label: 'x'.repeat(120) }, { kind: 'web' }]
  );
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'integration', label: `S${i}` }));
  assert.equal(boundAnswerBasis(many).length, 12);
});

// ── contributed ────────────────────────────────────────────────────────────

const hit = scope => ({ provider: 'project', ref: { id: 'i1', scope } });

test('scopeSummary: a project whose text went into the prompt contributed, another did not', () => {
  const doc = { id: 'd1', name: 'Doc' };
  const summary = scopeSummary({
    budgetTokens: 1000,
    projects: [
      { id: 'prj_a', name: 'A', mode: 'loaded', injected: [{ doc, text: 'x' }] },
      { id: 'prj_b', name: 'B', mode: 'searched', injected: [] },
      { id: 'prj_c', name: 'C', mode: 'loaded', injected: [] },
      { id: 'ifc_d', name: 'D', mode: 'unavailable', injected: [], reason: 'IFINDER_UNAVAILABLE' }
    ]
  });
  assert.deepEqual(
    summary.projects.map(p => [p.id, p.contributed]),
    [
      ['prj_a', true],
      ['prj_b', false],
      ['prj_c', false],
      ['ifc_d', false]
    ]
  );
});

test('projectIdsReadBy: only project documents a tool handed over count', () => {
  const ids = projectIdsReadBy({
    items: [hit('prj_a'), hit('prj_a'), { provider: 'web' }, { provider: 'project' }]
  });
  assert.deepEqual([...ids], ['prj_a']);
  assert.equal(projectIdsReadBy(null).size, 0);
});

test('settleKnowledgeScope: a search that returned a project’s documents makes it contribute', () => {
  const scope = {
    budgetTokens: 10,
    projects: [
      { id: 'prj_a', mode: 'searched', contributed: false },
      { id: 'prj_b', mode: 'searched', contributed: false },
      { id: 'prj_c', mode: 'loaded', contributed: true },
      { id: 'ifc_d', mode: 'unavailable', contributed: false }
    ]
  };
  const settled = settleKnowledgeScope(scope, { items: [hit('prj_a'), hit('ifc_d')] });
  assert.notEqual(settled, scope);
  assert.deepEqual(
    settled.projects.map(p => [p.id, p.contributed]),
    [
      ['prj_a', true],
      ['prj_b', false],
      ['prj_c', true],
      ['ifc_d', false]
    ],
    'an unavailable project cannot contribute'
  );
  assert.equal(scope.projects[0].contributed, false, 'the reported scope is not changed');
  assert.equal(
    settleKnowledgeScope(scope, { items: [] }),
    scope,
    'nothing changed: the same object'
  );
  assert.equal(settleKnowledgeScope(null, { items: [hit('prj_a')] }), null);
});

// ── the seam ──────────────────────────────────────────────────────────────

function runSeam(toolId, toolDef, outcome) {
  const added = [];
  const integrations = [];
  knowledgeSourceSeam.postTool(
    {
      addKnowledgeSource: source => added.push(source),
      addIntegration: label => integrations.push(label)
    },
    { toolId, toolDef },
    outcome
  );
  return { added, integrations };
}

test('seam: a project search counts as a project only when it returned a project document', () => {
  const found = runSeam('knowledge_search', undefined, {
    sources: { items: [hit('prj_a')], queries: ['q'] }
  });
  assert.deepEqual(found.added, ['project']);
  // Found nothing, was only a listing, or failed: the answer does not rest on a project.
  assert.deepEqual(
    runSeam('knowledge_search', undefined, { sources: { items: [], queries: ['q'] } }).added,
    []
  );
  assert.deepEqual(runSeam('knowledge_list', undefined, {}).added, []);
  assert.deepEqual(
    runSeam('knowledge_read', undefined, { error: 'boom', sources: { items: [hit('prj_a')] } })
      .added,
    []
  );
});

test('seam: a connected system is recorded by its own label', () => {
  const ok = { message: { role: 'tool', content: '{"issues":[]}' } };
  assert.deepEqual(
    runSeam('jira__search', { _integration: { definition: 'd', instanceLabel: 'Jira' } }, { ...ok })
      .integrations,
    ['Jira']
  );
  assert.deepEqual(
    runSeam('gh__search', { _mcp: { serverId: 'gh', serverName: 'GitHub' } }, { ...ok })
      .integrations,
    ['GitHub']
  );
  assert.deepEqual(runSeam('agent__skill', { _a2a: { agentId: 'a1' } }, { ...ok }).integrations, [
    'a1'
  ]);
  // No name known: still recorded, unnamed.
  assert.deepEqual(runSeam('x__y', { _integration: { definition: 'd' } }, { ...ok }).integrations, [
    ''
  ]);
  // A failed call informed nobody, so it names nobody.
  assert.deepEqual(
    runSeam(
      'jira__search',
      { _integration: { definition: 'd', instanceLabel: 'Jira' } },
      {
        message: { role: 'tool', content: '{"error":true,"message":"down"}' }
      }
    ).integrations,
    []
  );
});

test('the basis names a system the way the activity row does', () => {
  const defs = [
    { id: 'a', _integration: { definition: 'd', instanceLabel: ' Munich AD ' } },
    { id: 'b', _mcp: { serverId: 'srv' } },
    { id: 'c', _a2a: { agentName: 'Planner', agentId: 'p1' } }
  ];
  for (const def of defs) {
    assert.equal(integrationLabelOf(def), toolDisplayOf(def).integration);
  }
  assert.equal(integrationLabelOf({ id: 'webSearch' }), null);
  assert.equal(integrationLabelOf(null), null);
});
