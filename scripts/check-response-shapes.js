#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Response-shape contract: what every readable API route answers, as a committed
 * snapshot (`tests/contract/response-shapes.json`).
 *
 * The server starts on a fresh, seeded contents directory (the same one the e2e
 * suites use). The script signs in as the default admin and requests every `GET`
 * route of the route table (`scripts/dump-routes.js`); a route with one path
 * parameter takes the first id its parent collection lists. Of each JSON answer it
 * records the shape — keys and types, a list as the merged shape of its elements,
 * three levels deep — never a value. The result is compared with the snapshot.
 *
 * A server change that renames or moves a key in an answer changes the snapshot, so
 * the pull request shows it and its clients are looked at (a client that still reads
 * `data.connections` from an answer that now says `items` shows nothing until a page
 * has data). A route that answers with a list of no element has no element shape yet:
 * the snapshot says `[]`, and the report names such routes, so the gap is visible.
 *
 * What it does not see: a client that reads the wrong key of an answer that did not
 * change (that is what the crawl is for), `POST`/`PUT`/`DELETE` answers, and shapes
 * that need data the seed does not have.
 *
 * Usage:
 *   node scripts/check-response-shapes.js            compare with the snapshot
 *   node scripts/check-response-shapes.js --update   rewrite the snapshot
 *   node scripts/check-response-shapes.js --list     print the shapes found, no comparison
 *   node scripts/check-response-shapes.js --serve    start the seeded server and wait (to explore it)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = path.join(root, 'tests', 'contract', 'response-shapes.json');

// Key order must be the same on every machine, so it never depends on the locale
// (`localeCompare` does): plain code-unit order.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MAX_DEPTH = 3;
const MAX_ELEMENTS = 25;

/** GET routes that stream, download, redirect, reach the network or are not JSON. */
export const NOT_REQUESTED = [
  [/\/(stream|events|sse)$|\/stream\//, 'streams'],
  [/download|\.zip$|\.crx$|\.xml$|\/package\b|\/_file$|\/content$|\/export$/, 'a download'],
  [/^\/api\/docs|^\/api\/swagger|\/swagger/, 'API documentation'],
  [
    /\/callback\b|\/authorize\b|^\/api\/auth\/(oidc|google|microsoft|ntlm|proxy)|\/login\/|\/logout/,
    'a redirect or sign-in flow'
  ],
  [
    /^\/api\/oauth\/|^\/\.well-known|^\/mcp|^\/a2a|^\/api\/inference|^\/inference/,
    'an external specification'
  ],
  [/^\/api\/admin\/(update|version\/check)|^\/api\/admin\/marketplace/, 'reaches the network'],
  [
    /^\/s\/|^\/share\/|^\/office\/|^\/nextcloud\/|^\/manifest|^\/sw\.js|^\/uploads|^\/$|\*/,
    'not an API answer'
  ]
];

/** A compact description of the keys and types of `value`. */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (depth >= MAX_DEPTH) return 'array';
    return [mergeShapes(value.slice(0, MAX_ELEMENTS).map(v => shapeOf(v, depth + 1)))];
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object';
    return Object.fromEntries(
      Object.keys(value)
        .sort(byCodeUnit)
        .map(key => [key, shapeOf(value[key], depth + 1)])
    );
  }
  return typeof value;
}

/** Objects: the union of keys, a key some lack marked with `?`. */
function mergeObjectShapes(objects) {
  const keys = [...new Set(objects.flatMap(o => Object.keys(o)))].sort(byCodeUnit);
  return Object.fromEntries(
    keys.map(key => {
      const present = objects.filter(o => key in o);
      const merged = mergeShapes(present.map(o => o[key]));
      return [present.length === objects.length ? key : `${key}?`, merged];
    })
  );
}

