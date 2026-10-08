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
    await expect(page).toHaveURL(/\/apps\/chat\/c\/[0-9a-f-]{36}$/);
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

  test.describe('memory', () => {
    async function createTask(page, extra = {}) {
      const response = await page.request.post('/api/scheduled-tasks', {
        data: {
          name: `E2E memory ${Date.now()}`,
          appId: 'chat',
          instructions: 'Say hello.',
          schedule: { type: 'manual' },
          ...extra
        }
      });
      expect(response.status()).toBe(201);
      const task = await response.json();
      created.push(task.id);
      return task;
    }

    test('keeps notes that the owner edits, with a version check and clearing', async ({
      page
    }) => {
      const task = await createTask(page, { memory: { enabled: true } });
      expect(task.memory.enabled).toBe(true);
      const url = `/api/scheduled-tasks/${task.id}/memory`;

      const empty = await (await page.request.get(url)).json();
      expect(empty).toMatchObject({ body: '', version: 0, enabled: true });
      expect(empty.maxChars).toBeGreaterThan(0);

      const saved = await page.request.put(url, {
        data: { content: '- reported v1.2', expectedVersion: 0 }
      });
      expect(saved.ok()).toBeTruthy();
      const { version } = await saved.json();
      expect(version).toBe(1);

      // A write that started from an older version is refused, not merged.
      const stale = await page.request.put(url, {
        data: { content: 'overwrite', expectedVersion: 0 }
      });
      expect(stale.status()).toBe(409);
      expect((await (await page.request.get(url)).json()).body).toBe('- reported v1.2\n');

      const cleared = await page.request.delete(url);
      expect(cleared.ok()).toBeTruthy();
      expect((await (await page.request.get(url)).json()).body).toBe('');
    });

    test('shows an admin the size of the notes and never the notes', async ({ page }) => {
      const task = await createTask(page, { memory: { enabled: true } });
      const put = await page.request.put(`/api/scheduled-tasks/${task.id}/memory`, {
        data: { content: 'private note', expectedVersion: 0 }
      });
      expect(put.ok()).toBeTruthy();

      const response = await page.request.get(`/api/admin/scheduled-tasks/${task.id}/memory`);
      expect(response.ok()).toBeTruthy();
      const metadata = await response.json();
      // The server ends the notes with a newline, like a file.
      expect(metadata.chars).toBe('private note\n'.length);
      expect(metadata.version).toBe(1);
      expect(JSON.stringify(metadata)).not.toContain('private note');
    });

    test('refuses "only when something changed" for a task without memory', async ({ page }) => {
      const response = await page.request.post('/api/scheduled-tasks', {
        data: {
          name: 'No memory',
          appId: 'chat',
          instructions: 'Say hello.',
          schedule: { type: 'manual' },
          notify: 'changes'
        }
      });
      expect(response.status()).toBe(400);
      const { details } = await response.json();
      expect(details.map(detail => detail.code)).toContain('NOTIFY_CHANGES_NEEDS_MEMORY');
    });

    test('edits the notes from the Memory card on the task page', async ({ page }) => {
      const task = await createTask(page, { memory: { enabled: true } });
      await page.goto(`/tasks/${task.id}`);

      const notes = page.getByRole('textbox', { name: 'Memory notes' });
      await expect(notes).toBeVisible();
      await notes.fill('- watermark: 2026-10-08');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId('memory-version')).toContainText('Version 1');

      await page.reload();
      await expect(page.getByRole('textbox', { name: 'Memory notes' })).toHaveValue(
        '- watermark: 2026-10-08\n'
      );
    });
  });
});
