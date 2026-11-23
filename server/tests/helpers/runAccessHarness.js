// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run routes over the real access check, for tests that ask "who gets
 * which status".
 *
 * Everything behind the request is real: a filesystem storage provider over a
 * scratch directory, the chat repository, the run ledger, the interaction
 * service, the rate limiter, the audit log and `server/routes/runs.js` itself.
 * Only the sign-in is replaced: the header `x-test-user` names the caller, and
 * a request without it is the anonymous principal, which gets its guest
 * identity from the real cookie code (`attachGuestIdentity`).
 *
 * The server modules are imported inside {@link startRunAccessHarness}: the
 * audit log writes below `CONTENTS_DIR`, which is read once when the server's
 * configuration loads, so the scratch directory has to be set first. A test
 * file that uses this helper imports no server module of its own at the top.
 *
 * @module tests/helpers/runAccessHarness
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The signed-in callers of the access tests, by the role they play. */
export const USERS = Object.freeze({
  /** Owns the run and its chat. */
  owner: Object.freeze({ id: 'alice', name: 'Alice', groups: ['users'] }),
  /** Signed in, owns nothing here. */
  otherUser: Object.freeze({ id: 'bob', name: 'Bob', groups: ['users'] }),
  /** An administrator who is not the owner. */
  admin: Object.freeze({
    id: 'root',
    name: 'Root',
    groups: ['admins'],
    isAdmin: true,
    isContentAdmin: true
  }),
  /** A second owner, for the cases that must not share a rate limit count. */
  secondOwner: Object.freeze({ id: 'carol', name: 'Carol', groups: ['users'] })
});

/**
 * Start the harness.
 *
 * @returns {Promise<Object>} the app, the seeding functions and the server
 *   modules a test needs to look behind the response
 */
export async function startRunAccessHarness() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-run-access-')));
  process.env.CONTENTS_DIR = path.join(root, 'contents');

  const { default: express } = await import('express');
  const { default: cookieParser } = await import('cookie-parser');
  const { default: request } = await import('supertest');
  const { default: configCache } = await import('../../configCache.js');
  const { default: runLog } = await import('../../services/loop/RunLog.js');
  const { default: interactionService } = await import('../../services/loop/InteractionService.js');
  const { default: registerRunRoutes } = await import('../../routes/runs.js');
  const { default: errorHandler } = await import('../../middleware/errorHandler.js');
  const { getChatRepository } = await import('../../services/chat/ChatRepository.js');
  const chatOwner = await import('../../services/chat/chatOwner.js');
  const runAccess = await import('../../services/loop/runAccess.js');
  const steering = await import('../../services/loop/steering.js');
  const audit = await import('../../services/AuditLogService.js');
  const { startTestStorage } = await import('./testStorage.js');

  const storage = await startTestStorage({ prefix: 'ihub-run-access-storage-' });
  // Anonymous access is on, so the guest cases reach the routes at all.
  configCache.setCacheEntry('config/platform.json', { anonymousAuth: { enabled: true } });

  const byId = new Map(Object.values(USERS).map(user => [user.id, user]));
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => {
    const known = byId.get(String(req.get('x-test-user') || ''));
    // A fresh object per request, as the sign-in middleware leaves it: the
    // guest identity is bound to this object and to nothing that outlives it.
    req.user = known ? { ...known } : { id: 'anonymous', name: 'Anonymous', groups: ['anonymous'] };
    chatOwner.attachGuestIdentity(req, res);
    next();
  });
  registerRunRoutes(app);
  /** Routes a test adds after the run routes (the inventory's scratch route). */
  const extra = express.Router();
  app.use(extra);
  app.use(errorHandler);

  /**
   * Store a chat for an owner id.
   *
   * @param {string} ownerId
   * @param {Object} [options]
   * @param {boolean} [options.temporary=false]
   * @returns {Promise<string>} the chat id
   */
  async function seedChat(ownerId, { temporary = false } = {}) {
    const chatId = `chat-${crypto.randomUUID()}`;
    const chat = await getChatRepository().ensureChat({
      chatId,
      ownerId,
      identityMode: 'default',
      appId: 'chat',
      title: 'Access test',
      origin: { createdVia: 'ui' },
      temporary
    });
    if (!chat) throw new Error('The test chat could not be stored');
    return chatId;
  }

  /**
   * A running run of a signed-in user, with its stored chat.
   *
   * @param {Object} [user=USERS.owner]
   * @param {Object} [options]
   * @param {string} [options.kind='chat']
   * @param {boolean} [options.withChat=true] - false for a run without a chat (an API run)
   * @returns {Promise<{runId: string, chatId: string|null, principalId: string}>}
   */
  async function seedUserRun(user = USERS.owner, { kind = 'chat', withChat = true } = {}) {
    const owner = await chatOwner.resolveChatOwner(user, { mode: runLog.identityMode() });
    const chatId = withChat ? await seedChat(owner.id) : null;
    const { runId, principal } = await runLog.startRun({
      kind,
      user,
      refs: chatId ? { chatId, appId: 'chat' } : {}
    });
    return { runId, chatId, principalId: principal.id };
  }

  /**
   * A running run of an anonymous visitor, with the chat its browser owns.
   *
   * @returns {Promise<{runId: string, chatId: string, cookie: string}>} `cookie`
   *   is the `Cookie` header of the browser session that owns the chat
   */
  async function seedGuestRun() {
    const guestId = chatOwner.mintGuestId();
    const chatId = await seedChat(chatOwner.guestOwnerId(guestId), { temporary: true });
    const { runId } = await runLog.startRun({
      kind: 'chat',
      user: null,
      refs: { chatId, appId: 'chat' }
    });
    return { runId, chatId, cookie: `${chatOwner.GUEST_COOKIE}=${guestId}` };
  }

  /**
   * Send one request.
   *
   * @param {string} method - `get`, `post`, `delete`, ...
   * @param {string} url
   * @param {Object} [caller]
   * @param {Object} [caller.user] - one of {@link USERS}; anonymous when absent
   * @param {string} [caller.cookie] - `Cookie` header (a guest's browser session)
   * @param {Object} [body]
   * @returns {Promise<import('supertest').Response>}
   */
  function send(method, url, { user, cookie } = {}, body = undefined) {
    let pending = request(app)[method](url);
    if (user) pending = pending.set('x-test-user', user.id);
    if (cookie) pending = pending.set('Cookie', cookie);
    return body === undefined ? pending : pending.send(body);
  }

  /**
   * The audit entries written for a run so far.
   *
   * @param {string} runId
   * @returns {Promise<Object[]>}
   */
  async function auditEntriesFor(runId) {
    await audit.flushAuditLog();
    const dir = path.join(process.env.CONTENTS_DIR, 'data', 'audit-log');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
      .filter(entry => entry.resource === 'run' && entry.resourceId === runId);
  }

  return {
    app,
    extra,
    send,
    seedChat,
    seedUserRun,
    seedGuestRun,
    auditEntriesFor,
    runLog,
    interactionService,
    runAccess,
    steering,
    chatOwner,
    async stop() {
      await audit.flushAuditLog();
      audit.stopAuditCleanupScheduler();
      await runLog.stop();
      await storage.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
