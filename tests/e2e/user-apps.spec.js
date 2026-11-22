// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { ADMIN, BUILDER, NORMAL_USER } from '../config/app-builder-seed.mjs';
import { startLlmStub } from '../config/e2e-llm-stub.mjs';

/**
 * End-to-end: personal apps (concepts/app-builder-rework-2026-11/02-personal-apps.md,
 * section 14.4). A user without any admin right builds an app, shares it, hands
 * it over and publishes it; the people it is shared with see who owns it and
 * are asked before the app reaches out for them. The numbers in the test titles
 * are the case numbers of the plan.
 *
 * Runs only through the app builder config (`npm run test:e2e:app-builder`,
 * tests/config/playwright.app-builder.config.js), after `app-builder.spec.js`:
 * its own server and contents directory, one worker, the model stub. The spec
 * switches the feature `userApps` on for its run and off again, and three cases
 * change the group `authenticated` or `anonymous` and put it back in `finally`.
 *
 * People:
 *   the owner  - the account `user` of a fresh install ("Demo User"), group `users`
 *   Ben, Cleo  - created here, in a group that grants nothing itself: what they
 *                may use comes from the group `authenticated`, which the cases
 *                about web search and about the app wildcard narrow
 *   the content admin - `builder` of the app builder seed
 *
 * Every app here has a name that starts with `E2E UA`; the personal apps and
 * the company apps that came from them are removed after each test.
 */

const NAME_PREFIX = 'E2E UA';
const here = path.dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(
  fs.readFileSync(path.join(here, '..', '..', 'shared', 'i18n', 'en.json'), 'utf8')
);

/**
 * An English text of the UI, as shipped.
 *
 * @param {string} key - e.g. `userApps.notice.ownedBy`
 * @param {Record<string, string|number>} [values] - Interpolation values; `count` picks the plural
 * @returns {string}
 */
function tr(key, values = {}) {
  const read = name => name.split('.').reduce((node, part) => node?.[part], EN);
  let text = read(key);
  if (typeof text !== 'string' && values.count !== undefined) {
    text = read(`${key}_${values.count === 1 ? 'one' : 'other'}`);
  }
  if (typeof text !== 'string') throw new Error(`No English text for the key ${key}`);
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => String(values[name] ?? ''));
}

const OWNER_NAME = 'Demo User';
const MEMBER_GROUP = Object.freeze({
  id: 'e2e-ua-members',
  name: 'E2E UA members',
  description: 'Personal apps e2e suite: grants personal apps and nothing else',
  inherits: ['authenticated'],
  permissions: {
    apps: [],
    prompts: [],
    models: [],
    skills: [],
    workflows: [],
    integrations: [],
    adminAccess: false,
    userApps: true,
    userAppSharing: true
  },
  mappings: []
});
const BEN = Object.freeze({
  username: 'e2e-ua-ben',
  password: 'ben-e2e-pass-1',
  name: 'Ben Koch',
  email: 'ben.koch@example.com'
});
const CLEO = Object.freeze({
  username: 'e2e-ua-cleo',
  password: 'cleo-e2e-pass-1',
  name: 'Cleo Maier',
  email: 'cleo.maier@example.com'
});

/** A model that calls tools, served by a stub this spec starts (case 5). */
const TOOL_MODEL_ID = 'e2e-ua-tool-model';
const TOOL_STUB_PORT =
  Number(new URL(process.env.E2E_APP_BUILDER_LLM_URL || 'http://127.0.0.1:8985').port) + 400;
/** The page the scripted model asks to read. */
const PAGE_URL = 'https://example.com/e2e-ua-page';

/**
 * The scripted model of case 5: asked with the page reader among its tools, it
 * calls it once for {@link PAGE_URL}; with the tool's answer in the
 * conversation, or without the tool, it answers in words.
 */
function toolModelScript(body) {
  const messages = body.messages || [];
  if (messages.some(message => message.role === 'tool')) {
    return { content: 'E2E UA read the page.' };
  }
  const reader = (body.tools || []).find(tool => /read_url/.test(tool.function?.name || ''));
  if (!reader) return { content: 'E2E UA answer without tools.' };
  return {
    content: '',
    toolCalls: [
      {
        id: 'call_e2e_ua_1',
        name: reader.function.name,
        arguments: JSON.stringify({ url: PAGE_URL })
      }
    ]
  };
}

/**
 * @param {import('@playwright/test').APIResponse} response
 * @param {string} what - Named in the failure
 * @param {number[]} [accepted] - Statuses besides 2xx that are fine
 */
async function expectOk(response, what, accepted = []) {
  if (response.ok() || accepted.includes(response.status())) return;
  throw new Error(`${what}: HTTP ${response.status()} ${(await response.text()).slice(0, 400)}`);
}

async function apiAs(playwright, baseURL, { username, password }) {
  const api = await playwright.request.newContext({ baseURL });
  await expectOk(
    await api.post('/api/auth/local/login', { data: { username, password } }),
    `sign in as ${username}`
  );
  return api;
}

/**
 * A browser window of one person: its own cookies, signed in, the first-run
 * disclaimer acknowledged.
 *
 * @returns {Promise<{page: import('@playwright/test').Page, api: import('@playwright/test').APIRequestContext}>}
 */
async function windowOf(browser, baseURL, account) {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
  });
  await expectOk(
    await context.request.post('/api/auth/local/login', {
      data: { username: account.username, password: account.password }
    }),
    `sign in as ${account.username}`
  );
  return { page: await context.newPage(), api: context.request, context };
}

