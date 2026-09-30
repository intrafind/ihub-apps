/**
 * Installation-specific records made by admins: stamping, the unmarked-model
 * gate, and the import/export rules (records never travel between
 * installations; concept §8.2, §8.6).
 *
 * @module services/provenance/records
 */
import { isTextMarked, stripInstallationRecords } from '../../../shared/aiTransparency.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { isAiTransparencyActive } from './config.js';
import { actorOf, getInstallationInfo } from './installation.js';
import { validAcknowledgement } from './markingPolicy.js';
import { logAudit } from '../AuditLogService.js';

/** Minimum length of a justification. */
export const MIN_REASON_LENGTH = 10;

/** The request body field that carries an unmarked-model justification. */
export const JUSTIFICATION_FIELD = 'aiTransparencyJustification';

/**
 * Who/when/where for a record, from the request.
 * @param {import('express').Request} req
 */
export function stampOf(req) {
  const actor = actorOf(req);
  const info = getInstallationInfo(req);
  return {
    by: actor.id,
    byName: actor.name,
    at: new Date().toISOString(),
    installationUrl: info.installationUrl,
    installationId: info.installationId,
    ihubVersion: getAppVersion()
  };
}

/**
 * The acknowledgement record for enabling a model that does not mark text.
 * @param {import('express').Request} req
 * @param {string} justification
 */
export function buildAcknowledgement(req, justification) {
  const stamp = stampOf(req);
  return {
    acknowledgedBy: stamp.by,
    acknowledgedByName: stamp.byName,
    acknowledgedAt: stamp.at,
    justification: String(justification).trim(),
    installationUrl: stamp.installationUrl,
    installationId: stamp.installationId,
    ihubVersion: stamp.ihubVersion
  };
}

export class UnmarkedModelError extends Error {
  constructor(models) {
    super(
      `Enabling ${models.length === 1 ? `model "${models[0]}"` : `${models.length} models`} that do not mark ` +
        'generated text requires a justification. The model stays listed as non-conforming.'
    );
    this.name = 'UnmarkedModelError';
    this.status = 409;
    this.code = 'UNMARKED_MODEL_ACKNOWLEDGEMENT_REQUIRED';
    this.models = models;
  }
}

/**
 * Gate for switching models on (issue #2565): a model without text marking
 * can only be enabled with an acknowledgement. An existing acknowledgement
 * made on this installation counts; otherwise the justification from the
 * request body is turned into one. Mutates `models` (adds the record).
 *
 * @param {Object[]} models - models that are about to be enabled
 * @param {import('express').Request} req
 * @param {string} [justification]
 * @throws {UnmarkedModelError} when a justification is missing
 * @returns {string[]} ids of models that got a new acknowledgement
 */
export function applyUnmarkedModelGate(models, req, justification) {
  if (!isAiTransparencyActive()) return [];
  const needing = models.filter(
    m => m && m.modelType !== 'transcription' && !isTextMarked(m) && !validAcknowledgement(m)
  );
  if (needing.length === 0) return [];
  const reason = typeof justification === 'string' ? justification.trim() : '';
  if (reason.length < MIN_REASON_LENGTH) throw new UnmarkedModelError(needing.map(m => m.id));
  for (const model of needing) {
    model.contentMarking = {
      ...(model.contentMarking || { textWatermark: 'none' }),
      acknowledgement: buildAcknowledgement(req, reason)
    };
  }
  return needing.map(m => m.id);
}

/**
 * Audit the acknowledgements `applyUnmarkedModelGate` created, with their
 * justification, once the models are saved (the generic model audit entry
 * does not carry the reason).
 * @param {import('express').Request} req
 * @param {Object[]} models - the models passed to the gate
 * @param {string[]} ids - what the gate returned
 */
export function auditNewAcknowledgements(req, models, ids) {
  for (const id of ids || []) {
    const acknowledgement = models.find(m => m?.id === id)?.contentMarking?.acknowledgement;
    if (!acknowledgement) continue;
    logAudit({
      req,
      action: 'update',
      resource: 'model',
      resourceId: id,
      summary: `Acknowledged unmarked model output: ${acknowledgement.justification}`
    });
  }
}

/**
 * Keep the stored records of an app or model on save; the client can never
 * set or change them through the generic editor (only the dedicated,
 * audited endpoints do).
 *
 * @param {'app'|'model'} kind
 * @param {Object} incoming - the body being saved (mutated)
 * @param {Object|null} stored - the document on disk
 */
export function preserveStoredRecords(kind, incoming, stored) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (kind === 'app') {
    const keep = {
      disclosureOptOut: stored?.aiTransparency?.disclosureOptOut,
      exemption: stored?.aiTransparency?.exemption
    };
    const block = { ...(incoming.aiTransparency || {}) };
    delete block.disclosureOptOut;
    delete block.exemption;
    for (const [key, value] of Object.entries(keep)) if (value) block[key] = value;
    if (Object.keys(block).length) incoming.aiTransparency = block;
    else delete incoming.aiTransparency;
  } else if (kind === 'model') {
    const ack = stored?.contentMarking?.acknowledgement;
    if (incoming.contentMarking && typeof incoming.contentMarking === 'object') {
      const block = { ...incoming.contentMarking };
      delete block.acknowledgement;
      if (ack) block.acknowledgement = ack;
      incoming.contentMarking = block;
    } else if (ack) {
      incoming.contentMarking = { ...(stored.contentMarking || {}), acknowledgement: ack };
    }
  }
  return incoming;
}

/**
 * Drop records from content arriving from elsewhere (upload, marketplace).
 * @param {'app'|'model'|'platform'} kind
 * @param {Object} incoming
 */
export function dropIncomingRecords(kind, incoming) {
  return stripInstallationRecords(kind, incoming);
}
