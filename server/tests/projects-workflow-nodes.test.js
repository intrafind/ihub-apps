// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The project steps of a workflow (#1036, spec 2 §8) and the workflow input
 * of type `project` (spec 1 §6.2): `project-items` lists, `project-read`
 * reads, `project-write` writes back with provenance, and the run's inputs
 * and links decide what a step may reach.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getPermissionsForUser, resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import {
  LocalFileKeyProvider,
  _resetKeyProvider,
  registerKeyProvider
} from '../services/projects/crypto/KeyProvider.js';
import { evictItemKeys } from '../services/projects/ItemTextStore.js';
import { getProjectService } from '../services/projects/ProjectService.js';
import { getProjectRepository } from '../services/projects/ProjectRepository.js';
import {
  bootstrapProjects,
  getIngestService,
  shutdownProjects
} from '../services/projects/bootstrap.js';
import { evictItemText } from '../services/knowledge/ItemTextService.js';
import { evictProjectIndex } from '../services/knowledge/LocalKnowledgeProvider.js';
import {
  ProjectNodeError,
  assertProjectInputs,
  knowledgeContextOf,
  projectInputLinks,
  projectInputVariables,
  resolveNodeProject,
  workflowProjectLinks
} from '../services/workflow/projectNodes.js';
import { getExecutor } from '../services/workflow/executors/index.js';
import { matchesFilter } from '../services/workflow/executors/ProjectItemsNodeExecutor.js';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';

const ADA = { id: 'user-ada', name: 'Ada', groups: ['authenticated'] };
const GRACE = { id: 'user-grace', name: 'Grace', groups: ['authenticated'] };
const ROOT = { id: 'user-root', name: 'Root', groups: ['admin', 'authenticated'] };
const GROUPS = resolveGroupInheritance({
  groups: {
    admin: {
      id: 'admin',
      name: 'Admin',
      permissions: { adminAccess: true, apps: ['*'], workflows: ['*'] }
    },
    authenticated: {
      id: 'authenticated',
      name: 'Authenticated',
      permissions: { apps: ['*'], workflows: ['*'], projects: true, projectSharing: true }
    },
    anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: [] } }
  }
});
const MASTER = crypto.createHash('sha256').update('test-master-nodes').digest('hex');

let scratch;
let service;
let repo;
let caseProject;

/** A workflow with a `case` input of type project and a link to the FAQ. */
function workflowOf(overrides = {}) {
  return {
    id: 'memo-writer',
    name: { en: 'Memo writer' },
    description: { en: 'Writes a memo per document' },
    version: '1.0.0',
    enabled: true,
    projects: [{ id: 'faq', mode: 'tools', write: false }],
    nodes: [
      {
        id: 'start',
        type: 'start',
        name: { en: 'Start' },
        position: { x: 0, y: 0 },
        config: {
          inputVariables: [
            { name: 'case', type: 'project', required: true },
            { name: 'topic', type: 'string' }
          ]
        }
      },
      { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 0, y: 200 } }
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end' }],
    ...overrides
  };
}

function contextOf({ user = ADA, workflow = workflowOf(), executionId = 'wf-exec-1' } = {}) {
  return { executionId, chatId: executionId, workflow, user, language: 'en' };
}

