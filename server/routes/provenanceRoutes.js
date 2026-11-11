// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Provenance lookup (EU AI Act Art. 50(2), #3327).
 *
 * `POST /api/provenance/_verify` takes a text or a content hash and answers
 * whether this installation produced that exact output, and with which model
 * and version. A miss is a valid answer (200, `found: false`): it never says
 * the text is "not AI" or "human-written", only that no record exists.
 *
 * Privacy: the endpoint is a membership oracle for a candidate text, so it is
 * authenticated by default (`provenance.verify.access: "public"` opens it),
 * rate limited, capped in size, excluded from the audit log, and the request
 * body is never logged.
 */
import configCache from '../configCache.js';
import { authenticatedOnly } from '../middleware/authRequired.js';
import { createProvenanceVerifyLimiter } from '../middleware/rateLimiting.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import { isStorageReady } from '../storage/bootstrap.js';
import { getProvenanceStore } from '../services/provenance/ProvenanceStore.js';
import { provenanceSettings } from '../services/provenance/provenanceSettings.js';
import { verifyUrl } from '../services/provenance/turnProvenance.js';
import {
  NORMALIZATION_NFC_TRIM,
  TEXT_NORMALIZATIONS,
  hashText,
  isHexHash
} from '../services/provenance/records.js';

const VERIFY_PATH = '/api/provenance/_verify';

/** Largest text accepted, in bytes. */
export const MAX_VERIFY_TEXT_BYTES = 256 * 1024;

function invalid(pointer, message) {
  return new ServiceError('VALIDATION_FAILED', message, { details: [{ pointer, message }] });
}

/**
 * Validate the body: `{ text }` xor `{ contentHash }`, optional `normalization`.
 * Exported for the tests.
 */
export function parseVerifyBody(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hasText = input.text !== undefined;
  const hasHash = input.contentHash !== undefined;
  if (hasText === hasHash) {
    throw invalid(
      hasText ? '/contentHash' : '/text',
      hasText ? 'Send either text or contentHash, not both' : 'Send text or contentHash'
    );
  }
  const normalization = input.normalization ?? NORMALIZATION_NFC_TRIM;
  if (!TEXT_NORMALIZATIONS.includes(normalization)) {
    throw invalid(
      '/normalization',
      `normalization must be one of: ${TEXT_NORMALIZATIONS.join(', ')}`
    );
  }
  if (hasText) {
    if (typeof input.text !== 'string') throw invalid('/text', 'text must be a string');
    if (Buffer.byteLength(input.text, 'utf8') > MAX_VERIFY_TEXT_BYTES) {
      throw new ServiceError('PAYLOAD_TOO_LARGE', 'text is too large', {
        details: { maxBytes: MAX_VERIFY_TEXT_BYTES }
      });
    }
    return { text: input.text, normalization };
  }
  const hash = typeof input.contentHash === 'string' ? input.contentHash.trim().toLowerCase() : '';
  if (!isHexHash(hash))
    throw invalid('/contentHash', 'contentHash must be 64 hexadecimal characters');
  return { hash, normalization };
}

export default function registerProvenanceRoutes(app) {
  const limiter = createProvenanceVerifyLimiter(configCache.getPlatform() || {});
  // Read per request, so an admin switching to `public` needs no restart.
  // `authenticatedOnly`, not `authRequired`: the latter lets everyone through while
  // anonymous access is on, which is the shipped default, and this lookup must stay
  // closed to guests unless an admin opens it with `verify.access: public`.
  const maybeAuth = (req, res, next) =>
    provenanceSettings().verify.access === 'public' ? next() : authenticatedOnly(req, res, next);

  /**
   * @swagger
   * /api/provenance/_verify:
   *   post:
   *     summary: Look up an AI output by its text or content hash
   *     description: >-
   *       Answers whether this installation produced exactly this output. A miss means only
   *       that no record exists; it is not proof of human authorship. The text is hashed with
   *       the `nfc-trim` normalization (Unicode NFC, line endings to LF, trimmed, UTF-8,
   *       SHA-256) and never stored or logged.
   *     tags: [Provenance]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               text: { type: string, maxLength: 262144 }
   *               contentHash: { type: string, description: 64 hex characters }
   *               normalization: { type: string, enum: [nfc-trim], default: nfc-trim }
   *     responses:
   *       200:
   *         description: >-
   *           `{ found, normalization, records? }`. Records are provenance objects
   *           (`intrafind-provenance/1.0`).
   *       400: { description: Both or neither of text and contentHash }
   *       401: { description: Authentication required (unless verify.access is public) }
   *       413: { description: Text too large }
   *       429: { description: Rate limited }
   *       503: { description: Storage not ready }
   */
  app.post(buildServerPath(VERIFY_PATH), limiter, maybeAuth, async (req, res, next) => {
    try {
      const { text, hash, normalization } = parseVerifyBody(req.body);
      if (!isStorageReady() || !getProvenanceStore().isAvailable()) {
        throw new ServiceError('SERVICE_UNAVAILABLE', 'The provenance store is not available');
      }
      const value = hash ?? hashText(text, normalization);
      const records = await getProvenanceStore().findByHash(value);
      // Sensitive request: never cache.
      res.setHeader('Cache-Control', 'no-store');
      if (records.length === 0) return res.json({ found: false, normalization });
      const verify = verifyUrl(req);
      return res.json({
        found: true,
        normalization,
        records: records.map(record => ({ ...record, verify }))
      });
    } catch (error) {
      return next(error);
    }
  });
}
