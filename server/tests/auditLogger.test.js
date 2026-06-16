/**
 * Tests for the global audit safety-net middleware: path/method/auth gating,
 * the admin carve-out, resource derivation, and sensitive-field redaction.
 */
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import configCache from '../configCache.js';
import { auditLogger, deriveResource, redact } from '../middleware/auditLogger.js';

function makeReqRes({
  method = 'POST',
  url = '/api/admin/apps/foo',
  user = { id: 'u1', username: 'alice', authenticated: true }
} = {}) {
  const req = { method, originalUrl: url, url, user, body: {} };
  const res = new EventEmitter();
  res.statusCode = 200;
  return { req, res };
}

describe('auditLogger gating', () => {
  const mw = auditLogger();

  beforeEach(() => {
    jest.spyOn(configCache, 'getPlatform').mockReturnValue({ audit: { verbosity: 'metadata' } });
  });
  afterEach(() => jest.restoreAllMocks());

  test('registers a finish listener for authenticated admin mutations', () => {
    const { req, res } = makeReqRes();
    const onSpy = jest.spyOn(res, 'on');
    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(onSpy).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  test('skips non-mutating methods (reads)', () => {
    const { req, res } = makeReqRes({ method: 'GET' });
    const onSpy = jest.spyOn(res, 'on');
    mw(req, res, jest.fn());
    expect(onSpy).not.toHaveBeenCalled();
  });

  test('skips unauthenticated / anonymous requests (anti-flood)', () => {
    const { req, res } = makeReqRes({ user: { id: 'anonymous' } });
    const onSpy = jest.spyOn(res, 'on');
    mw(req, res, jest.fn());
    expect(onSpy).not.toHaveBeenCalled();
  });

  test('still audits admin paths even when a segment is in the exclusion list', () => {
    const { req, res } = makeReqRes({ url: '/api/admin/pages/home' });
    const onSpy = jest.spyOn(res, 'on');
    mw(req, res, jest.fn());
    expect(onSpy).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  test('excludes high-volume non-admin segments (e.g. /api/pages)', () => {
    const { req, res } = makeReqRes({ url: '/api/pages/home' });
    const onSpy = jest.spyOn(res, 'on');
    mw(req, res, jest.fn());
    expect(onSpy).not.toHaveBeenCalled();
  });

  test('skips non-api paths', () => {
    const { req, res } = makeReqRes({ url: '/healthz' });
    const onSpy = jest.spyOn(res, 'on');
    mw(req, res, jest.fn());
    expect(onSpy).not.toHaveBeenCalled();
  });
});

describe('deriveResource', () => {
  const cases = [
    ['/api/admin/apps/my-app', { resource: 'apps', resourceId: 'my-app' }],
    ['/api/admin/apps', { resource: 'apps', resourceId: '' }],
    ['/api/integrations/jira', { resource: 'integrations', resourceId: 'jira' }],
    ['/api/admin/auth/users/u1?x=1', { resource: 'auth', resourceId: 'users' }],
    ['/notapi/', { resource: 'notapi', resourceId: '' }]
  ];
  test.each(cases)('%s', (url, expected) => {
    expect(deriveResource({ originalUrl: url })).toEqual(expected);
  });
});

describe('redact', () => {
  test('redacts sensitive keys, recursing into nested objects and arrays', () => {
    const out = redact({
      name: 'ok',
      password: 'p',
      nested: { clientSecret: 's', apiKey: 'k', keep: 1 },
      list: [{ token: 't' }, { fine: 2 }],
      privateKey: 'x',
      authorization: 'Bearer z'
    });
    expect(out.name).toBe('ok');
    expect(out.password).toBe('***REDACTED***');
    expect(out.nested.clientSecret).toBe('***REDACTED***');
    expect(out.nested.apiKey).toBe('***REDACTED***');
    expect(out.nested.keep).toBe(1);
    expect(out.list[0].token).toBe('***REDACTED***');
    expect(out.list[1].fine).toBe(2);
    expect(out.privateKey).toBe('***REDACTED***');
    expect(out.authorization).toBe('***REDACTED***');
  });
});
