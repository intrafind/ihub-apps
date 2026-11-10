// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  isAllowedHost,
  isAllowedShortLinkTarget,
  shortLinkTargetRefusal
} from '../utils/shortLinkTarget.js';

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

describe('isAllowedHost with patterns', () => {
  test.each([
    ['*.intrafind.io', 'docs.intrafind.io', true],
    ['*.intrafind.io', 'a.b.intrafind.io', true],
    ['*.intrafind.io', 'intrafind.io', false],
    ['*.intrafind.io', 'otherintrafind.io', false],
    ['*.intrafind.io', 'intrafind.io.example.net', false],
    ['.local', 'server.local', true],
    ['.local', 'a.server.local', true],
    ['.local', 'local', false],
    ['.local', 'server.localdomain', false],
    ['*.Example.COM', 'Docs.example.com', true],
    ['*', 'docs.example.com', false],
    ['*.', 'docs.example.com', false]
  ])('%s with %s is %s', (entry, hostname, expected) => {
    expect(isAllowedHost(hostname, [entry])).toBe(expected);
  });

  test('a /regex/ entry is not a pattern: the SSRF allowlist has none', () => {
    expect(isAllowedHost('docs.example.com', ['/[a-z]+\\.example\\.com/'])).toBe(false);
  });

  test('trims and lowercases entries and ignores non-string ones', () => {
    expect(isAllowedHost('docs.example.com', [' Docs.Example.com ', null, 3])).toBe(true);
    expect(isAllowedHost('docs.example.com', 'docs.example.com')).toBe(false);
  });

  test('an absolute target is accepted when its host matches a pattern', () => {
    const hosts = ['*.intrafind.io', '.example.org'];
    expect(isAllowedShortLinkTarget('https://docs.intrafind.io/guide', hosts)).toBe(true);
    expect(isAllowedShortLinkTarget('https://wiki.example.org/', hosts)).toBe(true);
    expect(isAllowedShortLinkTarget('https://intrafind.io/', hosts)).toBe(false);
    expect(isAllowedShortLinkTarget('https://user@docs.intrafind.io/', hosts)).toBe(false);
    expect(isAllowedShortLinkTarget('ftp://docs.intrafind.io/', hosts)).toBe(false);
  });
});

describe('shortLinkTargetRefusal', () => {
  test('is null for an allowed target', () => {
    expect(shortLinkTargetRefusal('/apps/chat', [])).toBeNull();
    expect(shortLinkTargetRefusal('https://www.qwant.com/', ['www.qwant.com'])).toBeNull();
  });

  // The host an administrator has to allow, so the error can name it.
  test.each([
    ['https://www.qwant.com/', 'www.qwant.com'],
    ['http://Docs.Example.com:8080/x?y=1', 'docs.example.com'],
    ['https://bücher.de/', 'xn--bcher-kva.de']
  ])('names the host of %s when only the host is missing', (target, host) => {
    expect(shortLinkTargetRefusal(target, [])).toEqual({ reason: 'host', host });
  });

  test.each([
    'ftp://www.qwant.com/',
    'javascript:alert(1)',
    'https://user:pass@www.qwant.com/',
    '//www.qwant.com/',
    '/\\www.qwant.com/',
    'not a url',
    42
  ])('refuses %s without naming a host: allowing one would not help', target => {
    expect(shortLinkTargetRefusal(target, [])).toEqual({ reason: 'target' });
  });
});
