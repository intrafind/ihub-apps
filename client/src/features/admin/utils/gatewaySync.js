// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers for the admin "Sync models" dialog (GatewaySyncDialog).
 *
 * `GET /admin/providers/:id/_model-drift` reports how the models of an iFinder
 * Model Gateway or Google differ from the models imported from it: `added`, `changed` and
 * `removed` items. Nothing is changed by that call. The admin's pick goes back
 * to `POST /admin/providers/:id/_sync-models` as `{ kind, remoteId }` pairs; the
 * server applies it (see server/services/gatewaySyncApply.js) and answers one
 * outcome per item. Free of React so these can be unit tested.
 */

import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';

/**
 * Stable key of a drift item or of a pick: the same rule as the server's. `changed` and `removed`
 * are about one iHub model and several can share a remote id (Clone keeps it), so they are keyed
 * by the iHub model; `added` is about a remote model nobody imported, keyed by its remote id.
 */
export function itemKey(item) {
  return `${item.kind}:${item.kind === 'added' ? item.remoteId : item.modelId}`;
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
 * A `contentMarking` as text: the members that mark something, each as `Text: synthid
 * (provider)`. `labels.text` and `labels.image` name the members. Nothing marked is an em dash.
 */
function formatContentMarking(value, labels) {
  const parts = [];
  for (const [kind, label] of [
    ['text', labels.text || 'text'],
    ['image', labels.image || 'image']
  ]) {
    const marking = value?.[kind];
    if (!marking || marking.by === 'none') continue;
    parts.push(
      `${label}: ${marking.scheme || marking.by}${marking.scheme ? ` (${marking.by})` : ''}`
    );
  }
  return parts.length > 0 ? parts.join(', ') : '—';
}

/**
 * A value of a changed field as text for the admin: switches as yes/no (given
 * as `labels`), the EU AI Act marking as its members, an unset value as an em
 * dash, anything else as it is. Numbers stay exact: the admin compares the old
 * and the new value.
 */
export function formatChangeValue(field, value, labels = {}) {
  if (field === 'contentMarking') return formatContentMarking(value, labels);
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'supportsVision') return value ? labels.yes || 'yes' : labels.no || 'no';
  return String(value);
}

/**
 * Send the picked items to the server to apply.
 *
 * Only the kind, the remote id and, for a changed or removed item, the iHub model are sent: the server derives what to
 * do from a fresh look at the gateway, so a pick that no longer matches comes
 * back `skipped`. A request that fails as a whole gives every item `failed`.
 *
 * @param {string} providerId - The gateway provider
 * @param {Array<{ kind: string, remoteId: string, modelId?: string }>} items - Picked drift items
 * @param {typeof makeAdminApiCall} [call] - Injected for tests
 * @returns {Promise<Array<{ key: string, kind: string, status: 'applied'|'skipped'|'failed',
 *   ok: boolean, detail?: string }>>}
 */
export async function applyGatewaySync(providerId, items, call = makeAdminApiCall) {
  if (items.length === 0) return [];
  try {
    const { data } = await call(`/admin/providers/${encodeURIComponent(providerId)}/_sync-models`, {
      method: 'POST',
      body: {
        items: items.map(({ kind, remoteId, modelId }) => ({
          kind,
          remoteId,
          ...(modelId ? { modelId } : {})
        }))
      }
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
