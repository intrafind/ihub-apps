/**
 * Unit tests for userPromptsStore.js (per-user prompt CRUD, #1037/#1038).
 * Exercises the real filesystem under a throwaway userId directory (cleaned
 * up in afterAll) rather than mocking fs, since path-traversal safety is the
 * behavior under test.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import {
  listOwnUserPrompts,
  listSharedUserPrompts,
  getUserPrompt,
  createUserPrompt,
  updateUserPrompt,
  deleteUserPrompt
} from '../utils/userPromptsStore.js';

const OWNER_ID = `test-owner-${Date.now()}`;
const OTHER_ID = `test-other-${Date.now()}`;

function userDirPath(userId) {
  return path.join(getRootDir(), 'contents', 'data', 'user-prompts', userId);
}

afterAll(async () => {
  await fs.rm(userDirPath(OWNER_ID), { recursive: true, force: true });
  await fs.rm(userDirPath(OTHER_ID), { recursive: true, force: true });
});

describe('userPromptsStore', () => {
  test('createUserPrompt persists a record with ownership/audit fields', async () => {
    const record = await createUserPrompt(OWNER_ID, {
      name: 'My Prompt',
      description: 'A test prompt',
      prompt: 'Summarize: [content]',
      visibility: 'private'
    });

    expect(record.id).toBeTruthy();
    expect(record.ownerId).toBe(OWNER_ID);
    expect(record.createdBy).toBe(OWNER_ID);
    expect(record.lastModifiedBy).toBe(OWNER_ID);
    expect(record.visibility).toBe('private');
    expect(record.enabled).toBe(true);

    const fetched = await getUserPrompt(OWNER_ID, record.id);
    expect(fetched).toEqual(record);
  });

  test('listOwnUserPrompts returns only the owner’s prompts', async () => {
    const own = await listOwnUserPrompts(OWNER_ID);
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own.every(p => p.ownerId === OWNER_ID)).toBe(true);
  });

  test('private prompts are not returned by listSharedUserPrompts for other users', async () => {
    const shared = await listSharedUserPrompts(OTHER_ID);
    expect(shared.some(p => p.ownerId === OWNER_ID)).toBe(false);
  });

  test('shared prompts are visible to other users, private ones are not', async () => {
    const sharedRecord = await createUserPrompt(OWNER_ID, {
      name: 'Shared Prompt',
      prompt: 'Translate: [content]',
      visibility: 'shared'
    });

    const visibleToOther = await listSharedUserPrompts(OTHER_ID);
    expect(visibleToOther.some(p => p.id === sharedRecord.id)).toBe(true);

    // Excluding the owner's own id should never surface their own prompts,
    // shared or not — the caller already gets those from listOwnUserPrompts.
    const visibleToSelf = await listSharedUserPrompts(OWNER_ID);
    expect(visibleToSelf.some(p => p.id === sharedRecord.id)).toBe(false);
  });

  test('updateUserPrompt mutates fields and bumps lastModified*, returns null for unknown id', async () => {
    const record = await createUserPrompt(OWNER_ID, {
      name: 'Before',
      prompt: 'Before text',
      visibility: 'private'
    });

    const updated = await updateUserPrompt(OWNER_ID, record.id, {
      name: 'After',
      prompt: 'After text',
      visibility: 'shared'
    });

    expect(updated.name).toBe('After');
    expect(updated.prompt).toBe('After text');
    expect(updated.visibility).toBe('shared');
    expect(updated.createdAt).toBe(record.createdAt);
    expect(updated.lastModifiedAt >= record.lastModifiedAt).toBe(true);

    const missing = await updateUserPrompt(OWNER_ID, 'does-not-exist', {
      name: 'X',
      prompt: 'Y'
    });
    expect(missing).toBeNull();
  });

  test('deleteUserPrompt removes the file and reports whether it existed', async () => {
    const record = await createUserPrompt(OWNER_ID, {
      name: 'To Delete',
      prompt: 'Delete me'
    });

    const deleted = await deleteUserPrompt(OWNER_ID, record.id);
    expect(deleted).toBe(true);

    const afterDelete = await getUserPrompt(OWNER_ID, record.id);
    expect(afterDelete).toBeNull();

    const deleteAgain = await deleteUserPrompt(OWNER_ID, record.id);
    expect(deleteAgain).toBe(false);
  });

  test('rejects promptId values that look like path traversal', async () => {
    await expect(getUserPrompt(OWNER_ID, '../../etc/passwd')).rejects.toThrow('Invalid prompt id');
    await expect(getUserPrompt(OWNER_ID, '..')).rejects.toThrow('Invalid prompt id');
  });

  test('rejects userId values that look like path traversal', async () => {
    await expect(listOwnUserPrompts('..')).rejects.toThrow('Invalid user id');
    await expect(listOwnUserPrompts('../../etc')).rejects.toThrow('Invalid user id');
  });
});
