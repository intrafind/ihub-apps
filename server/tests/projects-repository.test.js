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
  chatMarkerKey,
  isAdminProjectId,
  isUserProjectId,
  memberMarkerKey,
  mintItemId,
  mintProjectId
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
    assert.deepEqual(narrowed.changed, ['user:u-grace'], 'Grace went from editor to user');

    // Same member, another role: nothing added or removed, but the audit
    // trail must see the permission change.
    const promoted = await repo.setMembers(
      project.id,
      [{ type: 'user', id: GRACE.id, role: 'editor' }],
      { actor: ADA }
    );
    assert.deepEqual(promoted.added, []);
    assert.deepEqual(promoted.removed, []);
    assert.deepEqual(promoted.changed, ['user:u-grace']);
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
    assert.deepEqual((await repo.removeAllChatMarkers(project.id)).sort(), ['chat-1', 'chat-2']);
    assert.deepEqual(await repo.listChatMarkers(project.id), []);
    assert.equal(
      await getStorage().documents.get(
        PROJECT_CHATS_NAMESPACE,
        chatMarkerKey(project.id, 'chat-1')
      ),
      null
    );
  });

  it('keeps a chat marker whose ids together outgrow a storage key', async () => {
    const project = await repo.createUser({ owner: ADA, content: { name: 'Long chats' } });
    const chatId = `chat-${'x'.repeat(75)}`;
    assert.equal(chatId.length, 80);
    assert.equal(await repo.addChatMarker(project.id, chatId, { ownerId: ADA.id }), true);
    assert.ok(chatMarkerKey(project.id, chatId).length <= 100);
    assert.deepEqual(
      (await repo.listChatMarkers(project.id)).map(marker => marker.chatId),
      [chatId]
    );
    assert.equal(await repo.removeChatMarker(project.id, chatId), true);
    assert.deepEqual(await repo.listChatMarkers(project.id), []);
  });

  it('scans in pages without repeating a document when a budget stops it', async () => {
    const owner = { id: 'user-scan', name: 'Scan' };
    const made = [];
    for (const name of ['S1', 'S2', 'S3']) {
      made.push((await repo.createUser({ owner, content: { name } })).id);
    }
    const mine = project => project.owner?.id === owner.id;
    const seen = [];
    let cursor = null;
    let rounds = 0;
    do {
      const page = await repo.scanUser({ filter: mine, max: 1, cursor });
      assert.ok(page.projects.length <= 1, 'at most one project per round');
      seen.push(...page.projects.map(project => project.id));
      cursor = page.truncated ? page.nextCursor : null;
      rounds += 1;
    } while (cursor && rounds < 50);
    assert.deepEqual([...seen].sort(), [...made].sort(), 'every project exactly once');
    const all = await repo.scanUser({ filter: mine });
    assert.equal(all.truncated, false);
    assert.equal(all.projects.length, 3);
  });

  it('follows the scan cursor to the end', async () => {
    const made = [];
    for (const name of ['Page one', 'Page two', 'Page three']) {
      made.push((await repo.createUser({ owner: ADA, content: { name } })).id);
    }
    const ids = (await repo.scanUserAll({ pageSize: 1 })).map(project => project.id);
    assert.equal(new Set(ids).size, ids.length, 'no project is listed twice');
    for (const id of made) assert.ok(ids.includes(id), `${id} is in the full scan`);
  });

  it("removes a project's blobs by prefix, and only keys shaped like its own", async () => {
    const blobs = getStorage().blobs;
    await blobs.put(PROJECT_FILES_NAMESPACE, 'prj_a__itm_1__v1', 'one');
    await blobs.put(PROJECT_FILES_NAMESPACE, 'prj_a__itm_2__v1', 'two');
    await blobs.put(PROJECT_FILES_NAMESPACE, 'prj_b__itm_1__v1', 'other');
    // A key that shares the prefix but has more parts is not this project's
    // (`case` versus a hypothetical `case__archive`): a prefix match alone
    // must not delete it.
    await blobs.put(PROJECT_FILES_NAMESPACE, 'case__archive__itm_1__v1', 'archive');
    await blobs.put(PROJECT_FILES_NAMESPACE, 'case__itm_9__v1', 'mine');
    assert.equal(await repo.deleteBlobs('prj_a', 'itm_1'), 1);
    assert.equal(await repo.deleteBlobs('prj_a'), 1);
    assert.ok(await blobs.get(PROJECT_FILES_NAMESPACE, 'prj_b__itm_1__v1'));
    assert.equal(await repo.deleteBlobs('case'), 1);
    assert.ok(await blobs.get(PROJECT_FILES_NAMESPACE, 'case__archive__itm_1__v1'));
    assert.equal(await repo.deleteBlobs('case', 'itm__9'), 0, 'an item id with the separator');
  });

  it('never mints an id that carries the blob separator, and refuses one', () => {
    for (let i = 0; i < 500; i++) {
      assert.ok(!mintProjectId().includes('__'));
      assert.ok(!mintItemId().includes('__'));
    }
    assert.equal(isAdminProjectId('case'), true);
    assert.equal(isAdminProjectId('case__archive'), false);
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
    await assert.rejects(repo.createAdmin({ id: 'case__archive', name: { en: 'x' } }));
    assert.equal(await repo.get('../x'), null);
  });

  it('deletes under the project lock, after the update that was in flight', async () => {
    await repo.createAdmin({ id: 'racy', name: { en: 'Racy' }, items: [] });
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const update = repo.mutate('racy', async project => {
      await gate;
      return { ...project, instructions: 'written late' };
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const removal = repo.delete('racy');
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    const [updated, removed] = await Promise.all([update, removal]);
    assert.equal(updated?.instructions, 'written late');
    assert.equal(removed?.id, 'racy', 'the delete ran after the update and found the project');
    assert.equal(await repo.get('racy'), null, 'the late write did not bring it back');
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
    // The count and the create are serialized per owner: with one slot left,
    // concurrent creates cannot all see it free.
    const racer = { id: 'u-racer', name: 'Racer' };
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map(n => service.createUserProject({ owner: racer, content: { name: `r${n}` } }))
    );
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
    assert.ok(
      outcomes.filter(o => o.status === 'rejected').every(o => o.reason.code === 'QUOTA_PROJECTS')
    );
    assert.equal(await repo.countOwned(racer.id), 1);
    platform = {};
  });

  it('judges a delete again under the lock, and drops one member in place', async () => {
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Judged' } });
    // The retention sweep and the user cleanup pass what they saw as the
    // predicate; a project that no longer satisfies it is left alone.
    await assert.rejects(
      service.deleteProject(project.id, { authorize: current => current.owner.id === GRACE.id }),
      error => error instanceof ProjectError && error.code === 'PROJECT_ACCESS_CHANGED'
    );
    assert.ok(await repo.get(project.id));
    const graceKey = memberTargetKey({ type: 'user', id: GRACE.id });
    await repo.setMembers(project.id, [
      { type: 'user', id: GRACE.id, name: 'Grace', role: 'user' },
      { type: 'group', id: 'g1', name: 'G1', role: 'user' }
    ]);
    const dropped = await repo.removeMember(project.id, graceKey);
    assert.deepEqual(
      dropped.members.map(m => m.id),
      ['g1']
    );
    assert.equal(await repo.removeMember(project.id, graceKey), null);
    assert.deepEqual(await repo.listSharedWith([graceKey]), []);
    assert.ok(await service.deleteProject(project.id));
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

    const stale = '2020-01-01T00:00:00.000Z';
    await repo.mutate(project.id, current => current, { now: stale });
    const renamed = await service.updateItem(
      project.id,
      item.id,
      { name: 'Doc', pinned: true },
      { user: ADA }
    );
    assert.equal(renamed.item.name, 'Doc');
    assert.equal(renamed.item.pinned, true);
    // Renaming or pinning is using the project: retention must see it.
    assert.ok(renamed.project.lastActivityAt > stale);
    await assert.rejects(
      service.updateItem(project.id, 'itm_missing', { name: 'x' }, { user: ADA }),
      error => error.code === 'ITEM_NOT_FOUND'
    );
    const after = await service.removeItem(project.id, item.id, { user: ADA });
    assert.deepEqual(after.items, []);
  });

  it('refuses a switched-off item kind in a new admin project', async () => {
    await assert.rejects(
      service.createAdminProject(
        {
          id: 'adm-kinds',
          name: { en: 'Kinds' },
          items: [{ kind: 'ifinder-document', ref: { documentId: 'd1' } }]
        },
        { actor: ADA }
      ),
      error => error.code === 'KIND_DISABLED'
    );
    assert.equal(await repo.get('adm-kinds'), null);
  });

  it('refreshes activity for chat turns, at most once per throttle window', async () => {
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Busy' } });
    const stale = '2020-01-01T00:00:00.000Z';
    await repo.mutate(project.id, current => current, { now: stale });
    assert.equal(await service.noteChatTurn(project.id), true);
    const touched = (await repo.get(project.id)).lastActivityAt;
    assert.ok(touched > stale);
    await repo.mutate(project.id, current => current, { now: stale });
    // The next turn inside the window is not written again.
    assert.equal(await service.noteChatTurn(project.id), false);
    assert.equal((await repo.get(project.id)).lastActivityAt, stale);
    assert.equal(
      await service.noteChatTurn('prj_missing'),
      false,
      'a missing project is not touched'
    );
  });

  it('records chat activity without counting it as an edit', async () => {
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Quiet' } });
    const stale = '2020-01-01T00:00:00.000Z';
    await repo.mutate(project.id, current => current, { now: stale, actor: GRACE });
    await service.touchActivity(project.id);
    const touched = await repo.get(project.id);
    assert.ok(touched.lastActivityAt > stale);
    assert.equal(touched.updatedAt, stale, 'a chat turn is not an edit');
    assert.equal(touched.updatedBy.id, GRACE.id, 'the last editor stays');
  });

  it('refuses a chat marker for a project that is gone', async () => {
    assert.equal(await service.attachChat('prj_missing', 'chat-lost', { ownerId: ADA.id }), false);
    assert.deepEqual(await repo.listChatMarkers('prj_missing'), []);
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Here' } });
    assert.equal(await service.attachChat(project.id, 'chat-found', { ownerId: ADA.id }), true);
    assert.deepEqual(
      (await repo.listChatMarkers(project.id)).map(marker => marker.chatId),
      ['chat-found']
    );
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
