/**
 * SSRF protection helpers for outbound workflow HTTP requests.
 *
 * Classifies IP addresses by network range on their canonical numeric form and
 * provides a DNS-pinning lookup so a validated request cannot be re-pointed at
 * an internal host between the check and the connection (DNS rebinding).
 *
 * Kept dependency-free (only node:net / node:dns) so it can be unit tested in
 * isolation and reused by any outbound-request code path.
 *
 * @module utils/ssrfGuard
 */

import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Classify a 4-octet IPv4 address (as bytes) as private/sensitive.
 *
 * Blocks:
 * - Unspecified (0/8) and loopback (127/8)
 * - RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)
 * - Link-local (169.254/16) -- includes AWS/GCP/Azure IMDS (169.254.169.254)
 * - Shared address space / CGNAT (100.64.0.0/10, RFC 6598)
 * - Multicast and reserved (224/4, 240/4)
 *
 * @param {number[]} bytes - Four octets [a, b, c, d]
 * @returns {boolean} True if the address is in a blocked range
 */
export function isPrivateIPv4Bytes([a, b]) {
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 shared/CGNAT
  if (a === 169 && b === 254) return true; // link-local (IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
  return false;
}

/**
 * Parse an IPv6 address literal into its 16 octets.
 *
 * Handles `::` zero-compression, an embedded dotted-quad IPv4 tail
 * (e.g. `::ffff:1.2.3.4` or `64:ff9b::1.2.3.4`), and zone identifiers
 * (`fe80::1%eth0`). The input is expected to already be a syntactically
 * valid IPv6 literal (net.isIP(ip) === 6); anything that fails to parse
 * returns null so callers can treat it as blocked.
 *
 * @param {string} ip - IPv6 address literal
 * @returns {number[]|null} 16 octets, or null if unparseable
 */
export function ipv6ToBytes(ip) {
  // Drop any zone identifier (e.g. fe80::1%eth0).
  let addr = ip.toLowerCase().split('%')[0];

  // Fold an embedded dotted-quad IPv4 tail into two hextets so the address
  // becomes pure hex. This is what lets the mapped-hex form and the
  // dotted form normalize to the same 16 octets.
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = addr.slice(lastColon + 1);
    if (net.isIP(v4) !== 4) return null;
    const [a, b, c, d] = v4.split('.').map(Number);
    addr =
      addr.slice(0, lastColon + 1) +
      (((a << 8) | b) >>> 0).toString(16) +
      ':' +
      (((c << 8) | d) >>> 0).toString(16);
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null; // more than one '::' is illegal

  const head = halves[0] ? halves[0].split(':') : [];
  let hextets;
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    hextets = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;

  const bytes = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const val = parseInt(h, 16);
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }
  return bytes;
}

/**
 * Classify a 16-octet IPv6 address (as bytes) as private/sensitive.
 *
 * Decodes IPv4-in-IPv6 transition wrappers to the embedded IPv4 and
 * classifies that instead, so e.g. `::ffff:a9fe:a9fe`, `::ffff:169.254.169.254`,
 * and `64:ff9b::169.254.169.254` all resolve to 169.254.169.254 and are blocked.
 *
 * Blocks: unspecified (::), loopback (::1), multicast (ff00::/8),
 * link-local (fe80::/10), unique-local (fc00::/7), and any wrapper whose
 * embedded IPv4 is private.
 *
 * @param {number[]} b - 16 octets
 * @returns {boolean} True if the address is in a blocked range
 */
export function isPrivateIPv6Bytes(b) {
  const zeroRange = (start, end) => b.slice(start, end).every(x => x === 0);

  if (zeroRange(0, 16)) return true; // :: unspecified
  if (zeroRange(0, 15) && b[15] === 1) return true; // ::1 loopback
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local (fc/fd)

  // IPv4-mapped ::ffff:0:0/96 -> classify embedded IPv4
  if (zeroRange(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIPv4Bytes(b.slice(12));
  }
  // IPv4-compatible ::/96 (deprecated) -> classify embedded IPv4
  if (zeroRange(0, 12)) {
    return isPrivateIPv4Bytes(b.slice(12));
  }
  // NAT64 64:ff9b::/96 -> classify embedded IPv4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeroRange(4, 12)) {
    return isPrivateIPv4Bytes(b.slice(12));
  }
  return false;
}

