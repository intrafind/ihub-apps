// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The audit log must show one person under one name. A login entry records the
 * display name while every later request only knows the persisted `user_…` id
 * from the JWT, and older entries carry no name at all, so queryAuditLog
 * resolves each actor to a single label (`actor.displayName`) that the facets,
 * the actor filter and the free-text search all key on.
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-audit-actor-')));
process.env.CONTENTS_DIR = path.join(ROOT, 'contents');
const AUDIT_DIR = path.join(ROOT, 'contents', 'data', 'audit-log');

const { default: configCache } = await import('../configCache.js');
const { logAudit, flushAuditLog, queryAuditLog } = await import('../services/AuditLogService.js');

const USERS = {
  user_jonas: { id: 'user_jonas', name: 'Jonas Rothe', email: 'jonas@example.com' },
  user_mail: { id: 'user_mail', name: 'mail.only@example.com' }
};

const today = new Date().toISOString().slice(0, 10);

function writeEntries(entries) {
  fsSync.mkdirSync(AUDIT_DIR, { recursive: true });
  fsSync.writeFileSync(
    path.join(AUDIT_DIR, `${today}.jsonl`),
    entries.map(e => JSON.stringify({ ts: `${today}T10:00:00.000Z`, ...e })).join('\n') + '\n'
  );
}

let auditConfig;

beforeEach(() => {
  auditConfig = { includeEmail: false };
  jest.spyOn(configCache, 'getPlatform').mockImplementation(() => ({ audit: auditConfig }));
  const realGet = configCache.get.bind(configCache);
  jest
    .spyOn(configCache, 'get')
    .mockImplementation(key =>
      String(key).includes('users') ? { data: { users: USERS } } : realGet(key)
    );
  fsSync.rmSync(AUDIT_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await flushAuditLog().catch(() => {});
  jest.restoreAllMocks();
});

afterAll(() => {
  fsSync.rmSync(ROOT, { recursive: true, force: true });
});

describe('logAudit records the actor name', () => {
  test('stores name separately from the JWT username', () => {
    const entry = logAudit({
      req: { user: { id: 'user_jonas', username: 'user_jonas', name: 'Jonas Rothe' } },
      action: 'update',
      resource: 'app',
      resourceId: 'web-chat'
    });
    expect(entry.actor).toMatchObject({
      id: 'user_jonas',
      username: 'user_jonas',
      name: 'Jonas Rothe'
    });
  });

  test('masks an email-shaped name when includeEmail is false', () => {
    const entry = logAudit({
      req: { user: { id: 'user_mail', username: 'user_mail', name: 'mail.only@example.com' } },
      action: 'update',
      resource: 'app'
    });
    expect(entry.actor.name).toBe('mail.only');
  });
});

describe('queryAuditLog resolves one label per actor', () => {
  test('login (display name) and request (id only) entries share one label and facet', async () => {
    writeEntries([
      {
        id: '1',
        action: 'login',
        resource: 'auth',
        actor: { id: 'user_jonas', username: 'Jonas Rothe', authenticated: true }
      },
      {
        id: '2',
        action: 'update',
        resource: 'app',
        actor: { id: 'user_jonas', username: 'user_jonas', authenticated: true }
      }
    ]);
    const { entries, facets } = await queryAuditLog({ from: today, to: today, facets: true });
    expect(entries.map(e => e.actor.displayName)).toEqual(['Jonas Rothe', 'Jonas Rothe']);
    expect(facets.actor).toEqual([{ value: 'Jonas Rothe', count: 2 }]);

    const filtered = await queryAuditLog({ from: today, to: today, actor: 'Jonas Rothe' });
    expect(filtered.total).toBe(2);
  });

  test('a deleted user falls back to the stored name, then the username', async () => {
    writeEntries([
      {
        id: '1',
        action: 'update',
        resource: 'app',
        actor: { id: 'user_gone', username: 'user_gone', name: 'Former Person' }
      },
      { id: '2', action: 'update', resource: 'app', actor: { id: 'user_x', username: 'user_x' } }
    ]);
    const { entries } = await queryAuditLog({ from: today, to: today });
    expect(entries.map(e => e.actor.displayName).sort()).toEqual(['Former Person', 'user_x']);
  });

  test('masks an email-shaped resolved name unless includeEmail is true', async () => {
    writeEntries([
      { id: '1', action: 'update', resource: 'app', actor: { id: 'user_mail', username: 'x' } }
    ]);
    let { entries } = await queryAuditLog({ from: today, to: today });
    expect(entries[0].actor.displayName).toBe('mail.only');

    auditConfig.includeEmail = true;
    ({ entries } = await queryAuditLog({ from: today, to: today }));
    expect(entries[0].actor.displayName).toBe('mail.only@example.com');
  });

  test('free-text search matches the name and the raw id', async () => {
    writeEntries([
      {
        id: '1',
        action: 'update',
        resource: 'app',
        actor: { id: 'user_jonas', username: 'user_jonas' }
      }
    ]);
    expect((await queryAuditLog({ from: today, to: today, q: 'rothe' })).total).toBe(1);
    expect((await queryAuditLog({ from: today, to: today, q: 'user_jonas' })).total).toBe(1);
  });

  test('legacy entries with a plain admin string still resolve', async () => {
    writeEntries([{ id: '1', action: 'update', resource: 'app', admin: 'old-admin' }]);
    const { facets } = await queryAuditLog({ from: today, to: today, facets: true });
    expect(facets.actor).toEqual([{ value: 'old-admin', count: 1 }]);
  });
});
