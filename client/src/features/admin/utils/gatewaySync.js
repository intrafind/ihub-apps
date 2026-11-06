// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers for the admin "Sync with gateway" dialog (GatewaySyncDialog).
 *
 * `GET /admin/providers/:id/_model-drift` reports how the models of an iFinder
 * Model Gateway differ from the models imported from it: `added`, `changed` and
 * `removed` items. Nothing is changed by that call. The admin's pick goes back
 * to `POST /admin/providers/:id/_sync-models` as `{ kind, remoteId }` pairs; the
 * server applies it (see server/services/gatewaySyncApply.js) and answers one
 * outcome per item. Free of React so these can be unit tested.
 */

import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';

/** Stable key of a drift item (one per kind and remote model). */
export function itemKey(item) {
  return `${item.kind}:${item.remoteId}`;
}

/**
 * How many items of each kind there are.
 *
 * @param {Array<{ kind: string }>} items
 * @returns {{ added: number, changed: number, removed: number }}
 */
export function countByKind(items) {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const item of items || []) {
    if (item.kind in counts) counts[item.kind]++;
  }
  return counts;
}

/**
 * A value of a changed field as text for the admin: switches as yes/no (given
 * as `labels`), an unset value as an em dash, anything else as it is. Numbers
 * stay exact: the admin compares the old and the new value.
 */
export function formatChangeValue(field, value, labels = {}) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'supportsVision') return value ? labels.yes || 'yes' : labels.no || 'no';
  return String(value);
}

/**
 * Send the picked items to the server to apply.
 *
 * Only the kind and remote id of each item are sent: the server derives what to
 * do from a fresh look at the gateway, so a pick that no longer matches comes
 * back `skipped`. A request that fails as a whole gives every item `failed`.
 *
 * @param {string} providerId - The gateway provider
 * @param {Array<{ kind: string, remoteId: string }>} items - Picked drift items
 * @param {typeof makeAdminApiCall} [call] - Injected for tests
 * @returns {Promise<Array<{ key: string, kind: string, status: 'applied'|'skipped'|'failed',
 *   ok: boolean, detail?: string }>>}
 */
export async function applyGatewaySync(providerId, items, call = makeAdminApiCall) {
  if (items.length === 0) return [];
  try {
    const { data } = await call(`/admin/providers/${encodeURIComponent(providerId)}/_sync-models`, {
      method: 'POST',
      body: { items: items.map(({ kind, remoteId }) => ({ kind, remoteId })) }
    });
    return (Array.isArray(data?.items) ? data.items : []).map(result => ({
      key: itemKey(result),
      kind: result.kind,
      status: result.status,
      ok: result.status === 'applied',
      detail: result.detail
    }));
  } catch (error) {
    const detail = getAdminApiErrorMessage(error);
    return items.map(item => ({
      key: itemKey(item),
      kind: item.kind,
      status: 'failed',
      ok: false,
      detail
    }));
  }
}
