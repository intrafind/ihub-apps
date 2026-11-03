// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyFrameAncestorsCsp, sanitizeFrameAncestors } from '../utils/frameAncestors.js';
import { sanitizeOrigins } from '../services/chat/chatSharing.js';

describe('frame-ancestors helpers', () => {
  it('always allows self and keeps only http(s) origins, once each', () => {
    assert.equal(sanitizeFrameAncestors(undefined), "'self'");
    assert.equal(
      sanitizeFrameAncestors([
        'https://a.example.com/path?x=1',
        'https://a.example.com',
        'http://b.example.com:8080',
        'javascript:alert(1)',
        'ftp://c.example.com',
        'not a url',
        42,
        '*'
      ]),
      "'self' https://a.example.com http://b.example.com:8080"
    );
  });

  it('reduces admin input to bare origins', () => {
    assert.deepEqual(sanitizeOrigins(['https://a.example.com/x', ' http://b.example.com ', 'x']), [
      'https://a.example.com',
      'http://b.example.com'
    ]);
    assert.deepEqual(sanitizeOrigins('https://a.example.com'), []);
  });

  it('replaces X-Frame-Options with the policy and appends extra directives', () => {
    const headers = { 'x-frame-options': 'DENY' };
    const res = {
      removeHeader: name => delete headers[name.toLowerCase()],
      setHeader: (name, value) => {
        headers[name.toLowerCase()] = value;
      }
    };
    applyFrameAncestorsCsp(res, ['https://a.example.com'], ["frame-src 'self'"]);
    assert.equal(headers['x-frame-options'], undefined);
    assert.equal(
      headers['content-security-policy'],
      "frame-ancestors 'self' https://a.example.com; frame-src 'self'"
    );
  });
});
