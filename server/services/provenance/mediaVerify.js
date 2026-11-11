// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The file branch of `POST /api/eu-ai-act/provenance/_verify` (#3328): an uploaded image
 * or audio file is looked up by its hash and its C2PA manifest is read.
 *
 * The upload is parsed into memory only (`multer.memoryStorage`), never
 * written to disk, never logged, and dropped when the response is sent (CoP
 * 2.1.3, zero retention). The file type comes from the bytes, not from the
 * client.
 *
 * Wording rules (README decision 8): a result says "found" / "not found" and
 * what a mark claims; trust is never evaluated, and an absent record or mark is
 * not proof of origin. SynthID is "declared, not detectable".
 *
 * @module services/provenance/mediaVerify
 */
import multer from 'multer';
import { ServiceError } from '../../utils/ServiceError.js';
import { getProvenanceStore } from './ProvenanceStore.js';
import { provenanceSettings } from './provenanceSettings.js';
import { readC2pa } from './c2paReader.js';
import { hashBytes } from './mediaMarking.js';
import { sniffMedia } from './mediaSniff.js';
import { NORMALIZATION_NONE } from './records.js';

/** Types the file branch accepts, named in the 415 detail. */
export const ACCEPTED_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/avif',
  'audio/wav',
  'audio/mpeg',
  'audio/flac',
  'audio/ogg',
  'audio/mp4'
]);

/**
 * Whether the request is a multipart upload.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isMultipart(req) {
  return Boolean(req.is?.('multipart/form-data'));
}

/**
 * Whether the request body is JSON (the text/hash lookup).
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isJsonRequest(req) {
  return Boolean(req.is?.('application/json')) || !req.headers?.['content-type'];
}

/**
 * Parse one `file` field (and an optional `kind` field) into memory.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} maxBytes
 * @returns {Promise<{buffer: Buffer, kind?: string}>}
 * @throws {ServiceError} `PAYLOAD_TOO_LARGE` (413), `BAD_REQUEST` (400).
 */
export function parseMediaUpload(req, res, maxBytes) {
  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: maxBytes, files: 1, fields: 10 }
  }).single('file');
  return new Promise((resolve, reject) => {
    upload(req, res, error => {
      if (error) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return reject(
            new ServiceError('PAYLOAD_TOO_LARGE', 'The file is too large', {
              details: { maxBytes }
            })
          );
        }
        if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
          return reject(
            new ServiceError('BAD_REQUEST', 'Send exactly one file in the "file" field')
          );
        }
        return reject(new ServiceError('BAD_REQUEST', 'The upload could not be read'));
      }
      if (!req.file?.buffer?.length) {
        return reject(
          new ServiceError('VALIDATION_FAILED', 'Send an image or audio file in the "file" field', {
            details: [{ pointer: '/file', message: 'file is required' }]
          })
        );
      }
      const kind = req.body?.kind;
      if (kind !== undefined && kind !== 'image' && kind !== 'audio') {
        return reject(
          new ServiceError('VALIDATION_FAILED', 'kind must be image or audio', {
            details: [{ pointer: '/kind', message: 'kind must be image or audio' }]
          })
        );
      }
      return resolve({ buffer: req.file.buffer, kind });
    });
  });
}

/**
 * Verify an uploaded media file.
 *
 * (1) SHA-256 of the whole file → record lookup; (2) the C2PA read. A miss in
 * (1) still returns (2). Only generated images have records; an audio file gets
 * its C2PA read and never a hash hit.
 *
 * @param {Buffer} buffer
 * @param {Object} [options]
 * @param {string} [options.kind] - Declared kind; must match the bytes.
 * @returns {Promise<Object>}
 * @throws {ServiceError} `UNSUPPORTED_MEDIA_TYPE` (415) for an unknown type or SVG.
 */
export async function verifyMediaFile(buffer, { kind } = {}) {
  const sniffed = sniffMedia(buffer);
  if (!sniffed) {
    throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', 'This file type is not accepted', {
      details: { accepted: ACCEPTED_MEDIA_TYPES }
    });
  }
  if (kind && kind !== sniffed.kind) {
    throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', `The file is not ${kind}`, {
      details: { accepted: ACCEPTED_MEDIA_TYPES, detected: sniffed.kind }
    });
  }
  const settings = provenanceSettings();
  const store = getProvenanceStore();
  const value = hashBytes(buffer);
  const technique = [];

  const byOutput = new Map();
  for (const record of await store.findByHash(value)) byOutput.set(record.output_id, record);
  const records = [...byOutput.values()];
  if (records.length > 0) technique.push('hash-lookup');

  const c2pa = settings.media.readC2pa
    ? await readC2pa(buffer, { mimeType: sniffed.mimeType })
    : null;
  if (c2pa?.present || c2pa?.xmpDigitalSourceType) technique.push('metadata');

  const declared = records.find(record => record.provider_marking?.declared)?.provider_marking
    ?.declared;
  const caveats = ['trust-not-evaluated'];
  if (records.length === 0) caveats.push('absence-is-not-proof');
  const body = {
    found: records.length > 0,
    kind: sniffed.kind,
    normalization: NORMALIZATION_NONE,
    contentHash: {
      alg: 'sha-256',
      value,
      bytes: buffer.length,
      mimeType: sniffed.mimeType
    },
    c2pa: c2pa
      ? {
          present: c2pa.present,
          status: c2pa.status,
          valid: c2pa.valid,
          issuer: c2pa.issuer,
          digitalSourceType: c2pa.digitalSourceType,
          claimGenerator: c2pa.claimGenerator,
          signedAt: c2pa.signedAt,
          trust: c2pa.trust,
          xmpDigitalSourceType: c2pa.xmpDigitalSourceType ?? null
        }
      : null,
    declared: declared ?? null,
    technique,
    // SynthID has no public detector: only "declared" can be said, never "no SynthID".
    synthid: records.some(r => r.provider_marking?.declared === 'synthid')
      ? 'declared-not-detectable'
      : 'not-detectable',
    caveats
  };
  if (records.length > 0) body.records = records;
  return body;
}
