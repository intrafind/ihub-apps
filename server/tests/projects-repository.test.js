// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ProjectRepository and ProjectService over a real filesystem storage
 * provider (#1036, spec 1 §8, §9): the documents, the member and chat
 * markers, the blob cascade, quotas and the item rules.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapStorage, getStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { StorageError } from '../storage/errors.js';
import {
  ACCESS_CHANGED,
  PROJECT_CHATS_NAMESPACE,
  PROJECT_FILES_NAMESPACE,
  USER_PROJECTS_NAMESPACE,
  USER_PROJECT_SHARES_NAMESPACE,
  ProjectRepository,
  isUserProjectId,
  memberMarkerKey
} from '../services/projects/ProjectRepository.js';
import { ProjectError, ProjectService } from '../services/projects/ProjectService.js';
import { memberTargetKey } from '../services/projects/projectAccess.js';

const ADA = { id: 'u-ada', name: 'Ada' };
const GRACE = { id: 'u-grace', name: 'Grace' };

let scratch;
let repo;
let service;
let platform = {};

/** An in-memory stand-in for the config store's admin project files. */
function fakeConfigStore() {
  const files = new Map();
  return {
    files,
    readJson: async rel => structuredClone(files.get(rel) ?? null),
    createJson: async (rel, data) => {
      if (files.has(rel)) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      files.set(rel, structuredClone(data));
    },
    writeJson: async (rel, data) => files.set(rel, structuredClone(data)),
    updateJson: async (rel, mutate) => {
      const current = structuredClone(files.get(rel) ?? null);
      const next = await mutate(current);
      if (next === undefined) return { data: current, written: false };
      files.set(rel, structuredClone(next));
      return { data: next, written: true };
    },
    remove: async rel => files.delete(rel),
    listDocuments: async dir =>
      [...files.entries()]
        .filter(([rel]) => rel.startsWith(`${dir}/`))
        .map(([rel, data]) => ({ key: rel.slice(dir.length + 1, -5), path: rel, data }))
  };
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-repo-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const provider = getStorage();
  repo = new ProjectRepository({
    documents: provider.documents,
    blobs: provider.blobs,
    locks: provider.locks,
    config: fakeConfigStore()
  });
  service = new ProjectService({
    repository: repo,
    platform: () => platform,
    features: () => ({})
  });
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('user projects', () => {
  it('creates a project filed under its owner', async () => {
    const project = await repo.createUser({ owner: ADA, content: { name: 'Case 1' } });
    assert.ok(isUserProjectId(project.id));
    assert.equal(project.ownership, 'user');
    assert.equal(project.tier, 'ihub');
    assert.deepEqual(project.owner, ADA);
    assert.deepEqual(project.usage, { items: 0, bytes: 0 });
    const owned = await repo.listOwned(ADA.id);
    assert.ok(owned.some(entry => entry.id === project.id));
    assert.equal(
      (await repo.listOwned(GRACE.id)).some(entry => entry.id === project.id),
      false
    );
    assert.equal((await repo.get(project.id)).name, 'Case 1');
  });

  it('indexes members by marker and prunes markers of a deleted project', async () => {
    const project = await repo.createUser({ owner: ADA, content: { name: 'Shared' } });
    const result = await repo.setMembers(
      project.id,
      [
        { type: 'user', id: GRACE.id, role: 'editor' },
        { type: 'group', id: 'legal', role: 'user' }
      ],
      { actor: ADA }
    );
    assert.deepEqual(result.added.sort(), ['group:legal', 'user:u-grace']);
    const shared = await repo.listSharedWith(['user:u-grace']);
    assert.ok(shared.some(entry => entry.id === project.id));
    assert.ok((await repo.listSharedWith(['group:legal'])).some(entry => entry.id === project.id));

    const narrowed = await repo.setMembers(
      project.id,
      [{ type: 'user', id: GRACE.id, role: 'user' }],
      {
        actor: ADA
      }
    );
    assert.deepEqual(narrowed.removed, ['group:legal']);
    assert.equal(
      (await repo.listSharedWith(['group:legal'])).some(e => e.id === project.id),
      false
    );

    await repo.delete(project.id);
    const documents = getStorage().documents;
    assert.equal(await documents.get(USER_PROJECTS_NAMESPACE, project.id), null);
    assert.equal(
      await documents.get(
        USER_PROJECT_SHARES_NAMESPACE,
        memberMarkerKey(project.id, 'user:u-grace')
      ),
      null
    );
  });

  it('drops a stale marker whose project is gone', async () => {
    const documents = getStorage().documents;
    await documents.put(
      USER_PROJECT_SHARES_NAMESPACE,
      memberMarkerKey('prj_gone', 'user:u-grace'),
      { projectId: 'prj_gone', target: 'user:u-grace' },
      { ownerId: 'user:u-grace' }
    );
    const shared = await repo.listSharedWith(['user:u-grace']);
    assert.equal(
      shared.some(entry => entry.id === 'prj_gone'),
      false
    );
    assert.equal(
      await documents.get(
        USER_PROJECT_SHARES_NAMESPACE,
        memberMarkerKey('prj_gone', 'user:u-grace')
      ),
      null
    );
  });

  it('re-runs the authorize check under the lock', async () => {
    const project = await repo.createUser({ owner: ADA, content: { name: 'Guarded' } });
    await assert.rejects(
      repo.mutate(project.id, p => ({ ...p, name: 'x' }), { authorize: () => false }),
      error => error instanceof StorageError && error.code === ACCESS_CHANGED
    );
    assert.equal((await repo.get(project.id)).name, 'Guarded');
  });

  it('transfers ownership and drops the new owner from the members', async () => {
    const project = await repo.createUser({ owner: ADA, content: { name: 'Handed over' } });
    await repo.setMembers(project.id, [{ type: 'user', id: GRACE.id, role: 'editor' }], {
      actor: ADA
    });
    const moved = await repo.transfer(project.id, GRACE, { actor: ADA });
    assert.equal(moved.owner.id, GRACE.id);
    assert.deepEqual(moved.members, []);
    assert.ok((await repo.listOwned(GRACE.id)).some(entry => entry.id === project.id));
    assert.equal(
      (await repo.listOwned(ADA.id)).some(entry => entry.id === project.id),
      false
    );
    assert.equal(
      (await repo.listSharedWith(['user:u-grace'])).some(e => e.id === project.id),
      false
    );
  });

  it('keeps chat markers under the project id', async () => {
    const project = await repo.createUser({ owner: ADA, content: { name: 'With chats' } });
    await repo.addChatMarker(project.id, 'chat-1', { ownerId: ADA.id });
    await repo.addChatMarker(project.id, 'chat-2', { ownerId: GRACE.id });
    const markers = await repo.listChatMarkers(project.id);
    assert.deepEqual(markers.map(marker => marker.chatId).sort(), ['chat-1', 'chat-2']);
    assert.deepEqual(await repo.removeAllChatMarkers(project.id), ['chat-1', 'chat-2']);
    assert.deepEqual(await repo.listChatMarkers(project.id), []);
    assert.equal(
      await getStorage().documents.get(PROJECT_CHATS_NAMESPACE, `${project.id}__chat-1`),
      null
    );
  });

  it("removes a project's blobs by prefix", async () => {
    const blobs = getStorage().blobs;
    await blobs.put(PROJECT_FILES_NAMESPACE, 'prj_a__itm_1__v1', 'one');
    await blobs.put(PROJECT_FILES_NAMESPACE, 'prj_a__itm_2__v1', 'two');
    await blobs.put(PROJECT_FILES_NAMESPACE, 'prj_b__itm_1__v1', 'other');
    assert.equal(await repo.deleteBlobs('prj_a', 'itm_1'), 1);
    assert.equal(await repo.deleteBlobs('prj_a'), 1);
    assert.ok(await blobs.get(PROJECT_FILES_NAMESPACE, 'prj_b__itm_1__v1'));
  });
});

describe('admin projects', () => {
  it('creates, lists, changes and deletes through the config store', async () => {
    const created = await repo.createAdmin(
      { id: 'faq', name: { en: 'FAQ' }, items: [] },
      { actor: ADA }
    );
    assert.equal(created.ownership, 'admin');
    assert.equal(created.enabled, true);
    await assert.rejects(
      repo.createAdmin({ id: 'faq', name: { en: 'Again' } }),
      error => error.code === 'PROJECT_EXISTS'
    );
    assert.ok((await repo.listAdmin()).some(project => project.id === 'faq'));
    const updated = await repo.mutate('faq', project => ({ ...project, enabled: false }), {
      actor: ADA
    });
    assert.equal(updated.enabled, false);
    assert.equal(
      (await repo.listAdmin({ includeDisabled: false })).some(p => p.id === 'faq'),
      false
    );
    assert.equal(await repo.mutate('missing', p => p), null);
    assert.ok(await repo.delete('faq'));
    assert.equal(await repo.get('faq'), null);
  });

  it('refuses ids shaped like user project ids and unsafe ids', async () => {
    await assert.rejects(repo.createAdmin({ id: 'prj_x', name: { en: 'x' } }));
    await assert.rejects(repo.createAdmin({ id: '../x', name: { en: 'x' } }));
    assert.equal(await repo.get('../x'), null);
  });
});

describe('service rules', () => {
  it('caps projects per user', async () => {
    platform = { projects: { limits: { maxProjectsPerUser: 1 } } };
    const owner = { id: 'u-capped', name: 'Capped' };
    await service.createUserProject({ owner, content: { name: 'one' } });
    await assert.rejects(
      service.createUserProject({ owner, content: { name: 'two' } }),
      error => error instanceof ProjectError && error.code === 'QUOTA_PROJECTS'
    );
    platform = {};
  });

  it('adds link items as ready, refuses unknown kinds and bad refs', async () => {
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Items' } });
    const { item } = await service.addItem(
      project.id,
      { kind: 'url', ref: { url: 'https://example.com/doc' } },
      { user: ADA }
    );
    assert.equal(item.status, 'ready');
    assert.equal(item.storage, 'link');
    assert.equal(item.provenance.origin, 'linked');
    assert.equal(item.provenance.by.id, ADA.id);
    assert.equal(item.name, 'https://example.com/doc');
    assert.equal(item.cache.ttlSeconds, 7200);
    assert.equal((await repo.get(project.id)).usage.items, 1);

    await assert.rejects(
      service.addItem(project.id, { kind: 'nope', ref: {} }, { user: ADA }),
      error => error.code === 'KIND_UNKNOWN'
    );
    await assert.rejects(
      service.addItem(project.id, { kind: 'url', ref: { url: 'ftp://x' } }, { user: ADA }),
      error => error.code === 'INVALID_REF'
    );
    await assert.rejects(
      service.addItem(
        project.id,
        { kind: 'ifinder-document', ref: { documentId: 'd1' } },
        { user: ADA }
      ),
      error => error.code === 'KIND_DISABLED',
      'iFinder kinds are off without the integration'
    );

    const renamed = await service.updateItem(
      project.id,
      item.id,
      { name: 'Doc', pinned: true },
      { user: ADA }
    );
    assert.equal(renamed.item.name, 'Doc');
    assert.equal(renamed.item.pinned, true);
    await assert.rejects(
      service.updateItem(project.id, 'itm_missing', { name: 'x' }, { user: ADA }),
      error => error.code === 'ITEM_NOT_FOUND'
    );
    const after = await service.removeItem(project.id, item.id, { user: ADA });
    assert.deepEqual(after.items, []);
  });

  it('caps items per project', async () => {
    platform = { projects: { limits: { maxFiles: 1 } } };
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Full' } });
    await service.addItem(
      project.id,
      { kind: 'url', ref: { url: 'https://a.example' } },
      { user: ADA }
    );
    await assert.rejects(
      service.addItem(
        project.id,
        { kind: 'url', ref: { url: 'https://b.example' } },
        { user: ADA }
      ),
      error => error.code === 'QUOTA_FILES'
    );
    platform = {};
  });

  it('cascades a delete into blobs, chat markers and the chats themselves', async () => {
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Doomed' } });
    await getStorage().blobs.put(PROJECT_FILES_NAMESPACE, `${project.id}__itm_x__v1`, 'text');
    await service.attachChat(project.id, 'chat-9', { ownerId: ADA.id });
    const detached = [];
    const deleted = await service.deleteProject(project.id, {
      detachChat: async id => detached.push(id)
    });
    assert.equal(deleted.id, project.id);
    assert.deepEqual(detached, ['chat-9']);
    assert.equal(
      await getStorage().blobs.get(PROJECT_FILES_NAMESPACE, `${project.id}__itm_x__v1`),
      null
    );
    assert.deepEqual(await repo.listChatMarkers(project.id), []);
    assert.equal(await service.deleteProject(project.id), null);
  });

  it('refuses members and transfers on admin projects', async () => {
    await repo.createAdmin({ id: 'docs', name: { en: 'Docs' } });
    await assert.rejects(
      service.setMembers('docs', [], { user: ADA }),
      error => error.code === 'PERMISSION_DENIED'
    );
    await assert.rejects(
      service.transfer('docs', GRACE, { user: ADA }),
      error => error.code === 'PERMISSION_DENIED'
    );
    assert.equal(memberTargetKey({ type: 'everyone' }), 'everyone');
  });
});
