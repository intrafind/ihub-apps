// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression tests for the NTLM 401 challenge.
 *
 * Bug: with `ntlmAuth.type: "negotiate"` iHub challenged with
 * `WWW-Authenticate: Negotiate`. express-ntlm only parses
 * `Authorization: NTLM …`, so the browser's Kerberos / SPNEGO answer was
 * rejected with 400 and no Windows user could sign in. The challenge must
 * always be NTLM, even when an old config still carries the removed key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNtlmMiddleware } from '../middleware/ntlmAuth.js';

function makeReq(headers = {}) {
  return { headers, connection: {}, originalUrl: '/api/auth/ntlm/login' };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    ended: false,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    end() {
      res.ended = true;
    },
    sendStatus(code) {
      res.statusCode = code;
      res.ended = true;
    }
  };
  return res;
}

function challenge(ntlmConfig) {
  const middleware = createNtlmMiddleware(ntlmConfig);
  const res = makeRes();
  let nextCalled = false;
  middleware(makeReq(), res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe('NTLM challenge scheme', () => {
  it('challenges with NTLM by default', () => {
    const { res, nextCalled } = challenge({ domain: 'EXAMPLE' });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], 'NTLM');
    assert.equal(res.ended, true);
  });

  it('still challenges with NTLM when a leftover type "negotiate" is in the config', () => {
    const { res } = challenge({ domain: 'EXAMPLE', type: 'negotiate' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], 'NTLM');
  });
});
