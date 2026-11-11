// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomBytes } from 'node:crypto';

/**
 * End-to-end: the AI-use acknowledgement in the embedded roots (step 8 of epic
 * #3324).
 *
 * - `?embed=true` mounts the full web app in a frame (iFinder, Nextcloud, Teams use it).
 * - `/extension/sidepanel.html` is the real `OfficeApp` root that the Outlook pane,
 *   its pop-out window and the browser extension share. Only the `chrome` global is
 *   stubbed (as the extension runtime would provide it) and a bearer token is
 *   seeded; Outlook itself cannot be driven here.
 *
 * Signs in as the default local admin. Real Office, Teams and Chrome hosts are not
 * covered: see the manual matrix of the pull request.
 */

const ADMIN = { username: 'admin', password: 'password123' };
const POLICY = 'https://policy.example.org/ai';

test.describe('AI-use acknowledgement in embedded roots', () => {
  test.describe.configure({ mode: 'serial' });

  const setPlatform = async (page, patch) => {
    const platform = await (await page.request.get('/api/admin/configs/platform')).json();
    platform.aiAcknowledgement = { ...platform.aiAcknowledgement, ...patch };
    const saved = await page.request.post('/api/admin/configs/platform', { data: platform });
    expect(saved.ok(), 'save the platform config').toBeTruthy();
  };

  const removeAll = async page => {
    const removed = await page.request.delete('/api/admin/ai-acknowledgements');
    expect(removed.status()).toBe(204);
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
    await setPlatform(page, { enabled: true, enforce: true, policyUrl: POLICY });
    await removeAll(page);
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    if (login.ok()) await setPlatform(page, { enabled: false, policyUrl: '' });
    await context.close();
  });

  const dialogOf = page => page.getByRole('dialog', { name: 'Confirm your use of AI' });

  test('?embed=true: the dialog blocks the first message and Cancel keeps the draft', async ({
    page
  }) => {
    const models = page.waitForResponse(
      response => response.url().includes('/api/models') && response.ok()
    );
    await page.goto('/apps/chat?embed=true');
    await models;
    await page.waitForLoadState('networkidle');

    const input = page.getByRole('textbox', { name: 'Type your message' });
    await input.fill('Embedded hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialogOf(page)).toBeVisible();
    await expect(input).toHaveValue('Embedded hello');

    await dialogOf(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(input).toHaveValue('Embedded hello');
    // Embed mode renders the note in two chat layouts; the visible one counts.
    await expect(page.getByTestId('ai-ack-note').filter({ visible: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await dialogOf(page).getByRole('button', { name: 'Confirm and send' }).click();
    await expect(
      page.getByText('E2E reply to: Embedded hello (turn 1)').filter({ visible: true }).first()
    ).toBeVisible({ timeout: 30_000 });
  });

  test.describe('OfficeApp root (extension side panel page)', () => {
    // The panel page at a phone-pane width, as a pinned Outlook pane is.
    test.use({ viewport: { width: 360, height: 640 } });

    const openPanel = async page => {
      const cookies = await page.context().cookies();
      const token = cookies.find(cookie => cookie.name === 'authToken')?.value;
      expect(token, 'the sign-in cookie carries the token').toBeTruthy();
      const apps = await (await page.request.get('/api/apps')).json();
      const chat = (Array.isArray(apps) ? apps : apps.items || []).find(a => a.id === 'chat');
      expect(chat, 'the chat app').toBeTruthy();

      await page.addInitScript(
        ({ origin, jwt, app }) => {
          window.IHUB_RUNTIME_CONFIG = {
            baseUrl: origin,
            clientId: 'e2e-extension',
            displayName: {},
            description: {},
            starterPrompts: []
          };
          // What the extension runtime provides; nothing here talks to a browser.
          window.__opened = [];
          window.chrome = {
            runtime: { id: 'e2e' },
            storage: { local: { get: async () => ({}), set: async () => undefined } },
            identity: { getRedirectURL: () => 'https://e2e.chromiumapp.org/' },
            tabs: {
              create: ({ url }) => {
                window.__opened.push(url);
                return Promise.resolve({});
              },
              query: async () => []
            },
            scripting: { executeScript: async () => [] }
          };
          window.localStorage.setItem('office_ihubtoken', jwt);
          window.localStorage.setItem(
            'office_ihubuser',
            JSON.stringify({ id: 'admin', name: 'Admin' })
          );
          window.sessionStorage.setItem('office_ihubselectedapp', JSON.stringify(app));
        },
        {
          origin: new URL(page.url() === 'about:blank' ? 'http://localhost:5173' : page.url())
            .origin,
          jwt: token,
          app: chat
        }
      );
      await page.goto('/extension/sidepanel.html');
    };

    const composer = page => page.getByRole('textbox', { name: 'Type your message' });

    test('asks before the first message; the policy opens through the host; Cancel keeps the draft', async ({
      page
    }) => {
      await openPanel(page);
      await composer(page).fill('Panel hello');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();
      // Signed in through OAuth, never a guest: no "this browser session only" line.
      await expect(dialog).not.toContainText('this browser session only');
      await expect(composer(page)).toHaveValue('Panel hello');

      // chrome.tabs.create, not a dead target=_blank link.
      await dialog.getByRole('link', { name: /Read the AI policy/ }).click();
      expect(await page.evaluate(() => window.__opened)).toEqual([POLICY]);
      await expect(dialog).toBeVisible();

      // No horizontal scroll at 360 px, buttons reachable.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(overflow).toBe(false);
      await expect(dialog.getByRole('button', { name: 'Confirm and send' })).toBeInViewport();

      // No serious or critical axe findings in the open dialog, light and dark.
      for (const dark of [false, true]) {
        await page.evaluate(isDark => {
          document.documentElement.classList.toggle('dark', isDark);
          document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
        }, dark);
        const results = await new AxeBuilder({ page })
          .include('[role="dialog"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const blocking = results.violations.filter(v => ['serious', 'critical'].includes(v.impact));
        expect(
          blocking.map(v => v.id),
          dark ? 'dark' : 'light'
        ).toEqual([]);
      }

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(composer(page)).toHaveValue('Panel hello');
      await expect(page.getByTestId('ai-ack-note')).toBeVisible();
      // Back in the composer, not on the page body.
      await expect(composer(page)).toBeFocused();
    });

    test('Confirm sends the same message; the "AI-use notice" entry then shows the text read-only', async ({
      page
    }) => {
      await openPanel(page);
      await composer(page).fill('Panel again');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await dialogOf(page).getByRole('button', { name: 'Confirm and send' }).click();
      await expect(
        // The pane sends the app's system prompt too, so the stub echoes it before the text.
        page
          .getByText(/Panel again \(turn 1\)/)
          .filter({ visible: true })
          .first()
      ).toBeVisible({ timeout: 30_000 });

      // The confirmation is on the user's record, written through the bearer token.
      const mine = await (await page.request.get('/api/ai-acknowledgements/me')).json();
      expect(mine.acknowledged).toBe(true);
      expect(mine.policyUrl).toBe(POLICY);

      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('button', { name: 'AI-use notice' }).click();
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
    });
  });
});

/**
 * The server side of the same decision: the Outlook add-in's real delegated OAuth
 * token (authorization code + PKCE, public client) is gated as a person. Before
 * step 8 it carried a `clientId`, counted as a machine and never got a 428.
 */
test.describe('Office add-in OAuth token (delegated, PKCE)', () => {
  test.describe.configure({ mode: 'serial' });

  const bearerHeaders = token => ({ Authorization: `Bearer ${token}` });
  const chatUrl = '/api/apps/chat/chat/chat-e2e-office-ack';

  async function mintOfficeToken(page) {
    const enabled = await page.request.post('/api/admin/office-integration/_enable');
    expect(enabled.ok(), 'enable the Office integration').toBeTruthy();
    const status = await (await page.request.get('/api/admin/office-integration/status')).json();
    const clientId = status.oauthClientId;
    expect(clientId).toBeTruthy();

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = `${new URL(page.url() === 'about:blank' ? 'http://localhost:5173' : page.url()).origin}/office/callback.html`;
    const authorize = await page.request.get('/api/oauth/authorize', {
      params: {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state: 'e2e',
        code_challenge: challenge,
        code_challenge_method: 'S256'
      },
      maxRedirects: 0
    });
    expect(authorize.status(), 'authorize redirects with a code').toBe(302);
    const code = new URL(authorize.headers().location).searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await page.request.post('/api/oauth/token', {
      data: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier
      }
    });
    expect(token.ok(), 'exchange the code').toBeTruthy();
    return (await token.json()).access_token;
  }

  test('428 until confirmed, absolute policy link, the client is recorded', async ({
    page,
    playwright,
    baseURL
  }) => {
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok()).toBeTruthy();
    const platform = await (await page.request.get('/api/admin/configs/platform')).json();
    platform.aiAcknowledgement = {
      ...platform.aiAcknowledgement,
      enabled: true,
      enforce: true,
      policyUrl: '/page/ai-policy'
    };
    expect(
      (await page.request.post('/api/admin/configs/platform', { data: platform })).ok()
    ).toBeTruthy();
    expect((await page.request.delete('/api/admin/ai-acknowledgements')).status()).toBe(204);

    const accessToken = await mintOfficeToken(page);
    // No cookie: only the bearer token, as the add-in sends it.
    const office = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: bearerHeaders(accessToken)
    });
    try {
      const refused = await office.post(chatUrl, { data: { messages: [] } });
      expect(refused.status()).toBe(428);
      expect((await refused.json()).code).toBe('AI_ACKNOWLEDGEMENT_REQUIRED');

      const notice = await (await office.get('/api/ai-acknowledgements/me?language=en')).json();
      expect(notice.acknowledged).toBe(false);
      expect(notice.policyUrl).toBe(`${baseURL}/page/ai-policy`);
      expect(notice.appUrl).toBe(baseURL);

      const confirmed = await office.post('/api/ai-acknowledgements/me', {
        data: {
          version: notice.requiredVersion,
          textHash: notice.textHash,
          language: notice.language
        }
      });
      expect(confirmed.status()).toBe(201);
      expect((await confirmed.json()).client).toBe('office');

      const after = await office.post(chatUrl, { data: { messages: [] } });
      expect(after.status()).not.toBe(428);
    } finally {
      await office.dispose();
      await page.request.delete('/api/admin/ai-acknowledgements');
      const restore = await (await page.request.get('/api/admin/configs/platform')).json();
      restore.aiAcknowledgement = {
        ...restore.aiAcknowledgement,
        enabled: false,
        policyUrl: ''
      };
      await page.request.post('/api/admin/configs/platform', { data: restore });
      await page.request.post('/api/admin/office-integration/_disable');
    }
  });
});