/**
 * Check whether a single IP address literal (v4 or v6, in any serialization)
 * belongs to a private or otherwise sensitive network range.
 *
 * IPv6 is parsed to its canonical 16 octets and classified by range, rather
 * than matched textually. This closes serialization-based SSRF bypasses such
 * as the IPv4-mapped hex form `::ffff:a9fe:a9fe` (== 169.254.169.254), which a
 * dotted-decimal regex would miss.
 *
 * @param {string} ip - The IP address to check
 * @returns {boolean} True if the IP is in a blocked range
 */
export function isPrivateIP(ip) {
  if (!ip) return true; // be safe: unknown is blocked
  const family = net.isIP(ip);

  if (family === 4) {
    return isPrivateIPv4Bytes(ip.split('.').map(Number));
  }

  if (family === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true; // unparseable IPv6 literal -> block to be safe
    return isPrivateIPv6Bytes(bytes);
  }

  // Not a valid IP literal -- callers should resolve DNS first.
  return false;
}

/**
 * Match a hostname against a single allowlist pattern.
 *   - `*.example.com` matches any subdomain (e.g. `api.example.com`) but NOT
 *     `example.com` itself
 *   - `.example.com` is an alias for `*.example.com` — subdomains only, NOT
 *     `example.com` itself
 *   - everything else is an exact-match hostname (case-insensitive)
 *
 * This is the single canonical matcher for `platform.ssrf.allowedHosts` and
 * any per-caller allow lists; callers should not maintain their own copy.
 *
 * @param {string} hostname
 * @param {string} pattern
 * @returns {boolean}
 */
export function hostMatchesPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return Boolean(base) && h.endsWith('.' + base);
  }
  if (p.startsWith('.')) {
    // Subdomain pattern — bare domain must NOT match (per repo convention)
    const base = p.slice(1);
    return Boolean(base) && h.endsWith(p);
  }
  return h === p;
}

/**
 * Check whether a hostname matches any pattern in an allowlist (e.g. a
 * per-caller `allowHosts` array merged with the admin-managed
 * `platform.ssrf.allowedHosts`).
 *
 * @param {string} hostname
 * @param {string[]} allowList
 * @returns {boolean}
 */
export function isAllowedHost(hostname, allowList) {
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  return allowList.some(pattern => hostMatchesPattern(hostname, pattern));
}

/**
 * SSRF guard: resolve the URL's hostname to one or more IP addresses and
 * verify every resolved IP is in a public range. Catches DNS-based
 * bypasses where an external hostname resolves to a private IP.
 *
 * On success returns the set of validated public addresses so the caller can
 * pin the connection to them (see {@link createPinnedLookup}) and avoid a
 * DNS-rebinding window between this check and the actual fetch.
 *
 * @param {URL} parsedUrl - The parsed request URL
 * @param {Object} [options]
 * @param {string[]} [options.allowedHosts] - Patterns (see {@link hostMatchesPattern})
 *   that bypass the private-IP veto for this hostname, e.g. the admin-managed
 *   `platform.ssrf.allowedHosts` merged with any per-caller allow list. DNS is
 *   still resolved (when applicable) so the caller can pin the connection.
 * @returns {Promise<{ok: boolean, reason?: string, addresses?: string[]}>}
 */
