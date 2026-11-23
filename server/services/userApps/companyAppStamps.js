// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one-time upgrade pass that stamps the company apps of 5.7.4.
 *
 * A publish writes the personal app's ID into the company app
 * (`sourceUserAppId`), and a promoted record counts as promoted only while
 * its company app carries that ID (`isCompanyAppOf` in `userAppAccess.js`).
 * Company apps published or taken over with 5.7.4 carry no stamp. Without
 * this pass their records would be released on the first read after the
 * update: the personal app would become editable again and its company app
 * would be orphaned.
 *
 * The pass, once per installation:
 *
 * 1. Lists every promoted record that names its company app.
 * 2. For each app ID claimed by exactly one record, writes the record's ID
 *    into `contents/apps/<appId>.json` when the file exists and carries no
 *    stamp. A file with another stamp is left as it is. An app ID claimed by
 *    two records is stamped for neither, with a warning: the pass cannot tell
 *    which of them published it.
 * 3. Reloads the apps once.
 * 4. Records that it is done: the marker `user-app-company-app-stamps` in the
 *    `runtime-imports` namespace, where the other one-time passes keep theirs.
 * 5. Switches this process to the strict rule (`setCompanyAppStampsChecked`).
 *
 * Until step 5, and for good when the pass fails, an app file without any
 * stamp counts as the company app of the record that points at it (5.7.4
 * behaviour), so no record is released for a missing stamp. A failed pass
 * writes no marker and runs again on the next start.
 *
 * The pass runs at startup (`server/startup/worker.js`), after storage and the
 * configuration cache are up and before the routes are registered, whether
 * or not the feature `userApps` is switched on: the records exist either way.
 * The resolver of personal apps awaits {@link companyAppStampsSettled} before
 * it decides whether a record is released, so a pass started late still
 * comes first.
 *
 * Every worker of a cluster runs it. The writes are idempotent (a file that
 * carries a stamp is never written again), and a worker that finds the marker
 * still reloads the apps before it switches to the strict rule, so it never
 * judges by a cache loaded before another worker stamped.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, section 8.2.
 *
 * @module services/userApps/companyAppStamps
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { isUserAppId } from '../../../shared/userAppContent.js';
import configStore from '../config/ConfigStore.js';
import { getUserAppRepository } from './UserAppRepository.js';
import { setCompanyAppStampsChecked } from './userAppAccess.js';

const COMPONENT = 'UserAppCompanyStamps';

/** Namespace of the marker, shared with the other one-time passes. */
export const COMPANY_APP_STAMPS_MARKER_NAMESPACE = RUNTIME_NAMESPACES.runtimeImports;

/** Key of the marker that records the pass as done. */
export const COMPANY_APP_STAMPS_MARKER = 'user-app-company-app-stamps';

/** The config cache key of the apps. */
const APPS_CACHE_KEY = 'config/apps.json';

/** The pass started in this process, or null when none was started. */
let pending = null;

/**
 * Whether the marker says the pass has completed on this installation.
 *
 * @param {Object} documents - Document facet of the storage provider.
 * @returns {Promise<boolean>}
 */
async function hasMarker(documents) {
  const marker = await documents.get(
    COMPANY_APP_STAMPS_MARKER_NAMESPACE,
    COMPANY_APP_STAMPS_MARKER
  );
  return Boolean(marker?.data?.completedAt);
}

/**
 * The records that claim each company app ID, by the lower-case ID (app IDs
 * are compared without regard to case, as every app lookup compares them).
 *
 * @param {Object[]} records - Promoted records with `publishedAs.appId`.
 * @returns {Map<string, Object[]>}
 */
function claimsByAppId(records) {
  const claims = new Map();
  for (const record of records) {
    const key = record.publishedAs.appId.toLowerCase();
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(record);
  }
  return claims;
}

/**
 * Write the record's ID into its company app file, if the file exists and
 * carries no stamp.
 *
 * @param {Object} record - The only promoted record that claims the app ID.
 * @param {Object} deps
 * @param {Object} deps.store - The configuration store.
 * @param {Object} deps.cache - The configuration cache.
 * @returns {Promise<'stamped'|'alreadyStamped'|'otherStamp'|'missing'>}
 */
async function stampOne(record, { store, cache }) {
  const appId = record.publishedAs.appId;
  // The cache knows the ID as the file spells it; the record may differ in case.
  const known = findByIdCaseInsensitive(cache.getApps(true)?.data || [], appId);
  const relPath = await store.resolveIdToPath('apps', known?.id || appId, {
    createIfMissing: false
  });
  if (!relPath) return 'missing';

  let outcome = 'missing';
  await store.updateJson(relPath, current => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      outcome = 'missing';
      return undefined;
    }
    const stamp = current.sourceUserAppId;
    if (stamp !== undefined && stamp !== null) {
      outcome = stamp === record.id ? 'alreadyStamped' : 'otherStamp';
      return undefined;
    }
    outcome = 'stamped';
    return { ...current, sourceUserAppId: record.id };
  });
  return outcome;
}

