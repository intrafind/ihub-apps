// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The write side of the iFinder tier, iteration 2 (#3024): create a smart
 * collection, rename it, add iFinder documents to it and remove them again.
 *
 * What every write here does, and why:
 *
 *  - **The caller's own token.** Every call is the user's JWT, so iFinder's own
 *    owner check decides: a collection that is not theirs answers 404, the same
 *    as a missing one. No owner is ever sent, and rename sends only `name` and
 *    `description` (`SmartCollectionsService`).
 *  - **One writer per collection, across all instances.** iFinder changes a
 *    collection with an unversioned read-modify-write, so overlapping writes
 *    lose each other's changes. Every write to a collection runs under the
 *    storage layer's lock for it (`collectionLock.js`); where no lock reaches
 *    every instance, writes are refused (`IFINDER_WRITES_DISABLED`).
 *  - **Read fresh under the lock.** The membership the cap and the duplicate
 *    check use is read from iFinder inside the lock, never from the cache.
 *  - **Not atomic, so reconcile.** A write that fails (or whose answer is lost)
 *    may have changed the collection. The collection is read again, under the
 *    same lock, and the error says which documents did and did not make it. A
 *    write that succeeds is verified the same way.
 *  - **Evict.** Every write, failed or not, drops what it made stale
 *    (`noteCollectionWritten`), so the next read sees the change.
 *
 * Adding checks each document first, with the user's token, because iFinder
 * checks nothing on add. Removing only removes the membership: the endpoint
 * knows nothing but the collection's id list.
 *
 * @module services/projects/ifinder/IFinderCollectionWriter
 */
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import { LockTimeoutError } from '../../../storage/errors.js';
import iFinderService from '../../integrations/iFinderService.js';
import smartCollections, {
  MAX_COLLECTION_DOCUMENTS,
  SMART_COLLECTIONS_ERRORS,
  SmartCollectionsError,
  summarizeCollection
} from '../../integrations/SmartCollectionsService.js';
import { ProjectError } from '../projectErrors.js';
import { collectionIdOf, ifinderProjectIdOf } from '../projectConstants.js';
import { getItemKind, isItemKindEnabled } from '../kinds/registry.js';
import { iFinderTierConfigured, projectSettings } from '../projectSettings.js';
import { collectionWriteSupport, withCollectionLock } from './collectionLock.js';
import {
  TITLE_BATCH,
  availabilityFor,
  itemIdOf,
  noteCollectionWritten,
  principalOf,
  projectOfCollection,
  tenantKey
} from './IFinderTier.js';

const COMPONENT = 'IFinderCollectionWriter';

/** The one item kind an iFinder-tier project accepts. */
export const IFINDER_ITEM_KIND = 'ifinder-document';

/** Documents a collection holds at most: iFinder's cap, counted here before sending. */
export const MAX_DOCUMENTS = MAX_COLLECTION_DOCUMENTS;

/** Documents one add call takes. */
export const MAX_ADD_PER_CALL = 50;

// --- shared pieces ----------------------------------------------------------------

/**
 * Throw if this caller may not write to the tier at all, and return the tenant.
 * The checks, cheapest first: the tier is configured, the caller has a stable
 * principal, and a lock reaches every instance.
 */
function writeContext(user) {
  const platform = configCache.getPlatform() || {};
  if (!iFinderTierConfigured(platform) || !principalOf(user)) {
    throw new ProjectError('TIER_NOT_AVAILABLE', 'The iFinder tier is not available to you');
  }
  const support = collectionWriteSupport();
  if (!support.writable) {
    throw new ProjectError(
      'IFINDER_WRITES_DISABLED',
      'Changing smart collections from iHub is switched off on this installation: no lock reaches every iHub instance',
      { reason: support.reason }
    );
  }
  return { tenant: tenantKey() };
}

