// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect, request as playwrightRequest } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * The one connect flow end to end (#2917, #2923), with a per-user MCP server:
 *
 *   1. not connected → the chat shows the Connect card → Connect → consent
 *      (the stub authorization server approves at once) → back in the same
 *      chat → the server runs the stored call once and the answer names the
 *      account, with no message of the user's own in between (#3752);
 *   2. expired → the card says Reconnect → Reconnect → back in the chat → answer;
 *   3. cancelled consent → nothing runs, the card stays;
 *   4. a call that needs approval asks again after the connect (it does not run);
 *   5. a second request for the same stored call (a second tab, a double click)
 *      is refused and runs nothing; another user's request neither;
 *   6. from the chat's integrations picker: `Connect →` → consent in a new tab →
 *      back in the same chat → the row is on → the tool call succeeds.
 *
 * Under a path prefix (`CONNECT_E2E_BASE=/ihub`, `playwright.subpath.config.js`) every
 * request and page goes through the prefix.
 *
 * Everything between the browser and the vendor is the real iHub: the Vite
 * client, the Express server, the connection service and its OAuth client,
 * the MCP client manager, the chat pipeline. What lives beyond iHub is one
 * small HTTP server this file starts (port `CONNECT_E2E_STUB_PORT`, 4178):
 *
 *   - an OpenAI-compatible chat model that calls the MCP tool `whoami` and
 *     answers with what the tool returned;
 *   - an MCP server (`/mcp`, Streamable HTTP, JSON responses) that answers
 *     `401` + `WWW-Authenticate` without a bearer token (RFC 9728);
 *   - its authorization server: metadata (RFC 8414), dynamic client
 *     registration, `/authorize` that approves at once and redirects back
 *     with a code, `/token` (authorization code + refresh token).
 *
 * The test provisions the stack through the admin API (default `admin` /
 * `password123`, see CLAUDE.md): the SSRF allowlist entry for the stub, the
 * model, the MCP installation (`auth.mode: oauth-user`) and an app bound to
 * it, and removes them in `afterAll`. It rewrites configuration, so it is
 * opt-in: run it against a throwaway instance with
 * `CONNECT_E2E=1 CONTENTS_DIR=/tmp/ihub-e2e npx playwright test --config
 * tests/config/playwright.config.js tests/e2e/integration-connect.spec.js --project=chromium`.
 * Set `PW_CHROMIUM_PATH` when the environment's Chromium is not Playwright's.
 */

/** The deployment's path prefix (`/ihub`), empty at the root. */
const BASE = (process.env.CONNECT_E2E_BASE || '').replace(/\/$/, '');
const STUB_PORT = Number(process.env.CONNECT_E2E_STUB_PORT || 4178);
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const ACCOUNT = 'ada@example.com';
const QUESTION = 'Who am I in the directory?';
const ADMIN = {
  username: process.env.E2E_ADMIN_USER || 'admin',
  password: process.env.E2E_ADMIN_PASSWORD || 'password123'
};
const INSTALLATION_ID = 'e2e-directory';
const APP_ID = 'e2e-connect';
/** The same app with tool approval on: every call asks first. */
const APPROVAL_APP_ID = 'e2e-connect-approval';
const MODEL = {
  id: 'e2e-connect-chat',
  modelId: 'e2e-connect-chat-model',
  name: { en: 'E2E connect chat', de: 'E2E connect chat' },
  description: { en: 'Connect flow E2E stub', de: 'Connect flow E2E stub' },
  url: `${STUB}/v1/chat/completions`,
  provider: 'local',
  modelType: 'chat',
  contextWindow: 32000,
  maxOutputTokens: 4000,
  supportsTools: 'auto',
  enabled: true,
  default: false,
  autoDiscovery: false
};

// ───────────────────────── the stub vendor ─────────────────────────

