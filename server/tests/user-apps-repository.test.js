// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The store of personal apps (feature `userApps`, design sections 4, 8.3 and
 * 10), on a real filesystem storage provider over `mkdtemp`.
 *
 * Pinned here:
 *
 *  - an app is filed under its owner, with an ID no config app has;
 *  - a write with a stale revision fails, and a write whose `authorize`
 *    callback fails under the lock throws `USER_APP_ACCESS_CHANGED`;
 *  - "shared with me" is answered from markers, and a marker without a
 *    matching member grants nothing;
 *  - an offer puts the app into the receiver's list; accepting swaps the
 *    owner, drops the receiver's own membership and makes every editor a user;
 *  - every content change stores a content state, the 21st removes the
 *    oldest, and the newest stays 90 days after a delete;
 *  - the limits per person are counted under a lock.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bootstrapStorage,
  getStorage,
  readFacet,
  shutdownStorageBootstrap
} from '../storage/bootstrap.js';
import {
  DELETED_STATE_TTL_MS,
  MAX_CONTENT_STATES,
  USER_APPS_NAMESPACE,
  USER_APP_REVISIONS_NAMESPACE,
  USER_APP_SHARES_NAMESPACE,
  UserAppRepository,
  contentHashOf,
  mintUserAppId,
  shareMarkerKey
} from '../services/userApps/UserAppRepository.js';
import { OFFER_TTL_MS } from '../services/userApps/userAppAccess.js';
import { CorruptDocumentError } from '../storage/errors.js';
import { isUserAppId } from '../../shared/userAppContent.js';
import { isValidAppId } from '../../shared/appId.js';

const ALICE = { id: 'alice', name: 'Alice Schmidt', groups: ['users'], authMode: 'local' };
const BEN = { id: 'ben', name: 'Ben Koch', groups: ['users'], authMode: 'local' };
const CAROL = { id: 'carol', name: 'Carol Shaw', groups: ['users'], authMode: 'local' };

const T0 = '2026-11-20T10:00:00.000Z';
const at = (days, base = T0) =>
  new Date(Date.parse(base) + days * 24 * 60 * 60 * 1000).toISOString();

const snapshotOf = user => ({
  userId: String(user.id),
  username: String(user.id),
  name: String(user.name || user.id),
  email: null,
  groups: [...(user.groups || [])],
  authMode: user.authMode || null,
  provider: null,
  recorded: true
});

const content = (text = 'You write job ads.') => ({
  name: { en: 'Job ad writer' },
  description: { en: 'Writes job ads' },
  system: { en: text },
  icon: 'document-text',
  color: '#4F46E5',
  variables: [],
  starterPrompts: [],
  capabilities: { upload: true, webSearch: false, skills: false, integrations: [] }
});

let baseDir;
let documents;
let repo;
/** IDs the repository treats as taken by a config app. */
const configAppIds = new Set();

function makeRepo(options = {}) {
  return new UserAppRepository({
    documents,
    locks: readFacet(getStorage(), 'locks'),
    isConfigAppId: id => configAppIds.has(id),
    snapshotOf,
    ...options
  });
}

async function createApp(owner = ALICE, options = {}) {
  return repo.create({
    owner,
    ownerPrincipal: snapshotOf(owner),
    content: content(),
    language: 'en',
    origin: 'blank',
    now: T0,
    ...options
  });
}

