// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression tests: one wrong Windows password must not lock the account.
 *
 * Bug: until a sign-in succeeds, every request runs its own NTLM handshake.
 * With a stale password each one was a failed logon at the domain controller:
 * a page load (a dozen parallel API calls) plus the client's endless
 * `/api/health` poll locked the AD account within seconds.
 *
 * Fixed by (1) never signing in `/api/health` and (2) holding an account's
 * NTLM answers back for a while after the domain controller rejected it.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { ntlmAuthMiddleware, isNtlmExemptPath } from '../middleware/ntlmAuth.js';
import {
  parseNtlmType3Identity,
  recordNtlmRejection,
  ntlmCooldownRemaining,
  resetNtlmRejections
} from '../utils/ntlmRejectionCooldown.js';

/**
 * Build an `Authorization: NTLM …` header carrying a Type 3 message.
 * Only the fields the parser reads are filled in.
 */
function type3Header({ domain, user, unicode = true }) {
  const encoding = unicode ? 'utf16le' : 'latin1';
  const domainBuf = Buffer.from(domain, encoding);
  const userBuf = Buffer.from(user, encoding);
  const header = Buffer.alloc(64);
  header.write('NTLMSSP\0', 0, 'latin1');
  header.writeUInt32LE(3, 8);
  let offset = 64;
  for (const [field, buf] of [
    [28, domainBuf],
    [36, userBuf]
  ]) {
    header.writeUInt16LE(buf.length, field);
    header.writeUInt16LE(buf.length, field + 2);
    header.writeUInt32LE(offset, field + 4);
    offset += buf.length;
  }
  header.writeUInt32LE(unicode ? 0x00000001 : 0x00000002, 60);
  const message = Buffer.concat([header, domainBuf, userBuf]);
  return `NTLM ${message.toString('base64')}`;
}

describe('parseNtlmType3Identity', () => {
  it('reads domain and user from a Unicode Type 3 message', () => {
    assert.deepEqual(parseNtlmType3Identity(type3Header({ domain: 'MUC', user: 'jane.doe' })), {
      domain: 'MUC',
      user: 'jane.doe'
    });
  });

  it('reads domain and user from an OEM Type 3 message', () => {
    assert.deepEqual(
      parseNtlmType3Identity(type3Header({ domain: 'MUC', user: 'jane.doe', unicode: false })),
      { domain: 'MUC', user: 'jane.doe' }
    );
  });

  it('ignores anything that is not an NTLM Type 3 message', () => {
    const type1 = 'NTLM TlRMTVNTUAABAAAAB4IIogAAAAAAAAAAAAAAAAAAAAAGAbEdAAAADw==';
    assert.equal(parseNtlmType3Identity(type1), null);
    assert.equal(parseNtlmType3Identity(undefined), null);
    assert.equal(parseNtlmType3Identity('Bearer abc'), null);
    assert.equal(parseNtlmType3Identity('NTLM !!!'), null);
    assert.equal(parseNtlmType3Identity(`NTLM ${Buffer.alloc(80).toString('base64')}`), null);
  });

  it('ignores a message whose fields point outside it', () => {
    const header = Buffer.alloc(64);
    header.write('NTLMSSP\0', 0, 'latin1');
    header.writeUInt32LE(3, 8);
    header.writeUInt16LE(50, 36);
    header.writeUInt32LE(4000, 40);
    assert.equal(parseNtlmType3Identity(`NTLM ${header.toString('base64')}`), null);
  });
});

describe('NTLM rejection cooldown', () => {
  beforeEach(() => resetNtlmRejections());

  it('holds an account back after a rejection and releases it when the time is up', () => {
    recordNtlmRejection('MUC', 'jane.doe', 1000, 60000);
    assert.equal(ntlmCooldownRemaining('MUC', 'jane.doe', 1000), 60000);
    assert.equal(ntlmCooldownRemaining('MUC', 'jane.doe', 30000), 31000);
    assert.equal(ntlmCooldownRemaining('MUC', 'jane.doe', 61000), 0);
  });

  it('matches the account regardless of case and leaves other accounts alone', () => {
    recordNtlmRejection('MUC', 'Jane.Doe', 1000, 60000);
    assert.ok(ntlmCooldownRemaining('muc', 'jane.doe', 2000) > 0);
    assert.equal(ntlmCooldownRemaining('MUC', 'john.doe', 2000), 0);
    assert.equal(ntlmCooldownRemaining('OTHER', 'jane.doe', 2000), 0);
  });

  it('records nothing without a user name', () => {
    recordNtlmRejection('MUC', undefined, 1000, 60000);
    assert.equal(ntlmCooldownRemaining('MUC', '', 2000), 0);
  });
});

describe('ntlmAuthMiddleware lockout protection', () => {
  beforeEach(() => {
    resetNtlmRejections();
    mock.method(configCache, 'getPlatform', () => ({
      ntlmAuth: { enabled: true, domain: 'MUC' }
    }));
  });
  afterEach(() => mock.restoreAll());

  function makeRes() {
    const res = {
      headers: {},
      statusCode: 200,
      ended: false,
      setHeader(name, value) {
        res.headers[name.toLowerCase()] = value;
      },
      getHeaders: () => res.headers,
      end() {
        res.ended = true;
      },
      send() {
        res.ended = true;
      },
      sendStatus(code) {
        res.statusCode = code;
        res.ended = true;
      }
    };
    return res;
  }

  function run(req) {
    const res = makeRes();
    let nextArg = 'not called';
    ntlmAuthMiddleware(
      { headers: {}, query: {}, cookies: {}, connection: {}, ...req },
      res,
      err => {
        nextArg = err;
      }
    );
    return { res, nextArg };
  }

  it('never challenges the health check', () => {
    assert.equal(isNtlmExemptPath('/api/health'), true);
    assert.equal(isNtlmExemptPath('/api/apps'), false);
    const { res, nextArg } = run({ path: '/api/health', url: '/api/health' });
    assert.equal(nextArg, undefined);
    assert.equal(res.ended, false);
    assert.equal(res.headers['www-authenticate'], undefined);
  });

  it('refuses a recently rejected account without asking the domain controller', () => {
    recordNtlmRejection('MUC', 'jane.doe');
    const { res, nextArg } = run({
      path: '/api/apps',
      url: '/api/apps',
      headers: { authorization: type3Header({ domain: 'MUC', user: 'jane.doe' }) }
    });
    assert.equal(nextArg?.name, 'ServiceError');
    assert.equal(nextArg.code, 'RATE_LIMITED');
    assert.equal(nextArg.status, 429);
    assert.ok(nextArg.details.retryAfterMs > 0);
    assert.ok(Number(res.headers['retry-after']) > 0);
    assert.equal(res.ended, false);
  });

  it('still challenges a request without credentials', () => {
    recordNtlmRejection('MUC', 'jane.doe');
    const { res, nextArg } = run({ path: '/api/apps', url: '/api/apps', originalUrl: '/api/apps' });
    assert.equal(nextArg, 'not called');
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], 'NTLM');
  });
});
