/**
 * DNS guard for outbound HTTP connections.
 *
 * Node resolves hostnames with `getaddrinfo` on the libuv threadpool, and
 * libuv lets at most half of that pool (two threads by default) run such
 * "slow I/O" work at once — process-wide. A lookup for a host whose resolver
 * does not answer (a VPN-only model endpoint with the VPN down) blocks one of
 * those slots for the operating system's resolver timeout, tens of seconds,
 * and aborting the HTTP request does not cancel it. One chat turn against such
 * a host issues several lookups (discovery, then each connect attempt), so both
 * slots fill up and every other outbound request in the process — any model,
 * any user — waits in the DNS queue behind them.
 *
 * The guard wraps `dns.lookup` so that:
 *   - concurrent lookups of the same hostname share one `getaddrinfo` call
 *     instead of each taking a slot;
 *   - a failed or overdue lookup is remembered for a short while and new
 *     requests to that host fail immediately, so a dead host costs one slot
 *     once, not once per attempt;
 *   - callers wait at most `timeoutMs` for an answer; the OS call finishes in
 *     the background and, if it eventually succeeds, clears the negative entry.
 *
 * IP literals never reach `getaddrinfo` and pass straight through.
 *
 * Env: `DNS_LOOKUP_TIMEOUT_MS` (default 5000), `DNS_NEGATIVE_CACHE_MS`
 * (default 30000). Set either to 0 to disable that part.
 */
import dns from 'node:dns';
import net from 'node:net';

const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_NEGATIVE_CACHE_MS = 30_000;

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Error returned to callers when a lookup did not finish within the guard's
 * timeout. Shaped like a `getaddrinfo` system error so the callers that
 * classify network failures (`erroredSysCall` / `syscall`, `hostname`) treat
 * it as a DNS failure.
 */
export function dnsTimeoutError(hostname, timeoutMs) {
  const err = new Error(
    `getaddrinfo EAI_TIMEOUT ${hostname}: DNS lookup did not complete within ${timeoutMs} ms`
  );
  err.code = 'EAI_TIMEOUT';
  err.errno = -3008; // EAI_AGAIN's errno; the closest standard code
  err.syscall = 'getaddrinfo';
  err.hostname = hostname;
  return err;
}

/**
 * Whether an error (or its cause chain) is a hostname resolution failure:
 * a `getaddrinfo` system error, the guard's own timeout, or a node-fetch
 * wrapper of either (`erroredSysCall`).
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isDnsFailure(err) {
  let e = err;
  for (let depth = 0; e && depth < 4; depth++) {
    if (e.syscall === 'getaddrinfo' || e.erroredSysCall === 'getaddrinfo') return true;
    if (
      /^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|EAI_NODATA|EAI_TIMEOUT)$/.test(
        String(e.code || '')
      )
    )
      return true;
    e = e.cause;
  }
  return false;
}

/**
 * Create a `dns.lookup`-compatible function with de-duplication, a bounded
 * wait, and a negative cache.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.inner=dns.lookup] - the real resolver
 * @param {number} [opts.timeoutMs] - max wait per caller; 0 disables
 * @param {number} [opts.negativeTtlMs] - how long a failure is remembered; 0 disables
 * @param {() => number} [opts.now=Date.now]
 * @returns {Function & { stats: () => object, reset: () => void }}
 */
export function createGuardedLookup({
  inner = dns.lookup,
  timeoutMs = envMs('DNS_LOOKUP_TIMEOUT_MS', DEFAULT_LOOKUP_TIMEOUT_MS),
  negativeTtlMs = envMs('DNS_NEGATIVE_CACHE_MS', DEFAULT_NEGATIVE_CACHE_MS),
  now = Date.now
} = {}) {
  const inflight = new Map(); // key -> { waiters: Function[] }
  const negative = new Map(); // hostname -> { until: number, error: Error }
  const counters = { lookups: 0, shared: 0, timeouts: 0, negativeHits: 0 };

  function remember(hostname, error) {
    if (negativeTtlMs > 0) negative.set(hostname, { until: now() + negativeTtlMs, error });
  }

  function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};
    // IP literals are answered by Node without touching the threadpool.
    if (typeof hostname !== 'string' || net.isIP(hostname)) {
      return inner(hostname, options, callback);
    }

    const cached = negative.get(hostname);
    if (cached) {
      if (cached.until > now()) {
        counters.negativeHits++;
        return process.nextTick(callback, cached.error);
      }
      negative.delete(hostname);
    }

    const family = typeof options === 'number' ? options : (options.family ?? 0);
    const key = `${hostname}|${family}|${options.all ? 'all' : 'one'}|${options.hints ?? 0}|${options.verbatim ?? ''}|${options.order ?? ''}`;
    let entry = inflight.get(key);
    if (entry) {
      counters.shared++;
      entry.waiters.push(callback);
      return undefined;
    }

    entry = { waiters: [callback], settled: false };
    inflight.set(key, entry);
    counters.lookups++;

    const settle = (err, ...results) => {
      if (entry.settled) return;
      entry.settled = true;
      if (timer) clearTimeout(timer);
      inflight.delete(key);
      if (err) remember(hostname, err);
      else negative.delete(hostname);
      const waiters = entry.waiters;
      entry.waiters = [];
      for (const waiter of waiters) {
        try {
          waiter(err, ...results);
        } catch {
          /* a throwing callback must not break the other waiters */
        }
      }
    };

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        counters.timeouts++;
        settle(dnsTimeoutError(hostname, timeoutMs));
      }, timeoutMs);
    }

    try {
      inner(hostname, options, (err, ...results) => {
        if (entry.settled) {
          // The OS answered after we gave up: a success means the host is fine
          // again, so stop failing fast for it.
          if (!err) negative.delete(hostname);
          return;
        }
        settle(err, ...results);
      });
    } catch (err) {
      settle(err);
    }
    return undefined;
  }

  guardedLookup.stats = () => ({
    ...counters,
    inflight: inflight.size,
    negative: negative.size,
    timeoutMs,
    negativeTtlMs
  });
  guardedLookup.reset = () => {
    inflight.clear();
    negative.clear();
    for (const k of Object.keys(counters)) counters[k] = 0;
  };
  return guardedLookup;
}

/** Process-wide guard used by every direct (non-proxied) outbound connection. */
export const guardedLookup = createGuardedLookup();

export default guardedLookup;