/** One shape for several: objects by key, lists by element, anything else as its types joined by `|`. */
export function mergeShapes(shapes) {
  if (shapes.length === 1) return shapes[0];
  const isObject = s => s && typeof s === 'object' && !Array.isArray(s);
  if (shapes.every(isObject)) return mergeObjectShapes(shapes);
  if (shapes.every(Array.isArray)) {
    const inner = shapes.flat();
    return inner.length ? [mergeShapes(inner)] : [];
  }
  const names = [...new Set(shapes.map(s => (typeof s === 'string' ? s : JSON.stringify(s))))].sort(
    byCodeUnit
  );
  return names.length === 1 ? shapes[0] : names.join('|');
}

/**
 * Parts of an answer that depend on timing, not on the code: they are described in a
 * way that holds however the race went. Keyed by route template.
 */
export const NORMALIZERS = {
  // Token counts are computed in the background: a project has a number once counted, null
  // before. Whichever it is, the description is the same one.
  '/api/admin/projects/_tokens': shape => {
    const projects = shape?.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return shape;
    const merged = mergeShapes(Object.values(projects));
    if (!merged || typeof merged !== 'object') return shape;
    return { ...shape, projects: { '<id>': { ...merged, tokens: 'null|number' } } };
  },
  // The resource sampler fills its fields on its first tick, five seconds after start: a
  // request before it sees null, one after it a value. How soon the check reaches this
  // route depends on what the server does meanwhile (the first fetch of the shipped
  // project's web pages, #3622), so the description holds either way.
  '/api/admin/system/resources': shape => {
    const sampled = (value, type) =>
      ['null', type, `null|${type}`].includes(value) ? `null|${type}` : value;
    const cpu = shape?.host?.cpu;
    const host =
      cpu && typeof cpu === 'object'
        ? {
            ...shape.host,
            cpu: { ...cpu, utilizationPercent: sampled(cpu.utilizationPercent, 'number') }
          }
        : shape?.host;
    const processes = Array.isArray(shape?.processes)
      ? shape.processes.map(entry =>
          entry && typeof entry === 'object'
            ? {
                ...entry,
                eventLoopDelayMs: sampled(entry.eventLoopDelayMs, 'object'),
                sampledAt: sampled(entry.sampledAt, 'string')
              }
            : entry
        )
      : shape?.processes;
    return { ...shape, host, processes };
  },
  // `import` is the transient state of an item that is still being ingested, and
  // `text` is null until the ingest job has stored the item's text, an object after.
  '/api/admin/projects/:id': shape => {
    if (!Array.isArray(shape?.items) || !shape.items[0] || typeof shape.items[0] !== 'object') {
      return shape;
    }
    const { import: _import, 'import?': _optional, ...element } = shape.items[0];
    if (['null', 'object', 'null|object'].includes(element.text)) element.text = 'null|object';
    return { ...shape, items: [element] };
  }
};

/** Why a route is not requested, or null. */
export function notRequestedReason(routePath) {
  for (const [pattern, reason] of NOT_REQUESTED) if (pattern.test(routePath)) return reason;
  return null;
}

/** The first id a list answer offers: `items[0].id`, a keyed map's first key, or an array element's id. */
export function firstId(body) {
  const items = Array.isArray(body) ? body : body?.items;
  if (Array.isArray(items) && items.length) {
    const first = items[0];
    if (typeof first === 'string') return first;
    return first?.id ?? first?.name ?? first?.key ?? first?.code ?? null;
  }
  if (body && typeof body === 'object') {
    for (const value of Object.values(body)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
        const id = value[0].id ?? value[0].name ?? value[0].key;
        if (id) return id;
      }
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(contentsDir) {
  const port = await freePort();
  // Answers must not depend on the machine: a developer's proxy variables would show up
  // in `/api/admin/proxy/config`, a runner's would not.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(all|http|https|no)_proxy$/i.test(name))
  );
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...environment,
      NODE_ENV: 'production',
      WORKERS: '1',
      HOST: '127.0.0.1',
      PORT: String(port),
      CONTENTS_DIR: contentsDir,
      TELEMETRY_ENABLED: 'false',
      JWT_SECRET: process.env.JWT_SECRET || 'response-shapes-contract'
    }
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('the server exited while starting');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) return { child, base: `http://127.0.0.1:${port}` };
    } catch {
      /* not listening yet */
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  child.kill('SIGKILL');
  throw new Error('the server did not come up in time');
}

