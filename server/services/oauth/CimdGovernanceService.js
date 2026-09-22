/**
 * Governance for clients identified by a metadata document.
 *
 * A CIMD client has no record until an administrator (or a first successful
 * authorization) creates one, so the admin list has to be a *join*: the policy
 * records in `oauth-clients.json`, the connections in the consent store, and
 * the platform defaults that apply where a record says nothing. This module is
 * that join, and the one place a discovery record is written from.
 *
 * What it deliberately does not do is invent identity. A row's name comes from
 * the consent snapshot or the display snapshot on the record; `redirect_uris`,
 * `grant_types` and `token_endpoint_auth_method` are never stored and never
 * shown as editable — they come from the document, every time.
 *
 * @module services/oauth/CimdGovernanceService
 */
import {
  findCimdClientPolicy,
  listCimdClientPolicies,
  upsertCimdClientPolicy
} from '../../utils/oauthClientManager.js';
import { clientIdHost } from '../../utils/clientIdMetadata.js';
import { getCimdConfig } from '../../utils/oauthClientResolver.js';
import { effectiveField, evaluateCimdActivation } from '../../utils/oauthClientPolicy.js';
import { countByClient, listSeenCimdClients } from './ConnectionService.js';
import logger from '../../utils/logger.js';
import { oauthClientsFile } from '../../utils/contentsPath.js';

/** Where the client store lives, with the shipped default applied. */
export function clientsFileFor(platform) {
  return oauthClientsFile(platform?.oauth);
}

/**
 * Turn a policy record and its connection data into one admin row.
 *
 * Both the record's own values and the effective (layered) ones are returned:
 * the edit page needs to show which fields this client decides for itself and
 * which it inherits from `platform.oauth.cimd`, and it cannot tell them apart
 * from the layered result alone.
 *
 * @param {Object} params
 * @param {string} params.clientId - CIMD client identifier
 * @param {Object|null} params.record - Stored policy record, if any
 * @param {Object|null} params.seen - Row derived from the consent store, if any
 * @param {Object} params.cimdConfig - Normalized platform CIMD policy
 * @param {number} params.connectionCount - Live connections for this client
 * @returns {Object} One admin row
 */
function toRow({ clientId, record, seen, cimdConfig, connectionCount }) {
  const activation = evaluateCimdActivation(clientId, cimdConfig, record);

  return {
    clientId,
    host: record?.metadata?.host || seen?.host || clientIdHost(clientId),
    name: seen?.name || record?.metadata?.displayName || clientId,
    kind: 'cimd',
    connectionCount,
    lastUsedAt: seen?.lastUsedAt || record?.lastUsed || null,
    firstSeenAt: record?.metadata?.firstSeenAt || seen?.firstGrantedAt || null,
    firstUserId: record?.metadata?.firstUserId || '',
    firstUserName: record?.metadata?.firstUserName || '',
    // `hasRecord: false` is the "synthetic row" case that predates governance:
    // a client people are connected through that nobody has decided anything
    // about yet.
    hasRecord: !!record,
    approvalState: record?.approvalState || null,
    // A pending record carries `active: false` so that nothing can connect
    // through it while it waits, but that is not a block and must not be shown
    // as one: the row would offer "Unblock" for a client no administrator ever
    // blocked, and clicking it would report success while the client stayed
    // refused by the approval gate. `blockedAt` is what an actual block leaves
    // behind, so a client that is both pending and blocked still reads as
    // blocked.
    blocked:
      record?.active === false &&
      (record?.approvalState !== 'pending' || !!record?.metadata?.blockedAt),
    active: activation.active,
    inactiveCode: activation.code || null,
    approvedBy: record?.metadata?.approvedBy || '',
    approvedAt: record?.metadata?.approvedAt || null,
    blockedBy: record?.metadata?.blockedBy || '',
    blockedAt: record?.metadata?.blockedAt || null,
    // What the record itself sets — `undefined` means "inherits".
    policy: {
      allowedGroups: record?.allowedGroups,
      allowedApps: record?.allowedApps,
      allowedModels: record?.allowedModels,
      allowedPrompts: record?.allowedPrompts,
      scopes: record?.scopes,
      tokenExpirationMinutes: record?.tokenExpirationMinutes
    },
    // What the client actually gets, after layering.
    effective: {
      allowedGroups: effectiveField(record, cimdConfig, 'allowedGroups'),
      allowedApps: effectiveField(record, cimdConfig, 'allowedApps'),
      allowedModels: effectiveField(record, cimdConfig, 'allowedModels'),
      allowedPrompts: effectiveField(record, cimdConfig, 'allowedPrompts'),
      scopes: effectiveField(record, cimdConfig, 'scopes', 'allowedScopes'),
      tokenExpirationMinutes: effectiveField(record, cimdConfig, 'tokenExpirationMinutes')
    }
  };
}

