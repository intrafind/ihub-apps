// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A change of owner is an offer (feature `userApps`, design section 8.3):
 * offer, replace, withdraw, decline, lapse and accept, over the user routes.
 * Until the receiver accepts, the owner, the limit count and what the app may
 * do are unchanged.
 *
 * Run: node --test server/tests/user-apps-offer.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OFFER_TTL_MS } from '../services/userApps/userAppAccess.js';
import { ADMIN_APP, groupsWith, member, setConfig } from './helpers/userAppsHarness.js';
import { startUserAppRoutesApi } from './helpers/userAppRoutesApi.js';

let api;
let as;

before(async () => {
  api = await startUserAppRoutesApi();
  ({ as } = api);
});
after(() => api.stop());
beforeEach(() => api.reset());

const problem = res => ({ status: res.status, code: res.body?.code, details: res.body?.details });
const offer = (who, id, ownerId) => as(who).put(`/api/apps/${id}/owner-offer`).send({ ownerId });
const withdraw = (who, id) => as(who).delete(`/api/apps/${id}/owner-offer`);
const accept = (who, id, revision) => {
  const req = as(who).post(`/api/apps/${id}/owner-offer/_accept`);
  return revision === undefined ? req : req.set('If-Match', `"${revision}"`);
};
const read = (who, id) => as(who).get(`/api/apps/${id}`);

/** An app of Anna, shared with Ben ("Can use") and Carol ("Can edit"). */
const sharedApp = (options = {}) =>
  api.createApp('anna', {
    members: [member('ben', 'user'), member('carol', 'editor')],
    ...options
  });

