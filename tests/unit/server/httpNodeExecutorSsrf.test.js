/**
 * SSRF guard regression tests for the workflow HTTP node executor.
 *
 * Pins the fix for the IPv4-mapped-IPv6 hex bypass (GHSA-fp9c-pq7w-vr34):
 * `http://[::ffff:a9fe:a9fe]/` decodes to 169.254.169.254 (AWS IMDS) and must
 * be classified as private regardless of serialization. Also covers the
 * additional classification gaps (NAT64, 100.64.0.0/10) and the DNS-pinning
 * lookup that closes the rebinding window.
 */
import { describe, expect, test } from '@jest/globals';
import {
  isPrivateIP,
  ipv6ToBytes,
  assertPublicTarget,
  createPinnedLookup
} from '../../../server/services/workflow/executors/ssrfGuard.js';

describe('isPrivateIP — IPv4-mapped IPv6 hex bypass (GHSA-fp9c-pq7w-vr34)', () => {
  test('blocks the canonical mapped-hex form of AWS IMDS', () => {
    // ::ffff:a9fe:a9fe == 169.254.169.254
    expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true);
  });

  test('blocks the mapped-hex form of loopback', () => {
    // ::ffff:7f00:1 == 127.0.0.1
    expect(isPrivateIP('::ffff:7f00:1')).toBe(true);
  });

  test('blocks the dotted mapped form of IMDS (already covered, stays covered)', () => {
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
  });

  test('both serializations decode to the same octets', () => {
    expect(ipv6ToBytes('::ffff:a9fe:a9fe')).toEqual(ipv6ToBytes('::ffff:169.254.169.254'));
  });

  test('does NOT over-block a mapped public address', () => {
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIP('::ffff:0808:0808')).toBe(false);
  });
});

describe('isPrivateIP — IPv4 ranges', () => {
  test.each([
    ['10.0.0.1', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['0.0.0.0', true],
    ['100.64.0.1', true], // CGNAT / shared address space (RFC 6598)
    ['100.127.255.255', true],
    ['224.0.0.1', true], // multicast
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['100.63.255.255', false], // just below 100.64/10
    ['100.128.0.0', false] // just above 100.64/10
  ])('%s -> %s', (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });
});

describe('isPrivateIP — IPv6 ranges', () => {
  test.each([
    ['::1', true], // loopback
    ['::', true], // unspecified
    ['fe80::1', true], // link-local
    ['fc00::1', true], // ULA
    ['fd12:3456::1', true], // ULA
    ['ff02::1', true], // multicast
    ['64:ff9b::169.254.169.254', true], // NAT64 wrapping IMDS
    ['64:ff9b::a9fe:a9fe', true], // NAT64 wrapping IMDS (hex)
    ['2606:4700:4700::1111', false], // public (Cloudflare)
    ['2001:4860:4860::8888', false] // public (Google)
  ])('%s -> %s', (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });

  test('unparseable / empty inputs are blocked (fail closed)', () => {
    expect(isPrivateIP('')).toBe(true);
    expect(isPrivateIP(null)).toBe(true);
  });
});

describe('assertPublicTarget — IP literal targets', () => {
  test('rejects the mapped-hex IMDS literal', async () => {
    const res = await assertPublicTarget(new URL('http://[::ffff:a9fe:a9fe]/latest/meta-data/'));
    expect(res.ok).toBe(false);
  });

  test('rejects localhost before any DNS', async () => {
    const res = await assertPublicTarget(new URL('http://localhost:8080/'));
    expect(res.ok).toBe(false);
  });

  test('accepts a public IP literal and returns it for pinning', async () => {
    const res = await assertPublicTarget(new URL('http://8.8.8.8/'));
    expect(res.ok).toBe(true);
    expect(res.addresses).toEqual(['8.8.8.8']);
  });
});

describe('createPinnedLookup — DNS rebinding protection', () => {
  const call = (lookup, hostname, options) =>
    new Promise(resolve => {
      lookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
    });

  test('returns only the pre-validated address', async () => {
    const lookup = createPinnedLookup(['93.184.216.34']);
    const { err, address, family } = await call(lookup, 'example.com', {});
    expect(err).toBeFalsy();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  test('supports the all:true (Happy Eyeballs) form', async () => {
    const lookup = createPinnedLookup(['93.184.216.34', '2606:2800:220:1::1']);
    const { err, address: entries } = await call(lookup, 'example.com', { all: true });
    expect(err).toBeFalsy();
    expect(entries).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 }
    ]);
  });

  test('filters by requested family', async () => {
    const lookup = createPinnedLookup(['93.184.216.34', '2606:2800:220:1::1']);
    const v6 = await call(lookup, 'example.com', { family: 6 });
    expect(v6.address).toBe('2606:2800:220:1::1');
    const v4 = await call(lookup, 'example.com', { family: 4 });
    expect(v4.address).toBe('93.184.216.34');
  });

  test('re-checks addresses and refuses a private one (defense in depth)', async () => {
    const lookup = createPinnedLookup(['169.254.169.254']);
    const { err } = await call(lookup, 'evil.example', {});
    expect(err).toBeTruthy();
    expect(err.code).toBe('ENOTFOUND');
  });

  test('errors when no address matches the requested family', async () => {
    const lookup = createPinnedLookup(['93.184.216.34']);
    const { err } = await call(lookup, 'example.com', { family: 6 });
    expect(err).toBeTruthy();
    expect(err.code).toBe('ENOTFOUND');
  });
});
