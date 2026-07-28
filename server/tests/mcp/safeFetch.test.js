import { describe, it, expect } from '@jest/globals';
import { isPrivateIp, assertSafeHost, hostMatchesPattern } from '../../services/mcp/safeFetch.js';

describe('mcp/safeFetch isPrivateIp', () => {
  it('matches all RFC1918 IPv4 ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('matches loopback and link-local', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.0.0.42')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // AWS metadata
  });

  it('matches IPv6 loopback / unique-local / link-local', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fc00:1234::1')).toBe(true);
    expect(isPrivateIp('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('does not flag public addresses', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });

  it('does not flag boundary-adjacent ranges that are NOT private', () => {
    expect(isPrivateIp('11.0.0.1')).toBe(false);
    expect(isPrivateIp('172.15.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateIp('172.32.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateIp('192.169.0.1')).toBe(false);
  });

  it('matches CGNAT / shared address space (100.64.0.0/10)', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
    expect(isPrivateIp('100.63.255.255')).toBe(false);
  });

  it('matches multicast and reserved ranges (224/4+)', () => {
    expect(isPrivateIp('224.0.0.1')).toBe(true);
    expect(isPrivateIp('240.0.0.1')).toBe(true);
  });

  it('matches the IPv4-mapped IPv6 hex-compressed form (cloud metadata)', () => {
    // 169.254.169.254 == a9fe:a9fe -- a dotted-decimal regex misses this form
    expect(isPrivateIp('::ffff:a9fe:a9fe')).toBe(true);
  });
});

describe('mcp/safeFetch assertSafeHost', () => {
  it('rejects localhost', async () => {
    await expect(assertSafeHost('localhost')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED'
    });
  });

  it('rejects an explicit private IPv4 literal', async () => {
    await expect(assertSafeHost('127.0.0.1')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('allows hostnames present in allowList even if private', async () => {
    // localhost is private, but explicit allow should let it through (operator opt-in).
    await expect(assertSafeHost('localhost', ['localhost'])).resolves.toBeUndefined();
  });

  it('per-caller allowList is case-insensitive and trims whitespace', async () => {
    // Stored config might preserve casing/whitespace; matching must not depend on it.
    await expect(assertSafeHost('localhost', ['  LOCALHOST  '])).resolves.toBeUndefined();
  });
});

describe('mcp/safeFetch hostMatchesPattern', () => {
  describe('wildcard `*.example.com`', () => {
    it('matches subdomains', () => {
      expect(hostMatchesPattern('api.example.com', '*.example.com')).toBe(true);
      expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(true);
    });

    it('does NOT match the base domain itself', () => {
      expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false);
    });

    it('does NOT match unrelated hosts', () => {
      expect(hostMatchesPattern('attacker.com', '*.example.com')).toBe(false);
      expect(hostMatchesPattern('notexample.com', '*.example.com')).toBe(false);
    });
  });

  describe('subdomain `.example.com` (alias for *.example.com)', () => {
    it('matches subdomains', () => {
      expect(hostMatchesPattern('api.example.com', '.example.com')).toBe(true);
      expect(hostMatchesPattern('a.b.example.com', '.example.com')).toBe(true);
    });

    it('does NOT match the base domain itself (matches isDomainWhitelisted semantics)', () => {
      expect(hostMatchesPattern('example.com', '.example.com')).toBe(false);
    });

    it('does NOT match unrelated hosts', () => {
      expect(hostMatchesPattern('attacker.com', '.example.com')).toBe(false);
    });
  });

  describe('exact patterns', () => {
    it('matches the exact host', () => {
      expect(hostMatchesPattern('api.example.com', 'api.example.com')).toBe(true);
    });

    it('does NOT match a different host that ends with the same suffix', () => {
      expect(hostMatchesPattern('xapi.example.com', 'api.example.com')).toBe(false);
    });

    it('matches case-insensitively', () => {
      expect(hostMatchesPattern('API.Example.COM', 'api.example.com')).toBe(true);
    });

    it('trims pattern whitespace', () => {
      expect(hostMatchesPattern('api.example.com', '  api.example.com  ')).toBe(true);
    });
  });

  describe('degenerate inputs', () => {
    it('returns false for empty hostname or pattern', () => {
      expect(hostMatchesPattern('', 'example.com')).toBe(false);
      expect(hostMatchesPattern('example.com', '')).toBe(false);
      expect(hostMatchesPattern('', '')).toBe(false);
    });

    it('returns false for a wildcard pattern with no base (`*.`)', () => {
      expect(hostMatchesPattern('anything.com', '*.')).toBe(false);
    });

    it('returns false for a subdomain pattern with no base (`.`)', () => {
      expect(hostMatchesPattern('anything.com', '.')).toBe(false);
    });
  });
});