/** What the server told the suite about the people it created. */
const people = { ownerId: null, benId: null, cleoId: null };

const test = base.extend({
  adminApi: async ({ playwright, baseURL }, use) => {
    const api = await apiAs(playwright, baseURL, ADMIN);
    await use(api);
    await api.dispose();
  },
  /** The owner's window. */
  owner: async ({ browser, baseURL }, use) => {
    const session = await windowOf(browser, baseURL, NORMAL_USER);
    await use(session);
    await session.context.close();
  },
  ben: async ({ browser, baseURL }, use) => {
    const session = await windowOf(browser, baseURL, BEN);
    await use(session);
    await session.context.close();
  },
  cleo: async ({ browser, baseURL }, use) => {
    const session = await windowOf(browser, baseURL, CLEO);
    await use(session);
    await session.context.close();
  }
});

test.skip(
  process.env.E2E_APP_BUILDER !== '1',
  'Switches a feature and changes groups of its server: runs only through npm run test:e2e:app-builder'
);

let toolStub = null;

/**
 * The search engine the cases about web search need. A fresh install has none
 * unless the environment holds a key (`STAAN_API_KEY`, `BRAVE_SEARCH_API_KEY`),
 * and CI holds none: without an engine nobody may use web search, and creating
 * an app that asks for it answers 403. Qwant needs no key. No case sends a
 * search: the scripted model only reads a page.
 */
const SEARCH_ENGINE = Object.freeze({ id: 'qwant', definition: 'com.intrafind/qwant-search' });
/** Whether this run installed {@link SEARCH_ENGINE}, and so removes it again. */
let installedSearchEngine = false;

test.beforeAll(async ({ playwright, baseURL }) => {
  const admin = await apiAs(playwright, baseURL, ADMIN);
  try {
    await expectOk(
      await admin.put('/api/admin/features', { data: { userApps: true } }),
      'switching personal apps on'
    );
    // 409: there from an earlier run against a kept server.
    await expectOk(
      await admin.post('/api/admin/groups', { data: MEMBER_GROUP }),
      `creating the group ${MEMBER_GROUP.id}`,
      [409]
    );
    const listUsers = async () =>
      Object.values((await (await admin.get('/api/admin/auth/users')).json()).users || {});
    let users = await listUsers();
    for (const account of [BEN, CLEO]) {
      if (users.some(user => user.username === account.username)) continue;
      await expectOk(
        await admin.post('/api/admin/auth/users', {
          data: { ...account, internalGroups: [MEMBER_GROUP.id], active: true }
        }),
        `creating the user ${account.username}`
      );
    }
    users = await listUsers();
    const idOf = username => users.find(user => user.username === username)?.id;
    people.ownerId = idOf(NORMAL_USER.username);
    people.benId = idOf(BEN.username);
    people.cleoId = idOf(CLEO.username);
    expect(
      people.ownerId && people.benId && people.cleoId,
      'the three accounts exist'
    ).toBeTruthy();

    // 409: the engine is there already (a kept server, or a key in the environment).
    const engine = await admin.post('/api/admin/integrations/installed', { data: SEARCH_ENGINE });
    await expectOk(engine, `installing the search engine ${SEARCH_ENGINE.id}`, [409]);
    installedSearchEngine = engine.status() === 201;

    // A second model that calls tools; the model of the suite answers in words only.
    toolStub = await startLlmStub(TOOL_STUB_PORT, { script: toolModelScript });
    const stubModel = await (await admin.get('/api/admin/models/e2e-stub')).json();
    await expectOk(
      await admin.post('/api/admin/models', {
        data: {
          ...stubModel,
          id: TOOL_MODEL_ID,
          name: { en: 'E2E UA tool model' },
          url: `http://127.0.0.1:${TOOL_STUB_PORT}/v1/chat/completions`,
          supportsTools: 'auto',
          default: false
        }
      }),
      'creating the tool model',
      [409]
    );
  } finally {
    await admin.dispose();
  }
});

test.afterAll(async ({ playwright, baseURL }) => {
  const admin = await apiAs(playwright, baseURL, ADMIN);
  try {
    await admin.delete(`/api/admin/models/${TOOL_MODEL_ID}`);
    if (installedSearchEngine) {
      await admin.delete(`/api/admin/integrations/installed/${SEARCH_ENGINE.id}`);
    }
    await admin.put('/api/admin/user-apps/_settings', { data: DEFAULT_SETTINGS });
    await admin.put('/api/admin/features', { data: { userApps: false } });
  } finally {
    await admin.dispose();
    await new Promise(resolve => (toolStub ? toolStub.close(resolve) : resolve()));
  }
});

/** The settings of a fresh install that the cases change. */
const DEFAULT_SETTINGS = {
  sharing: { allowPublish: false },
  capabilities: { webSearch: false },
  publishing: { adminEnables: 'withTools' }
};

async function setSettings(adminApi, settings) {
  await expectOk(
    await adminApi.put('/api/admin/user-apps/_settings', { data: settings }),
    'changing the personal app settings'
  );
}

