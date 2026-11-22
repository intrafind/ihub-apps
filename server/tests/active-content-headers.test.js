// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A user's file served from the application's origin must not run as a document:
 * an HTML, XHTML or SVG upload gets a sandboxing Content-Security-Policy, other
 * types are served as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isActiveDocumentType, setUserFileContentType } from '../utils/activeContentHeaders.js';
import { servedMediaType } from '../services/artifacts/artifactPolicy.js';

function fakeResponse() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    }
  };
}

describe('isActiveDocumentType', () => {
  it('recognises the types a browser runs as a document, with parameters and any case', () => {
    for (const type of [
      'text/html',
      'TEXT/HTML; charset=utf-8',
      'application/xhtml+xml',
      'image/svg+xml',
      'text/xml',
      'Application/XML; charset=utf-8',
      'text/example+xml',
      'application/rss+xml; charset=utf-8'
    ]) {
      assert.equal(isActiveDocumentType(type), true, type);
    }
  });

  it('leaves passive types and non-strings alone', () => {
    for (const type of ['application/pdf', 'image/png', 'text/plain; charset=utf-8', '', null]) {
      assert.equal(isActiveDocumentType(type), false, String(type));
    }
  });
});

describe('setUserFileContentType', () => {
  it('sandboxes an uploaded HTML file', () => {
    const res = fakeResponse();
    setUserFileContentType(res, servedMediaType('text/html'));
    assert.equal(res.headers['content-type'], 'text/html');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /\bsandbox\b/);
    assert.doesNotMatch(res.headers['content-security-policy'], /allow-scripts/);
  });

  it('sandboxes an uploaded SVG file', () => {
    const res = fakeResponse();
    setUserFileContentType(res, 'image/svg+xml');
    assert.match(res.headers['content-security-policy'], /\bsandbox\b/);
  });

  it('sandboxes an uploaded XML file, which runs as XHTML when it uses that namespace', () => {
    const res = fakeResponse();
    setUserFileContentType(res, 'text/xml');
    assert.match(res.headers['content-security-policy'], /\bsandbox\b/);
  });

  it('adds no policy to a PDF, which a sandbox would stop the browser from showing', () => {
    const res = fakeResponse();
    setUserFileContentType(res, servedMediaType('application/pdf'));
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-security-policy'], undefined);
  });
});