async function markersOf(target) {
  const page = await documents.list(USER_APP_SHARES_NAMESPACE, {
    ownerId: target,
    includeData: true
  });
  return page.items.map(doc => doc.data);
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-user-apps-repo-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  documents = readFacet(getStorage(), 'documents');
  repo = makeRepo();
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('create', () => {
  it('stores the record of section 4.3, filed under the owner', async () => {
    const record = await createApp(ALICE, { origin: 'generated', language: 'de' });
    assert.equal(isUserAppId(record.id), true);
    assert.equal(record.id.length, 36);
    assert.deepEqual(
      {
        version: record.version,
        ownership: record.ownership,
        owner: record.owner,
        pendingOwner: record.pendingOwner,
        members: record.members,
        language: record.language,
        origin: record.origin,
        state: record.state,
        publishedAs: record.publishedAs,
        disabled: record.disabled,
        revision: record.revision,
        createdBy: record.createdBy,
        updatedBy: record.updatedBy,
        lastUsedAt: record.lastUsedAt
      },
      {
        version: 1,
        ownership: 'user',
        owner: { id: 'alice', name: 'Alice Schmidt' },
        pendingOwner: null,
        members: [],
        language: 'de',
        origin: 'generated',
        state: 'active',
        publishedAs: null,
        disabled: null,
        revision: 1,
        createdBy: { id: 'alice', name: 'Alice Schmidt' },
        updatedBy: { id: 'alice', name: 'Alice Schmidt' },
        lastUsedAt: null
      }
    );
    assert.deepEqual(record.ownerPrincipal, snapshotOf(ALICE));
    assert.equal(record.ownerPrincipalAt, T0);
    assert.equal(record.contentHash, contentHashOf(content()));
    assert.match(record.contentHash, /^sha256:[a-f0-9]{64}$/);

    const stored = await documents.get(USER_APPS_NAMESPACE, record.id);
    assert.equal(stored.ownerId, 'alice');
    assert.deepEqual(await repo.get(record.id), record);
    assert.ok((await repo.listOwned('alice')).some(app => app.id === record.id));
    assert.equal(
      (await repo.listOwned('ben')).some(app => app.id === record.id),
      false
    );
  });

  it('mints an ID of the personal shape that the app builder refuses for admin apps', () => {
    for (let i = 0; i < 20; i += 1) {
      const id = mintUserAppId();
      assert.equal(isUserAppId(id), true, id);
      assert.equal(isValidAppId(id), false, id);
    }
  });

  it('mints again when a config app or a personal app has the ID', async () => {
    const taken = await createApp(BEN);
    const byConfig = 'uap_00000000000000000000000000000001';
    const free = 'uap_00000000000000000000000000000002';
    configAppIds.add(byConfig);
    const queue = [byConfig, taken.id, free];
    const minting = makeRepo({ mintId: () => queue.shift() });
    const record = await minting.create({
      owner: BEN,
      ownerPrincipal: snapshotOf(BEN),
      content: content(),
      language: 'en',
      now: T0
    });
    assert.equal(record.id, free);
    assert.deepEqual(queue, []);
    configAppIds.delete(byConfig);
    await repo.delete(taken.id, { keepLastState: false });
    await repo.delete(free, { keepLastState: false });
  });

  it('answers null for an ID that is not of the personal shape, without a lookup', async () => {
    assert.equal(await repo.get('chat'), null);
    assert.equal(await repo.get('uap_helper'), null);
    assert.equal(await repo.get('../../etc/passwd'), null);
    assert.equal(await repo.update('chat', content(), { actor: ALICE }), null);
    assert.equal(await repo.delete('uap_helper'), null);
  });

  it('refuses the create over the limit, and two parallel creates at the limit yield one app', async () => {
    const dora = { id: 'dora', name: 'Dora', groups: ['users'], authMode: 'local' };
    await createApp(dora, { limit: 2 });
    const results = await Promise.allSettled([
      createApp(dora, { limit: 2 }),
      createApp(dora, { limit: 2 })
    ]);
    const created = results.filter(result => result.status === 'fulfilled');
    const refused = results.filter(result => result.status === 'rejected');
    assert.equal(created.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason.code, 'QUOTA_USER_APPS');
    assert.equal(await repo.countOwned('dora'), 2);
    await rejectsWith(createApp(dora, { limit: 2 }), 'QUOTA_USER_APPS');
    // Zero means no limit.
    assert.ok(await createApp(dora, { limit: 0 }));
    assert.equal(await repo.countOwned('dora'), 3);
  });
});

describe('update', () => {
  it('saves new content as the next revision and stamps who saved', async () => {
    const record = await createApp();
    const saved = await repo.update(record.id, content('Be brief.'), {
      actor: CAROL,
      expectedRevision: 1,
      now: at(1)
    });
    assert.equal(saved.revision, 2);
    assert.equal(saved.content.system.en, 'Be brief.');
    assert.equal(saved.contentHash, contentHashOf(content('Be brief.')));
    assert.notEqual(saved.contentHash, record.contentHash);
    assert.deepEqual(saved.updatedBy, { id: 'carol', name: 'Carol Shaw' });
    assert.equal(saved.updatedAt, at(1));
    assert.deepEqual(saved.owner, record.owner);
  });

  it('a write with a stale revision fails with ETAG_MISMATCH and changes nothing', async () => {
    const record = await createApp();
    await repo.update(record.id, content('Second.'), { actor: ALICE, expectedRevision: 1 });
    await rejectsWith(
      repo.update(record.id, content('Third.'), { actor: CAROL, expectedRevision: 1 }),
      'ETAG_MISMATCH'
    );
    const stored = await repo.get(record.id);
    assert.equal(stored.revision, 2);
    assert.equal(stored.content.system.en, 'Second.');
    // Without a revision the write goes through, as on admin saves.
    const saved = await repo.update(record.id, content('Third.'), { actor: ALICE });
    assert.equal(saved.revision, 3);
  });

  it('a save that changes nothing writes nothing', async () => {
    const record = await createApp();
    const same = await repo.update(record.id, content(), { actor: CAROL, now: at(1) });
    assert.equal(same.revision, 1);
    assert.equal(same.updatedAt, T0);
    assert.equal((await repo.listRevisions(record.id)).length, 1);
  });

  it('a save by the owner rewrites the owner snapshot; a save by an editor does not', async () => {
    const record = await createApp();
    const moved = snapshotOf({ ...ALICE, groups: ['users', 'hr'] });
    const byEditor = await repo.update(record.id, content('By the editor.'), {
      actor: CAROL,
      ownerPrincipal: snapshotOf(CAROL),
      now: at(1)
    });
    assert.deepEqual(byEditor.ownerPrincipal, snapshotOf(ALICE));
    const byOwner = await repo.update(record.id, content('By the owner.'), {
      actor: ALICE,
      ownerPrincipal: moved,
      now: at(2)
    });
    assert.deepEqual(byOwner.ownerPrincipal.groups, ['users', 'hr']);
    assert.equal(byOwner.ownerPrincipalAt, at(2));
  });

  it('runs the authorize callback on the record loaded under the lock', async () => {
    const record = await createApp();
    let seen = null;
    await rejectsWith(
      repo.update(record.id, content('Not allowed.'), {
        actor: CAROL,
        authorize: loaded => {
          seen = loaded;
          return false;
        }
      }),
      'USER_APP_ACCESS_CHANGED'
    );
    assert.equal(seen.id, record.id);
    assert.equal((await repo.get(record.id)).revision, 1);
  });

  it('a write whose access was taken away while it waited for the lock is refused', async () => {
    const record = await createApp();
    await repo.setMembers(record.id, [{ type: 'user', id: 'carol', role: 'editor' }], {
      actor: ALICE
    });
    // The route checked Carol's access on a copy read before the lock. In the
    // meantime the owner removes her; the write checks again under the lock.
    const isEditor = loaded =>
      loaded.members.some(member => member.id === 'carol' && member.role === 'editor');
    const [removal, write] = await Promise.allSettled([
      repo.setMembers(record.id, [], { actor: ALICE }),
      repo.update(record.id, content('Carol was here.'), { actor: CAROL, authorize: isEditor })
    ]);
    assert.equal(removal.status, 'fulfilled');
    assert.equal(write.status, 'rejected');
    assert.equal(write.reason.code, 'USER_APP_ACCESS_CHANGED');
    assert.equal((await repo.get(record.id)).content.system.en, 'You write job ads.');
  });
});

describe('members and markers', () => {
  it('replaces the list, reports what changed and files one marker per target', async () => {
    const record = await createApp();
    const first = await repo.setMembers(
      record.id,
      [
        { type: 'user', id: 'ben', name: 'Ben Koch', role: 'editor' },
        { type: 'group', id: 'hr', name: 'HR', role: 'user' },
        { type: 'everyone', role: 'user' }
      ],
      { actor: ALICE, now: at(1) }
    );
    assert.deepEqual(first.added.sort(), ['everyone', 'group:hr', 'user:ben']);
    assert.deepEqual(first.removed, []);
    assert.equal(first.record.revision, 2);
    assert.equal(first.record.membersUpdatedAt, at(1));
    assert.deepEqual(first.record.membersUpdatedBy, { id: 'alice', name: 'Alice Schmidt' });
    assert.deepEqual(first.record.members, [
      { type: 'user', id: 'ben', name: 'Ben Koch', role: 'editor' },
      { type: 'group', id: 'hr', name: 'HR', role: 'user' },
      { type: 'everyone', id: null, name: '', role: 'user' }
    ]);
    for (const target of ['user:ben', 'group:hr', 'everyone']) {
      assert.ok(
        (await markersOf(target)).some(marker => marker.appId === record.id),
        `marker under ${target}`
      );
    }

    const second = await repo.setMembers(
      record.id,
      [
        { type: 'user', id: 'ben', name: 'Ben Koch', role: 'user' },
        { type: 'user', id: 'carol', name: 'Carol Shaw', role: 'user' }
      ],
      { actor: ALICE }
    );
    assert.deepEqual(second.added, ['user:carol']);
    assert.deepEqual(second.removed.sort(), ['everyone', 'group:hr']);
    assert.deepEqual(second.changed, ['user:ben']);
    for (const target of ['group:hr', 'everyone']) {
      assert.equal(
        (await markersOf(target)).some(marker => marker.appId === record.id),
        false,
        `no marker under ${target}`
      );
    }
  });

  it('leaves out an entry that names the owner, and a repeated target', async () => {
    const record = await createApp();
    const { record: stored } = await repo.setMembers(
      record.id,
      [
        { type: 'user', id: 'alice', role: 'editor' },
        { type: 'user', id: 'ben', role: 'user' },
        { type: 'user', id: 'ben', role: 'editor' }
      ],
      { actor: ALICE }
    );
    assert.deepEqual(
      stored.members.map(member => [member.id, member.role]),
      [['ben', 'editor']]
    );
  });

  it('"shared with me" is answered from the markers, newest first', async () => {
    const older = await createApp(ALICE, { now: at(-2) });
    const newer = await createApp(ALICE, { now: at(-1) });
    const mine = await createApp(ALICE);
    await repo.setMembers(older.id, [{ type: 'user', id: 'frank', role: 'user' }], {
      actor: ALICE
    });
    await repo.setMembers(newer.id, [{ type: 'group', id: 'frank-team', role: 'editor' }], {
      actor: ALICE
    });
    const shared = await repo.listSharedWith(['user:frank', 'group:frank-team', 'everyone']);
    const ids = shared.map(app => app.id);
    assert.deepEqual(ids.slice(0, 2), [newer.id, older.id]);
    assert.equal(ids.includes(mine.id), false);
    assert.deepEqual(await repo.listSharedWith(['user:nobody']), []);
    assert.equal(
      (await repo.listSharedWith(['user:frank', 'group:frank-team'], { limit: 1 })).length,
      1
    );
  });

  it('a marker without a matching member grants nothing, and is removed', async () => {
    const record = await createApp();
    // A marker that the document does not back: left behind by a failure, or forged.
    await documents.put(
      USER_APP_SHARES_NAMESPACE,
      shareMarkerKey(record.id, 'user:mallory'),
      { appId: record.id, target: 'user:mallory', kind: 'member' },
      { ownerId: 'user:mallory' }
    );
    assert.equal((await markersOf('user:mallory')).length, 1);
    assert.deepEqual(await repo.listSharedWith(['user:mallory']), []);
    assert.deepEqual(await markersOf('user:mallory'), [], 'the marker is pruned');

    // A marker that names another target than the index it is filed under.
    await documents.put(
      USER_APP_SHARES_NAMESPACE,
      shareMarkerKey(record.id, 'user:mallory'),
      { appId: record.id, target: 'everyone', kind: 'member' },
      { ownerId: 'user:mallory' }
    );
    await repo.setMembers(record.id, [{ type: 'everyone', role: 'user' }], { actor: ALICE });
    assert.deepEqual(await repo.listSharedWith(['user:mallory']), []);
  });

  it('a member removed from the list loses the app at once', async () => {
    const record = await createApp();
    await repo.setMembers(record.id, [{ type: 'user', id: 'gus', role: 'user' }], { actor: ALICE });
    assert.equal((await repo.listSharedWith(['user:gus'])).length, 1);
    await repo.setMembers(record.id, [], { actor: ALICE });
    assert.deepEqual(await repo.listSharedWith(['user:gus']), []);
  });

  it('a member leaves: the entry and its marker go', async () => {
    const record = await createApp();
    await repo.setMembers(
      record.id,
      [
        { type: 'user', id: 'hana', role: 'user' },
        { type: 'user', id: 'ben', role: 'editor' }
      ],
      { actor: ALICE }
    );
    const left = await repo.removeMember(record.id, 'user:hana', {
      actor: { id: 'hana', name: 'Hana' },
      now: at(1)
    });
    assert.equal(left.removed, true);
    assert.deepEqual(
      left.record.members.map(member => member.id),
      ['ben']
    );
    assert.equal(left.record.revision, 3);
    assert.deepEqual(await repo.listSharedWith(['user:hana']), []);
    const again = await repo.removeMember(record.id, 'user:hana', { actor: { id: 'hana' } });
    assert.equal(again.removed, false);
    assert.equal(again.record.revision, 3);
  });
});

describe('the offer', () => {
  it('keeps the owner, sets pendingOwner and files a marker under the receiver', async () => {
    const record = await createApp();
    const offered = await repo.setOffer(record.id, BEN, { actor: ALICE, now: T0 });
    assert.deepEqual(offered.owner, { id: 'alice', name: 'Alice Schmidt' });
    assert.deepEqual(offered.pendingOwner, {
      id: 'ben',
      name: 'Ben Koch',
      offeredAt: T0,
      offeredBy: { id: 'alice', name: 'Alice Schmidt' }
    });
    assert.equal(offered.revision, 2);
    assert.equal(await repo.countOwned('ben'), 0, 'the app still counts for the old owner');
    assert.ok(
      (await markersOf('user:ben')).some(
        marker => marker.appId === record.id && marker.kind === 'offer'
      )
    );
    assert.ok((await repo.listSharedWith(['user:ben'])).some(app => app.id === record.id));
    await repo.delete(record.id, { keepLastState: false });
  });

  it('a second offer replaces the first, and the first receiver loses the app', async () => {
    const record = await createApp();
    await repo.setOffer(record.id, BEN, { actor: ALICE });
    const replaced = await repo.setOffer(record.id, CAROL, { actor: ALICE });
    assert.equal(replaced.pendingOwner.id, 'carol');
    assert.equal(
      (await repo.listSharedWith(['user:ben'])).some(app => app.id === record.id),
      false
    );
    assert.ok((await repo.listSharedWith(['user:carol'])).some(app => app.id === record.id));
    await repo.delete(record.id, { keepLastState: false });
  });

  it('withdraw and decline remove the offer and its marker', async () => {
    const record = await createApp();
    await repo.setOffer(record.id, BEN, { actor: ALICE });
    const cleared = await repo.clearOffer(record.id);
    assert.equal(cleared.offer.id, 'ben');
    assert.equal(cleared.record.pendingOwner, null);
    assert.equal(
      (await repo.listSharedWith(['user:ben'])).some(app => app.id === record.id),
      false
    );
    const nothing = await repo.clearOffer(record.id);
    assert.equal(nothing.offer, null);
    assert.equal(nothing.record.revision, cleared.record.revision);
  });

  it('the sixth open offer of one sender is refused; replacing one and lapsed ones do not count', async () => {
    const ivy = { id: 'ivy', name: 'Ivy', groups: ['users'], authMode: 'local' };
    const apps = [];
    for (let i = 0; i < 6; i += 1) apps.push(await createApp(ivy));
    for (let i = 0; i < 5; i += 1) {
      await repo.setOffer(apps[i].id, BEN, { actor: ivy, maxOpenOffers: 5, now: T0 });
    }
    assert.equal(await repo.countOpenOffers('ivy', { now: Date.parse(T0) }), 5);
    await rejectsWith(
      repo.setOffer(apps[5].id, BEN, { actor: ivy, maxOpenOffers: 5, now: T0 }),
      'QUOTA_USER_APP_OFFERS'
    );
    assert.equal((await repo.get(apps[5].id)).pendingOwner, null);
    // Replacing an own offer is no sixth offer.
    const replaced = await repo.setOffer(apps[0].id, CAROL, {
      actor: ivy,
      maxOpenOffers: 5,
      now: T0
    });
    assert.equal(replaced.pendingOwner.id, 'carol');
    // A withdrawn offer frees a place.
    await repo.clearOffer(apps[1].id);
    assert.ok(await repo.setOffer(apps[5].id, BEN, { actor: ivy, maxOpenOffers: 5, now: T0 }));
    // After 30 days every one of them has lapsed.
    const later = new Date(Date.parse(T0) + OFFER_TTL_MS).toISOString();
    assert.equal(await repo.countOpenOffers('ivy', { now: Date.parse(later) }), 0);
    assert.ok(await repo.setOffer(apps[1].id, BEN, { actor: ivy, maxOpenOffers: 5, now: later }));
    for (const app of apps) await repo.delete(app.id, { keepLastState: false });
  });

  it('an offer by a full admin counts for the admin, not for the owner', async () => {
    const root = { id: 'root', name: 'Root' };
    const record = await createApp();
    const offered = await repo.setOffer(record.id, BEN, { actor: root, maxOpenOffers: 5 });
    assert.deepEqual(offered.pendingOwner.offeredBy, { id: 'root', name: 'Root' });
    assert.equal(await repo.countOpenOffers('root'), 1);
    assert.equal(await repo.countOpenOffers('alice'), 0);
    await repo.delete(record.id, { keepLastState: false });
    assert.equal(await repo.countOpenOffers('root'), 0);
  });
});

describe('an unreadable app document', () => {
  it('is skipped by the shared listing and by the offer count, and its markers stay', async () => {
    const broken = await createApp();
    const fine = await createApp();
    for (const record of [broken, fine]) {
      await repo.setMembers(
        record.id,
        [{ type: 'user', id: 'ben', name: 'Ben Koch', role: 'user' }],
        {
          actor: ALICE
        }
      );
      await repo.setOffer(record.id, CAROL, { actor: ALICE });
    }
    const damaged = makeRepo();
    const get = damaged.get.bind(damaged);
    damaged.get = async appId => {
      if (appId === broken.id) throw new CorruptDocumentError('The stored data is damaged.');
      return get(appId);
    };

    const listed = await damaged.listSharedWith(['user:ben']);
    assert.deepEqual(
      listed.filter(app => [broken.id, fine.id].includes(app.id)).map(app => app.id),
      [fine.id]
    );
    assert.equal(await damaged.countOpenOffers('alice'), 1);
    assert.ok((await markersOf('user:ben')).some(marker => marker.appId === broken.id));

    for (const record of [broken, fine]) await repo.delete(record.id, { keepLastState: false });
  });
});

describe('the company-app IDs personal apps hold', () => {
  it('lists published and publishing IDs, in lower case, without the excepted app', async () => {
    const published = await createApp();
    const publishing = await createApp();
    await repo.mutate(published.id, r => ({
      ...r,
      state: 'promoted',
      publishedAs: { appId: 'Chat-2', at: T0, by: { id: 'alice', name: 'Alice' } }
    }));
    await repo.mutate(publishing.id, r => ({ ...r, publishing: { appId: 'chat-3' } }), {
      bumpRevision: false
    });
    const held = await repo.heldCompanyAppIds();
    assert.ok(held.has('chat-2'));
    assert.ok(held.has('chat-3'));
    assert.equal(
      (await repo.heldCompanyAppIds({ exceptAppId: publishing.id })).has('chat-3'),
      false
    );
    for (const record of [published, publishing]) {
      await repo.delete(record.id, { keepLastState: false });
    }
  });
});

describe('accepting an offer', () => {
  async function offeredApp() {
    const record = await createApp();
    await repo.setMembers(
      record.id,
      [
        { type: 'user', id: 'ben', name: 'Ben Koch', role: 'user' },
        { type: 'user', id: 'carol', name: 'Carol Shaw', role: 'editor' },
        { type: 'group', id: 'hr', name: 'HR', role: 'editor' },
        { type: 'user', id: 'jon', name: 'Jon', role: 'user' }
      ],
      { actor: ALICE }
    );
    return repo.setOffer(record.id, BEN, { actor: ALICE, now: T0 });
  }

  it("swaps the owner, drops the receiver's membership and makes every editor a user", async () => {
    const offered = await offeredApp();
    const before = await repo.countOwned('alice');
    const accepted = await repo.acceptOffer(offered.id, {
      receiver: BEN,
      ownerPrincipal: snapshotOf(BEN),
      expectedRevision: offered.revision,
      now: at(1)
    });
    const { record } = accepted;
    assert.deepEqual(record.owner, { id: 'ben', name: 'Ben Koch' });
    assert.deepEqual(accepted.previousOwner, { id: 'alice', name: 'Alice Schmidt' });
    assert.equal(accepted.downgraded, 2);
    assert.deepEqual(record.ownerPrincipal, snapshotOf(BEN));
    assert.equal(record.ownerPrincipalAt, at(1));
    assert.equal(record.pendingOwner, null);
    assert.deepEqual(
      record.members.map(member => [member.type, member.id, member.role]),
      [
        ['user', 'carol', 'user'],
        ['group', 'hr', 'user'],
        ['user', 'jon', 'user']
      ]
    );
    assert.equal(record.revision, offered.revision + 1);
    // The previous owner keeps no role.
    assert.equal(
      record.members.some(member => member.id === 'alice'),
      false
    );
    // The owner index moved.
    assert.equal((await documents.get(USER_APPS_NAMESPACE, record.id)).ownerId, 'ben');
    assert.ok((await repo.listOwned('ben')).some(app => app.id === record.id));
    assert.equal(await repo.countOwned('alice'), before - 1);
    // The offer marker and the receiver's member marker are gone.
    assert.equal(
      (await markersOf('user:ben')).some(marker => marker.appId === record.id),
      false
    );
    assert.ok((await markersOf('user:carol')).some(marker => marker.appId === record.id));
    await repo.delete(record.id, { keepLastState: false });
  });

  it('needs the revision the receiver read: none is an error, a stale one answers ETAG_MISMATCH', async () => {
    const offered = await offeredApp();
    await rejectsWith(
      repo.acceptOffer(offered.id, { receiver: BEN, ownerPrincipal: snapshotOf(BEN) }),
      'INVALID_ARGUMENT'
    );
    // An editor changes the app after the receiver read it.
    await repo.update(offered.id, content('Changed after the offer.'), { actor: CAROL });
    await rejectsWith(
      repo.acceptOffer(offered.id, {
        receiver: BEN,
        ownerPrincipal: snapshotOf(BEN),
        expectedRevision: offered.revision
      }),
      'ETAG_MISMATCH'
    );
    const stored = await repo.get(offered.id);
    assert.equal(stored.owner.id, 'alice', 'until the accept the owner is unchanged');
    assert.equal(stored.pendingOwner.id, 'ben');
    await repo.delete(offered.id, { keepLastState: false });
  });

  it('only the receiver of an open offer accepts', async () => {
    const offered = await offeredApp();
    await rejectsWith(
      repo.acceptOffer(offered.id, {
        receiver: CAROL,
        ownerPrincipal: snapshotOf(CAROL),
        expectedRevision: offered.revision
      }),
      'USER_APP_NO_OFFER'
    );
    // A lapsed offer is none.
    await rejectsWith(
      repo.acceptOffer(offered.id, {
        receiver: BEN,
        ownerPrincipal: snapshotOf(BEN),
        expectedRevision: offered.revision,
        now: new Date(Date.parse(T0) + OFFER_TTL_MS).toISOString()
      }),
      'USER_APP_NO_OFFER'
    );
    assert.equal((await repo.get(offered.id)).owner.id, 'alice');
    await repo.delete(offered.id, { keepLastState: false });
  });

  it("a receiver at the limit is refused, and the sender's count is unchanged", async () => {
    const kim = { id: 'kim', name: 'Kim', groups: ['users'], authMode: 'local' };
    await createApp(kim);
    await createApp(kim);
    const record = await createApp();
    const offered = await repo.setOffer(record.id, kim, { actor: ALICE, now: T0 });
    const sendersApps = await repo.countOwned('alice');
    await rejectsWith(
      repo.acceptOffer(offered.id, {
        receiver: kim,
        ownerPrincipal: snapshotOf(kim),
        expectedRevision: offered.revision,
        limit: 2,
        now: at(1)
      }),
      'QUOTA_USER_APPS'
    );
    assert.equal(await repo.countOwned('alice'), sendersApps);
    assert.equal(await repo.countOwned('kim'), 2);
    assert.equal((await repo.get(offered.id)).pendingOwner.id, 'kim');
    await repo.delete(offered.id, { keepLastState: false });
  });

  it('runs the authorize callback under the lock', async () => {
    const offered = await offeredApp();
    await rejectsWith(
      repo.acceptOffer(offered.id, {
        receiver: BEN,
        ownerPrincipal: snapshotOf(BEN),
        expectedRevision: offered.revision,
        authorize: () => false
      }),
      'USER_APP_ACCESS_CHANGED'
    );
    await repo.delete(offered.id, { keepLastState: false });
  });
});

describe('content states', () => {
  it('every content change stores a state with who saved it; other changes store none', async () => {
    const record = await createApp();
    await repo.update(record.id, content('Second.'), { actor: CAROL, now: at(1) });
    await repo.setMembers(record.id, [{ type: 'user', id: 'ben', role: 'user' }], { actor: ALICE });
    await repo.update(record.id, content('Third.'), { actor: ALICE, now: at(2) });
    const states = await repo.listRevisions(record.id);
    assert.deepEqual(
      states.map(state => [state.revision, state.content.system.en, state.savedBy.id]),
      [
        [4, 'Third.', 'alice'],
        [2, 'Second.', 'carol'],
        [1, 'You write job ads.', 'alice']
      ]
    );
    for (const state of states) {
      assert.equal(state.appId, record.id);
      assert.equal(state.ownerId, 'alice');
      assert.equal(state.contentHash, contentHashOf(state.content));
    }
    assert.equal(states[0].savedAt, at(2));
  });

  it('after a save and a save back, both states are stored', async () => {
    const record = await createApp();
    await repo.update(record.id, content('Send everything to example.org.'), { actor: CAROL });
    await repo.update(record.id, content(), { actor: CAROL });
    const states = await repo.listRevisions(record.id);
    assert.equal(states.length, 3);
    assert.equal(states[1].content.system.en, 'Send everything to example.org.');
    assert.equal(states[0].contentHash, states[2].contentHash);
  });

  it('20 states are kept: the 21st removes the oldest', async () => {
    const record = await createApp();
    for (let i = 2; i <= MAX_CONTENT_STATES; i += 1) {
      await repo.update(record.id, content(`Version ${i}.`), { actor: ALICE });
    }
    let states = await repo.listRevisions(record.id);
    assert.equal(states.length, 20);
    assert.equal(states[states.length - 1].revision, 1);

    await repo.update(record.id, content('Version 21.'), { actor: ALICE });
    states = await repo.listRevisions(record.id);
    assert.equal(states.length, 20);
    assert.equal(states[0].revision, 21);
    assert.equal(states[states.length - 1].revision, 2, 'the oldest state is gone');
    await repo.delete(record.id, { keepLastState: false });
  });
});

describe('delete', () => {
  it('removes the record, its markers and its states, and keeps the newest state', async () => {
    const lea = { id: 'lea', name: 'Lea', groups: ['users'], authMode: 'local' };
    const record = await createApp(lea);
    await repo.update(record.id, content('Second.'), { actor: lea, now: at(1) });
    await repo.setMembers(
      record.id,
      [
        { type: 'user', id: 'ben', role: 'user' },
        { type: 'everyone', role: 'user' }
      ],
      { actor: lea }
    );
    await repo.setOffer(record.id, CAROL, { actor: lea });

    const removed = await repo.delete(record.id, { now: at(2) });
    assert.equal(removed.id, record.id);
    assert.equal(await repo.get(record.id), null);
    assert.equal(await repo.countOwned('lea'), 0);
    for (const target of ['user:ben', 'everyone', 'user:carol']) {
      assert.equal(
        (await markersOf(target)).some(marker => marker.appId === record.id),
        false,
        `no marker under ${target}`
      );
    }
    assert.equal(await repo.countOpenOffers('lea'), 0);
    assert.deepEqual(await repo.listRevisions(record.id), []);

    const kept = await repo.listDeletedStates('lea');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].appId, record.id);
    assert.equal(kept[0].revision, 2);
    assert.equal(kept[0].content.system.en, 'Second.');
    assert.equal(kept[0].deletedAt, at(2));
    assert.equal(await repo.delete(record.id), null, 'a second delete finds nothing');
  });

  it('the kept state stays 90 days and goes when the owner next creates or deletes', async () => {
    const mia = { id: 'mia', name: 'Mia', groups: ['users'], authMode: 'local' };
    const first = await createApp(mia);
    await repo.delete(first.id, { now: T0 });
    const ttlDays = DELETED_STATE_TTL_MS / (24 * 60 * 60 * 1000);
    assert.equal(ttlDays, 90);

    // 89 days later the owner creates an app: the state is still there.
    const second = await createApp(mia, { now: at(89) });
    assert.equal((await repo.listDeletedStates('mia')).length, 1);

    // 91 days later the owner deletes an app: the old state goes, the new one stays.
    await repo.delete(second.id, { now: at(91) });
    const kept = await repo.listDeletedStates('mia');
    assert.deepEqual(
      kept.map(state => state.appId),
      [second.id]
    );

    // And a create after that removes it when its own time is up.
    const third = await createApp(mia, { now: at(91 + 90) });
    assert.deepEqual(await repo.listDeletedStates('mia'), []);
    await repo.delete(third.id, { keepLastState: false });
  });

  it('with keepLastState off nothing of the app stays: for deleting a user account', async () => {
    const nia = { id: 'nia', name: 'Nia', groups: ['users'], authMode: 'local' };
    const kept = await createApp(nia);
    await repo.delete(kept.id);
    const gone = await createApp(nia);
    await repo.delete(gone.id, { keepLastState: false });
    assert.deepEqual(
      (await repo.listDeletedStates('nia')).map(state => state.appId),
      [kept.id]
    );
    assert.equal(await repo.purgeDeletedStates('nia', { all: true }), 1);
    assert.deepEqual(await repo.listDeletedStates('nia'), []);
  });

  it('runs the authorize callback under the lock: an app handed over meanwhile stays', async () => {
    const record = await createApp();
    const offered = await repo.setOffer(record.id, BEN, { actor: ALICE, now: T0 });
    await repo.acceptOffer(offered.id, {
      receiver: BEN,
      ownerPrincipal: snapshotOf(BEN),
      expectedRevision: offered.revision,
      now: T0
    });
    // The cleanup of Alice's deleted account listed the app while it was hers.
    await rejectsWith(
      repo.delete(record.id, { authorize: loaded => loaded.owner.id === 'alice' }),
      'USER_APP_ACCESS_CHANGED'
    );
    assert.equal((await repo.get(record.id)).owner.id, 'ben');
    await repo.delete(record.id, { keepLastState: false });
  });
});

