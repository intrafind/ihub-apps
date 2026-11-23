// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { ADMIN, BUILDER, BUILDER_GROUP, NORMAL_USER } from '../config/app-builder-seed.mjs';

/**
 * End-to-end: the app builder (concepts/app-builder-rework-2026-11, section 7.3).
 *
 * From the app list to the first answer in the test chat, the draft from a
 * description, publishing, and the same as a content admin who is not an
 * administrator. The numbers in the test titles are the case numbers of the
 * plan.
 *
 * Runs only through its own config (`npm run test:e2e:app-builder`,
 * tests/config/playwright.app-builder.config.js): its own server, ports and
 * contents directory, one worker, and a model stub that answers a description
 * carrying an `e2e-app-*` marker with the draft of an app
 * (tests/config/e2e-llm-stub.mjs). Two cases change what every other test
 * relies on, the only model and the app wildcard of the group `authenticated`,
 * and put it back in `finally`.
 *
 * Every app a test creates has an ID that starts with `e2e-ab-`, and all such
 * apps are deleted after each test.
 */

const PREFIX = 'e2e-ab-';
const STUB_URL = process.env.E2E_APP_BUILDER_LLM_URL;
const STUB_MODEL = 'e2e-stub';
/** Every model the e2e contents set up (`tests/config/e2e-contents.mjs`): all off is "no model". */
const STUB_MODELS = [STUB_MODEL, 'e2e-stub-tools'];
const here = path.dirname(fileURLToPath(import.meta.url));

/** The texts of the UI, so German labels are the ones the product ships. */
const LOCALES = Object.fromEntries(
  ['en', 'de'].map(language => [
    language,
    JSON.parse(
      fs.readFileSync(path.join(here, '..', '..', 'shared', 'i18n', `${language}.json`), 'utf8')
    )
  ])
);

/**
 * A text of the UI.
 *
 * @param {'en'|'de'} language
 * @param {string} key - e.g. `admin.apps.create.submit`
 * @param {Record<string, string|number>} [values] - Interpolation values
 * @returns {string}
 */
function tr(language, key, values = {}) {
  let node = LOCALES[language];
  for (const part of key.split('.')) node = node?.[part];
  if (typeof node !== 'string') throw new Error(`No ${language} text for the key ${key}`);
  return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => String(values[name] ?? ''));
}

/** English labels that must not show on a German page (case 3). */
const ENGLISH_LABELS = [
  'New app',
  'Start empty',
  'Templates',
  'Other ways to start',
  'Prepare draft',
  'Create and test',
  'Short description',
  'Instructions',
  'Not published',
  'Publish',
  'Basics',
  'Expand all',
  'Add input field',
  'Conversation starters',
  'Who can use this app',
  'Your app is ready to test',
  'Test app',
  'Save'
];

/**
 * An API client signed in as one account, with its own cookies.
 *
 * @param {import('@playwright/test').PlaywrightWorkerArgs['playwright']} playwright
 * @param {string} baseURL
 * @param {{username: string, password: string}} account
 */
async function apiAs(playwright, baseURL, { username, password }) {
  const api = await playwright.request.newContext({ baseURL });
  const login = await api.post('/api/auth/local/login', { data: { username, password } });
  expect(login.ok(), `sign in as ${username}: HTTP ${login.status()}`).toBeTruthy();
  return api;
}

const test = base.extend({
  /** The admin API as the full administrator. */
  adminApi: async ({ playwright, baseURL }, use) => {
    const api = await apiAs(playwright, baseURL, ADMIN);
    await use(api);
    await api.dispose();
  },
  /** The API as a user without any admin right. */
  userApi: async ({ playwright, baseURL }, use) => {
    const api = await apiAs(playwright, baseURL, NORMAL_USER);
    await use(api);
    await api.dispose();
  }
});

test.skip(
  process.env.E2E_APP_BUILDER !== '1',
  'Changes the model and the groups of its server: runs only through npm run test:e2e:app-builder'
);

/** @returns {Promise<object[]>} Every app, as the admin list has it */
async function adminApps(adminApi) {
  const response = await adminApi.get('/api/admin/apps');
  expect(response.ok(), `GET /api/admin/apps: HTTP ${response.status()}`).toBeTruthy();
  const body = await response.json();
  return Array.isArray(body) ? body : body.items;
}

/** @returns {Promise<object>} The stored app */
async function storedApp(adminApi, id) {
  const response = await adminApi.get(`/api/admin/apps/${id}`);
  expect(response.status(), `GET /api/admin/apps/${id}`).toBe(200);
  return response.json();
}

/** @returns {Promise<string[]>} The IDs of the apps `api`'s user gets in the app list */
async function visibleAppIds(api) {
  const response = await api.get('/api/apps');
  expect(response.ok(), `GET /api/apps: HTTP ${response.status()}`).toBeTruthy();
  const body = await response.json();
  return (Array.isArray(body) ? body : body.items).map(app => app.id);
}

/** A user sees an app when it is in their list and opens by its ID. */
async function expectVisibleTo(api, id, visible) {
  await expect
    .poll(async () => (await visibleAppIds(api)).includes(id), {
      message: `${id} ${visible ? 'is' : 'is not'} in GET /api/apps`
    })
    .toBe(visible);
  expect((await api.get(`/api/apps/${id}`)).status()).toBe(visible ? 200 : 404);
}

/**
 * Creates an app through the admin API, for tests whose subject is not the
 * create page.
 *
 * @param {import('@playwright/test').APIRequestContext} adminApi
 * @param {string} id
 * @param {object} [overrides]
 * @returns {Promise<object>} The created app
 */
