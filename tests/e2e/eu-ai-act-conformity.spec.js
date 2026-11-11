// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: the EU AI Act master switch (step 9 of epic #3324).
 *
 * Signs in as the default local admin (`admin` / `password123`). The switch is
 * platform-wide state, so the specs run serially and the afterAll puts it back on.
 * Acknowledgements are switched on for the run (the e2e contents ship them off) and
 * off again at the end.
 *
 * What it proves, in one flow: with the features on, a chat POST without
 * acknowledgement is a 428, the guardrail rule reaches the model and `_verify`
 * answers; after `_disable` the 428 is gone, the rule does not reach the model,
 * `_verify` is 403 FEATURE_DISABLED, the status page runs no checks, the public
 * config says off (and not who or why); after `_enable` all of it is back and the
 * acknowledgement that was given before is still there.
 *
 * Not covered here (unit tests in server/tests/euAiActConformityGates.test.js):
 * provenance headers and members on the inference API, and the vLLM `watermarking`
 * flag, which need an API key / a vLLM-style model this suite does not set up.
 */

const ADMIN = { username: 'admin', password: 'password123' };
const STUB_PORT = Number(process.env.E2E_LLM_PORT) || 8979;
const REASON = 'End-to-end test: the whole stack is exercised with the features off.';

test.describe('EU AI Act master switch', () => {
  test.describe.configure({ mode: 'serial' });

  const conformity = path => `/api/admin/eu-ai-act/conformity${path}`;
  const chatPost = page =>
    page.request.post('/api/apps/chat/chat/chat-e2e-conformity', { data: { messages: [] } });
  const lastStubBody = async page =>
    (await (await page.request.get(`http://127.0.0.1:${STUB_PORT}/__last-request`)).json()).body;

  const setAcknowledgements = async (page, enabled) => {
    const platform = await (await page.request.get('/api/admin/configs/platform')).json();
    platform.aiAcknowledgement = { ...platform.aiAcknowledgement, enabled, enforce: true };
    const saved = await page.request.post('/api/admin/configs/platform', { data: platform });
    expect(saved.ok(), 'save the platform config').toBeTruthy();
  };

  const ensureOn = async page => {
    const record = await (await page.request.get(conformity(''))).json();
    if (!record.enabled) {
      const res = await page.request.post(conformity('/_enable'), { data: {} });
      expect(res.ok(), 'switch the features on').toBeTruthy();
    }
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok(), 'sign in as the default admin').toBeTruthy();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const login = await page.request.post('/api/auth/local/login', { data: ADMIN });
    if (login.ok()) {
      await ensureOn(page);
      await setAcknowledgements(page, false);
      await page.request.delete('/api/admin/eu-ai-act/acknowledgements');
    }
    await context.close();
  });

  test('on: 428 without acknowledgement, the rule reaches the model, _verify answers', async ({
    page
  }) => {
    await ensureOn(page);
    await setAcknowledgements(page, true);
    expect((await page.request.delete('/api/admin/eu-ai-act/acknowledgements')).status()).toBe(204);

    const guarded = await chatPost(page);
    expect(guarded.status()).toBe(428);
    expect((await guarded.json()).code).toBe('AI_ACKNOWLEDGEMENT_REQUIRED');

    const pub = await (await page.request.get('/api/configs/platform')).json();
    expect(pub.euAiAct).toEqual({ enabled: true });
    expect(pub.aiAcknowledgement.enabled).toBe(true);
    expect(pub.aiDisclosure.firstTurnNotice.enabled).toBe(true);

    // Acknowledge, then run one real turn through the stub model.
    const notice = await (
      await page.request.get('/api/eu-ai-act/acknowledgements/me?language=en')
    ).json();
    expect(notice.acknowledged).toBe(false);
    const confirmed = await page.request.post('/api/eu-ai-act/acknowledgements/me', {
      data: {
        version: notice.requiredVersion,
        textHash: notice.textHash,
        language: notice.language
      }
    });
    expect(confirmed.status()).toBe(201);

    await page.goto('/apps/chat');
    await page.waitForLoadState('networkidle');
    await page.getByRole('textbox', { name: 'Type your message' }).fill('Rule check on');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page.getByText('E2E reply to: Rule check on (turn 1)').filter({ visible: true }).first()
    ).toBeVisible({ timeout: 30_000 });
    const body = await lastStubBody(page);
    expect(JSON.stringify(body.messages)).toContain('You are an AI system');

    const verify = await page.request.post('/api/provenance/_verify', {
      data: { text: 'Some text that was never generated here.' }
    });
    expect(verify.status()).not.toBe(403);

    const status = await (await page.request.get('/api/admin/eu-ai-act/status')).json();
    expect(status.conformity.enabled).toBe(true);
    expect(status.checks.length).toBeGreaterThan(0);
  });

  test('disable: validation, the record, and everything stops', async ({ page }) => {
    await ensureOn(page);
    const bad = await page.request.post(conformity('/_disable'), {
      data: { reason: 'too short', acceptResponsibility: true }
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).code).toBe('VALIDATION_FAILED');
    const unaccepted = await page.request.post(conformity('/_disable'), {
      data: { reason: REASON }
    });
    expect(unaccepted.status()).toBe(400);
    expect((await (await page.request.get(conformity(''))).json()).enabled).toBe(true);

    const off = await page.request.post(conformity('/_disable'), {
      data: { reason: REASON, acceptResponsibility: true }
    });
    expect(off.status()).toBe(200);
    const record = await off.json();
    expect(record).toMatchObject({
      enabled: false,
      reason: REASON,
      changedBy: { id: expect.any(String) },
      statementVersion: 1
    });
    expect(record.changedBy.name).toBeTruthy();
    expect(new Date(record.changedAt).toISOString()).toBe(record.changedAt);
    expect(record.history[0]).toMatchObject({ enabled: false, reason: REASON });

    // A second disable is a conflict that shows the first one's record.
    const again = await page.request.post(conformity('/_disable'), {
      data: { reason: REASON, acceptResponsibility: true }
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).details.enabled).toBe(false);

    // The generic platform save cannot change or erase the record.
    const platform = await (await page.request.get('/api/admin/configs/platform')).json();
    platform.euAiAct = { enabled: true };
    expect(
      (await page.request.post('/api/admin/configs/platform', { data: platform })).ok()
    ).toBeTruthy();
    expect((await (await page.request.get(conformity(''))).json()).enabled).toBe(false);

    // Chat: no 428 although acknowledgements are on and enforced, and the rule is gone.
    expect((await chatPost(page)).status()).not.toBe(428);
    const me = await (await page.request.get('/api/eu-ai-act/acknowledgements/me')).json();
    expect(me).toMatchObject({ enabled: false, enforce: false, acknowledged: true });

    await page.goto('/apps/chat');
    await page.waitForLoadState('networkidle');
    await page.getByRole('textbox', { name: 'Type your message' }).fill('Rule check off');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page.getByText('E2E reply to: Rule check off (turn 1)').filter({ visible: true }).first()
    ).toBeVisible({ timeout: 30_000 });
    const body = await lastStubBody(page);
    expect(JSON.stringify(body.messages)).not.toContain('You are an AI system');
    expect(body.watermarking).toBeUndefined();

    // Verification, status and the public config.
    const verify = await page.request.post('/api/provenance/_verify', {
      data: { text: 'Some text that was never generated here.' }
    });
    expect(verify.status()).toBe(403);
    expect((await verify.json()).code).toBe('FEATURE_DISABLED');
    const status = await (await page.request.get('/api/admin/eu-ai-act/status')).json();
    expect(status.summary.level).toBe('disabled');
    expect(status.checks).toEqual([]);
    expect(status.conformity).toMatchObject({ enabled: false, reason: REASON });
    const pub = await (await page.request.get('/api/configs/platform')).json();
    expect(pub.euAiAct).toEqual({ enabled: false });
    expect(JSON.stringify(pub)).not.toContain(REASON);
    expect(pub.aiAcknowledgement.enabled).toBe(false);
    expect(pub.aiDisclosure.firstTurnNotice.enabled).toBe(false);

    // The data is kept and the CSV export still works.
    const csv = await page.request.get('/api/admin/eu-ai-act/acknowledgements/_export');
    expect(csv.ok()).toBeTruthy();
    expect(await csv.text()).toContain('admin');
  });

  test('enable: everything is back and the earlier acknowledgement is still valid', async ({
    page
  }) => {
    const on = await page.request.post(conformity('/_enable'), {
      data: { reason: 'End-to-end test finished.' }
    });
    expect(on.status()).toBe(200);
    const record = await on.json();
    expect(record.enabled).toBe(true);
    expect(record.history[0].enabled).toBe(true);
    expect(record.history[1].enabled).toBe(false);
    expect(record.history[0].reason).toBe('End-to-end test finished.');
    expect((await page.request.post(conformity('/_enable'), { data: {} })).status()).toBe(409);

    const me = await (await page.request.get('/api/eu-ai-act/acknowledgements/me')).json();
    expect(me).toMatchObject({ enabled: true, acknowledged: true });
    expect((await chatPost(page)).status()).not.toBe(428);

    const verify = await page.request.post('/api/provenance/_verify', {
      data: { text: 'Some text that was never generated here.' }
    });
    expect(verify.status()).not.toBe(403);
    const status = await (await page.request.get('/api/admin/eu-ai-act/status')).json();
    expect(status.conformity.enabled).toBe(true);
    expect(status.checks.length).toBeGreaterThan(0);

    // Somebody without a valid acknowledgement is asked again (no automatic re-request).
    expect((await page.request.delete('/api/admin/eu-ai-act/acknowledgements')).status()).toBe(204);
    expect((await chatPost(page)).status()).toBe(428);
  });
});