/** What the stub saw and how it behaves; the tests flip `rejectTokens`. */
const vendor = {
  codes: new Map(),
  tokens: new Set(),
  refreshTokens: new Set(),
  rejectTokens: false,
  authorizeRequests: [],
  denyConsent: false,
  toolCalls: 0,
  /** What the model was sent: the user messages of every request, in order. */
  modelRequests: []
};

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** One SSE chat completion: a tool call, or text. */
function streamCompletion(res, { toolCall, text }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = delta =>
    res.write(
      `data: ${JSON.stringify({
        id: 'cmpl-e2e',
        object: 'chat.completion.chunk',
        model: MODEL.modelId,
        choices: [{ index: 0, delta, finish_reason: null }]
      })}\n\n`
    );
  if (toolCall) {
    chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call_${crypto.randomUUID().slice(0, 8)}`,
          type: 'function',
          function: { name: toolCall, arguments: '{}' }
        }
      ]
    });
  } else {
    chunk({ role: 'assistant', content: text });
  }
  res.write(
    `data: ${JSON.stringify({
      id: 'cmpl-e2e',
      object: 'chat.completion.chunk',
      model: MODEL.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }]
    })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * The model: a turn whose last message is from the user calls `whoami`; a
 * turn that got the tool's result answers with it.
 */
function answerChat(body, res) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  vendor.modelRequests.push(
    messages.filter(m => m.role === 'user').map(m => String(m.content || ''))
  );
  const last = messages[messages.length - 1];
  const tool = (body.tools || []).find(t => /whoami/.test(t.function?.name || ''));
  if (last?.role === 'tool') {
    const result = String(last.content || '');
    const text = result.includes(ACCOUNT)
      ? `You are signed in as ${ACCOUNT}.`
      : 'You have to connect the directory first.';
    streamCompletion(res, { text });
    return;
  }
  if (tool) {
    streamCompletion(res, { toolCall: tool.function.name });
    return;
  }
  streamCompletion(res, { text: 'No directory tool is available.' });
}

/** A minimal MCP server over Streamable HTTP with JSON responses. */
function answerMcp(message, res) {
  const reply = result => json(res, 200, { jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-directory', version: '1.0.0' }
      });
    case 'tools/list':
      return reply({
        tools: [
          {
            name: 'whoami',
            description: 'The signed-in account in the directory',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true }
          }
        ]
      });
    case 'tools/call':
      vendor.toolCalls += 1;
      return reply({ content: [{ type: 'text', text: `You are ${ACCOUNT}` }] });
    default:
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return undefined;
      }
      return reply({});
  }
}

