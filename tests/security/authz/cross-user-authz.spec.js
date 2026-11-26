// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cross-user authorization regression suite (OWASP A01, broken access control),
 * black box against a real server: `npx playwright test --config
 * tests/config/playwright.authz.config.js`. The config starts the API server
 * alone (no Vite) on its own port and its own disposable contents directory,
 * with the model served by a local stub: no network, no model key.
 *
 * Principals (`principals.js`, seeded by `tests/config/authz-server.mjs`):
 *   alice  - `users` group; owns one of every user-owned resource (`seedAlice`)
 *   bob    - `users` group; must reach none of alice's resources
 *   carol  - a restricted group without the secret app, model, prompt, skill,
 *            page and workflow; recipient of alice's chat share, prompt and skill
 *   anonymous - anonymous access on (the platform default); `AUTHZ_ANONYMOUS=0`
 *            runs the same suite with it off
 *   admin  - the seeded default admin, for the sanity checks
 *   mallory, dave - only in `user-apps-authz.spec.js`: who may do what on a
 *            personal app alice shares (here her personal app is shared with
 *            nobody, so bob and carol are strangers to it like everyone else)
 *
 * The matrix (`RESOURCES` in `resources.js`): every non-admin route with a path
 * parameter that reaches one of alice's resources, attacked by bob, carol and
 * anonymous with every method the route has. An attack passes on 401/403/404
 * (or the per-route expectation), with nothing of alice's in the body, and alice's
 * resources read back unchanged afterwards (`aliceSnapshot`). Next to it: list,
 * search and count endpoints (`LISTS`), group-gated config (`GROUP_GATED`, carol),
 * an app that is not published (`UNPUBLISHED_APP`: an unknown app to everyone but
 * an admin in the interactive chat), the `/api/inference/v1`, `/mcp` and `/a2a`
 * surfaces, and admin sanity checks (so the suite cannot pass because everything
 * answers 404).
 *
 * To add a resource: create it in `seedAlice`, put what must not change into
 * `aliceSnapshot`, add its routes to `RESOURCES` and its list endpoint to `LISTS`.
 * To exempt a route: add it to `EXEMPT_ROUTES` with a one-line reason. The
 * coverage guard (`route-coverage.spec.js`) fails on a parameterised non-admin
 * route that is in neither.
 */

import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bearerContext, contextFor, DENY, fillPath, send } from './harness.js';
import {
  ADMIN_ONLY,
  EXEMPT_ROUTES,
  FIXED_IDS,
  GROUP_GATED,
  RESOURCES,
  SECRET,
  SKIP,
  UNPUBLISHED_APP,
  aliceSnapshot,
  callerScoped,
  seedAlice
} from './resources.js';
import {
  AUTHZ_USERS,
  SECRET_APP_ID,
  SECRET_MODEL_ID,
  UNKNOWN_APP_ID,
  UNPUBLISHED_APP_ID,
  UNPUBLISHED_APP_MARKER
} from './principals.js';

const ctx = {};
let ids;
let baseline;

/**
 * Alice's resources are created once per server: Playwright starts a new worker
 * (and runs `beforeAll` again) after a failed test, and the later tests must
 * attack the same resources. The contents directory is recreated on every run.
 */
const SEED_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  process.env.AUTHZ_CONTENTS_DIR || 'contents-e2e-authz',
  '.authz-seed.json'
);

/** The URL of a matrix entry, its parameters taken from `ids`. */
function urlOf(entry, paramMap = {}) {
  const [, template] = entry.route.split(' ');
  const map = { ...paramMap, ...entry.params };
  const values = new Proxy(
    {},
    { get: (_target, name) => ids[map[name] ?? name] ?? FIXED_IDS[map[name] ?? name] }
  );
  return fillPath(template, values);
}

/** Send a matrix entry as `context`. */
function attack(context, entry, paramMap) {
  const [method] = entry.route.split(' ');
  const data = typeof entry.data === 'function' ? entry.data(ids) : entry.data;
  return send(context, {
    method,
    url: urlOf(entry, paramMap),
    data,
    multipart: entry.multipart,
    headers: entry.headers,
    timeout: entry.stream ? 5_000 : 15_000
  });
}