describe('the owner snapshot', () => {
  it('one request refreshes every app of the owner whose snapshot differs', async () => {
    const olga = { id: 'olga', name: 'Olga', groups: ['users'], authMode: 'oidc' };
    const first = await createApp(olga);
    const second = await createApp(olga);
    const foreign = await createApp(ALICE);

    // Same groups, an hour later: nothing to write.
    assert.equal(await repo.refreshOwnerPrincipal(olga, { now: at(1 / 24) }), 0);

    const moved = { ...olga, groups: ['users', 'hr'] };
    assert.equal(await repo.refreshOwnerPrincipal(moved, { now: at(1 / 24) }), 2);
    for (const id of [first.id, second.id]) {
      const stored = await repo.get(id);
      assert.deepEqual(stored.ownerPrincipal.groups, ['users', 'hr']);
      assert.equal(stored.ownerPrincipalAt, at(1 / 24));
      assert.equal(stored.revision, 1, 'the revision does not change');
    }
    assert.deepEqual((await repo.get(foreign.id)).ownerPrincipal, snapshotOf(ALICE));

    // Unchanged groups, but older than a day: rewritten to keep it fresh.
    assert.equal(await repo.refreshOwnerPrincipal(moved, { now: at(2) }), 2);
    assert.equal((await repo.get(first.id)).ownerPrincipalAt, at(2));
    assert.equal(await repo.refreshOwnerPrincipal(moved, { now: at(2) }), 0);
  });

  it('lastUsedAt is written at most once a day and does not change the revision', async () => {
    const record = await createApp();
    assert.equal(await repo.touchLastUsed(record.id, { now: T0 }), true);
    assert.equal(await repo.touchLastUsed(record.id, { now: at(0.5) }), false);
    assert.equal(await repo.touchLastUsed(record.id, { now: at(1) }), true);
    const stored = await repo.get(record.id);
    assert.equal(stored.lastUsedAt, at(1));
    assert.equal(stored.revision, 1);
  });
});

