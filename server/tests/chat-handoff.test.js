/**
 * Chat hand-offs: a chat that is not stored server-side, parked by the Outlook
 * pane for the same user's browser ("Open in web app").
 *
 * Pinned here: what a hand-off may carry (and what is dropped), that it can be
 * claimed exactly once, only by its owner, only before it expires, and that a
 * claim by somebody else leaves it for the owner.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import registerChatHandoffRoutes, {
  MAX_HANDOFF_MESSAGES,
  normalizeHandoff
} from '../routes/chatHandoffs.js';
import {
  HANDOFF_TTL_MS,
  MAX_HANDOFF_BYTES_PER_WORKER,
  MAX_HANDOFFS_PER_USER,
  claimHandoff,
  cleanup,
  parkHandoff
} from '../services/chat/chatHandoffStore.js';

const ADA = { id: 'user-ada' };
const GRACE = { id: 'user-grace' };

function captureRoutes(register) {
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({ get: record('get'), post: record('post'), use: () => {} });
  return routes;
}

const routes = captureRoutes(registerChatHandoffRoutes);

function handlersFor(suffix) {
  const route = routes.find(entry => entry.method === 'post' && entry.routePath.endsWith(suffix));
  assert.ok(route, `POST ${suffix} must be registered`);
  return route.handlers;
}

function makeResponse() {
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  return res;
}

/** Run a route's middleware chain like Express would. */
async function call(suffix, { user, body }) {
  const req = { user, body };
  const res = makeResponse();
  for (const handler of handlersFor(suffix)) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

const transcript = [
  { role: 'user', content: 'Summarize this email', hostContext: { email: { subject: 'Q3' } } },
  { role: 'assistant', content: 'It is about Q3.' }
];

describe('normalizeHandoff', () => {
  it('keeps the words, the roles and the email of a user turn — nothing else', () => {
    const { value } = normalizeHandoff({
      appId: 'mail-assistant',
      messages: [
        { ...transcript[0], imageData: [{ base64: 'AAAA' }], id: 'u1' },
        { ...transcript[1], hostContext: { email: {} }, loading: false }
      ],
      variables: { tone: 'formal', count: 3, nested: { no: true } }
    });
    assert.deepEqual(value, {
      appId: 'mail-assistant',
      messages: transcript,
      variables: { tone: 'formal', count: 3 }
    });
  });

  it('refuses what is not a chat', () => {
    assert.match(normalizeHandoff(null).error, /object/);
    assert.match(normalizeHandoff({ appId: '../etc', messages: transcript }).error, /appId/);
    assert.match(normalizeHandoff({ appId: 'a', messages: [] }).error, /non-empty/);
    assert.match(
      normalizeHandoff({ appId: 'a', messages: [{ role: 'system', content: 'x' }] }).error,
      /role/
    );
    assert.match(
      normalizeHandoff({ appId: 'a', messages: [{ role: 'user', content: 42 }] }).error,
      /string/
    );
    const many = Array.from({ length: MAX_HANDOFF_MESSAGES + 1 }, () => transcript[1]);
    assert.match(normalizeHandoff({ appId: 'a', messages: many }).error, /At most/);
  });

  it('a chat too large to carry is flagged as such', () => {
    const big = { role: 'user', content: 'x', hostContext: { body: 'y'.repeat(5 * 1024 * 1024) } };
    const result = normalizeHandoff({ appId: 'a', messages: [big] });
    assert.equal(result.tooLarge, true);
  });
});

describe('chat hand-off store', () => {
  it('is claimed once, by its owner', async () => {
    const { token, expiresAt } = parkHandoff(ADA.id, { appId: 'a', messages: transcript });
    assert.ok(expiresAt > Date.now());
    assert.deepEqual(await claimHandoff(token, ADA.id), {
      data: { appId: 'a', messages: transcript }
    });
    assert.deepEqual(await claimHandoff(token, ADA.id), { error: 'notFound' });
  });

  it("somebody else's claim is refused and leaves it for the owner", async () => {
    const { token } = parkHandoff(ADA.id, { appId: 'a', messages: transcript });
    assert.deepEqual(await claimHandoff(token, GRACE.id), { error: 'notOwner' });
    assert.equal((await claimHandoff(token, ADA.id)).data.appId, 'a');
  });

  it('a guessed secret burns the hand-off', async () => {
    const { token } = parkHandoff(ADA.id, { appId: 'a', messages: transcript });
    const [handle] = token.split('.');
    assert.deepEqual(await claimHandoff(`${handle}.${'0'.repeat(64)}`, ADA.id), {
      error: 'notFound'
    });
    assert.deepEqual(await claimHandoff(token, ADA.id), { error: 'notFound' });
  });

  it('expires', async () => {
    const { token } = parkHandoff(ADA.id, { appId: 'a', messages: transcript });
    cleanup(Date.now() + HANDOFF_TTL_MS + 1);
    assert.deepEqual(await claimHandoff(token, ADA.id), { error: 'notFound' });
  });

  it('keeps a few per user, dropping the oldest', async () => {
    const tokens = Array.from({ length: MAX_HANDOFFS_PER_USER + 1 }, (_, i) =>
      parkHandoff('user-busy', { appId: `a${i}`, messages: transcript })
    ).map(entry => entry.token);
    assert.deepEqual(await claimHandoff(tokens[0], 'user-busy'), { error: 'notFound' });
    assert.equal(
      (await claimHandoff(tokens.at(-1), 'user-busy')).data.appId,
      `a${MAX_HANDOFFS_PER_USER}`
    );
  });

  it('a worker holds a bounded number of bytes, dropping the oldest records first', async () => {
    const half = MAX_HANDOFF_BYTES_PER_WORKER / 2;
    const first = parkHandoff('user-big-1', { appId: 'one', messages: transcript }, half);
    const second = parkHandoff('user-big-2', { appId: 'two', messages: transcript }, half);
    // The budget is full; the next record, however small, pushes the oldest out.
    const third = parkHandoff('user-big-3', { appId: 'three', messages: transcript }, 10);
    assert.deepEqual(await claimHandoff(first.token, 'user-big-1'), { error: 'notFound' });
    assert.equal((await claimHandoff(second.token, 'user-big-2')).data.appId, 'two');
    assert.equal((await claimHandoff(third.token, 'user-big-3')).data.appId, 'three');
  });

  it('malformed tokens are simply not found', async () => {
    assert.deepEqual(await claimHandoff('nodot', ADA.id), { error: 'notFound' });
    assert.deepEqual(await claimHandoff(undefined, ADA.id), { error: 'notFound' });
  });
});

describe('POST /api/chat-handoffs and /claim', () => {
  it('park and claim through the routes, the same user on both sides', async () => {
    const parked = await call('/api/chat-handoffs', {
      user: ADA,
      body: { appId: 'mail', messages: transcript }
    });
    assert.equal(parked.statusCode, 201);
    assert.equal(typeof parked.body.token, 'string');

    const claimed = await call('/api/chat-handoffs/claim', {
      user: ADA,
      body: { token: parked.body.token }
    });
    assert.equal(claimed.statusCode, 200);
    assert.deepEqual(claimed.body, { appId: 'mail', messages: transcript, variables: null });
  });

  it('anonymous callers get nothing either way', async () => {
    const parked = await call('/api/chat-handoffs', {
      user: { id: 'anonymous' },
      body: { appId: 'mail', messages: transcript }
    });
    assert.equal(parked.statusCode, 401);
    const claimed = await call('/api/chat-handoffs/claim', {
      user: undefined,
      body: { token: 'x.y' }
    });
    assert.equal(claimed.statusCode, 401);
  });

  it('another user is told so, an unknown token is a 404, junk is a 400', async () => {
    const parked = await call('/api/chat-handoffs', {
      user: ADA,
      body: { appId: 'mail', messages: transcript }
    });
    const other = await call('/api/chat-handoffs/claim', {
      user: GRACE,
      body: { token: parked.body.token }
    });
    assert.equal(other.statusCode, 403);
    assert.equal(other.body.details.code, 'HANDOFF_OTHER_USER');

    const unknown = await call('/api/chat-handoffs/claim', {
      user: ADA,
      body: { token: 'aaaa.bbbb' }
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.body.details.code, 'HANDOFF_NOT_FOUND');

    const junk = await call('/api/chat-handoffs/claim', { user: ADA, body: { token: 7 } });
    assert.equal(junk.statusCode, 400);

    const invalid = await call('/api/chat-handoffs', { user: ADA, body: { appId: 'mail' } });
    assert.equal(invalid.statusCode, 400);
  });
});
