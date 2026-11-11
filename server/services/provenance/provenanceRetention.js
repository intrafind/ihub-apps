// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Daily sweep of provenance records older than `provenance.retentionDays`.
 * 0 or less keeps records forever. Run by the cluster-singleton worker only.
 *
 * @module services/provenance/provenanceRetention
 */
import logger from '../../utils/logger.js';
import { isStorageReady } from '../../storage/bootstrap.js';
import { getProvenanceStore } from './ProvenanceStore.js';
import { provenanceSettings } from './provenanceSettings.js';

const COMPONENT = 'ProvenanceRetention';
const DAY_MS = 24 * 60 * 60 * 1000;

let sweepTimer = null;
let startupTimer = null;
let sweeping = false;

/**
 * @param {Object} [options]
 * @param {number} [options.retentionDays] - Override the configured limit (tests).
 * @param {() => number} [options.now]
 * @returns {Promise<{scanned: number, removedRecords: number, removedDocuments: number, skipped: boolean}>}
 */
export async function sweepProvenance({ retentionDays, now = Date.now } = {}) {
  const days =
    retentionDays !== undefined ? Number(retentionDays) : provenanceSettings().retentionDays;
  const empty = { scanned: 0, removedRecords: 0, removedDocuments: 0, skipped: true };
  if (!(days > 0)) return empty;
  const store = getProvenanceStore();
  if (!store.isAvailable()) return empty;
  const result = await store.sweep(now() - days * DAY_MS);
  if (result.removedRecords > 0) {
    logger.info('Provenance retention sweep removed expired records', {
      component: COMPONENT,
      ...result,
      retentionDays: days
    });
  }
  return { ...result, skipped: false };
}

/** Start the daily sweep (and one shortly after startup). */
export function startProvenanceRetentionSweep({ intervalMs = DAY_MS } = {}) {
  if (sweepTimer) return;
  const tick = async () => {
    if (sweeping || !isStorageReady()) return;
    sweeping = true;
    try {
      await sweepProvenance();
    } catch (error) {
      logger.error('Provenance retention sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    } finally {
      sweeping = false;
    }
  };
  sweepTimer = setInterval(tick, intervalMs);
  sweepTimer.unref?.();
  startupTimer = setTimeout(tick, 5000);
  startupTimer.unref?.();
}

/** Stop the sweep (shutdown and tests). */
export function stopProvenanceRetentionSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (startupTimer) clearTimeout(startupTimer);
  sweepTimer = null;
  startupTimer = null;
}
