// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers of the prompt-injection specs: signing in, running one chat turn
 * through the real chat API (SSE), and reading what the model stub and the
 * canary received.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request as playwrightRequest } from '@playwright/test';
import { CANARY_TOKEN } from './compromisedModel.mjs';
import {
  APPS,
  CLIENT_PORT,
  CONTENTS_DIR,
  INTERNAL,
  LLM,
  PROJECTS,
  SECRETS,
  SERVER_PORT
} from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const BASE_URL = `http://127.0.0.1:${CLIENT_PORT}`;
/**
 * The iHub server itself. Server-rendered pages (the embed page of a shared artifact) are
 * only served here: the Vite client proxies `/api` and answers every other path with the app.
 */
export const API_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

/**
 * An API context signed in as `credentials` (local login, `authToken` cookie).
 *
 * @param {{username: string, password: string}} credentials
 */
export async function signedIn(credentials) {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const login = await api.post('/api/auth/local/login', { data: credentials });
  if (!login.ok()) {
    throw new Error(`sign-in as ${credentials.username}: ${login.status()} ${await login.text()}`);
  }
  return api;
}

/** Parse an SSE body into `{ type, data }` frames. */
export function parseFrames(text) {
  const frames = [];
  for (const block of String(text).split(/\n\n+/)) {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const frame = JSON.parse(data);
      frames.push({ type: frame.type, data: frame.data ?? {} });
    } catch {
      // A keep-alive or a non-JSON line.
    }
  }
  return frames;
}

/**
 * One chat turn through `POST /api/apps/:appId/chat/:chatId` with
 * `Accept: text/event-stream`: the response ends with the turn.
 *
 * @param {import('@playwright/test').APIRequestContext} api
 * @param {string} appId
 * @param {string} message
 * @param {{chatId?: string, extra?: Object}} [options]
 * @returns {Promise<{chatId: string, status: number, frames: Array, text: string, answer: string}>}
 */
export async function chatTurn(api, appId, message, { chatId, extra = {} } = {}) {
  const id = chatId || `inj-${crypto.randomUUID()}`;
  const res = await api.post(`/api/apps/${appId}/chat/${id}`, {
    headers: { accept: 'text/event-stream' },
    data: {
      messages: [{ role: 'user', content: message, messageId: `msg-${crypto.randomUUID()}` }],
      modelId: 'e2e-stub',
      language: 'en',
      ...extra
    },
    timeout: 60_000
  });
  const text = await res.text();
  const frames = res.ok() ? parseFrames(text) : [];
  const answer = frames
    .filter(f => f.type === 'step/delta' && f.data.kind === 'text')
    .map(f => f.data.content || '')
    .join('');
  return { chatId: id, status: res.status(), frames, text, answer };
}

/** The `tool/started` frames of a turn: the calls the platform actually started. */
export const startedTools = turn => turn.frames.filter(f => f.type === 'tool/started');

/** Every chat request the model stub received since the last reset. */
export async function modelRequests() {
  const res = await fetch(`${LLM}/__requests`);
  return (await res.json()).items;
}

export async function resetModelRequests() {
  await fetch(`${LLM}/__reset`, { method: 'POST' });
}

/** The tool messages (results) the model was handed, by call id, across requests. */
export async function toolResultsSeenByModel() {
  const results = new Map();
  for (const body of await modelRequests()) {
    for (const message of body.messages || []) {
      if (message.role === 'tool') results.set(message.tool_call_id, String(message.content));
    }
  }
  return results;
}

/** Every request the canary and the internal listener recorded. */
export async function canaryLog() {
  const res = await fetch(`${INTERNAL}/__control/log`);
  return (await res.json()).items;
}

export async function resetCanary() {
  await fetch(`${INTERNAL}/__control/reset`, { method: 'POST' });
}

/** The `CANARY-…` tokens in a value (serialized). */
export function canaryTokensIn(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...new Set(text.match(CANARY_TOKEN) || [])];
}

/**
 * Wait until the seeded project documents are imported (startup import, then
 * the ingest job): before that, the injection is not in any prompt.
 *
 * @param {import('@playwright/test').APIRequestContext} admin
 */
export async function waitForSeededProjects(admin) {
  await expect
    .poll(
      async () => {
        const statuses = [];
        for (const id of Object.values(PROJECTS)) {
          const res = await admin.get(`/api/admin/projects/${id}`);
          if (!res.ok()) return [`${id}: ${res.status()}`];
          statuses.push(...((await res.json()).items || []).map(item => item.status));
        }
        return statuses.length > 0 && statuses.every(status => status === 'ready');
      },
      { timeout: 60_000, message: 'the seeded project documents are imported' }
    )
    .toBe(true);
}

