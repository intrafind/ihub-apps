/**
 * Chat sharing, driven through the real route chains (#2515).
 *
 * Everything below the handlers is real: a filesystem storage provider over
 * `mkdtemp`, the chat repository, the share repository, the artifact store
 * and the two access checks. The authentication middleware in front of the
 * owner routes is run as registered — `requireFeature` reads the feature
 * cache, `authenticatedOnly` reads `req.user` — and the viewer routes carry
 * none, which is the point: a public share must open with no user at all.
 *
 * What is pinned here is what a share promises:
 *
 *  - who may open a link, per mode (the access matrix);
 *  - that a link shows the chat as it was, not as it is (the snapshot);
 *  - that only the artifacts the snapshot named are reachable (the allow-list);
 *  - that a view limit, an expiry and a revoke all close the link the same way;
 *  - that deleting the chat takes its shares with it;
 *  - that a viewer learns nothing about the owner, the chat or the other
 *    recipients.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getChatShareRepository, isShareId } from '../services/chat/ChatShareRepository.js';
import {
  SHARE_ARTIFACT_GRACE_MS,
  isWithinArtifactGrace,
  resolveShareLimits,
  shareState
} from '../services/chat/chatSharing.js';
import { authorizeShareView } from '../services/chat/chatShareAccess.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { fingerprint } from '../services/UserFingerprint.js';
import registerChatShareRoutes, { downloadName } from '../routes/chatShares.js';
import registerChatRoutes from '../routes/chats.js';

const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', email: 'grace@example.com' };
const LINUS = { id: 'user-linus', name: 'Linus Torvalds', email: 'linus@example.com' };
const ROOT = { id: 'user-root', name: 'Root', isAdmin: true, groups: ['admins'] };
const ANONYMOUS = undefined;

const DAY_MS = 24 * 60 * 60 * 1000;

let baseDir;
let platform;

function captureRoutes(register) {
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {}
  });
  return routes;
}

const shareRoutes = captureRoutes(registerChatShareRoutes);
const chatRoutes = captureRoutes(registerChatRoutes);

function handlersFor(routes, method, suffix) {
  const route = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

function makeResponse() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.send = value => {
    res.body = value;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  res.set = res.setHeader;
  return res;
}

/**
 * Drive a whole handler chain, middleware included.
 *
 * @param {Function[]} handlers - Chain as registered.
 * @param {Object} params
 * @returns {Promise<Object>} The response double.
 */
