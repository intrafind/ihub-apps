// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The lock that serializes writes to one iFinder smart collection, across every
 * iHub worker **and every iHub instance**.
 *
 * Why it exists: the utilities service of iFinder changes a collection with an
 * unversioned read-modify-write (no `if_seq_no`). Two writes to one collection
 * that overlap each read the same list and the second write drops what the first
 * added. A lock or queue inside one process does not stop two instances from
 * doing that to each other, so the lock comes from the storage layer
 * (`getStorage().locks`), whose reach the provider declares:
 *
 *  - `getCapabilities().locking`: `none`, `advisory-single-machine` (the workers
 *    of one machine on one volume) or `distributed` (every instance);
 *  - `getCapabilities().multiInstance`: several instances may run against the
 *    same storage.
 *
 * The cluster bus (`server/clusterBus.js`) is IPC between the workers of one
 * machine: it never reaches another instance, so it is no substitute.
 *
 * **Writes are enabled** when a lock exists and it reaches as far as the
 * deployment does: a storage that is not multi-instance needs a lock among its
 * workers, a multi-instance storage needs a `distributed` one. Otherwise they
 * stay **disabled** (reads keep working) and `GET /api/projects/_config`
 * reports why, until utilities gains `if_seq_no`.
 *
 * @module services/projects/ifinder/collectionLock
 */
import { getStorage, readFacet } from '../../../storage/bootstrap.js';
import { LockTimeoutError } from '../../../storage/errors.js';

/** Why writes are off. */
export const WRITE_DISABLED_REASONS = Object.freeze({
  /** No storage, or none with a lock facet: nothing can serialize the writes. */
  NO_LOCK: 'NO_LOCK',
  /** Several instances may run and the lock does not reach across them. */
  MULTI_INSTANCE: 'MULTI_INSTANCE'
});

/**
 * Lease of one collection write. The lease is renewed while the write runs
 * (`ttlMs` is how long a crashed holder blocks the collection); `waitMs` is how
 * long a second writer queues before it is told the collection is busy.
 */
export const LOCK_OPTIONS = Object.freeze({ ttlMs: 20_000, waitMs: 10_000 });

let resolveStorage = getStorage;

/**
 * Test hook: use another storage provider than the bootstrapped one (a fake
 * that declares `multiInstance` with an advisory lock, for example). Call it
 * without an argument to go back.
 *
 * @param {(() => Object|null)|undefined} resolver
 */
export function setStorageResolver(resolver) {
  resolveStorage = typeof resolver === 'function' ? resolver : getStorage;
}

function capabilitiesOf(provider) {
  try {
    return provider?.getCapabilities?.() || {};
  } catch {
    return {};
  }
}

/**
 * Whether collection writes are safe on this installation.
 *
 * @returns {{writable: true}|{writable: false, reason: keyof typeof WRITE_DISABLED_REASONS}}
 */
export function collectionWriteSupport() {
  const provider = resolveStorage();
  const locks = readFacet(provider, 'locks');
  if (!locks || typeof locks.withLock !== 'function') {
    return { writable: false, reason: WRITE_DISABLED_REASONS.NO_LOCK };
  }
  const { locking, multiInstance } = capabilitiesOf(provider);
  if (!locking || locking === 'none') {
    return { writable: false, reason: WRITE_DISABLED_REASONS.NO_LOCK };
  }
  if (multiInstance === true && locking !== 'distributed') {
    return { writable: false, reason: WRITE_DISABLED_REASONS.MULTI_INSTANCE };
  }
  return { writable: true };
}

/**
 * Run `fn` holding the lease of one collection.
 *
 * @template T
 * @param {string} tenant - The iFinder installation (`IFinderTier` tenant key).
 * @param {string} collectionId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @throws {LockTimeoutError} The collection stayed busy for the whole wait.
 * @throws {Error} Writes are not safe here (callers check
 *   {@link collectionWriteSupport} first; this is the last line).
 */
export async function withCollectionLock(tenant, collectionId, fn) {
  const support = collectionWriteSupport();
  if (!support.writable) {
    throw new Error(`Collection writes are disabled (${support.reason})`);
  }
  const locks = readFacet(resolveStorage(), 'locks');
  return locks.withLock(`ifinder-collection:${tenant}:${collectionId}`, fn, LOCK_OPTIONS);
}

export { LockTimeoutError };
