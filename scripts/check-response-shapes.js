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
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = path.join(root, 'tests', 'contract', 'response-shapes.json');

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
        .sort()
        .map(key => [key, shapeOf(value[key], depth + 1)])
    );
  }
  return typeof value;
}

/** One shape for several: an object with the union of keys (`?` marks a key some lack), types joined by `|`. */
export function mergeShapes(shapes) {
  if (shapes.length === 1) return shapes[0];
  const objects = shapes.filter(s => s && typeof s === 'object' && !Array.isArray(s));
  if (objects.length === shapes.length) {
    const keys = [...new Set(objects.flatMap(o => Object.keys(o)))].sort();
    return Object.fromEntries(
      keys.map(key => {
        const present = objects.filter(o => key in o);
        const merged = mergeShapes(present.map(o => o[key]));
        return [present.length === objects.length ? key : `${key}?`, merged];
      })
    );
  }
  const arrays = shapes.filter(Array.isArray);
  if (arrays.length === shapes.length) {
    const inner = arrays.flat();
    return inner.length ? [mergeShapes(inner)] : [];
  }
  const names = [
    ...new Set(shapes.map(s => (typeof s === 'string' ? s : JSON.stringify(s))))
  ].sort();
  return names.length === 1 ? shapes[0] : names.join('|');
}

/** Why a route is not requested, or null. */
export function notRequestedReason(routePath) {
  for (const [pattern, reason] of NOT_REQUESTED) if (pattern.test(routePath)) return reason;
  return null;
}

const paramNames = routePath => [...routePath.matchAll(/:(\w+)/g)].map(m => m[1]);

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
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
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

/** Fill the one path parameter of `routePath` from the list at its parent path. */
async function resolvePath(base, cookie, routePath, getPaths) {
  const names = paramNames(routePath);
  if (names.length === 0) return { path: routePath };
  if (names.length > 1) return { skipped: 'more than one path parameter' };
  const parent = routePath.slice(0, routePath.indexOf('/:'));
  if (!parent || !getPaths.has(parent))
    return { skipped: 'its parent path is not a readable list' };
  const listing = await request(base, cookie, parent);
  const id = listing.body ? firstId(listing.body) : null;
  if (id === null || id === undefined)
    return { skipped: 'its parent list has no entry in the seed' };
  return { path: routePath.replace(/:\w+/, encodeURIComponent(String(id))) };
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
        ? { status: answer.status, shape: shapeOf(answer.body) }
        : { status: answer.status, type: answer.type };
  };
  // One request at a time: the seed's state and the rate limit stay simple.
  await [...new Set(getRoutes)]
    .sort()
    .reduce((chain, routePath) => chain.then(() => visit(routePath)), Promise.resolve());
  return out;
}

/** Differences between two snapshots, one line each. */
export function diffSnapshots(expected, actual) {
  const lines = [];
  for (const key of Object.keys({ ...expected, ...actual }).sort()) {
    const a = JSON.stringify(expected[key]);
    const b = JSON.stringify(actual[key]);
    if (a === b) continue;
    if (expected[key] === undefined) lines.push(`+ ${key}  (new route)  ${b}`);
    else if (actual[key] === undefined) lines.push(`- ${key}  (gone)`);
    else lines.push(`~ ${key}\n    was ${a}\n    now ${b}`);
  }
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const { dumpRoutes } = await import('./dump-routes.js');
  const routes = await dumpRoutes();

  const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapes-'));
  process.chdir(root);
  process.env.CONTENTS_DIR = contentsDir;
  const { prepareE2eContents } = await import(
    pathToFileURL(path.join(root, 'tests/config/e2e-contents.mjs')).href
  );
  await prepareE2eContents({ root, contentsDir, llmPort: await freePort() });

  const { child, base } = await startServer(contentsDir);
  let snapshot;
  try {
    const login = await fetch(`${base}/api/auth/local/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' })
    });
    if (!login.ok) throw new Error(`the default admin could not sign in (${login.status})`);
    const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
    snapshot = await collectShapes({ base, cookie, routes });
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(contentsDir, { recursive: true, force: true });
  }

  const requested = Object.values(snapshot).filter(v => !v.skipped);
  const withShape = requested.filter(v => v.shape !== undefined);
  const emptyLists = Object.entries(snapshot).filter(
    ([, v]) => Array.isArray(v.shape) && v.shape.length === 0
  );
  console.log(
    `${Object.keys(snapshot).length} GET routes: ${withShape.length} with a JSON shape, ` +
      `${requested.length - withShape.length} answering something else, ` +
      `${Object.keys(snapshot).length - requested.length} not requested`
  );
  if (emptyLists.length) {
    console.log(`${emptyLists.length} answer an empty list (no element shape yet):`);
    for (const [key] of emptyLists) console.log(`  ${key}`);
  }

  if (argv.includes('--list')) {
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (argv.includes('--update')) {
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
