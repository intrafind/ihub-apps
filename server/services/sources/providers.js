/**
 * Source providers: the systems that can act on the sources they own —
 * return a document's content for Preview, Download, Add to email and Open in
 * App, and its details — through one route
 * (`GET /api/sources/:provider/content|metadata`, `routes/sources.js`).
 *
 * A provider is code on the server, registered by its integration; a source
 * gets content actions when its `provider` has one registered and it carries
 * a `ref` (`{ id, scope? }`) to hand to it. Everything a provider returns is
 * fetched with the signed-in user's own permissions in that system.
 *
 * ```js
 * registerSourceProvider({
 *   id: 'nextcloud',
 *   async content({ ref, user, format }) { … },   // format: 'original' | 'pdf' | 'text'
 *   async metadata({ ref, user }) { … }          // optional
 * });
 * ```
 *
 * `content` resolves to `{ contentType, stream }` (a Node readable) or
 * `{ contentType, body }` (a string or Buffer), optionally with
 * `contentDisposition`, `contentLength` or `fileName`; it throws a
 * {@link sourceProviderError} for a status other than 500.
 *
 * @module services/sources/providers
 */

/** Built-in providers, loaded on first use so the loop does not import their services. */
const BUILT_IN = {
  ifinder: () => import('./providers/ifinder.js')
};

const registered = new Map();

/**
 * @param {{id: string, content: Function, metadata?: Function}} provider
 */
export function registerSourceProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || typeof provider.content !== 'function') {
    throw new TypeError('A source provider needs an id and a content function');
  }
  registered.set(provider.id, provider);
}

/**
 * Whether a provider can act on its sources' refs. Synchronous and cheap: the
 * loop asks for every source it reports.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function hasSourceProvider(id) {
  return registered.has(id) || Object.hasOwn(BUILT_IN, id);
}

/**
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getSourceProvider(id) {
  if (registered.has(id)) return registered.get(id);
  if (!Object.hasOwn(BUILT_IN, id)) return null;
  const module = await BUILT_IN[id]();
  return module.default;
}

/**
 * An error a provider throws to answer with a given status.
 *
 * @param {number} status
 * @param {string} message
 * @returns {Error}
 */
export function sourceProviderError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Test hook: forget registered providers. */
export function _resetSourceProviders() {
  registered.clear();
}
