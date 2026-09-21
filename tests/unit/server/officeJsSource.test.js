/**
 * @jest-environment node
 */

/**
 * Office.js is a bootstrapper that derives the base path for every other file
 * it loads from the `src` of its own `<script>` tag. That makes the library
 * serveable from any origin — and makes the `/office.js` filename suffix load-
 * bearing, because it is how the bootstrapper recognises that tag. These tests
 * pin both halves: the URLs we accept, and the rewrite that puts one into the
 * add-in HTML.
 */
import { describe, expect, test } from '@jest/globals';
import {
  DEFAULT_OFFICE_JS_CDN_URL,
  LEGACY_OFFICE_JS_CDN_URL,
  OFFICE_JS_LOCAL_URL,
  OFFICE_JS_MODES,
  deriveOfficeJsBaseUrl,
  resolveOfficeJsSource,
  rewriteOfficeJsScriptSrc,
  validateOfficeJsUrl
} from '../../../server/utils/officeJsSource.js';

const platformWith = officeIntegration => ({ officeIntegration });

describe('validateOfficeJsUrl', () => {
  test.each([
    ['the documented CDN URL', DEFAULT_OFFICE_JS_CDN_URL],
    ['the legacy CDN URL', LEGACY_OFFICE_JS_CDN_URL],
    ['a custom CDN', 'https://cdn.example.com/office/office.js'],
    ['a cache-busting query', 'https://cdn.example.com/office/office.js?v=2026-09'],
    ['the debug build', 'https://cdn.example.com/office/office.debug.js'],
    ['http on localhost, for development', 'http://localhost:5173/office-js/office.js']
  ])('accepts %s', (_label, url) => {
    expect(validateOfficeJsUrl(url)).toEqual({ value: url });
  });

  test('trims surrounding whitespace', () => {
    expect(validateOfficeJsUrl('  https://cdn.example.com/office/office.js  ')).toEqual({
      value: 'https://cdn.example.com/office/office.js'
    });
  });

  test.each([
    [
      'a renamed bundle — the bootstrapper would not find itself',
      'https://cdn.example.com/office-bundle.js'
    ],
    [
      'office.js as a directory rather than the filename',
      'https://cdn.example.com/office.js/latest'
    ],
    ['a fragment, which breaks the suffix match', 'https://cdn.example.com/office.js#x'],
    ['plain http off localhost — Office refuses it', 'http://cdn.example.com/office.js'],
    ['a relative URL', './office-js/office.js'],
    ['an empty string', ''],
    ['a non-string', 42]
  ])('rejects %s', (_label, url) => {
    expect(validateOfficeJsUrl(url).error).toEqual(expect.any(String));
  });
});

describe('deriveOfficeJsBaseUrl', () => {
  test('strips the filename so sibling files resolve against it', () => {
    expect(deriveOfficeJsBaseUrl('https://cdn.example.com/office/office.js')).toBe(
      'https://cdn.example.com/office/'
    );
  });

  test('drops the query, which applies only to office.js itself', () => {
    expect(deriveOfficeJsBaseUrl('https://cdn.example.com/office/office.js?v=9')).toBe(
      'https://cdn.example.com/office/'
    );
  });

  test('is null for a URL that would not validate', () => {
    expect(deriveOfficeJsBaseUrl('https://cdn.example.com/nope.js')).toBeNull();
  });
});

