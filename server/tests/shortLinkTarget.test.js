import { isAllowedShortLinkTarget, normalizeAllowedHosts } from '../utils/shortLinkTarget.js';

describe('isAllowedShortLinkTarget', () => {
  const hosts = ['docs.example.com', 'Intranet.Example.org'];

  test.each(['/', '/apps/chat', '/apps/chat?model=gpt&temp=0.2', '/ihub/apps/chat#top'])(
    'accepts the path %s on this server',
    target => {
      expect(isAllowedShortLinkTarget(target, [])).toBe(true);
    }
  );

  test.each([
    'https://docs.example.com/guide',
    'http://docs.example.com:8080/guide',
    'https://intranet.example.org/'
  ])('accepts %s on an allowed host', target => {
    expect(isAllowedShortLinkTarget(target, hosts)).toBe(true);
  });

  test.each([
    ['another host', 'https://elsewhere.example/'],
    ['a subdomain of an allowed host', 'https://sub.docs.example.com/'],
    ['a protocol-relative URL', '//docs.example.com/'],
    ['a path that normalises to //', '/.//docs.example.com/'],
    ['a parent segment before //', '/a/..//docs.example.com/'],
    ['a backslash after the slash', '/\\docs.example.com/'],
    ['a backslash later in the path', '/apps\\chat'],
    ['a tab inside the path', '/\t/elsewhere.example'],
    ['a line break', '/apps\n/chat'],
    ['a space', '/apps chat'],
    ['a relative path without a leading slash', 'apps/chat'],
    ['a non-http scheme', 'ftp://docs.example.com/'],
    ['a data URL', 'data:text/plain,hello'],
    ['credentials in the URL', 'https://user:pass@docs.example.com/'],
    ['an empty string', ''],
    ['a non-string', 42]
  ])('refuses %s', (_label, target) => {
    expect(isAllowedShortLinkTarget(target, hosts)).toBe(false);
  });

  test('refuses an absolute URL when no host is allowed', () => {
    expect(isAllowedShortLinkTarget('https://docs.example.com/', [])).toBe(false);
    expect(isAllowedShortLinkTarget('https://docs.example.com/', undefined)).toBe(false);
  });
});

describe('normalizeAllowedHosts', () => {
  test('lowercases, trims and drops empty or non-string entries', () => {
    expect(normalizeAllowedHosts([' Docs.Example.com ', '', null, 3])).toEqual([
      'docs.example.com'
    ]);
    expect(normalizeAllowedHosts('docs.example.com')).toEqual([]);
  });
});