describe('an offer', () => {
  it('leaves the owner in place and lets the receiver read and use the app', async () => {
    const record = await sharedApp();
    assert.equal((await read('dave', record.id)).status, 404);

    const res = await offer('anna', record.id, 'dave');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.etag, `"${record.revision + 1}"`);
    assert.deepEqual(res.body.owner, { id: 'anna', name: 'Anna Schmidt', active: true });
    assert.equal(res.body.pendingOwner.id, 'dave');
    assert.equal(res.body.pendingOwner.name, 'Dave Lund');
    assert.deepEqual(res.body.pendingOwner.offeredBy, { id: 'anna', name: 'Anna Schmidt' });
    assert.ok(Date.parse(res.body.pendingOwner.offeredAt));

    // Until the accept: the owner, the snapshot of the owner's rights and the members are unchanged.
    const stored = await api.repo().get(record.id);
    assert.equal(stored.owner.id, 'anna');
    assert.deepEqual(stored.ownerPrincipal, record.ownerPrincipal);
    assert.deepEqual(stored.members, record.members);
    assert.equal(await api.repo().countOwned('anna'), 1);
    assert.equal(await api.repo().countOwned('dave'), 0);

    // The receiver reads the app, its members and its instructions, and may use it as a member would.
    const seen = await read('dave', record.id);
    assert.equal(seen.status, 200, seen.text);
    assert.equal(seen.body.permissions.role, 'offered');
    assert.deepEqual(
      [
        seen.body.permissions.canUse,
        seen.body.permissions.canEdit,
        seen.body.permissions.canAcceptOffer
      ],
      [true, false, true]
    );
    assert.equal(seen.body.owner.id, 'anna');
    assert.equal(seen.body.members.length, 2);
    // What the app may do is still decided for someone who is not its owner.
    assert.deepEqual(seen.body.approval, { mode: 'always', chatGrants: false });
    assert.equal(seen.body.toolApproval.default, 'always');
    assert.deepEqual((await read('anna', record.id)).body.approval, {
      mode: 'writes',
      chatGrants: true
    });

    // The offered app is in the receiver's list of own apps, marked as offered.
    const mine = await as('dave').get('/api/apps?scope=mine');
    assert.deepEqual(
      mine.body.items.map(item => [item.id, item.permissions.role]),
      [[record.id, 'offered']]
    );
    // A "Can use" member does not learn of the offer.
    assert.equal('pendingOwner' in (await read('ben', record.id)).body, false);
  });

  it('is replaced by a second offer', async () => {
    const record = await sharedApp();
    assert.equal((await offer('anna', record.id, 'dave')).status, 200);
    const second = await offer('anna', record.id, 'mallory');
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.pendingOwner.id, 'mallory');
    assert.equal((await read('dave', record.id)).status, 404);
    assert.equal((await read('mallory', record.id)).body.permissions.role, 'offered');
    assert.deepEqual((await as('dave').get('/api/apps?scope=mine')).body.items, []);
    assert.equal(await api.repo().countOpenOffers('anna'), 1);
    // The first receiver cannot accept any more.
    assert.equal((await accept('dave', record.id, second.body.revision)).status, 404);
  });

  it('can be made by the owner and a full admin only, for a known, active user who is not the owner', async () => {
    const record = await sharedApp();
    for (const who of ['carol', 'ben']) {
      assert.deepEqual(
        problem(await offer(who, record.id, 'dave')),
        { status: 403, code: 'PERMISSION_DENIED', details: { required: 'offer' } },
        who
      );
    }
    for (const ownerId of ['nobody', 'gone', 'anna']) {
      const res = await offer('anna', record.id, ownerId);
      assert.deepEqual([res.status, res.body.code], [400, 'VALIDATION_FAILED'], ownerId);
    }
    const unknownKey = await as('anna')
      .put(`/api/apps/${record.id}/owner-offer`)
      .send({ ownerId: 'dave', revision: 3 });
    assert.equal(unknownKey.body.code, 'VALIDATION_FAILED');
    const stale = await as('anna')
      .put(`/api/apps/${record.id}/owner-offer`)
      .set('If-Match', '"1"')
      .send({ ownerId: 'dave' });
    assert.deepEqual([stale.status, stale.body.code], [409, 'ETAG_MISMATCH']);
    assert.equal((await api.repo().get(record.id)).pendingOwner, null);
  });

  it('is refused for a promoted and a switched-off app', async () => {
    const off = await sharedApp({
      change: r => ({ ...r, disabled: { at: 'x', by: { id: 'root' }, reason: 'x' } })
    });
    const gone = await sharedApp({
      change: r => ({
        ...r,
        state: 'promoted',
        publishedAs: { appId: ADMIN_APP, at: 'x', by: r.owner }
      })
    });
    for (const who of ['anna', 'root']) {
      assert.deepEqual(problem(await offer(who, off.id, 'dave')), {
        status: 409,
        code: 'CONFLICT',
        details: { reason: 'disabled' }
      });
      assert.deepEqual(problem(await offer(who, gone.id, 'dave')).details, { reason: 'promoted' });
    }
  });

  it('the sixth open offer answers 409, and replacing one of the five does not', async () => {
    const apps = [];
    for (let index = 0; index < 6; index += 1) apps.push(await api.createApp('anna'));
    for (const app of apps.slice(0, 5)) {
      assert.equal((await offer('anna', app.id, 'dave')).status, 200);
    }
    const sixth = await offer('anna', apps[5].id, 'dave');
    assert.deepEqual([sixth.status, sixth.body.code], [409, 'QUOTA_USER_APP_OFFERS']);
    // The limit, for the sentence "You have 5 open offers. Withdraw one first."
    assert.deepEqual(sixth.body.details, { max: 5 });
    assert.equal((await api.repo().get(apps[5].id)).pendingOwner, null);
    assert.equal((await offer('anna', apps[0].id, 'ben')).status, 200);
    // A withdrawn offer makes room.
    assert.equal((await withdraw('anna', apps[1].id)).status, 204);
    assert.equal((await offer('anna', apps[5].id, 'dave')).status, 200);
    // The count is the sender's: another owner is not affected.
    const other = await api.createApp('carol');
    assert.equal((await offer('carol', other.id, 'dave')).status, 200);
  });
});