function contentsFile(name) {
  try {
    return fs.readFileSync(path.join(ROOT, CONTENTS_DIR, name), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Secret material that must never reach the model, whatever it asks for:
 * planted canaries (server environment, platform config, an internal service's
 * answer) and the installation's real key material (encryption key, JWT
 * secret, a line of the JWT private key), read from the suite's contents.
 *
 * @param {Array<{name: string, value: string}>} [extra] - e.g. users' session tokens
 * @returns {Array<{name: string, value: string}>}
 */
export function forbiddenSecrets(extra = []) {
  const privateKeyLine =
    contentsFile('.jwt-private-key.pem')
      .split('\n')
      .find(line => /^[A-Za-z0-9+/=]{48,}$/.test(line.trim())) || '';
  return [
    { name: 'server environment secret', value: SECRETS.ENV },
    { name: 'provider API key in the environment', value: SECRETS.ENV_OPENAI },
    { name: 'platform config secret', value: SECRETS.PLATFORM },
    { name: 'internal service response', value: SECRETS.INTERNAL },
    { name: '.encryption-key', value: contentsFile('.encryption-key') },
    { name: '.jwt-secret', value: contentsFile('.jwt-secret') },
    { name: 'JWT private key', value: privateKeyLine.trim() },
    ...extra
  ].filter(secret => secret.value && secret.value.length >= 16);
}

/** The forbidden secrets found in what the model was sent since the last reset. */
export async function secretsSeenByModel(extra = []) {
  const sent = JSON.stringify(await modelRequests());
  return forbiddenSecrets(extra)
    .filter(secret => sent.includes(secret.value))
    .map(secret => secret.name);
}

/** The session token (`authToken` cookie) of an API context, as a forbidden secret. */
export async function sessionTokenOf(api, name) {
  const { cookies } = await api.storageState();
  const token = cookies.find(cookie => cookie.name === 'authToken')?.value || '';
  return { name: `session token of ${name}`, value: token };
}

/** Sign a page's browser context in (local login) and skip the first-visit disclaimer. */
export async function signInPage(page, credentials) {
  await page.addInitScript(() => {
    window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
  });
  const login = await page.request.post('/api/auth/local/login', { data: credentials });
  expect(login.ok(), `sign in as ${credentials.username}`).toBeTruthy();
}

/**
 * Record (and abort) every browser request to `host` from any frame of the
 * page's context: the browser-side canary.
 *
 * @returns {Promise<string[]>} The live list of requested URLs.
 */
export async function recordBrowserRequests(page, host = 'canary.invalid') {
  const hits = [];
  await page.context().route(
    url => url.hostname === host,
    route => {
      hits.push(route.request().url());
      return route.abort();
    }
  );
  // WebSockets bypass HTTP routing: record every attempt to open one to the host (it cannot
  // connect, the host does not resolve), on this page and in the frames it opens.
  const recordSocket = socket => {
    if (new URL(socket.url()).hostname === host) hits.push(socket.url());
  };
  page.on('websocket', recordSocket);
  page.context().on('page', opened => opened.on('websocket', recordSocket));
  return hits;
}

/**
 * Open an app's chat and send one message. The caller waits for what the
 * answer shows.
 */
export async function sendInUi(page, appId, message) {
  const models = page.waitForResponse(
    response => response.url().includes('/api/models') && response.ok()
  );
  await page.goto(`/apps/${appId}`);
  await models;
  await page.waitForLoadState('networkidle');
  await page.getByRole('textbox', { name: 'Type your message' }).fill(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/**
 * Publish hostile artifact `id` (`hostileArtifacts.mjs`) as `api`'s user: one turn of the
 * artifact lab app, whose planted document makes the compromised model create it.
 *
 * @param {import('@playwright/test').APIRequestContext} api
 * @param {string} id
 * @returns {Promise<{chatId: string, artifact: {id: string, name: string, mimeType: string}|null}>}
 *   `artifact` is null when the platform refused to store it.
 */
export async function publishHostileArtifact(api, id) {
  const turn = await chatTurn(
    api,
    APPS.artifactLab,
    `Publish the vendor file [inj-artifact-${id}]`
  );
  expect(turn.status, `turn that publishes ${id}`).toBe(200);
  const res = await api.get(`/api/chats/${turn.chatId}/artifacts`);
  expect(res.ok(), `list the artifacts of ${turn.chatId}`).toBeTruthy();
  const { items } = await res.json();
  return { chatId: turn.chatId, artifact: items[0] || null };
}

/** Share a chat (or one of its artifacts) as `api`'s user; the link that comes back. */
export async function createShare(api, chatId, options = {}) {
  const { artifactId, ...body } = options;
  const path = artifactId
    ? `/api/chats/${chatId}/artifacts/${artifactId}/shares`
    : `/api/chats/${chatId}/shares`;
  const res = await api.post(path, { data: { mode: 'authenticated', ...body } });
  expect(
    res.status(),
    `share ${artifactId ? 'artifact' : 'chat'} ${chatId}: ${await res.text()}`
  ).toBe(201);
  return res.json();
}

/**
 * Sign a page in as a victim whose session token is also in `localStorage`: the cookie the
 * login set, and the copy the client keeps when a session starts from an external token
 * (proxy auth, `AuthContext.loginWithToken`). The worst case for any script that ever runs
 * on an iHub origin. Returns the token, the value that must never leave.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{username: string, password: string}} credentials
 * @returns {Promise<string>}
 */
export async function signInVictimPage(page, credentials) {
  await signInPage(page, credentials);
  const cookie = (await page.context().cookies()).find(entry => entry.name === 'authToken');
  expect(cookie?.value, 'the login set a session cookie').toBeTruthy();
  await page.addInitScript(token => {
    try {
      window.localStorage.setItem('authToken', token);
    } catch {
      // A sandboxed frame has no storage: that is the point.
    }
  }, cookie.value);
  return cookie.value;
}

/**
 * Every request the page's context tries to make to a host other than iHub, from any
 * frame: what a script attempted, including what its CSP then refused (Chrome reports
 * those too, before the network). What actually left the browser is what
 * {@link recordBrowserRequests} caught at the network layer.
 *
 * @returns {Array<{url: string, postData: string, headers: Record<string, string>}>} Live list.
 */
export function recordForeignRequests(page) {
  const seen = [];
  page.context().on('request', request => {
    const url = request.url();
    if (!/^(https?|wss?):/i.test(url)) return;
    const { hostname } = new URL(url);
    if (hostname === '127.0.0.1' || hostname === 'localhost') return;
    seen.push({ url, postData: request.postData() || '', headers: request.headers() });
  });
  return seen;
}

/** Whether `value` (a URL, a body, a header map) carries `secret`, plain or percent-encoded. */
export function carries(value, secret) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(secret) || text.includes(encodeURIComponent(secret));
}