test.afterEach(async ({ adminApi }) => {
  // Personal apps of the suite, and the company apps that came from them.
  const listed = await (await adminApi.get('/api/admin/user-apps?limit=200')).json();
  for (const app of listed.items || []) {
    if (app.publishedAs?.appId) await adminApi.delete(`/api/admin/apps/${app.publishedAs.appId}`);
    await adminApi.delete(`/api/admin/user-apps/${app.id}`);
  }
  const apps = await (await adminApi.get('/api/admin/apps')).json();
  for (const app of Array.isArray(apps) ? apps : apps.items || []) {
    const name = typeof app.name === 'string' ? app.name : Object.values(app.name || {})[0];
    if (String(name || '').startsWith(NAME_PREFIX)) {
      await adminApi.delete(`/api/admin/apps/${app.id}`);
    }
  }
  await setSettings(adminApi, DEFAULT_SETTINGS);
});

/**
 * Create a personal app through the API, as the person `api` is signed in as.
 *
 * @returns {Promise<Object>} The app
 */
async function createApp(api, name, extra = {}) {
  const response = await api.post('/api/apps', {
    data: {
      language: 'en',
      origin: 'blank',
      name: { en: name },
      description: { en: `${name}: a personal app of the e2e suite.` },
      system: { en: `You are ${name}. Answer briefly.` },
      ...extra
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function share(api, appId, members) {
  await expectOk(
    await api.put(`/api/apps/${appId}/members`, { data: { members } }),
    `sharing ${appId}`
  );
}

const member = (id, role = 'user') => ({ type: 'user', id, role });

async function readApp(api, appId) {
  const response = await api.get(`/api/apps/${appId}`);
  return { status: response.status(), body: await response.json().catch(() => null) };
}

/** Send a message in the chat inside `scope` and wait for the stub's answer to it. */
async function expectChatAnswer(scope, message, answer = `E2E reply to: ${message}`) {
  const box = scope.locator('textarea.chat-input-textarea:visible');
  await expect(box).toBeEnabled();
  await box.fill(message);
  await box.press('Enter');
  await expect(scope.locator('p:visible', { hasText: answer }).last()).toBeVisible();
}

const testPanel = page => page.getByRole('complementary', { name: tr('admin.apps.test.title') });
const saveBar = page => page.getByRole('region', { name: tr('admin.ui.saveBar.label') });
const nameField = page =>
  page.getByRole('textbox', { name: tr('admin.apps.create.essentials.name') }).first();
/** The "More" menu of the personal editor's header. */
const openMore = page => page.locator('main button[aria-haspopup]').first().click();

/**
 * Records what must not happen on a cold load: a request the server refuses,
 * and an uncaught error.
 */
function watchPage(page) {
  const problems = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.includes('/api/') && response.status() >= 400) {
      problems.push(`${response.request().method()} ${url.pathname} answered ${response.status()}`);
    }
  });
  page.on('pageerror', error => problems.push(`uncaught: ${error.message}`));
  return problems;
}

test.describe('Personal apps', () => {
  test('0: with the feature off, the apps page offers nothing new and a personal address names no app', async ({
    owner,
    adminApi
  }) => {
    const app = await createApp(owner.api, `${NAME_PREFIX} Feature off`);
    await expectOk(
      await adminApi.put('/api/admin/features', { data: { userApps: false } }),
      'switching personal apps off'
    );
    try {
      await owner.page.goto('/apps');
      await expect(owner.page.getByRole('heading', { level: 1 })).toBeVisible();
      await owner.page.waitForLoadState('networkidle');
      await expect(owner.page.getByRole('radiogroup')).toHaveCount(0);
      await expect(owner.page.getByTestId('user-app-new')).toHaveCount(0);
      await expect(owner.page.getByTestId('user-app-badge')).toHaveCount(0);

      // The owner's own app answers as an address that names no app.
      const unknown = await owner.api.get(`/api/apps/uap_${'0'.repeat(32)}`);
      const own = await owner.api.get(`/api/apps/${app.id}`);
      expect(own.status()).toBe(404);
      expect(await own.text()).toBe(await unknown.text());
      const listed = await owner.api.get('/api/apps?scope=personal');
      expect(await listed.json()).toEqual({ items: [], nextCursor: null });
      const create = await owner.api.post('/api/apps', { data: { language: 'en' } });
      expect(create.status()).toBe(403);
      expect((await create.json()).code).toBe('USER_APPS_DISABLED');
      await owner.page.goto('/apps/new');
      await owner.page.waitForLoadState('networkidle');
      await expect(
        owner.page.getByRole('textbox', { name: tr('admin.apps.create.start.label') })
      ).toHaveCount(0);
    } finally {
      await expectOk(
        await adminApi.put('/api/admin/features', { data: { userApps: true } }),
        'switching personal apps on again'
      );
    }
    // The record was kept: switched on again, the app is back.
    expect((await readApp(owner.api, app.id)).status).toBe(200);
  });

  test('1: a user without admin rights builds an app from a description in two clicks and gets a test answer', async ({
    owner
  }) => {
    const { page, api } = owner;
    // Not an administrator of any kind.
    expect((await api.get('/api/admin/apps')).status()).toBe(403);

    // Every request the browser makes on the walk, to catch a call to an admin
    // route that fails quietly or answers 200 (acceptance item 1). The app shell
    // asks /api/admin/auth/status on every page (AdminAuthProvider in App.jsx,
    // older than personal apps); it reads no app and is left out.
    const adminCalls = [];
    page.on('request', request => {
      const { pathname } = new URL(request.url());
      if (pathname.includes('/api/admin/') && !pathname.endsWith('/api/admin/auth/status')) {
        adminCalls.push(`${request.method()} ${pathname}`);
      }
    });

    await page.goto('/apps');
    await expect(page.getByTestId('apps-scope-mine')).toHaveText(
      new RegExp(`^${tr('userApps.list.scope.mine')}`)
    );
    // "New app" lives in the sidebar's Create menu.
    await page
      .getByRole('button', { name: tr('sidebar.create.label'), exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByTestId('sidebar-create-app').filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/apps\/new$/);
    const describe = page.getByRole('textbox', { name: tr('admin.apps.create.start.label') });
    await describe.fill('An assistant that rewrites a text in a friendlier tone. e2e-app-json');

    // Click one: the draft. The personal route, never the admin one.
    const [draft] = await Promise.all([
      page.waitForResponse(response => response.url().includes('/_generate')),
      page.getByRole('button', { name: tr('admin.apps.create.start.generate') }).click()
    ]);
    expect(new URL(draft.url()).pathname).toBe('/api/apps/_generate');
    expect(draft.status(), await draft.text()).toBe(200);
    await expect(nameField(page)).toHaveValue('E2E AB Tone helper');
    await expect(page.getByText(tr('userApps.create.stateLine'))).toBeVisible();
    await nameField(page).fill(`${NAME_PREFIX} Tone helper`);

    // Click two: the app exists and the test chat is open.
    const [created] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/apps'
      ),
      page.getByRole('button', { name: tr('admin.apps.create.submit') }).click()
    ]);
    expect(created.status(), await created.text()).toBe(201);
    const app = await created.json();
    expect(app.id).toMatch(/^uap_[0-9a-f]{32}$/);
    expect(app.owner.id).toBe(people.ownerId);
    expect(created.request().postDataJSON().origin).toBe('generated');
    await expect(page).toHaveURL(new RegExp(`/apps/${app.id}/edit`));
    await expect(page.getByTestId('user-app-state')).toHaveText(tr('userApps.edit.state.private'));

    await expectChatAnswer(testPanel(page), 'hello', 'E2E reply to:');

    // No request the browser made on the whole walk went to an admin route,
    // and the admin route of the app refuses the user.
    expect(adminCalls).toEqual([]);
    expect((await api.get(`/api/admin/apps/${app.id}`)).status()).toBe(403);
    // It is no company app: the list of everyone's apps does not hold it.
    const all = await (await api.get('/api/apps')).json();
    expect((Array.isArray(all) ? all : all.items).map(entry => entry.id)).not.toContain(app.id);
  });

  test('2 and 3: the owner shares with a second user, who sees the notice, chats and cannot edit; a third user gets 404', async ({
    owner,
    ben,
    cleo
  }) => {
    const name = `${NAME_PREFIX} Shared helper`;
    const app = await createApp(owner.api, name);

    // The owner shares from the tile menu of "My apps".
    await owner.page.goto('/apps');
    await owner.page.getByTestId('apps-scope-mine').click();
    await owner.page
      .getByRole('button', { name: tr('userApps.list.menu.label', { name }) })
      .click();
    await owner.page.getByRole('menuitem', { name: tr('userApps.list.menu.share') }).click();
    const dialog = owner.page.getByRole('dialog');
    await expect(dialog).toContainText(tr('userApps.share.title', { name }));
    await expect(dialog).toContainText(tr('userApps.share.help'));
    await dialog.getByRole('textbox').fill('Ben');
    await dialog.getByText(BEN.name).first().click();
    const [saved] = await Promise.all([
      owner.page.waitForResponse(
        response =>
          response.request().method() === 'PUT' && response.url().endsWith(`/${app.id}/members`)
      ),
      dialog.getByRole('button', { name: tr('common.save') }).click()
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    expect(saved.request().headers()['if-match']).toMatch(/^"\d+"$/);
    expect((await readApp(owner.api, app.id)).body.members).toEqual([
      { type: 'user', id: people.benId, name: BEN.name, role: 'user' }
    ]);

    // Ben finds it under "Shared with me", sees who owns it, and chats.
    await ben.page.goto('/apps');
    await ben.page.getByTestId('apps-scope-shared').click();
    await ben.page.getByRole('button', { name: tr('userApps.list.menu.label', { name }) }).click();
    await expect(ben.page.getByRole('menuitem')).toHaveText([
      tr('userApps.list.menu.duplicate'),
      tr('userApps.list.menu.leave')
    ]);
    await ben.page.keyboard.press('Escape');
    await ben.page.goto(`/apps/${app.id}`);
    const notice = ben.page.getByTestId('personal-app-notice');
    await expect(notice).toContainText(tr('userApps.notice.ownedBy', { owner: OWNER_NAME }));
    await notice.getByRole('button', { name: tr('userApps.notice.showInstructions') }).click();
    await expect(ben.page.getByTestId('personal-app-instructions')).toHaveText(
      `You are ${name}. Answer briefly.`
    );
    await ben.page.keyboard.press('Escape');
    await expectChatAnswer(ben.page.locator('main'), 'please help');

    // Ben cannot edit: the page has no save bar and the fields are locked, and
    // the server refuses what the page does not offer.
    await ben.page.goto(`/apps/${app.id}/edit`);
    await expect(nameField(ben.page)).toHaveValue(name);
    await expect(nameField(ben.page)).toBeDisabled();
    await expect(saveBar(ben.page)).toHaveCount(0);
    const patch = await ben.api.patch(`/api/apps/${app.id}`, { data: { name: { en: 'pwned' } } });
    expect(patch.status()).toBe(403);
    const view = (await readApp(ben.api, app.id)).body;
    expect(view.permissions).toMatchObject({ role: 'user', canUse: true, canEdit: false });
    expect(view).not.toHaveProperty('members');

    // The owner's own chat shows no notice.
    await owner.page.goto(`/apps/${app.id}`);
    await expect(owner.page.locator('textarea.chat-input-textarea:visible')).toBeVisible();
    await expect(owner.page.getByTestId('personal-app-notice')).toHaveCount(0);

    // 3: Cleo has no share. The address answers as an address that names no app.
    const unknownId = `uap_${'0'.repeat(32)}`;
    const denied = await cleo.api.get(`/api/apps/${app.id}`);
    const unknown = await cleo.api.get(`/api/apps/${unknownId}`);
    expect(denied.status()).toBe(404);
    expect(await denied.text()).toBe(await unknown.text());
    const answers = [];
    cleo.page.on('response', response => {
      if (new URL(response.url()).pathname === `/api/apps/${app.id}`)
        answers.push(response.status());
    });
    await cleo.page.goto(`/apps/${app.id}`);
    await cleo.page.waitForLoadState('networkidle');
    expect(answers.length, 'the page asked for the app').toBeGreaterThan(0);
    expect(new Set(answers)).toEqual(new Set([404]));
    await expect(cleo.page.getByText(name)).toHaveCount(0);
    await expect(cleo.page.locator('textarea.chat-input-textarea')).toHaveCount(0);
    await cleo.page.goto(`/apps/${app.id}/edit`);
    await cleo.page.waitForLoadState('networkidle');
    await expect(cleo.page.getByText(name)).toHaveCount(0);
    await expect(nameField(cleo.page)).toHaveCount(0);
  });

  test('6: hand over: the receiver sees the offer with the members, takes the app over, and the previous owner gets 404', async ({
    owner,
    ben,
    cleo
  }) => {
    const name = `${NAME_PREFIX} Hand over`;
    const app = await createApp(owner.api, name);
    await share(owner.api, app.id, [member(people.cleoId, 'editor')]);

    // The owner makes the offer from the editor.
    await owner.page.goto(`/apps/${app.id}/edit`);
    await expect(nameField(owner.page)).toHaveValue(name);
    await openMore(owner.page);
    await owner.page.getByRole('menuitem', { name: tr('userApps.transfer.action') }).click();
    const dialog = owner.page.getByRole('dialog').or(owner.page.getByRole('alertdialog')).first();
    await dialog.getByPlaceholder(tr('userApps.transfer.search')).fill('Ben');
    await dialog.getByText(BEN.name).first().click();
    await dialog.getByRole('button', { name: tr('userApps.transfer.next') }).click();
    for (const key of ['title', 'line1', 'line2', 'line3']) {
      await expect(dialog).toContainText(tr(`userApps.transfer.${key}`, { name, owner: BEN.name }));
    }
    await dialog
      .getByRole('button', { name: tr('userApps.transfer.submit', { owner: BEN.name }) })
      .click();
    await expect(owner.page.getByTestId('user-app-state')).toHaveText(
      tr('userApps.edit.state.offered', { owner: BEN.name })
    );
    // Until Ben answers, nothing changed.
    expect((await readApp(owner.api, app.id)).body.owner.id).toBe(people.ownerId);

    // Ben finds the offer under "My apps" and reads what he would take over.
    await ben.page.goto('/apps');
    await ben.page.getByTestId('apps-scope-mine').click();
    await expect(
      ben.page.getByTestId('user-app-badge').filter({ hasText: tr('userApps.list.badge.offered') })
    ).toBeVisible();
    // The tile of an offered app opens the editor with the offer, not the chat.
    await ben.page.getByRole('button', { name, exact: true }).click();
    await expect(ben.page).toHaveURL(new RegExp(`/apps/${app.id}/edit$`));
    const banner = ben.page.getByTestId('user-app-offer');
    await expect(banner).toContainText(tr('userApps.transfer.received', { from: OWNER_NAME }));
    await expect(banner).toContainText(tr('userApps.transfer.receivedDuty'));
    await expect(ben.page.getByTestId('user-app-offer-members')).toContainText(CLEO.name);
    await expect(banner).toContainText(tr('userApps.transfer.receivedEditors'));
    const [accepted] = await Promise.all([
      ben.page.waitForResponse(response => response.url().endsWith('/owner-offer/_accept')),
      banner.getByRole('button', { name: tr('userApps.transfer.accept') }).click()
    ]);
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect(accepted.request().headers()['if-match']).toMatch(/^"\d+"$/);
    await expect(banner).toHaveCount(0);
    await expect(ben.page.getByTestId('user-app-state')).toHaveText(
      tr('userApps.edit.state.shared', { list: tr('userApps.edit.state.people', { count: 1 }) })
    );

    const taken = (await readApp(ben.api, app.id)).body;
    expect(taken.owner.id).toBe(people.benId);
    expect(taken.permissions.isOwner).toBe(true);
    // "Can edit" became "Can use".
    expect(taken.members).toEqual([
      { type: 'user', id: people.cleoId, name: CLEO.name, role: 'user' }
    ]);
    expect((await readApp(cleo.api, app.id)).body.permissions.canEdit).toBe(false);

    // The previous owner has no role left.
    expect((await readApp(owner.api, app.id)).status).toBe(404);
    await owner.page.goto(`/apps/${app.id}/edit`);
    await owner.page.waitForLoadState('networkidle');
    await expect(nameField(owner.page)).toHaveCount(0);
    await expect(owner.page.getByText(name)).toHaveCount(0);
  });

  test('8: cold loads of "New app" and of the editor of an app answer at the root', async ({
    owner
  }) => {
    const name = `${NAME_PREFIX} Cold load`;
    const app = await createApp(owner.api, name);
    const problems = watchPage(owner.page);

    await owner.page.goto('/apps/new');
    await expect(
      owner.page.getByRole('textbox', { name: tr('admin.apps.create.start.label') })
    ).toBeVisible();
    await expect(owner.page.getByText('Unable to connect to the server')).toHaveCount(0);
    expect(new URL(owner.page.url()).pathname).toBe('/apps/new');
    await owner.page.waitForLoadState('networkidle');
    expect(problems, 'the cold load of the create page').toEqual([]);

    await owner.page.goto(`/apps/${app.id}/edit`);
    await expect(nameField(owner.page)).toHaveValue(name);
    await expect(owner.page.getByTestId('user-app-state')).toHaveText(
      tr('userApps.edit.state.private')
    );
    expect(new URL(owner.page.url()).pathname).toBe(`/apps/${app.id}/edit`);
    await owner.page.waitForLoadState('networkidle');
    expect(problems, 'the cold load of the editor').toEqual([]);
  });
});

/**
 * Change permissions of built-in groups for one case and get the function that
 * puts them back.
 *
 * @param {import('@playwright/test').APIRequestContext} adminApi
 * @param {Record<string, Object>} changes - Group id → the permissions to replace
 * @returns {Promise<() => Promise<void>>} Restores what was stored before
 */
async function changeGroups(adminApi, changes) {
  const { groups } = await (await adminApi.get('/api/admin/groups')).json();
  const put = (id, permissions) =>
    adminApi.put(`/api/admin/groups/${id}`, {
      data: { ...groups[id], permissions: { ...groups[id].permissions, ...permissions } }
    });
  for (const [id, permissions] of Object.entries(changes)) {
    await expectOk(await put(id, permissions), `changing the group ${id}`);
  }
  return async () => {
    for (const id of Object.keys(changes)) {
      await expectOk(await put(id, {}), `restoring the group ${id}`);
    }
  };
}

/** A personal app that asks for web search and answers with the model that calls tools. */
const withWebSearch = {
  preferredModel: TOOL_MODEL_ID,
  capabilities: { upload: false, webSearch: true, skills: false, integrations: [] }
};

const webSearchCapability = app => app.capabilities.find(entry => entry.id === 'webSearch');

test.describe('Personal apps: web search for someone else', () => {
  test.beforeEach(async ({ adminApi }) => {
    await setSettings(adminApi, { capabilities: { webSearch: true } });
  });

  test('4: the second user may not use the search engine: the notice says so and the tool is not offered', async ({
    owner,
    ben,
    adminApi
  }) => {
    const name = `${NAME_PREFIX} Search for some`;
    // The engine is granted to the owner's group `users` only.
    const restore = await changeGroups(adminApi, {
      authenticated: { integrations: [] },
      anonymous: { integrations: [] }
    });
    try {
      const app = await createApp(owner.api, name, withWebSearch);
      await share(owner.api, app.id, [member(people.benId)]);
      expect(webSearchCapability(app)).toMatchObject({ requested: true, granted: true });

      const view = (await readApp(ben.api, app.id)).body;
      expect(webSearchCapability(view)).toEqual({
        id: 'webSearch',
        granted: false,
        reason: 'youMayNot'
      });
      expect(view.websearch.enabled).toBe(false);

      await ben.page.goto(`/apps/${app.id}`);
      const notice = ben.page.getByTestId('personal-app-notice');
      await expect(notice).toContainText(
        tr('userApps.notice.notForYou', { list: tr('userApps.notice.capability.webSearch') })
      );
      await expect(notice).not.toContainText(tr('userApps.notice.asksFirst'));
      // No switch for it, in the input row or in its menu.
      await expect(ben.page.getByRole('button', { name: /web search/i })).toHaveCount(0);
      const menu = ben.page.getByRole('button', { name: 'Actions menu' });
      if (await menu.count()) {
        await menu.click();
        await expect(ben.page.getByRole('menuitemcheckbox', { name: /web search/i })).toHaveCount(
          0
        );
        await ben.page.keyboard.press('Escape');
      }
      // And the model is not offered the tools: it answers in words.
      await expectChatAnswer(
        ben.page.locator('main'),
        'read the page',
        'E2E UA answer without tools.'
      );
      await expect(ben.page.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      await restore();
    }
  });

  test('5: the second user switches web search on and is asked before a page is read, without "allow for this chat"', async ({
    owner,
    ben
  }) => {
    const name = `${NAME_PREFIX} Search for all`;
    const app = await createApp(owner.api, name, withWebSearch);
    await share(owner.api, app.id, [member(people.benId)]);
    const view = (await readApp(ben.api, app.id)).body;
    expect(webSearchCapability(view)).toEqual({ id: 'webSearch', granted: true });
    expect(view.approval).toEqual({ mode: 'always', chatGrants: false });

    await ben.page.goto(`/apps/${app.id}`);
    const notice = ben.page.getByTestId('personal-app-notice');
    await expect(notice).toContainText(
      tr('userApps.notice.mayUse', {
        list: `${tr('userApps.notice.capability.webSearch')} (${tr('userApps.notice.switchOn')})`
      })
    );
    await expect(notice).toContainText(tr('userApps.notice.asksFirst'));

    // Off until Ben switches it on for this chat.
    await ben.page.getByRole('button', { name: 'Actions menu' }).click();
    const toggle = ben.page.getByRole('menuitemcheckbox', { name: /web search/i });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await ben.page.keyboard.press('Escape');

    const main = ben.page.locator('main');
    const box = main.locator('textarea.chat-input-textarea:visible');
    await box.fill('What does the page say?');
    await box.press('Enter');

    // The model asks for a page; nothing is fetched before Ben decides.
    // The card is rendered twice, once in the collapsed list of steps.
    const card = main.locator('[data-testid="tool-approval-card"]:visible');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('tool-approval-args')).toContainText(PAGE_URL);
    await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: /allow for this chat/i })).toHaveCount(0);

    await card.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(card.getByTestId('tool-approval-decision')).toHaveText(
      'You rejected this call. It was not run.'
    );
  });
});

