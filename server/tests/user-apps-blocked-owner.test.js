// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A blocked owner (`platform.userApps.blockedOwners`, design 5 and 8.4) is
 * locked out of their apps (ticket #3897): they still see them, but cannot
 * edit the content, change the members or delete an app. Their editors lost
 * the share with the block and cannot change the app either. Each refusal is
 * 403 `PERMISSION_DENIED` with `details.reason: 'ownerBlocked'`. Unblocking
 * gives everything back.
 *
 * Run: node --test server/tests/user-apps-blocked-owner.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { member, setConfig } from './helpers/userAppsHarness.js';
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
const blockAnna = () => setConfig({ userApps: { blockedOwners: ['anna'] } });

/** An app of Anna, shared with Ben ("Can use") and Carol ("Can edit"). */
const sharedApp = () =>
  api.createApp('anna', { members: [member('ben', 'user'), member('carol', 'editor')] });

const patch = (who, id) =>
  as(who)
    .patch(`/api/apps/${id}`)
    .send({ name: { en: 'Changed' } });
const putMembers = (who, id) =>
  as(who)
    .put(`/api/apps/${id}/members`)
    .send({ members: [{ type: 'user', id: 'ben', role: 'user' }] });

describe('a blocked owner', () => {
  it('still sees the app, read-only, with the reason', async () => {
    const record = await sharedApp();
    blockAnna();
    const res = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(res.status, 200, res.text);
    const { permissions } = res.body;
    assert.equal(permissions.isOwner, true);
    assert.equal(permissions.suspended, 'ownerBlocked');
    assert.deepEqual(
      [permissions.canEdit, permissions.canShare, permissions.canDelete, permissions.canOffer],
      [false, false, false, false]
    );
  });

  it('cannot edit the content', async () => {
    const record = await sharedApp();
    blockAnna();
    assert.deepEqual(problem(await patch('anna', record.id)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'edit', reason: 'ownerBlocked' }
    });
    assert.deepEqual((await api.repo().get(record.id)).content, record.content);
  });

  it('cannot change the members', async () => {
    const record = await sharedApp();
    blockAnna();
    assert.deepEqual(problem(await putMembers('anna', record.id)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'share', reason: 'ownerBlocked' }
    });
    assert.equal((await api.repo().get(record.id)).members.length, 2);
  });

  it('cannot delete the app', async () => {
    const record = await sharedApp();
    blockAnna();
    assert.deepEqual(problem(await as('anna').delete(`/api/apps/${record.id}`)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'delete', reason: 'ownerBlocked' }
    });
    assert.ok(await api.repo().get(record.id));
  });

  it('gets everything back when unblocked', async () => {
    const record = await sharedApp();
    blockAnna();
    setConfig();
    assert.equal((await patch('anna', record.id)).status, 200);
    assert.equal((await as('anna').delete(`/api/apps/${record.id}`)).status, 204);
  });
});

describe('an editor of a blocked owner', () => {
  it('cannot edit the content or change the members either', async () => {
    const record = await sharedApp();
    blockAnna();
    const view = await as('carol').get(`/api/apps/${record.id}`);
    assert.equal(view.body.permissions.suspended, 'ownerBlocked');
    assert.equal(view.body.permissions.canEdit, false);
    assert.deepEqual(problem(await patch('carol', record.id)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'edit', reason: 'ownerBlocked' }
    });
    assert.deepEqual(problem(await putMembers('carol', record.id)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'share', reason: 'ownerBlocked' }
    });
  });
});
