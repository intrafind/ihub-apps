// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sign-in callbacks mark their redirect with `?oidc=success` / `?ntlm=success`,
 * and the auth gate reads that from `location.search`. Appended with a plain
 * `?`, the marker of a sign-in that started on `/page#section` ended up inside
 * the fragment, the gate never saw it, and the person stayed on the login screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendQueryParams } from '../utils/appendQueryParams.js';

const SUCCESS = { oidc: 'success', provider: 'microsoft' };

test('adds a query to a URL without one', () => {
  assert.equal(appendQueryParams('/', SUCCESS), '/?oidc=success&provider=microsoft');
  assert.equal(
    appendQueryParams('https://ihub.example.com/apps/chat', SUCCESS),
    'https://ihub.example.com/apps/chat?oidc=success&provider=microsoft'
  );
});

test('keeps an existing query', () => {
  assert.equal(
    appendQueryParams('/apps/chat?prefill=hello&send=true', SUCCESS),
    '/apps/chat?prefill=hello&send=true&oidc=success&provider=microsoft'
  );
  assert.equal(appendQueryParams('/apps?', { ntlm: 'success' }), '/apps?ntlm=success');
});

test('puts the parameters in front of a fragment, not inside it', () => {
  assert.equal(
    appendQueryParams('/#section', SUCCESS),
    '/?oidc=success&provider=microsoft#section'
  );
  assert.equal(
    appendQueryParams('https://ihub.example.com/admin/docs?page=2#auth', { ntlm: 'success' }),
    'https://ihub.example.com/admin/docs?page=2&ntlm=success#auth'
  );

  const url = new URL(appendQueryParams('https://ihub.example.com/#a?b', SUCCESS));
  assert.equal(url.searchParams.get('oidc'), 'success');
  assert.equal(url.hash, '#a?b');
});

test('encodes the values', () => {
  assert.equal(appendQueryParams('/', { provider: 'corp sso&x=1' }), '/?provider=corp+sso%26x%3D1');
});

test('returns the URL unchanged when there is nothing to add', () => {
  assert.equal(appendQueryParams('/page#x', {}), '/page#x');
});