async function drive(handlers, { params = {}, query = {}, body = {}, user } = {}) {
  const req = { params, query, body, headers: {}, user, ip: '127.0.0.1', method: 'GET', url: '/' };
  const res = makeResponse();
  for (let index = 0; index < handlers.length; index += 1) {
    let advanced = false;
    await handlers[index](req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

const createHandlers = handlersFor(shareRoutes, 'post', '/api/chats/:chatId/shares');
const listHandlers = handlersFor(shareRoutes, 'get', '/api/chats/:chatId/shares');
const withMeHandlers = handlersFor(shareRoutes, 'get', '/api/shares/with-me');
const openHandlers = handlersFor(shareRoutes, 'get', '/api/shares/:shareId');
const artifactsHandlers = handlersFor(shareRoutes, 'get', '/api/shares/:shareId/artifacts');
const artifactHandlers = handlersFor(
  shareRoutes,
  'get',
  '/api/shares/:shareId/artifacts/:artifactId'
);
const revokeHandlers = handlersFor(shareRoutes, 'delete', '/api/shares/:shareId');
const lookupHandlers = handlersFor(shareRoutes, 'get', '/api/users/lookup');
const deleteChatHandlers = handlersFor(chatRoutes, 'delete', '/api/chats/:chatId');

let chatCounter = 0;

/**
 * Store a chat with a few messages, owned by `user`.
 *
 * @param {Object} user - Owner.
 * @param {Object} [options]
 * @param {number} [options.turns=2] - User messages to write.
 * @returns {Promise<string>} The chat id.
 */
async function seedChat(user, { turns = 2 } = {}) {
  chatCounter += 1;
  const chatId = `chat-${chatCounter}`;
  const repository = getChatRepository();
  await repository.ensureChat({ chatId, ownerId: user.id, appId: 'chat', title: 'A shared chat' });
  for (let i = 1; i <= turns; i += 1) {
    await repository.appendMessage(chatId, {
      role: 'user',
      content: `question ${i}`,
      clientMessageId: `client-${i}`
    });
    await repository.appendMessage(chatId, {
      role: 'assistant',
      content: `answer ${i}`,
      usage: { totalTokens: 10 }
    });
  }
  return chatId;
}

/**
 * Store one image artifact against a chat and record it on a new message.
 *
 * @param {string} chatId - Chat id.
 * @param {string} label - Distinguishes the bytes.
 * @returns {Promise<Object>} The descriptor as stored on the message.
 */
async function seedArtifact(chatId, label) {
  const repository = getChatRepository();
  const bytes = Buffer.from(`png-bytes-${label}`);
  const stored = await repository.artifactStore().put(repository.artifactScope(chatId), {
    kind: 'image',
    mimeType: 'image/png',
    data: bytes.toString('base64'),
    name: `${label}.png`
  });
  assert.ok(stored?.id, 'the artifact was stored');
  await repository.appendMessage(chatId, {
    role: 'assistant',
    content: `here is ${label}`,
    artifacts: [stored]
  });
  return stored;
}

async function createShare(user, chatId, body) {
  const res = await drive(createHandlers, { params: { chatId }, body, user });
  return res;
}

function setSharing(overrides = {}) {
  platform.chats.sharing = { ...platform.chats.sharing, ...overrides };
  configCache.setCacheEntry('config/platform.json', platform);
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-shares-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  // The recipient picker and the recipient check read the user database the
  // login paths read; point it at a file of our own.
  const usersFile = path.join(baseDir, 'users.json');
  await fs.writeFile(
    usersFile,
    JSON.stringify({
      users: {
        [ADA.id]: { ...ADA, username: 'ada', active: true, passwordHash: 'x' },
        [GRACE.id]: { ...GRACE, username: 'grace', active: true, passwordHash: 'x' },
        [LINUS.id]: { ...LINUS, username: 'linus', active: false, passwordHash: 'x' }
      }
    }),
    'utf8'
  );
  platform = {
    chats: {
      enabled: true,
      sharing: {
        enabled: true,
        allowUsers: true,
        allowAuthenticated: true,
        allowPublic: true,
        defaultExpiryDays: 0,
        maxExpiryDays: 0,
        maxViewsCap: 0
      }
    },
    localAuth: { usersFile }
  };
  configCache.setCacheEntry('config/features.json', { chatPersistence: true, chatSharing: true });
  configCache.setCacheEntry('config/platform.json', platform);
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(() => setSharing({ allowPublic: true, maxExpiryDays: 0, maxViewsCap: 0 }));

describe('the policy helpers', () => {
  it('reads a share state from its record', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    assert.equal(shareState(null, now), 'missing');
    assert.equal(shareState({ viewCount: 0 }, now), 'active');
    assert.equal(shareState({ revokedAt: '2026-09-24T11:00:00Z' }, now), 'revoked');
    assert.equal(shareState({ expiresAt: '2026-09-24T11:59:59Z' }, now), 'expired');
    assert.equal(shareState({ expiresAt: '2026-09-24T12:00:01Z' }, now), 'active');
    assert.equal(shareState({ maxViews: 2, viewCount: 2 }, now), 'exhausted');
    assert.equal(shareState({ maxViews: 2, viewCount: 1 }, now), 'active');
  });

  it('bounds an owner’s expiry and view limit by the admin caps', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    const open = { defaultExpiryDays: 0, maxExpiryDays: 0, maxViewsCap: 0 };
    assert.deepEqual(resolveShareLimits({}, open, now), {
      ok: true,
      expiresAt: null,
      maxViews: null
    });
    // A default expiry fills in when the owner names none.
    assert.equal(
      resolveShareLimits({}, { ...open, defaultExpiryDays: 7 }, now).expiresAt,
      new Date(now + 7 * DAY_MS).toISOString()
    );
    // A cap decides for an owner who asked for "never", and refuses a later date.
    assert.equal(
      resolveShareLimits({}, { ...open, maxExpiryDays: 30 }, now).expiresAt,
      new Date(now + 30 * DAY_MS).toISOString()
    );
    assert.equal(
      resolveShareLimits(
        { expiresAt: new Date(now + 31 * DAY_MS).toISOString() },
        { ...open, maxExpiryDays: 30 },
        now
      ).ok,
      false
    );
    assert.equal(resolveShareLimits({ expiresAt: 'yesterday' }, open, now).ok, false);
    assert.equal(
      resolveShareLimits({ expiresAt: new Date(now - 1000).toISOString() }, open, now).ok,
      false
    );
    // Views: a cap fills in for "unlimited" and refuses more.
    assert.equal(resolveShareLimits({}, { ...open, maxViewsCap: 5 }, now).maxViews, 5);
    assert.equal(resolveShareLimits({ maxViews: 6 }, { ...open, maxViewsCap: 5 }, now).ok, false);
    assert.equal(resolveShareLimits({ maxViews: 0 }, open, now).ok, false);
    assert.equal(resolveShareLimits({ maxViews: 2.5 }, open, now).ok, false);
  });

  it('never lets a default expiry exceed the longest expiry an owner may pick', () => {
    // An admin who sets the default above the cap gets the cap applied, not a
    // form that refuses every owner who left the expiry alone.
    const now = Date.parse('2026-09-24T12:00:00Z');
    const settings = { defaultExpiryDays: 30, maxExpiryDays: 7, maxViewsCap: 0 };
    const limits = resolveShareLimits({}, settings, now);
    assert.equal(limits.ok, true);
    assert.equal(limits.expiresAt, new Date(now + 7 * DAY_MS).toISOString());
  });

  it('grants a used-up share a short window for its artifacts, and nothing else', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    const justUsedUp = {
      maxViews: 1,
      viewCount: 1,
      lastViewedAt: new Date(now - 1000).toISOString()
    };
    assert.equal(isWithinArtifactGrace(justUsedUp, now), true);
    const longAgo = {
      ...justUsedUp,
      lastViewedAt: new Date(now - SHARE_ARTIFACT_GRACE_MS - 1).toISOString()
    };
    assert.equal(isWithinArtifactGrace(longAgo, now), false);
    assert.equal(
      isWithinArtifactGrace({ ...justUsedUp, revokedAt: '2026-09-24T11:00:00Z' }, now),
      false
    );
    assert.equal(isWithinArtifactGrace({ viewCount: 0 }, now), false, 'an active share needs none');
  });

  it('builds a download name that survives a cut through a surrogate pair', () => {
    // The stored name is capped at 200 UTF-16 units elsewhere, which can split
    // an emoji; the header must still be encodable.
    const name = `${'a'.repeat(199)}😀`.slice(0, 200);
    const result = downloadName({ id: 'x', kind: 'image', mimeType: 'image/png', name });
    assert.doesNotThrow(() => encodeURIComponent(result));
    assert.equal(
      downloadName({ id: 'abcdef0123', kind: 'image', mimeType: 'image/png' }),
      'image-abcdef01.png'
    );
    assert.equal(
      downloadName({ id: 'x', kind: 'image', mimeType: 'image/png', name: 'a/b"c\nd.png' }),
      'a_b_c_d.png'
    );
  });
});

describe('creating a share', () => {
  it('is the owner’s call: a signed-in stranger and an admin both get 404', async () => {
    const chatId = await seedChat(ADA);
    const stranger = await createShare(GRACE, chatId, { mode: 'authenticated' });
    assert.equal(stranger.statusCode, 404);
    const admin = await createShare(ROOT, chatId, { mode: 'authenticated' });
    assert.equal(admin.statusCode, 404, 'the admin read bypass does not extend to publishing');
  });

  it('mints an unguessable id that is not the chat id, and answers the owner’s view', async () => {
    const chatId = await seedChat(ADA);
    const res = await createShare(ADA, chatId, { mode: 'authenticated' });
    assert.equal(res.statusCode, 201);
    const { share } = res.body;
    assert.ok(isShareId(share.id));
    assert.notEqual(share.id, chatId);
    assert.ok(share.id.length >= 30);
    assert.equal(share.state, 'active');
    assert.equal(share.messageCount, 4);
    assert.equal(share.viewCount, 0);
    assert.equal('views' in share, false, 'the per-view log is not part of the owner view');
  });

  it('refuses an audience the admin switched off', async () => {
    const chatId = await seedChat(ADA);
    setSharing({ allowPublic: false });
    const res = await createShare(ADA, chatId, { mode: 'public' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.details.code, 'SHARE_MODE_DISABLED');
  });

  it('refuses an empty chat and a malformed body', async () => {
    const chatId = await seedChat(ADA, { turns: 0 });
    assert.equal((await createShare(ADA, chatId, { mode: 'authenticated' })).statusCode, 400);
    const full = await seedChat(ADA);
    assert.equal((await createShare(ADA, full, { mode: 'everyone' })).statusCode, 400);
    assert.equal(
      (await createShare(ADA, full, { mode: 'authenticated', surprise: true })).statusCode,
      400
    );
  });

  it('checks recipients against the user database', async () => {
    const chatId = await seedChat(ADA);
    const none = await createShare(ADA, chatId, { mode: 'users', recipients: [] });
    assert.equal(none.statusCode, 400);
    const unknown = await createShare(ADA, chatId, { mode: 'users', recipients: ['nobody'] });
    assert.equal(unknown.statusCode, 400);
    assert.deepEqual(unknown.body.details.unknown, ['nobody']);
    const inactive = await createShare(ADA, chatId, { mode: 'users', recipients: [LINUS.id] });
    assert.equal(inactive.statusCode, 400, 'a deactivated account cannot be a recipient');
    const proto = await createShare(ADA, chatId, { mode: 'users', recipients: ['__proto__'] });
    assert.equal(proto.statusCode, 400, 'a prototype key is not a user');
    const ok = await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id, GRACE.id] });
    assert.equal(ok.statusCode, 201);
    assert.deepEqual(ok.body.share.recipients, [GRACE.id]);
    assert.deepEqual(ok.body.share.recipientDetails, [
      { id: GRACE.id, name: GRACE.name, email: GRACE.email }
    ]);
  });

  it('applies the admin caps server-side, whatever the form sent', async () => {
    const chatId = await seedChat(ADA);
    setSharing({ maxViewsCap: 3, maxExpiryDays: 2 });
    const tooMany = await createShare(ADA, chatId, { mode: 'authenticated', maxViews: 4 });
    assert.equal(tooMany.statusCode, 400);
    const res = await createShare(ADA, chatId, { mode: 'authenticated' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.share.maxViews, 3);
    assert.ok(res.body.share.expiresAt, 'a cap on expiry means every link expires');
    assert.ok(Date.parse(res.body.share.expiresAt) <= Date.now() + 2 * DAY_MS + 1000);
  });
});