/** SIGTERM, wait for the exit (SIGKILL after 15 s). */
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
}

async function request(base, cookie, routePath) {
  try {
    const response = await fetch(base + routePath, {
      headers: { cookie, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000)
    });
    const type = response.headers.get('content-type') || '';
    if (!/json/.test(type)) return { status: response.status, type: type.split(';')[0] || 'none' };
    return { status: response.status, type: 'json', body: await response.json() };
  } catch (error) {
    return { status: 0, type: `error: ${error.name}` };
  }
}

/**
 * Fill every path parameter of `routePath`, left to right: each takes the first id the
 * list at the path before it offers (`/api/projects/:projectId/items/:itemId` asks
 * `/api/projects`, then `/api/projects/<id>/items`).
 */
async function resolvePath(base, cookie, routePath, getPaths) {
  const template = routePath.split('/');
  const fill = async (i, filled) => {
    const next = template.findIndex((segment, at) => at >= i && segment.startsWith(':'));
    if (next < 0) return { path: filled.join('/') };
    const parentTemplate = template.slice(0, next).join('/');
    if (!parentTemplate || !getPaths.has(parentTemplate)) {
      return { skipped: 'its parent path is not a readable list' };
    }
    const listing = await request(base, cookie, filled.slice(0, next).join('/'));
    const id = listing.body ? firstId(listing.body) : null;
    if (id === null || id === undefined) {
      return { skipped: 'its parent list has no entry in the seed' };
    }
    const filledNext = [...filled];
    filledNext[next] = encodeURIComponent(String(id));
    return fill(next + 1, filledNext);
  };
  return fill(0, [...template]);
}

/**
 * Switch the preview features on and create one record of each kind a client lists, so
 * the answers have elements to describe. Every step must succeed: a seed that quietly
 * did less would change the snapshot.
 */
