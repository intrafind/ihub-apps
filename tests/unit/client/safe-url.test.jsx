/**
 * Return URLs after sign-in, and admin-configured redirect targets.
 *
 * `getSafeReturnPath` is used by every place that navigates to a
 * `?returnUrl=` value or the stored `authReturnUrl` (LoginPage, AuthContext).
 * It must keep working for the values the app itself stores — absolute URLs
 * on this origin and paths including the deployment base path — and turn
 * everything else into the app root.
 *
 * `getHttpUrl` guards redirect and iframe apps: only http(s) targets are
 * followed or embedded.
 */

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
let mockBasePath = '';
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => mockBasePath
}));

import { getHttpUrl, getSafeReturnPath } from '../../../client/src/utils/safeUrl';

const ORIGIN = 'https://ihub.example.com';

describe('getSafeReturnPath at the root', () => {
  const safe = value => getSafeReturnPath(value, { basePath: '', origin: ORIGIN });

  test.each([
    ['/apps/chat', '/apps/chat'],
    ['/apps/chat?prefill=hello&send=true', '/apps/chat?prefill=hello&send=true'],
    ['/pages/faq#contact', '/pages/faq#contact'],
    [`${ORIGIN}/apps/chat?x=1`, '/apps/chat?x=1'],
    ['apps/chat', '/apps/chat']
  ])('keeps a same-origin value %s as %s', (value, expected) => {
    expect(safe(value)).toBe(expected);
  });

  test('returns a path, never an absolute URL', () => {
    expect(safe(`${ORIGIN}/settings`)).toBe('/settings');
  });

  test.each([
    ['an absolute URL on another origin', 'https://other.example.com/apps/chat'],
    ['the same host on another scheme', 'http://ihub.example.com/apps/chat'],
    ['the same host on another port', 'https://ihub.example.com:8443/apps/chat'],
    ['a protocol-relative URL', '//other.example.com/apps/chat'],
    ['a backslash after the slash', '/\\other.example.com/apps/chat'],
    ['two backslashes', '\\\\other.example.com'],
    ['leading whitespace before //', '  //other.example.com'],
    ['a tab inside //', '/\t/other.example.com'],
    ['a path that normalises to //', '/.//other.example.com'],
    ['a parent segment before //', '/a/..//other.example.com'],
    ['a same-origin URL whose path starts with //', `${ORIGIN}//other.example.com`],
    ['a javascript: URL', 'javascript:void(0)'],
    ['an upper-case javascript: URL', 'JAVASCRIPT:void(0)'],
    ['a data: URL', 'data:text/html,hello'],
    ['a blob: URL on this origin', `blob:${ORIGIN}/apps/chat`],
    ['a malformed URL', 'http://['],
    ['an empty value', ''],
    ['null', null],
    ['undefined', undefined],
    ['a non-string value', ['/apps/chat']]
  ])('falls back to / for %s', (_label, value) => {
    expect(safe(value)).toBe('/');
  });

  test('normalises dot segments before deciding', () => {
    expect(safe('/apps/../admin')).toBe('/admin');
  });

  test('falls back when the current origin is opaque', () => {
    expect(getSafeReturnPath('javascript:void(0)', { basePath: '', origin: 'null' })).toBe('/');
    expect(getSafeReturnPath('/apps/chat', { basePath: '', origin: 'null' })).toBe('/');
  });
});

describe('getSafeReturnPath on a subpath deployment', () => {
  const safe = value => getSafeReturnPath(value, { basePath: '/ihub', origin: ORIGIN });

  test.each([
    ['/ihub/apps/chat', '/ihub/apps/chat'],
    [`${ORIGIN}/ihub/apps/chat?x=1#top`, '/ihub/apps/chat?x=1#top'],
    ['/ihub/', '/ihub/'],
    ['/ihub', '/ihub']
  ])('keeps %s inside the base path', (value, expected) => {
    expect(safe(value)).toBe(expected);
  });

  test.each([
    ['a path outside the base path', '/other-app/page'],
    ['a path that only starts with the base path name', '/ihub-old/apps/chat'],
    ['a path leaving the base path via ..', '/ihub/../other-app'],
    ['another origin', 'https://other.example.com/ihub/apps/chat'],
    ['a protocol-relative URL', '//other.example.com/ihub/'],
    ['a backslash after the slash', '/\\other.example.com/ihub/'],
    ['a javascript: URL', 'javascript:void(0)'],
    ['a data: URL', 'data:text/html,hello']
  ])('falls back to the base-path root for %s', (_label, value) => {
    expect(safe(value)).toBe('/ihub/');
  });
});

describe('getSafeReturnPath defaults', () => {
  afterEach(() => {
    mockBasePath = '';
  });

  test('uses the current origin and the detected base path', () => {
    mockBasePath = '/ihub';
    const origin = window.location.origin;

    expect(getSafeReturnPath(`${origin}/ihub/apps/chat`)).toBe('/ihub/apps/chat');
    expect(getSafeReturnPath('https://other.example.com/')).toBe('/ihub/');
  });

  test('falls back to / at the root', () => {
    expect(getSafeReturnPath('https://other.example.com/')).toBe('/');
  });
});

describe('getHttpUrl', () => {
  test.each([
    ['https://example.com/tool', 'https://example.com/tool'],
    ['http://intranet.example.com:8080/a?b=c', 'http://intranet.example.com:8080/a?b=c'],
    ['HTTPS://EXAMPLE.COM', 'https://example.com/']
  ])('accepts %s', (value, expected) => {
    expect(getHttpUrl(value)).toBe(expected);
  });

  test('resolves a relative path against the base', () => {
    expect(getHttpUrl('/apps/other', `${ORIGIN}/apps/current`)).toBe(`${ORIGIN}/apps/other`);
  });

  test.each([
    'javascript:void(0)',
    ' javascript:void(0)',
    'data:text/html,hello',
    'file:///etc/hosts',
    'mailto:someone@example.com',
    'ftp://files.example.com/',
    'http://[',
    '',
    '   ',
    null,
    undefined
  ])('rejects %s', value => {
    expect(getHttpUrl(value)).toBeNull();
  });
});
