#!/usr/bin/env node

/**
 * Search diagnostics specs — the admin connectivity test's whole value is that
 * it tells an admin *which kind* of problem they have, because the two common
 * ones need opposite responses:
 *
 *   - A DataDome block means nothing on the provider page is wrong. Editing
 *     settings or retrying cannot help; the egress IP has to change.
 *   - A missing or rejected key is a configuration problem, fixable on that
 *     very page.
 *
 * Conflating them is the failure mode worth guarding against, so these specs
 * assert the distinction rather than just that "some error" came back.
 *
 * Run: node --test server/tests/search-diagnostics.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  diagnoseSearchError,
  diagnoseSearchSuccess,
  providerLabel
} from '../services/search/searchDiagnostics.js';

/** Build an error the way WebSearchService wraps a provider failure. */
function wrapped(code, message = 'something went wrong') {
  const error = new Error(`Search failed with qwant: ${message}`);
  error.code = code;
  return error;
}

describe('providerLabel', () => {
  it('names the providers the test covers', () => {
    assert.equal(providerLabel('brave'), 'Brave Search');
    assert.equal(providerLabel('qwant'), 'Qwant');
    assert.equal(providerLabel('staan'), 'Staan');
  });

  it('falls back to the raw id for anything else', () => {
    assert.equal(providerLabel('somethingelse'), 'somethingelse');
  });
});

describe('diagnoseSearchSuccess', () => {
  it('reports results as ok', () => {
    const d = diagnoseSearchSuccess({ results: [{ url: 'https://a.test' }] }, 'qwant');
    assert.equal(d.status, 'ok');
    assert.equal(d.code, 'OK');
    assert.equal(d.remediation.length, 0);
    assert.equal(d.blockedBy, null);
  });

  it('counts results in the headline, with correct pluralisation', () => {
    assert.match(diagnoseSearchSuccess({ results: [{}] }, 'qwant').title, /1 result\b/);
    assert.match(diagnoseSearchSuccess({ results: [{}, {}] }, 'qwant').title, /2 results/);
  });

  it('separates "answered but empty" from "ok", without calling it a failure', () => {
    // Connectivity is what the test asks about, and an empty result set proves
    // the round trip worked. Reporting it as ok would contradict the visibly
    // empty list; reporting it as an error would send the admin debugging
    // a network that is fine.
    const d = diagnoseSearchSuccess({ results: [] }, 'qwant');
    assert.equal(d.status, 'empty');
    assert.equal(d.code, 'NO_RESULTS');
    assert.match(d.detail, /connectivity is fine/i);
    assert.ok(d.remediation.length > 0);
  });

  it('treats a malformed payload as empty rather than throwing', () => {
    assert.equal(diagnoseSearchSuccess(undefined, 'qwant').status, 'empty');
    assert.equal(diagnoseSearchSuccess({}, 'qwant').status, 'empty');
    assert.equal(diagnoseSearchSuccess({ results: 'nope' }, 'qwant').status, 'empty');
  });
});

describe('diagnoseSearchError — DataDome', () => {
  const d = diagnoseSearchError(wrapped('QWANT_CAPTCHA'), 'qwant');

  it('is its own status, not a generic error', () => {
    assert.equal(d.status, 'blocked');
    assert.equal(d.code, 'QWANT_CAPTCHA');
  });

  it('names DataDome so the UI can badge it', () => {
    assert.equal(d.blockedBy, 'datadome');
  });

  it('says plainly that this is not a configuration problem', () => {
    assert.match(d.detail, /not about how the provider is configured/i);
  });

  it('is not retryable — the egress IP will not change between attempts', () => {
    assert.equal(d.retryable, false);
    assert.match(d.detail, /retrying will not/i);
  });

  it('offers egress and Brave as the actual ways out', () => {
    const steps = d.remediation.join(' ');
    assert.match(steps, /egress IP/i);
    assert.match(steps, /Brave/);
    assert.match(steps, /proxy/i);
  });
});

describe('diagnoseSearchError — configuration', () => {
  it('detects a missing Brave key from its message', () => {
    const error = new Error(
      'Search failed with brave: Brave Search API key is not configured. Please configure it in the admin panel.'
    );
    const d = diagnoseSearchError(error, 'brave');
    assert.equal(d.status, 'unconfigured');
    assert.equal(d.code, 'MISSING_API_KEY');
    assert.equal(d.retryable, false);
    // The keyless alternative is worth naming right where the key is missing.
    assert.match(d.remediation.join(' '), /Qwant/);
  });

  it('reads a 401 as a rejected credential, not a network problem', () => {
    const d = diagnoseSearchError(wrapped('HTTP_401'), 'brave');
    assert.equal(d.status, 'unconfigured');
    assert.match(d.detail, /the request arrived but the credential was not accepted/i);
  });

  it('keeps a 403 distinct from a captcha', () => {
    const captcha = diagnoseSearchError(wrapped('QWANT_CAPTCHA'), 'qwant');
    const plain = diagnoseSearchError(wrapped('QWANT_ACCESS_DENIED'), 'qwant');
    assert.equal(captcha.blockedBy, 'datadome');
    assert.equal(plain.blockedBy, null);
    assert.notEqual(captcha.code, plain.code);
  });
});

