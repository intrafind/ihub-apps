// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Personal apps in the cross-user authorization suite: who may do what on an
 * app alice built and shared (`USER_APP_MATRIX` in `resources.js`, design 14.2
 * of `concepts/app-builder-rework-2026-11/02-personal-apps.md`). Same server,
 * principals and stub model as `cross-user-authz.spec.js`.
 *
 * Principals:
 *   alice       - owns every app here
 *   bob         - "Can use"
 *   carol       - "Can edit"
 *   mallory     - signed in, no share
 *   dave        - receives the offer to take an app over
 *   aliceKey    - alice's personal API key: acts as alice
 *   bobKey      - bob's personal API key: reaches only bob's own apps
 *   oauthClient - a client-credentials token with every app and model allowed
 *   anonymous   - `AUTHZ_ANONYMOUS=0` runs the suite with anonymous access off
 *
 * Every cell of the matrix runs on an app of its own, seeded right before the
 * request and removed after it. A refused request must leave the app as it was;
 * to a principal without a share, the answer must equal the answer for an id
 * that names no app, and must hold nothing alice wrote.
 */

import { test, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { bearerContext, contextFor, fillPath, send } from './harness.js';
import {
  SECRET,
  USER_APP_MATRIX,
  USER_APP_PRINCIPALS,
  USER_APP_STRANGERS,
  seedUserApp,
  userAppState
} from './resources.js';
import { AUTHZ_USERS, SECRET_MODEL_ID } from './principals.js';

const ctx = {};

/** An id of the personal shape that names no app. */
const unknownUserAppId = () => `uap_${randomBytes(16).toString('hex')}`;

async function newKey(context, name) {
  const res = await context.post('/api/integrations/api-keys', { data: { name } });
  expect(res.status(), `API key for ${name}`).toBe(201);
  return (await res.json()).secrets.apiKey;
}

/** A client-credentials token of a client that is allowed every app and model. */
async function clientToken(admin) {
  const created = await admin.post('/api/admin/oauth/clients', {
    data: { name: `authz personal apps ${Date.now()}`, allowedApps: ['*'], allowedModels: ['*'] }
  });
  expect(created.status(), 'OAuth client').toBe(201);
  const { clientId, clientSecret } = await created.json();
  // A token counts as issued before the client's secret when both fall into the
  // same second (`iat` has whole seconds), so the token is asked for in the next one.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const token = await admin.post('/api/oauth/token', {
    data: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }
  });
  expect(token.status(), 'client-credentials token').toBe(200);
  return (await token.json()).access_token;
}

test.beforeAll(async () => {
  for (const name of ['alice', 'bob', 'carol', 'mallory', 'dave', 'admin', 'anonymous']) {
    ctx[name] = await contextFor(name);
  }
  ctx.aliceKey = await bearerContext(await newKey(ctx.alice, 'alice personal apps'));
  ctx.bobKey = await bearerContext(await newKey(ctx.bob, 'bob personal apps'));
  ctx.oauthClient = await bearerContext(await clientToken(ctx.admin));
  // The three tokens are good: a 404 below is about the app, not about the token.
  for (const who of ['aliceKey', 'bobKey', 'oauthClient']) {
    expect((await ctx[who].get('/api/apps/chat')).status(), `${who} reads an admin app`).toBe(200);
  }
});

test.afterAll(async () => {
  for (const context of Object.values(ctx)) await context.dispose();
});

/** Alice's own view of an app: `{ status, state }`. */
async function asAlice(appId) {
  const res = await send(ctx.alice, { method: 'GET', url: `/api/apps/${appId}` });
  return { status: res.status, state: userAppState(res.json), app: res.json };
}

/** Remove what a cell left behind, as the administrator. */
async function cleanUp(appIds, companyAppIds = []) {
  for (const id of appIds) await ctx.admin.delete(`/api/admin/user-apps/${id}`);
  for (const id of companyAppIds) await ctx.admin.delete(`/api/admin/apps/${id}`);
}

