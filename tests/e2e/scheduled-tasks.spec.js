import { test, expect } from '@playwright/test';

/**
 * End-to-end: a scheduled task from the form to the chat its run produced.
 *
 * Needs a server with the `chatPersistence` and `scheduledTasks` features on
 * and a working default model for the `chat` app; the spec skips itself when
 * the platform config says scheduled tasks are off. It signs in as the
 * default local admin (`admin` / `password123`) that a fresh `contents/`
 * ships with.
 */

const ADMIN = { username: 'admin', password: 'password123' };

async function signIn(request) {
  const response = await request.post('/api/auth/local/login', { data: ADMIN });
  expect(response.ok()).toBeTruthy();
}

async function scheduledTasksEnabled(request) {
  const response = await request.get('/api/configs/platform');
  if (!response.ok()) return false;
  const platform = await response.json();
  return platform?.scheduledTasks?.enabled === true;
}

test.describe('Scheduled tasks', () => {
  const created = [];

  test.beforeEach(async ({ page }) => {
    // The first-visit disclaimer would sit over every click.
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    await signIn(page.request);
    test.skip(
      !(await scheduledTasksEnabled(page.request)),
      'Scheduled tasks are not enabled on this server'
    );
  });

  test.afterEach(async ({ page }) => {
    // Remove what the test made, run chats included.
    while (created.length) {
      const id = created.pop();
      await page.request.delete(`/api/scheduled-tasks/${id}?deleteChats=1`);
    }
  });

  test('creates a task, runs it now and opens the chat of the run', async ({ page }) => {
    const name = `E2E digest ${Date.now()}`;

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Scheduled tasks' })).toBeVisible();

    await page.getByRole('link', { name: 'New task' }).first().click();
    await expect(page).toHaveURL(/\/tasks\/new$/);

    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.locator('#task-app').selectOption('chat');
    await page.getByLabel('Instructions').fill('Give me a one-line summary for {{run_time}}.');
    await page.locator('#schedule-type').selectOption('daily');
    await page.locator('#schedule-time').fill('07:30');
    // The server preview answers before the form can be saved with confidence.
    await expect(page.getByText('Next runs')).toBeVisible();

    await page.getByRole('button', { name: 'Create task' }).click();
    await expect(page).toHaveURL(/\/tasks\/st-[0-9a-f-]+$/);
    const taskId = page.url().split('/').pop();
    created.push(taskId);

    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('Every day at 07:30')).toBeVisible();

    await page.getByRole('button', { name: 'Run now' }).click();

    // The run finishes on whichever worker owns the scheduler; the history
    // follows it until the chat link appears.
    const openChat = page.getByRole('link', { name: 'Open chat' }).first();
    await expect(openChat).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Succeeded').first()).toBeVisible();

    await openChat.click();
    await expect(page).toHaveURL(/\/apps\/chat\/[0-9a-f-]+/);
    await expect(page.getByText('Scheduled run of')).toBeVisible();
    await expect(page.getByRole('link', { name })).toBeVisible();

    // Opening the chat is what "seen" means: the task has no unread run left.
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/scheduled-tasks/${taskId}`);
        return (await response.json()).unseenCount;
      })
      .toBe(0);
  });

  test('refuses a schedule below the minimum interval', async ({ page }) => {
    // The preview is the form's live validation: it answers, and says why not.
    const preview = await page.request.post('/api/scheduled-tasks/_preview', {
      data: { schedule: { type: 'interval', every: 1, unit: 'minutes' } }
    });
    expect(preview.ok()).toBeTruthy();
    const body = await preview.json();
    expect(body.valid).toBe(false);
    expect(body.errors.map(error => error.code)).toContain('BELOW_MIN_INTERVAL');

    // Saving such a task is refused outright.
    const create = await page.request.post('/api/scheduled-tasks', {
      data: {
        name: 'Too often',
        appId: 'chat',
        instructions: 'Hello',
        schedule: { type: 'interval', every: 1, unit: 'minutes' }
      }
    });
    expect(create.status()).toBe(400);
  });
});