describe('withdraw and decline', () => {
  it('the owner withdraws, the receiver declines, a member can do neither', async () => {
    const record = await sharedApp();
    await offer('anna', record.id, 'dave');
    assert.deepEqual(problem(await withdraw('carol', record.id)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'offer' }
    });
    assert.equal((await withdraw('mallory', record.id)).status, 404);

    const declined = await withdraw('dave', record.id);
    assert.equal(declined.status, 204, declined.text);
    assert.equal((await api.repo().get(record.id)).pendingOwner, null);
    assert.equal((await read('dave', record.id)).status, 404);
    assert.deepEqual((await as('dave').get('/api/apps?scope=mine')).body.items, []);

    await offer('anna', record.id, 'dave');
    assert.equal((await withdraw('anna', record.id)).status, 204);
    assert.equal((await read('dave', record.id)).status, 404);
    assert.equal(await api.repo().countOpenOffers('anna'), 0);

    // Nothing to withdraw.
    const none = await withdraw('anna', record.id);
    assert.deepEqual([none.status, none.body.code], [404, 'NOT_FOUND']);
    // A full admin withdraws an owner's offer.
    await offer('anna', record.id, 'dave');
    assert.equal((await withdraw('root', record.id)).status, 204);
  });
});

describe('an offer to a person the app is already shared with', () => {
  for (const [who, role] of [
    ['ben', 'user'],
    ['carol', 'editor']
  ]) {
    it(`"${role}": keeps the role of the share, sees the offer, and can accept it`, async () => {
      const record = await sharedApp();
      const offered = (await offer('anna', record.id, who)).body;

      const seen = await read(who, record.id);
      assert.equal(seen.status, 200, seen.text);
      // The share still decides what they may do with the app.
      assert.equal(seen.body.permissions.role, role);
      assert.equal(seen.body.permissions.canEdit, role === 'editor');
      assert.equal(seen.body.permissions.canAcceptOffer, true);
      // The offer and what a receiver reads before answering: who offered it, and the members.
      assert.equal(seen.body.pendingOwner.id, who);
      assert.deepEqual(seen.body.pendingOwner.offeredBy, { id: 'anna', name: 'Anna Schmidt' });
      assert.equal(seen.body.members.length, 2);

      // Listed with the receiver's own apps, once, and not also as a shared app.
      const mine = (await as(who).get('/api/apps?scope=mine')).body.items;
      assert.deepEqual(
        mine.map(item => item.id),
        [record.id]
      );
      assert.equal(mine[0].pendingOwner.id, who);
      const shared = (await as(who).get('/api/apps?scope=shared')).body.items;
      assert.deepEqual(shared, []);
      const both = (await as(who).get('/api/apps?scope=personal')).body.items;
      assert.equal(both.filter(item => item.id === record.id).length, 1);

      // A member the offer is not for does not read it.
      const other = who === 'ben' ? 'carol' : 'ben';
      assert.equal('pendingOwner' in (await read(other, record.id)).body, false);
      assert.equal((await read(other, record.id)).body.permissions.canAcceptOffer, false);

      const res = await accept(who, record.id, offered.revision);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.owner.id, who);
      assert.equal(res.body.permissions.isOwner, true);
      // The new owner's own share is gone.
      assert.equal(
        res.body.members.some(entry => entry.id === who),
        false
      );
    });
  }
});

describe('an offer lapses after 30 days', () => {
  const lapsedOffer = async record =>
    api.repo().setOffer(
      record.id,
      { id: 'dave', name: 'Dave Lund' },
      {
        actor: { id: 'anna', name: 'Anna Schmidt' },
        now: new Date(Date.now() - OFFER_TTL_MS - 60_000).toISOString()
      }
    );

  it('and is then treated as none', async () => {
    const record = await sharedApp();
    const offered = await lapsedOffer(record);
    assert.equal((await read('dave', record.id)).status, 404);
    assert.equal((await accept('dave', record.id, offered.revision)).status, 404);
    // A person who cannot see the app removes nothing.
    assert.equal((await api.repo().get(record.id)).pendingOwner.id, 'dave');
    const seen = await read('anna', record.id);
    assert.equal(seen.body.pendingOwner, null);
    assert.equal(await api.repo().countOpenOffers('anna'), 0);
    // The read removed what was left of it, without a new revision, and recorded it once.
    const stored = await api.repo().get(record.id);
    assert.equal(stored.owner.id, 'anna');
    assert.equal(stored.pendingOwner, null);
    assert.equal(stored.revision, offered.revision);
    assert.equal(seen.body.revision, offered.revision);
    await read('anna', record.id);
    const lapsed = (await api.audit(record.id, { resource: 'userAppShare' })).filter(
      entry => entry.details?.offer === 'lapsed'
    );
    assert.equal(lapsed.length, 1);
    assert.deepEqual(
      { from: lapsed[0].details.from, to: lapsed[0].details.to, action: lapsed[0].action },
      { from: 'anna', to: 'dave', action: 'update' }
    );
    assert.equal(lapsed[0].details.revision, offered.revision);
    assert.ok(lapsed[0].details.contentHash);
    assert.equal((await withdraw('anna', record.id)).status, 404);
    // A lapsed offer nobody read is replaced by a new one.
    await lapsedOffer(record);
    const again = await offer('anna', record.id, 'mallory');
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.pendingOwner.id, 'mallory');
  });

  it('a member who was the receiver cannot accept it', async () => {
    const record = await api.createApp('anna', { members: [member('dave', 'user')] });
    const offered = await lapsedOffer(record);
    const res = await accept('dave', record.id, offered.revision);
    assert.deepEqual([res.status, res.body.code], [404, 'NOT_FOUND']);
    assert.equal((await api.repo().get(record.id)).owner.id, 'anna');
  });
});

