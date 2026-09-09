/**
 * StorageProvider — one backend behind the four storage facets.
 *
 * A provider bundles a {@link DocumentStore}, an {@link AppendLog}, a
 * {@link ChangeNotifier} and a {@link LockManager} plus its lifecycle, and
 * declares what it can actually do through {@link StorageProvider#getCapabilities}.
 * Domain repositories talk to the facets; nothing in the application picks a
 * provider itself — `StorageRegistry` resolves the configured one once.
 *
 * This class is the written contract, not an implementation: the facet
 * accessors and `healthCheck()` throw {@link NotSupportedError}. Providers
 * extend it and prove they honour the semantics documented across these files
 * by passing the conformance suite in
 * `server/storage/__tests__/providerConformance.js`.
 *
 * @module storage/StorageProvider
 */
import { NotSupportedError } from './errors.js';

/**
 * What a provider supports. Callers branch on this instead of on the provider
 * name, so a new backend never needs a new special case upstream.
 *
 * @typedef {Object} Capabilities
 * @property {boolean} transactions - Multi-document writes can be atomic.
 * @property {'in-process'|'push'|'poll'|'none'} notifications - How far change
 *   events reach: this process only, pushed between instances, polled, or not
 *   at all.
 * @property {'none'|'advisory-single-machine'|'distributed'} locking - How far
 *   `locks.withLock()` excludes: nothing, cluster workers sharing one machine
 *   or volume, or every instance.
 * @property {boolean} search - Documents can be queried by content, not only
 *   by key, owner and prefix.
 * @property {boolean} multiInstance - Several server instances may run against
 *   the same storage safely.
 * @property {boolean} blobs - The append log can store blobs beside a stream.
 * @property {boolean} conditionalWrites - `documents.put()` honours the `etag`
 *   compare-and-set and create-only modes.
 */

/**
 * The conservative baseline: everything off, no reach. A provider starts from
 * this and turns on only what it has actually implemented — an unset
 * capability must never read as "supported".
 *
 * Frozen because it is shared: {@link StorageProvider#getCapabilities} returns
 * a copy so a caller cannot mutate the baseline for everyone else.
 *
 * @type {Readonly<Capabilities>}
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  transactions: false,
  notifications: 'none',
  locking: 'none',
  search: false,
  multiInstance: false,
  blobs: false,
  conditionalWrites: false
});

/**
 * Result of {@link StorageProvider#healthCheck}.
 *
 * @typedef {Object} HealthCheckResult
 * @property {'ok'|'degraded'|'error'} status - Outcome of the probe.
 * @property {string} provider - Provider name that answered.
 * @property {number} latencyMs - How long the probe took.
 * @property {Object} [details] - Provider-specific diagnostics, e.g. the error
 *   message when `status` is not 'ok'.
 */

/**
 * Abstract storage provider. Extend it; do not instantiate it.
 */
export class StorageProvider {
  /**
   * @param {Object} [config={}] - Provider configuration, taken from
   *   `platform.json → storage.<provider>` (tests pass it directly).
   */
  constructor(config = {}) {
    /** @type {Object} */
    this.config = config;
  }

  /**
   * Registry name of this provider, e.g. 'filesystem'. Reported by
   * `healthCheck()` and used in log messages.
   *
   * @returns {string}
   */
  get name() {
    throw new NotSupportedError('StorageProvider.name is not implemented');
  }

  /**
   * The document facet.
   *
   * @returns {DocumentStore}
   */
  get documents() {
    throw new NotSupportedError('StorageProvider.documents is not implemented');
  }

  /**
   * The append-log facet.
   *
   * @returns {AppendLog}
   */
  get logs() {
    throw new NotSupportedError('StorageProvider.logs is not implemented');
  }

  /**
   * The change-notification facet.
   *
   * @returns {ChangeNotifier}
   */
  get notifier() {
    throw new NotSupportedError('StorageProvider.notifier is not implemented');
  }

  /**
   * The locking facet.
   *
   * @returns {LockManager}
   */
  get locks() {
    throw new NotSupportedError('StorageProvider.locks is not implemented');
  }

  /**
   * Prepare the backend for use — create directories, open connections, run
   * whatever one-time setup the provider needs.
   *
   * Must be idempotent: calling it twice is a no-op, because both the registry
   * and a test harness may initialize the same instance.
   *
   * @returns {Promise<void>}
   */
  async initialize() {}

  /**
   * Release everything the provider holds: flush buffered writes, stop timers,
   * close the notifier and any connection. Nothing may keep the event loop
   * alive afterwards — a dangling handle here hangs the test suite and delays
   * every shutdown.
   *
   * Must be idempotent. Using a provider after shutdown is allowed to throw.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {}

  /**
   * Probe the backend with a real round-trip (not a cached flag) and report
   * how long it took.
   *
   * @returns {Promise<HealthCheckResult>}
   */
  async healthCheck() {
    throw new NotSupportedError('StorageProvider.healthCheck is not implemented');
  }

  /**
   * What this provider supports. The base returns the all-off baseline; a
   * provider overrides it with the subset it implements.
   *
   * @returns {Capabilities}
   */
  getCapabilities() {
    return { ...DEFAULT_CAPABILITIES };
  }
}