export async function seedData(base, cookie) {
  const send = async (method, routePath, body, expected) => {
    const response = await fetch(base + routePath, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!expected.includes(response.status)) {
      throw new Error(
        `seed step ${method} ${routePath} answered ${response.status}: ${(await response.text()).slice(0, 300)}`
      );
    }
  };
  const feature = {
    skills: true,
    workflows: true,
    userProjects: true,
    chatSharing: true,
    compareMode: true,
    appAsTool: true,
    agentFactory: true,
    toolsService: true,
    voiceMode: true
  };
  await send('PUT', '/api/admin/features', feature, [200]);
  await send(
    'POST',
    '/api/admin/configs/platform',
    { oauth: { enabled: { clients: true } } },
    [200]
  );
  await send(
    'POST',
    '/api/prompts',
    { name: 'Contract prompt', prompt: 'Summarise [text]' },
    [201]
  );
  await send(
    'POST',
    '/api/projects',
    { name: 'Contract project', instructions: 'Be brief.' },
    [201]
  );
  await send(
    'POST',
    '/api/scheduled-tasks',
    {
      name: 'Contract task',
      appId: 'chat',
      instructions: 'Say hello.',
      schedule: { type: 'manual' }
    },
    [201]
  );
  await send('POST', '/api/shortlinks', { url: '/apps/chat', appId: 'chat' }, [200, 201]);
  await send(
    'POST',
    '/api/user-skills',
    { name: 'contract-skill', description: 'A skill.', body: 'Do it.' },
    [201]
  );
  await send(
    'POST',
    '/api/admin/credentials',
    { id: 'contract-credential', name: 'Contract credential', type: 'bearer', token: 'abc' },
    [201]
  );
  await send(
    'POST',
    '/api/admin/document-templates',
    { id: 'contract-template', name: { en: 'Contract template' }, description: { en: 'x' } },
    [201]
  );
  await send(
    'POST',
    '/api/admin/agents/inboxes/contract-inbox',
    { name: { en: 'Contract inbox' } },
    [201]
  );
  await send(
    'POST',
    '/api/admin/agents/profiles',
    { id: 'contract-agent', name: { en: 'Contract agent' }, description: { en: 'x' } },
    [201]
  );
  await send(
    'POST',
    '/api/workflows',
    {
      id: 'contract-workflow',
      version: '1.0.0',
      name: { en: 'Contract workflow' },
      description: { en: 'x' },
      nodes: [
        { id: 'start', type: 'start', name: { en: 'Start' }, position: { x: 0, y: 0 }, config: {} },
        {
          id: 'end',
          type: 'end',
          name: { en: 'End' },
          position: { x: 200, y: 0 },
          config: { output: 'result' }
        }
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end' }]
    },
    [201]
  );
  await send(
    'POST',
    '/api/admin/oauth/clients',
    { name: 'Contract client', redirectUris: ['http://localhost:9999/cb'], scopes: ['openid'] },
    [201]
  );
  // A stored chat (one non-streaming turn on the stub model) and a share of it.
  await send(
    'POST',
    '/api/apps/chat/chat/contract-chat',
    {
      messages: [{ role: 'user', content: 'Hello contract', messageId: 'm1' }],
      modelId: 'e2e-stub',
      language: 'en',
      streaming: false
    },
    [200]
  );
  await send('POST', '/api/chats/contract-chat/shares', { mode: 'authenticated' }, [200, 201]);
}

/** `{ "GET /api/x": { status, shape } | { status, type } | { skipped } }` for the running server. */
export async function collectShapes({ base, cookie, routes }) {
  const getRoutes = routes.filter(r => r.method === 'GET').map(r => r.path);
  const getPaths = new Set(getRoutes);
  const out = {};
  const visit = async routePath => {
    const key = `GET ${routePath}`;
    const reason = notRequestedReason(routePath);
    if (reason) {
      out[key] = { skipped: reason };
      return;
    }
    const resolved = await resolvePath(base, cookie, routePath, getPaths);
    if (resolved.skipped) {
      out[key] = { skipped: resolved.skipped };
      return;
    }
    const answer = await request(base, cookie, resolved.path);
    out[key] =
      answer.type === 'json'
        ? {
            status: answer.status,
            shape: (NORMALIZERS[routePath] ?? (x => x))(shapeOf(answer.body))
          }
        : { status: answer.status, type: answer.type };
  };
  // One request at a time: the seed's state and the rate limit stay simple.
  await [...new Set(getRoutes)]
    .sort(byCodeUnit)
    .reduce((chain, routePath) => chain.then(() => visit(routePath)), Promise.resolve());
  return out;
}

/** Differences between two snapshots, one line each. */
export function diffSnapshots(expected, actual) {
  const lines = [];
  for (const key of Object.keys({ ...expected, ...actual }).sort(byCodeUnit)) {
    const a = JSON.stringify(expected[key]);
    const b = JSON.stringify(actual[key]);
    if (a === b) continue;
    if (expected[key] === undefined) lines.push(`+ ${key}  (new route)  ${b}`);
    else if (actual[key] === undefined) lines.push(`- ${key}  (gone)`);
    else lines.push(`~ ${key}\n    was ${a}\n    now ${b}`);
  }
  return lines;
}

/** Sign in as the default admin; the cookie header for later requests. */
async function signIn(base) {
  const login = await fetch(`${base}/api/auth/local/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password123' })
  });
  if (!login.ok) throw new Error(`the default admin could not sign in (${login.status})`);
  return (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
}

/** Item states the server is still working on. */
const UNSETTLED_ITEM_STATES = new Set(['pending', 'extracting']);

/**
 * Wait until the admin projects' items have settled.
 *
 * The server imports the seeded projects' file-backed items in the background, a
 * moment after it starts (`importPendingProjects` in services/projects/bootstrap.js).
 * `/api/health` answers before that, so on a slow machine the crawl could catch an
 * item half-way (an `import` pointer, `text: null`) and the snapshot would differ
 * from run to run. Gives up after `timeoutMs` and crawls anyway: the comparison then
 * shows what did not settle.
 */
export async function waitForProjectImports(base, cookie, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const unsettled = await unsettledProjectItems(base, cookie);
    if (unsettled.length === 0) return;
    if (Date.now() >= deadline) {
      console.warn(
        `project items still importing after ${timeoutMs / 1000}s: ${unsettled.join(', ')}`
      );
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    await poll();
  };
  await poll();
}

/** `projectId/itemId` of every admin project item the server is still working on. */
async function unsettledProjectItems(base, cookie, cursor = null) {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  const answer = await request(base, cookie, `/api/admin/projects?${query}`);
  // An answer that is not the list (an error) is nothing to wait for.
  if (answer.type !== 'json' || answer.status !== 200) return [];
  const unsettled = (answer.body.items ?? []).flatMap(project =>
    (project.items ?? [])
      .filter(item => UNSETTLED_ITEM_STATES.has(item.status))
      .map(item => `${project.id}/${item.id}`)
  );
  const next = answer.body.nextCursor;
  return next ? [...unsettled, ...(await unsettledProjectItems(base, cookie, next))] : unsettled;
}

async function main() {
  const flags = new Set(process.argv.slice(2));

  // The server reads CONTENTS_DIR when its config module is first loaded, so the
  // directory is chosen before anything of the server is imported.
  const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapes-'));
  process.chdir(root);
  process.env.CONTENTS_DIR = contentsDir;

  const { dumpRoutes } = await import('./dump-routes.js');
  const routes = await dumpRoutes();
  const { prepareE2eContents } = await import(
    pathToFileURL(path.join(root, 'tests/config/e2e-contents.mjs')).href
  );
  await prepareE2eContents({ root, contentsDir, llmPort: await freePort() });

  const { child, base } = await startServer(contentsDir);
  if (flags.has('--serve')) {
    const login = await signIn(base);
    await seedData(base, login);
    console.log(`seeded server: ${base}  (admin / password123); Ctrl-C to stop`);
    await new Promise(() => {});
  }
  let snapshot;
  try {
    const cookie = await signIn(base);
    await seedData(base, cookie);
    await waitForProjectImports(base, cookie);
    snapshot = await collectShapes({ base, cookie, routes });
  } finally {
    // Delete the contents only once the server is gone: a server still shutting
    // down writes into the directory (flushes, locks) while rmSync walks it,
    // which fails with ENOTEMPTY.
    await stopServer(child);
    fs.rmSync(contentsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const requested = Object.values(snapshot).filter(v => !v.skipped);
  const withShape = requested.filter(v => v.shape !== undefined);
  // A list with no element has no element shape: the snapshot cannot tell a renamed
  // key inside it. Naming such routes keeps that gap visible.
  const emptyLists = Object.entries(snapshot).filter(([, v]) =>
    Array.isArray(v.shape) ? v.shape.length === 0 : v.shape?.items?.length === 0
  );
  const errorAnswers = requested.filter(v => (v.status ?? 200) >= 400);
  const total = Object.keys(snapshot).length;
  console.log(
    `${total} GET routes: ${withShape.length} with a JSON shape (${errorAnswers.length} of them an ` +
      `error body), ${requested.length - withShape.length} answering something else, ` +
      `${total - requested.length} not requested`
  );
  if (emptyLists.length) {
    console.log(`${emptyLists.length} answer an empty list (no element shape yet):`);
    for (const [key] of emptyLists) console.log(`  ${key}`);
  }

  if (flags.has('--list')) {
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (flags.has('--update')) {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, text);
    console.log(`wrote ${path.relative(root, SNAPSHOT_PATH)}`);
    return 0;
  }
  const expected = fs.existsSync(SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    : {};
  const lines = diffSnapshots(expected, snapshot);
  for (const line of lines) console.log(line);
  console.log(
    lines.length
      ? `\n${lines.length} route(s) answer differently from tests/contract/response-shapes.json.\n` +
          'If that is intended, check the clients that read them, then run: node scripts/check-response-shapes.js --update'
      : 'The answers match tests/contract/response-shapes.json.'
  );
  return lines.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