describe('who may open a link', () => {
  it('public: opens for nobody at all, and every such open counts', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'public' })).body;
    const res = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.body.messages.length, 4);
    const again = await drive(openHandlers, { params: { shareId: share.id }, user: GRACE });
    assert.equal(again.statusCode, 200);
    const stored = await getChatShareRepository().getShare(share.id);
    assert.equal(stored.viewCount, 2);
    assert.deepEqual(
      stored.views.map(view => view.userId),
      [null, GRACE.id]
    );
  });

  it('authenticated: an anonymous visitor is told to sign in, anyone signed in gets through', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'authenticated' })).body;
    const anon = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(anon.statusCode, 401);
    assert.equal(anon.body.details.code, 'AUTH_REQUIRED');
    const named = await drive(openHandlers, {
      params: { shareId: share.id },
      user: { id: 'anonymous' }
    });
    assert.equal(named.statusCode, 401, 'the literal anonymous principal is anonymous too');
    const grace = await drive(openHandlers, { params: { shareId: share.id }, user: GRACE });
    assert.equal(grace.statusCode, 200);
  });

  it('users: only the people on the list, and the owner', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id] }))
      .body;
    assert.equal(
      (await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS })).statusCode,
      401
    );
    const stranger = { id: 'user-stranger', name: 'Stranger' };
    assert.equal(
      (await drive(openHandlers, { params: { shareId: share.id }, user: stranger })).statusCode,
      404,
      'not on the list reads exactly like no such link'
    );
    const grace = await drive(openHandlers, { params: { shareId: share.id }, user: GRACE });
    assert.equal(grace.statusCode, 200);
    const owner = await drive(openHandlers, { params: { shareId: share.id }, user: ADA });
    assert.equal(owner.statusCode, 200, 'the owner may check their own link');
    const stored = await getChatShareRepository().getShare(share.id);
    assert.equal(stored.viewCount, 1, 'the owner’s own open is not a view');
    assert.equal(stored.recipientViews[GRACE.id].count, 1);
  });

  it('an admin may read any link, without counting', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id] }))
      .body;
    const res = await drive(openHandlers, { params: { shareId: share.id }, user: ROOT });
    assert.equal(res.statusCode, 200);
    assert.equal((await getChatShareRepository().getShare(share.id)).viewCount, 0);
  });

  it('an unknown or malformed id is 404, never an error', async () => {
    for (const shareId of ['shr_doesnotexist', 'chat-1', '../etc/passwd', 'with-me']) {
      const res = await drive(openHandlers, { params: { shareId }, user: GRACE });
      assert.equal(res.statusCode, 404, shareId);
    }
  });

  it('every link is dead while sharing is switched off', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'public' })).body;
    setSharing({ enabled: false });
    try {
      const res = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
      assert.equal(res.statusCode, 404);
    } finally {
      setSharing({ enabled: true });
    }
  });
});

