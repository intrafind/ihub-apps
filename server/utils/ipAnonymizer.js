/**
 * Anonymize an IPv4 or IPv6 address by zeroing the host bits, leaving only
 * coarse network information behind. The output is still useful for things
 * like region detection or rate-limiting buckets but cannot be tied back to
 * an individual subscriber.
 *
 * Behaviour:
 *   - IPv4 (`1.2.3.4`)           -> `1.2.3.0`              (zero last octet, /24)
 *   - IPv4-in-IPv6 (`::ffff:…`)  -> `::ffff:1.2.3.0`       (zero last octet, /24)
 *   - IPv6 (`2001:db8:a:b::1`)   -> `2001:db8:a::`         (zero last 80 bits, /48)
 *   - Unparseable input          -> `null`                 (fail closed)
 *
 * Returns the input unchanged when it isn't a string. Passing falsy values
 * (`null`, `undefined`, `''`) returns them as-is so callers don't have to
 * branch on presence.
 *
 * @param {string|null|undefined} ip
 * @returns {string|null|undefined}
 */
export function anonymizeIp(ip) {
  if (!ip || typeof ip !== 'string') return ip;

  const ipv4Mapped = parseIpv4(ip.replace(/^::ffff:/i, ''));
  if (ipv4Mapped && /^::ffff:/i.test(ip)) {
    return `::ffff:${ipv4Mapped[0]}.${ipv4Mapped[1]}.${ipv4Mapped[2]}.0`;
  }

  const ipv4 = parseIpv4(ip);
  if (ipv4) {
    return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0`;
  }

  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups && groups.length === 8 && groups.every(isHexGroup)) {
      return `${groups[0]}:${groups[1]}:${groups[2]}::`;
    }
  }

  return null;
}

// Parse a dotted-quad into [a,b,c,d] only if every octet is a decimal in
// 0-255. Returns null on anything else so we never mask garbage like
// "999.999.999.999".
function parseIpv4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]];
  for (const o of octets) {
    // Reject leading zeros ("01") and out-of-range octets.
    if (o.length > 1 && o[0] === '0') return null;
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  return octets;
}

function isHexGroup(group) {
  return /^[0-9a-fA-F]{1,4}$/.test(group);
}

function expandIpv6(ip) {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  if (parts.length === 1) {
    const groups = ip.split(':');
    return groups.length === 8 ? groups : null;
  }
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill('0'), ...right];
}

export default { anonymizeIp };
