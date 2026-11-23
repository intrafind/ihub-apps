// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The pages `/api/oauth/authorize` renders carry values a caller controls: the
 * client's name and host (from a metadata document anyone can publish), its id,
 * the requested scopes and the language header. Every one of them is escaped,
 * so none of them can add markup to a page served from the application's origin.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  renderApprovalPendingPage,
  renderClientBlockedPage,
  renderClientNotAllowedPage,
  renderConsentScreen,
  renderGroupDeniedPage
} from '../routes/oauthAuthorize.js';

const PAYLOAD = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
const ESCAPED = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;';

/** The markup that must not appear in any page, whatever the data. */
function assertNoInjectedMarkup(html) {
  assert.ok(!html.includes('<script>alert(1)'), 'script element was injected');
  assert.ok(!html.includes('<img src=x'), 'img element was injected');
  assert.ok(!html.includes('"><script'), 'an attribute value was closed early');
  assert.ok(html.includes(ESCAPED) || !html.includes('alert'), 'payload is not escaped');
}

describe('escapeHtml', () => {
  it('escapes the five characters that matter in content and in quoted attributes', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#x27;');
  });

  it('escapes an ampersand once, not twice', () => {
    assert.equal(escapeHtml('a & b &amp; c'), 'a &amp; b &amp;amp; c');
  });

  it('answers an empty string for null and undefined, and coerces other values', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
  });
});

describe('consent screen', () => {
  const render = overrides =>
    renderConsentScreen({
      client: {
        name: PAYLOAD,
        clientId: PAYLOAD,
        host: PAYLOAD,
        redirectUris: ['https://app.example/cb']
      },
      scopes: ['openid', PAYLOAD],
      consentTicket: PAYLOAD,
      baseUrl: `https://ihub.example${PAYLOAD}`,
      lang: 'en',
      ...overrides
    });

  it('escapes the client, the scopes, the ticket and the base URL', () => {
    assertNoInjectedMarkup(render());
  });

  it('escapes a language that is not a two-letter code', () => {
    const html = render({ lang: PAYLOAD });
    assert.ok(!html.includes('<html lang=""><script>'));
    assertNoInjectedMarkup(html);
  });

  it('shows no description for a scope that only exists on Object.prototype', () => {
    const html = render({ scopes: ['constructor', '__proto__', 'toString', 'openid'] });
    assert.ok(!html.includes('function'), 'a prototype member was rendered as a description');
    assert.ok(!html.includes('[object Object]'));
    assert.ok(html.includes('Verify your identity'), 'a known scope keeps its description');
  });
});

describe('refusal pages', () => {
  it('escape the name, host, client id and reason of an unapproved client', () => {
    assertNoInjectedMarkup(
      renderApprovalPendingPage({ name: PAYLOAD, host: PAYLOAD, clientId: PAYLOAD, lang: 'en' })
    );
    assertNoInjectedMarkup(renderClientBlockedPage({ name: PAYLOAD, host: PAYLOAD, lang: 'en' }));
    assertNoInjectedMarkup(
      renderClientNotAllowedPage({ host: PAYLOAD, reason: PAYLOAD, lang: 'en' })
    );
    assertNoInjectedMarkup(renderGroupDeniedPage({ client: { name: PAYLOAD }, lang: 'en' }));
  });
});