/** What a failed call to iFinder is, as a project error (the write itself is judged separately). */
function projectErrorOf(error, fallback = 'IFINDER_UNAVAILABLE') {
  if (error instanceof ProjectError) return error;
  if (error instanceof LockTimeoutError) {
    return new ProjectError(
      'COLLECTION_BUSY',
      'The collection is being changed right now. Try again in a moment.'
    );
  }
  if (error instanceof SmartCollectionsError) {
    switch (error.code) {
      case SMART_COLLECTIONS_ERRORS.NOT_FOUND:
        return new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
      case SMART_COLLECTIONS_ERRORS.FORBIDDEN:
        return new ProjectError(
          'IFINDER_FORBIDDEN',
          'iFinder does not allow you to change smart collections'
        );
      case SMART_COLLECTIONS_ERRORS.REJECTED:
        return new ProjectError('IFINDER_REJECTED', 'iFinder did not accept the change');
      default:
        return new ProjectError(fallback, 'iFinder could not be reached');
    }
  }
  return error;
}

/** The collection as iFinder has it now, or null when it cannot be read. */
async function readNow(user, collectionId) {
  try {
    return await smartCollections.get({ user, id: collectionId });
  } catch (error) {
    logger.warn('A collection could not be read after a write', {
      component: COMPONENT,
      collectionId,
      code: error?.code
    });
    return null;
  }
}

/**
 * Run one write to a collection under its lock, and evict what it made stale
 * before the lock is released, whatever it ended in.
 */
async function lockedWrite(user, collectionId, work) {
  const { tenant } = writeContext(user);
  const touched = { documentIds: [], summary: null };
  try {
    return await withCollectionLock(tenant, collectionId, async () => {
      try {
        return await work(touched);
      } finally {
        noteCollectionWritten(user, collectionId, touched);
      }
    });
  } catch (error) {
    throw projectErrorOf(error);
  }
}

/**
 * The failure of a membership write: read the collection again and say which of
 * `ids` made it. When all of them did (the write was applied and only its answer
 * was lost) this returns and the write counts as done; otherwise it throws, with
 * the outcome in the details. `landed(after, id)` tells whether an id is in its
 * target state.
 */
async function reconcileFailedWrite({ user, collectionId, ids, landed, error, touched, noun }) {
  const cause = projectErrorOf(error, 'IFINDER_WRITE_FAILED');
  // A collection that is gone, or not the caller's, or a role that is missing,
  // is said as it is.
  if (['PROJECT_NOT_FOUND', 'IFINDER_FORBIDDEN'].includes(cause.code)) throw cause;
  const after = await readNow(user, collectionId);
  if (after) touched.summary = summarizeCollection(toRaw(after));
  const done = after ? ids.filter(id => landed(after, id)) : null;
  if (done && done.length === ids.length) {
    logger.warn('A collection write failed after it was applied', {
      component: COMPONENT,
      collectionId,
      code: error?.code
    });
    return;
  }
  const outcome = !done ? 'unknown' : done.length === 0 ? 'none' : 'partial';
  const details = {
    outcome,
    [noun]: done || [],
    not: done ? ids.filter(id => !done.includes(id)) : ids
  };
  // iFinder said no and nothing changed: that is its answer, not a lost one.
  if (outcome === 'none' && cause.code === 'IFINDER_REJECTED') {
    throw new ProjectError(cause.code, cause.message, details);
  }
  throw new ProjectError(
    'IFINDER_WRITE_FAILED',
    outcome === 'unknown'
      ? `iFinder reported an error and it is not known which documents were ${noun}`
      : outcome === 'none'
        ? `iFinder reported an error and no document was ${noun}`
        : `iFinder reported an error after ${done.length} of ${ids.length} documents were ${noun}`,
    details
  );
}

// --- create -----------------------------------------------------------------------

/**
 * Create a smart collection for the caller. The owner is not sent: iFinder sets
 * it to the principal of the token, so the collection is the caller's and the
 * list shows it again for the same user.
 *
 * @param {Object} user
 * @param {{name: string, description?: string}} content
 * @returns {Promise<Object>} The new collection as a project.
 */
