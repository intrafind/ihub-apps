// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  isAllowedHost,
  isAllowedShortLinkTarget,
  normalizeAllowedHostEntry,
  normalizeAllowedHosts,
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

  test.each([
    ['/[a-z]+\\.example\\.com/', 'docs.example.com', true],
    ['/[a-z]+\\.example\\.com/', 'a.b.example.com', false],
    ['/(docs|wiki)\\.intrafind\\.io/', 'wiki.intrafind.io', true],
    ['/(docs|wiki)\\.intrafind\\.io/', 'blog.intrafind.io', false],
    ['/.*\\.intrafind\\.(io|de)/', 'docs.intrafind.de', true],
    ['/.*\\.intrafind\\.(io|de)/', 'docs.intrafind.de.example.net', false],
    ['/intrafind\\.io/', 'docs.intrafind.io', false],
    ['/^intrafind\\.io$/', 'intrafind.io', true]
  ])('regex %s with %s is %s', (entry, hostname, expected) => {
    expect(isAllowedHost(hostname, [entry])).toBe(expected);
  });

  test('a regex entry that does not compile or is not bounded matches nothing', () => {
    expect(isAllowedHost('docs.example.com', ['/([a-z/'])).toBe(false);
    expect(isAllowedHost('docs.example.com', ['/(.*)+/'])).toBe(false);
    expect(isAllowedHost('docs.example.com', [`/${'a'.repeat(300)}/`])).toBe(false);
    // Other entries in the list still apply.
    expect(isAllowedHost('docs.example.com', ['/([a-z/', 'docs.example.com'])).toBe(true);
  });

  test('an absolute target is accepted when its host matches a pattern', () => {
    const hosts = ['*.intrafind.io', '/[a-z]+\\.example\\.org/'];
    expect(isAllowedShortLinkTarget('https://docs.intrafind.io/guide', hosts)).toBe(true);
    expect(isAllowedShortLinkTarget('https://wiki.example.org/', hosts)).toBe(true);
    expect(isAllowedShortLinkTarget('https://intrafind.io/', hosts)).toBe(false);
    expect(isAllowedShortLinkTarget('https://user@docs.intrafind.io/', hosts)).toBe(false);
    expect(isAllowedShortLinkTarget('ftp://docs.intrafind.io/', hosts)).toBe(false);
  });
});

describe('normalizeAllowedHosts', () => {
  test('lowercases, trims and drops empty or non-string entries', () => {
    expect(normalizeAllowedHosts([' Docs.Example.com ', '', null, 3])).toEqual([
      'docs.example.com'
    ]);
    expect(normalizeAllowedHosts('docs.example.com')).toEqual([]);
  });

  test('keeps regex entries as written', () => {
    expect(normalizeAllowedHosts([' /[A-Z]\\.Example\\.com/ ', '*.Example.com'])).toEqual([
      '/[A-Z]\\.Example\\.com/',
      '*.example.com'
    ]);
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

describe('normalizeAllowedHostEntry', () => {
  test.each([
    ['www.qwant.com', 'www.qwant.com'],
    ['  Docs.Example.COM ', 'docs.example.com'],
    ['*.Example.com', '*.example.com'],
    ['.local', '.local'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['*.bücher.de', '*.xn--bcher-kva.de'],
    ['10.0.0.1', '10.0.0.1'],
    ['[::1]', '[::1]'],
    ['my_host.local', 'my_host.local'],
    ['/(docs|wiki)\\.example\\.org/', '/(docs|wiki)\\.example\\.org/']
  ])('accepts %j as %j', (input, entry) => {
    expect(normalizeAllowedHostEntry(input)).toEqual({ entry });
  });

  test('every accepted host entry matches the host it names', () => {
    for (const [input, url] of [
      ['bücher.de', 'https://bücher.de/'],
      ['*.Example.com', 'https://docs.example.com/'],
      ['[::1]', 'http://[::1]:3000/']
    ]) {
      const { entry } = normalizeAllowedHostEntry(input);
      expect([input, isAllowedShortLinkTarget(url, [entry])]).toEqual([input, true]);
    }
  });

  test('refuses a URL and says which host to enter instead', () => {
    expect(normalizeAllowedHostEntry('https://www.qwant.com/')).toEqual({
      error: 'is a URL; enter its host www.qwant.com instead'
    });
  });

  test.each(['', '   ', 'bad host!', '*.', 'www.qwant.com/path', 'host:8080', '/(.*)+/', 42])(
    'refuses %j',
    input => {
      expect(normalizeAllowedHostEntry(input)).toHaveProperty('error');
    }
  );
});
