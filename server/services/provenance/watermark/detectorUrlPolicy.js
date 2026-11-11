// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where iHub may send watermark keys (#3331).
 *
 * The detector call carries every key, so the target is held to a stricter rule
 * than an ordinary outbound call, and the rule runs at call time (not only when
 * a model is saved):
 * - no credentials in the URL;
 * - never a link-local or cloud-metadata address;
 * - `https:` otherwise always;
 * - `http:` only when every resolved address is loopback or private, or the host
 *   is trusted (`ssl.domainWhitelist`, `ssrf.allowedHosts`).
 *
 * `assertPublicTarget({allowPrivate})` cannot be used: it refuses loopback, and a
 * detector sidecar on 127.0.0.1 is the expected setup.
 *
 * @module services/provenance/watermark/detectorUrlPolicy
 */
import net from 'node:net';
import dns from 'node:dns';
import { isPrivateIP } from '../../../utils/ssrfGuard.js';
import { isSsrfTrustedHost } from '../../../utils/httpConfig.js';

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

const forbidden = new net.BlockList();
forbidden.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, cloud metadata
forbidden.addSubnet('fe80::', 10, 'ipv6');
forbidden.addSubnet('0.0.0.0', 8, 'ipv4');
forbidden.addAddress('::', 'ipv6');
forbidden.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS over IPv6

function family(ip) {
  const f = net.isIP(ip);
  return f === 6 ? 'ipv6' : 'ipv4';
}

/** Unwrap `::ffff:a.b.c.d` so the IPv4 rules apply. */
function unmap(ip) {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return match ? match[1] : ip;
}

export function isLoopbackAddress(ip) {
  const addr = unmap(ip);
  return net.isIP(addr) !== 0 && loopback.check(addr, family(addr));
}

export function isForbiddenAddress(ip) {
  const addr = unmap(ip);
  return net.isIP(addr) === 0 || forbidden.check(addr, family(addr));
}

/**
 * @param {string} url
 * @param {{resolve?: (host: string) => Promise<string[]>}} [options] - `resolve` for tests.
 * @returns {Promise<{ok: true, url: URL, addresses: string[]} | {ok: false, reason: string}>}
 */
export async function checkDetectorUrl(url, { resolve } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'The detector URL is not a valid URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'The detector URL must be http(s)' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'The detector URL must not contain credentials' };
  }
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = resolve
        ? await resolve(host)
        : (await dns.promises.lookup(host, { all: true })).map(entry => entry.address);
    } catch {
      return { ok: false, reason: `The detector host ${host} cannot be resolved` };
    }
  }
  if (!addresses.length)
    return { ok: false, reason: `The detector host ${host} cannot be resolved` };
  if (addresses.some(isForbiddenAddress)) {
    return { ok: false, reason: 'The detector address is link-local or a metadata address' };
  }
  if (parsed.protocol === 'http:') {
    const internal = addresses.every(ip => isLoopbackAddress(ip) || isPrivateIP(unmap(ip)));
    if (!internal && !isSsrfTrustedHost(host)) {
      return {
        ok: false,
        reason: 'Plain http is allowed only for loopback and private addresses; use https'
      };
    }
  }
  return { ok: true, url: parsed, addresses };
}

/**
 * Like {@link checkDetectorUrl}, but throws.
 * @throws {Error} with `code: 'WATERMARK_DETECTOR_URL_REFUSED'`
 */
export async function assertDetectorUrlAllowed(url, options) {
  const result = await checkDetectorUrl(url, options);
  if (!result.ok) {
    const error = new Error(result.reason);
    error.code = 'WATERMARK_DETECTOR_URL_REFUSED';
    throw error;
  }
  return result;
}