async function createAppByApi(adminApi, id, overrides = {}) {
  const response = await adminApi.post('/api/admin/apps?origin=blank', {
    data: {
      id,
      name: { en: `E2E AB ${id.slice(PREFIX.length)}` },
      description: { en: 'Created by the app builder e2e suite.' },
      system: { en: 'You answer in one sentence.' },
      color: '#4F46E5',
      icon: 'chat-bubbles',
      enabled: false,
      ...overrides
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function setPublished(adminApi, ids, enabled) {
  const response = await adminApi.post(`/api/admin/apps/${[].concat(ids).join(',')}/_toggle`, {
    data: { enabled }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** What the model stub received last, and whether its caller hung up early. */
async function lastModelRequest(adminApi) {
  const response = await adminApi.get(`${STUB_URL}/__last-request`);
  const { body, aborted } = await response.json();
  const text = role =>
    (body?.messages ?? [])
      .filter(message => message.role === role)
      .map(message => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
  return { aborted, user: text('user'), system: text('system') };
}

/** Signs the page's browser context in and gets the first-run disclaimer out of the way. */
async function signIn(page, { username, password }) {
  await page.context().addInitScript(() => {
    window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
  });
  const login = await page.request.post('/api/auth/local/login', { data: { username, password } });
  expect(login.ok(), `sign in as ${username}: HTTP ${login.status()}`).toBeTruthy();
}

/** The "New app" page, reached the way an author reaches it: from the list. */
async function openNewApp(page, language = 'en') {
  await page.goto('/admin/apps');
  await page.getByRole('button', { name: tr(language, 'admin.apps.createApp') }).click();
  await expect(page).toHaveURL(/\/admin\/apps\/new$/);
  await expect(
    page.getByRole('heading', { level: 1, name: tr(language, 'admin.apps.create.title') })
  ).toBeVisible();
}

/** The three fields of the Essentials screen, by their labels. */
function essentials(page, language = 'en') {
  const field = key =>
    page.getByRole('textbox', { name: tr(language, `admin.apps.create.essentials.${key}`) });
  return {
    name: field('name'),
    description: field('description'),
    instructions: field('instructions'),
    submit: page.getByRole('button', { name: tr(language, 'admin.apps.create.submit') })
  };
}

async function fillEssentials(page, { name, description, instructions }, language = 'en') {
  const fields = essentials(page, language);
  await fields.name.fill(name);
  await fields.description.fill(description);
  if (instructions !== undefined) await fields.instructions.fill(instructions);
}

const isCreateRequest = request =>
  request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/admin/apps');

/**
 * Presses "Create and test" and returns the request the page sent.
 *
 * @returns {Promise<{response: import('@playwright/test').Response, body: object, origin: string|null}>}
 */
async function submitCreate(page, language = 'en') {
  const [response] = await Promise.all([
    page.waitForResponse(candidate => isCreateRequest(candidate.request())),
    essentials(page, language).submit.click()
  ]);
  return {
    response,
    body: response.request().postDataJSON(),
    origin: new URL(response.url()).searchParams.get('origin')
  };
}

/** The editor of a new app: its own URL, without `?created=1`, with the test panel open. */
async function expectEditorOf(page, id, language = 'en') {
  await expect(page).toHaveURL(new RegExp(`/admin/apps/${id}$`));
  await expect(page.getByTestId('app-id')).toHaveText(id);
  await expect(testPanel(page, language)).toBeVisible();
}

function testPanel(page, language = 'en') {
  return page.getByRole('complementary', { name: tr(language, 'admin.apps.test.title') });
}

/**
 * Sends a message in the test chat and waits for the stub's answer to it. The
 * stub echoes what reached it, which is the message, or with a message
 * template the filled-in template (`echo`).
 */
async function expectTestAnswer(page, message, { language = 'en', echo = message } = {}) {
  const panel = testPanel(page, language);
  const box = panel.locator('textarea.chat-input-textarea:visible');
  await box.fill(message);
  await box.press('Enter');
  await expect(panel.locator('p:visible', { hasText: `E2E reply to: ${echo}` })).toBeVisible();
}

/** The Publish dialog of the editor, opened from the header. */
async function openPublishDialog(page, language = 'en') {
  await page
    .getByRole('button', { name: tr(language, 'admin.apps.edit.publish.action'), exact: true })
    .first()
    .click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

const isToggle = response =>
  response.request().method() === 'POST' &&
  /\/api\/admin\/apps\/[^/]+\/_toggle$/.test(response.url());

/** Confirms an open Publish or Unpublish dialog and returns the `_toggle` response. */
async function confirmToggle(page, dialog, label) {
  const [response] = await Promise.all([
    page.waitForResponse(isToggle),
    dialog.getByRole('button', { name: label, exact: true }).click()
  ]);
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(dialog).toBeHidden();
  return response;
}

/** The description box of the Start screen and what belongs to it. */
function describeStart(page) {
  const region = page.getByRole('region', { name: 'What should your app do?' });
  return {
    region,
    box: region.getByRole('textbox', { name: 'Your description' }),
    prepare: region.getByRole('button', { name: 'Prepare draft' }),
    pending: region.getByRole('button', { name: /Preparing your draft/ }),
    cancel: region.getByRole('button', { name: 'Cancel' }),
    alert: region.getByRole('alert')
  };
}

const isGenerate = response =>
  response.request().method() === 'POST' && response.url().endsWith('/api/admin/apps/_generate');

/** Types a description on the Start screen, asks for a draft and returns the response. */
async function prepareDraft(page, description) {
  const start = describeStart(page);
  await start.box.fill(description);
  const [response] = await Promise.all([page.waitForResponse(isGenerate), start.prepare.click()]);
  return response;
}

/** A group of the editor form: its header button and its panel. */
function editorGroup(page, id) {
  return {
    header: page.locator(`#app-group-${id}-header`),
    panel: page.locator(`#app-group-${id}-panel`)
  };
}

/** Presses Tab until `target` has the focus: the way a keyboard user gets there. */
async function tabTo(page, target, limit = 80) {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target, `not reached with ${limit} presses of Tab`).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await signIn(page, ADMIN);
});

test.afterEach(async ({ adminApi }) => {
  for (const app of await adminApps(adminApi)) {
    if (app.id.startsWith(PREFIX)) await adminApi.delete(`/api/admin/apps/${app.id}`);
  }
});

test.describe('Creating an app', () => {
  test('1: empty start, three fields, and the test chat answers within five clicks', async ({
    page
  }) => {
    // Clicks are counted in the page, so a click the helpers hide is counted too.
    await page.addInitScript(() => {
      document.addEventListener(
        'click',
        event => {
          if (!event.isTrusted) return;
          const clicks = Number(window.sessionStorage.getItem('e2e-clicks') || 0);
          window.sessionStorage.setItem('e2e-clicks', String(clicks + 1));
        },
        true
      );
    });
    await openNewApp(page);
    await page.evaluate(() => window.sessionStorage.setItem('e2e-clicks', '0'));

    await expect(page.getByText('Step 1 of 2: Start')).toBeVisible();
    await page.getByRole('button', { name: 'Start empty' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Describe your app' })).toBeFocused();
    await expect(page.getByText('Step 2 of 2: Essentials')).toBeVisible();

    await fillEssentials(page, {
      name: 'E2E AB First',
      description: 'Answers a greeting.',
      instructions: 'You answer every greeting in one sentence.'
    });
    const created = await submitCreate(page);
    expect(created.response.status()).toBe(201);
    expect(created.origin).toBe('blank');
    expect(created.body).toMatchObject({
      id: 'e2e-ab-first',
      name: { en: 'E2E AB First' },
      description: { en: 'Answers a greeting.' },
      system: { en: 'You answer every greeting in one sentence.' },
      enabled: false
    });

    await expectEditorOf(page, 'e2e-ab-first');
    await expect(page.getByTestId('editor-toast')).toContainText('App "E2E AB First" created');
    await expect(page.getByRole('heading', { name: 'Your app is ready to test' })).toBeVisible();
    await expect(page.getByTestId('app-status')).toHaveText('Not published');
    await expect(page.getByTestId('test-not-published')).toBeVisible();

    await expectTestAnswer(page, 'hello');
    const clicks = Number(await page.evaluate(() => window.sessionStorage.getItem('e2e-clicks')));
    expect(clicks, 'clicks from "New app" to the first answer').toBeLessThanOrEqual(5);
  });

  test('2: an edit round-trips, and users see the app only once it is published', async ({
    page,
    adminApi,
    userApi
  }) => {
    await openNewApp(page);
    await page.getByRole('button', { name: 'Start empty' }).click();
    await fillEssentials(page, {
      name: 'E2E AB Round trip',
      description: 'Before the edit.',
      instructions: 'You answer briefly.'
    });
    const { body: posted } = await submitCreate(page);
    const id = posted.id;
    await expectEditorOf(page, id);
    // The server stores what was sent and adds the defaults of the app schema.
    const created = await storedApp(adminApi, id);
    expect(created, 'the stored app holds the POST body').toMatchObject(posted);
    const added = Object.keys(created).filter(key => !(key in posted));
    expect(added.sort(), 'only schema defaults were added').toEqual([
      'allowInheritance',
      'autoStart',
      'disallowModelSelection'
    ]);

    const description = editorGroup(page, 'basics').panel.getByRole('textbox', {
      name: 'Short description'
    });
    await description.fill('After the edit.');
    const saveBar = page.getByRole('region', { name: 'Save changes' });
    const [saved] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'PUT' && response.url().endsWith(`/api/admin/apps/${id}`)
      ),
      saveBar.getByRole('button', { name: 'Save Changes' }).click()
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    await expect(page.getByTestId('editor-toast')).toContainText('App saved');

    await page.reload();
    await expect(description).toHaveValue('After the edit.');
    expect(await storedApp(adminApi, id), 'only the short description changed').toEqual({
      ...created,
      description: { en: 'After the edit.' }
    });

    // Not published: a user gets the same answer as for an app that does not exist.
    await expectVisibleTo(userApi, id, false);

    const dialog = await openPublishDialog(page);
    await expect(dialog).toContainText('Publish "E2E AB Round trip"?');
    await expect(dialog.getByTestId('publish-audience')).toHaveText(
      'Everyone who signs in can use this app.'
    );
    await confirmToggle(page, dialog, 'Publish');
    await expect(page.getByTestId('app-status')).toHaveText('Published');
    await expectVisibleTo(userApi, id, true);
    expect((await storedApp(adminApi, id)).enabled).toBe(true);
  });

  test.describe('in German', () => {
    test.use({ locale: 'de-DE' });

    test('3: the same walk without an English label, stored in German only', async ({
      page,
      adminApi
    }) => {
      const main = page.locator('#admin-main-content');
      const expectGerman = async where => {
        const text = await main.innerText();
        expect(text, `${where}: a translation key is shown`).not.toContain('admin.apps.');
        for (const label of ENGLISH_LABELS) {
          expect(text, `${where}: the English label "${label}" is shown`).not.toMatch(
            new RegExp(`(^|[^\\p{L}])${label}($|[^\\p{L}])`, 'mu')
          );
        }
      };

      await openNewApp(page, 'de');
      await expect(
        page.getByRole('button', { name: tr('de', 'admin.apps.create.start.blank') })
      ).toBeVisible();
      await expectGerman('Start');

      await page.getByRole('button', { name: tr('de', 'admin.apps.create.start.blank') }).click();
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: tr('de', 'admin.apps.create.essentials.heading.blank')
        })
      ).toBeVisible();
      await expectGerman('Essentials');

      await fillEssentials(
        page,
        {
          name: 'E2E AB Grüße',
          description: 'Beantwortet eine Begrüßung.',
          instructions: 'Sie beantworten jede Begrüßung in einem Satz.'
        },
        'de'
      );
      const { body: posted, response } = await submitCreate(page, 'de');
      expect(response.status(), await response.text()).toBe(201);
      const id = posted.id;
      expect(id).toBe('e2e-ab-gruesse');

      await expectEditorOf(page, id, 'de');
      await expect(page.getByTestId('app-status')).toHaveText(
        tr('de', 'admin.apps.status.notPublished')
      );
      // The header resolves the name in the UI language; a name without English is still a name.
      await expect(page.locator('#admin-main-content h1').first()).toHaveText('E2E AB Grüße');
      await expectTestAnswer(page, 'hallo', { language: 'de' });
      await expectGerman('Editor');

      const stored = await storedApp(adminApi, id);
      expect(Object.keys(stored.name)).toEqual(['de']);
      expect(Object.keys(stored.description)).toEqual(['de']);
      expect(Object.keys(stored.system)).toEqual(['de']);

      // One language: one input per text, without a language code beside it.
      for (const group of ['basics', 'instructions']) {
        const { panel } = editorGroup(page, group);
        await expect(panel).toBeVisible();
        await expect(panel.getByText(/^(DE|EN)$/)).toHaveCount(0);
      }
      await expect(
        editorGroup(page, 'basics').panel.getByRole('textbox', {
          name: tr('de', 'admin.apps.edit.name'),
          exact: true
        })
      ).toHaveValue('E2E AB Grüße');

      // A group with an explicit app list filters the selector by name: an app
      // named in German only must be offered there, by that name.
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/admin/groups/anonymous');
      const search = page.getByPlaceholder(tr('de', 'admin.groups.form.searchApps'));
      await expect(search).toBeVisible();
      await search.fill('Grüße');
      await expect(page.getByRole('button', { name: /E2E AB Grüße/ })).toBeVisible();
      expect(errors, 'the group page threw').toEqual([]);
    });
  });

  test('6: a duplicate is a plain copy that is not published', async ({ page, adminApi }) => {
    await createAppByApi(adminApi, 'e2e-ab-source', {
      name: { en: 'E2E AB Source', de: 'E2E AB Quelle' },
      description: { en: 'The app that is copied.', de: 'Die App, die kopiert wird.' },
      system: { en: 'You answer briefly.', de: 'Sie antworten kurz.' },
      enabled: true,
      parentId: 'chat',
      inheritanceLevel: 1,
      overriddenFields: ['name']
    });

    await page.goto('/admin/apps');
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill('e2e-ab-source');
    const row = page.getByRole('row', { name: /e2e-ab-source/ });
    await row.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Adjust your copy' })).toBeVisible();
    // The source leaves the URL once the copy is open.
    await expect(page).toHaveURL(/\/admin\/apps\/new$/);
    await expect(page.getByText('Copied from "E2E AB Source".')).toBeVisible();
    const fields = essentials(page);
    await expect(fields.name).toHaveValue('E2E AB Source (copy)');
    await expect(fields.name).toBeFocused();
    await expect(fields.instructions).toHaveValue('You answer briefly.');

    const created = await submitCreate(page);
    expect(created.response.status(), await created.response.text()).toBe(201);
    expect(created.origin).toBe('copy');
    const id = created.body.id;
    expect(id).not.toBe('e2e-ab-source');
    expect(id).toBe('e2e-ab-source-copy');
    await expectEditorOf(page, id);

    const copy = await storedApp(adminApi, id);
    expect(copy.name).toEqual({ en: 'E2E AB Source (copy)', de: 'E2E AB Quelle (Kopie)' });
    expect(copy.enabled).toBe(false);
    expect(copy).not.toHaveProperty('parentId');
    expect(copy).not.toHaveProperty('inheritanceLevel');
    expect(copy).not.toHaveProperty('overriddenFields');
    expect((await storedApp(adminApi, 'e2e-ab-source')).enabled, 'the source is untouched').toBe(
      true
    );
  });

  test('7: the list button, the empty list, Cmd+K and a cold load open the same page', async ({
    page
  }) => {
    const heading = page.getByRole('heading', { level: 1, name: 'New app' });

    // The list button.
    await openNewApp(page);

    // A cold load.
    await page.goto('/admin/apps/new');
    await expect(heading).toBeVisible();
    await expect(describeStart(page).box).toBeVisible();

    // Cmd+K.
    await page.goto('/admin/apps');
    await expect(page.getByRole('button', { name: 'New app' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('New app');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/apps\/new$/);
    await expect(heading).toBeVisible();

    // The empty state of the list: an installation without any app.
    await page.route(
      url => url.pathname.endsWith('/api/admin/apps'),
      route =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { items: [], nextCursor: null } })
          : route.fallback()
    );
    await page.goto('/admin/apps');
    await expect(page.getByText('No apps yet')).toBeVisible();
    await expect(page.getByText('An app is an assistant for one task')).toBeVisible();
    const emptyState = page.locator('main').getByRole('button', { name: 'New app' });
    await emptyState.last().click();
    await expect(page).toHaveURL(/\/admin\/apps\/new$/);
    await expect(heading).toBeVisible();
  });

  test('10: a taken ID is refused before submit, and a 409 keeps the input', async ({
    page,
    adminApi
  }) => {
    await openNewApp(page);
    await page.getByRole('button', { name: 'Start empty' }).click();
    await fillEssentials(page, {
      name: 'E2E AB Conflict',
      description: 'Meets a taken ID.',
      instructions: 'You answer briefly.'
    });

    await page.getByRole('button', { name: 'More details' }).click();
    const appId = page.getByRole('textbox', { name: 'App ID' });
    await expect(appId).toHaveValue('e2e-ab-conflict');
    await appId.fill('chat');
    await appId.blur();
    await expect(page.locator('#app-create-id-error')).toHaveText(
      'An app with the ID "chat" already exists. Choose another ID.'
    );
    expect(page.url(), 'nothing was submitted').toMatch(/\/admin\/apps\/new$/);

    // The ID is free when the author types it and taken when the request arrives.
    await appId.fill('e2e-ab-taken');
    await appId.blur();
    await expect(page.locator('#app-create-id-error')).toHaveCount(0);
    await createAppByApi(adminApi, 'e2e-ab-taken');

    const { response } = await submitCreate(page);
    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe('CONFLICT');
    await expect(appId).toBeFocused();
    await expect(appId).toHaveValue('e2e-ab-taken');
    await expect(page.locator('#app-create-id-error')).toHaveText(
      'An app with the ID "e2e-ab-taken" already exists. Choose another ID.'
    );
    const fields = essentials(page);
    await expect(fields.name).toHaveValue('E2E AB Conflict');
    await expect(fields.description).toHaveValue('Meets a taken ID.');
    await expect(fields.instructions).toHaveValue('You answer briefly.');
    await expect(page).toHaveURL(/\/admin\/apps\/new$/);
  });

  test('11: leaving with typed input asks once; an unchanged template does not', async ({
    page
  }) => {
    const dialog = page.getByRole('alertdialog');
    await openNewApp(page);
    await page.getByRole('button', { name: 'Start empty' }).click();
    const fields = essentials(page);
    await fields.name.fill('E2E AB Leaving');

    // Back.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(dialog).toContainText('Discard this app?');
    await expect(dialog).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog).toBeHidden();
    await expect(fields.name).toHaveValue('E2E AB Leaving');

    // The browser's back button.
    await page.evaluate(() => window.history.back());
    await expect(dialog).toContainText('Discard this app?');
    await expect(dialog).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/admin\/apps\/new$/);
    await expect(fields.name).toHaveValue('E2E AB Leaving');

    // Discarding goes back to the Start screen and does not ask a second time.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'New app' })).toBeVisible();

    // A template the author did not change: Back does not ask.
    await page.getByRole('button', { name: /^Translator/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Adjust the template' })
    ).toBeVisible();
    await expect(page.getByText('Started from the template "Translator".')).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New app' })).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });

  test('12: keyboard only, from the list to the first answer', async ({ page }) => {
    await page.goto('/admin/apps');
    await expect(page.getByRole('button', { name: 'New app' })).toBeVisible();
    // The skip link is the first stop and leads past the navigation.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /skip to content/i })).toBeFocused();
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('button', { name: 'New app' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'New app' })).toBeVisible();

    await tabTo(page, page.getByRole('button', { name: 'Start empty' }));
    await page.keyboard.press('Space');
    await expect(page.getByRole('heading', { level: 1, name: 'Describe your app' })).toBeFocused();

    const fields = essentials(page);
    await tabTo(page, fields.name);
    await page.keyboard.type('E2E AB Keyboard');
    await tabTo(page, fields.description);
    await page.keyboard.type('Created without a pointer.');
    await tabTo(page, fields.instructions);
    await page.keyboard.type('You answer briefly.');
    await tabTo(page, fields.submit);
    await page.keyboard.press('Enter');

    await expectEditorOf(page, 'e2e-ab-keyboard');
    await expect(page.getByRole('heading', { name: 'Your app is ready to test' })).toBeVisible();
    // The message box of the test chat takes the focus once the chat has loaded,
    // so the author can type at once; `tabTo` presses nothing then.
    const box = testPanel(page).locator('textarea.chat-input-textarea:visible');
    await expect(box).toBeVisible();
    await tabTo(page, box, 200);
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');
    await expect(
      testPanel(page).locator('p:visible', { hasText: 'E2E reply to: hello' })
    ).toBeVisible();
  });

  test.describe('on a phone, in German', () => {
    test.use({ locale: 'de-DE', viewport: { width: 390, height: 844 } });

    test('13: the primary button is inside the viewport on both screens', async ({ page }) => {
      const expectInViewport = async button => {
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        expect(box, 'the button is rendered').not.toBeNull();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(844);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      };

      await page.goto('/admin/apps/new');
      await expectInViewport(
        page.getByRole('button', { name: tr('de', 'admin.apps.create.start.generate') })
      );
      await page.getByRole('button', { name: tr('de', 'admin.apps.create.start.blank') }).click();
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: tr('de', 'admin.apps.create.essentials.heading.blank')
        })
      ).toBeVisible();
      await expectInViewport(essentials(page, 'de').submit);
    });
  });

  test('14: a template and a link each create an app that opens in the editor', async ({
    page,
    adminApi
  }) => {
    // Template.
    await openNewApp(page);
    await page.getByRole('button', { name: /^Text Summarizer/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Adjust the template' })
    ).toBeVisible();
    const fields = essentials(page);
    await expect(fields.name).toBeFocused();
    await expect(fields.name).toHaveValue('Text Summarizer');
    await expect(fields.instructions).not.toHaveValue('');
    // The name is selected, so typing replaces it; the ID follows the name.
    await page.keyboard.type('E2E AB From template');
    const template = await submitCreate(page);
    expect(template.response.status(), await template.response.text()).toBe(201);
    expect(template.origin).toBe('template');
    expect(template.body.id).toBe('e2e-ab-from-template');
    await expectEditorOf(page, 'e2e-ab-from-template');

    // An app from a template opens like every other app: two groups open.
    const headers = page.locator('[id^="app-group-"][id$="-header"]');
    await expect(headers).toHaveCount(8);
    await expect(
      page.locator('[id^="app-group-"][id$="-header"][aria-expanded="true"]')
    ).toHaveCount(2);
    await expect(editorGroup(page, 'basics').header).toHaveAttribute('aria-expanded', 'true');
    await expect(editorGroup(page, 'instructions').header).toHaveAttribute('aria-expanded', 'true');
    const fromTemplate = await storedApp(adminApi, 'e2e-ab-from-template');
    expect(Object.keys(fromTemplate.system), 'one language').toEqual(['en']);
    expect(fromTemplate.variables.length).toBeGreaterThan(0);
    expect(fromTemplate.enabled).toBe(false);

    // Link.
    await openNewApp(page);
    await page.getByRole('button', { name: 'Other ways to start' }).click();
    await page.getByRole('button', { name: 'Create a link app' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up your link app' })
    ).toBeVisible();
    await fillEssentials(page, { name: 'E2E AB Link', description: 'Opens a website.' });
    await expect(fields.instructions).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Website address' }).fill('https://example.com/docs');
    await page.getByRole('radio', { name: 'Open the website' }).check();
    const link = await submitCreate(page);
    expect(link.response.status(), await link.response.text()).toBe(201);
    expect(link.origin).toBe('link');
    await expect(page).toHaveURL(/\/admin\/apps\/e2e-ab-link$/);
    await expect(page.getByTestId('app-id')).toHaveText('e2e-ab-link');
    await expect(page.getByRole('heading', { level: 1, name: 'E2E AB Link' })).toBeVisible();
    const linkApp = await storedApp(adminApi, 'e2e-ab-link');
    expect(linkApp.type).toBe('redirect');
    expect(linkApp.redirectConfig.url).toBe('https://example.com/docs');
    expect(linkApp).not.toHaveProperty('system');
  });
});

test.describe('A draft from a description', () => {
  test('4: the draft fills Essentials, binds nothing unasked, and a new draft sends the new text', async ({
    page,
    adminApi
  }) => {
    await openNewApp(page);
    // A fenced answer with prose around it: the server still reads the draft.
    const first = await prepareDraft(page, 'Rewrite a text in a chosen tone. e2e-app-fenced');
    expect(first.status(), await first.text()).toBe(200);

    await expect(page.getByRole('heading', { level: 1, name: 'Check your draft' })).toBeFocused();
    const fields = essentials(page);
    await expect(fields.name).toHaveValue('E2E AB Tone helper');
    await expect(fields.description).toHaveValue('Rewrites a text in the tone the user chooses.');
    await expect(fields.instructions).toHaveValue(/^You rewrite the text the user sends\./);

    const notice = page.getByRole('region', { name: /The AI prepared this draft/ });
    const inputFields = notice.getByRole('checkbox', { name: 'Input fields: Tone' });
    await expect(inputFields).toBeChecked();
    await expect(inputFields).toBeEnabled();
    const webSearch = notice.getByRole('checkbox', { name: /^Web search/ });
    await expect(webSearch).not.toBeChecked();
    const suggested = (await first.json()).suggestions;
    expect(suggested.websearch).toBe(true);
    expect(suggested.integrations).toHaveLength(1);
    const system = notice.getByRole('checkbox', {
      name: new RegExp(`^${suggested.integrations[0].label}: `)
    });
    await expect(system).not.toBeChecked();

    // The description reached the model as the user message and nowhere else.
    let sent = await lastModelRequest(adminApi);
    expect(sent.user).toBe('Rewrite a text in a chosen tone. e2e-app-fenced');
    expect(sent.system).not.toContain('Rewrite a text in a chosen tone');
    expect(sent.system).toContain('OUTPUT RULES');

    // The loop on one screen: change the description, draft again.
    const description = notice.getByRole('textbox', { name: 'Your description' });
    await expect(description).toHaveValue('Rewrite a text in a chosen tone. e2e-app-fenced');
    await description.fill('Rewrite a text, friendly or formal. e2e-app-json');
    const [second] = await Promise.all([
      page.waitForResponse(isGenerate),
      notice.getByRole('button', { name: 'Prepare a new draft' }).click()
    ]);
    expect(second.status(), await second.text()).toBe(200);
    expect(second.request().postDataJSON().description).toBe(
      'Rewrite a text, friendly or formal. e2e-app-json'
    );
    sent = await lastModelRequest(adminApi);
    expect(sent.user).toBe('Rewrite a text, friendly or formal. e2e-app-json');
    expect(sent.system).not.toContain('friendly or formal');
    await expect(fields.name).toHaveValue('E2E AB Tone helper');
    await expect(webSearch).not.toBeChecked();
    await expect(system).not.toBeChecked();

    // Nothing ticked: nothing bound.
    const created = await submitCreate(page);
    expect(created.response.status(), await created.response.text()).toBe(201);
    expect(created.origin).toBe('generated');
    expect(created.body).not.toHaveProperty('integrations');
    expect(created.body).not.toHaveProperty('websearch');
    const id = created.body.id;
    expect(id).toBe('e2e-ab-tone-helper');
    await expectEditorOf(page, id);

    const stored = await storedApp(adminApi, id);
    expect(stored).not.toHaveProperty('integrations');
    expect(stored).not.toHaveProperty('websearch');
    expect(stored.enabled).toBe(false);
    expect(stored.prompt.en).toContain('{{tone}}');
    expect(stored.variables).toHaveLength(1);

    // The editor shows the dropdown input field with its options.
    const { panel } = editorGroup(page, 'instructions');
    await expect(panel.getByRole('textbox', { name: 'Field name' })).toHaveValue('Tone');
    await expect(panel.getByRole('textbox', { name: 'Placeholder' })).toHaveValue('tone');
    await expect(
      panel.getByRole('combobox', { name: 'Kind of field' }).locator('option:checked')
    ).toHaveText('Dropdown (choose one)');
    await expect(panel.getByRole('textbox', { name: 'Option 1' })).toHaveValue('Friendly');
    await expect(panel.getByRole('textbox', { name: 'Option 2' })).toHaveValue('Formal');
    const received = panel.getByRole('textbox', { name: 'Text the AI receives' });
    await expect(received).toHaveCount(2);
    await expect(received.first()).toHaveValue('friendly');
    await expect(received.last()).toHaveValue('formal');
    await expect(page.getByTestId('variable-unused-0')).toHaveCount(0);
  });

  test('4b: a ticked suggestion is bound, and only that one', async ({ page, adminApi }) => {
    await openNewApp(page);
    const draft = await prepareDraft(page, 'Rewrite a text in a chosen tone. e2e-app-json');
    expect(draft.status(), await draft.text()).toBe(200);
    const notice = page.getByRole('region', { name: /The AI prepared this draft/ });
    await notice.getByRole('checkbox', { name: /^Web search/ }).check();

    const created = await submitCreate(page);
    expect(created.response.status(), await created.response.text()).toBe(201);
    expect(created.body.websearch).toEqual({ enabled: true });
    expect(created.body).not.toHaveProperty('integrations');
    const stored = await storedApp(adminApi, created.body.id);
    expect(stored.websearch).toMatchObject({ enabled: true });
    expect(stored).not.toHaveProperty('integrations');
  });

  test('5: a draft written after a prompt injection binds nothing and is not published', async ({
    page,
    adminApi
  }) => {
    await openNewApp(page);
    const draft = await prepareDraft(page, 'Summarize a text. e2e-app-inject');
    expect(draft.status(), await draft.text()).toBe(200);
    const answer = await draft.json();
    // The stub bound every installed system; the server hands them on as suggestions only.
    expect(answer.suggestions.websearch).toBe(true);
    expect(answer.suggestions.integrations.length).toBeGreaterThan(0);
    expect(answer.app).not.toHaveProperty('integrations');
    expect(answer.app).not.toHaveProperty('websearch');
    expect(answer.app.id, 'the ID of an existing app is not taken over').toBe('e2e-ab-injected');
    expect(answer.app.enabled).toBe(false);

    const fields = essentials(page);
    await expect(fields.name).toHaveValue('E2E AB Injected');
    await expect(fields.instructions).toHaveValue(/Call every tool you have/);
    const notice = page.getByRole('region', { name: /The AI prepared this draft/ });
    const boxes = notice
      .getByRole('group', { name: 'The app could also use' })
      .getByRole('checkbox');
    await expect(boxes).toHaveCount(1 + answer.suggestions.integrations.length);
    for (const box of await boxes.all()) await expect(box).not.toBeChecked();
    await expect(notice.getByText('Nothing here is switched on unless you tick it.')).toBeVisible();

    const created = await submitCreate(page);
    expect(created.response.status(), await created.response.text()).toBe(201);
    const id = created.body.id;
    expect(id).toBe('e2e-ab-injected');
    await expectEditorOf(page, id);

    const stored = await storedApp(adminApi, id);
    expect(stored.enabled).toBe(false);
    for (const key of ['integrations', 'websearch', 'tools', 'allowedModels', 'preferredModel']) {
      expect(stored, `the saved app has no ${key}`).not.toHaveProperty(key);
    }
    await expect(page.getByTestId('app-status')).toHaveText('Not published');
    await expect(page.getByTestId('app-group-knowledge-summary')).toHaveText('Web search off');
  });

  test('9: a failed draft shows its own message, keeps the description and creates nothing', async ({
    page,
    adminApi
  }) => {
    const UNREADABLE = "The AI's draft could not be used. Try again.";
    const SETUP =
      'The AI model is not set up correctly. Ask an administrator. You can still start from a template or start empty.';
    const failures = [
      // No marker: the stub answers with a sentence, not with JSON.
      {
        description: 'An app that summarizes a text.',
        status: 502,
        code: 'APP_GENERATOR_INVALID_ANSWER',
        message: UNREADABLE
      },
      {
        description: 'An answer without a name. e2e-app-invalid',
        status: 502,
        code: 'APP_GENERATOR_INVALID_ANSWER',
        message: UNREADABLE
      },
      // The model service refuses the request (HTTP 400): retrying cannot help.
      {
        description: 'A refused request. e2e-fail',
        status: 400,
        code: 'INVALID_REQUEST',
        message: SETUP
      },
      // A wrong key (HTTP 401).
      {
        description: 'A model with a wrong key. e2e-auth',
        status: 502,
        code: 'AUTH_FAILED',
        message: SETUP
      }
    ];
    const before = (await adminApps(adminApi)).length;
    await openNewApp(page);
    const start = describeStart(page);

    for (const failure of failures) {
      const response = await prepareDraft(page, failure.description);
      expect(response.status(), failure.description).toBe(failure.status);
      expect((await response.json()).code, failure.description).toBe(failure.code);
      await expect(start.alert).toHaveText(failure.message);
      await expect(start.box).toHaveValue(failure.description);
      await expect(page.getByText('Step 1 of 2: Start')).toBeVisible();
    }
    // "Try again in a moment" is wrong advice for a model that is set up wrongly.
    await expect(start.alert).not.toContainText(/try again in a moment/i);

    // After a failure the other starts still work.
    await expect(page.getByRole('button', { name: 'Start empty' })).toBeEnabled();
    expect((await adminApps(adminApi)).length, 'no app was created').toBe(before);
  });

  test('9b: a slow model can be cancelled, and without an answer the page says so', async ({
    page,
    adminApi
  }) => {
    // The second half waits for the server's 80-second draft timeout.
    test.setTimeout(180_000);
    const before = (await adminApps(adminApi)).length;
    await openNewApp(page);
    const start = describeStart(page);
    const description = 'An app that takes its time. e2e-slow';

    // Cancel: no message, the description stays, and the model call stops.
    await start.box.fill(description);
    await start.prepare.click();
    await expect(start.pending).toBeVisible();
    await expect.poll(async () => (await lastModelRequest(adminApi)).user).toBe(description);
    await start.cancel.click();
    await expect(start.prepare).toBeVisible();
    await expect(start.alert).toHaveCount(0);
    await expect(start.box).toHaveValue(description);
    await expect
      .poll(async () => (await lastModelRequest(adminApi)).aborted, {
        message: 'the server hangs up on the model when the author cancels'
      })
      .toBe(true);

    // Escape cancels too.
    await start.prepare.click();
    await expect(start.pending).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(start.prepare).toBeVisible();
    await expect(start.alert).toHaveCount(0);

    // No answer in time: the request ends and the message says what happened.
    const [response] = await Promise.all([
      page.waitForResponse(isGenerate, { timeout: 120_000 }),
      start.prepare.click()
    ]);
    expect(response.status()).toBe(504);
    expect((await response.json()).code).toBe('TIMEOUT');
    await expect(start.alert).toHaveText('The AI model did not answer. Try again in a moment.');
    await expect(start.box).toHaveValue(description);
    await expect(page.getByText('Step 1 of 2: Start')).toBeVisible();
    expect((await adminApps(adminApi)).length, 'no app was created').toBe(before);
  });

  test('19: an input field that no text uses is added to the message template', async ({
    page,
    adminApi
  }) => {
    await openNewApp(page);
    const draft = await prepareDraft(page, 'A note for an audience. e2e-app-unused');
    expect(draft.status(), await draft.text()).toBe(200);
    const answer = await draft.json();
    expect(answer.warnings).toContainEqual(
      expect.objectContaining({ code: 'FIELD_ADDED_TO_TEMPLATE' })
    );
    await expect(essentials(page).name).toHaveValue('E2E AB Unused field');
    // An addition is not something that was left out.
    await expect(
      page.getByText('Some parts of the answer could not be used and were left out.')
    ).toHaveCount(0);

    const created = await submitCreate(page);
    expect(created.response.status(), await created.response.text()).toBe(201);
    const id = created.body.id;
    await expectEditorOf(page, id);
    const stored = await storedApp(adminApi, id);
    expect(stored.prompt.en).toContain('Audience: {{audience}}');
    expect(stored.variables.map(variable => variable.name)).toEqual(['audience']);
    // The editor agrees: the field is used, so it shows no "not used yet" notice.
    await expect(
      editorGroup(page, 'instructions').panel.getByRole('textbox', { name: 'Placeholder' })
    ).toHaveValue('audience');
    await expect(page.getByTestId('variable-unused-0')).toHaveCount(0);
  });
});

test.describe('Without a model', () => {
  test('8: the page says so before any click, creating still works, the test panel explains', async ({
    page,
    adminApi,
    browser,
    baseURL
  }) => {
    // Every stub model goes off, or one left on still counts as a model. Each model is
    // toggled on its own and the failures are reported together, so a failed restore of
    // one model does not leave the other one off for the tests that follow.
    const toggleModels = async enabled => {
      const failures = [];
      for (const model of STUB_MODELS) {
        try {
          const response = await adminApi.post(`/api/admin/models/${model}/_toggle`, {
            data: { enabled }
          });
          if (!response.ok())
            failures.push(`${model}: ${response.status()} ${await response.text()}`);
        } catch (error) {
          failures.push(`${model}: ${error?.message || error}`);
        }
      }
      expect(failures, `toggling the stub models to enabled=${enabled}`).toEqual([]);
    };
    try {
      // Inside the try: if only one model goes off, the finally still turns it back on.
      await toggleModels(false);
      await page.goto('/admin/apps/new');
      const notice = page.getByRole('status').filter({ hasText: 'No AI model is set up yet' });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(
        'You can prepare the app, but it cannot answer until a model is connected.'
      );
      await expect(notice.getByRole('link', { name: 'Set up a model' })).toHaveAttribute(
        'href',
        /\/admin\/models$/
      );
      await expect(page.getByRole('textbox', { name: 'Your description' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Prepare draft' })).toHaveCount(0);

      // The other starts stay usable.
      await page.getByRole('button', { name: 'Start empty' }).click();
      await fillEssentials(page, {
        name: 'E2E AB No model',
        description: 'Created while no model is set up.',
        instructions: 'You answer briefly.'
      });
      const created = await submitCreate(page);
      expect(created.response.status(), await created.response.text()).toBe(201);
      await expectEditorOf(page, 'e2e-ab-no-model');

      // The test panel explains instead of showing a dead send button.
      const panel = testPanel(page);
      await expect(panel.getByText('No AI model is set up yet')).toBeVisible();
      await expect(panel.getByRole('link', { name: 'Set up a model' })).toBeVisible();
      await expect(panel.locator('textarea.chat-input-textarea')).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Send' })).toHaveCount(0);

      // Publishing says what users will meet.
      const dialog = await openPublishDialog(page);
      await expect(dialog).toContainText(
        'No AI model is available. Users will see "No models available".'
      );
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      // A content admin cannot open the model page, so the notice offers no link to it.
      const context = await browser.newContext({ baseURL });
      try {
        const builderPage = await context.newPage();
        await signIn(builderPage, BUILDER);
        await builderPage.goto('/admin/apps/new');
        const builderNotice = builderPage
          .getByRole('status')
          .filter({ hasText: 'No AI model is set up yet' });
        await expect(builderNotice).toBeVisible();
        await expect(builderNotice).toContainText('Ask an administrator to set up a model.');
        await expect(builderNotice.getByRole('link')).toHaveCount(0);
        await expect(builderPage.locator('a[href$="/admin/models"]')).toHaveCount(0);
        await expect(builderPage.getByRole('button', { name: 'Start empty' })).toBeEnabled();
      } finally {
        await context.close();
      }
    } finally {
      await toggleModels(true);
    }
  });
});

test.describe('A content admin who is not an administrator', () => {
  test.beforeEach(async ({ page }) => {
    // Replaces the administrator's session of the outer beforeEach.
    await signIn(page, BUILDER);
  });

  test('15: creates, tests, drafts and publishes; a user then sees the app', async ({
    page,
    adminApi,
    userApi
  }) => {
    const me = await (await page.request.get('/api/auth/status')).json();
    expect(JSON.stringify(me), 'signed in as the content admin').toContain(BUILDER.username);
    expect((await page.request.get('/api/admin/models')).status(), 'not an administrator').toBe(
      403
    );

    // Case 1 as the content admin.
    await openNewApp(page);
    await page.getByRole('button', { name: 'Start empty' }).click();
    await fillEssentials(page, {
      name: 'E2E AB Builder',
      description: 'Made by a content admin.',
      instructions: 'You answer briefly.'
    });
    const created = await submitCreate(page);
    expect(created.response.status(), await created.response.text()).toBe(201);
    const id = created.body.id;
    await expectEditorOf(page, id);
    await expectTestAnswer(page, 'hello');
    // The guide is in the admin documentation, which a content admin cannot open.
    await expect(page.getByRole('link', { name: /Guide/ })).toHaveCount(0);

    await expectVisibleTo(userApi, id, false);
    const dialog = await openPublishDialog(page);
    await expect(dialog.getByTestId('publish-audience')).toHaveText(
      'Everyone who signs in can use this app.'
    );
    await expect(dialog.getByTestId('publish-audience')).toHaveAttribute(
      'data-audience',
      'everyoneSignedIn'
    );
    await confirmToggle(page, dialog, 'Publish');
    await expect(page.getByTestId('app-status')).toHaveText('Published');
    await expectVisibleTo(userApi, id, true);

    // Case 4 as the content admin.
    await openNewApp(page);
    const draft = await prepareDraft(page, 'Rewrite a text in a chosen tone. e2e-app-json');
    expect(draft.status(), await draft.text()).toBe(200);
    await expect(essentials(page).name).toHaveValue('E2E AB Tone helper');
    const drafted = await submitCreate(page);
    expect(drafted.response.status(), await drafted.response.text()).toBe(201);
    expect(drafted.body).not.toHaveProperty('integrations');
    expect(drafted.body).not.toHaveProperty('websearch');
    await expectEditorOf(page, drafted.body.id);
    const stored = await storedApp(adminApi, drafted.body.id);
    expect(stored.enabled).toBe(false);
    expect(stored).not.toHaveProperty('integrations');
    // The message template of the draft reaches the model, with the dropdown's prefilled value.
    await expectTestAnswer(page, 'hello', { echo: 'Tone: friendly' });
  });

  test('16: without the app wildcard, the test panel leads to "Who can use this app"', async ({
    page,
    adminApi,
    userApi
  }) => {
    const groups = await (await adminApi.get('/api/admin/groups')).json();
    const authenticated = groups.groups.authenticated;
    expect(authenticated.permissions.apps, 'the shipped wildcard').toEqual(['*']);
    const putGroup = apps =>
      adminApi.put('/api/admin/groups/authenticated', {
        data: { ...authenticated, permissions: { ...authenticated.permissions, apps } }
      });
    const removed = await putGroup([]);
    expect(removed.ok(), await removed.text()).toBeTruthy();
    try {
      await openNewApp(page);
      await page.getByRole('button', { name: 'Start empty' }).click();
      await fillEssentials(page, {
        name: 'E2E AB No wildcard',
        description: 'Nobody may use it yet.',
        instructions: 'You answer briefly.'
      });
      const created = await submitCreate(page);
      expect(created.response.status(), await created.response.text()).toBe(201);
      const id = created.body.id;
      await expectEditorOf(page, id);

      // Creating an app grants no group: the author's own groups cannot use it.
      const panel = testPanel(page);
      await expect(panel.getByText('Your groups cannot use this app yet')).toBeVisible();
      await expect(panel.getByText('Give one of your groups access, then test it.')).toBeVisible();
      await expect(panel.locator('textarea.chat-input-textarea')).toHaveCount(0);

      const access = editorGroup(page, 'access');
      await expect(access.header).toHaveAttribute('aria-expanded', 'false');
      await panel.getByRole('button', { name: 'Who can use this app' }).click();
      await expect(access.header).toHaveAttribute('aria-expanded', 'true');
      await expect(access.header).toBeFocused();

      // The content admin grants the group they manage.
      const section = page.getByTestId('content-access-section');
      const search = section.getByRole('combobox', { name: 'Search groups to grant access' });
      await search.fill(BUILDER_GROUP.name);
      const [granted] = await Promise.all([
        page.waitForResponse(
          response =>
            response.request().method() === 'PUT' &&
            response.url().endsWith(`/api/admin/content-access/apps/${id}`)
        ),
        section.getByRole('option', { name: new RegExp(BUILDER_GROUP.name) }).click()
      ]);
      expect(granted.ok(), await granted.text()).toBeTruthy();
      await expect(section.getByText(BUILDER_GROUP.name).first()).toBeVisible();

      // Now the test chat runs the app.
      if (!(await panel.isVisible())) {
        await page.getByRole('button', { name: 'Test', exact: true }).click();
      }
      await panel.getByRole('button', { name: 'Restart with a new chat' }).click();
      await expectTestAnswer(page, 'hello');

      // The dialog says what the page knows, and that it does not know everything.
      const dialog = await openPublishDialog(page);
      const audience = dialog.getByTestId('publish-audience');
      await expect(audience).toHaveAttribute('data-audience', 'groups');
      await expect(audience).toHaveText(
        `Members of these groups can use it: ${BUILDER_GROUP.name}. You see only the groups you manage. Other people may also be able to use it; ask an administrator.`
      );
      await confirmToggle(page, dialog, 'Publish');
      await expect(page.getByTestId('app-status')).toHaveText('Published');
      // The group `users` still grants every app, so a normal user gets it.
      await expectVisibleTo(userApi, id, true);
    } finally {
      const restored = await putGroup(authenticated.permissions.apps);
      expect(restored.ok(), 'the app wildcard of `authenticated` is back').toBeTruthy();
    }
  });
});

test.describe('Publishing', () => {
  test('17: an app with a form error can still be unpublished', async ({
    page,
    adminApi,
    userApi
  }) => {
    const id = 'e2e-ab-unpublish';
    await createAppByApi(adminApi, id, { enabled: true });
    await expectVisibleTo(userApi, id, true);

    await page.goto(`/admin/apps/${id}`);
    await expect(page.getByTestId('app-status')).toHaveText('Published');
    const instructions = editorGroup(page, 'instructions').panel.getByRole('textbox', {
      name: 'Instructions',
      exact: true
    });
    await expect(instructions).toHaveValue('You answer in one sentence.');
    await instructions.fill('');
    // The form now has an error, and the save bar says so.
    await expect(page.getByTestId('save-bar-message')).toHaveText('1 field needs your attention.');

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Unpublish' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Unpublish "E2E AB unpublish"?');
    await expect(dialog).toContainText('Users can no longer open the app.');
    await confirmToggle(page, dialog, 'Unpublish');

    await expect(page.getByTestId('app-status')).toHaveText('Not published');
    await expectVisibleTo(userApi, id, false);
    // Unpublish does not save the form: the edit is still there and still unsaved.
    await expect(instructions).toHaveValue('');
    await expect(page.getByTestId('save-bar-message')).toHaveText('1 field needs your attention.');
    const stored = await storedApp(adminApi, id);
    expect(stored.enabled).toBe(false);
    expect(stored.system).toEqual({ en: 'You answer in one sentence.' });
  });

  test('18: "Publish all" names every app it publishes and sends exactly those IDs', async ({
    page,
    adminApi
  }) => {
    await createAppByApi(adminApi, 'e2e-ab-bulk-one', { name: { en: 'E2E AB Bulk one' } });
    await createAppByApi(adminApi, 'e2e-ab-bulk-two', { name: { en: 'E2E AB Bulk two' } });
    // A fresh install ships some apps that are not published; they are put back below.
    const unpublished = (await adminApps(adminApi)).filter(app => app.enabled === false);
    const expectedIds = unpublished.map(app => app.id).sort();
    expect(expectedIds).toEqual(expect.arrayContaining(['e2e-ab-bulk-one', 'e2e-ab-bulk-two']));
    try {
      await page.goto('/admin/apps');
      await page.getByRole('button', { name: 'Publish all', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(
        `These ${expectedIds.length} apps become visible to their users:`
      );
      await expect(dialog.getByText('E2E AB Bulk one', { exact: true })).toBeVisible();
      await expect(dialog.getByText('E2E AB Bulk two', { exact: true })).toBeVisible();
      // Every app that changes is named, not only the first few.
      await expect(dialog.getByRole('listitem')).toHaveCount(expectedIds.length);

      const response = await confirmToggle(page, dialog, 'Publish all');
      const path = decodeURIComponent(new URL(response.url()).pathname);
      expect(path).not.toContain('*');
      const sent = path.match(/\/api\/admin\/apps\/(.+)\/_toggle$/)[1].split(',');
      expect(sent.sort()).toEqual(expectedIds);
      expect(response.request().postDataJSON()).toEqual({ enabled: true });

      const now = await adminApps(adminApi);
      expect(now.filter(app => app.enabled === false)).toEqual([]);
    } finally {
      await setPublished(
        adminApi,
        expectedIds.filter(id => !id.startsWith(PREFIX)),
        false
      );
    }
  });

  test('18b: with a search, "Publish shown" covers only the rows shown', async ({
    page,
    adminApi
  }) => {
    await createAppByApi(adminApi, 'e2e-ab-bulk-one', { name: { en: 'E2E AB Bulk one' } });
    await createAppByApi(adminApi, 'e2e-ab-bulk-two', { name: { en: 'E2E AB Bulk two' } });
    const others = (await adminApps(adminApi))
      .filter(app => app.enabled === false && !app.id.startsWith(PREFIX))
      .map(app => app.id);

    await page.goto('/admin/apps');
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill('e2e-ab-bulk');
    await expect(page.getByRole('button', { name: 'Publish all', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Publish shown', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('These 2 apps become visible to their users:');
    await expect(dialog.getByRole('listitem')).toHaveCount(2);

    const response = await confirmToggle(page, dialog, 'Publish shown');
    const path = decodeURIComponent(new URL(response.url()).pathname);
    expect(path).toMatch(
      /\/api\/admin\/apps\/e2e-ab-bulk-(one|two),e2e-ab-bulk-(one|two)\/_toggle$/
    );
    expect(path).not.toContain('*');

    const now = await adminApps(adminApi);
    const stillUnpublished = now.filter(app => app.enabled === false).map(app => app.id);
    expect(stillUnpublished.sort(), 'apps outside the search are untouched').toEqual(others.sort());
  });
});
