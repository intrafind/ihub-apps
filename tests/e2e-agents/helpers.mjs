// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers of the agents end-to-end specs: signing in, sending a message in the
 * chat page or through the chat API, watching the page's chat requests, driving
 * the model stub (what it was sent, releasing a hang), reading the counter of the
 * test tools and restarting the server.
 *
 * The specs run against the real server. They never answer an `/api` request
 * themselves (`page.route(…)` with `route.fulfill(…)`): what a spec needs from the
 * model it gets through the stub's markers (`tests/config/e2e-llm-stub.mjs`), and
 * `server/tests/e2e-agents-suite.test.js` fails the build on a mocked API.
 */

import crypto from 'node:crypto';
import { expect, request as playwrightRequest } from '@playwright/test';
import { BASE_URL, CONTROL, LLM, MODELS } from '../config/agents-scenario.mjs';

/**
 * An API context signed in as `credentials` (local login, `authToken` cookie).
 *
 * @param {{username: string, password: string}} credentials
 * @returns {Promise<import('@playwright/test').APIRequestContext>}
 */
export async function signedIn(credentials) {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const login = await api.post('/api/auth/local/login', {
    data: { username: credentials.username, password: credentials.password }
  });
  if (!login.ok()) {
    throw new Error(`sign-in as ${credentials.username}: ${login.status()} ${await login.text()}`);
  }
  return api;
}

/**
 * Sign the page in as `credentials` without the sign-in form, and keep the
 * first-visit disclaimer away (it would sit over every click).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{username: string, password: string}} credentials
 */
export async function signInPage(page, credentials) {
  await dismissDisclaimer(page);
  const login = await page.request.post('/api/auth/local/login', {
    data: { username: credentials.username, password: credentials.password }
  });
  expect(login.ok(), `sign in as ${credentials.username}`).toBeTruthy();
}

/** @param {import('@playwright/test').Page} page */
export async function dismissDisclaimer(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
  });
}

/** The visible copy of a text: the page also holds a hidden one for screen readers. */
export const shown = (page, text) => page.getByText(text).filter({ visible: true }).first();
export const composer = page => page.getByRole('textbox', { name: 'Type your message' });
export const sendButton = page => page.getByRole('button', { name: 'Send', exact: true });
/** The transcript of the chat page. */
export const transcript = page => page.getByRole('log', { name: 'Chat messages' });

/**
 * Open an app's chat page and wait until it knows its models: a message sent
 * before that is shown but never reaches the server.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} appId
 */
export async function openApp(page, appId) {
  const models = page.waitForResponse(
    response => response.url().includes('/api/models') && response.ok()
  );
  await page.goto(`/apps/${appId}`);
  await models;
  await page.waitForLoadState('networkidle');
}

/** Type a message into the composer and send it. */
export async function sendMessage(page, text) {
  await composer(page).fill(text);
  await sendButton(page).click();
}

/**
 * Record what the page sends to an app's chat URL (`/api/apps/<appId>/chat/<chatId>`),
 * to tell on which connection an answer came: the chat `POST` itself
 * (`text/event-stream`), or a stream `GET` opened before a `POST` that answers JSON.
 * Call it before the message is sent. Nothing is intercepted.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} appId
 * @returns {() => Array<{method: string, type: string|null}>} The requests so far,
 *   oldest first, with the content type of the response (`null` while there is none)
 */
export function watchChatRequests(page, appId) {
  const seen = [];
  const chatPath = new RegExp(`/api/apps/${appId}/chat/[^/]+$`);
  page.on('request', request => {
    if (chatPath.test(new URL(request.url()).pathname)) {
      seen.push({ request, method: request.method(), type: null });
    }
  });
  page.on('response', response => {
    const entry = seen.find(item => item.request === response.request());
    if (entry) entry.type = (response.headers()['content-type'] || '').split(';')[0].trim();
  });
  return () => seen.map(({ method, type }) => ({ method, type }));
}

/**
 * A text no other test (and no earlier run of this one) sends, to find one's own
 * requests in `stub.requests(…)`: the stub keeps what the whole run sent.
 *
 * @param {string} text
 * @returns {string}
 */
export const unique = text => `${text} ${crypto.randomUUID().slice(0, 8)}`;

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
 * @param {{chatId?: string, modelId?: string, extra?: Object}} [options]
 * @returns {Promise<{chatId: string, status: number, frames: Array, text: string, answer: string}>}
 */
