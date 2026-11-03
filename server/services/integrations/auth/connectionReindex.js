// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One-time re-index of the per-user tokens an installation already has into
 * the connection index (`integration-connections`), so that after the upgrade
 * every user with a stored Jira, Office 365, Google Drive, Nextcloud or
 * per-user MCP token is still connected — without consenting again.
 *
 * No token is moved, copied or re-encrypted: the index record's `secretRef`
 * names the file `TokenStorageService` has always kept. The mapping
 * (concept `2026-10-20 Unified Integrations/04-architecture.md` §7):
 *
 *   | Token file                                   | integration                         | principal                  |
 *   | -------------------------------------------- | ----------------------------------- | -------------------------- |
 *   | `jira/<userId>.json`                         | the `jira` installation             | user `<userId>`            |
 *   | `<service>/<userId>__<providerId>.json`      | the storage installation `<providerId>` | user `<userId>`        |
 *   | `<service>/<userId>.json` (legacy, unscoped) | the only installation of that service; skipped and logged when there are several | user `<userId>` |
 *   | `mcp/<storageId>__<serverId>.json`           | the MCP installation `<serverId>`   | the user id inside the payload |
 *
 * where `<service>` is `office365`, `googledrive` or `nextcloud`. A file whose
 * installation is gone, that the current key cannot read, or (MCP) that was
 * issued for another endpoint is skipped and logged. Other directories under
 * `contents/integrations/` (the OIDC login tokens of iFinder, …) are not
 * connections and are left alone.
 *
 * Why a startup re-index and not a config migration: the index is runtime
 * state in the pluggable storage, not a config file in `contents/config/`; no
 * config file changes shape, so there is no `V…` migration. Like the other
 * one-time runtime imports it is:
 *   - **idempotent** — a record that exists is never overwritten (a newer
 *     connect or refresh wins), so a retry after a crash finishes the job;
 *   - **run once** — a marker in `runtime-imports` (`integration-connections`)
 *     ends it on every later start;
 *   - **cluster-safe** — the whole run holds the storage provider's lock
 *     `runtime-import:integration-connections`; a worker that cannot take it
 *     skips the run instead of racing it.
 * The connection service also indexes a token file it meets without a record,
 * so nothing depends on this run having finished.
 *
 * @module services/integrations/auth/connectionReindex
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import tokenStorage from '../../TokenStorageService.js';
import { getStorage, readFacet } from '../../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../../storage/namespaces.js';
import logger from '../../../utils/logger.js';
import { CLOUD_STORAGE_PROVIDERS, listCloudStorageInstallations } from '../cloudStorageConfig.js';
import { JIRA_INSTANCE_ID, JIRA_TOKEN_SERVICE } from '../jiraConfig.js';
import { describeInstallation } from './connectionProviders.js';
import {
  getIntegrationConnectionService,
  recordFromStored
} from './IntegrationConnectionService.js';
import { SAFE_STORAGE_ID, tokenSecretRef } from './tokenSecrets.js';

const COMPONENT = 'ConnectionReindex';

/** Namespace and key of the "already ran" marker. */
export const REINDEX_MARKER_NAMESPACE = RUNTIME_NAMESPACES.runtimeImports;
export const REINDEX_MARKER_KEY = 'integration-connections';

const LOCK_NAME = 'runtime-import:integration-connections';
const LOCK_OPTIONS = { ttlMs: 300_000, waitMs: 1000 };

const MCP_SERVICE = 'mcp';

