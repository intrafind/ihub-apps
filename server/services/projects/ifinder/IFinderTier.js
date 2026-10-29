// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder tier of projects, iteration 1 (#3024): the user's smart
 * collections as **read-only projects**.
 *
 * A collection becomes a project with `tier: 'ifinder'`, the id `ifc_<uuid>`
 * (a namespace no stored project can carry) and one `ifinder-document` item
 * per document id. Those items are plain link items, so they are read by the
 * existing link-kind fetch (`ItemTextService`) with the reading user's rights,
 * cited and reported unavailable exactly like an iFinder document added to a
 * project by hand. The scope of a chat is the collection's id list; nothing
 * here depends on the iFinder retrieval scope of 6.9.
 *
 * What this module owns:
 *
 *  - **Availability.** The tier is offered to a user when the tier policy is
 *    `both` or `ifinder`, iFinder is configured, the user has a stable
 *    principal (the JWT subject iHub signs for them) and the Smart
 *    Collections API answers. An older iFinder never shows the tier.
 *  - **Caches.** Everything cached here is keyed by tenant (the iFinder
 *    endpoint) **and principal** (the JWT subject, exactly as signed): an entry
 *    is never read for another principal. Only data iFinder sent is cached;
 *    every project handed out is **built again for the requesting user** from
 *    that data, so no name, id or owner of another user's entry can reach a
 *    response, cache hit or not.
 *  - **Failure.** iFinder being slow or down is an outcome, not an exception:
 *    the project list still answers with the local projects and a warning.
 *
 * Nothing here writes to iFinder.
 *
 * @module services/projects/ifinder/IFinderTier
 */
import { createHash } from 'node:crypto';
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import { resolveJwtSubject } from '../../../utils/iFinderJwt.js';
import iFinderService from '../../integrations/iFinderService.js';
import smartCollections, {
  SMART_COLLECTIONS_ERRORS,
  SmartCollectionsError
} from '../../integrations/SmartCollectionsService.js';
import { canHoldProjects } from '../projectAccess.js';
import { collectionIdOf, ifinderProjectIdOf } from '../projectConstants.js';
import { iFinderTierConfigured } from '../projectSettings.js';

const COMPONENT = 'IFinderTier';

/** How long what iFinder told us stays valid, in milliseconds. */
export const TTL = Object.freeze({
  /** A user's collection list. */
  list: 60_000,
  /** One collection with its document ids. */
  collection: 30_000,
  /** The titles of documents, per user. */
  title: 10 * 60_000,
  /** The Smart Collections API is there. */
  supported: 5 * 60_000,
  /** The Smart Collections API is not there (an older iFinder). */
  unsupported: 10 * 60_000,
  /** The user lacks the `fi_smartcollections` role. */
  forbidden: 5 * 60_000,
  /** iFinder did not answer. Short, so a down iFinder is not asked on every request. */
  unavailable: 15_000
});

/** Documents per title lookup. iFinder search pages are capped at 100 hits. */
export const TITLE_BATCH = 100;

/** Why the tier is not offered to a user, or why a call could not be served. */
export const TIER_REASONS = Object.freeze({
  NOT_OFFERED: 'NOT_OFFERED',
  NO_PRINCIPAL: 'NO_PRINCIPAL',
  UNSUPPORTED: 'UNSUPPORTED',
  FORBIDDEN: 'FORBIDDEN',
  UNAVAILABLE: 'UNAVAILABLE'
});

/** The warning `GET /api/projects` carries when iFinder could not be asked. */
export const IFINDER_UNAVAILABLE_WARNING = Object.freeze({
  code: 'IFINDER_UNAVAILABLE',
  tier: 'ifinder'
});

/** A small insertion-ordered cache with a lifetime per entry. */
class TtlCache {
  constructor(max) {
    this.max = max;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
  }

  clear() {
    this.entries.clear();
  }
}

const capabilities = new TtlCache(16); // per tenant
const lists = new TtlCache(1000); // per tenant and principal
const collections = new TtlCache(4000); // per tenant, principal and collection
const titles = new TtlCache(40_000); // per tenant, principal and document
const inflight = new Map();

/** Test hook: forget everything cached. */
export function resetIFinderTier() {
  for (const cache of [capabilities, lists, collections, titles]) cache.clear();
  inflight.clear();
}

/** Run `load` once for `key` however many callers ask while it is out. */
function singleFlight(key, load) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = Promise.resolve()
    .then(load)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// --- identity -----------------------------------------------------------------

/**
 * The principal iFinder knows a user by: the JWT subject iHub signs for them
 * (`jwtSubjectField`), as it is, case included, because iFinder's list call
 * matches the owner case-sensitively. Null for anyone who may not hold projects
 * (anonymous callers, OAuth clients, agents) and for a user the configured
 * field has no value for (local auth without an email): such a user gets no
 * iFinder tier, and no request is sent for them.
 *
 * @param {Object|null|undefined} user
 * @returns {string|null}
 */