describe('identity modes and delegated principals', () => {
  it('writes no owner name on a pseudonymized installation, and hides the toggle server-side', async () => {
    chatCounter += 1;
    const chatId = `chat-pseudo-${chatCounter}`;
    const repository = getChatRepository();
    // A pseudonymized chat is owned by the hashed principal, which is what the
    // access check resolves the caller to in that mode.
    await repository.ensureChat({
      chatId,
      ownerId: await fingerprint(ADA.id),
      identityMode: 'pseudonymized',
      appId: 'chat',
      title: 'Hashed owner'
    });
    await repository.appendMessage(chatId, { role: 'user', content: 'hello' });
    await repository.appendMessage(chatId, { role: 'assistant', content: 'hi' });

    const res = await createShare(ADA, chatId, { mode: 'public', showOwnerName: true });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.share.ownerName, null);
    assert.equal(res.body.share.showOwnerName, false);

    const view = await drive(openHandlers, {
      params: { shareId: res.body.share.id },
      user: GRACE
    });
    assert.equal(view.statusCode, 200);
    assert.equal(view.body.share.sharedBy, null);
    // The per-view log stores the viewer the way the mode records people.
    const stored = await getChatShareRepository().getShare(res.body.share.id);
    assert.equal(stored.views[0].userId, await fingerprint(GRACE.id));
    assert.notEqual(stored.views[0].userId, GRACE.id);
  });

  it("a delegated token with the admin's groups is not an admin here", async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id] }))
      .body;
    const apiKey = { ...ROOT, authMode: 'oauth_personal_key' };
    const read = await drive(openHandlers, { params: { shareId: share.id }, user: apiKey });
    assert.equal(read.statusCode, 404);
    const revoke = await drive(revokeHandlers, { params: { shareId: share.id }, user: apiKey });
    assert.equal(revoke.statusCode, 404);
    const still = await getChatShareRepository().getShare(share.id);
    assert.equal(still.revokedAt, null);
  });
});