function startStub() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, STUB);
    const raw = await readBody(req);
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return answerChat(JSON.parse(raw || '{}'), res);
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource: `${STUB}/mcp`, authorization_servers: [STUB] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: STUB,
        authorization_endpoint: `${STUB}/authorize`,
        token_endpoint: `${STUB}/token`,
        registration_endpoint: `${STUB}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const metadata = JSON.parse(raw || '{}');
      return json(res, 201, { ...metadata, client_id: 'e2e-client' });
    }
    if (url.pathname === '/authorize') {
      // Consent: approved at once (or denied, for the run that cancels it).
      vendor.authorizeRequests.push(Object.fromEntries(url.searchParams));
      if (vendor.denyConsent) {
        const denied = new URL(url.searchParams.get('redirect_uri'));
        denied.searchParams.set('error', 'access_denied');
        denied.searchParams.set('state', url.searchParams.get('state'));
        res.writeHead(302, { Location: denied.toString() });
        res.end();
        return undefined;
      }
      const code = crypto.randomUUID();
      vendor.codes.set(code, url.searchParams.get('code_challenge'));
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const params = new URLSearchParams(raw);
      const grant = params.get('grant_type');
      const known =
        grant === 'authorization_code'
          ? vendor.codes.delete(params.get('code'))
          : !vendor.rejectTokens && vendor.refreshTokens.has(params.get('refresh_token'));
      if (!known) return json(res, 400, { error: 'invalid_grant' });
      const accessToken = crypto.randomUUID();
      const refreshToken = crypto.randomUUID();
      vendor.tokens.add(accessToken);
      vendor.refreshTokens.add(refreshToken);
      return json(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'directory.read'
      });
    }
    if (url.pathname === '/mcp') {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      // The shared tool catalog is public (it is what a per-user server lists
      // before anyone connected); calling a tool needs a user's token.
      const method = req.method === 'POST' ? JSON.parse(raw || '{}').method : '';
      const publicCall =
        method === 'initialize' ||
        method === 'tools/list' ||
        String(method).startsWith('notifications/');
      if (!publicCall && (!bearer || vendor.rejectTokens || !vendor.tokens.has(bearer))) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${STUB}/.well-known/oauth-protected-resource/mcp"`
        });
        res.end();
        return undefined;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return undefined;
      }
      return answerMcp(JSON.parse(raw || '{}'), res);
    }
    res.writeHead(404);
    res.end('not found');
    return undefined;
  });
  return new Promise(resolve => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

// ───────────────────────── fixtures ─────────────────────────

test.use({
  launchOptions: process.env.PW_CHROMIUM_PATH
    ? { executablePath: process.env.PW_CHROMIUM_PATH }
    : {},
  // Screenshots a person will look at are taken at twice the pixel density.
  ...(process.env.CONNECT_E2E_SHOTS ? { deviceScaleFactor: 2 } : {})
});

/** `CONNECT_E2E_SHOTS=<dir>` keeps a screenshot of the key states there; otherwise nothing. */
async function shot(page, name) {
  const dir = process.env.CONNECT_E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}
test.describe.configure({ mode: 'serial' });

let stubServer = null;
let api = null;
let originalSsrf = null;

/**
 * A per-user server offers its tools only from its shared catalog, and the
 * catalog is stored from an authenticated listing. So connect once as the
 * admin (the same user the runs sign in as), wait for the catalog, and
 * disconnect: from then on the installation lists `whoami` while nobody is
 * connected, as it does on a real installation after the first user connected.
 */
async function primeCatalog() {
  const started = await api.post(`${BASE}/api/integrations/${INSTALLATION_ID}/_connect`, {
    data: { returnUrl: `${BASE}/` }
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  const { url } = await started.json();
  // Consent (approved at once) and the callback, redirects followed.
  const consent = await api.get(url);
  expect(consent.ok(), `consent and callback: ${consent.status()}`).toBeTruthy();
  await expect
    .poll(
      async () => {
        const res = await api.get(`${BASE}/api/integrations/${INSTALLATION_ID}`);
        const body = res.ok() ? await res.json() : null;
        return body?.actions?.length ?? 0;
      },
      { timeout: 30_000, message: 'the shared tool catalog is stored after the first connect' }
    )
    .toBeGreaterThan(0);
  await disconnect();
}

/** The admin (and the browser, same user) starts every run not connected. */
async function disconnect() {
  const res = await api.post(`${BASE}/api/integrations/${INSTALLATION_ID}/_disconnect`, {
    data: {}
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.beforeAll(async () => {
  test.skip(
    !process.env.CONNECT_E2E,
    'The connect flow E2E rewrites config: run it with CONNECT_E2E=1 on a throwaway instance'
  );
  test.skip(
    test.info().project.name !== 'chromium',
    'The connect flow E2E runs in the desktop Chromium project only'
  );
  test.setTimeout(150_000);
  stubServer = await startStub();
  const baseURL = test.info().project.use.baseURL || 'http://localhost:5173';
  api = await playwrightRequest.newContext({ baseURL });
  await expect
    .poll(async () => (await api.get(`${BASE}/api/health`).catch(() => null))?.status() ?? 0, {
      timeout: 90_000,
      message: 'the iHub server answers /api/health'
    })
    .toBe(200);
  const login = await api.post(`${BASE}/api/auth/local/login`, { data: ADMIN });
  expect(login.ok(), 'admin login (default admin / password123)').toBeTruthy();

  // The stub runs on 127.0.0.1: the SSRF guard has to let iHub reach it.
  originalSsrf = await (await api.get(`${BASE}/api/admin/ssrf/config`)).json();
  const ssrf = await api.put(`${BASE}/api/admin/ssrf/config`, {
    data: { allowedHosts: [...(originalSsrf.allowedHosts || []), '127.0.0.1'] }
  });
  expect(ssrf.ok(), await ssrf.text()).toBeTruthy();

  const model = await api.put(`${BASE}/api/admin/models/${MODEL.id}`, { data: MODEL });
  expect(model.ok(), await model.text()).toBeTruthy();

  const installed = await api.post(`${BASE}/api/admin/integrations/installed`, {
    data: {
      id: INSTALLATION_ID,
      definition: 'com.intrafind/mcp-server',
      label: { en: 'E2E directory' },
      enabled: true,
      values: { transport: 'streamableHttp', url: `${STUB}/mcp` },
      auth: { mode: 'oauth-user' }
    }
  });
  expect(installed.ok(), await installed.text()).toBeTruthy();

  // The MCP manager loads the installation asynchronously; until it has, the
  // user API shows it without a sign-in and its catalog is empty.
  await expect
    .poll(
      async () => {
        const res = await api.get(`${BASE}/api/integrations/${INSTALLATION_ID}`);
        const body = res.ok() ? await res.json() : null;
        return Boolean(body?.connection?.connectable);
      },
      { timeout: 60_000, message: 'the server shows the MCP installation as connectable' }
    )
    .toBe(true);

  await primeCatalog();

  const app = await api.post(`${BASE}/api/admin/apps`, {
    data: {
      id: APP_ID,
      name: { en: 'E2E connect' },
      description: { en: 'Connect flow end to end' },
      color: '#4F46E5',
      icon: 'link',
      system: { en: 'Use the directory tool to answer.' },
      preferredModel: MODEL.id,
      enabled: true,
      integrations: { [INSTALLATION_ID]: {} }
    }
  });
  expect(app.ok(), await app.text()).toBeTruthy();

  // The same app, with every tool call asking a person first.
  const approvalApp = await api.post(`${BASE}/api/admin/apps`, {
    data: {
      id: APPROVAL_APP_ID,
      name: { en: 'E2E connect approval' },
      description: { en: 'Connect flow with tool approval' },
      color: '#4F46E5',
      icon: 'link',
      system: { en: 'Use the directory tool to answer.' },
      preferredModel: MODEL.id,
      enabled: true,
      integrations: { [INSTALLATION_ID]: {} },
      toolApproval: { default: 'always' }
    }
  });
  expect(approvalApp.ok(), await approvalApp.text()).toBeTruthy();
});

test.afterAll(async () => {
  if (api) {
    await api
      .post(`/api/integrations/${INSTALLATION_ID}/_disconnect`, { data: {} })
      .catch(() => {});
    await api.delete(`${BASE}/api/admin/apps/${APP_ID}`).catch(() => {});
    await api.delete(`${BASE}/api/admin/apps/${APPROVAL_APP_ID}`).catch(() => {});
    await api.delete(`${BASE}/api/admin/integrations/installed/${INSTALLATION_ID}`).catch(() => {});
    await api.delete(`${BASE}/api/admin/models/${MODEL.id}`).catch(() => {});
    if (originalSsrf) {
      await api.put(`${BASE}/api/admin/ssrf/config`, { data: originalSsrf }).catch(() => {});
    }
    await api.dispose();
  }
  await new Promise(resolve => (stubServer ? stubServer.close(resolve) : resolve()));
});

/** Sign the browser in as the admin (the API context's cookie). */
async function signIn(context) {
  await context.addCookies((await api.storageState()).cookies);
  // The first-visit disclaimer would sit over every click.
  await context.addInitScript(() => {
    window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
  });
}

/** The visible chat; the live region next to it repeats every message for screen readers. */
function chatLog(page) {
  return page.getByRole('log', { name: 'Chat messages' });
}

/**
 * Opens the app and sends the question once the chat knows its model: the
 * context counter shows the model's window. Sent earlier, the request goes out
 * without a `modelId` and the server answers 400.
 */
async function askQuestion(page, appId = APP_ID) {
  const modelsLoaded = page.waitForResponse(
    r => new URL(r.url()).pathname.endsWith('/api/models') && r.ok()
  );
  await page.goto(`${BASE}/apps/${appId}`);
  await modelsLoaded;
  await page.waitForLoadState('networkidle');
  await page.getByRole('textbox').first().fill(QUESTION);
  await page.keyboard.press('Enter');
}

// ───────────────────────── the runs ─────────────────────────

// `test.setTimeout` in `beforeAll` only covers the hook; the runs need room too.
test.describe.configure({ timeout: 150_000 });

test('not connected → Connect → consent → back in the same chat → answer', async ({
  page,
  context
}) => {
  await signIn(context);
  await disconnect();
  await askQuestion(page);

  const card = page.getByRole('region', { name: /Connect E2E directory/ });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('iHub needs to act as you in E2E directory');
  await shot(page, '1-card-asking-light');

  // The card in its "not connected" state meets WCAG 2.2 AA (the tags of
  // accessibility.spec.js): no axe violation inside the card, and the buttons
  // are reachable by keyboard with a visible name.
  await card.evaluate(element => element.setAttribute('data-e2e-connect-card', ''));
  const axe = await new AxeBuilder({ page })
    .include('[data-e2e-connect-card]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze();
  expect(
    axe.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
  // Dark mode follows the system preference; contrast is where it usually breaks.
  await page.emulateMedia({ colorScheme: 'dark' });
  // Colors transition; scanning mid-way measures blended in-between values.
  await page.waitForTimeout(800);
  const axeDark = await new AxeBuilder({ page })
    .include('[data-e2e-connect-card]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze();
  expect(
    axeDark.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
  await shot(page, '2-card-asking-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await card.getByRole('button', { name: /Connect/ }).focus();
  await expect(card.getByRole('button', { name: /Connect/ })).toBeFocused();
  const chatUrl = page.url();

  await card.getByRole('button', { name: /Connect/ }).click();
  // The stub approves at once; the callback sends the browser back to the chat.
  await page.waitForURL(url => url.pathname === new URL(chatUrl).pathname, { timeout: 60_000 });
  expect(vendor.authorizeRequests.at(-1)?.code_challenge_method).toBe('S256');
  // The result parameters are removed from the URL once the page has mounted.
  await expect.poll(() => page.url()).not.toContain('integration_connected');

  // The server continued the stored call: the answer appears with no message
  // of the user's own in between, and the vendor was called once.
  await expect(chatLog(page).getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible({
    timeout: 60_000
  });
  await expect(chatLog(page).getByText(/I connected E2E directory/)).toHaveCount(0);
  await shot(page, '3-after-connect-answer');
  expect(vendor.toolCalls).toBe(1);
  // The model saw the question once: call, explanation, continuation.
  expect(vendor.modelRequests.length).toBeGreaterThanOrEqual(3);
  expect(vendor.modelRequests.flat().filter(text => /connected/i.test(text))).toEqual([]);

  // The stored chat: one question, the explanation and the continuation.
  const chatId = new URL(chatUrl).pathname.split('/').pop();
  const stored = await (await api.get(`${BASE}/api/chats/${chatId}`)).json();
  expect(stored.messages.map(m => m.role)).toEqual(['user', 'assistant', 'assistant']);
  expect(stored.chat.pendingConnect ?? null).toBeNull();

  // A reload does not run it again.
  await page.reload();
  await expect(chatLog(page).getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(vendor.toolCalls).toBe(1);
});

test('expired → Reconnect → back in the chat → answer', async ({ page, context }) => {
  await signIn(context);
  // The vendor revokes everything: the access token and the refresh token.
  vendor.rejectTokens = true;
  vendor.tokens.clear();
  vendor.refreshTokens.clear();

  await askQuestion(page);

  const card = page.getByRole('region', { name: /Reconnect E2E directory/ });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('expired or was revoked');

  vendor.rejectTokens = false;
  const calls = vendor.toolCalls;
  await card.getByRole('button', { name: /Reconnect/ }).click();
  await expect(chatLog(page).getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible({
    timeout: 60_000
  });
  expect(vendor.toolCalls).toBe(calls + 1);
  await expect(chatLog(page).getByText(/I connected E2E directory/)).toHaveCount(0);
});

test('cancelled consent → nothing runs and the card stays', async ({ page, context }) => {
  await signIn(context);
  await disconnect();
  vendor.denyConsent = true;
  try {
    await askQuestion(page);
    const card = page.getByRole('region', { name: /Connect E2E directory/ });
    await expect(card).toBeVisible({ timeout: 60_000 });
    const calls = vendor.toolCalls;
    const chatPath = new URL(page.url()).pathname;
    await card.getByRole('button', { name: /Connect/ }).click();
    await page.waitForURL(url => url.pathname === chatPath, { timeout: 60_000 });
    // The sign-in says it did not succeed; the card is still there to try again.
    await expect(
      page.getByRole('alert').filter({ hasText: /not connected because access was not granted/i })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('region', { name: /Connect E2E directory/ }).getByRole('button', {
        name: /Connect/
      })
    ).toBeVisible();
    await page.waitForTimeout(1500);
    expect(vendor.toolCalls).toBe(calls);
  } finally {
    vendor.denyConsent = false;
  }
});

test('a call that needs approval asks again after the connect; it does not run', async ({
  page,
  context
}) => {
  await signIn(context);
  await disconnect();
  await askQuestion(page, APPROVAL_APP_ID);

  // The first ask: the policy gate, before the call reaches the connection check.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
    timeout: 60_000
  });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const card = page.getByRole('region', { name: /Connect E2E directory/ });
  await expect(card).toBeVisible({ timeout: 60_000 });

  const calls = vendor.toolCalls;
  const chatPath = new URL(page.url()).pathname;
  await card.getByRole('button', { name: /Connect/ }).click();
  await page.waitForURL(url => url.pathname === chatPath, { timeout: 60_000 });

  // The connect continued the stored call, which asks again: nothing ran.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
    timeout: 60_000
  });
  await shot(page, '4-approval-after-connect');
  await page.waitForTimeout(1500);
  expect(vendor.toolCalls).toBe(calls);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(chatLog(page).getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible({
    timeout: 60_000
  });
  expect(vendor.toolCalls).toBe(calls + 1);
});

test('a second request for the same stored call runs nothing', async ({ page, context }) => {
  await signIn(context);
  await disconnect();
  await askQuestion(page);
  await expect(page.getByRole('region', { name: /Connect E2E directory/ })).toBeVisible({
    timeout: 60_000
  });
  const chatId = new URL(page.url()).pathname.split('/').pop();
  const record = (await (await api.get(`${BASE}/api/chats/${chatId}`)).json()).chat.pendingConnect;
  expect(record.integrations).toEqual([INSTALLATION_ID]);
  // The record never carries the arguments or the transcript to the client.
  expect(Object.keys(record).sort()).toEqual(['callIds', 'expiresAt', 'id', 'integrations']);

  // Not connected yet: the server refuses and keeps the record.
  const resume = () =>
    api.post(`${BASE}/api/apps/${APP_ID}/chat/${chatId}`, {
      data: {
        messages: [
          { role: 'user', content: '', messageId: 'msg-resume', connectResume: { id: record.id } }
        ],
        modelId: MODEL.id,
        language: 'en'
      }
    });
  const early = await resume();
  expect(early.status()).toBe(409);
  expect((await early.json()).code).toBe('CONNECT_RESUME_NOT_CONNECTED');

  // Connect (as the browser would), then two requests at once: one runs it.
  const started = await api.post(`${BASE}/api/integrations/${INSTALLATION_ID}/_connect`, {
    data: { returnUrl: `${BASE}/` }
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  expect((await api.get((await started.json()).url)).ok()).toBeTruthy();
  const calls = vendor.toolCalls;
  const [a, b] = await Promise.all([resume(), resume()]);
  const statuses = [a.status(), b.status()].sort();
  expect(statuses).toEqual([200, 409]);
  const refused = a.status() === 409 ? a : b;
  expect((await refused.json()).code).toBe('CONNECT_RESUME_NOT_PENDING');
  await expect
    .poll(() => vendor.toolCalls, { timeout: 60_000, message: 'the stored call ran' })
    .toBe(calls + 1);
  await page.waitForTimeout(2000);
  expect(vendor.toolCalls).toBe(calls + 1);
  // A third request, after the run: nothing is pending any more.
  const late = await resume();
  expect(late.status()).toBe(409);
  expect((await late.json()).code).toBe('CONNECT_RESUME_NOT_PENDING');
  expect(vendor.toolCalls).toBe(calls + 1);
});

// #2923: the same flow started from the chat's integrations picker.
test('picker → Connect → consent in a new tab → back in the same chat → row on → answer', async ({
  page,
  context
}) => {
  await signIn(context);
  // Start disconnected.
  const disconnected = await api.post(`${BASE}/api/integrations/${INSTALLATION_ID}/_disconnect`, {
    data: {}
  });
  expect(disconnected.ok(), await disconnected.text()).toBeTruthy();

  await page.goto(`${BASE}/apps/${APP_ID}`);
  await page.getByRole('button', { name: 'Actions menu' }).first().click();
  const row = page.getByRole('menu').getByRole('menuitem', { name: /E2E directory/ });
  await expect(row).toContainText('Connect →');
  const chatPath = new URL(page.url()).pathname;

  // The consent opens in a new tab and comes back to the same chat there.
  const [consent] = await Promise.all([context.waitForEvent('page'), row.click()]);
  await consent.waitForURL(url => url.pathname === chatPath, { timeout: 60_000 });
  // The returning tab tells the other tabs (BroadcastChannel) once its picker
  // has read the result; closing it earlier would cut that short. The row is
  // on in that tab too.
  await consent.waitForLoadState('networkidle');
  await consent.getByRole('button', { name: 'Actions menu' }).first().click();
  await expect(
    consent.getByRole('menu').getByRole('menuitemcheckbox', { name: /E2E directory/ })
  ).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  await consent.close();

  // Back in the first tab: the row is on in this chat.
  await page.bringToFront();
  // Connect leaves the menu open; open it only when it is closed.
  const trigger = page.getByRole('button', { name: 'Actions menu' }).first();
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(
    page.getByRole('menu').getByRole('menuitemcheckbox', { name: /E2E directory/ })
  ).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  await page.keyboard.press('Escape');

  const calls = vendor.toolCalls;
  await page.getByRole('textbox').first().fill(QUESTION);
  await page.keyboard.press('Enter');
  await expect(chatLog(page).getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible({
    timeout: 60_000
  });
  expect(vendor.toolCalls).toBe(calls + 1);
});
