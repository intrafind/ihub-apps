// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Latency diagnostics for storage facets, for every provider.
 *
 * @module storage/facetTiming
 */
import { timeAsync } from '../telemetry/waitDiagnostics.js';

/** The blob facet methods worth timing. `scan` pages `list` and counts there. */
export const BLOB_OPS = Object.freeze(['get', 'put', 'delete', 'list', 'deletePrefix']);

/**
 * Time a facet's async methods into the `storage` diagnostics
 * (`GET /api/admin/system/resources`), as `<facet>.<op>` or, per namespace,
 * `<facet>.<op>:<ns>`. Latency here includes the wait for a libuv thread
 * (`UV_THREADPOOL_SIZE`, default 4) or for the network, which is what makes it
 * worth watching. A method that calls another timed method through `this`
 * counts under both.
 *
 * The facet is changed in place: each named method is replaced by a wrapper.
 *
 * @param {Object} facet - The facet instance.
 * @param {string} name - Facet name in the diagnostics, e.g. `blobs`.
 * @param {ReadonlyArray<string>} methods - Method names to time.
 * @param {boolean} perNamespace - Label by the first argument as well.
 * @returns {void}
 */
export function timeFacetMethods(facet, name, methods, perNamespace) {
  for (const method of methods) {
    const original = facet[method];
    if (typeof original !== 'function') continue;
    const key = `${name}.${method}`;
    facet[method] = function timedStorageOp(...args) {
      const label = perNamespace && typeof args[0] === 'string' ? `${key}:${args[0]}` : key;
      return timeAsync('storage', label, () => original.apply(this, args));
    };
  }
}
