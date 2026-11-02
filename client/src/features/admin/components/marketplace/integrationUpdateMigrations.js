// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { changeParts } from '../integrations/migrationState';
import { pickText } from '../integrations/ConfigFieldInput';

/**
 * What a marketplace update of an integration does to the installations of
 * its definition (versioning concept §4), read from the item detail's
 * `migrationPreview` before the update and from the update's
 * `integrationMigrations` after it. Pure; `IntegrationUpdateMigrations.jsx`
 * renders the sentences.
 *
 * @module features/admin/components/marketplace/integrationUpdateMigrations
 */

/** Codes of `POST …/_update` that mean "a migration holds the lock, try again" (409). */
export const UPDATE_RETRY_CODES = Object.freeze([
  'MIGRATION_LOCKED',
  'MIGRATION_LOCK_LOST',
  'MIGRATION_CONFLICT'
]);

/**
 * The kind of one installation row of `migrationPreview.installations`:
 *
 * - `review`: no valid `definitionVersion`; the update does not migrate it;
 * - `notPlanned`: older than the releases the catalog lists, so the plan is
 *   made against the downloaded definition when the update runs;
 * - `fails`: the planned steps collide; the update goes in and the
 *   installation is marked `migrationFailed`, on its old version;
 * - `current`: already at the catalog version;
 * - `changes` / `noChanges`: planned, with or without changes to what it stores.
 *
 * @param {{ from: string|null, planFromCatalog: boolean, ok: boolean, summary: Object|null }} row
 * @returns {'review'|'notPlanned'|'fails'|'current'|'changes'|'noChanges'}
 */
export function previewRowKind(row) {
  if (!row?.from) return 'review';
  if (row.planFromCatalog === false) return 'notPlanned';
  if (row.ok === false) return 'fails';
  if (!row.summary) return 'current';
  return changeParts(row.summary).length > 0 ? 'changes' : 'noChanges';
}

/**
 * The name of an installation in the preview or the report: its stored label
 * in the admin's language, else its id.
 *
 * @param {{ id: string, label?: string|Object|null }} row
 * @param {string} lang
 * @returns {string}
 */
export function installationLabelOf(row, lang) {
  return pickText(row?.label, lang) || row?.id || '';
}

/**
 * The labels of the installations a preview lists, by id, so the report
 * after the update can name them (the update's results carry ids only).
 *
 * @param {Object|null|undefined} preview - `migrationPreview`
 * @param {string} lang
 * @returns {Map<string, string>}
 */
export function previewLabels(preview, lang) {
  const labels = new Map();
  for (const row of preview?.installations || []) {
    labels.set(row.id, installationLabelOf(row, lang));
  }
  return labels;
}

/**
 * Whether the preview as a whole could not be planned from the catalog
 * (no version, or migrations this server cannot read) and has no
 * installation rows that say so themselves.
 *
 * @param {Object|null|undefined} preview
 * @returns {boolean}
 */
export function previewNotPlanned(preview) {
  if (!preview || preview.planFromCatalog !== false) return false;
  return !preview.to || (preview.errors || []).length > 0;
}

/**
 * The reason a failed row of `integrationMigrations` gives: the state's
 * reason, else the log entry's.
 *
 * @param {Object} row - one entry of `integrationMigrations`
 * @returns {string}
 */
export function resultReasonOf(row) {
  return row?.statusReason || row?.logEntry?.reason || row?.reason || '';
}