describe('what a viewer sees', () => {
  it('is the transcript and the display fields, nothing that identifies the owner or the chat', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id] }))
      .body;
    const res = await drive(openHandlers, { params: { shareId: share.id }, user: GRACE });
    assert.equal(res.statusCode, 200);
    const view = res.body.share;
    assert.equal(view.id, share.id);
    assert.equal(view.mode, 'users');
    assert.equal(view.title, 'A shared chat');
    assert.equal(view.readOnly, true);
    assert.equal(view.sharedBy, ADA.name, 'a colleague sees who shared it');
    for (const forbidden of ['chatId', 'ownerId', 'recipients', 'recipientDetails', 'views']) {
      assert.equal(forbidden in view, false, `${forbidden} must not reach a viewer`);
    }
    for (const message of res.body.messages) {
      assert.equal('usage' in message, false);
      assert.equal('clientMessageId' in message, false);
    }
  });

  it('hides the owner’s name on a public link unless they opted in', async () => {
    const chatId = await seedChat(ADA);
    const hidden = (await createShare(ADA, chatId, { mode: 'public' })).body.share;
    const shown = (await createShare(ADA, chatId, { mode: 'public', showOwnerName: true })).body
      .share;
    const a = await drive(openHandlers, { params: { shareId: hidden.id }, user: ANONYMOUS });
    assert.equal(a.body.share.sharedBy, null);
    const b = await drive(openHandlers, { params: { shareId: shown.id }, user: ANONYMOUS });
    assert.equal(b.body.share.sharedBy, ADA.name);
  });

  it('keeps an upload as its descriptor only', async () => {
    const chatId = await seedChat(ADA, { turns: 0 });
    await getChatRepository().appendMessage(chatId, {
      role: 'user',
      content: 'see attached',
      attachments: [{ type: 'application/pdf', name: 'plan.pdf', bytes: 1234 }]
    });
    const { share } = (await createShare(ADA, chatId, { mode: 'public' })).body;
    const res = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.deepEqual(res.body.messages[0].attachments, [
      { type: 'application/pdf', name: 'plan.pdf', bytes: 1234 }
    ]);
  });
});

