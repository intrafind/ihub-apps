// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The EU AI Act master switch (step 9 of epic #3324).
 *
 * One audited switch turns every Art. 50 feature of iHub off: the guardrail
 * rule, the first-turn notice, the acknowledgement requirement, provenance
 * records and response metadata, text watermarking, image marking and
 * verification. Behaviour is off, data is kept (acknowledgements, records,
 * watermark keys). The legal duty stays with the deployer; this switch only
 * records who decided to stop applying the measures, when and why.
 *
 * The API and the record say `conformity`; the admin UI says "EU AI Act
 * features" because iHub cannot confer conformity.
 *
 * The state lives in its own file, `config/eu-ai-act-conformity.json`, not in
 * platform.json: the generic admin save rewrites platform.json from client
 * copies and applies `IHUB_*` overrides, neither of which may flip the switch or
 * erase the record. This module is the ONLY reader and writer of that file
 * (a test fails otherwise).
 *
 * @module services/euAiAct/conformity
 */
import configCache from '../../configCache.js';
import configStore from '../config/ConfigStore.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import {
  euAiActConformitySchema,
  MAX_HISTORY,
  STATEMENT_VERSION
} from '../../validators/euAiActConformitySchema.js';

export const CONFORMITY_FILE = 'config/eu-ai-act-conformity.json';

let warnedInvalid = false;

/**
 * Reads and checks the record. Anything that is not a well-formed document is
 * invalid. A hand-edited file that says "off" without a complete record (who,
 * when, why) must not switch anything off, so it is reported as invalid and
 * treated as on.
 *
 * @returns {{ raw: Object|null, valid: boolean }}
 */
function readRecord() {
  let raw = null;
  try {
    raw = configCache.getEuAiActConformity();
  } catch {
    // The cache is not initialised yet (startup, tests): nothing was switched off.
    return { raw: null, valid: true };
  }
  const parsed = euAiActConformitySchema.safeParse(raw);
  if (!parsed.success) return { raw, valid: false };
  const doc = parsed.data;
  if (doc.enabled === false) {
    const complete = Boolean(doc.changedAt && doc.changedBy?.id && doc.reason?.trim());
    if (!complete) return { raw, valid: false };
  }
  return { raw: doc, valid: true };
}

/**
 * Whether the EU AI Act features are on. Synchronous and never throws.
 *
 * It answers `false` only for a complete "off" record. A missing, unreadable,
 * malformed or incomplete record answers `true` (fails towards compliance) and
 * is logged once at `warn`.
 *
 * @returns {boolean}
 */
export function isEuAiActEnabled() {
  try {
    const { raw, valid } = readRecord();
    if (!valid) {
      if (!warnedInvalid) {
        warnedInvalid = true;
        logger.warn('EU AI Act switch record is invalid; the features stay on', {
          component: 'EuAiActConformity'
        });
      }
      return true;
    }
    return raw?.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * The record for the admin API and the status page.
 *
 * @returns {{ enabled: boolean, valid: boolean, changedAt: string|null,
 *   changedBy: {id: string, name: string}|null, reason: string|null,
 *   statementVersion: number|null, history: Object[] }}
 */
export function getConformity() {
  const { raw, valid } = readRecord();
  const enabled = isEuAiActEnabled();
  const source = valid && raw ? raw : {};
  return {
    enabled,
    valid,
    changedAt: source.changedAt ?? null,
    changedBy: source.changedBy ?? null,
    reason: source.reason ?? null,
    statementVersion: source.statementVersion ?? null,
    history: Array.isArray(source.history) ? source.history : []
  };
}

/**
 * Switch the features off or on. The change is applied under the store's
 * compare-and-set, so two admins clicking at once produce exactly one record and
 * one `409 CONFLICT` for the other.
 *
 * @param {Object} change
 * @param {boolean} change.enabled - the target state
 * @param {string} [change.reason] - why (mandatory for off, checked by the route)
 * @param {{id: string, name: string}} change.actor - who, from the session, never the body
 * @param {number} [change.statementVersion]
 * @returns {Promise<{ previous: boolean, current: ReturnType<typeof getConformity> }>}
 */
export async function setConformity({
  enabled,
  reason,
  actor,
  statementVersion = STATEMENT_VERSION
}) {
  let previous = true;
  await configStore.updateJson(CONFORMITY_FILE, current => {
    const parsed = euAiActConformitySchema.safeParse(current);
    const doc = parsed.success ? parsed.data : { version: 1, enabled: true, history: [] };
    // Judge the state as isEuAiActEnabled() does: an incomplete "off" is on.
    const effective =
      doc.enabled === false && doc.changedAt && doc.changedBy?.id && doc.reason?.trim()
        ? false
        : true;
    previous = effective;
    if (effective === enabled) {
      throw new ServiceError(
        'CONFLICT',
        `The EU AI Act features are already switched ${enabled ? 'on' : 'off'}`,
        {
          details: {
            enabled: effective,
            changedAt: doc.changedAt ?? null,
            changedBy: doc.changedBy ?? null
          }
        }
      );
    }
    const changedAt = new Date().toISOString();
    const note = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    const entry = {
      enabled,
      changedAt,
      changedBy: actor,
      reason: note,
      statementVersion: enabled ? null : statementVersion
    };
    return {
      version: 1,
      enabled,
      changedAt,
      changedBy: actor,
      reason: note,
      statementVersion: entry.statementVersion,
      history: [entry, ...(doc.history || [])].slice(0, MAX_HISTORY)
    };
  });
  warnedInvalid = false;
  // Also announces the change to the other workers and waits for them.
  await configCache.refreshCacheEntry(CONFORMITY_FILE);
  return { previous, current: getConformity() };
}

/**
 * Express middleware for the explicit actions that cannot do anything while the
 * features are off (`_verify`, the detector actions). Runtime paths never use it:
 * they skip silently.
 *
 * @param {string} feature - named in `details.feature`
 */
export function requireEuAiActEnabled(feature) {
  return (req, res, next) => {
    if (isEuAiActEnabled()) return next();
    return next(
      new ServiceError(
        'FEATURE_DISABLED',
        'The EU AI Act features are switched off on this server',
        {
          details: { feature }
        }
      )
    );
  };
}
