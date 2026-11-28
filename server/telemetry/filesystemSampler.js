// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Feeds `ihub.storage.filesystem.usage` / `.limit`: the disk usage of the
 * volumes iHub writes to (contents, data, uploads, logs, temp), the numbers the
 * admin System resources page shows. A full `contents/` volume makes chat saves
 * fail while `/api/health` still answers; with these gauges an alert fires at
 * 85 % instead.
 *
 * Observable gauges are read synchronously, while `statfs` is not: the sampler
 * measures every minute and the gauges report the last measurement.
 *
 * @module telemetry/filesystemSampler
 */

import configCache from '../configCache.js';
import {
  getLogFilePath,
  getMonitoredPaths,
  getStorageSnapshot
} from '../services/systemResources.js';
import logger from '../utils/logger.js';
import { registerFilesystemObservers } from './metrics.js';

const SAMPLE_INTERVAL_MS = 60_000;

let latest = [];
let timer = null;

/**
 * The volumes of a storage snapshot, one entry per storage location: a volume
 * that holds several locations is reported once for each.
 *
 * @param {{volumes: Array<{paths: Array<{key: string}>, used: number, total: number}>}} snapshot
 * @returns {Array<{mount: string, used: number, total: number}>}
 */
export function volumesByMount(snapshot) {
  const out = [];
  for (const volume of snapshot?.volumes || []) {
    for (const { key } of volume.paths || []) {
      out.push({ mount: key, used: volume.used, total: volume.total });
    }
  }
  return out;
}

async function sample() {
  try {
    const platform = configCache.getPlatform?.() || {};
    const snapshot = await getStorageSnapshot(
      getMonitoredPaths({ logFile: getLogFilePath(platform) })
    );
    latest = volumesByMount(snapshot);
  } catch (error) {
    logger.warn('Could not measure disk usage for the filesystem gauges', {
      component: 'Telemetry',
      error: error.message
    });
  }
}

/** Start measuring and register the gauges. Idempotent. */
export function startFilesystemSampler() {
  if (timer) return;
  registerFilesystemObservers(() => latest);
  void sample();
  timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

/** Stop measuring (shutdown, tests). */
export function stopFilesystemSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}
