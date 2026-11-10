// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Retention of the Website Corpus' crawls: a daily sweep removes every corpus
 * older than `RETENTION_DAYS`, whoever owns it.
 *
 * A corpus is a working copy of a site for one sizing. Starting a discovery
 * already removes the owner's expired and surplus corpora, but someone who
 * stops using the tool would leave theirs (the extracted text of a site, up to
 * a few thousand pages) in storage for good; this sweep closes that gap.
 *
 * Same shape and the same ownership guard as the project and chat sweeps: the
 * cluster-singleton worker runs it, so two workers never race each other's
 * deletes.
 *
 * @module services/websiteCorpus/corpusRetention
 */
import logger from '../../utils/logger.js';
import { isStorageReady } from '../../storage/bootstrap.js';
import { getCorpusStore } from './CorpusStore.js';

const COMPONENT = 'WebsiteCorpusRetention';
const DAY_MS = 24 * 60 * 60 * 1000;

let sweepTimer = null;
let startupTimer = null;
let sweeping = false;

/**
 * Remove every expired corpus.
 *
 * @param {Object} [options]
 * @param {import('./CorpusStore.js').CorpusStore} [options.store]
 * @param {() => number} [options.now]
 * @returns {Promise<{scanned: number, deleted: number, skipped: boolean}>}
 */
export async function sweepWebsiteCorpora({ store = getCorpusStore(), now = Date.now } = {}) {
  if (!store.isAvailable()) return { scanned: 0, deleted: 0, skipped: true };
  const { scanned, deleted } = await store.sweepExpired(now());
  if (deleted > 0) {
    logger.info('Website corpus retention sweep removed expired corpora', {
      component: COMPONENT,
      deleted
    });
  }
  return { scanned, deleted, skipped: false };
}

/**
 * Start the daily sweep, with a first run shortly after startup.
 *
 * @param {Object} [options]
 * @param {number} [options.intervalMs]
 */
export function startWebsiteCorpusRetentionSweep({ intervalMs = DAY_MS } = {}) {
  if (sweepTimer) return;
  const tick = async () => {
    if (sweeping || !isStorageReady()) return;
    sweeping = true;
    try {
      await sweepWebsiteCorpora();
    } catch (error) {
      logger.error('Website corpus retention sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    } finally {
      sweeping = false;
    }
  };
  sweepTimer = setInterval(tick, intervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  startupTimer = setTimeout(tick, 5000);
  startupTimer.unref?.();
}

/** Stop the sweep (shutdown and tests). */
export function stopWebsiteCorpusRetentionSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (startupTimer) clearTimeout(startupTimer);
  sweepTimer = null;
  startupTimer = null;
}