async function listJson(dir) {
  try {
    return (await fs.readdir(dir)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readEnvelope(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build one index record from a token file, or explain why not.
 * @returns {Promise<{record: Object}|{skip: string}>}
 */
async function recordFor({ descriptor, service, storageId, providerId, userIdFromPayload, now }) {
  const file = path.join(
    tokenStorage.storageBasePath,
    service,
    providerId ? `${storageId}__${providerId}.json` : `${storageId}.json`
  );
  const envelope = await readEnvelope(file);
  if (!envelope) return { skip: 'unreadable file' };
  let payload;
  try {
    payload = tokenStorage.decryptTokens(envelope, storageId, service);
  } catch {
    return { skip: 'cannot decrypt (another key?)' };
  }
  const userId = userIdFromPayload
    ? typeof payload?.userId === 'string' && payload.userId
      ? payload.userId
      : storageId
    : storageId;
  const view = descriptor.secret.view(payload);
  if (!view) return { skip: 'no access token' };
  if (descriptor.stack === 'mcp') {
    const { tokensMatchServer } = await import('../../mcp/mcpUserTokens.js');
    if (!tokensMatchServer(payload, descriptor.serverConfig)) {
      return { skip: 'issued for another endpoint' };
    }
  }
  return {
    record: recordFromStored({
      descriptor,
      userId,
      located: {
        secretRef: tokenSecretRef({ service, storageId, providerId }),
        createdAt: envelope.createdAt || null,
        expiresAt: envelope.expiresAt || null
      },
      view,
      now
    })
  };
}

/**
 * Every token file the mapping covers, with the installation it maps to.
 * @returns {Promise<{candidates: Object[], skipped: Array<{file: string, reason: string}>}>}
 */
async function collectCandidates() {
  const candidates = [];
  const skipped = [];
  const base = tokenStorage.storageBasePath;
  const describeCache = new Map();
  const describe = async id => {
    if (!describeCache.has(id)) {
      describeCache.set(id, await describeInstallation(id).catch(() => null));
    }
    return describeCache.get(id);
  };

  // Jira: one slot per user.
  for (const file of await listJson(path.join(base, JIRA_TOKEN_SERVICE))) {
    const stem = file.slice(0, -'.json'.length);
    if (!SAFE_STORAGE_ID.test(stem) || stem.includes('__')) {
      skipped.push({ file: `jira/${file}`, reason: 'unexpected file name' });
      continue;
    }
    const descriptor = await describe(JIRA_INSTANCE_ID);
    if (descriptor?.stack !== 'jira') {
      skipped.push({ file: `jira/${file}`, reason: 'no jira installation' });
      continue;
    }
    candidates.push({ descriptor, service: JIRA_TOKEN_SERVICE, storageId: stem, providerId: null });
  }

  // Cloud storage: scoped files and legacy unscoped ones.
  for (const [type, spec] of Object.entries(CLOUD_STORAGE_PROVIDERS)) {
    const installations = listCloudStorageInstallations(type);
    for (const file of await listJson(path.join(base, spec.service))) {
      const stem = file.slice(0, -'.json'.length);
      const at = stem.indexOf('__');
      const storageId = at > 0 ? stem.slice(0, at) : stem;
      const providerId = at > 0 ? stem.slice(at + 2) : null;
      if (!SAFE_STORAGE_ID.test(storageId) || (providerId && !SAFE_STORAGE_ID.test(providerId))) {
        skipped.push({ file: `${spec.service}/${file}`, reason: 'unexpected file name' });
        continue;
      }
      let installationId = providerId;
      if (!installationId) {
        if (installations.length !== 1) {
          skipped.push({
            file: `${spec.service}/${file}`,
            reason:
              installations.length === 0
                ? 'legacy file, no installation of this service'
                : 'legacy file, several installations of this service'
          });
          continue;
        }
        installationId = installations[0].id;
      }
      const descriptor = await describe(installationId);
      if (descriptor?.stack !== 'cloud-storage' || descriptor.type !== type) {
        skipped.push({ file: `${spec.service}/${file}`, reason: 'installation not found' });
        continue;
      }
      candidates.push({ descriptor, service: spec.service, storageId, providerId });
    }
  }

  // Per-user MCP: the user id is inside the payload (storage ids may be hashed).
  for (const file of await listJson(path.join(base, MCP_SERVICE))) {
    const stem = file.slice(0, -'.json'.length);
    const at = stem.indexOf('__');
    if (at <= 0) {
      skipped.push({ file: `mcp/${file}`, reason: 'unexpected file name' });
      continue;
    }
    const storageId = stem.slice(0, at);
    const serverId = stem.slice(at + 2);
    if (!SAFE_STORAGE_ID.test(storageId) || !SAFE_STORAGE_ID.test(serverId)) {
      skipped.push({ file: `mcp/${file}`, reason: 'unexpected file name' });
      continue;
    }
    const descriptor = await describe(serverId);
    if (descriptor?.stack !== 'mcp') {
      skipped.push({ file: `mcp/${file}`, reason: 'no per-user MCP installation' });
      continue;
    }
    candidates.push({
      descriptor,
      service: MCP_SERVICE,
      storageId,
      providerId: serverId,
      userIdFromPayload: true
    });
  }
  return { candidates, skipped };
}

/**
 * Re-index the token tree into the connection index, once.
 *
 * @param {Object} [options]
 * @param {Object|null} [options.documents] - Document store (default: the provider's)
 * @param {Object|null} [options.locks] - Lock manager (default: the provider's)
 * @param {import('./IntegrationConnectionService.js').IntegrationConnectionService} [options.service]
 * @param {boolean} [options.force=false] - Ignore the marker (tests, a manual re-run)
 * @returns {Promise<{ran: boolean, indexed: number, existing: number, skipped: number, reason?: string}>}
 */
export async function reindexIntegrationConnections({
  documents = readFacet(getStorage(), 'documents'),
  locks = readFacet(getStorage(), 'locks'),
  service = getIntegrationConnectionService(),
  force = false
} = {}) {
  const idle = { ran: false, indexed: 0, existing: 0, skipped: 0 };
  if (!documents) {
    logger.info('No storage provider; connections are indexed as they are used', {
      component: COMPONENT
    });
    return { ...idle, reason: 'storage-unavailable' };
  }
  const alreadyDone = async () => {
    if (force) return false;
    const marker = await documents.get(REINDEX_MARKER_NAMESPACE, REINDEX_MARKER_KEY);
    return Boolean(marker?.data?.completedAt);
  };
  if (await alreadyDone()) return { ...idle, reason: 'already-indexed' };

  const run = async () => {
    // Checked again under the lock: on a first boot every worker passes the
    // outer check at once.
    if (await alreadyDone()) return { ...idle, reason: 'already-indexed' };
    const now = new Date().toISOString();
    const { candidates, skipped } = await collectCandidates();
    let indexed = 0;
    let existing = 0;
    for (const candidate of candidates) {
      const outcome = await recordFor({ ...candidate, now });
      if (outcome.skip) {
        skipped.push({
          file: `${candidate.service}/${candidate.storageId}${candidate.providerId ? `__${candidate.providerId}` : ''}.json`,
          reason: outcome.skip
        });
        continue;
      }
      // Create-only: a record a live connect or refresh wrote meanwhile (on
      // any worker) wins, atomically in the document store.
      const { created, record } = await service.createConnection(outcome.record);
      if (created) indexed += 1;
      else if (record) existing += 1;
    }
    for (const entry of skipped) {
      logger.warn('Token file not indexed as a connection', {
        component: COMPONENT,
        file: entry.file,
        reason: entry.reason
      });
    }
    await documents.put(REINDEX_MARKER_NAMESPACE, REINDEX_MARKER_KEY, {
      completedAt: new Date().toISOString(),
      indexed,
      existing,
      skipped: skipped.length
    });
    const result = { ran: true, indexed, existing, skipped: skipped.length };
    if (indexed || skipped.length) {
      logger.info('Integration connections indexed from the token store', {
        component: COMPONENT,
        ...result
      });
    }
    return result;
  };

  if (!locks) return run();
  try {
    return await locks.withLock(LOCK_NAME, run, LOCK_OPTIONS);
  } catch (error) {
    if (error?.code === 'LOCK_TIMEOUT') {
      logger.debug?.('Connection re-index already running elsewhere', { component: COMPONENT });
      return { ...idle, reason: 'in-progress' };
    }
    throw error;
  }
}

export default reindexIntegrationConnections;
