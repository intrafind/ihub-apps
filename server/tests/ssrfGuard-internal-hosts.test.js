// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The SSRF guard with `allowPrivate`: a caller (the Website Corpus) may let
 * company-internal addresses through, and the machine itself (loopback), link-local
 * addresses, reserved ranges and the cloud metadata services stay blocked.
 * Without the option nothing changes: every private address is refused.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPublicTarget,
  createPinnedLookup,
  isAlwaysBlockedIP,
  isBlockedIP,
  isPrivateIP
} from '../utils/ssrfGuard.js';

/** What a company network is made of: allowed with `allowPrivate`, refused without. */
const INTERNAL = [
  '10.0.0.5',
  '10.255.255.254',
  '172.16.0.1',
  '172.31.255.1',
  '192.168.1.20',
  '100.64.0.1',
  '100.127.255.254',
  '100.100.100.199', // next to Alibaba's metadata address, which is the one blocked
  '100.100.100.201',
  'fd12:3456::1',
  'fc00::1',
  '::ffff:10.0.0.5',
  '::ffff:192.168.1.1'
];

/** Never reachable, whatever the option says. */
const NEVER = [
  '127.0.0.1',
  '127.255.255.255',
  '0.0.0.0',
  '169.254.169.254', // AWS, Azure and GCP metadata
  '169.254.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '100.100.100.200', // Alibaba metadata, inside the shared address space
  '::1',
  '::',
  'fe80::1',
  'fd00:ec2::254', // AWS metadata over IPv6, inside unique-local
  'ff02::1',
  // The same addresses in IPv6 wrappers.
  '::ffff:127.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:a9fe:a9fe',
  '::ffff:100.100.100.200',
  '64:ff9b::169.254.169.254',
  '::169.254.169.254'
];

describe('isAlwaysBlockedIP / isBlockedIP', () => {
  it('lets a company network through when allowed', () => {
    for (const ip of INTERNAL) {
      assert.equal(isPrivateIP(ip), true, `${ip} is private`);
      assert.equal(isAlwaysBlockedIP(ip), false, `${ip} is not always blocked`);
      assert.equal(isBlockedIP(ip), true, `${ip} is blocked by default`);
      assert.equal(
        isBlockedIP(ip, { allowPrivate: true }),
        false,
        `${ip} passes with allowPrivate`
      );
    }
  });

  it('keeps loopback, link-local, reserved and metadata addresses blocked in every notation', () => {
    for (const ip of NEVER) {
      assert.equal(isAlwaysBlockedIP(ip), true, `${ip} is always blocked`);
      assert.equal(isBlockedIP(ip, { allowPrivate: true }), true, `${ip} stays blocked`);
      assert.equal(isBlockedIP(ip), true, `${ip} is blocked by default`);
    }
  });

  it('treats public addresses as reachable either way, and unknown input as blocked', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '100.63.255.255']) {
      assert.equal(isBlockedIP(ip), false, ip);
      assert.equal(isBlockedIP(ip, { allowPrivate: true }), false, ip);
    }
    assert.equal(isAlwaysBlockedIP(''), true);
    assert.equal(isAlwaysBlockedIP(undefined), true);
    assert.equal(isAlwaysBlockedIP('fe80::zz'), true, 'not an address at all');
    assert.equal(isAlwaysBlockedIP('not-an-ip'), true);
  });
});

describe('assertPublicTarget with allowPrivate', () => {
  const url = host => new URL(`http://${host}/`);

  it('refuses every private address by default, as before', async () => {
    for (const ip of [
      ...INTERNAL.filter(ip => !ip.includes(':')),
      '127.0.0.1',
      '169.254.169.254'
    ]) {
      const result = await assertPublicTarget(url(ip));
      assert.equal(result.ok, false, ip);
      assert.match(result.reason, /private/);
    }
  });

  it('allows a company-internal literal when asked to, and pins it', async () => {
    for (const ip of ['10.1.2.3', '172.20.0.9', '192.168.0.10', '100.64.1.1']) {
      assert.deepEqual(await assertPublicTarget(url(ip), { allowPrivate: true }), {
        ok: true,
        addresses: [ip]
      });
    }
    assert.equal(
      (await assertPublicTarget(url('[fd12:3456::1]'), { allowPrivate: true })).ok,
      true
    );
  });

  it('still refuses loopback, localhost, link-local and the metadata services', async () => {
    for (const host of [
      '127.0.0.1',
      '169.254.169.254',
      '100.100.100.200',
      '[::1]',
      '[fe80::1]',
      '[fd00:ec2::254]',
      '[::ffff:169.254.169.254]',
      '0.0.0.0',
      'localhost',
      'app.localhost'
    ]) {
      const result = await assertPublicTarget(url(host), { allowPrivate: true });
      assert.equal(result.ok, false, `${host} must stay blocked`);
    }
  });

  it('does not change what a public address does', async () => {
    assert.equal((await assertPublicTarget(url('93.184.216.34'), { allowPrivate: true })).ok, true);
    assert.equal((await assertPublicTarget(url('93.184.216.34'))).ok, true);
  });
});

describe('createPinnedLookup with allowPrivate', () => {
  const lookup = (addresses, options) =>
    new Promise((resolve, reject) =>
      createPinnedLookup(addresses, options)('x.corp', { all: true }, (error, entries) =>
        error ? reject(error) : resolve(entries)
      )
    );

  it('re-checks every address at connect time with the same rule it was validated with', async () => {
    await assert.rejects(lookup(['10.0.0.5']), { code: 'ENOTFOUND' });
    assert.deepEqual(await lookup(['10.0.0.5'], { allowPrivate: true }), [
      { address: '10.0.0.5', family: 4 }
    ]);
    // An address that slipped in later (rebinding) is dropped, not connected to.
    assert.deepEqual(await lookup(['10.0.0.5', '169.254.169.254'], { allowPrivate: true }), [
      { address: '10.0.0.5', family: 4 }
    ]);
    await assert.rejects(lookup(['169.254.169.254'], { allowPrivate: true }), {
      code: 'ENOTFOUND'
    });
    await assert.rejects(lookup(['127.0.0.1'], { allowPrivate: true }), { code: 'ENOTFOUND' });
  });
});

describe('more addresses that are never reachable', () => {
  const never = [
    '168.63.129.16', // Azure WireServer
    '192.0.0.192',
    '192.0.0.8',
    'fec0::1', // site-local
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2002:a9fe:a9fe::1', // 6to4 of 169.254.169.254
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '::ffff:0:a9fe:a9fe', // IPv4-translated metadata address
    '64:ff9b:1::1' // local-use NAT64
  ];
  it('keeps them blocked with and without the internal-address option', () => {
    for (const ip of never) {
      assert.equal(isAlwaysBlockedIP(ip), true, ip);
      assert.equal(isBlockedIP(ip, { allowPrivate: true }), true, ip);
      assert.equal(isBlockedIP(ip), true, ip);
    }
  });
  it('still allows the company network and public 6to4 / documentation neighbours', () => {
    for (const ip of ['10.1.2.3', '192.0.2.1', '192.168.0.9', '2002:5db8:d822::1']) {
      assert.equal(isBlockedIP(ip, { allowPrivate: true }), false, ip);
    }
  });
});
