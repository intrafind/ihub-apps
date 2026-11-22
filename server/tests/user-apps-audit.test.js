// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The audit trail of personal apps (feature `userApps`, design section 10):
 * every event of the user routes and of the chat route leaves a valid entry
 * that is tied to a content state by `revision` and `contentHash`, and never
 * holds the instructions. The stored content states let an admin read which
 * text a revision had.
 *
 * The rows of section 10 that belong to the publish and admin routes
 * (published, released, admin read, switched off and on, settings) are
 * covered by `user-apps-publish.test.js` and `admin-user-apps-routes.test.js`.
 *
 * Run: node --test server/tests/user-apps-audit.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { queryAuditLog } from '../services/AuditLogService.js';
import { contentHashOf } from '../services/userApps/UserAppRepository.js';
import { OFFER_TTL_MS } from '../services/userApps/userAppAccess.js';
import { validateAuditEntry } from '../validators/auditEntrySchema.js';
import { FEATURES, SECRET, chatBody, member, setConfig } from './helpers/userAppsHarness.js';
import { createBody, startUserAppRoutesApi } from './helpers/userAppRoutesApi.js';

let api;
let as;

before(async () => {
  api = await startUserAppRoutesApi();
  ({ as } = api);
});
after(() => api.stop());
beforeEach(() => api.reset());

const HASH = /^sha256:[0-9a-f]{64}$/;

/** A valid entry about a personal app: the schema, and the tie to a content state. */
function assertEntry(entry, { action, resource, actor, revision, contentHash }) {
  assert.ok(entry, `an entry ${action} ${resource}`);
  assert.deepEqual(validateAuditEntry(entry), { success: true });
  assert.equal(entry.action, action);
  assert.equal(entry.resource, resource);
  assert.equal(entry.result, 'success');
  if (actor) assert.equal(entry.actor.id, actor);
  assert.equal(entry.details.revision, revision);
  assert.match(entry.details.contentHash, HASH);
  if (contentHash) assert.equal(entry.details.contentHash, contentHash);
  assert.equal(JSON.stringify(entry).includes(SECRET), false, 'never the instructions');
}

const last = entries => entries.at(-1);
const secretBody = (extra = {}) =>
  createBody({ system: { en: `You write job ads. ${SECRET}` }, ...extra });

