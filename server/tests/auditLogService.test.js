/**
 * Tests for the AuditLogService core: enriched entry shape, defaults, email
 * masking, buffered writes / flush, and crash-safety on partial input.
 *
 * fs.promises is the same object reference whether imported as `{ promises }`
 * or accessed as `fs.promises`, so spying on it here intercepts the writes the
 * service performs internally.
 */
import { promises as fsp } from 'fs';
import { jest } from '@jest/globals';
import configCache from '../configCache.js';
import { logAudit, flushAuditLog, queryAuditLog } from '../services/AuditLogService.js';

describe('AuditLogService.logAudit', () => {
  let appendSpy;
  let auditConfig;

  beforeEach(() => {
    auditConfig = { includeEmail: false, verbosity: 'metadata', winstonMirror: false };
    jest.spyOn(configCache, 'getPlatform').mockImplementation(() => ({ audit: auditConfig }));
    jest.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
    appendSpy = jest.spyOn(fsp, 'appendFile').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await flushAuditLog().catch(() => {});
    jest.restoreAllMocks();
  });

  test('builds an enriched entry with actor and defaults', () => {
    const req = {
      ip: '10.0.0.1',
      originalUrl: '/api/admin/apps/foo',
      user: { id: 'u1', username: 'alice', groups: ['admin'], authenticated: true }
    };
    const entry = logAudit({ req, action: 'create', resource: 'app', resourceId: 'foo' });

    expect(entry).toMatchObject({
      action: 'create',
      resource: 'app',
      resourceId: 'foo',
      result: 'success', // default
      source: 'admin', // derived from /api/admin/ URL
      actor: { id: 'u1', username: 'alice', authenticated: true }
    });
    expect(entry.id).toBeTruthy();
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.actor.groups).toEqual(['admin']);
  });

  test('masks email-shaped usernames when includeEmail is false', () => {
    const req = { user: { id: 'u2', username: 'bob@example.com', authenticated: true } };
    const entry = logAudit({ req, action: 'login', resource: 'auth' });
    expect(entry.actor.username).toBe('bob');
  });

  test('keeps full email when includeEmail is true', () => {
    auditConfig.includeEmail = true;
    const req = { user: { id: 'u2', username: 'bob@example.com', authenticated: true } };
    const entry = logAudit({ req, action: 'login', resource: 'auth' });
    expect(entry.actor.username).toBe('bob@example.com');
  });

  test('honors an explicit actor for pre-auth events', () => {
    const entry = logAudit({
      action: 'login',
      resource: 'auth',
      result: 'failure',
      actor: { id: 'mallory', username: 'mallory', authenticated: false }
    });
    expect(entry.result).toBe('failure');
    expect(entry.actor).toMatchObject({ id: 'mallory', authenticated: false });
  });

  test('derives source web for non-admin requests', () => {
    const entry = logAudit({
      req: { originalUrl: '/api/auth/local/login' },
      action: 'login',
      resource: 'auth'
    });
    expect(entry.source).toBe('web');
  });

  test('buffers entries and flushes to a dated JSONL file', async () => {
    logAudit({
      req: { user: { id: 'u1', username: 'alice', authenticated: true } },
      action: 'create',
      resource: 'app',
      resourceId: 'foo'
    });

    // Nothing written until flush.
    expect(appendSpy).not.toHaveBeenCalled();

    const count = await flushAuditLog();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);

    const [filePath, content] = appendSpy.mock.calls[0];
    const today = new Date().toISOString().slice(0, 10);
    expect(filePath).toContain(`${today}.jsonl`);
    expect(content).toContain('"resourceId":"foo"');

    // A second flush with an empty queue is a no-op.
    expect(await flushAuditLog()).toBe(0);
  });

  test('marks the request so the middleware can de-dupe', () => {
    const req = { user: { id: 'u1', username: 'alice', authenticated: true } };
    logAudit({ req, action: 'update', resource: 'app' });
    expect(req._auditLogged).toBe(true);
  });

  test('never throws on partial input', () => {
    expect(() => logAudit()).not.toThrow();
    expect(() => logAudit({ action: 'create' })).not.toThrow();
  });

  test('queryAuditLog flushes the buffer before reading', async () => {
    logAudit({
      req: { user: { id: 'u1', username: 'alice', authenticated: true } },
      action: 'create',
      resource: 'app'
    });
    jest.spyOn(fsp, 'readdir').mockResolvedValue([]);
    await queryAuditLog({});
    // The pending entry was flushed as part of the query.
    expect(appendSpy).toHaveBeenCalled();
  });
});