export async function createCollection(user, { name, description = '' }) {
  writeContext(user);
  const availability = await availabilityFor(user);
  if (!availability.offered) {
    throw availability.unavailable
      ? new ProjectError('IFINDER_UNAVAILABLE', 'iFinder could not be reached')
      : new ProjectError('TIER_NOT_AVAILABLE', 'The iFinder tier is not available to you', {
          reason: availability.reason
        });
  }
  let id;
  try {
    ({ id } = await smartCollections.create({ user, name, description }));
  } catch (error) {
    const cause = projectErrorOf(error, 'IFINDER_WRITE_FAILED');
    // A request whose answer was lost may still have created the collection.
    if (cause.code === 'IFINDER_WRITE_FAILED') {
      throw new ProjectError(
        'IFINDER_WRITE_FAILED',
        'iFinder did not answer, so it is not known whether the collection was created. Check your list before trying again.',
        { outcome: 'unknown' }
      );
    }
    throw cause;
  }
  const collection = (await readNow(user, id)) || {
    id,
    name,
    description,
    owner: '',
    createdAt: null,
    updatedAt: null,
    documentCount: 0,
    documentIds: []
  };
  noteCollectionWritten(user, id, { summary: summarizeCollection(toRaw(collection)) });
  return projectOfCollection(user, collection);
}

/** A parsed collection as the raw shape `summarizeCollection` reads. */
function toRaw(collection) {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    owner: collection.owner,
    creation_date: collection.createdAt,
    modification_date: collection.updatedAt,
    documents: (collection.documentIds || []).map(id => ({ id }))
  };
}

// --- rename -----------------------------------------------------------------------

/**
 * Rename a collection, and change its description when one is given.
 *
 * @param {Object} user
 * @param {string} projectId - `ifc_<uuid>`.
 * @param {{name?: string, description?: string}} change
 * @returns {Promise<Object>} The collection as a project.
 */
export async function renameCollection(user, projectId, { name, description }) {
  const collectionId = collectionIdOf(projectId);
  if (!collectionId) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
  let collection = null;
  await lockedWrite(user, collectionId, async touched => {
    await smartCollections.rename({ user, id: collectionId, name, description });
    collection = await readNow(user, collectionId);
    if (collection) touched.summary = summarizeCollection(toRaw(collection));
  });
  if (!collection) {
    // The change went through; only the answer could not be read back.
    throw new ProjectError(
      'IFINDER_UNAVAILABLE',
      'The collection was renamed, but could not be read back'
    );
  }
  return projectOfCollection(user, collection);
}

// --- delete -----------------------------------------------------------------------

/**
 * Delete a collection in iFinder, as its owner. A collection that is gone
 * already counts as deleted. The documents stay in iFinder.
 *
 * @param {Object} user
 * @param {string} collectionId
 * @returns {Promise<void>}
 */
export async function deleteCollection(user, collectionId) {
  if (!collectionIdOf(ifinderProjectIdOf(collectionId))) {
    throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
  }
  await lockedWrite(user, collectionId, async () => {
    try {
      await smartCollections.remove({ user, id: collectionId });
    } catch (error) {
      if (error?.code !== SMART_COLLECTIONS_ERRORS.NOT_FOUND) throw error;
    }
  });
  noteCollectionWritten(user, collectionId, { deleted: true });
}

// --- add --------------------------------------------------------------------------

/**
 * The ids among `ids` the user cannot read, asked with the user's own token in
 * batches of {@link TITLE_BATCH}. A document counts as readable when a search
 * with the user's rights returns it, which is the rule the titles and the
 * "unavailable for you" state of iteration 1 use. An id of a shape that cannot go
 * into the query cannot be read by iHub either, and counts as unreadable.
 */
