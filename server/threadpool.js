/**
 * Size the libuv threadpool before anything uses it.
 *
 * This module must be the FIRST import of every entry point (server.js and
 * any wrapper that starts it). libuv reads `UV_THREADPOOL_SIZE` once, when the
 * pool is created on the first threadpool operation (an async file read, a
 * DNS lookup, crypto), and ignores later changes. ES module bodies run in
 * import order, so a first import with no dependencies of its own runs before
 * the rest of the server touches the pool.
 *
 * Why a larger pool: `getaddrinfo` runs on that pool and libuv lets at most
 * half of it run such slow I/O at once. With the default of 4 threads, two
 * hung DNS lookups (an unreachable model endpoint) stall every other outbound
 * request in the process. 16 threads give eight concurrent lookups; the DNS
 * guard in utils/dnsGuard.js keeps a dead host from consuming more than one.
 *
 * Set `UV_THREADPOOL_SIZE` in the environment (or `.env`) to override; values
 * below 1 fall back to the default. libuv caps the size at 1024.
 */
export const DEFAULT_UV_THREADPOOL_SIZE = 16;

const configured = Number(process.env.UV_THREADPOOL_SIZE);
if (!(Number.isInteger(configured) && configured >= 1)) {
  process.env.UV_THREADPOOL_SIZE = String(DEFAULT_UV_THREADPOOL_SIZE);
}

/** The size in effect for this process (as passed to libuv). */
export const uvThreadpoolSize = Number(process.env.UV_THREADPOOL_SIZE);