/** Why `res` is the wrong answer for `who` (or null). */
function judge(entry, who, res) {
  if (res.timedOut) return 'no complete answer: an event stream opened';
  const check = entry.expect?.[who] ?? DENY;
  const problem = Array.isArray(check)
    ? check.includes(res.status)
      ? null
      : `got ${res.status}, expected ${check.join('/')}`
    : check(res, ids);
  if (problem) return `${problem}: ${res.text.slice(0, 160)}`;
  if (!check.mayRevealSecret && res.text.includes(SECRET)) {
    return `response contains alice's data: ${res.text.slice(0, 160)}`;
  }
  return null;
}

/** What each attack got back, attached to the test as `observed.txt`. */
const observed = [];

/** Run `entries` as `who`, returning one line per wrong answer. */
async function runMatrix(who, entries, paramMap) {
  const failures = [];
  for (const entry of entries) {
    if (entry.expect?.[who] === SKIP) continue;
    const res = await attack(ctx[who], entry, paramMap);
    observed.push(`${who.padEnd(9)} ${String(res.status).padEnd(4)} ${entry.route}`);
    const problem = judge(entry, who, res);
    if (problem) failures.push(`${who} ${entry.route} -> ${problem}`);
  }
  return failures;
}

test.beforeAll(async () => {
  for (const name of ['alice', 'bob', 'carol', 'admin', 'anonymous']) {
    ctx[name] = await contextFor(name);
  }
  if (fs.existsSync(SEED_FILE)) {
    ({ ids, baseline } = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
  } else {
    ids = await seedAlice(ctx.alice);
    baseline = await aliceSnapshot(ctx.alice, ids);
    fs.writeFileSync(SEED_FILE, JSON.stringify({ ids, baseline }));
  }
  ids = { ...ids, freshChatId: randomUUID() };
});

test.afterAll(async () => {
  for (const context of Object.values(ctx)) await context.dispose();
});

test('alice reads each of her own resources (the ids are live)', async () => {
  const failures = [];
  for (const resource of RESOURCES) {
    for (const entry of resource.routes) {
      if (!entry.route.startsWith('GET ') || entry.stream || entry.ownerSkip) continue;
      const res = await attack(ctx.alice, entry, resource.params);
      if (res.timedOut || res.status < 200 || res.status >= 300) {
        failures.push(`alice ${entry.route} -> ${res.status} ${res.text.slice(0, 160)}`);
      }
    }
  }
  expect(failures).toEqual([]);
  // Every snapshot read succeeded, so "unchanged" below means something.
  for (const [name, value] of Object.entries(baseline)) {
    if (name.endsWith('Shares')) continue;
    expect(value[0], `alice snapshot ${name}`).toBe(200);
  }
});

for (const attacker of ['bob', 'carol', 'anonymous']) {
  test(`${attacker} cannot read or change alice's resources`, async ({}, testInfo) => {
    const failures = [];
    observed.length = 0;
    for (const resource of RESOURCES) {
      failures.push(...(await runMatrix(attacker, resource.routes, resource.params)));
    }
    await testInfo.attach('observed.txt', { body: observed.join('\n'), contentType: 'text/plain' });
    if (process.env.AUTHZ_PRINT) console.log(observed.join('\n'));
    expect(failures).toEqual([]);
    expect(await aliceSnapshot(ctx.alice, ids)).toEqual(baseline);
  });
}

/**
 * List, search and count endpoints: what bob gets back from each must not
 * mention one of alice's ids or her data. `carol: false` skips carol where she
 * is a recipient by design.
 */
const LISTS = [
  { url: '/api/chats' },
  { url: '/api/chats?limit=100' },
  { url: '/api/shares/with-me', carol: false },
  { url: '/api/shortlinks' },
  { url: '/api/shortlinks?ownerId=user_authz_alice' },
  { url: '/api/shortlinks?appId=chat' },
  { url: '/api/prompts', carol: false },
  // Carol copied the prompt shared with her (allowed): her copy holds its text and source.
  { url: '/api/prompts?scope=mine', carol: false },
  { url: '/api/prompts?scope=shared', carol: false },
  { url: '/api/prompts?scope=favorites' },
  // The usage attack put alice's prompt id into the caller's own recents.
  { url: '/api/prompts/preferences', bob: 'secretOnly', carol: 'secretOnly' },
  { url: '/api/user-skills', carol: false },
  { url: '/api/apps?scope=personal' },
  { url: '/api/apps?scope=mine' },
  { url: '/api/apps?scope=shared' },
  { url: '/api/projects' },
  { url: '/api/projects/_catalog' },
  { url: '/api/projects/_collections' },
  { url: '/api/scheduled-tasks' },
  { url: '/api/scheduled-tasks/_notifications' },
  { url: '/api/workflows/my-executions' },
  { url: '/api/agents/runs' },
  { url: '/api/interactions/pending' },
  { url: '/api/interactions/pending?kind=approval' },
  { url: '/api/inference/v1/files' },
  { url: '/api/integrations/api-keys' },
  { url: '/api/integrations/connections' },
  { url: '/api/integrations/requests' },
  { url: '/api/tools-service/jobs' },
  { url: '/api/usage/me' },
  { url: '/api/runs' },
  { url: '/api/eu-ai-act/acknowledgements/me' }
];

/** Every id of alice's resources, plus her secret marker. */
function aliceMarkers() {
  const keys = [
    'chatId',
    'runId',
    'messageId',
    'fileId',
    'shareId',
    'code',
    'promptId',
    'skillId',
    'projectId',
    'itemId',
    'taskId',
    'taskFileId',
    'taskRunId',
    'executionId',
    'interactionId',
    'agentRunId',
    'conversationId',
    'inferenceFileId',
    'keyId',
    'requestId',
    'jobId',
    'privateUserAppId'
  ];
  return [SECRET, ...keys.map(key => ids[key]).filter(Boolean)];
}

for (const viewer of ['bob', 'carol']) {
  test(`${viewer}'s lists, searches and counts contain nothing of alice's`, async () => {
    const markers = aliceMarkers();
    const failures = [];
    for (const list of LISTS) {
      if (list[viewer] === false) continue;
      const res = await send(ctx[viewer], { method: 'GET', url: list.url });
      if (res.status >= 500 || res.timedOut) failures.push(`${list.url} -> ${res.status}`);
      const found = (list[viewer] === 'secretOnly' ? [SECRET] : markers).filter(marker =>
        res.text.includes(marker)
      );
      if (found.length) failures.push(`${list.url} leaks ${found.join(', ')}`);
    }
    expect(failures).toEqual([]);

    // Counts: bob made no model call, so his usage totals are zero although
    // alice's are not.
    if (viewer === 'bob') {
      const usage = await (await ctx.bob.get('/api/usage/me')).json();
      expect(usage.totals).toEqual({ day: 0, week: 0, month: 0 });
      const aliceUsage = await (await ctx.alice.get('/api/usage/me')).json();
      expect(aliceUsage.totals.month).toBeGreaterThan(0);
    }
  });
}

test('every list endpoint answers its owner or an admin (no list check passes on a 404)', async () => {
  // The list checks above fail only on a 5xx; a mistyped or removed list URL answers
  // 404 to everyone and would pass them without testing anything.
  const dead = [];
  for (const { url } of LISTS) {
    const asAlice = await send(ctx.alice, { method: 'GET', url });
    if (asAlice.status >= 200 && asAlice.status < 300) continue;
    const asAdmin = await send(ctx.admin, { method: 'GET', url });
    if (asAdmin.status < 200 || asAdmin.status >= 300) {
      dead.push(`${url} -> alice ${asAlice.status}, admin ${asAdmin.status}`);
    }
  }
  expect(dead).toEqual([]);
});

test('the owner sees her items in the same lists (the list checks are not vacuous)', async () => {
  const expectations = [
    ['/api/chats', ids.chatId],
    ['/api/shortlinks', ids.code],
    ['/api/prompts?scope=mine', ids.promptId],
    ['/api/user-skills', ids.skillId],
    ['/api/projects', ids.projectId],
    ['/api/apps?scope=mine', ids.privateUserAppId],
    ['/api/scheduled-tasks', ids.taskId],
    ['/api/workflows/my-executions', ids.executionId],
    ['/api/interactions/pending', ids.interactionId],
    ['/api/inference/v1/files', ids.inferenceFileId],
    ['/api/integrations/api-keys', ids.keyId],
    ['/api/integrations/requests', ids.requestId],
    ['/api/tools-service/jobs', ids.jobId]
  ];
  for (const [url, id] of expectations) {
    expect(await (await ctx.alice.get(url)).text(), `alice ${url}`).toContain(id);
  }
  // Carol, a recipient, sees what was shared with her.
  expect(await (await ctx.carol.get('/api/shares/with-me')).text()).toContain(ids.shareId);
  expect(await (await ctx.carol.get('/api/prompts?scope=shared')).text()).toContain(ids.promptId);
});

test('carol cannot use the app, model, prompt, skill, page or workflow her group lacks', async () => {
  const carolKey = (
    await (await ctx.carol.post('/api/integrations/api-keys', { data: { name: 'carol' } })).json()
  ).secrets.apiKey;
  ctx.carolKey = await bearerContext(carolKey);

  const failures = [];
  for (const entry of GROUP_GATED) {
    for (const who of ['carol', 'anonymous']) {
      const context = entry.bearer ? (who === 'carol' ? ctx.carolKey : ctx.anonymous) : ctx[who];
      const res = await attack(context, entry);
      const problem = judge(entry, who, res);
      if (problem) failures.push(`${who} ${entry.route} -> ${problem}`);
    }
  }
  // Alice (users) may: the denials above are about carol's group, not the route.
  ctx.aliceKey = await bearerContext(ids.apiKey);
  for (const entry of GROUP_GATED) {
    if (entry.stream) continue;
    const res = await attack(entry.bearer ? ctx.aliceKey : ctx.alice, {
      ...entry,
      data: entry.route.startsWith('POST /api/skills/')
        ? { name: `copy-${Date.now()}` }
        : entry.data
    });
    const ok = res.status >= 200 && res.status < 300 && !(res.json?.error && !res.json?.result);
    if (!ok) failures.push(`alice ${entry.route} -> ${res.status} ${res.text.slice(0, 160)}`);
  }
  expect(failures).toEqual([]);

  // The lists carol sees leave the secret items out.
  for (const [url, id] of [
    ['/api/apps', SECRET_APP_ID],
    ['/api/models', SECRET_MODEL_ID],
    ['/api/prompts', FIXED_IDS.secretPromptId],
    ['/api/skills', FIXED_IDS.secretSkillId],
    ['/api/workflows', FIXED_IDS.workflowId]
  ]) {
    expect(await (await ctx.carol.get(url)).text(), `carol ${url}`).not.toContain(id);
    expect(await (await ctx.alice.get(url)).text(), `alice ${url}`).toContain(id);
  }
});

/** Status and body of an answer, with the app id and what differs per request blanked. */
function answerShape(res, appId) {
  const body = res.text
    .split(appId)
    .join('<app>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/file_[0-9a-f]+/g, '<file>')
    .replace(/"(timestamp|createdAt|updatedAt)":"[^"]*"/g, '"$1":"<time>"');
  return `${res.status} ${body}`;
}

test('an unpublished app is an unknown app to users and API keys; an admin can try it', async ({}, testInfo) => {
  const keys = {
    bobKey: await bearerContext(await newKey(ctx.bob)),
    // An admin's personal API key acts as its owner, never as an admin.
    adminKey: await bearerContext(await newKey(ctx.admin))
  };
  const attackers = { bob: ctx.bob, carol: ctx.carol, anonymous: ctx.anonymous, ...keys };
  const failures = [];
  const seen = [];
  for (const entry of UNPUBLISHED_APP) {
    for (const [who, context] of Object.entries(attackers)) {
      const unknown = await send(context, await entry.request(UNKNOWN_APP_ID, context));
      const res = await send(context, await entry.request(UNPUBLISHED_APP_ID, context));
      seen.push(`${who.padEnd(9)} ${String(res.status).padEnd(4)} ${entry.route}`);
      if (res.timedOut || unknown.timedOut) {
        failures.push(`${who} ${entry.route} -> no complete answer`);
      } else if (answerShape(res, UNPUBLISHED_APP_ID) !== answerShape(unknown, UNKNOWN_APP_ID)) {
        failures.push(
          `${who} ${entry.route} -> ${answerShape(res, UNPUBLISHED_APP_ID).slice(0, 200)} ` +
            `but an unknown app gets ${answerShape(unknown, UNKNOWN_APP_ID).slice(0, 200)}`
        );
      }
      if (res.text.includes(UNPUBLISHED_APP_MARKER)) {
        failures.push(`${who} ${entry.route} -> the answer holds the unpublished app's text`);
      }
    }
  }
  await testInfo.attach('observed.txt', { body: seen.join('\n'), contentType: 'text/plain' });
  if (process.env.AUTHZ_PRINT) console.log(seen.join('\n'));
  expect(failures).toEqual([]);

  // No list holds it, for the admin either.
  for (const [who, context] of Object.entries({
    ...attackers,
    alice: ctx.alice,
    admin: ctx.admin
  })) {
    const list = await send(context, { method: 'GET', url: '/api/apps' });
    expect(list.text, `${who} GET /api/apps`).not.toContain(UNPUBLISHED_APP_ID);
    expect(list.text, `${who} GET /api/apps`).not.toContain(UNPUBLISHED_APP_MARKER);
  }

  // The admin, signed in, opens it and gets an answer in the interactive chat
  // (so the checks above are not about a route that answers 404 to everyone).
  const opened = await ctx.admin.get(`/api/apps/${UNPUBLISHED_APP_ID}`);
  expect(opened.status()).toBe(200);
  expect((await opened.json()).id).toBe(UNPUBLISHED_APP_ID);
  const turn = await send(ctx.admin, {
    method: 'POST',
    url: `/api/apps/${UNPUBLISHED_APP_ID}/chat/${randomUUID()}`,
    data: { messages: [{ role: 'user', content: 'hello', messageId: 'a1' }] },
    headers: { accept: 'text/event-stream' },
    timeout: 30_000
  });
  expect(turn.status).toBe(200);
  expect(turn.text).toContain('E2E reply');

  // Every other way of running an app answers the admin as for an unknown id.
  const elsewhere = UNPUBLISHED_APP.filter(entry =>
    [
      'GET /api/scheduled-tasks/_apps/:appId/tools',
      'POST /api/inference/v1/chat/completions'
    ].includes(entry.route)
  );
  expect(elsewhere.length).toBe(2);
  for (const entry of elsewhere) {
    const unknown = await send(ctx.admin, await entry.request(UNKNOWN_APP_ID, ctx.admin));
    const res = await send(ctx.admin, await entry.request(UNPUBLISHED_APP_ID, ctx.admin));
    expect(DENY, `admin ${entry.route}`).toContain(res.status);
    expect(answerShape(res, UNPUBLISHED_APP_ID), `admin ${entry.route}`).toBe(
      answerShape(unknown, UNKNOWN_APP_ID)
    );
  }
  for (const context of Object.values(keys)) await context.dispose();
});

test('the OpenAI-compatible API refuses carol the secret model and app', async () => {
  const completion = model => ({
    data: { model, messages: [{ role: 'user', content: 'hello' }] }
  });
  const carolKey = ctx.carolKey ?? (await bearerContext(await newKey(ctx.carol)));
  for (const context of [ctx.carol, carolKey]) {
    const secretModel = await context.post(
      '/api/inference/v1/chat/completions',
      completion(SECRET_MODEL_ID)
    );
    expect(secretModel.status()).toBe(403);
    const secretApp = await context.post(
      '/api/inference/v1/chat/completions',
      completion(`app:${SECRET_APP_ID}`)
    );
    expect(secretApp.status()).toBe(404);
    const allowedModel = await context.post(
      '/api/inference/v1/chat/completions',
      completion('e2e-stub')
    );
    expect(allowedModel.status()).toBe(200);
    expect(await (await context.get('/api/inference/v1/models')).text()).not.toContain(
      SECRET_MODEL_ID
    );
  }
  const alice = await ctx.alice.post(
    '/api/inference/v1/chat/completions',
    completion(SECRET_MODEL_ID)
  );
  expect(alice.status()).toBe(200);
  const anonymous = await ctx.anonymous.post(
    '/api/inference/v1/chat/completions',
    completion(SECRET_MODEL_ID)
  );
  expect(DENY).toContain(anonymous.status());
});

async function newKey(context) {
  const res = await context.post('/api/integrations/api-keys', { data: { name: 'key' } });
  expect(res.status()).toBe(201);
  return (await res.json()).secrets.apiKey;
}

const MCP_HEADERS = { accept: 'application/json, text/event-stream' };
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });

async function mcpSession(context) {
  const init = await context.post('/mcp', {
    headers: MCP_HEADERS,
    data: rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'authz-suite', version: '1' }
    })
  });
  expect(init.status()).toBe(200);
  const sessionId = init.headers()['mcp-session-id'];
  await context.post('/mcp', {
    headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    data: { jsonrpc: '2.0', method: 'notifications/initialized' }
  });
  return sessionId;
}

test('the MCP gateway keeps sessions and apps to their user', async () => {
  const aliceKey = ctx.aliceKey ?? (await bearerContext(ids.apiKey));
  const bobKey = await bearerContext(await newKey(ctx.bob));
  const carolKey = ctx.carolKey ?? (await bearerContext(await newKey(ctx.carol)));

  // No token, or a session cookie, is never enough on /mcp.
  for (const context of [ctx.anonymous, ctx.bob]) {
    const res = await context.post('/mcp', { headers: MCP_HEADERS, data: rpc(1, 'tools/list') });
    expect(res.status()).toBe(401);
  }

  const aliceSession = await mcpSession(aliceKey);
  const hijack = await bobKey.post('/mcp', {
    headers: { ...MCP_HEADERS, 'mcp-session-id': aliceSession },
    data: rpc(2, 'tools/list')
  });
  expect(hijack.status()).toBe(403);
  const end = await bobKey.delete('/mcp', { headers: { 'mcp-session-id': aliceSession } });
  expect(end.status()).toBe(403);
  const stillAlice = await aliceKey.post('/mcp', {
    headers: { ...MCP_HEADERS, 'mcp-session-id': aliceSession },
    data: rpc(3, 'tools/list')
  });
  expect(stillAlice.status()).toBe(200);

  const carolSession = await mcpSession(carolKey);
  const call = await carolKey.post('/mcp', {
    headers: { ...MCP_HEADERS, 'mcp-session-id': carolSession },
    data: rpc(4, 'tools/call', { name: SECRET_APP_ID, arguments: { content: 'hello' } })
  });
  const text = await call.text();
  // Refused: a tool the caller may not see is an unknown tool, which MCP SDK v2
  // answers with JSON-RPC -32602 (v1 answered with an `isError` result).
  expect(text).toMatch(/"error":\{"code":-32602|"isError":true/);
  expect(text).not.toContain('E2E reply');
  const tools = await carolKey.post('/mcp', {
    headers: { ...MCP_HEADERS, 'mcp-session-id': carolSession },
    data: rpc(5, 'tools/list')
  });
  expect(await tools.text()).not.toContain(SECRET_APP_ID);
  await bobKey.dispose();
});

test('A2A tasks stay with the user who started them', async () => {
  const aliceKey = ctx.aliceKey ?? (await bearerContext(ids.apiKey));
  const bobKey = await bearerContext(await newKey(ctx.bob));
  const sent = await aliceKey.post('/a2a', {
    data: rpc(1, 'message/send', {
      message: {
        kind: 'message',
        messageId: 'a2a-1',
        role: 'user',
        parts: [{ kind: 'text', text: `${SECRET} a2a` }],
        metadata: { skillId: 'app__chat' }
      },
      configuration: { blocking: true }
    })
  });
  const taskId = (await sent.json()).result?.id;
  expect(taskId).toBeTruthy();
  for (const method of ['tasks/get', 'tasks/cancel']) {
    const res = await bobKey.post('/a2a', { data: rpc(2, method, { id: taskId }) });
    const body = await res.text();
    expect(JSON.parse(body).error, `bob ${method}`).toBeTruthy();
    expect(body).not.toContain(SECRET);
  }
  const own = await aliceKey.post('/a2a', { data: rpc(3, 'tasks/get', { id: taskId }) });
  expect((await own.json()).result?.id).toBe(taskId);
  await bobKey.dispose();
});

test('admin-only routes outside /api/admin refuse everyone else', async () => {
  const failures = [];
  for (const who of ['bob', 'carol', 'anonymous']) {
    failures.push(...(await runMatrix(who, ADMIN_ONLY)));
  }
  expect(failures).toEqual([]);
});

test("bob cannot attach feedback to alice's run or take her short-link code", async () => {
  const before = await (await ctx.alice.get(`/api/runs/${ids.runId}/events`)).json();
  const feedback = await ctx.bob.post('/api/feedback', {
    data: {
      messageId: ids.messageId,
      appId: 'chat',
      chatId: ids.chatId,
      runId: ids.runId,
      rating: 1,
      feedback: 'bob was here',
      messageContent: 'x'
    }
  });
  expect(feedback.status()).toBeLessThan(500);
  const after = await (await ctx.alice.get(`/api/runs/${ids.runId}/events`)).json();
  expect(after.items.length).toBe(before.items.length);
  expect(JSON.stringify(after)).not.toContain('bob was here');

  const taken = await ctx.bob.post('/api/shortlinks', {
    data: { code: ids.code, url: 'https://evil.example/' }
  });
  expect(taken.status()).toBeGreaterThanOrEqual(400);
  expect(taken.status()).toBeLessThan(500);
  const link = await (await ctx.alice.get(`/api/shortlinks/${ids.code}`)).json();
  expect(link.ownerId).toBe(AUTHZ_USERS.alice.id);
  expect(link.url).toBe(baseline.link[1]);
});

test('the admin still does what admins are documented to do', async () => {
  const admin = ctx.admin;
  // The run ledger list is admin-only (bob got 403 above) and holds alice's run.
  const runs = await admin.get('/api/runs');
  expect(runs.status()).toBe(200);
  // All short links, or one owner's, with the full link.
  const links = await admin.get(`/api/shortlinks?ownerId=${AUTHZ_USERS.alice.id}`);
  expect(await links.text()).toContain(ids.code);
  const link = await (await admin.get(`/api/shortlinks/${ids.code}`)).json();
  expect(link.ownerId).toBe(AUTHZ_USERS.alice.id);
  // Scheduled-task memory: its size, never its text.
  const memory = await admin.get(`/api/admin/scheduled-tasks/${ids.taskId}/memory`);
  expect(memory.status()).toBe(200);
  expect(await memory.text()).not.toContain(SECRET);
  // Group-gated config.
  for (const url of [
    `/api/apps/${SECRET_APP_ID}`,
    `/api/models/${SECRET_MODEL_ID}`,
    `/api/workflows/${FIXED_IDS.workflowId}`
  ]) {
    expect((await admin.get(url)).status(), `admin ${url}`).toBe(200);
  }
  // Revoke a share as admin (owner or admin may); the recipient loses it.
  const revoked = await admin.delete(`/api/shares/${ids.shareId}`);
  expect(revoked.ok(), `admin revokes a share: ${revoked.status()}`).toBe(true);
  expect(DENY).toContain((await ctx.carol.get(`/api/shares/${ids.shareId}`)).status());
});

test("anonymous visitors and signed-in users cannot reach a guest's chat", async () => {
  const guestA = await contextFor('anonymous');
  const guestB = await contextFor('anonymous');
  const chatId = randomUUID();
  const turn = await send(guestA, {
    method: 'POST',
    url: `/api/apps/chat/chat/${chatId}`,
    data: { messages: [{ role: 'user', content: `${SECRET} guest`, messageId: 'g1' }] },
    headers: { accept: 'text/event-stream' },
    timeout: 30_000
  });
  if (process.env.AUTHZ_ANONYMOUS === '0') {
    // Anonymous access off: no guest chat to begin with.
    expect(DENY).toContain(turn.status);
  } else {
    expect(turn.status).toBe(200);
    expect((await guestA.get(`/api/chats/${chatId}`)).status()).toBe(200);
    const entries = [
      { route: 'GET /api/chats/:chatId' },
      { route: 'DELETE /api/chats/:chatId' },
      { route: 'GET /api/chats/:chatId/files' },
      { route: 'GET /api/apps/:appId/chat/:chatId/status' },
      {
        route: 'POST /api/apps/:appId/chat/:chatId',
        data: { messages: [{ role: 'user', content: 'hijack', messageId: 'g2' }] },
        headers: { accept: 'text/event-stream' },
        stream: true
      }
    ];
    const failures = [];
    for (const [who, context] of [
      ['guestB', guestB],
      ['bob', ctx.bob]
    ]) {
      for (const entry of entries) {
        const [method, template] = entry.route.split(' ');
        const res = await send(context, {
          method,
          url: fillPath(template, { chatId, appId: 'chat' }),
          data: entry.data,
          headers: entry.headers,
          timeout: entry.stream ? 5_000 : 15_000
        });
        const problem = judge(entry, 'bob', res);
        if (problem) failures.push(`${who} ${entry.route} -> ${problem}`);
      }
    }
    expect(failures).toEqual([]);
    const own = await (await guestA.get(`/api/chats/${chatId}`)).json();
    expect(own.messages.length).toBe(2);
  }
  await guestA.dispose();
  await guestB.dispose();
});

test('alice can do what the attackers could not (the routes are reachable)', async () => {
  // Runs last among the matrix tests: it changes alice's resources.
  const failures = [];
  const expectOk = async (label, response) => {
    if (!response.ok()) failures.push(`${label} -> ${response.status()} ${await response.text()}`);
  };
  const { alice } = ctx;
  await expectOk(
    'rename chat',
    await alice.patch(`/api/chats/${ids.chatId}`, { data: { title: 'Renamed' } })
  );
  await expectOk(
    'answer checkpoint',
    await alice.post(`/api/runs/${ids.executionId}/interactions/${ids.interactionId}/answer`, {
      data: { value: 'approve' }
    })
  );
  await expectOk(
    'edit short link',
    await alice.put(`/api/shortlinks/${ids.code}`, { data: { path: '/apps/chat?x=1' } })
  );
  await expectOk(
    'edit task',
    await alice.patch(`/api/scheduled-tasks/${ids.taskId}`, { data: { name: 'Renamed task' } })
  );
  await expectOk(
    'rename project',
    await alice.patch(`/api/projects/${ids.projectId}`, { data: { name: 'Renamed project' } })
  );
  await expectOk(
    'edit prompt',
    await alice.put(`/api/prompts/${ids.promptId}`, {
      data: { name: 'Alice prompt', prompt: 'edited' }
    })
  );
  await expectOk(
    'add conversation item',
    await alice.post(`/api/inference/v1/conversations/${ids.conversationId}/items`, {
      data: { items: [{ type: 'message', role: 'user', content: 'more' }] }
    })
  );
  await expectOk(
    'rotate key',
    await alice.post(`/api/integrations/api-keys/${ids.keyId}/_rotate`, { data: {} })
  );
  await expectOk(
    'delete task file',
    await alice.delete(`/api/scheduled-tasks/${ids.taskId}/files/${ids.taskFileId}`)
  );
  expect(failures).toEqual([]);
});

test('every exemption names a reason', () => {
  for (const [route, reason] of Object.entries(EXEMPT_ROUTES)) {
    expect(reason.trim().length, route).toBeGreaterThan(10);
  }
  expect(callerScoped({ status: 200 })).toBeNull();
});
