/**
 * ChangeNotifier — the change-propagation facet of a storage provider.
 *
 * Tells interested parts of the server that stored state changed. On a single
 * instance that is an in-process event emitter; a multi-instance provider
 * carries the same events between instances (a database LISTEN/NOTIFY channel,
 * a polled change feed), which is why the reach is a declared capability
 * (`getCapabilities().notifications`) rather than an assumption callers make.
 *
 * This class is the written contract, not an implementation: every method
 * throws {@link NotSupportedError}. Providers extend it and prove they honour
 * the semantics documented here by passing the conformance suite in
 * `server/storage/__tests__/providerConformance.js`.
 *
 * @module storage/ChangeNotifier
 */
import { NotSupportedError } from './errors.js';

/**
 * A change event.
 *
 * `at` is filled in by the notifier when the publisher omits it, so every
 * subscriber sees a timestamp even for events raised deep inside a provider.
 *
 * @typedef {Object} ChangeEvent
 * @property {string} type - Event type. The document store emits
 *   `'document.put'` and `'document.delete'`; domain code may publish its own.
 * @property {string} [ns] - Namespace the change happened in, when applicable.
 * @property {string} [key] - Key that changed, when applicable.
 * @property {string|null} [ownerId] - Owning principal of the changed
 *   document, so a subscriber can filter without a read.
 * @property {string} at - ISO-8601 timestamp of the change.
 */

/**
 * Abstract change-notification facet. Extend it; do not instantiate it.
 */
export class ChangeNotifier {
  /**
   * Publish a change event to every subscriber.
   *
   * A handler that throws must never break the publish or starve the other
   * subscribers: implementations catch and log handler failures and carry on.
   *
   * @param {ChangeEvent} event - The event; `at` is added when missing.
   * @returns {Promise<void>}
   */
  async publish(_event) {
    throw new NotSupportedError('ChangeNotifier.publish is not implemented');
  }

  /**
   * Subscribe to change events.
   *
   * Synchronous by design: it hands back the unsubscribe function immediately
   * so a caller can register in a constructor and tear down in a `finally`
   * without awaiting.
   *
   * @param {(event: ChangeEvent) => void} handler - Called for every event.
   * @returns {() => void} Unsubscribe function; calling it twice is safe.
   */
  subscribe(_handler) {
    throw new NotSupportedError('ChangeNotifier.subscribe is not implemented');
  }

  /**
   * Drop every subscription and release whatever the notifier holds open
   * (listeners, a connection, a poll timer), so the process can exit.
   *
   * @returns {Promise<void>}
   */
  async close() {
    throw new NotSupportedError('ChangeNotifier.close is not implemented');
  }
}