describe('a share is a snapshot', () => {
  it('shows the chat as it was when shared, not as it is now', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'public' })).body;
    const repository = getChatRepository();
    // The conversation goes on, and an earlier answer is edited away.
    await repository.appendMessage(chatId, { role: 'user', content: 'question 3' });
    const { messages: current } = await repository.getMessages(chatId);
    await repository.appendMessage(
      chatId,
      { role: 'user', content: 'question 1, rephrased' },
      { replaceFromMessageId: current[0].id }
    );
    const now = await repository.getMessages(chatId);
    assert.equal(now.messages.length, 1, 'the live chat was rewritten');

    const res = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.messages.map(m => m.content),
      ['question 1', 'answer 1', 'question 2', 'answer 2']
    );
  });
});

describe('artifacts through a share', () => {
  it('serves only what the snapshot named, inline or as a download', async () => {
    const chatId = await seedChat(ADA, { turns: 0 });
    const before = await seedArtifact(chatId, 'before');
    const { share } = (await createShare(ADA, chatId, { mode: 'public' })).body;
    const later = await seedArtifact(chatId, 'later');

    const list = await drive(artifactsHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.body.items.map(item => item.id),
      [before.id]
    );

    const ok = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: before.id },
      user: ANONYMOUS
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.headers['content-disposition'], 'inline');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(Buffer.from(ok.body).toString(), 'png-bytes-before');

    const download = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: before.id },
      query: { download: '1' },
      user: ANONYMOUS
    });
    assert.equal(download.statusCode, 200);
    assert.match(download.headers['content-disposition'], /^attachment; filename="before\.png"/);

    const denied = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: later.id },
      user: ANONYMOUS
    });
    assert.equal(denied.statusCode, 404, 'an artifact from after the share is not reachable');

    // Artifact opens are not views.
    assert.equal((await getChatShareRepository().getShare(share.id)).viewCount, 0);
  });

  it('keeps a shared picture when the owner regenerates or edits it away', async () => {
    const chatId = await seedChat(ADA, { turns: 0 });
    const repository = getChatRepository();
    const shared = await seedArtifact(chatId, 'shared');
    const { share } = (await createShare(ADA, chatId, { mode: 'public' })).body;
    // Not in any share: the ordinary rule still applies to this one.
    const unshared = await seedArtifact(chatId, 'unshared');
    const { messages } = await repository.getMessages(chatId);
    const first = messages.find(m => m.artifacts?.[0]?.id === shared.id);

    // Regenerate from the shared picture's message: both pictures leave the
    // live transcript.
    await repository.appendMessage(
      chatId,
      { role: 'assistant', content: 'a different answer' },
      { replaceFromMessageId: first.id }
    );

    const scope = repository.artifactScope(chatId);
    assert.ok(await getArtifactRepository().get(scope, shared.id), 'the shared picture survives');
    assert.equal(await getArtifactRepository().get(scope, unshared.id), null, 'the other is gone');

    const res = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: shared.id },
      user: ANONYMOUS
    });
    assert.equal(res.statusCode, 200);
    assert.equal(Buffer.from(res.body).toString(), 'png-bytes-shared');
  });

  it('is still served to the viewer whose open used the last allowed view', async () => {
    const chatId = await seedChat(ADA, { turns: 0 });
    const artifact = await seedArtifact(chatId, 'last');
    const { share } = (await createShare(ADA, chatId, { mode: 'public', maxViews: 1 })).body;

    const open = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(open.statusCode, 200);
    // The link is used up for the next reader …
    const again = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(again.statusCode, 404);
    // … but the page that was just served still gets its pictures.
    const list = await drive(artifactsHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.body.items.map(item => item.id),
      [artifact.id]
    );
    const bytes = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: artifact.id },
      user: ANONYMOUS
    });
    assert.equal(bytes.statusCode, 200);

    // Once the window has passed, nothing opens any more.
    const stored = await getChatShareRepository().getShare(share.id);
    const later = Date.parse(stored.lastViewedAt) + SHARE_ARTIFACT_GRACE_MS + 1;
    const expired = await authorizeShareView(stored, undefined, {
      now: later,
      purpose: 'artifact'
    });
    assert.deepEqual(expired, { ok: false, status: 404 });
  });

  it('applies the same audience rules as the transcript', async () => {
    const chatId = await seedChat(ADA, { turns: 0 });
    const artifact = await seedArtifact(chatId, 'private');
    const { share } = (await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id] }))
      .body;
    const anon = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: artifact.id },
      user: ANONYMOUS
    });
    assert.equal(anon.statusCode, 401);
    const stranger = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: artifact.id },
      user: { id: 'user-stranger' }
    });
    assert.equal(stranger.statusCode, 404);
    const grace = await drive(artifactHandlers, {
      params: { shareId: share.id, artifactId: artifact.id },
      user: GRACE
    });
    assert.equal(grace.statusCode, 200);
  });
});