/**
 * Every CIMD client an administrator should see: the ones with a policy record
 * and the ones people are merely connected through.
 *
 * Pending clients sort first — they are the ones waiting on a decision — then
 * blocked ones, then by connection count.
 *
 * @param {Object} platform - Platform configuration
 * @returns {Array<Object>} Admin rows
 */
export function listCimdClientRows(platform = {}) {
  const cimdConfig = getCimdConfig(platform);
  const counts = countByClient();
  const seenByClient = new Map(listSeenCimdClients().map(entry => [entry.clientId, entry]));
  const records = listCimdClientPolicies(clientsFileFor(platform));

  const clientIds = new Set([...records.map(record => record.clientId), ...seenByClient.keys()]);
  const recordsByClient = new Map(records.map(record => [record.clientId, record]));

  const rows = [...clientIds].map(clientId =>
    toRow({
      clientId,
      record: recordsByClient.get(clientId) || null,
      seen: seenByClient.get(clientId) || null,
      cimdConfig,
      connectionCount: counts[clientId] || 0
    })
  );

  const rank = row => (row.approvalState === 'pending' ? 0 : row.blocked ? 1 : 2);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.connectionCount - a.connectionCount ||
      a.clientId.localeCompare(b.clientId)
  );
}

/**
 * One CIMD client's admin row, or null when there is neither a record nor a
 * connection to derive one from.
 *
 * @param {string} clientId - CIMD client identifier
 * @param {Object} platform - Platform configuration
 * @returns {Object|null} The row
 */
export function getCimdClientRow(clientId, platform = {}) {
  const record = findCimdClientPolicy(clientId, clientsFileFor(platform));
  const seen = listSeenCimdClients().find(entry => entry.clientId === clientId) || null;
  if (!record && !seen) return null;

  return toRow({
    clientId,
    record,
    seen,
    cimdConfig: getCimdConfig(platform),
    connectionCount: countByClient()[clientId] || 0
  });
}

/**
 * Write the record that turns a client the server has just met into a real,
 * editable row.
 *
 * Idempotent by design: it does nothing when a record already exists, so the
 * authorize path can call it on every flow without rewriting the store, and a
 * client that was blocked yesterday is not silently un-blocked today.
 *
 * The state it writes is the server's answer to "may this client connect":
 * `auto` when the host allowlist is the whole decision, `pending` (and
 * inactive) when an administrator still has to say yes.
 *
 * @param {Object} params
 * @param {string} params.clientId - CIMD client identifier
 * @param {Object} params.platform - Platform configuration
 * @param {string} [params.clientName] - Display snapshot from the document
 * @param {Object} [params.user] - The user whose flow met the client first
 * @returns {Promise<{created: boolean, approvalState: string}>}
 */
export async function recordCimdDiscovery({ clientId, platform = {}, clientName, user }) {
  const clientsFilePath = clientsFileFor(platform);

  try {
    if (findCimdClientPolicy(clientId, clientsFilePath)) {
      return { created: false, approvalState: '' };
    }

    const approvalMode = getCimdConfig(platform).approvalMode;
    const pending = approvalMode === 'approval';

    await upsertCimdClientPolicy(
      clientId,
      {
        approvalState: pending ? 'pending' : 'auto',
        // A pending client must not be usable while it waits, and `active` is
        // what every request path already checks.
        active: !pending,
        metadata: {
          displayName: clientName || clientIdHost(clientId),
          firstSeenAt: new Date().toISOString(),
          firstUserId: user?.sub || user?.id || '',
          firstUserName: user?.name || user?.username || user?.sub || ''
        }
      },
      clientsFilePath,
      'discovery',
      // A discovery stamp is bookkeeping, not a policy change: announcing it
      // would make every worker re-read the store on a first authorization.
      // A pending one *is* a policy change, and must land everywhere at once.
      { announce: pending }
    );

    logger.info('[OAuth CIMD] Client discovered', {
      component: 'CimdGovernanceService',
      clientId,
      approvalState: pending ? 'pending' : 'auto'
    });

    return { created: true, approvalState: pending ? 'pending' : 'auto' };
  } catch (error) {
    logger.error('[OAuth CIMD] Failed to record client discovery', {
      component: 'CimdGovernanceService',
      clientId,
      error: error.message
    });
    // Bookkeeping must not fail an authorization that policy already allowed.
    return { created: false, approvalState: '' };
  }
}