describe('accept', () => {
  it('is for the receiver only, and needs If-Match', async () => {
    const record = await sharedApp();
    const offered = (await offer('anna', record.id, 'dave')).body;

    for (const who of ['anna', 'ben', 'carol', 'root']) {
      const res = await accept(who, record.id, offered.revision);
      assert.deepEqual([res.status, res.body.code], [404, 'NOT_FOUND'], who);
    }
    const missing = await accept('dave', record.id);
    assert.deepEqual([missing.status, missing.body.code], [400, 'VALIDATION_FAILED']);
    // An editor changed the app after the receiver read it.
    assert.equal(
      (
        await as('carol')
          .patch(`/api/apps/${record.id}`)
          .send({ system: { en: 'Changed.' } })
      ).status,
      200
    );
    const stale = await accept('dave', record.id, offered.revision);
    assert.deepEqual([stale.status, stale.body.code], [409, 'ETAG_MISMATCH']);
    assert.equal((await api.repo().get(record.id)).owner.id, 'anna');

    const fresh = (await read('dave', record.id)).body;
    const res = await accept('dave', record.id, fresh.revision);
    assert.equal(res.status, 200, res.text);
  });

  it('swaps the owner, turns every editor into "Can use" and leaves the previous owner no role', async () => {
    const record = await api.createApp('anna', {
      members: [
        member('ben', 'user'),
        member('carol', 'editor'),
        member('dave', 'editor'),
        member('staff', 'editor', 'group')
      ]
    });
    const offered = (await offer('anna', record.id, 'dave')).body;
    const res = await accept('dave', record.id, offered.revision);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.etag, `"${offered.revision + 1}"`);
    assert.deepEqual(res.body.owner, { id: 'dave', name: 'Dave Lund', active: true });
    assert.equal(res.body.permissions.role, 'owner');
    assert.equal(res.body.pendingOwner, null);
    assert.deepEqual(
      res.body.members.map(entry => [entry.type, entry.id, entry.role]),
      [
        ['user', 'ben', 'user'],
        ['user', 'carol', 'user'],
        ['group', 'staff', 'user']
      ]
    );
    // The ceiling follows the new owner from here on.
    assert.deepEqual(res.body.approval, { mode: 'writes', chatGrants: true });

    const stored = await api.repo().get(record.id);
    assert.equal(stored.ownerPrincipal.userId, 'dave');
    assert.equal((await read('anna', record.id)).status, 404);
    assert.equal(
      (
        await as('carol')
          .patch(`/api/apps/${record.id}`)
          .send({ name: { en: 'x' } })
      ).status,
      403
    );
    assert.equal((await read('carol', record.id)).body.permissions.role, 'user');
    assert.equal(await api.repo().countOwned('anna'), 0);
    assert.equal(await api.repo().countOwned('dave'), 1);
    assert.equal(await api.repo().countOpenOffers('anna'), 0);
    // A second accept finds no offer.
    assert.equal((await accept('dave', record.id, stored.revision)).status, 404);
  });

  it('a receiver without the right to create gets 403, and nothing changes', async () => {
    api.addPerson('guest', {
      id: 'guest',
      name: 'Gus Guest',
      authMode: 'oidc',
      groups: ['guests']
    });
    api.users.guest = { id: 'guest', name: 'Gus Guest', active: true };
    const record = await sharedApp();
    const offered = (await offer('anna', record.id, 'guest')).body;
    assert.deepEqual(problem(await accept('guest', record.id, offered.revision)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userApps' }
    });
    // A blocked receiver is refused the same way.
    await offer('anna', record.id, 'dave');
    setConfig({ userApps: { blockedOwners: ['dave'] } });
    const blocked = await accept('dave', record.id, (await api.repo().get(record.id)).revision);
    assert.deepEqual(blocked.body.details, { required: 'userApps', reason: 'ownerBlocked' });
    assert.equal((await api.repo().get(record.id)).owner.id, 'anna');
  });

  it('a receiver at the limit gets 409, and the sender still owns and counts the app', async () => {
    setConfig({ userApps: { limits: { maxAppsPerUser: 1 } } });
    await api.createApp('dave');
    const record = await sharedApp();
    const offered = (await offer('anna', record.id, 'dave')).body;
    const res = await accept('dave', record.id, offered.revision);
    assert.deepEqual([res.status, res.body.code], [409, 'QUOTA_USER_APPS']);
    const stored = await api.repo().get(record.id);
    assert.equal(stored.owner.id, 'anna');
    assert.equal(stored.pendingOwner.id, 'dave');
    assert.equal(await api.repo().countOwned('anna'), 1);
    assert.equal(await api.repo().countOwned('dave'), 1);
    // The sender cannot create another app: the offered one still counts.
    const create = await as('anna')
      .post('/api/apps')
      .send({ name: { en: 'a' }, description: { en: 'b' }, system: { en: 'c' } });
    assert.equal(create.body.code, 'QUOTA_USER_APPS');
  });

  it('is refused once the app is switched off', async () => {
    const record = await sharedApp();
    const offered = (await offer('anna', record.id, 'dave')).body;
    const off = await api.repo().mutate(record.id, r => ({
      ...r,
      disabled: { at: 'x', by: { id: 'root' }, reason: 'x' }
    }));
    const res = await accept('dave', record.id, off.revision);
    assert.deepEqual(problem(res), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'disabled' }
    });
    assert.equal(offered.owner.id, 'anna');
    assert.equal((await api.repo().get(record.id)).owner.id, 'anna');
  });
});