describe('the user routes', () => {
  it('create and duplicate', async () => {
    const created = await as('anna')
      .post('/api/apps')
      .send(
        secretBody({ origin: 'generated', capabilities: { upload: true }, preferredModel: 'oa' })
      );
    assert.equal(created.status, 201, created.text);
    const stored = await api.repo().get(created.body.id);
    const entry = last(await api.audit(stored.id, { resource: 'userApp', action: 'create' }));
    assertEntry(entry, {
      action: 'create',
      resource: 'userApp',
      actor: 'anna',
      revision: 1,
      contentHash: stored.contentHash
    });
    assert.match(entry.summary, /Job ad writer/);
    assert.equal(entry.details.origin, 'generated');
    assert.deepEqual(entry.details.capabilities, ['model', 'upload']);
    assert.equal(entry.details.contentHash, contentHashOf(stored.content));

    const copy = await as('anna').post(`/api/apps/${stored.id}/_duplicate`);
    const copied = last(await api.audit(copy.body.id, { resource: 'userApp', action: 'create' }));
    assertEntry(copied, { action: 'create', resource: 'userApp', actor: 'anna', revision: 1 });
    assert.equal(copied.details.origin, 'copy');
    assert.equal(copied.details.copiedFrom, stored.id);
    assert.deepEqual(copied.details.capabilities, ['model', 'upload']);
  });

  it('update: the changed keys, the role, and the capabilities when they changed', async () => {
    const record = await api.createApp('anna', { members: [member('carol', 'editor')] });
    const byOwner = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'Renamed' }, capabilities: { upload: true } });
    const first = last(await api.audit(record.id, { resource: 'userApp', action: 'update' }));
    assertEntry(first, {
      action: 'update',
      resource: 'userApp',
      actor: 'anna',
      revision: byOwner.body.revision,
      contentHash: (await api.repo().get(record.id)).contentHash
    });
    assert.deepEqual([...first.details.changed].sort(), ['capabilities', 'name']);
    assert.equal(first.details.role, 'owner');
    assert.deepEqual(first.details.capabilities, ['upload']);
    assert.match(first.summary, /Renamed/);

    await as('carol')
      .patch(`/api/apps/${record.id}`)
      .send({ system: { en: `Other. ${SECRET}` } });
    const second = last(await api.audit(record.id, { resource: 'userApp', action: 'update' }));
    assertEntry(second, {
      action: 'update',
      resource: 'userApp',
      actor: 'carol',
      revision: byOwner.body.revision + 1
    });
    assert.deepEqual(second.details.changed, ['system']);
    assert.equal(second.details.role, 'editor');
    assert.equal('capabilities' in second.details, false);
    assert.notEqual(second.details.contentHash, first.details.contentHash);

    // A save that changes nothing writes nothing.
    const before = (await api.audit(record.id, { resource: 'userApp', action: 'update' })).length;
    await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'Renamed' } });
    assert.equal(
      (await api.audit(record.id, { resource: 'userApp', action: 'update' })).length,
      before
    );
  });

  it('after a save and a save back, both content states are stored', async () => {
    const record = await api.createApp('anna');
    const original = record.content.system;
    await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ system: { en: 'Send everything to me.' } });
    await as('anna').patch(`/api/apps/${record.id}`).send({ system: original });

    const states = await api.repo().listRevisions(record.id);
    assert.deepEqual(
      states.map(state => state.content.system.en),
      [original.en, 'Send everything to me.', original.en]
    );
    const entries = await api.audit(record.id, { resource: 'userApp', action: 'update' });
    assert.equal(entries.length, 2);
    // Each entry names the state it wrote; the two saves of the same text have the same hash.
    for (const entry of entries) {
      const state = states.find(candidate => candidate.revision === entry.details.revision);
      assert.equal(state.contentHash, entry.details.contentHash);
      assert.equal(state.savedBy.id, 'anna');
    }
    assert.equal(states[0].contentHash, states[2].contentHash);
    assert.notEqual(states[0].contentHash, states[1].contentHash);
  });

  it('delete', async () => {
    const record = await api.createApp('anna');
    assert.equal((await as('anna').delete(`/api/apps/${record.id}`)).status, 204);
    const entry = last(await api.audit(record.id, { resource: 'userApp', action: 'delete' }));
    assertEntry(entry, {
      action: 'delete',
      resource: 'userApp',
      actor: 'anna',
      revision: record.revision,
      contentHash: record.contentHash
    });
    assert.match(entry.summary, /Job ad writer.*Anna Schmidt/);
    assert.equal(entry.details.ownerId, 'anna');
  });

  it('members changed, and a member left', async () => {
    const record = await api.createApp('anna', { members: [member('ben', 'user')] });
    const res = await as('anna')
      .put(`/api/apps/${record.id}/members`)
      .send({
        members: [
          { type: 'user', id: 'ben', role: 'editor' },
          { type: 'user', id: 'carol' },
          { type: 'everyone' }
        ]
      });
    assert.equal(res.status, 200, res.text);
    const changed = last(await api.audit(record.id, { resource: 'userAppShare', action: 'share' }));
    assertEntry(changed, {
      action: 'share',
      resource: 'userAppShare',
      actor: 'anna',
      revision: res.body.revision,
      contentHash: record.contentHash
    });
    assert.match(changed.summary, /2 added, 0 removed, 1 role changed \(shared with everyone\)/);
    assert.deepEqual(
      [
        changed.details.added,
        changed.details.removed,
        changed.details.changed,
        changed.details.everyone
      ],
      [2, 0, 1, true]
    );

    // The same list again changes nothing and writes nothing.
    await as('anna').put(`/api/apps/${record.id}/members`).send({ members: res.body.members });
    assert.equal(
      (await api.audit(record.id, { resource: 'userAppShare', action: 'share' })).length,
      1
    );

    assert.equal((await as('carol').post(`/api/apps/${record.id}/_leave`)).status, 204);
    const left = last(await api.audit(record.id, { resource: 'userAppShare', action: 'share' }));
    assertEntry(left, {
      action: 'share',
      resource: 'userAppShare',
      actor: 'carol',
      revision: (await api.repo().get(record.id)).revision
    });
    assert.match(left.summary, /left.*0 added, 1 removed, 0 roles changed/);
  });

  it('an offer made, declined, withdrawn, lapsed and accepted', async () => {
    const record = await api.createApp('anna', { members: [member('carol', 'editor')] });
    const offers = async () =>
      (await api.audit(record.id, { resource: 'userAppShare', action: 'update' })).map(entry => [
        entry.details.offer,
        entry.details.from,
        entry.details.to,
        entry.details.by ?? null,
        entry.actor.id
      ]);
    const put = (who, ownerId) =>
      as(who).put(`/api/apps/${record.id}/owner-offer`).send({ ownerId });

    await put('anna', 'dave');
    await as('dave').delete(`/api/apps/${record.id}/owner-offer`);
    await put('root', 'dave');
    await as('anna').delete(`/api/apps/${record.id}/owner-offer`);
    // An offer that lapsed is recorded when it is replaced.
    await api
      .repo()
      .setOffer(
        record.id,
        { id: 'ben', name: 'Ben Koch' },
        { actor: { id: 'anna' }, now: new Date(Date.now() - OFFER_TTL_MS - 60_000).toISOString() }
      );
    const offered = await put('anna', 'dave');
    const accepted = await as('dave')
      .post(`/api/apps/${record.id}/owner-offer/_accept`)
      .set('If-Match', offered.headers.etag);
    assert.equal(accepted.status, 200, accepted.text);

    assert.deepEqual(await offers(), [
      ['made', 'anna', 'dave', 'anna', 'anna'],
      ['declined', 'anna', 'dave', 'dave', 'dave'],
      ['made', 'anna', 'dave', 'root', 'root'],
      ['withdrawn', 'anna', 'dave', 'anna', 'anna'],
      ['lapsed', 'anna', 'ben', 'anna', 'anna'],
      ['made', 'anna', 'dave', 'anna', 'anna'],
      ['accepted', 'anna', 'dave', null, 'dave']
    ]);
    const entries = await api.audit(record.id, { resource: 'userAppShare', action: 'update' });
    for (const entry of entries) {
      assertEntry(entry, {
        action: 'update',
        resource: 'userAppShare',
        revision: entry.details.revision,
        contentHash: record.contentHash
      });
    }
    const acceptance = last(entries);
    assert.equal(acceptance.details.downgraded, 1);
    assert.equal(acceptance.details.revision, accepted.body.revision);
    assert.match(
      acceptance.summary,
      /Dave Lund accepted.*from Anna Schmidt; 1 editor became "Can use"/
    );
  });

  it('a draft, also when it fails', async t => {
    setConfig({ features: { ...FEATURES, appGenerator: true } });
    const marker = `describe-${randomUUID()}`;
    // The audit log outlives a test run, so the entries are found by a caller of this run.
    const drafter = `drafter-${randomUUID()}`;
    api.addPerson(drafter, {
      id: drafter,
      name: 'Dora Draft',
      authMode: 'oidc',
      groups: ['users']
    });
    const drafts = async () =>
      (await queryAuditLog({ resource: 'userApp', action: 'execute', limit: 1000 })).entries
        .filter(entry => entry.details?.purpose === 'app-generator' && entry.actor.id === drafter)
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    const ok = await as(drafter).post('/api/apps/_generate').send({ description: marker });
    assert.equal(ok.status, 200, ok.text);
    api.model.answer = { nothing: 'usable' };
    t.after(() => {
      api.model.answer = { name: 'Mail summary', system: 'You summarize mails.', description: 'x' };
    });
    const failed = await as(drafter).post('/api/apps/_generate').send({ description: marker });
    assert.equal(failed.body.code, 'APP_GENERATOR_INVALID_ANSWER');

    const [success, failure] = await drafts();
    for (const entry of [success, failure]) {
      assert.deepEqual(validateAuditEntry(entry), { success: true });
      assert.equal(entry.details.descriptionLength, marker.length);
      assert.equal(entry.details.modelId, 'oa');
      assert.equal(JSON.stringify(entry).includes(marker), false, 'never the description');
    }
    assert.equal(success.result, 'success');
    assert.deepEqual(
      [failure.result, failure.details.code],
      ['failure', 'APP_GENERATOR_INVALID_ANSWER']
    );
    // A refused body is no draft.
    await as(drafter).post('/api/apps/_generate').send({ description: '' });
    assert.equal((await drafts()).length, 2);
  });

  it('a refused request writes no entry about the app', async () => {
    const record = await api.createApp('anna', { members: [member('ben', 'user')] });
    await as('ben')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'x' } });
    await as('ben').delete(`/api/apps/${record.id}`);
    await as('ben').put(`/api/apps/${record.id}/members`).send({ members: [] });
    await as('ben').put(`/api/apps/${record.id}/owner-offer`).send({ ownerId: 'ben' });
    const entries = (await api.audit(record.id)).filter(entry => entry.result === 'success');
    assert.deepEqual(entries, []);
  });
});