describe('limits and revocation close a link the same way', () => {
  it('a view limit: the open that reaches it is served, the next is not', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'public', maxViews: 2 })).body;
    const open = () => drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal((await open()).statusCode, 200);
    assert.equal((await open()).statusCode, 200);
    assert.equal((await open()).statusCode, 404);
    const owner = await drive(listHandlers, { params: { chatId }, user: ADA });
    assert.equal(owner.body.items.find(item => item.id === share.id).state, 'exhausted');
  });

  it('an expiry: a link past its date is gone', async () => {
    const chatId = await seedChat(ADA);
    const { messages } = await getChatRepository().getMessages(chatId);
    const share = await getChatShareRepository().createShare({
      chatId,
      ownerId: ADA.id,
      identityMode: 'default',
      mode: 'public',
      messages,
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const res = await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS });
    assert.equal(res.statusCode, 404);
    assert.equal(shareState(share), 'expired');
  });

  it('a revoke: by the owner or an admin, never by anyone else, and it sticks', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'public' })).body;
    const stranger = await drive(revokeHandlers, { params: { shareId: share.id }, user: GRACE });
    assert.equal(stranger.statusCode, 404);
    assert.equal(
      (await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS })).statusCode,
      200
    );
    const owner = await drive(revokeHandlers, { params: { shareId: share.id }, user: ADA });
    assert.equal(owner.statusCode, 200);
    assert.equal(owner.body.share.state, 'revoked');
    assert.equal(
      (await drive(openHandlers, { params: { shareId: share.id }, user: ANONYMOUS })).statusCode,
      404
    );
    // Idempotent, and an admin may do it too.
    const second = (await createShare(ADA, chatId, { mode: 'public' })).body.share;
    const admin = await drive(revokeHandlers, { params: { shareId: second.id }, user: ROOT });
    assert.equal(admin.statusCode, 200);
    const again = await drive(revokeHandlers, { params: { shareId: second.id }, user: ADA });
    assert.equal(again.statusCode, 200);
  });
});