/** Status and body with what differs per request blanked. */
function answerShape(res, appId) {
  const body = res.text
    .split(appId)
    .join('<app>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/"(timestamp|createdAt|updatedAt)":"[^"]*"/g, '"$1":"<time>"');
  return `${res.status} ${body}`;
}

/** The request of a matrix entry for one app. */
function requestFor(entry, appId, revision) {
  const [method, template] = entry.route.split(' ');
  return {
    method,
    url: fillPath(template, { appId, chatId: randomUUID() }),
    data: entry.data,
    headers: { ...entry.headers, ...(entry.ifMatch ? { 'if-match': `"${revision}"` } : {}) }
  };
}

/**
 * Run one cell: seed an app, send the request as `who`, and return why the
 * outcome is wrong (an empty list when it is right).
 */
async function runCell(entry, who) {
  const problems = [];
  const expected = entry.expect[who];
  const appId = await seedUserApp(ctx.alice, {
    offerTo: entry.offer ? AUTHZ_USERS.dave.id : undefined
  });
  const created = [appId];
  const companyApps = [];
  try {
    const before = await asAlice(appId);
    const request = requestFor(entry, appId, before.state.revision);
    const allowed = expected >= 200 && expected < 300;
    const res = await send(ctx[who], {
      ...request,
      // A refused chat turn is one JSON body; an event stream must not open.
      timeout: entry.stream && !allowed ? 5_000 : 30_000
    });
    if (res.timedOut) return [`${who} ${entry.route} -> no complete answer`];
    if (res.status !== expected) {
      problems.push(
        `${who} ${entry.route} -> ${res.status}, expected ${expected}: ${res.text.slice(0, 200)}`
      );
    }
    if (res.status === 201 && res.json?.id) created.push(res.json.id);
    if (res.json?.publishedAs?.appId) companyApps.push(res.json.publishedAs.appId);

    if (USER_APP_STRANGERS.includes(who)) {
      if (res.text.includes(SECRET) || res.text.includes('Authz personal app')) {
        problems.push(
          `${who} ${entry.route} -> the answer holds alice's app: ${res.text.slice(0, 200)}`
        );
      }
      // An app that exists and an id that names none get the same answer.
      const unknownId = unknownUserAppId();
      const unknown = await send(ctx[who], {
        ...requestFor(entry, unknownId, before.state.revision),
        timeout: 5_000
      });
      if (answerShape(res, appId) !== answerShape(unknown, unknownId)) {
        problems.push(
          `${who} ${entry.route} -> ${answerShape(res, appId).slice(0, 200)} but an unknown id ` +
            `gets ${answerShape(unknown, unknownId).slice(0, 200)}`
        );
      }
    }

    const after = await asAlice(appId);
    if (!allowed) {
      // A refusal changes nothing.
      if (JSON.stringify(after.state) !== JSON.stringify(before.state)) {
        problems.push(
          `${who} ${entry.route} -> refused with ${res.status}, but the app changed: ` +
            `${JSON.stringify(before.state)} -> ${JSON.stringify(after.state)}`
        );
      }
    } else if (entry.stream && !res.text.includes('E2E reply')) {
      problems.push(`${who} ${entry.route} -> no answer of the model: ${res.text.slice(0, 200)}`);
    } else if (entry.route === 'DELETE /api/apps/:appId' && after.status !== 404) {
      problems.push(`${who} ${entry.route} -> 204, but the app is still there`);
    }
  } finally {
    await cleanUp(created, companyApps);
  }
  return problems;
}

for (const who of USER_APP_PRINCIPALS) {
  test(`personal app matrix: ${who}`, async ({}, testInfo) => {
    const problems = [];
    const seen = [];
    for (const entry of USER_APP_MATRIX) {
      const cell = await runCell(entry, who);
      seen.push(`${who.padEnd(11)} ${String(entry.expect[who]).padEnd(4)} ${entry.route}`);
      problems.push(...cell);
    }
    await testInfo.attach('expected.txt', { body: seen.join('\n'), contentType: 'text/plain' });
    expect(problems).toEqual([]);
  });
}

test('the matrix covers every principal on every route, and the allowed cells do what they say', async () => {
  for (const entry of USER_APP_MATRIX) {
    expect(Object.keys(entry.expect).sort(), entry.route).toEqual([...USER_APP_PRINCIPALS].sort());
  }

  // Leave: the caller's own share is gone, the other one stays.
  const left = await seedUserApp(ctx.alice);
  expect((await ctx.bob.post(`/api/apps/${left}/_leave`, { data: {} })).status()).toBe(204);
  expect((await ctx.bob.get(`/api/apps/${left}`)).status()).toBe(404);
  expect((await asAlice(left)).state.members).toEqual([['user', AUTHZ_USERS.carol.id, 'editor']]);

  // An editor's change is stored; what a member changes about the members is too.
  const edited = await seedUserApp(ctx.alice);
  const patch = await ctx.carol.patch(`/api/apps/${edited}`, {
    data: { description: { en: 'changed by carol' } }
  });
  expect(patch.status()).toBe(200);
  expect((await asAlice(edited)).app.description).toEqual({ en: 'changed by carol' });

  // Duplicate: the copy belongs to the caller and has no members.
  const copy = await ctx.bob.post(`/api/apps/${edited}/_duplicate`, { data: {} });
  expect(copy.status()).toBe(201);
  const copied = await copy.json();
  expect(copied.owner.id).toBe(AUTHZ_USERS.bob.id);
  expect(copied.members).toEqual([]);
  expect((await ctx.alice.get(`/api/apps/${copied.id}`)).status()).toBe(404);

  await cleanUp([left, edited, copied.id]);
});

test('dave, the receiver of the offer, takes the app over; alice has no role left', async () => {
  const appId = await seedUserApp(ctx.alice, { offerTo: AUTHZ_USERS.dave.id });
  try {
    const offered = await send(ctx.dave, { method: 'GET', url: `/api/apps/${appId}` });
    expect(offered.status).toBe(200);
    expect(offered.json.permissions.canAcceptOffer).toBe(true);
    expect(offered.json.permissions.canEdit).toBe(false);

    // The header is required: the receiver confirms the state they read.
    const without = await ctx.dave.post(`/api/apps/${appId}/owner-offer/_accept`, { data: {} });
    expect(without.status()).toBe(400);
    const stale = await ctx.dave.post(`/api/apps/${appId}/owner-offer/_accept`, {
      data: {},
      headers: { 'if-match': '"1"' }
    });
    expect(stale.status()).toBe(409);
    expect((await asAlice(appId)).state.owner).toBe(AUTHZ_USERS.alice.id);

    const accepted = await ctx.dave.post(`/api/apps/${appId}/owner-offer/_accept`, {
      data: {},
      headers: { 'if-match': `"${offered.json.revision}"` }
    });
    expect(accepted.status()).toBe(200);
    const app = await accepted.json();
    expect(app.owner.id).toBe(AUTHZ_USERS.dave.id);
    expect(app.permissions.isOwner).toBe(true);
    // Every "Can edit" member is "Can use" now, and the previous owner has no role.
    expect(app.members.map(member => [member.id, member.role]).sort()).toEqual([
      [AUTHZ_USERS.bob.id, 'user'],
      [AUTHZ_USERS.carol.id, 'user']
    ]);
    expect((await ctx.alice.get(`/api/apps/${appId}`)).status()).toBe(404);
    expect((await ctx.aliceKey.get(`/api/apps/${appId}`)).status()).toBe(404);
  } finally {
    await cleanUp([appId]);
  }
});

test('lists: a stranger never sees the app, a member and the owner do', async () => {
  const appId = await seedUserApp(ctx.alice);
  try {
    for (const who of ['mallory', 'bobKey', 'oauthClient', 'anonymous']) {
      for (const scope of ['personal', 'mine', 'shared']) {
        const res = await send(ctx[who], { method: 'GET', url: `/api/apps?scope=${scope}` });
        expect(res.status, `${who} scope=${scope}`).toBeLessThan(500);
        expect(res.text, `${who} scope=${scope}`).not.toContain(appId);
        expect(res.text, `${who} scope=${scope}`).not.toContain(SECRET);
      }
      const all = await send(ctx[who], { method: 'GET', url: '/api/apps' });
      expect(all.text, `${who} GET /api/apps`).not.toContain(appId);
    }
    // Not vacuous: the same lists hold the app for those it is meant for.
    expect(await (await ctx.alice.get('/api/apps?scope=mine')).text()).toContain(appId);
    expect(await (await ctx.aliceKey.get('/api/apps?scope=mine')).text()).toContain(appId);
    expect(await (await ctx.bob.get('/api/apps?scope=shared')).text()).toContain(appId);
    expect(await (await ctx.carol.get('/api/apps?scope=personal')).text()).toContain(appId);
    expect(await (await ctx.bob.get('/api/apps?scope=mine')).text()).not.toContain(appId);
    // The list without `scope` holds admin apps only, for the owner too.
    expect(await (await ctx.alice.get('/api/apps')).text()).not.toContain(appId);
  } finally {
    await cleanUp([appId]);
  }
});

/** The keys of the view only the owner, "Can edit", the receiver and an admin get. */
const FULL_VIEW_ONLY = ['members', 'pendingOwner', 'publish', 'publishedAs'];

test('"Can use" reads the instructions, and neither the member list nor what the owner may do', async () => {
  // The app names a model carol's group may not use. As "Can use" she learns
  // that it depends on her, and nothing about alice.
  const appId = await seedUserApp(ctx.alice, {
    offerTo: AUTHZ_USERS.dave.id,
    content: { preferredModel: SECRET_MODEL_ID },
    members: [
      { type: 'user', id: AUTHZ_USERS.bob.id, role: 'user' },
      { type: 'user', id: AUTHZ_USERS.carol.id, role: 'user' },
      { type: 'user', id: AUTHZ_USERS.mallory.id, role: 'editor' }
    ]
  });
  try {
    for (const who of ['bob', 'carol']) {
      const res = await send(ctx[who], { method: 'GET', url: `/api/apps/${appId}` });
      expect(res.status, who).toBe(200);
      const app = res.json;
      expect(app.permissions.role, who).toBe('user');
      expect(app.system, `${who} reads the instructions`).toEqual({
        en: `${SECRET} personal app instructions`
      });
      for (const key of FULL_VIEW_ONLY) expect(app, `${who} ${key}`).not.toHaveProperty(key);
      for (const key of ['ownerPrincipal', 'contentHash', 'publishing']) {
        expect(app, `${who} ${key}`).not.toHaveProperty(key);
      }
      expect(app.sharedWith, who).toEqual({ users: 3, groups: 0, everyone: false });
      // No other member is named anywhere in the answer.
      expect(res.text, who).not.toContain(AUTHZ_USERS.mallory.id);
      expect(res.text, who).not.toContain(AUTHZ_USERS.dave.id);
      for (const capability of app.capabilities) {
        expect(capability, `${who} ${capability.id}`).not.toHaveProperty('requested');
        expect([undefined, 'youMayNot', 'unavailable'], `${who} ${capability.id}`).toContain(
          capability.reason
        );
      }
    }
    const model = async who =>
      (await (await ctx[who].get(`/api/apps/${appId}`)).json()).capabilities.find(
        capability => capability.id === 'model'
      );
    expect(await model('bob')).toEqual({ id: 'model', granted: true });
    expect(await model('carol')).toEqual({ id: 'model', granted: false, reason: 'youMayNot' });

    // The roles that manage the app get the list and the offer; nobody gets the principal.
    for (const who of ['alice', 'mallory', 'dave', 'admin']) {
      const res = await send(ctx[who], { method: 'GET', url: `/api/apps/${appId}` });
      expect(res.status, who).toBe(200);
      expect(res.json.members, who).toHaveLength(3);
      expect(res.text, who).not.toContain('ownerPrincipal');
      expect(res.text, who).not.toContain('@authz.example');
    }
  } finally {
    await cleanUp([appId]);
  }
});