export function principalOf(user) {
  if (!user || !canHoldProjects(user)) return null;
  try {
    const subject = resolveJwtSubject(user, configCache.getPlatform()?.iFinder || {});
    return subject.trim() ? subject : null;
  } catch {
    return null;
  }
}

/**
 * The iFinder installation tokens are minted for. A different endpoint, issuer
 * or audience is a different tenant, and nothing cached for one is read for
 * another.
 */
function tenantKey() {
  const settings = configCache.getPlatform()?.iFinder || {};
  const source = [
    iFinderService.getConfig().baseUrl,
    settings.issuer || '',
    settings.audience || ''
  ].join('\u0000');
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/** The key of one principal's cache entry: tenant, principal, then what is cached. */
function keyFor(tenant, principal, ...parts) {
  return [tenant, principal, ...parts].join('\u0000');
}

// --- the capability call --------------------------------------------------------

/**
 * @typedef {Object} Availability
 * @property {boolean} offered - The tier is offered to this user.
 * @property {keyof typeof TIER_REASONS} [reason] - Why not, or why it could not be told.
 * @property {boolean} [unavailable] - iFinder could not be asked: show a warning, not a missing tier.
 */

const HIDDEN = reason => ({ offered: false, reason });

function failureOf(error) {
  if (!(error instanceof SmartCollectionsError)) return TIER_REASONS.UNAVAILABLE;
  switch (error.code) {
    case SMART_COLLECTIONS_ERRORS.UNSUPPORTED:
      return TIER_REASONS.UNSUPPORTED;
    case SMART_COLLECTIONS_ERRORS.FORBIDDEN:
      return TIER_REASONS.FORBIDDEN;
    default:
      return TIER_REASONS.UNAVAILABLE;
  }
}

/** Remember what a failed call says about the tier, at the scope it holds for. */
function recordFailure(tenant, principal, reason) {
  if (reason === TIER_REASONS.UNSUPPORTED) {
    capabilities.set(tenant, { state: 'unsupported' }, TTL.unsupported);
  } else if (reason === TIER_REASONS.FORBIDDEN) {
    // The role is the user's, not the installation's.
    lists.set(keyFor(tenant, principal, 'list'), { forbidden: true }, TTL.forbidden);
  } else {
    capabilities.set(tenant, { state: 'unavailable' }, TTL.unavailable);
  }
}

/** The tier-wide state remembered for a tenant, as an availability, or null when unknown. */
function rememberedAvailability(tenant) {
  const known = capabilities.get(tenant);
  if (known?.state === 'unsupported') return HIDDEN(TIER_REASONS.UNSUPPORTED);
  if (known?.state === 'unavailable') {
    return { offered: false, reason: TIER_REASONS.UNAVAILABLE, unavailable: true };
  }
  return null;
}

/**
 * Whether the iFinder tier is offered to a user. The checks, cheapest first:
 * the tier policy and the iFinder configuration, a stable principal, then the
 * capability call, whose answer is remembered per installation (and per user
 * for a missing role). Never throws.
 *
 * @param {Object} user - The requesting user.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Availability>}
 */
export async function availabilityFor(user, { signal } = {}) {
  const platform = configCache.getPlatform() || {};
  if (!iFinderTierConfigured(platform)) return HIDDEN(TIER_REASONS.NOT_OFFERED);
  const principal = principalOf(user);
  if (!principal) return HIDDEN(TIER_REASONS.NO_PRINCIPAL);
  const tenant = tenantKey();
  // What this principal's own list already told comes first: it is current
  // data, and another user's failed call must not take it away.
  const listed = lists.get(keyFor(tenant, principal, 'list'));
  if (listed?.forbidden) return HIDDEN(TIER_REASONS.FORBIDDEN);
  if (listed) return { offered: true };
  const remembered = rememberedAvailability(tenant);
  if (remembered) return remembered;
  if (capabilities.get(tenant)?.state === 'supported') return { offered: true };
  try {
    await singleFlight(keyFor(tenant, principal, 'probe'), () =>
      smartCollections.probe({ user, signal })
    );
    capabilities.set(tenant, { state: 'supported' }, TTL.supported);
    return { offered: true };
  } catch (error) {
    const reason = failureOf(error);
    recordFailure(tenant, principal, reason);
    logger.info('The iFinder tier is not available', { component: COMPONENT, reason });
    return reason === TIER_REASONS.UNAVAILABLE
      ? { offered: false, reason, unavailable: true }
      : HIDDEN(reason);
  }
}

// --- the list ---------------------------------------------------------------------

/**
 * The user's collections as read-only projects, for the list: document counts
 * only, no items. Never throws.
 *
 * @param {Object} user
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{offered: boolean, projects: Object[], warnings: Object[], truncated?: boolean}>}
 *   `offered`: the tier exists for this user (an empty list is a list, not a
 *   missing tier). `warnings` is non-empty when iFinder could not be asked.
 */
export async function listCollectionProjects(user, { signal } = {}) {
  const none = (offered, warnings = []) => ({ offered, projects: [], warnings });
  const platform = configCache.getPlatform() || {};
  if (!iFinderTierConfigured(platform)) return none(false);
  const principal = principalOf(user);
  if (!principal) return none(false);
  const tenant = tenantKey();
  const key = keyFor(tenant, principal, 'list');
  let entry = lists.get(key);
  if (!entry) {
    const remembered = rememberedAvailability(tenant);
    if (remembered) {
      return none(false, remembered.unavailable ? [IFINDER_UNAVAILABLE_WARNING] : []);
    }
    try {
      entry = await singleFlight(key, async () => {
        const result = await smartCollections.list({ user, signal });
        lists.set(key, result, TTL.list);
        capabilities.set(tenant, { state: 'supported' }, TTL.supported);
        return result;
      });
    } catch (error) {
      const reason = failureOf(error);
      recordFailure(tenant, principal, reason);
      logger.info('The iFinder collections could not be listed', {
        component: COMPONENT,
        reason,
        code: error?.code
      });
      return reason === TIER_REASONS.UNAVAILABLE
        ? none(false, [IFINDER_UNAVAILABLE_WARNING])
        : none(false);
    }
  }
  if (entry.forbidden) return none(false);
  return {
    offered: true,
    // Built for this user now, from what iFinder said: never stored.
    projects: entry.collections.map(summary => projectOf(summary, user)),
    warnings: [],
    truncated: entry.truncated === true
  };
}

// --- one collection -----------------------------------------------------------------

/** The id an item gets: the same for the same document in the same collection, always. */
export function itemIdOf(collectionId, documentId) {
  const digest = createHash('sha256')
    .update(`${collectionId}\u0000${documentId}`)
    .digest('base64url')
    .slice(0, 22);
  return `itm_${digest}`;
}

function actorOf(user) {
  return {
    id: String(user?.id ?? ''),
    name: String(user?.name || user?.displayName || user?.username || user?.id || '')
  };
}

/**
 * A collection summary as a project, for the requesting user. The collection
 * is theirs in iFinder, which is why they are the owner here; the project is
 * read-only whoever asks (`projectPermissions` says so for every `ifc_` id).
 *
 * @param {import('../../integrations/SmartCollectionsService.js').SmartCollectionSummary} summary
 * @param {Object} user
 * @param {Object[]} [items]
 * @returns {Object}
 */
function projectOf(summary, user, items = []) {
  const owner = actorOf(user);
  return {
    id: ifinderProjectIdOf(summary.id),
    ownership: 'user',
    tier: 'ifinder',
    name: summary.name || summary.id,
    description: summary.description,
    instructions: '',
    owner,
    members: [],
    items,
    usage: { items: summary.documentCount, bytes: 0 },
    source: { type: 'smart-collection', collectionId: summary.id },
    createdAt: summary.createdAt,
    createdBy: owner,
    updatedAt: summary.updatedAt,
    updatedBy: null,
    lastActivityAt: summary.updatedAt
  };
}

function itemOf(collection, documentId, title, user) {
  const at = collection.updatedAt || collection.createdAt;
  return {
    id: itemIdOf(collection.id, documentId),
    kind: 'ifinder-document',
    name: title || documentId,
    ref: { documentId },
    storage: 'link',
    pinned: false,
    status: 'ready',
    error: null,
    provenance: {
      origin: 'linked',
      by: actorOf(user),
      at,
      run: null,
      source: { site: 'iFinder' }
    },
    snapshotAt: null,
    createdAt: at,
    updatedAt: at,
    cache: { ttlSeconds: 7200 }
  };
}

/**
 * The titles of documents, as the user may see them. One search per
 * {@link TITLE_BATCH} documents that are not cached for this principal, with
 * the user's own rights, so a document they may not see has no title (and is
 * named by its id). Best effort: a failure leaves the ids as names, and is not
 * cached.
 *
 * @param {Object} user
 * @param {string} principal
 * @param {string} tenant
 * @param {string} collectionId - Only to name the search in progress events.
 * @param {string[]} documentIds
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, string>>}
 */
async function titlesFor(user, principal, tenant, collectionId, documentIds, signal) {
  const found = new Map();
  const missing = [];
  for (const id of documentIds) {
    const cached = titles.get(keyFor(tenant, principal, 'title', id));
    if (cached === undefined) missing.push(id);
    else if (cached) found.set(id, cached);
  }
  // Ids go into a query string: only ids of the safe shape are asked for, the
  // rest keep their id as a name (an id that is not safe cannot be read either).
  const askable = missing.filter(id => isValidId(id));
  for (let start = 0; start < askable.length; start += TITLE_BATCH) {
    if (signal?.aborted) break;
    const batch = askable.slice(start, start + TITLE_BATCH);
    try {
      const result = await iFinderService.search({
        query: batch.map(id => `_id:"${id}"`).join(' OR '),
        chatId: `project-collection-${collectionId}`,
        user,
        maxResults: batch.length,
        returnFields: ['id', 'title'],
        returnFacets: [],
        queryLogging: false,
        signal
      });
      const answered = new Set();
      for (const hit of result?.results || []) {
        const id = hit?.id === undefined ? '' : String(hit.id);
        if (!id || !batch.includes(id)) continue;
        answered.add(id);
        const title = typeof hit.title === 'string' ? hit.title.trim().slice(0, 300) : '';
        titles.set(keyFor(tenant, principal, 'title', id), title, TTL.title);
        if (title) found.set(id, title);
      }
      // Asked for and not returned: not visible to this user (or gone). Cached
      // for a short while, so opening the project again does not ask again.
      for (const id of batch) {
        if (!answered.has(id)) titles.set(keyFor(tenant, principal, 'title', id), '', TTL.title);
      }
    } catch (error) {
      logger.warn('Titles of a collection could not be fetched', {
        component: COMPONENT,
        collectionId,
        error: error?.message
      });
      break;
    }
  }
  return found;
}

/**
 * One collection as a read-only project with its documents as items.
 *
 * Outcomes, none of them thrown:
 *  - `ok`: the project (`items` named with the titles the user may see);
 *  - `hidden`: the tier is not offered to this user, or the id is no collection;
 *  - `not-found`: no such collection, or not theirs (iFinder answers 404 for both);
 *  - `unavailable`: iFinder could not be asked.
 *
 * @param {Object} user
 * @param {string} projectId - `ifc_<uuid>`.
 * @param {{signal?: AbortSignal, titles?: boolean}} [options] - `titles: false`
 *   names the items by their ids and sends no search.
 * @returns {Promise<{status: 'ok', project: Object}|{status: 'hidden'|'not-found'|'unavailable'}>}
 */
export async function loadCollectionProject(
  user,
  projectId,
  { signal, titles: withTitles = true } = {}
) {
  const collectionId = collectionIdOf(projectId);
  if (!collectionId) return { status: 'hidden' };
  const platform = configCache.getPlatform() || {};
  if (!iFinderTierConfigured(platform)) return { status: 'hidden' };
  const principal = principalOf(user);
  if (!principal) return { status: 'hidden' };
  const tenant = tenantKey();
  if (lists.get(keyFor(tenant, principal, 'list'))?.forbidden) return { status: 'hidden' };

  const key = keyFor(tenant, principal, 'collection', collectionId);
  let collection = collections.get(key);
  if (!collection) {
    const remembered = rememberedAvailability(tenant);
    if (remembered) return { status: remembered.unavailable ? 'unavailable' : 'hidden' };
    try {
      collection = await singleFlight(key, async () => {
        const loaded = await smartCollections.get({ user, id: collectionId, signal });
        collections.set(key, loaded, TTL.collection);
        return loaded;
      });
    } catch (error) {
      const reason = error instanceof SmartCollectionsError ? error.code : null;
      if (reason === SMART_COLLECTIONS_ERRORS.NOT_FOUND) return { status: 'not-found' };
      if (reason === SMART_COLLECTIONS_ERRORS.FORBIDDEN) {
        recordFailure(tenant, principal, TIER_REASONS.FORBIDDEN);
        return { status: 'hidden' };
      }
      if (reason === SMART_COLLECTIONS_ERRORS.UNSUPPORTED) {
        recordFailure(tenant, principal, TIER_REASONS.UNSUPPORTED);
        return { status: 'hidden' };
      }
      recordFailure(tenant, principal, TIER_REASONS.UNAVAILABLE);
      logger.info('A collection could not be loaded', {
        component: COMPONENT,
        collectionId,
        code: reason
      });
      return { status: 'unavailable' };
    }
  }
  const named = withTitles
    ? await titlesFor(user, principal, tenant, collectionId, collection.documentIds, signal)
    : new Map();
  const items = collection.documentIds.map(id => itemOf(collection, id, named.get(id), user));
  return { status: 'ok', project: projectOf(collection, user, items) };
}

export default {
  availabilityFor,
  listCollectionProjects,
  loadCollectionProject,
  principalOf
};