describe('a full admin changes an owner the same way', () => {
  it('the admin offers, the receiver accepts; the admin cannot make someone the owner', async () => {
    const record = await sharedApp();
    const res = await offer('root', record.id, 'dave');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.permissions.role, 'admin');
    assert.deepEqual(res.body.pendingOwner.offeredBy, { id: 'root', name: 'Ada Admin' });
    assert.equal(res.body.owner.id, 'anna');
    // The offer counts for the admin who made it.
    assert.deepEqual(
      [await api.repo().countOpenOffers('root'), await api.repo().countOpenOffers('anna')],
      [1, 0]
    );
    assert.equal((await accept('root', record.id, res.body.revision)).status, 404);
    const accepted = await accept('dave', record.id, res.body.revision);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.owner.id, 'dave');
    assert.ok(accepted.body.members.every(entry => entry.role === 'user'));
  });

  it('a personal API key of an admin and a content admin cannot offer', async () => {
    const record = await sharedApp();
    assert.equal((await offer('rootKey', record.id, 'dave')).status, 404);
    assert.equal((await offer('builder', record.id, 'dave')).status, 404);
  });

  it('an offer for an app whose owner lost the permissions can still be accepted', async () => {
    setConfig({ groups: groupsWith({ users: { userApps: false, userAppSharing: false } }) });
    const record = await api.createApp('anna', { members: [member('sam', 'user')] });
    const res = await offer('root', record.id, 'sam');
    assert.equal(res.status, 200, res.text);
    const accepted = await accept('sam', record.id, res.body.revision);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.owner.id, 'sam');
  });
});
