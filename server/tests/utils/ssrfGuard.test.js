import { describe, it, expect } from '@jest/globals';
import {
  isPrivateIP,
  hostMatchesPattern,
  isAllowedHost,
  assertPublicTarget
} from '../../utils/ssrfGuard.js';

describe('ssrfGuard isPrivateIP', () => {
  it('blocks RFC1918, loopback, and link-local IPv4', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('192.168.1.1')).toBe(true);
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('169.254.169.254')).toBe(true); // cloud metadata
  });

  it('blocks CGNAT / shared address space (100.64.0.0/10)', () => {
    expect(isPrivateIP('100.64.0.1')).toBe(true);
    expect(isPrivateIP('100.100.0.1')).toBe(true);
    expect(isPrivateIP('100.127.255.255')).toBe(true);
    expect(isPrivateIP('100.63.255.255')).toBe(false); // just outside 100.64/10
    expect(isPrivateIP('100.128.0.1')).toBe(false); // just outside 100.64/10
  });

  it('blocks multicast and reserved ranges (224/4, 240/4)', () => {
    expect(isPrivateIP('224.0.0.1')).toBe(true);
    expect(isPrivateIP('239.255.255.255')).toBe(true);
    expect(isPrivateIP('240.0.0.1')).toBe(true);
    expect(isPrivateIP('223.255.255.255')).toBe(false); // just outside 224/4
  });

  it('blocks IPv4-mapped IPv6 in hex-compressed form (cloud metadata)', () => {
    // 169.254.169.254 == a9fe:a9fe
    expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true);
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
  });

  it('blocks IPv4-compatible and NAT64 wrappers with a private embedded IPv4', () => {
    expect(isPrivateIP('::10.0.0.1')).toBe(true);
    expect(isPrivateIP('64:ff9b::169.254.169.254')).toBe(true);
  });

  it('blocks IPv6 loopback / unique-local / link-local', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd12:3456::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('does not flag public addresses', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
    expect(isPrivateIP('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('ssrfGuard hostMatchesPattern', () => {
  it('matches wildcard subdomains but not the bare domain', () => {
    expect(hostMatchesPattern('api.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false);
  });

  it('matches exact hosts case-insensitively', () => {
    expect(hostMatchesPattern('API.Example.COM', 'api.example.com')).toBe(true);
    expect(hostMatchesPattern('other.com', 'api.example.com')).toBe(false);
  });
});

describe('ssrfGuard isAllowedHost', () => {
  it('returns false for an empty or missing allow list', () => {
    expect(isAllowedHost('internal.corp', [])).toBe(false);
    expect(isAllowedHost('internal.corp', undefined)).toBe(false);
  });

  it('returns true when any pattern matches', () => {
    expect(isAllowedHost('internal.corp', ['*.other.com', 'internal.corp'])).toBe(true);
  });
});

describe('ssrfGuard assertPublicTarget', () => {
  it('blocks a private IP literal', async () => {
    const result = await assertPublicTarget(new URL('http://169.254.169.254/latest/meta-data'));
    expect(result.ok).toBe(false);
  });

  it('blocks localhost', async () => {
    const result = await assertPublicTarget(new URL('http://localhost/'));
    expect(result.ok).toBe(false);
  });

  it('allows a private IP literal explicitly allow-listed', async () => {
    const result = await assertPublicTarget(new URL('http://169.254.169.254/'), {
      allowedHosts: ['169.254.169.254']
    });
    expect(result.ok).toBe(true);
    expect(result.addresses).toEqual(['169.254.169.254']);
  });
});
