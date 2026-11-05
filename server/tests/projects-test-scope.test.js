// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The test scope of an admin project (#3309): who may run a scratch chat
 * against one, and that the app is narrowed to exactly that project.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let scratch;
let configCache;
let resolveProjectTestScope;
let applyProjectTestScope;
let chatPostSchema;

const ADMIN = { id: 'user-admin', isAdmin: true, isContentAdmin: true };
const EDITOR = { id: 'user-editor', isContentAdmin: true };
const MEMBER = { id: 'user-member', isContentAdmin: false };
const ANONYMOUS = { id: 'anonymous', isContentAdmin: true };

/** A repository holding the given projects by id. */
const repositoryOf = projects => ({
  get: async id => projects.find(project => project.id === id) || null
});

const DOCS = { id: 'handbook', ownership: 'admin', enabled: false, items: [] };
const USER_PROJECT = { id: 'prj_abc123', ownership: 'user', items: [] };

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-project-test-scope-'));
  process.env.CONTENTS_DIR = scratch;
  await fs.mkdir(path.join(scratch, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(scratch, 'config', 'platform.json'),
    JSON.stringify({ defaultLanguage: 'en' }),
    'utf8'
  );
  ({ default: configCache } = await import('../configCache.js'));
  configCache.setCacheEntry('config/features.json', { projects: true });
  ({ resolveProjectTestScope, applyProjectTestScope } =
    await import('../services/knowledge/projectTestScope.js'));
  ({ chatPostSchema } = await import('../validators/index.js'));
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('resolveProjectTestScope', () => {
  const repository = repositoryOf([DOCS, USER_PROJECT]);

  it('lets a content admin test an admin project, disabled or not', async () => {
    for (const user of [ADMIN, EDITOR]) {
      const result = await resolveProjectTestScope({ user, testProjectId: 'handbook', repository });
      assert.deepEqual(result, { ok: true, projectId: 'handbook' });
    }
  });

  it('refuses everyone who is not a content admin with 403', async () => {
    for (const user of [MEMBER, ANONYMOUS, undefined]) {
      const result = await resolveProjectTestScope({ user, testProjectId: 'handbook', repository });
      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
      assert.equal(result.code, 'PROJECT_TEST_FORBIDDEN');
    }
  });

  it('answers 404 for a project that does not exist, is not an admin project or has a bad id', async () => {
    for (const testProjectId of ['missing', USER_PROJECT.id, 'ifc_collection', '../etc', 42, '']) {
      const result = await resolveProjectTestScope({ user: ADMIN, testProjectId, repository });
      assert.equal(result.ok, false, String(testProjectId));
      assert.equal(result.status, 404, String(testProjectId));
      assert.equal(result.code, 'PROJECT_NOT_FOUND');
    }
  });

  it('answers 404 for a stored project of another ownership even under an admin id', async () => {
    const odd = { id: 'sneaky', ownership: 'user', items: [] };
    const result = await resolveProjectTestScope({
      user: ADMIN,
      testProjectId: 'sneaky',
      repository: repositoryOf([odd])
    });
    assert.equal(result.status, 404);
  });

  it('answers 404 while the projects feature is off', async () => {
    configCache.setCacheEntry('config/features.json', { projects: false });
    try {
      const result = await resolveProjectTestScope({
        user: ADMIN,
        testProjectId: 'handbook',
        repository
      });
      assert.equal(result.status, 404);
    } finally {
      configCache.setCacheEntry('config/features.json', { projects: true });
    }
  });
});

describe('applyProjectTestScope', () => {
  const APP = {
    id: 'support',
    projects: [
      { id: 'other-docs', mode: 'context' },
      { id: 'more-docs', mode: 'auto' }
    ],
    features: { projects: false, userProjects: false, shortLinks: true },
    _projectId: 'prj_container',
    _attachedProjectIds: ['prj_attached'],
    _workflowProjects: [{ id: 'wf-docs' }]
  };

  it('leaves the project under test as the only one in scope', () => {
    const scoped = applyProjectTestScope(APP, 'handbook');
    assert.deepEqual(scoped.projects, [{ id: 'handbook', mode: 'auto' }]);
    assert.equal(scoped._projectId, undefined);
    assert.equal(scoped._attachedProjectIds, undefined);
    assert.equal(scoped._workflowProjects, undefined);
  });

  it('switches projects on for the app but keeps its other features', () => {
    const scoped = applyProjectTestScope(APP, 'handbook');
    assert.equal(scoped.features.projects, true);
    assert.equal(scoped.features.userProjects, false);
    assert.equal(scoped.features.shortLinks, true);
    assert.equal(scoped.id, 'support');
  });

  it('never changes the configured app', () => {
    const before = JSON.stringify(APP);
    applyProjectTestScope(APP, 'handbook');
    assert.equal(JSON.stringify(APP), before);
  });

  it('copes with an app that has no features', () => {
    const scoped = applyProjectTestScope({ id: 'bare' }, 'handbook');
    assert.deepEqual(scoped.features, { projects: true });
  });
});

describe('the chat request', () => {
  const body = extra => ({ messages: [{ role: 'user', content: 'hi' }], ...extra });
  const parse = value => chatPostSchema.body.safeParse(value);

  it('accepts a testProjectId', () => {
    const result = parse(body({ testProjectId: 'handbook' }));
    assert.equal(result.success, true);
    assert.equal(result.data.testProjectId, 'handbook');
  });

  it('works without one and refuses an empty or oversized one', () => {
    assert.equal(parse(body()).success, true);
    assert.equal(parse(body({ testProjectId: '' })).success, false);
    assert.equal(parse(body({ testProjectId: 'x'.repeat(201) })).success, false);
    assert.equal(parse(body({ testProjectId: 5 })).success, false);
  });
});