function stateOf(data) {
  return { executionId: 'wf-exec-1', data: { ...data }, nodeOutputs: {} };
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-project-nodes-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const users = {
    [ADA.id]: { ...ADA, username: 'ada', active: true },
    [GRACE.id]: { ...GRACE, username: 'grace', active: true },
    [ROOT.id]: { ...ROOT, username: 'root', active: true }
  };
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    anonymousAuth: { enabled: false },
    projects: {
      limits: { maxFiles: 25, maxFileBytes: 1024 * 1024, maxProjectBytes: 10 * 1024 * 1024 }
    }
  });
  configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
  configCache.setCacheEntry('config/groups.json', GROUPS);
  for (const user of [ADA, GRACE, ROOT]) {
    user.permissions = getPermissionsForUser(user.groups);
  }
  configCache.setCacheEntry('config/apps.json', []);
  // The workflow is installed, so its link makes the FAQ reachable for
  // whoever may run it (admin projects are reached through links only).
  configCache.setCacheEntry('config/workflows.json', [workflowOf()]);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/projects.json', []);
  configCache.setCacheEntry('config/models.json', []);
  configCache.setCacheEntry('config/tools.json', []);
  registerKeyProvider(
    'local-file',
    () => new LocalFileKeyProvider({ readMasterKey: () => MASTER, readPreviousKey: () => null })
  );
  _resetKeyProvider();
  await bootstrapProjects({ reconcile: false });
  getIngestService().tempDir = path.join(scratch, 'uploads');
  service = getProjectService();
  repo = getProjectRepository();

  caseProject = await service.createUserProject({
    owner: ADA,
    content: { name: 'Case 2026-114', instructions: 'Answer as a lawyer' }
  });
  for (const [name, text, pinned] of [
    [
      'Lease.md',
      '# Lease\n\n## Termination\n\nThree months notice.\n\n## Deposit\n\nThree rents.',
      false
    ],
    ['Policy.md', '# Policy\n\nPasswords have 14 characters.', true]
  ]) {
    await service.addItem(
      caseProject.id,
      { kind: 'upload', ref: { contentType: 'text/markdown' }, name, text, pinned },
      { user: ADA, wait: true }
    );
  }
  await repo.setMembers(caseProject.id, [{ type: 'user', id: GRACE.id, role: 'user' }], {
    actor: ADA
  });
  await repo.createAdmin({ id: 'faq', name: { en: 'FAQ' }, items: [] }, { actor: ROOT });
  await repo.createAdmin({ id: 'orphan', name: { en: 'Orphan' }, items: [] }, { actor: ROOT });
  await service.addItem(
    'faq',
    {
      kind: 'upload',
      ref: { contentType: 'text/markdown' },
      name: 'Hours.md',
      text: '# Opening hours\n\nMonday to Friday, nine to five.'
    },
    { user: ROOT, wait: true }
  );
  caseProject = await repo.get(caseProject.id);
});