test.describe('Personal apps: publishing', () => {
  /**
   * The owner publishes from the editor.
   *
   * @returns {Promise<{appId: string, name: Object, enabled: boolean}>} The company
   *   app, as the answer to the publish names it (`publishedAs`)
   */
  async function publishFromEditor(page, appId, { title, body }) {
    await page.goto(`/apps/${appId}/edit`);
    await expect(nameField(page)).toBeVisible();
    await openMore(page);
    await page.getByRole('menuitem', { name: tr('userApps.publish.action') }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(title);
    await expect(dialog).toContainText(body);
    await expect(dialog).toContainText(tr('userApps.publish.managed'));
    const [response] = await Promise.all([
      page.waitForResponse(candidate => candidate.url().endsWith(`/${appId}/_publish`)),
      dialog.getByRole('button', { name: tr('userApps.publish.submit') }).click()
    ]);
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().headers()['if-match']).toMatch(/^"\d+"$/);
    const published = await response.json();
    // `retired` when the owner can use the company app at once: the body GET answers then.
    expect(['promoted', 'retired']).toContain(published.state);
    return published.publishedAs;
  }

  /** The pointer a person gets at the personal address once they can use the company app. */
  async function expectPointer(page, appId, companyId, name) {
    await page.goto(`/apps/${appId}`);
    const retired = page.getByTestId('personal-app-retired');
    await expect(retired).toContainText(tr('userApps.publish.retired.title'));
    await retired
      .getByRole('link', { name: tr('userApps.publish.retired.open', { name }) })
      .or(retired.getByRole('button', { name: tr('userApps.publish.retired.open', { name }) }))
      .click();
    await expect(page).toHaveURL(new RegExp(`/apps/${companyId}$`));
    // A company app: no notice about an owner.
    await expectChatAnswer(page.locator('main'), 'hello company app');
    await expect(page.getByTestId('personal-app-notice')).toHaveCount(0);
  }

  /** A person who cannot use the company app keeps the personal one. */
  async function expectPersonalChat(page, appId) {
    await page.goto(`/apps/${appId}`);
    await expect(page.getByTestId('personal-app-notice')).toBeVisible();
    await expect(page.getByTestId('personal-app-retired')).toHaveCount(0);
    await expectChatAnswer(
      page.locator('main'),
      'still here',
      /E2E (reply to: still here|UA answer)/
    );
  }

  test('7a: without publishing switched on, the editor offers no "Publish" and the server refuses', async ({
    owner
  }) => {
    const app = await createApp(owner.api, `${NAME_PREFIX} Not publishable`);
    expect(app.permissions.canPublish).toBe(false);
    await owner.page.goto(`/apps/${app.id}/edit`);
    await expect(nameField(owner.page)).toBeVisible();
    await openMore(owner.page);
    await expect(
      owner.page.getByRole('menuitem', { name: tr('userApps.transfer.action') })
    ).toBeVisible();
    await expect(
      owner.page.getByRole('menuitem', { name: tr('userApps.publish.action') })
    ).toHaveCount(0);
    const refused = await owner.api.post(`/api/apps/${app.id}/_publish`, {
      data: {},
      headers: { 'if-match': `"${app.revision}"` }
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).details).toMatchObject({ required: 'publish' });
  });

  test('7b: an app without tools is a company app at once, and a member is sent to it', async ({
    owner,
    ben,
    cleo,
    adminApi
  }) => {
    await setSettings(adminApi, { sharing: { allowPublish: true } });
    const name = `${NAME_PREFIX} Plain publish`;
    const app = await createApp(owner.api, name);
    await share(owner.api, app.id, [member(people.benId)]);

    const company = await publishFromEditor(owner.page, app.id, {
      title: tr('userApps.publish.titleNow', { name }),
      body: tr('userApps.publish.bodyNow')
    });
    expect(company.appId).not.toMatch(/^uap_/);

    // What was written is an admin app like any other: no owner, published.
    const stored = await (await adminApi.get(`/api/admin/apps/${company.appId}`)).json();
    expect(stored.enabled).toBe(true);
    expect(stored).not.toHaveProperty('owner');
    expect(stored).not.toHaveProperty('ownership');
    expect((await owner.api.get(`/api/admin/apps/${company.appId}`)).status()).toBe(403);

    // The member gets the pointer at the personal address at once.
    expect((await readApp(ben.api, app.id)).body).toEqual({
      id: app.id,
      ownership: 'user',
      state: 'retired',
      publishedAs: { appId: company.appId, name: { en: name }, enabled: true }
    });
    await expectPointer(ben.page, app.id, company.appId, name);
    // Someone the app was never shared with learns nothing at the personal
    // address, and uses the company app like everyone.
    expect((await readApp(cleo.api, app.id)).status).toBe(404);
    expect((await readApp(cleo.api, company.appId)).status).toBe(200);

    // The owner can no longer change it.
    const patch = await owner.api.patch(`/api/apps/${app.id}`, { data: { name: { en: 'x' } } });
    expect(patch.status()).toBe(409);
  });

  test('7c: an app with web search waits for an administrator; the member keeps the personal app until a content admin switches the company app on', async ({
    owner,
    ben,
    browser,
    baseURL,
    adminApi
  }) => {
    await setSettings(adminApi, {
      sharing: { allowPublish: true },
      capabilities: { webSearch: true }
    });
    const name = `${NAME_PREFIX} Search publish`;
    const app = await createApp(owner.api, name, withWebSearch);
    await share(owner.api, app.id, [member(people.benId)]);

    const company = await publishFromEditor(owner.page, app.id, {
      title: tr('userApps.publish.titleLater', { name }),
      body: tr('userApps.publish.bodyLaterTools', { list: tr('userApps.publish.tool.webSearch') })
    });
    expect(company).toMatchObject({ enabled: false });
    // The owner is told that it waits.
    await owner.page.goto(`/apps/${app.id}/edit`);
    await expect(owner.page.getByTestId('user-app-status')).toContainText(
      'An administrator has not switched the company app on yet.'
    );

    // Not visible to anyone yet, and the member still chats with the personal app.
    const listed = await (await ben.api.get('/api/apps')).json();
    expect((Array.isArray(listed) ? listed : listed.items).map(entry => entry.id)).not.toContain(
      company.appId
    );
    expect((await readApp(ben.api, company.appId)).status).toBe(404);
    await expectPersonalChat(ben.page, app.id);

    // The content admin is told that an app waits, and switches it on in the admin editor.
    const builder = await windowOf(browser, baseURL, BUILDER);
    try {
      expect((await builder.api.get('/api/admin/user-apps')).status()).toBe(403);
      await builder.page.goto('/admin/apps');
      const waiting = builder.page.getByTestId('waiting-apps-notice');
      await expect(waiting).toContainText(tr('admin.userApps.waiting.notice', { count: 1 }));
      await expect(waiting).toContainText(name);
      await waiting.getByRole('link', { name }).or(waiting.getByRole('button', { name })).click();
      await expect(builder.page).toHaveURL(new RegExp(`/admin/apps/${company.appId}`));
      await expect(builder.page.getByTestId('app-status')).toHaveText(
        tr('admin.apps.status.notPublished')
      );
      await builder.page
        .getByRole('button', { name: tr('admin.apps.edit.publish.action'), exact: true })
        .first()
        .click();
      const dialog = builder.page.getByRole('alertdialog');
      const [toggled] = await Promise.all([
        builder.page.waitForResponse(response => response.url().endsWith('/_toggle')),
        dialog
          .getByRole('button', { name: tr('admin.apps.edit.publish.action'), exact: true })
          .click()
      ]);
      expect(toggled.ok(), await toggled.text()).toBeTruthy();
      await expect(builder.page.getByTestId('app-status')).toHaveText(
        tr('admin.apps.status.published')
      );
    } finally {
      await builder.context.close();
    }

    // Now the member is sent to the company app.
    expect((await readApp(ben.api, app.id)).body.state).toBe('retired');
    await ben.page.goto(`/apps/${app.id}`);
    await expect(ben.page.getByTestId('personal-app-retired')).toContainText(
      tr('userApps.publish.retired.title')
    );
  });

  test('7d: without the app wildcard, a member whose groups do not grant the company app keeps the personal app', async ({
    owner,
    ben,
    adminApi
  }) => {
    await setSettings(adminApi, { sharing: { allowPublish: true } });
    const name = `${NAME_PREFIX} No wildcard`;
    const app = await createApp(owner.api, name);
    await share(owner.api, app.id, [member(people.benId)]);
    // Ben's apps come from `authenticated` alone; the owner's from `users`.
    const restore = await changeGroups(adminApi, { authenticated: { apps: [] } });
    try {
      const company = await publishFromEditor(owner.page, app.id, {
        title: tr('userApps.publish.titleNow', { name }),
        body: tr('userApps.publish.bodyNow')
      });
      // Switched on at once: it has no tools.
      const stored = await (await adminApi.get(`/api/admin/apps/${company.appId}`)).json();
      expect(stored.enabled).toBe(true);

      // Ben may not use the company app, so his personal address still works.
      expect((await readApp(ben.api, company.appId)).status).toBe(404);
      const view = (await readApp(ben.api, app.id)).body;
      expect(view.state).toBe('promoted');
      expect(view.permissions.canUse).toBe(true);
      await expectPersonalChat(ben.page, app.id);

      // The owner's groups grant it: the owner is sent on.
      await expectPointer(owner.page, app.id, company.appId, name);
    } finally {
      await restore();
    }
  });
});