describe('diagnoseSearchError — Staan', () => {
  const staan = code => diagnoseSearchError(wrapped(code), 'staan');

  it('reads a rejected key as a configuration problem, not a network one', () => {
    const d = staan('STAAN_UNAUTHORIZED');
    assert.equal(d.status, 'unconfigured');
    assert.equal(d.retryable, false);
    assert.equal(d.blockedBy, null);
    // The distinction that matters: the request arrived, so egress is fine.
    assert.match(d.detail, /connectivity is fine/i);
    assert.match(d.remediation.join(' '), /key/i);
  });

  it('detects a missing Staan key from its message, like Brave', () => {
    const error = new Error(
      'Search failed with staan: Staan Search API key is not configured. Please configure it in the admin panel or set the STAAN_API_KEY environment variable.'
    );
    const d = diagnoseSearchError(error, 'staan');
    assert.equal(d.status, 'unconfigured');
    assert.equal(d.code, 'MISSING_API_KEY');
  });

  it('marks rate limiting retryable and names the documented limit', () => {
    const d = staan('STAAN_RATE_LIMITED');
    assert.equal(d.status, 'rate_limited');
    assert.equal(d.retryable, true);
    assert.match(d.remediation.join(' '), /20 requests\/second/);
  });

  it('reports a rejected request as a request problem, and not worth retrying', () => {
    const d = staan('STAAN_BAD_REQUEST');
    assert.equal(d.status, 'error');
    assert.equal(d.retryable, false);
  });

  it('points a non-JSON body at proxies rather than at the provider', () => {
    const d = staan('STAAN_INVALID_RESPONSE');
    assert.equal(d.status, 'error');
    assert.match(d.remediation.join(' '), /proxy/i);
  });

  it('never blames bot protection — Staan has none', () => {
    for (const code of [
      'STAAN_UNAUTHORIZED',
      'STAAN_RATE_LIMITED',
      'STAAN_BAD_REQUEST',
      'STAAN_INVALID_RESPONSE'
    ]) {
      assert.equal(staan(code).blockedBy, null, code);
      assert.notEqual(staan(code).status, 'blocked', code);
    }
  });
});

describe('diagnoseSearchError — transient and transport', () => {
  it('marks rate limiting retryable', () => {
    for (const code of ['QWANT_RATE_LIMITED', 'HTTP_429']) {
      const d = diagnoseSearchError(wrapped(code), 'qwant');
      assert.equal(d.status, 'rate_limited', code);
      assert.equal(d.retryable, true, code);
    }
  });

  it('points transport failures at proxy and TLS configuration', () => {
    for (const code of ['NETWORK_ERROR', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']) {
      const d = diagnoseSearchError(wrapped(code), 'qwant');
      assert.equal(d.status, 'network', code);
      assert.match(d.remediation.join(' '), /proxy/i);
    }
  });

  it('reads a code off the cause when the wrapper has none', () => {
    const error = new Error('fetch failed');
    error.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    assert.equal(diagnoseSearchError(error, 'qwant').status, 'network');
  });

  it('falls back to a usable shape for an unrecognised error', () => {
    const d = diagnoseSearchError(new Error('who knows'), 'qwant');
    assert.equal(d.status, 'error');
    assert.equal(d.code, 'UNKNOWN');
    assert.match(d.detail, /who knows/);
    assert.ok(d.remediation.length > 0);
  });

  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 'a string', {}, 42]) {
      const d = diagnoseSearchError(input, 'qwant');
      assert.equal(typeof d.title, 'string');
      assert.equal(typeof d.detail, 'string');
      assert.ok(Array.isArray(d.remediation));
    }
  });
});

describe('diagnosis shape', () => {
  it('always carries the fields the UI renders', () => {
    const cases = [
      diagnoseSearchSuccess({ results: [{}] }, 'qwant'),
      diagnoseSearchSuccess({ results: [] }, 'qwant'),
      ...[
        'QWANT_CAPTCHA',
        'QWANT_RATE_LIMITED',
        'QWANT_ACCESS_DENIED',
        'QWANT_INVALID_RESPONSE',
        'STAAN_UNAUTHORIZED',
        'STAAN_RATE_LIMITED',
        'STAAN_BAD_REQUEST',
        'STAAN_INVALID_RESPONSE',
        'NETWORK_ERROR',
        'HTTP_401',
        'HTTP_429',
        'WHATEVER'
      ].map(code => diagnoseSearchError(wrapped(code), 'qwant'))
    ];

    const STATUSES = new Set([
      'ok',
      'empty',
      'blocked',
      'unconfigured',
      'rate_limited',
      'network',
      'error'
    ]);

    for (const d of cases) {
      assert.ok(STATUSES.has(d.status), `unexpected status ${d.status}`);
      assert.ok(d.title && d.detail, 'title and detail are required');
      assert.ok(Array.isArray(d.remediation));
      assert.equal(typeof d.retryable, 'boolean');
      assert.ok(d.blockedBy === null || typeof d.blockedBy === 'string');
    }
  });
});
