// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect, request as playwrightRequest } from '@playwright/test';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * The one connect flow end to end (#2917, #2923), with a per-user MCP server:
 *
 *   1. not connected → the chat shows the Connect card → Connect → consent
 *      (the stub authorization server approves at once) → back in the same
 *      chat → the request is retried once → the answer names the account;
 *   2. expired → the card says Reconnect → Reconnect → back in the chat → answer;
 *   3. from the chat's integrations picker: `Connect →` → consent in a new tab →
 *      back in the same chat → the row is on → the tool call succeeds.
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
const MODEL = {
  id: 'e2e-connect-chat',
  modelId: 'e2e-connect-chat-model',
  name: { en: 'E2E connect chat', de: 'E2E connect chat' },
  description: { en: 'Connect flow E2E stub', de: 'Connect flow E2E stub' },
  url: `${STUB}/v1/chat/completions`,
  provider: 'local',
  contextWindow: 32000,
  maxOutputTokens: 4000,
  supportsTools: true,
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
  toolCalls: 0
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
      // Consent: approved at once.
      vendor.authorizeRequests.push(Object.fromEntries(url.searchParams));
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
      if (!bearer || vendor.rejectTokens || !vendor.tokens.has(bearer)) {
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
    : {}
});
test.describe.configure({ mode: 'serial' });

let stubServer = null;
let api = null;
let originalSsrf = null;

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
    .poll(async () => (await api.get('/api/health').catch(() => null))?.status() ?? 0, {
      timeout: 90_000,
      message: 'the iHub server answers /api/health'
    })
    .toBe(200);
  const login = await api.post('/api/auth/local/login', { data: ADMIN });
  expect(login.ok(), 'admin login (default admin / password123)').toBeTruthy();

  // The stub runs on 127.0.0.1: the SSRF guard has to let iHub reach it.
  originalSsrf = await (await api.get('/api/admin/ssrf/config')).json();
  const ssrf = await api.put('/api/admin/ssrf/config', {
    data: { allowedHosts: [...(originalSsrf.allowedHosts || []), '127.0.0.1'] }
  });
  expect(ssrf.ok(), await ssrf.text()).toBeTruthy();

  const model = await api.put(`/api/admin/models/${MODEL.id}`, { data: MODEL });
  expect(model.ok(), await model.text()).toBeTruthy();

  const installed = await api.post('/api/admin/integrations/installed', {
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

  const app = await api.put(`/api/admin/apps/${APP_ID}`, {
    data: {
      id: APP_ID,
      name: { en: 'E2E connect' },
      description: { en: 'Connect flow end to end' },
      color: '#4F46E5',
      icon: 'link',
      system: { en: 'Use the directory tool to answer.' },
      tokenLimit: 4000,
      preferredModel: MODEL.id,
      enabled: true,
      integrations: { [INSTALLATION_ID]: {} }
    }
  });
  expect(app.ok(), await app.text()).toBeTruthy();
});

test.afterAll(async () => {
  if (api) {
    await api.post(`/api/integrations/${INSTALLATION_ID}/disconnect`, { data: {} }).catch(() => {});
    await api.delete(`/api/admin/apps/${APP_ID}`).catch(() => {});
    await api.delete(`/api/admin/integrations/installed/${INSTALLATION_ID}`).catch(() => {});
    await api.delete(`/api/admin/models/${MODEL.id}`).catch(() => {});
    if (originalSsrf) {
      await api.put('/api/admin/ssrf/config', { data: originalSsrf }).catch(() => {});
    }
    await api.dispose();
  }
  await new Promise(resolve => (stubServer ? stubServer.close(resolve) : resolve()));
});

/** Sign the browser in as the admin (the API context's cookie). */
async function signIn(context) {
  await context.addCookies((await api.storageState()).cookies);
}

// ───────────────────────── the runs ─────────────────────────

test('not connected → Connect → consent → back in the same chat → answer', async ({
  page,
  context
}) => {
  await signIn(context);
  await page.goto(`/apps/${APP_ID}`);
  await page.getByRole('textbox').first().fill(QUESTION);
  await page.keyboard.press('Enter');

  const card = page.getByRole('region', { name: /Connect E2E directory/ });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('iHub needs to act as you in E2E directory');
  const chatUrl = page.url();

  await card.getByRole('button', { name: /Connect/ }).click();
  // The stub approves at once; the callback sends the browser back to the chat.
  await page.waitForURL(url => url.pathname === new URL(chatUrl).pathname, { timeout: 60_000 });
  expect(vendor.authorizeRequests.at(-1)?.code_challenge_method).toBe('S256');
  expect(page.url()).not.toContain('integration_connected');

  // Retried once, automatically: the follow-up and the answer.
  await expect(page.getByText(/I connected E2E directory/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible({
    timeout: 60_000
  });
  expect(vendor.toolCalls).toBe(1);

  // A reload does not retry again.
  await page.reload();
  await expect(page.getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(vendor.toolCalls).toBe(1);
});

test('expired → Reconnect → back in the chat → answer', async ({ page, context }) => {
  await signIn(context);
  // The vendor revokes everything: the access token and the refresh token.
  vendor.rejectTokens = true;
  vendor.tokens.clear();
  vendor.refreshTokens.clear();

  await page.goto(`/apps/${APP_ID}`);
  await page.getByRole('textbox').first().fill(QUESTION);
  await page.keyboard.press('Enter');

  const card = page.getByRole('region', { name: /Reconnect E2E directory/ });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('expired or was revoked');

  vendor.rejectTokens = false;
  const calls = vendor.toolCalls;
  await card.getByRole('button', { name: /Reconnect/ }).click();
  await expect(page.getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible({
    timeout: 60_000
  });
  expect(vendor.toolCalls).toBe(calls + 1);
});

// #2923: the same flow started from the chat's integrations picker.
test('picker → Connect → consent in a new tab → back in the same chat → row on → answer', async ({
  page,
  context
}) => {
  await signIn(context);
  // Start disconnected.
  const disconnected = await api.post(`/api/integrations/${INSTALLATION_ID}/disconnect`, {
    data: {}
  });
  expect(disconnected.ok(), await disconnected.text()).toBeTruthy();

  await page.goto(`/apps/${APP_ID}`);
  await page.getByRole('button', { name: 'Actions menu' }).first().click();
  const row = page.getByRole('menu').getByRole('menuitem', { name: /E2E directory/ });
  await expect(row).toContainText('Connect →');
  const chatPath = new URL(page.url()).pathname;

  // The consent opens in a new tab and comes back to the same chat there.
  const [consent] = await Promise.all([context.waitForEvent('page'), row.click()]);
  await consent.waitForURL(url => url.pathname === chatPath, { timeout: 60_000 });
  await consent.close();

  // Back in the first tab: the row is on in this chat.
  await page.bringToFront();
  await page.getByRole('button', { name: 'Actions menu' }).first().click();
  await expect(
    page.getByRole('menu').getByRole('menuitemcheckbox', { name: /E2E directory/ })
  ).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  await page.keyboard.press('Escape');

  const calls = vendor.toolCalls;
  await page.getByRole('textbox').first().fill(QUESTION);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`You are signed in as ${ACCOUNT}.`)).toBeVisible({
    timeout: 60_000
  });
  expect(vendor.toolCalls).toBe(calls + 1);
});
