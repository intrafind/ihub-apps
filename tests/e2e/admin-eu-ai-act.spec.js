// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import { startMockDetector } from '../../server/tests/helpers/mockWatermarkDetector.js';

/**
 * End-to-end: the EU AI Act overview page (#3329).
 *
 * Signs in as the default local admin (`admin` / `password123`). The watermark
 * detector is a tiny mock server started here (no live vLLM): the page must show
 * the detector chain red while no key exists, the detector is down or the token
 * is wrong, and green once everything answers. The self-test needs a model that
 * really applies the watermark, so it is only checked for "runs and reports in
 * words" here; the diagnosis logic has server unit tests.
 *
 * The keys and models are platform-wide state: never run these side by side.
 */

const ADMIN = { username: 'admin', password: 'password123' };
const MODEL_ID = 'e2e-eu-ai-act-vllm';
const CREDENTIAL_ID = 'e2e-eu-ai-act-detector';
const TOKEN = 'e2e-detector-token-123456';

test.describe('Admin EU AI Act page', () => {
  test.describe.configure({ mode: 'serial' });
  let mock;

  test.beforeAll(async () => {
    mock = await startMockDetector({ token: TOKEN });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
  });

  const status = async page => {
    const response = await page.request.get('/api/admin/eu-ai-act/status?refresh=true');
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const check = (body, id) =>
    body.checks.find(c => c.id === id && (!c.modelId || c.modelId === MODEL_ID));

  test('the status API is for admins only and carries no secret', async ({
    page,
    playwright,
    baseURL
  }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    const denied = await anonymous.get('/api/admin/eu-ai-act/status');
    expect([401, 403]).toContain(denied.status());
    await anonymous.dispose();

    const body = await status(page);
    expect(['ok', 'warn', 'error']).toContain(body.summary.level);
    expect(Array.isArray(body.checks)).toBeTruthy();
    for (const item of body.checks) {
      expect(item.id).toBeTruthy();
      expect(item.messageKey).toMatch(/^admin\.euAiAct\.checks\./);
    }
    expect(body.acknowledgements).toHaveProperty('counts');
    expect(JSON.stringify(body)).not.toMatch(/"(key|token|secret)"/);
  });

  test('the page loads with the five cards, shows real checks and the honesty note', async ({
    page
  }) => {
    await page.goto('/admin/eu-ai-act');
    await expect(page.getByRole('heading', { level: 1, name: /EU AI Act/ })).toBeVisible();
    for (const name of [
      'Configuration check',
      'Acknowledgements',
      'Watermark keys',
      'Provenance settings',
      'Verification'
    ]) {
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    }
    await expect(page.getByText(/not "legally compliant"/).first()).toBeVisible();
    await expect(page.locator('[data-check-id="guardrail.active"]')).toBeVisible();
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/Last checked/)).toBeVisible();
  });

  test('a model marked "iHub" gets key, detector and self-test rows; a rejecting detector is red', async ({
    page
  }) => {
    // A rerun on a server that kept the state of an earlier run.
    await page.request.delete(`/api/admin/models/${MODEL_ID}`);
    await page.request.delete(`/api/admin/credentials/${CREDENTIAL_ID}`);
    const credential = await page.request.post('/api/admin/credentials', {
      data: { id: CREDENTIAL_ID, type: 'bearer', token: TOKEN }
    });
    expect(
      credential.ok(),
      `create the detector credential: ${credential.status()} ${await credential.text()}`
    ).toBeTruthy();
    const model = await page.request.post('/api/admin/models', {
      data: {
        id: MODEL_ID,
        name: { en: 'E2E vLLM' },
        description: { en: 'E2E vLLM' },
        provider: 'local',
        modelId: 'e2e-model',
        url: 'http://127.0.0.1:9/v1/chat/completions',
        tokenLimit: 4096,
        enabled: true,
        contentMarking: {
          text: {
            by: 'ihub',
            scheme: 'vllm-gumbel',
            detectorUrl: mock.url,
            detectorCredentialRef: CREDENTIAL_ID
          }
        }
      }
    });
    expect(model.ok(), `create the model: ${model.status()} ${await model.text()}`).toBeTruthy();

    await page.goto('/admin/eu-ai-act');
    // The model has a row in the check list. ("No key" being red is a server unit test:
    // an active key cannot be deleted, so a rerun on a kept server always has one.)
    await expect(
      page.locator('[data-check-id="model.watermark.detector"]').filter({ hasText: 'E2E vLLM' })
    ).toBeVisible();

    // Generate a key: the key and the vLLM option are shown once.
    await page.getByRole('button', { name: 'Generate key' }).first().click();
    // With a key already active the page asks first (a rerun on a kept server).
    const confirm = page.getByRole('alertdialog');
    if (await confirm.isVisible())
      await confirm.getByRole('button', { name: 'Generate key' }).click();
    const dialog = page.getByRole('dialog', { name: /New watermark key/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('--watermark-config', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('--watermark-config')).toHaveCount(0);

    // The detector mock answers: key and detector rows are green, the self-test row asks to run it.
    let body = await status(page);
    expect(check(body, 'model.watermark.key').level).toBe('ok');
    expect(check(body, 'model.watermark.detector').level).toBe('ok');
    expect(check(body, 'model.watermark.selftest').level).toBe('warn');

    // A rejecting detector is red.
    mock.setMode('401');
    await new Promise(resolve => setTimeout(resolve, 5100)); // the refresh floor per detector
    body = await status(page);
    expect(check(body, 'model.watermark.detector').level).toBe('error');
    mock.setMode('ok');
  });

  test('rotation: the old key is retired and can be deleted after a confirmation', async ({
    page
  }) => {
    await page.goto('/admin/eu-ai-act#watermark-keys');
    await page.getByRole('button', { name: 'Generate key' }).first().click();
    // A key is active already: the pre-dialog names what becomes retired.
    await expect(page.getByText(/becomes retired/)).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Generate key' }).click();
    const dialog = page.getByRole('dialog', { name: /New watermark key/ });
    await dialog.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByText('Retired (detection only)').first()).toBeVisible();
    await page
      .getByRole('button', { name: /^Delete key wm-/ })
      .first()
      .click();
    await expect(page.getByText(/can no longer be recognised as watermarked/)).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete key' }).click();
    await expect(page.getByRole('status').filter({ hasText: /deleted/ })).toBeVisible();
  });

  test('reveal shows the key and records it, and the key leaves the page when closed', async ({
    page
  }) => {
    await page.goto('/admin/eu-ai-act#watermark-keys');
    await page
      .getByRole('button', { name: /^Reveal key wm-/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: /Watermark key wm-/ });
    await expect(dialog.locator('pre').first()).toHaveText(/^\d+$/);
    await expect(page.getByText(/recorded in the audit log/).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('pre')).toHaveCount(0);
  });

  test('self-test runs and reports in words', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/admin/eu-ai-act#watermark-keys');
    await page.getByRole('button', { name: `Run self-test ${MODEL_ID}` }).click();
    // The e2e model is not a real vLLM, so the test fails or errors: either way the page
    // answers with a level badge and a sentence, never silence.
    await expect(page.locator('[role="status"] [data-level]').first()).toBeVisible({
      timeout: 90_000
    });
  });

  test('acknowledgements: counts, export downloads a CSV, request again raises the version', async ({
    page
  }) => {
    // The e2e contents switch the feature off (tests/config/e2e-contents.mjs): turn it on
    // for this test and off again at the end, like ai-acknowledgement.spec.js.
    const setEnabled = async enabled => {
      const platform = await (await page.request.get('/api/admin/configs/platform')).json();
      platform.aiAcknowledgement = { ...platform.aiAcknowledgement, enabled, enforce: true };
      const saved = await page.request.post('/api/admin/configs/platform', { data: platform });
      expect(saved.ok(), 'save the platform config').toBeTruthy();
    };
    await setEnabled(true);
    try {
      await page.goto('/admin/eu-ai-act');
      const card = page.getByRole('region', { name: 'Acknowledgements' });
      await expect(card.getByText('Acknowledged', { exact: true })).toBeVisible();
      await expect(card.getByText('Pending', { exact: true })).toBeVisible();
      const before = await card.getByText(/Enforced, version \d+/).textContent();
      const version = Number(/version (\d+)/.exec(before)[1]);

      await card.getByRole('button', { name: 'AI acknowledgements' }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: 'Export CSV' }).click();
      expect((await download).suggestedFilename()).toBe('ai-acknowledgements.csv');

      await card.getByRole('button', { name: 'AI acknowledgements' }).click();
      await page.getByRole('menuitem', { name: 'Request again' }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Ask everyone again' })
        .click();
      await expect(card.getByText(new RegExp(`Enforced, version ${version + 1}`))).toBeVisible();
    } finally {
      await setEnabled(false);
    }
  });

  test('rollback: Make active swaps the keys after a confirmation that names the consequences', async ({
    page
  }) => {
    // Make sure a retired key exists: a new key retires the active one.
    expect((await page.request.post('/api/admin/watermark-keys', { data: {} })).ok()).toBeTruthy();
    await page.goto('/admin/eu-ai-act#watermark-keys');
    const before = await (await page.request.get('/api/admin/watermark-keys')).json();
    const retired = before.items.find(k => k.status === 'retired');
    const current = before.items.find(k => k.status === 'active');
    expect(retired, 'an earlier test left a retired key').toBeTruthy();

    await page.getByRole('button', { name: `Make key ${retired.keyId} active` }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`${current.keyId} becomes retired`);
    await expect(dialog).toContainText('--watermark-config');
    await expect(dialog).toContainText('mismatch');
    await expect(dialog).toContainText('outdated');
    // Nothing happened yet.
    let now = await (await page.request.get('/api/admin/watermark-keys')).json();
    expect(now.items.find(k => k.keyId === retired.keyId).status).toBe('retired');

    await dialog.getByRole('button', { name: 'Make active' }).click();
    await expect(page.getByText(`Key ${retired.keyId} is now active`)).toBeVisible();
    now = await (await page.request.get('/api/admin/watermark-keys')).json();
    expect(now.items.find(k => k.keyId === retired.keyId).status).toBe('active');
    expect(now.items.find(k => k.keyId === current.keyId).status).toBe('retired');
    // The key value stays out of the page until it is revealed.
    expect(await page.content()).not.toContain('"algorithm"');
    await page.getByRole('button', { name: 'Show key and vLLM option' }).click();
    await expect(page.getByRole('dialog')).toContainText('"algorithm"');
  });

  test('provenance settings: validation, a consequence note, save and persistence', async ({
    page
  }) => {
    const read = async () =>
      (await (await page.request.get('/api/admin/configs/platform')).json()).provenance;
    const original = await read();
    try {
      await page.goto('/admin/eu-ai-act#provenance-settings');
      const retention = page.getByLabel(/Keep records for/);
      await expect(retention).toBeVisible();

      await retention.fill('-1');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(retention).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#provenance-retentionDays-error')).toContainText('0 or more');

      // A lowered retention asks first; cancelling changes nothing.
      await retention.fill('1');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('deleted at the next daily clean-up');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect((await read()).retentionDays).toBe(original.retentionDays);

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Settings saved/)).toBeVisible();
      const saved = await read();
      expect(saved.retentionDays).toBe(1);
      // What the form does not own is untouched.
      expect(saved.media).toEqual(original.media);
      expect(saved.verify).toEqual(original.verify);
    } finally {
      await page.request.post('/api/admin/configs/platform', {
        data: {
          ...(await (await page.request.get('/api/admin/configs/platform')).json()),
          provenance: { retentionDays: original.retentionDays }
        }
      });
    }
  });

  test('verification: paste a text, upload an image', async ({ page }) => {
    await page.goto('/admin/eu-ai-act#verification');
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeDisabled();
    await page.getByLabel('Text to check').fill('A text that this installation never produced.');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('Not found').first()).toBeVisible();
    await expect(page.getByText(/not proof/).first()).toBeVisible();

    await page.getByLabel('Image or audio file').check();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    await page
      .locator('#verify-file')
      .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('Content credentials (C2PA)')).toBeVisible();
    await expect(page.getByText(/not proof|proves nothing/).first()).toBeVisible();
  });

  test('cleanup: remove the e2e model, credential and keys', async ({ page }) => {
    await page.request.delete(`/api/admin/models/${MODEL_ID}`);
    await page.request.delete(`/api/admin/credentials/${CREDENTIAL_ID}`);
    const keys = await (await page.request.get('/api/admin/watermark-keys')).json();
    for (const key of keys.items.filter(k => k.status === 'retired')) {
      await page.request.delete(`/api/admin/watermark-keys/${key.keyId}`);
    }
  });
});
