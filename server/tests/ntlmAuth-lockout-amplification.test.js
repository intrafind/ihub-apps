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
import net from 'node:net';
import configCache from '../configCache.js';
import { ntlmAuthMiddleware, isNtlmLoginPath, createNtlmResponse } from '../middleware/ntlmAuth.js';
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

  const LOGIN = '/api/auth/ntlm/login';

  function run(req) {
    const res = makeRes();
    let nextArg = 'not called';
    const request = {
      path: LOGIN,
      url: LOGIN,
      originalUrl: LOGIN,
      headers: {},
      query: {},
      cookies: {},
      connection: {},
      ...req
    };
    ntlmAuthMiddleware(request, res, err => {
      nextArg = err;
    });
    return { req: request, res, nextArg };
  }

  it('runs the handshake on the Windows sign-in only', () => {
    // Every other request is signed in by the session cookie: a handshake per
    // API call made every call a logon at the domain controller.
    assert.equal(isNtlmLoginPath(LOGIN), true);
    for (const path of ['/api/health', '/api/apps', '/api/auth/status', '/apps/chat']) {
      assert.equal(isNtlmLoginPath(path), false);
      const { res, nextArg } = run({ path, url: path, originalUrl: path });
      assert.equal(nextArg, undefined, path);
      assert.equal(res.ended, false, path);
      assert.equal(res.headers['www-authenticate'], undefined, path);
    }
  });

  it('refuses a recently rejected account without asking the domain controller', () => {
    recordNtlmRejection('MUC', 'jane.doe');
    const { req, res, nextArg } = run({
      headers: { authorization: type3Header({ domain: 'MUC', user: 'jane.doe' }) }
    });
    // Left for the login route, which redirects the browser or answers the API.
    assert.equal(nextArg, undefined);
    assert.equal(req.ntlmFailure?.name, 'ServiceError');
    assert.equal(req.ntlmFailure.code, 'RATE_LIMITED');
    assert.equal(req.ntlmFailure.status, 429);
    assert.ok(req.ntlmFailure.details.retryAfterMs > 0);
    assert.ok(Number(res.headers['retry-after']) > 0);
    assert.equal(res.ended, false);
  });

  it('holds back an answer that names no domain, as a browser outside the domain sends it', () => {
    // express-ntlm reports the configured domain when the message has none,
    // and the rejection is recorded under that name.
    recordNtlmRejection('MUC', 'jane.doe');
    const { req } = run({
      headers: { authorization: type3Header({ domain: '', user: 'jane.doe' }) }
    });
    assert.equal(req.ntlmFailure?.code, 'RATE_LIMITED');
  });

  it('still challenges a request without credentials', () => {
    recordNtlmRejection('MUC', 'jane.doe');
    const { res, nextArg } = run({});
    assert.equal(nextArg, 'not called');
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], 'NTLM');
  });
});

describe('createNtlmResponse', () => {
  function fakeRes() {
    const res = {
      statusCode: 200,
      headers: {},
      ended: 0,
      setHeader(name, value) {
        res.headers[name] = value;
        return res;
      },
      end() {
        res.ended++;
        return res;
      }
    };
    return res;
  }

  it('forwards writes and reports when the response is finished', () => {
    const res = fakeRes();
    let sent = 0;
    const facade = createNtlmResponse(res, { isTimedOut: () => false, onSend: () => sent++ });
    facade.statusCode = 401;
    facade.setHeader('WWW-Authenticate', 'NTLM abc');
    facade.end();
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['WWW-Authenticate'], 'NTLM abc');
    assert.equal(res.ended, 1);
    assert.equal(sent, 1);
  });

  it('drops a late challenge once the request has timed out', () => {
    // The request was already answered with 503; a challenge from the domain
    // controller arriving afterwards must not touch the finished response.
    const res = fakeRes();
    let sent = 0;
    const facade = createNtlmResponse(res, { isTimedOut: () => true, onSend: () => sent++ });
    facade.statusCode = 401;
    facade.setHeader('WWW-Authenticate', 'NTLM abc');
    facade.end();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.headers, {});
    assert.equal(res.ended, 0);
    assert.equal(sent, 0);
  });
});

describe('ntlmAuthMiddleware when the domain controller does not answer', () => {
  let server;
  const sockets = [];

  beforeEach(async () => {
    // Accepts the connection and never answers, like an overloaded DC.
    server = net.createServer(socket => sockets.push(socket));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    mock.method(configCache, 'getPlatform', () => ({
      ntlmAuth: { enabled: true, domain: 'MUC', domainController: `ldap://127.0.0.1:${port}` }
    }));
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(async () => {
    mock.timers.reset();
    mock.restoreAll();
    sockets.forEach(s => s.destroy());
    await new Promise(resolve => server.close(resolve));
  });

  it('reports 503 instead of letting the sign-in through unauthenticated', async () => {
    const res = {
      statusCode: 200,
      headers: {},
      ended: false,
      setHeader(name, value) {
        res.headers[name.toLowerCase()] = value;
      },
      getHeaders: () => res.headers,
      end() {
        res.ended = true;
      },
      sendStatus(code) {
        res.statusCode = code;
        res.ended = true;
      }
    };
    let nextCalls = 0;
    const type1 = 'NTLM TlRMTVNTUAABAAAAB4IIogAAAAAAAAAAAAAAAAAAAAAGAbEdAAAADw==';
    const req = {
      path: '/api/auth/ntlm/login',
      url: '/api/auth/ntlm/login',
      originalUrl: '/api/auth/ntlm/login',
      protocol: 'http',
      get: () => 'localhost',
      headers: { authorization: type1 },
      query: {},
      cookies: {},
      connection: {}
    };
    ntlmAuthMiddleware(req, res, () => {
      nextCalls++;
    });

    // Let express-ntlm open its connection to the domain controller.
    await new Promise(resolve => setImmediate(resolve));
    mock.timers.tick(5000);

    // Left for the login route, which redirects the browser or answers 503.
    assert.equal(nextCalls, 1);
    assert.equal(req.ntlmFailure?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(req.ntlmFailure.status, 503);
    assert.equal(res.headers['retry-after'], '5');

    // The domain controller gives up afterwards; express-ntlm's late answer
    // must not reach the response that was already answered.
    sockets.forEach(s => s.destroy());
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.ended, false);
    assert.equal(res.statusCode, 200);
    assert.equal(nextCalls, 1);
  });
});
