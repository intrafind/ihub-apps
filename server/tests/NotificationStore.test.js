import { jest } from '@jest/globals';
import os from 'os';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';

/**
 * Unit tests for NotificationStore.js — the per-user JSON-file notification
 * persistence backing NotificationService (issue #1496, v1 scope).
 *
 * getRootDir() is mocked to point at a throwaway temp directory so these
 * tests never touch the real contents/ tree. The temp dir must exist
 * *before* the dynamic import below, since module-level code in
 * NotificationStore.js calls getRootDir() at import time, ahead of any
 * beforeAll/beforeEach hook.
 */

const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-notifications-test-'));

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => tmpRoot
}));

jest.unstable_mockModule('../config.js', () => ({
  default: { CONTENTS_DIR: 'contents' }
}));

const { appendNotification, listNotifications, countUnread, markRead, markAllRead } =
  await import('../services/notifications/NotificationStore.js');

describe('NotificationStore', () => {
  it('appends and lists notifications, most recent first', async () => {
    const userId = 'user-a@example.com';
    await appendNotification(userId, 'job.completed', { jobId: '1' });
    await appendNotification(userId, 'job.error', { jobId: '2' });

    const list = await listNotifications(userId);
    expect(list).toHaveLength(2);
    expect(list[0].type).toBe('job.error');
    expect(list[1].type).toBe('job.completed');
    expect(list[0].read).toBe(false);
  });

  it('scopes notifications per user', async () => {
    const userA = 'user-b@example.com';
    const userB = 'user-c@example.com';
    await appendNotification(userA, 'job.completed', {});

    expect(await listNotifications(userB)).toHaveLength(0);
    expect(await listNotifications(userA)).toHaveLength(1);
  });

  it('marks a single notification read and updates unread count', async () => {
    const userId = 'user-d@example.com';
    const n1 = await appendNotification(userId, 'job.completed', {});
    await appendNotification(userId, 'job.error', {});

    expect(await countUnread(userId)).toBe(2);

    const changed = await markRead(userId, n1.id);
    expect(changed).toBe(true);
    expect(await countUnread(userId)).toBe(1);

    // Marking an already-read notification again is a no-op.
    expect(await markRead(userId, n1.id)).toBe(false);
  });

  it('returns false when marking an unknown notification id as read', async () => {
    const userId = 'user-e@example.com';
    await appendNotification(userId, 'job.completed', {});
    expect(await markRead(userId, 'does-not-exist')).toBe(false);
  });

  it('marks all notifications read in one call', async () => {
    const userId = 'user-f@example.com';
    await appendNotification(userId, 'job.completed', {});
    await appendNotification(userId, 'job.error', {});

    const changed = await markAllRead(userId);
    expect(changed).toBe(2);
    expect(await countUnread(userId)).toBe(0);

    // Second call has nothing left to flip.
    expect(await markAllRead(userId)).toBe(0);
  });

  it('rejects userIds with path-traversal characters', async () => {
    await expect(appendNotification('../evil', 'job.completed', {})).rejects.toThrow();
    await expect(appendNotification('foo/bar', 'job.completed', {})).rejects.toThrow();
  });

  it('caps stored notifications per user at 200', async () => {
    const userId = 'user-cap@example.com';
    for (let i = 0; i < 205; i++) {
      await appendNotification(userId, 'job.completed', { i });
    }
    const list = await listNotifications(userId, { limit: 500 });
    expect(list).toHaveLength(200);
    // Most recent (i=204) should be first; oldest 5 (i=0..4) dropped.
    expect(list[0].data.i).toBe(204);
    expect(list[list.length - 1].data.i).toBe(5);
  });
});
