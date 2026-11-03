// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat's integrations picker state (#2923), on top of the server's rows
 * (`GET /api/integrations/picker`). Nothing here reads a tool id to decide
 * what a row is: a row says which references switch it on (`refs`) and which
 * other references keep it on (`coveredBy`, an app binding such as
 * `type:storage` that covers several installations).
 */

/** The references a row answers to. */
function referencesOf(row) {
  return [...(row?.refs || []), ...(row?.coveredBy || [])];
}

/**
 * Whether a row is on in a chat.
 *
 * @param {Object} row
 * @param {string[]|null} enabledTools - The chat's references
 * @returns {boolean}
 */
export function isRowOn(row, enabledTools) {
  if (!Array.isArray(enabledTools)) return false;
  return referencesOf(row).some(ref => enabledTools.includes(ref));
}

/**
 * The chat's references with one row switched on or off. Switching off a row
 * that a shared binding keeps on replaces the binding by the rows it still
 * covers, so the others stay as they were.
 *
 * @param {Object[]} rows - All rows of the app
 * @param {string[]} enabledTools
 * @param {string} rowId
 * @param {boolean} on
 * @returns {string[]}
 */
export function setRowOn(rows, enabledTools, rowId, on) {
  const current = Array.isArray(enabledTools) ? enabledTools : [];
  const row = (rows || []).find(candidate => candidate.id === rowId);
  if (!row) return current;
  if (on) {
    if (isRowOn(row, current)) return current;
    return [...current, ...(row.refs || []).filter(ref => !current.includes(ref))];
  }
  const dropped = new Set(referencesOf(row));
  const next = current.filter(ref => !dropped.has(ref));
  // The other rows a dropped binding kept on stay on by their own reference.
  for (const other of rows || []) {
    if (other.id === row.id) continue;
    const keptByDropped = (other.coveredBy || []).some(
      ref => dropped.has(ref) && current.includes(ref)
    );
    if (keptByDropped && !isRowOn(other, next)) {
      next.push(...(other.refs || []).filter(ref => !next.includes(ref)));
    }
  }
  return next;
}

/**
 * Whether a row needs the user to connect before it can be used.
 *
 * @param {Object} row
 * @returns {boolean}
 */
export function needsConnect(row) {
  const status = row?.connection?.status;
  return (
    row?.connection?.mode === 'personal' &&
    (status === 'not_connected' || status === 'needs_reconnect')
  );
}

/**
 * The dot a row's connection shows: `ok`, `warn` (connect first), `error`
 * (an admin has to act) or null when there is nothing to say.
 *
 * @param {Object} row
 * @returns {'ok'|'warn'|'error'|null}
 */
export function connectionDotOf(row) {
  const connection = row?.connection;
  if (!connection) return null;
  if (connection.status === 'unavailable') return 'error';
  if (needsConnect(row)) return 'warn';
  return 'ok';
}

/**
 * The effect summary of a row: "read · write".
 *
 * @param {string[]} effects
 * @param {(key: string, fallback: string) => string} t
 * @returns {string}
 */
export function effectSummary(effects, t) {
  const labels = {
    read: t('integrationPicker.effect.read', 'read'),
    write: t('integrationPicker.effect.write', 'write'),
    destructive: t('integrationPicker.effect.destructive', 'delete')
  };
  return (effects || [])
    .filter(effect => labels[effect])
    .map(effect => labels[effect])
    .join(' · ');
}

/**
 * Whether a row matches a search (name, description, kind).
 *
 * @param {{name?: string, description?: string}} item
 * @param {string} query
 * @returns {boolean}
 */
export function matchesQuery(item, query) {
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  if (!needle) return true;
  return [item?.name, item?.description]
    .filter(value => typeof value === 'string')
    .some(value => value.toLowerCase().includes(needle));
}

/**
 * The scope map a chat stores from the scope entries the picker shows.
 *
 * @param {Array<{id: string, current?: string, scopePicker?: string}>} scopeIntegrations
 * @returns {Object<string, string>}
 */
export function scopeMapOf(scopeIntegrations) {
  const out = {};
  for (const integration of Array.isArray(scopeIntegrations) ? scopeIntegrations : []) {
    if (integration?.scopePicker !== 'hidden' && integration?.current) {
      out[integration.id] = integration.current;
    }
  }
  return out;
}
