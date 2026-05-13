import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated through async boundaries via AsyncLocalStorage.
 *
 * Fields:
 *   - userId          The authenticated user id (or 'anonymous' / null). For
 *                     OAuth client_credentials tokens this is the client id.
 *   - oauthClientId   The OAuth client id when the request was authenticated
 *                     via an OAuth client (client_credentials, static API key,
 *                     or user-delegated authorization code).
 *   - ip              The calling IP address as resolved by Express (respects
 *                     trust proxy).
 *
 * The logger reads from this store on every log call and merges these fields
 * into the structured log entry, so log filtering by user / OAuth client / IP
 * works without touching every individual log site.
 */
const storage = new AsyncLocalStorage();

/**
 * Run the given callback inside a request context. Any subsequent log calls
 * made on the same async chain see the provided fields.
 *
 * @param {Object} initialContext - Initial context fields (mutable object).
 * @param {Function} callback - Function invoked inside the context.
 */
export function runWithContext(initialContext, callback) {
  storage.run(initialContext || {}, callback);
}

/**
 * Get the current request context, or undefined when called outside a request.
 * @returns {Object|undefined}
 */
export function getContext() {
  return storage.getStore();
}

/**
 * Merge updates into the current request context. No-op when called outside
 * a request (which is intentional — background tasks have no context).
 *
 * @param {Object} updates - Fields to merge into the context.
 */
export function setContext(updates) {
  const store = storage.getStore();
  if (store && updates && typeof updates === 'object') {
    Object.assign(store, updates);
  }
}

export default {
  runWithContext,
  getContext,
  setContext
};
