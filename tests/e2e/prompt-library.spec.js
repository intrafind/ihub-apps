import { test, expect } from '@playwright/test';

/**
 * Prompt library 2.0 (#2519), end to end: a user writes a prompt with
 * variables, shares it with a colleague, and the colleague uses it — the
 * fill-in dialog asks for the variables, previews the final text, and the
 * text lands in a chat input without being sent. Revoking the share takes
 * the prompt away again.
 *
 * Runs against a live installation (`TEST_BASE_URL`, default the dev server)
 * that still has the default local admin (`admin` / `password123`).
 */

const ADMIN = { username: 'admin', password: 'password123' };

/** A browser context that has already acknowledged the AI disclaimer. */
async function newContext(browser) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
  });
  return context;
}

async function login(request, { username, password }) {
  const response = await request.post('/api/auth/local/login', {
    data: { username, password }
  });
  expect(response.ok(), `login as ${username}`).toBeTruthy();
}

test.describe('Prompt library: create → share → use with variables', () => {
  test('a shared prompt is filled in and inserted into a chat', async ({ browser }) => {
    test.setTimeout(120000);
    const stamp = Date.now();
    const promptName = `E2E email ${stamp}`;
    const colleague = {
      username: `e2e-colleague-${stamp}`,
      password: 'secret-e2e-123',
      name: `E2E Colleague ${stamp}`
    };

    const adminContext = await newContext(browser);
    const admin = await adminContext.newPage();
    await login(admin.request, ADMIN);

    const created = await admin.request.post('/api/admin/auth/users', {
      data: {
        username: colleague.username,
        name: colleague.name,
        password: colleague.password,
        internalGroups: ['users']
      }
    });
    expect(created.ok()).toBeTruthy();
    const colleagueId = (await created.json()).user.id;
    let promptId = null;

    try {
      // Write the prompt in the library.
      await admin.goto('/prompts');
      await admin.getByRole('button', { name: 'New prompt' }).first().click();
      await admin.locator('#prompt-editor-name').fill(promptName);
      await admin
        .locator('#prompt-editor-text')
        .fill('Write a {{tone}} email to {{recipient}} about {{topic}}. Regards, {{user_name}}');
      // The detected variables are listed; the global one is filled in by itself.
      await expect(admin.getByText('Filled in automatically:')).toBeVisible();
      await admin.getByRole('button', { name: 'Save' }).click();

      const card = admin.locator('[data-testid="prompt-card"]', { hasText: promptName });
      await expect(card).toBeVisible();
      promptId = await card.getAttribute('data-prompt-id');
      expect(promptId).toMatch(/^upr_/);

      // Share it with the colleague.
      await card.getByRole('button', { name: 'Details' }).click();
      await admin.getByRole('button', { name: 'Share', exact: true }).click();
      await admin.locator('#prompt-share-search').fill(colleague.name.slice(0, 12));
      await admin.getByRole('button', { name: new RegExp(colleague.name) }).click();
      await admin.getByRole('button', { name: 'Save' }).click();
      await expect(admin.getByText('Sharing updated')).toBeVisible();

      // The colleague finds it under "Shared with me" and uses it.
      const colleagueContext = await newContext(browser);
      const page = await colleagueContext.newPage();
      await login(page.request, colleague);
      await page.goto('/prompts?filter=shared');
      const shared = page.locator('[data-testid="prompt-card"]', { hasText: promptName });
      await expect(shared).toBeVisible();
      await expect(shared).toContainText('Shared');

      await shared.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/Tone/).fill('friendly');
      await dialog.getByLabel(/Recipient/).fill('Grace');
      await dialog.getByLabel(/Topic/).fill('the launch');
      await expect(page.getByTestId('prompt-variables-preview')).toHaveText(
        `Write a friendly email to Grace about the launch. Regards, ${colleague.name}`
      );
      await dialog.getByRole('button', { name: 'Open in chat' }).click();

      await expect(page).toHaveURL(/\/apps\//);
      await expect(page.locator('textarea').first()).toHaveValue(
        `Write a friendly email to Grace about the launch. Regards, ${colleague.name}`
      );

      // Revoking the share takes the prompt away.
      const revoke = await admin.request.put(`/api/prompts/${promptId}/shares`, {
        data: { shares: [] }
      });
      expect(revoke.ok()).toBeTruthy();
      const list = await page.request.get('/api/prompts?scope=shared');
      const ids = (await list.json()).map(prompt => prompt.id);
      expect(ids).not.toContain(promptId);

      await colleagueContext.close();
    } finally {
      if (promptId) await admin.request.delete(`/api/prompts/${promptId}`);
      await admin.request.delete(`/api/admin/auth/users/${colleagueId}`);
      await adminContext.close();
    }
  });
});