describe('the owner’s and the recipient’s lists', () => {
  it('lists a chat’s shares for its owner only, with their state', async () => {
    const chatId = await seedChat(ADA);
    await createShare(ADA, chatId, { mode: 'public' });
    await createShare(ADA, chatId, { mode: 'authenticated' });
    const mine = await drive(listHandlers, { params: { chatId }, user: ADA });
    assert.equal(mine.statusCode, 200);
    assert.equal(mine.body.items.length, 2);
    assert.ok(mine.body.items.every(item => item.state === 'active' && !('views' in item)));
    const theirs = await drive(listHandlers, { params: { chatId }, user: GRACE });
    assert.equal(theirs.statusCode, 404);
    const admin = await drive(listHandlers, { params: { chatId }, user: ROOT });
    assert.equal(admin.statusCode, 404, 'the admin page has its own listing');
  });

  it('shows a recipient what was shared with them, and whether they opened it', async () => {
    const chatId = await seedChat(ADA);
    const { share } = (await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id] }))
      .body;
    await createShare(ADA, chatId, { mode: 'authenticated' });

    const grace = await drive(withMeHandlers, { user: GRACE });
    assert.equal(grace.statusCode, 200);
    const mine = grace.body.items.filter(item => item.id === share.id);
    assert.equal(mine.length, 1, 'only the share addressed to them, not the link-only one');
    assert.equal(mine[0].viewed, false);
    assert.equal(mine[0].sharedBy, ADA.name);
    assert.equal('recipients' in mine[0], false);

    await drive(openHandlers, { params: { shareId: share.id }, user: GRACE });
    const after = await drive(withMeHandlers, { user: GRACE });
    assert.equal(after.body.items.find(item => item.id === share.id).viewed, true);

    const nobody = await drive(withMeHandlers, { user: { id: 'user-stranger' } });
    assert.deepEqual(nobody.body.items, []);

    await drive(revokeHandlers, { params: { shareId: share.id }, user: ADA });
    const gone = await drive(withMeHandlers, { user: GRACE });
    assert.equal(
      gone.body.items.some(item => item.id === share.id),
      false,
      'a revoked share leaves the recipient’s list'
    );
  });
});

describe('deleting the chat', () => {
  it('takes its shares, their snapshots and their recipient markers with it', async () => {
    const chatId = await seedChat(ADA);
    const users = (await createShare(ADA, chatId, { mode: 'users', recipients: [GRACE.id] })).body
      .share;
    const pub = (await createShare(ADA, chatId, { mode: 'public' })).body.share;

    const res = await drive(deleteChatHandlers, { params: { chatId }, user: ADA });
    assert.equal(res.statusCode, 200);

    const shares = getChatShareRepository();
    assert.equal(await shares.getShare(users.id), null);
    assert.equal(await shares.getShare(pub.id), null);
    assert.equal(await shares.getSnapshot(users.id), null);
    const forGrace = await shares.listSharesForRecipient(GRACE.id);
    assert.equal(
      forGrace.some(item => item.id === users.id),
      false,
      'the recipient marker went with the share'
    );
    assert.equal(
      (await drive(openHandlers, { params: { shareId: pub.id }, user: ANONYMOUS })).statusCode,
      404
    );
  });
});

describe('the recipient picker', () => {
  it('answers nothing while user links are not on offer, and nothing to machine tokens', async () => {
    setSharing({ allowUsers: false });
    try {
      const off = await drive(lookupHandlers, { query: { q: 'grace' }, user: ADA });
      assert.deepEqual(off.body.items, []);
    } finally {
      setSharing({ allowUsers: true });
    }
    const machine = await drive(lookupHandlers, {
      query: { q: 'grace' },
      user: { id: 'client-1', isOAuthClient: true }
    });
    assert.deepEqual(machine.body.items, []);
    const agent = await drive(lookupHandlers, {
      query: { q: 'grace' },
      user: { id: 'agent-1', isAgent: true }
    });
    assert.deepEqual(agent.body.items, []);
  });

  it('needs two characters, matches name or e-mail, skips the caller and inactive accounts', async () => {
    const short = await drive(lookupHandlers, { query: { q: 'g' }, user: ADA });
    assert.deepEqual(short.body.items, []);
    const byName = await drive(lookupHandlers, { query: { q: 'grace' }, user: ADA });
    assert.deepEqual(byName.body.items, [{ id: GRACE.id, name: GRACE.name, email: GRACE.email }]);
    const byEmail = await drive(lookupHandlers, { query: { q: 'EXAMPLE.COM' }, user: ADA });
    assert.deepEqual(
      byEmail.body.items.map(item => item.id).sort(),
      [GRACE.id],
      'never the caller, never a deactivated account'
    );
    for (const item of byEmail.body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['email', 'id', 'name']);
    }
  });
});