describe('resolveOfficeJsSource', () => {
  test('defaults to the Microsoft CDN when nothing is configured', () => {
    expect(resolveOfficeJsSource(undefined)).toEqual({
      mode: 'cdn',
      scriptUrl: DEFAULT_OFFICE_JS_CDN_URL,
      upstreamBaseUrl: null
    });
  });

  test('keeps an installation pinned to the legacy CDN host', () => {
    const resolved = resolveOfficeJsSource(
      platformWith({ officeJsMode: 'cdn', officeJsCdnUrl: LEGACY_OFFICE_JS_CDN_URL })
    );
    expect(resolved.scriptUrl).toBe(LEGACY_OFFICE_JS_CDN_URL);
  });

  test('proxy mode serves locally and records the upstream to pull from', () => {
    expect(resolveOfficeJsSource(platformWith({ officeJsMode: 'proxy' }))).toEqual({
      mode: 'proxy',
      scriptUrl: OFFICE_JS_LOCAL_URL,
      upstreamBaseUrl: 'https://officeapis.public.onecdn.static.microsoft/1/'
    });
  });

  test('bundled mode serves locally with no upstream', () => {
    expect(resolveOfficeJsSource(platformWith({ officeJsMode: 'bundled' }))).toEqual({
      mode: 'bundled',
      scriptUrl: OFFICE_JS_LOCAL_URL,
      upstreamBaseUrl: null
    });
  });

  test('custom mode uses the admin-supplied URL', () => {
    expect(
      resolveOfficeJsSource(
        platformWith({ officeJsMode: 'custom', officeJsCustomUrl: 'https://cdn.corp/office.js' })
      )
    ).toEqual({
      mode: 'custom',
      scriptUrl: 'https://cdn.corp/office.js',
      upstreamBaseUrl: null
    });
  });

  test('custom mode with an unusable URL falls back to the CDN rather than serving nothing', () => {
    const resolved = resolveOfficeJsSource(
      platformWith({ officeJsMode: 'custom', officeJsCustomUrl: 'https://cdn.corp/bundle.js' })
    );
    expect(resolved).toEqual({
      mode: 'cdn',
      scriptUrl: DEFAULT_OFFICE_JS_CDN_URL,
      upstreamBaseUrl: null
    });
  });

  test('an unknown mode falls back to the CDN', () => {
    expect(resolveOfficeJsSource(platformWith({ officeJsMode: 'carrier-pigeon' })).mode).toBe(
      'cdn'
    );
  });

  test('a corrupt stored CDN URL falls back to the default', () => {
    expect(
      resolveOfficeJsSource(platformWith({ officeJsMode: 'cdn', officeJsCdnUrl: 'not-a-url' }))
        .scriptUrl
    ).toBe(DEFAULT_OFFICE_JS_CDN_URL);
  });

  test('every advertised mode resolves to a usable script URL', () => {
    for (const mode of OFFICE_JS_MODES) {
      const resolved = resolveOfficeJsSource(
        platformWith({ officeJsMode: mode, officeJsCustomUrl: 'https://cdn.corp/office.js' })
      );
      expect(resolved.scriptUrl).toBeTruthy();
    }
  });
});

describe('rewriteOfficeJsScriptSrc', () => {
  const html = [
    '<head>',
    '<script type="text/javascript" src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" onerror="boom()"></script>',
    '</head>',
    '<body><script type="module" src="./taskpane-entry.jsx"></script></body>'
  ].join('\n');

  test('repoints the Office.js tag whatever origin it currently names', () => {
    const out = rewriteOfficeJsScriptSrc(html, OFFICE_JS_LOCAL_URL);
    expect(out).toContain(`src="${OFFICE_JS_LOCAL_URL}"`);
    expect(out).not.toContain('appsforoffice.microsoft.com');
  });

  test('leaves the add-in entry bundle alone', () => {
    const out = rewriteOfficeJsScriptSrc(html, OFFICE_JS_LOCAL_URL);
    expect(out).toContain('src="./taskpane-entry.jsx"');
  });

  test('preserves the rest of the script tag, including the error handler', () => {
    expect(rewriteOfficeJsScriptSrc(html, OFFICE_JS_LOCAL_URL)).toContain('onerror="boom()"');
  });

  test('is idempotent, so a local URL survives a second pass', () => {
    const once = rewriteOfficeJsScriptSrc(html, OFFICE_JS_LOCAL_URL);
    expect(rewriteOfficeJsScriptSrc(once, OFFICE_JS_LOCAL_URL)).toBe(once);
  });

  test('rewrites a tag that already carries a query string', () => {
    const withQuery = '<script src="https://cdn.example.com/office/office.js?v=1"></script>';
    expect(rewriteOfficeJsScriptSrc(withQuery, DEFAULT_OFFICE_JS_CDN_URL)).toBe(
      `<script src="${DEFAULT_OFFICE_JS_CDN_URL}"></script>`
    );
  });
});
