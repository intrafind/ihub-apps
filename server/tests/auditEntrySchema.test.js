/**
 * Tests for the audit entry Zod schema and validateAuditEntry().
 */
import { randomUUID } from 'crypto';
import { validateAuditEntry } from '../validators/auditEntrySchema.js';

function baseEntry(overrides = {}) {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor: { id: 'u1', username: 'alice', groups: ['users'], authenticated: true },
    action: 'create',
    resource: 'app',
    resourceId: 'my-app',
    summary: 'Created app',
    result: 'success',
    source: 'admin',
    requestId: randomUUID(),
    ip: '127.0.0.1',
    ...overrides
  };
}

describe('validateAuditEntry', () => {
  test('accepts a well-formed entry', () => {
    const result = validateAuditEntry(baseEntry());
    expect(result.success).toBe(true);
  });

  test('rejects an unknown action', () => {
    const result = validateAuditEntry(baseEntry({ action: 'frobnicate' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/action/);
  });

  test('rejects an unknown result', () => {
    const result = validateAuditEntry(baseEntry({ result: 'maybe' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/result/);
  });

  test('rejects an unknown source', () => {
    const result = validateAuditEntry(baseEntry({ source: 'carrier-pigeon' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source/);
  });

  test('rejects a non-uuid id', () => {
    const result = validateAuditEntry(baseEntry({ id: 'not-a-uuid' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/id/);
  });

  test('requires an actor', () => {
    const entry = baseEntry();
    delete entry.actor;
    const result = validateAuditEntry(entry);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/actor/);
  });

  test('allows free-form resource names from the middleware', () => {
    const result = validateAuditEntry(baseEntry({ resource: 'integrations' }));
    expect(result.success).toBe(true);
  });

  test('never throws on garbage input', () => {
    expect(() => validateAuditEntry(null)).not.toThrow();
    expect(validateAuditEntry(null).success).toBe(false);
  });
});