/**
 * Run the upgrade pass once (see the module description). Never throws: a
 * failure is logged, writes no marker and leaves this process on the 5.7.4
 * rule; the next start tries again.
 *
 * @param {Object} [deps] - Injected for tests; default to the process-wide ones.
 * @param {import('./UserAppRepository.js').UserAppRepository} [deps.repository]
 * @param {Object} [deps.store] - The configuration store.
 * @param {Object} [deps.cache] - The configuration cache.
 * @param {Object} [deps.log] - Logger.
 * @returns {Promise<{status: 'done'|'alreadyDone'|'unavailable'|'failed',
 *   stamped?: number, alreadyStamped?: number, otherStamp?: number,
 *   missing?: number, conflicts?: number}>}
 */
export async function runCompanyAppStamps({
  repository = getUserAppRepository(),
  store = configStore,
  cache = configCache,
  log = logger
} = {}) {
  try {
    if (!repository?.isAvailable?.()) {
      log.warn('Personal apps have no storage; the company apps of 5.7.4 stay unstamped', {
        component: COMPONENT
      });
      return { status: 'unavailable' };
    }
    const documents = repository.documents;

    if (await hasMarker(documents)) {
      // Another start, or another worker, stamped the files: judge by them.
      if (!(await cache.refresh(APPS_CACHE_KEY))) return { status: 'failed' };
      setCompanyAppStampsChecked(true);
      return { status: 'alreadyDone' };
    }

    const counts = { stamped: 0, alreadyStamped: 0, otherStamp: 0, missing: 0, conflicts: 0 };
    let failures = 0;
    const claims = claimsByAppId(await repository.listPromoted());
    for (const records of claims.values()) {
      if (records.length > 1) {
        counts.conflicts += 1;
        log.warn('Several personal apps claim the same company app; none of them is stamped', {
          component: COMPONENT,
          appId: records[0].publishedAs.appId,
          userAppIds: records.map(record => record.id)
        });
        continue;
      }
      const [record] = records;
      if (!isUserAppId(record.id)) continue;
      try {
        counts[await stampOne(record, { store, cache })] += 1;
      } catch (error) {
        failures += 1;
        log.error('The company app of a personal app could not be stamped', {
          component: COMPONENT,
          appId: record.publishedAs.appId,
          userAppId: record.id,
          error: error.message
        });
      }
    }

    // Once, for every file written above, and for files another worker wrote.
    const reloaded = await cache.refresh(APPS_CACHE_KEY);
    if (failures > 0) {
      log.error('Not every company app of 5.7.4 was stamped; the pass runs again on next start', {
        component: COMPONENT,
        failures,
        ...counts
      });
      return { status: 'failed', ...counts };
    }

    await documents.put(COMPANY_APP_STAMPS_MARKER_NAMESPACE, COMPANY_APP_STAMPS_MARKER, {
      completedAt: new Date().toISOString(),
      ...counts
    });
    log.info('Stamped the company apps of personal apps published before the update', {
      component: COMPONENT,
      ...counts
    });
    if (!reloaded) return { status: 'failed', ...counts };
    setCompanyAppStampsChecked(true);
    return { status: 'done', ...counts };
  } catch (error) {
    log.error('The company apps of 5.7.4 could not be stamped; the pass runs again on next start', {
      component: COMPONENT,
      error: error.message
    });
    return { status: 'failed' };
  }
}

/**
 * Start the upgrade pass in this process, once. A second call answers the
 * same promise.
 *
 * @param {Parameters<typeof runCompanyAppStamps>[0]} [deps]
 * @returns {ReturnType<typeof runCompanyAppStamps>} Never rejects.
 */
export function ensureCompanyAppStamps(deps) {
  if (!pending) pending = runCompanyAppStamps(deps);
  return pending;
}

/**
 * Settles when the pass started in this process has finished, successfully or
 * not; at once when none was started. The resolver awaits it before it
 * decides whether a promoted record is released.
 *
 * @returns {Promise<void>} Never rejects.
 */
export async function companyAppStampsSettled() {
  if (pending) await pending;
}

/** Forget the pass of this process and go back to the 5.7.4 rule, for tests. */
export function resetCompanyAppStampsForTests() {
  pending = null;
  setCompanyAppStampsChecked(false);
}