describe('state changes through mutate', () => {
  it('switches an app off and on, and cannot touch owner, members or content', async () => {
    const record = await createApp();
    const off = await repo.mutate(record.id, current => ({
      ...current,
      disabled: { at: T0, by: { id: 'root', name: 'Root' }, reason: 'Review' },
      owner: { id: 'mallory', name: 'Mallory' },
      members: [{ type: 'everyone', id: null, role: 'editor' }],
      content: content('Overwritten.'),
      id: 'uap_ffffffffffffffffffffffffffffffff'
    }));
    assert.equal(off.disabled.reason, 'Review');
    assert.equal(off.revision, 2);
    assert.equal(off.id, record.id);
    assert.deepEqual(off.owner, record.owner);
    assert.deepEqual(off.members, []);
    assert.equal(off.content.system.en, 'You write job ads.');
    assert.equal(off.contentHash, record.contentHash);

    const on = await repo.mutate(record.id, current => ({ ...current, disabled: null }));
    assert.equal(on.disabled, null);
    assert.equal(on.revision, 3);
  });

  it('honours the revision and the authorize callback, and a falsy result writes nothing', async () => {
    const record = await createApp();
    await rejectsWith(
      repo.mutate(record.id, current => ({ ...current, state: 'promoted' }), {
        expectedRevision: 9
      }),
      'ETAG_MISMATCH'
    );
    await rejectsWith(
      repo.mutate(record.id, current => ({ ...current, state: 'promoted' }), {
        authorize: () => false
      }),
      'USER_APP_ACCESS_CHANGED'
    );
    const same = await repo.mutate(record.id, () => null);
    assert.equal(same.revision, 1);
    const marked = await repo.mutate(
      record.id,
      current => ({ ...current, publishing: { appId: 'job-ad-writer' } }),
      { bumpRevision: false }
    );
    assert.equal(marked.revision, 1);
    assert.deepEqual(marked.publishing, { appId: 'job-ad-writer' });
  });

  it('a save stores that a promoted app whose company app is gone is active again', async () => {
    const record = await createApp();
    await repo.mutate(record.id, current => ({
      ...current,
      state: 'promoted',
      publishedAs: { appId: 'job-ad-writer', at: T0, by: { id: 'alice', name: 'Alice' } }
    }));
    const saved = await repo.update(record.id, content('Editable again.'), {
      actor: ALICE,
      release: true
    });
    assert.equal(saved.state, 'active');
    assert.equal(saved.publishedAs, null);
  });
});

