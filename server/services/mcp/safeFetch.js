import dns from 'dns';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import configCache from '../../configCache.js';

const dnsLookupAsync = dns.promises.lookup;

/**
 * Match a hostname against a single allowlist pattern. Mirrors the pattern
 * semantics used by `ssl.domainWhitelist` (see `utils/httpConfig.js`):
 *   - `*.example.com` matches any subdomain (e.g. `api.example.com`) but NOT
 *     `example.com` itself
 *   - `.example.com` is an alias for `*.example.com` — subdomains only, NOT
 *     `example.com` itself
 *   - everything else is an exact-match hostname (case-insensitive)
 *
 * Kept inline (rather than imported from httpConfig) so this security-critical
 * module stays dependency-light and the matcher can be tested in isolation.
 * Exported for direct unit testing of the matching semantics.
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
 * Look up the admin-configured global SSRF allowlist from platform.json and
 * test the hostname against it. Returns false if configCache is not hydrated
 * or no patterns are defined.
 */
function isInGlobalSsrfAllowlist(hostname) {
  const platform = configCache.getPlatform?.() || {};
  const list = platform.ssrf?.allowedHosts;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some(pattern => hostMatchesPattern(hostname, pattern));
}

const PRIVATE_IP_RE = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^::ffff:127\./i,
  /^::ffff:10\./i,
  /^::ffff:192\.168\./i,
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
  /^fc/i,
  /^fd/i,
  /^fe80:/i
];

function isPrivateIp(ip) {
  return PRIVATE_IP_RE.some(re => re.test(ip));
}

/**
 * Resolve `hostname` once, return the IP, and reject anything that lives on a
 * private/internal range. Unlike a string-blocklist guard this can't be bypassed
 * by a public DNS record pointing at 127.0.0.1.
 */
async function resolveAndCheck(hostname, allowList, blockPrivateIps = true) {
  // The private-IP veto is skipped when:
  //   - the operator has disabled the check on this call (blockPrivateIps:false),
  //   - the hostname is on the per-caller exact-match allow list (e.g. a
  //     per-tool/per-MCP-server `allowedHosts`) — case-insensitive, trimmed,
  //   - OR the hostname matches a platform-wide pattern in
  //     `platform.ssrf.allowedHosts` (admin-managed, supports wildcards).
  // DNS is still resolved once so the socket can be pinned either way.
  const lowerHost = hostname.toLowerCase();
  const inCallerAllowList =
    Array.isArray(allowList) &&
    allowList.some(h => typeof h === 'string' && h.trim().toLowerCase() === lowerHost);
  const skipPrivateVeto =
    !blockPrivateIps || inCallerAllowList || isInGlobalSsrfAllowlist(hostname);

  let result;
  try {
    result = await dnsLookupAsync(hostname);
  } catch (err) {
    const e = new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
    e.code = 'DNS_RESOLUTION_FAILED';
    throw e;
  }
  if (!skipPrivateVeto && isPrivateIp(result.address)) {
    const e = new Error(
      `SSRF guard: hostname ${hostname} resolves to private IP ${result.address}`
    );
    e.code = 'SSRF_BLOCKED';
    throw e;
  }
  return result;
}

/**
 * Build a constant `dns.lookup`-shaped function that always resolves to the
 * pre-validated `(address, family)` tuple. Honors `options.all` because Node's
 * net stack (v20+) calls lookup with `{ all: true }` and expects an array of
 * `{ address, family }` objects — returning the legacy 3-arg form there yields
 * `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.
 */
function makePinnedLookup(pinnedAddress, family) {
  return (_hostname, opts, cb) => {
    if (opts && opts.all) {
      cb(null, [{ address: pinnedAddress, family }]);
    } else {
      cb(null, pinnedAddress, family);
    }
  };
}

/**
 * Build an https/http Agent that pins the socket to the IP we already vetted,
 * so the actual TCP connection cannot land on a different host (DNS rebinding).
 */
function makePinnedAgent(pinnedAddress, family, isHttps) {
  const AgentClass = isHttps ? https.Agent : http.Agent;
  return new AgentClass({
    keepAlive: true,
    maxSockets: 8,
    lookup: makePinnedLookup(pinnedAddress, family)
  });
}

/**
 * Drop-in `fetch` replacement that:
 *   1. Resolves DNS once.
 *   2. Refuses private/internal IPs (unless explicitly allow-listed).
 *   3. Pins the underlying socket to that IP so subsequent re-resolution
 *      between validation and connect can't swing to localhost.
 *
 * The original hostname is preserved in the `Host` header (and SNI) so TLS
 * cert validation still works against the public name.
 */
export async function safeFetch(input, init = {}, opts = {}) {
  const url = typeof input === 'string' ? new URL(input) : input;
  if (!['http:', 'https:'].includes(url.protocol)) {
    const e = new Error(`Unsupported protocol: ${url.protocol}`);
    e.code = 'UNSUPPORTED_PROTOCOL';
    throw e;
  }

  const { address, family } = await resolveAndCheck(
    url.hostname,
    opts.allowHosts,
    opts.blockPrivateIps !== false
  );
  const agent = makePinnedAgent(address, family, url.protocol === 'https:');

  // Node 18+ `fetch` (undici) does not accept the legacy `agent` option, so
  // when running under undici we set a dispatcher. When undici is unavailable
  // (older Node) we fall back to http.request via a thin shim.
  try {
    const undici = await import('undici');
    const dispatcher = new undici.Agent({
      connect: { lookup: makePinnedLookup(address, family) }
    });
    return await globalThis.fetch(url, { ...init, dispatcher });
  } catch {
    // Fall through to node-http-based fetch
  }

  return await nodeHttpFetch(url, init, agent);
}

/**
 * Minimal fetch implementation for the non-undici fallback. Only used in
 * environments where undici isn't available (very old Node). Covers what the
 * MCP SDK needs: POST/GET, request body, headers, status, response body.
 */
function nodeHttpFetch(url, init, agent) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method || 'GET',
        headers: init.headers || {},
        agent
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: new Map(Object.entries(res.headers || {})),
            text: async () => body.toString('utf8'),
            json: async () => JSON.parse(body.toString('utf8'))
          });
        });
      }
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * Standalone hostname check for code paths that don't go through fetch
 * (e.g. WebSocket transport, stdio command resolution).
 */
export async function assertSafeHost(hostname, allowList, blockPrivateIps = true) {
  await resolveAndCheck(hostname, allowList, blockPrivateIps);
}

export { isPrivateIp };