export async function chatTurn(api, appId, message, { chatId, modelId, extra = {} } = {}) {
  const id = chatId || `e2e-${crypto.randomUUID()}`;
  const res = await api.post(`/api/apps/${appId}/chat/${id}`, {
    headers: { accept: 'text/event-stream' },
    data: {
      messages: [{ role: 'user', content: message, messageId: `msg-${crypto.randomUUID()}` }],
      modelId: modelId || MODELS.default,
      language: 'en',
      ...extra
    },
    timeout: 60_000
  });
  const text = await res.text();
  const frames = res.ok() ? parseFrames(text) : [];
  const answer = frames
    .filter(frame => frame.type === 'step/delta' && frame.data.kind === 'text')
    .map(frame => frame.data.content || '')
    .join('');
  return { chatId: id, status: res.status(), frames, text, answer };
}

async function stubJson(pathname, init) {
  const res = await fetch(`${LLM}${pathname}`, init);
  if (!res.ok) throw new Error(`model stub ${pathname}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/** The model stub (`tests/config/e2e-llm-stub.mjs`). */
export const stub = {
  /**
   * The chat request bodies the stub got, oldest first; with `marker`, the ones
   * with a message that contains it. Use a marker or a text only your test sends:
   * the list is the whole run's.
   *
   * @param {string} [marker]
   * @returns {Promise<Object[]>}
   */
  async requests(marker) {
    const query = marker ? `?marker=${encodeURIComponent(marker)}` : '';
    return (await stubJson(`/__requests${query}`)).items;
  },
  /** @returns {Promise<{aborted: number, hanging: string[]}>} */
  stats: () => stubJson('/__stats'),
  /**
   * End the hang of `e2e-hang:<key>`. Waits for the request to reach the stub
   * first, so a spec may release right after sending the message.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  async release(key) {
    await expect
      .poll(
        async () =>
          (await stubJson(`/__release/${encodeURIComponent(key)}`, { method: 'POST' })).released,
        { message: `the hang ${key} never reached the model stub`, timeout: 15_000 }
      )
      .toBeGreaterThan(0);
  },
  /** End every hang, for an `afterEach` that must leave nothing waiting. */
  releaseAll: () => stubJson('/__release-all', { method: 'POST' })
};

/**
 * The counter of the test tools (`tests/config/test-counter.mjs`), hosted by the
 * suite's helper process: what `e2e_counter_write` wrote, counted outside the
 * server. A spec that needs a write to prove something reads it here, never from
 * a fixture of its own.
 */
export const counter = {
  /**
   * @returns {Promise<{total: number, counters: Record<string, {count: number, values: string[]}>}>}
   */
  async read() {
    const res = await fetch(`${CONTROL}/__counter`);
    if (!res.ok) throw new Error(`the test counter: ${res.status}`);
    return res.json();
  },
  /** How often `key` was written. */
  async count(key) {
    return (await counter.read()).counters[key]?.count ?? 0;
  },
  /** Set every counter to zero. */
  async reset() {
    const res = await fetch(`${CONTROL}/__counter/reset`, { method: 'POST' });
    if (!res.ok) throw new Error(`reset of the test counter: ${res.status}`);
  }
};

/**
 * What the suite's server runs with: how often it was started, and the overlay
 * laid over the seeded settings (`{}` for the seeded ones; see `agents-server.mjs`).
 *
 * @returns {Promise<{starts: number, overlay: {platform?: Object, features?: Object}, running: boolean}>}
 */
export async function serverStatus() {
  const res = await fetch(`${CONTROL}/__status`);
  if (!res.ok) throw new Error(`status of the iHub server: ${res.status}`);
  return res.json();
}

/**
 * Stop the iHub server and start it again on the same contents directory; resolves
 * once it is healthy. The model stub keeps running, with what it has seen.
 *
 * @param {Object} [options]
 * @param {'SIGTERM'|'SIGKILL'} [options.signal] - `SIGKILL` for a server that dies
 * @param {{platform?: Object, features?: Object}} [options.overlay] - Start with
 *   these settings laid over the seeded `platform.json` / `features.json`; `{}` goes
 *   back to the seeded ones. Without it the files stay as they are.
 * @returns {Promise<{starts: number, overlay: Object, running: boolean}>}
 */
export async function restartServer({ signal, overlay } = {}) {
  const res = await fetch(`${CONTROL}/__restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signal, overlay })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`restart of the iHub server: ${res.status} ${body.error}`);
  return body;
}
