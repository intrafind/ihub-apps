// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Startup wiring of the project text pipeline (spec 3): the decrypting
 * text reader the knowledge provider calls, the ingest service the project
 * service hands uploads to, the cache evictions when text goes away, the
 * temp directory sweep and the reconciler.
 *
 * Runs after `TokenStorageService.initializeEncryptionKey()`: the local key
 * provider wraps data keys with that key.
 *
 * @module services/projects/bootstrap
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { evictItemText, setTextReader } from '../knowledge/ItemTextService.js';
import { evictProjectIndex } from '../knowledge/LocalKnowledgeProvider.js';
import { evictItemKeys, readText } from './ItemTextStore.js';
import {
  ProjectIngestService,
  startIngestReconciler,
  stopIngestReconciler
} from './ProjectIngestService.js';
import { getProjectService } from './ProjectService.js';

const COMPONENT = 'ProjectsBootstrap';

function platformOf() {
  return configCache.getPlatform?.() || {};
}

let ingestService = null;

/**
 * Wire the pipeline into the process-wide project service.
 *
 * @param {{reconcile?: boolean}} [options] - `reconcile: false` skips the
 *   startup sweeps (tests).
 * @returns {Promise<ProjectIngestService>}
 */
export async function bootstrapProjects({ reconcile = true } = {}) {
  const service = getProjectService();
  setTextReader((project, item) => readText(project, item, { platform: platformOf() }));
  if (!ingestService) {
    ingestService = new ProjectIngestService({
      service: () => getProjectService(),
      repository: () => getProjectService().repository,
      platform: platformOf,
      onReady: (projectId, _item, { previousBlobKey } = {}) => {
        evictProjectIndex(projectId);
        if (previousBlobKey) {
          evictItemText(previousBlobKey);
          evictItemKeys(previousBlobKey);
        }
      }
    });
    service.onItemRemoved.push((projectId, _itemId, item) => {
      evictProjectIndex(projectId);
      const key = item?.text?.blobKey;
      if (key) {
        evictItemText(key);
        evictItemKeys(key);
      }
    });
  }
  service.ingest = ingestService;
  if (reconcile) {
    try {
      const removed = await ingestService.cleanTempDir();
      if (removed)
        logger.info('Removed stale project upload directories', { component: COMPONENT, removed });
    } catch (error) {
      logger.warn('Could not sweep the project upload directory', {
        component: COMPONENT,
        error: error.message
      });
    }
    startIngestReconciler(ingestService);
  }
  return ingestService;
}

/** Stop the reconciler (shutdown and tests). */
export function shutdownProjects() {
  stopIngestReconciler();
}

/** The ingest service, once bootstrapped. */
export function getIngestService() {
  return ingestService;
}
