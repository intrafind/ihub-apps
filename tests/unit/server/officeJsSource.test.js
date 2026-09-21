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
  OFFICE_JS_CDN_PRESETS,
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

describe('OFFICE_JS_CDN_PRESETS', () => {
  test('every preset URL would be accepted by the admin form', () => {
    for (const preset of OFFICE_JS_CDN_PRESETS) {
      expect(validateOfficeJsUrl(preset.url)).toEqual({ value: preset.url });
    }
  });

  test('ids are unique, so the i18n lookup and React keys stay stable', () => {
    const ids = OFFICE_JS_CDN_PRESETS.map(preset => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('offers both worldwide hosts — a microsoft.com block catches only one', () => {
    const urls = OFFICE_JS_CDN_PRESETS.map(preset => preset.url);
    expect(urls).toContain(DEFAULT_OFFICE_JS_CDN_URL);
    expect(urls).toContain(LEGACY_OFFICE_JS_CDN_URL);
  });

  test('every preset yields a usable base path for the proxy to pull from', () => {
    for (const preset of OFFICE_JS_CDN_PRESETS) {
      expect(deriveOfficeJsBaseUrl(preset.url)).toMatch(/\/$/);
    }
  });

  test('includes the 21Vianet CDN China tenants are required to use', () => {
    const china = OFFICE_JS_CDN_PRESETS.find(preset => preset.id === 'china');
    expect(china?.url).toContain('office365.cn');
  });
});

describe('validateOfficeJsUrl normalizes rather than echoing its input', () => {
  // The returned value is interpolated into a double-quoted `src` attribute in
  // the add-in HTML. Returning the raw input let a URL carrying a quote close
  // that attribute and open a second <script> tag, on pages that are served
  // without authentication.
  const BREAKOUT =
    'https://cdn.example.com/x"></script><script>fetch("/api/apps")</script><script src="/office.js';

  test('percent-encodes a quote rather than letting it close the attribute', () => {
    const { value } = validateOfficeJsUrl(BREAKOUT);
    expect(value).not.toContain('"');
    expect(value).toContain('%22');
  });

  test('a breakout payload cannot introduce a second script tag', () => {
    const { value } = validateOfficeJsUrl(BREAKOUT);
    const html = '<script type="text/javascript" src="https://x/office.js"></script>';
    const out = rewriteOfficeJsScriptSrc(html, value);

    expect(out.match(/<script/gi)).toHaveLength(1);
    expect(out).not.toMatch(/<\/script>\s*<script/i);
  });

  test('encodes a stray space instead of emitting markup that breaks at load time', () => {
    // Previously accepted verbatim, so the browser read the attribute as ending
    // at the space and Office.js 404ed — which the task pane then reported as a
    // blocked network rather than a malformed URL.
    const { value } = validateOfficeJsUrl('https://cdn.example.com/lib with space/office.js');
    expect(value).toBe('https://cdn.example.com/lib%20with%20space/office.js');
  });

  test('leaves every shipped preset byte-identical', () => {
    for (const preset of OFFICE_JS_CDN_PRESETS) {
      expect(validateOfficeJsUrl(preset.url).value).toBe(preset.url);
    }
  });

  test('preserves a cache-busting query string', () => {
    const url = 'https://cdn.example.com/office/office.js?v=2026-09';
    expect(validateOfficeJsUrl(url).value).toBe(url);
  });
});

describe('rewriteOfficeJsScriptSrc escapes independently of the validator', () => {
  // Defence in depth: the rewrite must stay safe for a value that did not come
  // through validateOfficeJsUrl.
  test('escapes a raw quote passed directly', () => {
    const out = rewriteOfficeJsScriptSrc(
      '<script src="https://x/office.js"></script>',
      'https://evil/"><script>alert(1)</script>'
    );
    expect(out.match(/<script/gi)).toHaveLength(1);
    expect(out).toContain('&quot;');
  });

  test('keeps an ampersand in a query string parseable', () => {
    const out = rewriteOfficeJsScriptSrc(
      '<script src="https://x/office.js"></script>',
      'https://cdn.example.com/office/office.js?a=1&b=2'
    );
    expect(out).toContain('a=1&amp;b=2');
  });
});