after(async () => {
  shutdownProjects();
  evictItemText();
  evictItemKeys();
  evictProjectIndex();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('workflow inputs of type project', () => {
  it('finds the project inputs and turns their values into links', () => {
    const workflow = workflowOf();
    assert.deepEqual(
      projectInputVariables(workflow).map(v => v.name),
      ['case']
    );
    assert.deepEqual(projectInputLinks(workflow, stateOf({ case: 'prj_1', topic: 'x' })), [
      { id: 'prj_1', mode: 'auto', write: false }
    ]);
    assert.deepEqual(projectInputLinks(workflow, stateOf({ case: '  ' })), []);
    assert.deepEqual(projectInputLinks(workflow, null, { case: 'prj_2' }), [
      { id: 'prj_2', mode: 'auto', write: false }
    ]);
    assert.deepEqual(projectInputLinks({ nodes: [] }, stateOf({ case: 'prj_1' })), []);
  });

  it('merges node or workflow links with the inputs, the first mention winning', () => {
    const workflow = workflowOf();
    const state = stateOf({ case: 'faq' });
    // The workflow link to `faq` keeps its mode; the input adds nothing new.
    assert.deepEqual(workflowProjectLinks({}, workflow, state), [
      { id: 'faq', mode: 'tools', write: false }
    ]);
    // A node's own list replaces the workflow's, inputs still join.
    assert.deepEqual(
      workflowProjectLinks({ projects: ['prj_x'] }, workflow, stateOf({ case: 'prj_y' })),
      ['prj_x', { id: 'prj_y', mode: 'auto', write: false }]
    );
  });

  it('refuses a run whose project input is missing, malformed or out of reach', async () => {
    const workflow = workflowOf();
    await assert.rejects(
      assertProjectInputs(workflow, { topic: 'x' }, ADA),
      error => error instanceof ProjectNodeError && error.code === 'INVALID_REF'
    );
    await assert.rejects(
      assertProjectInputs(workflow, { case: { id: caseProject.id } }, ADA),
      error => error.code === 'INVALID_REF'
    );
    await assert.rejects(
      assertProjectInputs(workflow, { case: 'prj_nope' }, ADA),
      error => error.code === 'PROJECT_NOT_FOUND'
    );
    // Grace is a member and Root an admin: both may use the project; a
    // stranger may not.
    await assertProjectInputs(workflow, { case: caseProject.id }, GRACE);
    await assertProjectInputs(workflow, { case: caseProject.id }, ROOT);
    await assertProjectInputs(workflow, { case: caseProject.id }, ADA);
    await assert.rejects(
      assertProjectInputs(
        workflow,
        { case: caseProject.id },
        {
          id: 'user-stranger',
          groups: ['authenticated'],
          permissions: ADA.permissions
        }
      ),
      error => error.code === 'PROJECT_NOT_FOUND'
    );
    // An optional input left empty is fine; a workflow without project inputs too.
    await assertProjectInputs(
      workflowOf({
        nodes: [
          {
            ...workflowOf().nodes[0],
            config: { inputVariables: [{ name: 'case', type: 'project' }] }
          },
          workflowOf().nodes[1]
        ]
      }),
      {},
      ADA
    );
    await assertProjectInputs({ nodes: [] }, { case: 'prj_nope' }, ADA);
  });

  it('stamps the run on the knowledge context, as a workflow or an agent', () => {
    const node = { id: 'write-memo', type: 'project-write' };
    const context = contextOf({ executionId: 'wf-exec-7' });
    assert.deepEqual(knowledgeContextOf(node, stateOf({}), context).run, {
      type: 'workflow',
      id: 'wf-exec-7',
      nodeId: 'write-memo'
    });
    const agent = knowledgeContextOf(node, stateOf({ _agentModelConfig: {} }), context);
    assert.equal(agent.run.type, 'agent');
    assert.equal(agent.purpose, 'agent');
  });
});

describe('resolveNodeProject', () => {
  const executor = getExecutor('project-items');

  it('reaches a project by its id or a reference, with the user’s rights', async () => {
    const node = { id: 'n', type: 'project-items', config: { project: '$.data.case' } };
    const resolved = await resolveNodeProject({
      executor,
      node,
      state: stateOf({ case: caseProject.id }),
      context: contextOf()
    });
    assert.equal(resolved.project.id, caseProject.id);
    assert.equal(resolved.canWrite, true, 'the owner writes');
    assert.deepEqual(
      resolved.link,
      { id: caseProject.id, mode: 'auto', write: false },
      'the input is a link without a write grant'
    );
    const asGrace = await resolveNodeProject({
      executor,
      node,
      state: stateOf({ case: caseProject.id }),
      context: contextOf({ user: GRACE })
    });
    assert.equal(asGrace.canWrite, false, 'a member with role user reads only');
  });

  it('writes to an admin project only through a link that grants it', async () => {
    const node = { id: 'n', type: 'project-write', config: { project: 'faq' } };
    const withoutGrant = await resolveNodeProject({
      executor,
      node,
      state: stateOf({}),
      context: contextOf()
    });
    assert.equal(withoutGrant.canWrite, false);
    const granted = await resolveNodeProject({
      executor,
      node,
      state: stateOf({}),
      context: contextOf({
        workflow: workflowOf({ projects: [{ id: 'faq', mode: 'tools', write: true }] })
      })
    });
    assert.equal(granted.canWrite, true);
    assert.equal(granted.link.write, true);
    // A node's own link list wins over the workflow's.
    const nodeLink = await resolveNodeProject({
      executor,
      node: { ...node, config: { project: 'faq', projects: [{ id: 'faq', write: true }] } },
      state: stateOf({}),
      context: contextOf()
    });
    assert.equal(nodeLink.canWrite, true);
  });

  it('fails with a code when the project is unnamed, unknown or out of reach', async () => {
    await assert.rejects(
      resolveNodeProject({
        executor,
        node: { id: 'n', type: 'project-items', config: {} },
        state: stateOf({}),
        context: contextOf()
      }),
      error => error.code === 'INVALID_REF'
    );
    await assert.rejects(
      resolveNodeProject({
        executor,
        node: { id: 'n', type: 'project-items', config: { project: '$.data.case' } },
        state: stateOf({}),
        context: contextOf()
      }),
      error => error.code === 'INVALID_REF'
    );
    await assert.rejects(
      resolveNodeProject({
        executor,
        node: { id: 'n', type: 'project-items', config: { project: caseProject.id } },
        state: stateOf({}),
        context: contextOf({
          user: { id: 'user-stranger', groups: ['authenticated'], permissions: ADA.permissions }
        })
      }),
      error => error.code === 'PROJECT_NOT_FOUND'
    );
    // An admin project nothing links is out of reach, whoever runs the step.
    await assert.rejects(
      resolveNodeProject({
        executor,
        node: { id: 'n', type: 'project-items', config: { project: 'orphan' } },
        state: stateOf({}),
        context: contextOf()
      }),
      error => error.code === 'PROJECT_NOT_FOUND'
    );
    await assert.rejects(
      resolveNodeProject({
        executor,
        node: { id: 'n', type: 'project-items', config: { project: caseProject.id } },
        state: stateOf({}),
        context: { ...contextOf(), user: null }
      }),
      error => error.code === 'FORBIDDEN'
    );
  });

  it('keeps user projects dark while the feature is off', async () => {
    configCache.setCacheEntry('config/features.json', { projects: true, userProjects: false });
    try {
      await assert.rejects(
        resolveNodeProject({
          executor,
          node: { id: 'n', type: 'project-items', config: { project: caseProject.id } },
          state: stateOf({}),
          context: contextOf()
        }),
        error => error.code === 'PROJECT_NOT_FOUND'
      );
      const faq = await resolveNodeProject({
        executor,
        node: { id: 'n', type: 'project-items', config: { project: 'faq' } },
        state: stateOf({}),
        context: contextOf()
      });
      assert.equal(faq.project.id, 'faq');
    } finally {
      configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
    }
  });
});

describe('project-items', () => {
  const executor = getExecutor('project-items');

  it('lists the usable documents into the state for a loop', async () => {
    const node = {
      id: 'list-docs',
      type: 'project-items',
      config: { project: '$.data.case', outputVariable: 'docs' }
    };
    const result = await executor.execute(node, stateOf({ case: caseProject.id }), contextOf());
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.output.project, caseProject.id);
    assert.equal(result.output.name, 'Case 2026-114');
    assert.equal(result.output.count, 2);
    assert.equal(result.output.total, 2);
    assert.deepEqual(
      result.stateUpdates.docs.map(doc => doc.name),
      ['Lease.md', 'Policy.md']
    );
    const doc = result.stateUpdates.docs[0];
    assert.equal(doc.projectId, caseProject.id);
    assert.equal(doc.status, 'ready');
    assert.equal(doc.provenance.origin, 'written');
    assert.ok(Number.isFinite(doc.tokens));
    assert.deepEqual(result.resolvedInputs.project, caseProject.id);
  });

  it('applies the filter and the limit', async () => {
    const pinned = await executor.execute(
      {
        id: 'n',
        type: 'project-items',
        config: { project: caseProject.id, filter: { pinned: true } }
      },
      stateOf({}),
      contextOf()
    );
    assert.deepEqual(
      pinned.stateUpdates._projectItems.map(doc => doc.name),
      ['Policy.md']
    );
    const one = await executor.execute(
      { id: 'n', type: 'project-items', config: { project: caseProject.id, limit: 1 } },
      stateOf({}),
      contextOf()
    );
    assert.equal(one.output.count, 1);
    assert.equal(one.output.total, 2);
    const none = await executor.execute(
      {
        id: 'n',
        type: 'project-items',
        config: { project: caseProject.id, filter: { kinds: ['url'] } }
      },
      stateOf({}),
      contextOf()
    );
    assert.equal(none.output.count, 0);
    assert.deepEqual(none.stateUpdates._projectItems, []);
  });

  it('filters by kind, status, pinned and origin', () => {
    const doc = {
      kind: 'upload',
      status: 'ready',
      pinned: false,
      provenance: { origin: 'uploaded' }
    };
    assert.equal(matchesFilter(doc), true);
    assert.equal(matchesFilter({ ...doc, status: 'failed' }), false);
    assert.equal(matchesFilter({ ...doc, status: 'failed' }, { status: ['failed'] }), true);
    assert.equal(matchesFilter(doc, { kinds: 'upload' }), true);
    assert.equal(matchesFilter(doc, { kinds: ['url', 'page'] }), false);
    assert.equal(matchesFilter(doc, { pinned: false }), true);
    assert.equal(matchesFilter(doc, { pinned: true }), false);
    assert.equal(matchesFilter(doc, { origin: ['written'] }), false);
    assert.equal(matchesFilter({ ...doc, provenance: null }, { origin: ['linked'] }), true);
  });

  it('fails with the code of the problem', async () => {
    const result = await executor.execute(
      { id: 'n', type: 'project-items', config: { project: 'prj_nope' } },
      stateOf({}),
      contextOf()
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.details.code, 'PROJECT_NOT_FOUND');
    assert.match(result.error, /project-items: Project "prj_nope"/);
  });
});

describe('project-write and project-read', () => {
  const write = getExecutor('project-write');
  const read = getExecutor('project-read');

  it('stores a rendered text with the run as provenance, then reads it back', async () => {
    const node = {
      id: 'write-memo',
      type: 'project-write',
      config: {
        project: '$.data.case',
        name: 'Memo {{item.name}}',
        text: '$.data.memo',
        pinned: true,
        outputVariable: 'memo'
      }
    };
    const state = stateOf({
      case: caseProject.id,
      _loopItem: { name: 'Lease.md' },
      memo: '# Memo\n\nThe lease ends with three months notice.'
    });
    const result = await write.execute(node, state, contextOf({ executionId: 'wf-exec-9' }));
    assert.equal(result.status, 'completed', result.error);
    const doc = result.output;
    assert.equal(doc.name, 'Memo Lease.md');
    assert.equal(doc.status, 'ready', 'the step waited for the text');
    assert.equal(doc.pinned, true);
    assert.equal(doc.kind, 'upload');
    assert.equal(doc.provenance.origin, 'written');
    assert.deepEqual(doc.provenance.run, {
      type: 'workflow',
      id: 'wf-exec-9',
      nodeId: 'write-memo'
    });
    assert.equal(doc.provenance.by.id, ADA.id);
    assert.equal(result.stateUpdates.memo.id, doc.id);
    assert.equal(result.resolvedInputs.name, 'Memo Lease.md');
    assert.equal(result.resolvedInputs.chars, state.data.memo.length);

    const stored = await repo.get(caseProject.id);
    assert.ok(stored.items.some(item => item.id === doc.id && item.status === 'ready'));

    const back = await read.execute(
      {
        id: 'read-memo',
        type: 'project-read',
        config: { project: '$.data.case', document: '$.data.memo.id', outputVariable: 'text' }
      },
      stateOf({ case: caseProject.id, memo: doc }),
      contextOf()
    );
    assert.equal(back.status, 'completed', back.error);
    assert.equal(back.output.document, doc.id);
    assert.equal(back.output.name, 'Memo Lease.md');
    assert.match(back.output.text, /three months notice/);
    assert.equal(back.output.chars, back.output.text.length);
    assert.equal(back.output.retrieval.mode, 'full');
    assert.equal(back.stateUpdates.text.text, back.output.text);
    assert.equal(back.output.doc.id, doc.id);
  });

  it('reads a document of a loop item and a section of it', async () => {
    const lease = (await repo.get(caseProject.id)).items.find(item => item.name === 'Lease.md');
    const whole = await read.execute(
      {
        id: 'n',
        type: 'project-read',
        config: { project: caseProject.id, document: '$.data._loopItem.id' }
      },
      stateOf({ _loopItem: { id: lease.id, name: lease.name } }),
      contextOf()
    );
    assert.equal(whole.status, 'completed', whole.error);
    assert.match(whole.output.text, /Deposit/);
    // A document that fits the budget comes back whole, section or not; one
    // that does not is cut to the section.
    const section = await read.execute(
      {
        id: 'n',
        type: 'project-read',
        config: {
          project: caseProject.id,
          document: lease.id,
          section: 'Termination',
          maxChars: 40
        }
      },
      stateOf({}),
      contextOf()
    );
    assert.equal(section.status, 'completed', section.error);
    assert.equal(section.output.retrieval.mode, 'section');
    assert.match(section.output.text, /Three months notice/);
    assert.ok(!/Three rents/.test(section.output.text), 'only the section');
    // A loop item object is accepted as the document reference too.
    const byObject = await read.execute(
      {
        id: 'n',
        type: 'project-read',
        config: { project: caseProject.id, document: '$.data._loopItem' }
      },
      stateOf({ _loopItem: { id: lease.id } }),
      contextOf()
    );
    assert.equal(byObject.output.document, lease.id);
  });

  it('refuses a write the user or the link does not allow', async () => {
    const asGrace = await write.execute(
      {
        id: 'n',
        type: 'project-write',
        config: { project: caseProject.id, name: 'Note', text: 'hello' }
      },
      stateOf({}),
      contextOf({ user: GRACE })
    );
    assert.equal(asGrace.status, 'failed');
    assert.equal(asGrace.details.code, 'FORBIDDEN');
    assert.match(asGrace.error, /may not write/);

    const faqNoGrant = await write.execute(
      { id: 'n', type: 'project-write', config: { project: 'faq', name: 'Note', text: 'hello' } },
      stateOf({}),
      contextOf()
    );
    assert.equal(faqNoGrant.details.code, 'FORBIDDEN');
    assert.match(faqNoGrant.error, /does not grant writes/);

    const faqGranted = await write.execute(
      {
        id: 'n',
        type: 'project-write',
        config: { project: 'faq', name: 'Holidays.md', text: '# Holidays\n\nClosed on Sundays.' }
      },
      stateOf({}),
      contextOf({
        workflow: workflowOf({ projects: [{ id: 'faq', mode: 'tools', write: true }] })
      })
    );
    assert.equal(faqGranted.status, 'completed', faqGranted.error);
    assert.equal(faqGranted.output.projectId, 'faq');
    assert.equal((await repo.get('faq')).items.length, 2);
  });

  it('fails on an empty name or text and on an unknown document', async () => {
    const noText = await write.execute(
      {
        id: 'n',
        type: 'project-write',
        config: { project: caseProject.id, name: 'Note', text: '$.data.missing' }
      },
      stateOf({}),
      contextOf()
    );
    assert.equal(noText.details.code, 'INVALID_REF');
    assert.match(noText.error, /"text" resolved to an empty value/);
    const noName = await write.execute(
      {
        id: 'n',
        type: 'project-write',
        config: { project: caseProject.id, name: '{{item.name}}', text: 'x' }
      },
      stateOf({}),
      contextOf()
    );
    assert.equal(noName.details.code, 'INVALID_REF');
    const unknown = await read.execute(
      {
        id: 'n',
        type: 'project-read',
        config: { project: caseProject.id, document: 'itm_nope' }
      },
      stateOf({}),
      contextOf()
    );
    assert.equal(unknown.status, 'failed');
    assert.equal(unknown.details.code, 'ITEM_NOT_FOUND');
    const noDocument = await read.execute(
      { id: 'n', type: 'project-read', config: { project: caseProject.id } },
      stateOf({}),
      contextOf()
    );
    assert.equal(noDocument.details.code, 'INVALID_REF');
  });
});

describe('workflow schema', () => {
  it('accepts the three project steps', () => {
    const parsed = workflowConfigSchema.safeParse({
      ...workflowOf(),
      nodes: [
        ...workflowOf().nodes,
        {
          id: 'list',
          type: 'project-items',
          name: { en: 'List' },
          position: { x: 0, y: 50 },
          config: { project: '$.data.case' }
        },
        {
          id: 'read',
          type: 'project-read',
          name: { en: 'Read' },
          position: { x: 0, y: 100 },
          config: { project: '$.data.case', document: '$.data._loopItem.id' }
        },
        {
          id: 'write',
          type: 'project-write',
          name: { en: 'Write' },
          position: { x: 0, y: 150 },
          config: { project: '$.data.case', name: 'Memo', text: '$.data.memo' }
        }
      ].map(node => (node.type === 'end' ? { ...node, config: { output: 'memo' } } : node)),
      edges: [
        { id: 'e1', source: 'start', target: 'list' },
        { id: 'e2', source: 'list', target: 'read' },
        { id: 'e3', source: 'read', target: 'write' },
        { id: 'e4', source: 'write', target: 'end' }
      ]
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });
});