async function unreadableDocuments(user, collectionId, ids) {
  const readable = new Set();
  const askable = ids.filter(id => isValidId(id));
  for (let start = 0; start < askable.length; start += TITLE_BATCH) {
    const batch = askable.slice(start, start + TITLE_BATCH);
    let result;
    try {
      result = await iFinderService.search({
        query: batch.map(id => `_id:"${id}"`).join(' OR '),
        chatId: `project-collection-${collectionId}`,
        user,
        maxResults: batch.length,
        returnFields: ['id'],
        returnFacets: [],
        queryLogging: false
      });
    } catch (error) {
      logger.warn('Documents could not be checked before they were added', {
        component: COMPONENT,
        collectionId,
        error: error?.message
      });
      throw new ProjectError('IFINDER_UNAVAILABLE', 'iFinder could not be reached');
    }
    for (const hit of result?.results || []) {
      const id = hit?.id === undefined ? '' : String(hit.id);
      if (batch.includes(id)) readable.add(id);
    }
  }
  return ids.filter(id => !readable.has(id));
}

/** The document ids of add requests, each checked against the kind registry. */
function documentIdsOf(requests) {
  const platform = configCache.getPlatform() || {};
  const ids = [];
  for (const request of requests) {
    if (request?.kind !== IFINDER_ITEM_KIND) {
      throw new ProjectError(
        'KIND_NOT_ALLOWED',
        'A project from iFinder holds iFinder documents only',
        { kind: request?.kind ?? null, allowed: [IFINDER_ITEM_KIND] }
      );
    }
    if (
      !isItemKindEnabled(IFINDER_ITEM_KIND, {
        platform,
        features: configCache.getFeatures(),
        settings: projectSettings(platform)
      })
    ) {
      throw new ProjectError('KIND_DISABLED', `Item kind "${IFINDER_ITEM_KIND}" is not available`);
    }
    const parsed = getItemKind(IFINDER_ITEM_KIND).refSchema.safeParse(request.ref || {});
    if (!parsed.success) {
      throw new ProjectError(
        'INVALID_REF',
        `Invalid reference for ${IFINDER_ITEM_KIND}: ${parsed.error.issues
          .map(issue => `${issue.path.join('.') || 'ref'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    ids.push(parsed.data.documentId);
  }
  return [...new Set(ids)];
}

/**
 * Add documents to a collection.
 *
 * Refused as a whole, before anything is sent, when a document is not readable
 * for the user or the collection would pass its cap of {@link MAX_DOCUMENTS}.
 * A document that is a member already is skipped, not an error.
 *
 * @param {Object} user
 * @param {string} projectId - `ifc_<uuid>`.
 * @param {Array<{kind: string, ref: Object}>} requests - `ifinder-document` items.
 * @returns {Promise<{project: Object, added: string[], alreadyMember: string[]}>}
 *   Document ids.
 */
export async function addDocuments(user, projectId, requests) {
  const collectionId = collectionIdOf(projectId);
  if (!collectionId) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
  const ids = documentIdsOf(requests);
  if (ids.length === 0 || ids.length > MAX_ADD_PER_CALL) {
    throw new ProjectError(
      'INVALID_REF',
      `Add between 1 and ${MAX_ADD_PER_CALL} documents at once`
    );
  }
  writeContext(user);
  // Before the lock: it does not depend on the collection, and it is the slow part.
  const unreadable = await unreadableDocuments(user, collectionId, ids);
  if (unreadable.length > 0) {
    throw new ProjectError(
      'DOCUMENT_NOT_READABLE',
      unreadable.length === 1
        ? 'You cannot read this document in iFinder, so it cannot be added'
        : `You cannot read ${unreadable.length} of these documents in iFinder, so none was added`,
      { documentIds: unreadable }
    );
  }
  let outcome;
  await lockedWrite(user, collectionId, async touched => {
    const before = await smartCollections.get({ user, id: collectionId });
    const members = new Set(before.documentIds);
    const toAdd = ids.filter(id => !members.has(id));
    const alreadyMember = ids.filter(id => members.has(id));
    if (members.size + toAdd.length > MAX_DOCUMENTS) {
      throw new ProjectError(
        'QUOTA_COLLECTION_DOCUMENTS',
        `A smart collection holds at most ${MAX_DOCUMENTS} documents`,
        { limit: MAX_DOCUMENTS, used: members.size, requested: toAdd.length }
      );
    }
    touched.documentIds = toAdd;
    if (toAdd.length === 0) {
      outcome = { collection: before, added: [], alreadyMember };
      return;
    }
    const landed = (collection, id) => collection.documentIds.includes(id);
    try {
      await smartCollections.addDocuments({ user, id: collectionId, documentIds: toAdd });
    } catch (error) {
      await reconcileFailedWrite({
        user,
        collectionId,
        ids: toAdd,
        landed,
        error,
        touched,
        noun: 'added'
      });
    }
    const after = await readNow(user, collectionId);
    if (after) touched.summary = summarizeCollection(toRaw(after));
    // iFinder said yes. A document that is not there is a write another editor
    // (iFinder's own UI) overwrote, and it is said, not hidden.
    const missing = after ? toAdd.filter(id => !landed(after, id)) : [];
    if (missing.length > 0) {
      throw new ProjectError(
        'IFINDER_WRITE_FAILED',
        'iFinder accepted the documents, but the collection was changed at the same time and some are missing. Try again.',
        {
          outcome: 'partial',
          added: toAdd.filter(id => !missing.includes(id)),
          not: missing
        }
      );
    }
    outcome = {
      collection: after || { ...before, documentIds: [...before.documentIds, ...toAdd] },
      added: toAdd,
      alreadyMember
    };
  });
  return {
    project: await projectOfCollection(user, outcome.collection),
    added: outcome.added,
    alreadyMember: outcome.alreadyMember
  };
}

// --- remove -----------------------------------------------------------------------

/**
 * Remove documents from a collection by the id of their items (`itm_…`). Only
 * the membership goes: iFinder's endpoint takes the collection's id list and
 * nothing else, and the documents are not asked for.
 *
 * @param {Object} user
 * @param {string} projectId - `ifc_<uuid>`.
 * @param {string[]} itemIds
 * @returns {Promise<{project: Object, removed: string[]}>} Document ids.
 */
export async function removeDocuments(user, projectId, itemIds) {
  const collectionId = collectionIdOf(projectId);
  if (!collectionId) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
  const wanted = [...new Set(itemIds)];
  let outcome;
  await lockedWrite(user, collectionId, async touched => {
    const before = await smartCollections.get({ user, id: collectionId });
    const byItem = new Map(before.documentIds.map(id => [itemIdOf(collectionId, id), id]));
    const unknown = wanted.filter(itemId => !byItem.has(itemId));
    if (unknown.length > 0) {
      throw new ProjectError('ITEM_NOT_FOUND', 'Item not found', { itemIds: unknown });
    }
    const ids = wanted.map(itemId => byItem.get(itemId));
    touched.documentIds = ids;
    const landed = (collection, id) => !collection.documentIds.includes(id);
    try {
      await smartCollections.removeDocuments({ user, id: collectionId, documentIds: ids });
    } catch (error) {
      await reconcileFailedWrite({
        user,
        collectionId,
        ids,
        landed,
        error,
        touched,
        noun: 'removed'
      });
    }
    const after = await readNow(user, collectionId);
    if (after) touched.summary = summarizeCollection(toRaw(after));
    const left = after ? ids.filter(id => !landed(after, id)) : [];
    if (left.length > 0) {
      throw new ProjectError(
        'IFINDER_WRITE_FAILED',
        'iFinder accepted the change, but the collection was changed at the same time and some documents are still in it. Try again.',
        { outcome: 'partial', removed: ids.filter(id => !left.includes(id)), not: left }
      );
    }
    outcome = {
      collection: after || {
        ...before,
        documentIds: before.documentIds.filter(id => !ids.includes(id))
      },
      removed: ids
    };
  });
  return { project: await projectOfCollection(user, outcome.collection), removed: outcome.removed };
}

export default {
  createCollection,
  renameCollection,
  deleteCollection,
  addDocuments,
  removeDocuments
};