describe('the admin walk', () => {
  it('pages through every app without a gap or a repeat, with a filter', async () => {
    const pia = { id: 'pia', name: 'Pia', groups: ['users'], authMode: 'local' };
    const created = [];
    for (let i = 0; i < 5; i += 1) created.push((await createApp(pia)).id);
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await repo.scan({
        filter: record => record.owner.id === 'pia',
        limit: 2,
        cursor
      });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map(record => record.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 500);
    assert.deepEqual([...seen].sort(), [...created].sort());
    assert.equal(new Set(seen).size, seen.length);
    await rejectsWith(repo.scan({ cursor: 'not-a-cursor' }), 'INVALID_CURSOR');
  });
});

describe('without a storage provider', () => {
  it('every method is a no-op', async () => {
    const off = new UserAppRepository({});
    assert.equal(off.isAvailable(), false);
    assert.equal(await off.create({ owner: ALICE, content: content() }), null);
    assert.equal(await off.get('uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8'), null);
    assert.deepEqual(await off.listOwned('alice'), []);
    assert.deepEqual(await off.listSharedWith(['user:alice']), []);
    assert.equal(await off.countOwned('alice'), 0);
    assert.deepEqual(await off.scan(), { items: [], nextCursor: null });
    assert.equal(await off.refreshOwnerPrincipal(ALICE), 0);
  });

  it('the revisions namespace holds the states under the app, never under a user', async () => {
    const record = await createApp();
    const page = await documents.list(USER_APP_REVISIONS_NAMESPACE, { ownerId: record.id });
    assert.equal(page.items.length, 1);
    await repo.delete(record.id, { keepLastState: false });
  });
});