export async function assertPublicTarget(parsedUrl, options = {}) {
  const { allowedHosts = [] } = options;

  // Strip IPv6 brackets that URL parsing leaves on the hostname.
  let host = parsedUrl.hostname;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  const allowed = isAllowedHost(host, allowedHosts);

  // Block obvious magic hostnames before DNS even runs.
  const lowerHost = host.toLowerCase();
  if (!allowed && (lowerHost === 'localhost' || lowerHost.endsWith('.localhost'))) {
    return { ok: false, reason: 'localhost is blocked' };
  }

  // If the hostname is already an IP literal, check it directly. No DNS is
  // performed for literals, so there is nothing to pin/rebind.
  if (net.isIP(host)) {
    if (allowed) return { ok: true, addresses: [host] };
    return isPrivateIP(host)
      ? { ok: false, reason: `IP ${host} is private` }
      : { ok: true, addresses: [host] };
  }

  // Resolve A and AAAA. If both fail we'll reject; if either resolves to a
  // private IP we reject. Any unresolved family is ignored (not all hosts
  // have both records).
  let addrs = [];
  try {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
    if (v4.status === 'fulfilled') addrs.push(...v4.value);
    if (v6.status === 'fulfilled') addrs.push(...v6.value);
  } catch (err) {
    return { ok: false, reason: `DNS resolution failed: ${err.message}` };
  }

  if (addrs.length === 0) {
    return { ok: false, reason: 'host did not resolve to any IP' };
  }

  if (!allowed) {
    for (const addr of addrs) {
      if (isPrivateIP(addr)) {
        return { ok: false, reason: `host resolves to private IP ${addr}` };
      }
    }
  }
  return { ok: true, addresses: addrs };
}

/**
 * Build a `dns.lookup`-compatible function that pins resolution to a fixed set
 * of pre-validated public addresses.
 *
 * Passing this as the connection's `lookup` closes the DNS-rebinding window:
 * without it, {@link assertPublicTarget} validates the records returned by one
 * resolution but the fetch re-resolves at connect time, so an attacker who
 * controls the authoritative DNS can answer "public" during the check and
 * "private" at connect. Here the connection can only ever reach an address
 * that already passed the guard, and each address is re-checked for good
 * measure before it is handed back.
 *
 * Note: this only takes effect for direct connections. When an HTTP proxy is
 * configured the proxy performs egress DNS itself and is treated as the trust
 * boundary, so the lookup is not applied there.
 *
 * @param {string[]} addresses - Validated public IP addresses
 * @param {Object} [options]
 * @param {boolean} [options.allowPrivate] - Skip the defense-in-depth private-IP
 *   re-check. Set this when `addresses` came from an `assertPublicTarget` call
 *   whose `allowedHosts` matched this hostname — otherwise a legitimately
 *   allow-listed private/internal address would be silently dropped here and
 *   the connection would fail with ENOTFOUND, defeating the allowlist.
 * @returns {Function} A `(hostname, options, callback)` lookup function
 */
export function createPinnedLookup(addresses, options = {}) {
  const { allowPrivate = false } = options;
  const allowed = [...new Set(addresses || [])];
  return function pinnedLookup(hostname, lookupOptions, callback) {
    if (typeof lookupOptions === 'function') {
      callback = lookupOptions;
      lookupOptions = {};
    } else if (typeof lookupOptions === 'number') {
      lookupOptions = { family: lookupOptions };
    }
    lookupOptions = lookupOptions || {};

    const wantFamily = lookupOptions.family || 0;
    const entries = [];
    for (const addr of allowed) {
      const fam = net.isIP(addr);
      if (fam === 0) continue;
      if (wantFamily && wantFamily !== fam) continue;
      if (!allowPrivate && isPrivateIP(addr)) continue; // defense-in-depth re-check
      entries.push({ address: addr, family: fam });
    }

    if (entries.length === 0) {
      const err = new Error(`pinned lookup: no validated public address for ${hostname}`);
      err.code = 'ENOTFOUND';
      return callback(err);
    }

    if (lookupOptions.all) return callback(null, entries);
    return callback(null, entries[0].address, entries[0].family);
  };
}
