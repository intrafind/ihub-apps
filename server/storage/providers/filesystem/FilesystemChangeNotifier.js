/**
 * In-process change notifications for the filesystem provider.
 *
 * The filesystem provider is single-instance by design (`multiInstance: false`),
 * so change events only ever have to reach the process that raised them — an
 * `EventEmitter` is exactly that reach and nothing more. There is deliberately
 * no file watcher underneath: watching the data directory would report every
 * write twice (once from the writer, once from the watcher), fires on
 * temporary files written by `atomicWriteJSON`, and behaves differently on
 * every platform and network filesystem. A provider that must reach other
 * instances declares `notifications: 'push'` or `'poll'` and carries the same
 * event shape over its own transport.
 *
 * @module storage/providers/filesystem/FilesystemChangeNotifier
 */
import { EventEmitter } from 'events';
import logger from '../../../utils/logger.js';
import { ChangeNotifier } from '../../ChangeNotifier.js';
import { StorageError } from '../../errors.js';

const COMPONENT = 'FilesystemChangeNotifier';

/** Single emitter channel: subscribers filter by `event.type` themselves. */
const CHANNEL = 'change';

/**
 * In-process {@link ChangeNotifier}.
 *
 * Handlers are wrapped so a throwing subscriber can neither fail the publish
 * nor starve the subscribers registered after it.
 */
export class FilesystemChangeNotifier extends ChangeNotifier {
  constructor() {
    super();
    this._emitter = new EventEmitter();
    // Subscriber count is driven by the application (one per repository, per
    // SSE connection, …), not by a fixed set of internals, so Node's
    // ten-listener leak heuristic would only produce false warnings here.
    this._emitter.setMaxListeners(0);
    this._closed = false;
  }

  /**
   * Number of live subscriptions. Exposed for diagnostics and for tests that
   * assert teardown actually removed the handlers.
   *
   * @returns {number}
   */
  get subscriberCount() {
    return this._emitter.listenerCount(CHANNEL);
  }

  /**
   * Publish a change event to every subscriber.
   *
   * Delivery is synchronous (the returned promise is already settled once the
   * handlers have run), so a caller that awaits `publish` knows every
   * subscriber has seen the event. After {@link FilesystemChangeNotifier#close}
   * there are no subscribers left and publishing is a no-op rather than an
   * error — a late event from an in-flight write must not fail a shutdown.
   *
   * @param {import('../../ChangeNotifier.js').ChangeEvent} event - Event to
   *   deliver; `at` is filled in with the current time when omitted.
   * @returns {Promise<void>}
   * @throws {StorageError} Code `INVALID_EVENT` when `event.type` is missing.
   */
  async publish(event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string' || !event.type) {
      throw new StorageError('Change event requires a non-empty string type', {
        code: 'INVALID_EVENT'
      });
    }
    if (this._closed) return;
    // Copy before stamping `at`: the caller's object may be reused or frozen,
    // and every subscriber must see the same immutable snapshot.
    const delivered = { ...event, at: event.at || new Date().toISOString() };
    this._emitter.emit(CHANNEL, delivered);
  }

  /**
   * Subscribe to change events.
   *
   * @param {(event: import('../../ChangeNotifier.js').ChangeEvent) => void} handler
   *   Called for every published event; its return value and any rejection of
   *   a returned promise are ignored.
   * @returns {() => void} Unsubscribe function; calling it more than once is safe.
   * @throws {StorageError} Code `INVALID_HANDLER` when `handler` is not a function.
   */
  subscribe(handler) {
    if (typeof handler !== 'function') {
      throw new StorageError('Change notifier subscribe requires a function', {
        code: 'INVALID_HANDLER'
      });
    }
    // The wrapper is what gets registered, so a handler subscribed twice still
    // has two independently removable subscriptions.
    const wrapped = event => {
      try {
        const result = handler(event);
        // An async handler rejects after `emit` has already returned, so its
        // failure has to be caught here too or it becomes an unhandled rejection.
        if (result && typeof result.then === 'function') {
          result.catch(error => this._logHandlerError(error, event));
        }
      } catch (error) {
        this._logHandlerError(error, event);
      }
    };
    this._emitter.on(CHANNEL, wrapped);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this._emitter.off(CHANNEL, wrapped);
    };
  }

  /**
   * Drop every subscription. Idempotent, and the notifier stays usable as a
   * sink afterwards so a shutdown racing an in-flight write cannot throw.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this._closed = true;
    this._emitter.removeAllListeners(CHANNEL);
  }

  /**
   * A broken subscriber is a bug in that subscriber, never a failed write:
   * log it with enough context to find it and carry on.
   *
   * @param {unknown} error - Whatever the handler threw or rejected with
   * @param {Object} event - The event being delivered
   * @returns {void}
   */
  _logHandlerError(error, event) {
    logger.error('Change notifier subscriber failed', {
      component: COMPONENT,
      type: event?.type,
      ns: event?.ns,
      error
    });
  }
}

export default FilesystemChangeNotifier;
