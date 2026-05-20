import { describe, it, expect } from '@jest/globals';
import { isPrivateIp, assertSafeHost } from '../../services/mcp/safeFetch.js';

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
});