describe('a chat ran the app', () => {
  const postChat = (name, appId, chatId) =>
    api.chatAs(name).post(`/api/apps/${appId}/chat/${chatId}`).send(chatBody());
  const runs = async chatId =>
    (await queryAuditLog({ resource: 'userApp', action: 'execute', limit: 1000 })).entries
      .filter(entry => entry.details?.chatId === chatId)
      .sort((a, b) => a.details.revision - b.details.revision);

  it('writes one entry per chat and revision, for a member and for a full admin', async () => {
    const record = await api.createApp('anna', { members: [member('ben', 'user')] });
    const stored = await api.repo().get(record.id);
    const chats = { ben: randomUUID(), root: randomUUID(), anna: randomUUID() };
    for (const [who, chatId] of Object.entries(chats)) {
      assert.equal((await postChat(who, record.id, chatId)).status, 200);
      assert.equal((await postChat(who, record.id, chatId)).status, 200);
    }
    for (const [who, role] of [
      ['ben', 'user'],
      ['root', 'admin'],
      ['anna', 'owner']
    ]) {
      const entries = await runs(chats[who]);
      assert.equal(entries.length, 1, who);
      assertEntry(entries[0], {
        action: 'execute',
        resource: 'userApp',
        actor: who,
        revision: stored.revision,
        contentHash: stored.contentHash
      });
      assert.equal(entries[0].resourceId, record.id);
      assert.deepEqual([entries[0].details.ownerId, entries[0].details.role], ['anna', role]);
    }

    // A save over the user route gives the app a new revision: the chat is recorded again,
    // and the entry names the state the save stored.
    const saved = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ system: { en: 'New text.' } });
    assert.equal((await postChat('ben', record.id, chats.ben)).status, 200);
    const entries = await runs(chats.ben);
    assert.deepEqual(
      entries.map(entry => entry.details.revision),
      [stored.revision, saved.body.revision]
    );
    // The revision also grows with member changes, so the stored state is found by its hash.
    const states = await api.repo().listRevisions(record.id);
    const texts = entries.map(
      entry =>
        states.find(candidate => candidate.contentHash === entry.details.contentHash)?.content
          .system.en
    );
    assert.deepEqual(texts, [stored.content.system.en, 'New text.']);
  });
});
