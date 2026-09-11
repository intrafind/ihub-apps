/**
 * LockManager — the mutual-exclusion facet of a storage provider.
 *
 * One primitive: run a function while holding a named lease. Leases carry a
 * TTL rather than relying on a clean release, because the holder can be a
 * process that died — with a shared volume or a shared database, a lock nobody
 * can take over is an outage.
 *
 * How far the exclusion reaches is a declared capability
 * (`getCapabilities().locking`): `'advisory-single-machine'` for the
 * filesystem provider (cluster workers on one volume), `'distributed'` for a
 * provider that can guard several instances.
 *
 * This class is the written contract, not an implementation: every method
 * throws {@link NotSupportedError}. Providers extend it and prove they honour
 * the semantics documented here by passing the conformance suite in
 * `server/storage/__tests__/providerConformance.js`.
 *
 * @module storage/LockManager
 */
import { NotSupportedError } from './errors.js';

/**
 * Options for {@link LockManager#withLock}.
 *
 * @typedef {Object} LockOptions
 * @property {number} [ttlMs=30000] - Lease lifetime. A lease older than this
 *   is treated as abandoned by a dead holder and taken over — including while
 *   its holder is still running, because nothing distinguishes a slow holder
 *   from a dead one. It is therefore also a ceiling on how long `fn` may take:
 *   pick a `ttlMs` that exceeds the worst case of the critical section, not
 *   just the time a crashed holder should block others for. A section that
 *   overruns it loses mutual exclusion silently, which is the failure the lock
 *   exists to prevent. There is no lease renewal; adding one is step 3.
 * @property {number} [waitMs=5000] - How long to wait for a held lock before
 *   giving up with a {@link LockTimeoutError}.
 */

/**
 * Abstract locking facet. Extend it; do not instantiate it.
 */
export class LockManager {
  /**
   * Run `fn` while holding an exclusive lease named `name`.
   *
   * Semantics an implementation must honour:
   * - The lease is released when `fn` settles — resolve **or** reject — and
   *   `fn`'s rejection is rethrown unchanged (no wrapping), so a caller's own
   *   error handling still works through the lock.
   * - When the lock is held elsewhere, wait up to `waitMs` and then throw
   *   {@link LockTimeoutError}. **Never run `fn` without the lock.** Note that
   *   `utils/fileLock.js#withFileLock` deliberately does the opposite (it
   *   continues after its timeout with a warning), so it cannot back this
   *   method directly.
   * - A lease older than `ttlMs` is taken over: its previous holder crashed —
   *   or is simply slower than its own TTL, which looks identical from
   *   outside. A holder whose lease was taken over must not release the new
   *   one. See {@link LockOptions} on sizing `ttlMs` for the section, not just
   *   for a crash.
   * - **Reentrancy is not supported.** A nested `withLock` on the same name
   *   from inside `fn` deadlocks until `waitMs` expires and then throws
   *   {@link LockTimeoutError}; callers must not nest.
   *
   * @param {string} name - Lease name. Any string; providers derive a safe
   *   storage location from it (e.g. a hash), so it need not be path-safe.
   * @param {() => Promise<T>|T} fn - The critical section.
   * @param {LockOptions} [opts] - Lease lifetime and wait budget.
   * @returns {Promise<T>} Whatever `fn` returned.
   * @throws {LockTimeoutError} When the lock could not be acquired in `waitMs`.
   * @template T
   */
  async withLock(_name, _fn, _opts = {}) {
    throw new NotSupportedError('LockManager.withLock is not implemented');
  }
}
