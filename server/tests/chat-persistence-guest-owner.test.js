// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The guest identity an anonymous visitor owns its stored chats through
 * (`services/chat/chatOwner.js`, #2947): minted once per browser, only on API
 * requests, carried as an HttpOnly cookie, stored only as a hash, and never
 * serialized with the user object.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GUEST_COOKIE,
  attachGuestIdentity,
  guestIdFromCookieHeader,
  guestIdOf,
  guestOwnerId,
  parseGuestId,
  resolveChatOwner,
  setGuestId
} from '../services/chat/chatOwner.js';

const anonymous = () => ({ id: 'anonymous', name: 'Anonymous', groups: ['anonymous'] });
const SECRET = 'c'.repeat(64);

function makeRes() {
  const cookies = [];
  return { cookies, cookie: (name, value, options) => cookies.push({ name, value, options }) };
}

function makeReq({ url = '/api/apps/chat/chat/chat-1', cookies = {}, user = anonymous() } = {}) {
  return { originalUrl: url, cookies, user, get: () => undefined, protocol: 'http' };
}

describe('guest identity', () => {
  it('accepts only a 64-hex secret', () => {
    assert.equal(parseGuestId(SECRET), SECRET);
    for (const bad of ['', 'short', 'g'.repeat(64), `${SECRET}0`, null, 42]) {
      assert.equal(parseGuestId(bad), null);
    }
  });

  it('reads the secret out of a raw Cookie header', () => {
    assert.equal(guestIdFromCookieHeader(`authToken=x; ${GUEST_COOKIE}=${SECRET}; a=b`), SECRET);
    assert.equal(guestIdFromCookieHeader('authToken=x'), null);
    assert.equal(guestIdFromCookieHeader(undefined), null);
  });

  it('mints a cookie for an anonymous API request that has none', () => {
    const req = makeReq();
    const res = makeRes();
    const minted = attachGuestIdentity(req, res);
    assert.ok(parseGuestId(minted));
    assert.equal(res.cookies.length, 1);
    assert.equal(res.cookies[0].name, GUEST_COOKIE);
    assert.equal(res.cookies[0].value, minted);
    assert.equal(res.cookies[0].options.httpOnly, true);
    assert.equal(guestIdOf(req.user), minted);
  });

  it('reuses the cookie it was sent, and sets none', () => {
    const req = makeReq({ cookies: { [GUEST_COOKIE]: SECRET } });
    const res = makeRes();
    assert.equal(attachGuestIdentity(req, res), SECRET);
    assert.equal(res.cookies.length, 0);
  });

  it('sets nothing outside the API and nothing for a signed-in user', () => {
    const page = makeRes();
    assert.equal(attachGuestIdentity(makeReq({ url: '/apps/chat' }), page), null);
    assert.equal(page.cookies.length, 0);

    const signedIn = makeRes();
    assert.equal(attachGuestIdentity(makeReq({ user: { id: 'user-1' } }), signedIn), null);
    assert.equal(signedIn.cookies.length, 0);
  });

  it('never rides along when the user object is serialized', () => {
    const user = anonymous();
    setGuestId(user, SECRET);
    assert.ok(!JSON.stringify(user).includes(SECRET));
    assert.ok(!JSON.stringify({ ...user }).includes(SECRET));
  });

  it('owns chats under a hash of the secret, and nothing without one', async () => {
    const user = anonymous();
    assert.equal(await resolveChatOwner(user), null);
    setGuestId(user, SECRET);
    const owner = await resolveChatOwner(user, { mode: 'pseudonymized' });
    assert.equal(owner.id, guestOwnerId(SECRET));
    assert.equal(owner.guest, true);
    assert.ok(!owner.id.includes(SECRET));
  });

  it('a signed-in user owns chats under its run principal', async () => {
    const owner = await resolveChatOwner({ id: 'user-1' }, { mode: 'default' });
    assert.deepEqual(owner, { id: 'user-1', mode: 'default', guest: false });
  });
});
