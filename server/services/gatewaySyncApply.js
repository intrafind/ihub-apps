// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Applying the picked items of a gateway sync (see `gatewayDrift.js`).
 *
 * The server applies the pick, not the client, for two reasons. The items are
 * re-derived from a fresh listing, so a client can only choose among what the
 * gateway reports now and never supplies a model config of its own. And every
 * model is read from and written to its stored file: the model endpoints a
 * client would chain read the config cache, which still shows the old value for
 * a moment after a write, so an update followed by a disable could write the
 * stale copy back.
 *
 * Each item has its own outcome and a failure does not stop the others:
 *   - `added`:   the model config built by the drift is created, unless an
 *                iHub model with that id exists by now.
 *   - `changed`: the changed fields are set on the stored model.
 *   - `removed`: the stored model is disabled and loses its default flag, never
 *                deleted: apps may still use it. If it was the default model, the
 *                config loader picks another one the next time it loads.
 *
 * @module server/services/gatewaySyncApply
 */

/** The order items are applied in. The result is the same in any order. */
const APPLY_ORDER = ['added', 'changed', 'removed'];

/** Stable key of a drift item (one per kind and remote model). */
export function itemKey(item) {
  return `${item.kind}:${item.remoteId}`;
}

/** The fields to set on a model for a `changed` item: `{ field: to }`. */
export function patchOf(changes) {
  return Object.fromEntries((changes || []).map(change => [change.field, change.to]));
}

/**
 * @typedef {Object} ModelStore
 * @property {(id: string) => Promise<Object|null>} read - The stored model, or null
 * @property {(id: string, model: Object) => Promise<void>} write - Store a model
 * @property {(action: 'create'|'update', id: string, summary: string) => Promise<void>} audit
 * @property {(id: string, before: Object, after: Object) => Promise<void>} snapshot - Keep the change history of an update
 */

/**
 * Apply the picked items.
 *
 * @param {Object} params
 * @param {Array<{ kind: string, remoteId: string }>} params.picks - What the admin chose
 * @param {Array<Object>} params.items - The drift as it is now (`computeGatewayDrift`)
 * @param {ModelStore} params.store
 * @returns {Promise<Array<{ kind: string, remoteId: string, modelId?: string,
 *   status: 'applied'|'skipped'|'failed', detail?: string }>>}
 *   `skipped`: the pick no longer matches the gateway (it changed again since the
 *   admin looked), nothing was done for it. `failed`: the write did not work.
 */
export async function applyGatewayDrift({ picks, items, store }) {
  const byKey = new Map(items.map(item => [itemKey(item), item]));
  // Each pick once, in apply order.
  const seen = new Set();
  const ordered = picks
    .filter(pick => {
      const key = itemKey(pick);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind));

  const results = [];
  for (const pick of ordered) {
    const base = { kind: pick.kind, remoteId: pick.remoteId };
    const item = byKey.get(itemKey(pick));
    if (!item) {
      results.push({ ...base, status: 'skipped', detail: 'changedSinceReview' });
      continue;
    }
    try {
      results.push({ ...base, ...(await applyItem(item, store)), status: 'applied' });
    } catch (error) {
      const modelId = item.kind === 'added' ? item.model.id : item.modelId;
      results.push({ ...base, modelId, status: 'failed', detail: error.message });
    }
  }
  return results;
}

/** Apply one item; throws when the write cannot be done. Returns `{ modelId }`. */
async function applyItem(item, store) {
  if (item.kind === 'added') {
    const { model } = item;
    if ((await store.read(model.id)) !== null) {
      throw new Error(`A model with the id ${model.id} already exists`);
    }
    await store.write(model.id, model);
    await store.audit('create', model.id, `Created model ${model.id} from a gateway sync`);
    return { modelId: model.id };
  }

  const before = await store.read(item.modelId);
  if (before === null) throw new Error(`Model ${item.modelId} not found`);
  const after =
    item.kind === 'changed'
      ? { ...before, ...patchOf(item.changes) }
      : { ...before, enabled: false, default: false };
  await store.write(item.modelId, after);
  await store.snapshot(item.modelId, before, after);
  await store.audit(
    'update',
    item.modelId,
    item.kind === 'changed'
      ? `Updated model ${item.modelId} from a gateway sync`
      : `Disabled model ${item.modelId}: the gateway no longer offers it`
  );
  return { modelId: item.modelId };
}
