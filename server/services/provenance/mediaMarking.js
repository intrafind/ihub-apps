// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Provenance records for generated images (#3328, EU AI Act Art. 50(2)).
 *
 * iHub applies no image or audio mark of its own. The providers do (Gemini:
 * SynthID in the signal; OpenAI gpt-image and some Google models: a C2PA
 * manifest). What we owe is (a) not to destroy it — no decode or encode between
 * the provider response and the final response, ever; (b) to record what the
 * provider claims; (c) to answer "did this file come from this installation,
 * and what marks does it carry?".
 *
 * **Invariant: bytes in = bytes out.** Nothing in this module (or anywhere on
 * the generated-media path) may decode and re-encode an image or audio file.
 * The hash is over the raw bytes the provider sent (the base64 decoded, never
 * the base64 text), and a test guards the server sources against image
 * libraries.
 *
 * A record never holds bytes. `provider_marking.declared` is what the operator
 * states the provider embeds (`contentMarking.<kind>`), never something we
 * detect: SynthID has no public detector.
 *
 * @module services/provenance/mediaMarking
 */
import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { isEuAiActEnabled } from '../euAiAct/conformity.js';
import { getProvenanceStore } from './ProvenanceStore.js';
import { provenanceSettings } from './provenanceSettings.js';
import { readC2pa } from './c2paReader.js';
import { sniffMedia } from './mediaSniff.js';
import { recordedUser } from './provenanceUser.js';
import {
  HASH_ALG,
  NORMALIZATION_NONE,
  PROVENANCE_SPEC,
  buildProvenance,
  buildWatermark,
  getContentMarking,
  newOutputId
} from './records.js';

const COMPONENT = 'MediaMarking';

/** SHA-256 (lowercase hex) of a buffer. */
export function hashBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * What the operator declares the provider embeds in this kind of output:
 * `contentMarking.<kind>.scheme` when `by` is `provider`, else null.
 *
 * @param {Object} [modelConfig]
 * @param {'image'|'audio'} kind
 * @returns {string|null}
 */
export function declaredMarking(modelConfig, kind) {
  const marking = getContentMarking(modelConfig, kind);
  return marking.by === 'provider' ? marking.scheme || 'provider' : null;
}

/**
 * The `provider_marking` member of a media record.
 *
 * @param {Object|null} c2pa - A {@link readC2pa} result (null: not read).
 * @param {Object} [modelConfig]
 * @param {'image'|'audio'} kind
 * @returns {{c2pa: Object, xmp: {digitalSourceType: string|null}, declared: string|null}}
 */
export function buildProviderMarking(c2pa, modelConfig, kind) {
  const read = c2pa || {
    present: false,
    status: 'unreadable',
    valid: null,
    issuer: null,
    digitalSourceType: null,
    claimGenerator: null,
    signedAt: null,
    trust: 'not-evaluated'
  };
  return {
    c2pa: {
      present: read.present,
      status: read.status,
      valid: read.valid,
      issuer: read.issuer,
      digitalSourceType: read.digitalSourceType,
      claimGenerator: read.claimGenerator,
      signedAt: read.signedAt,
      trust: read.trust
    },
    xmp: { digitalSourceType: read.xmpDigitalSourceType ?? null },
    declared: declaredMarking(modelConfig, kind)
  };
}

/**
 * Stamp a generated image with its output id, content hash, time and model,
 * synchronously. Idempotent: an image that already carries `provenance` keeps
 * it, so an image object seen twice (a chunk re-pushed, a snapshot copied)
 * never mints a second output. Never touches `data`.
 *
 * The stamp is internal (camelCase); {@link publicImageProvenance} turns it into
 * the provenance object a client or caller sees, and the stored record uses the
 * same output id and time.
 *
 * @param {{data: string, mimeType?: string, provenance?: Object}} image
 * @param {Object} [options]
 * @param {Object} [options.model] - Model config (`id`, `contentMarking`).
 * @returns {{outputId: string, contentHash: string, createdAt: string, created: boolean}|null}
 *   Null for an image without data.
 */
export function stampGeneratedImage(image, { model } = {}) {
  // EU AI Act master switch off: no stamp, hence no record (the image bytes are
  // untouched in both states).
  if (!isEuAiActEnabled()) return null;
  if (!image || typeof image.data !== 'string' || image.data.length === 0) return null;
  if (image.provenance?.outputId && image.provenance?.contentHash) {
    return { ...image.provenance, created: false };
  }
  const outputId = newOutputId();
  // The decoded bytes, not the base64 text: the same bytes the artifact store
  // keeps and a downloaded file contains.
  const contentHash = hashBytes(Buffer.from(image.data, 'base64'));
  const createdAt = new Date().toISOString();
  image.provenance = { outputId, contentHash, createdAt };
  if (model) {
    image.provenance.modelId = model.id ?? null;
    // What the operator declares the provider embeds (never detected here).
    image.provenance.watermark = buildWatermark(model, { kind: 'image' });
  }
  return { ...image.provenance, created: true };
}

/**
 * The provenance object of a generated image as a client sees it (chat stream,
 * stored message): the spec-shaped object of a text answer, with `kind: image`
 * and the hash of the raw bytes. The installation and the provider's C2PA
 * manifest are in the stored record (read after the image was sent), not here.
 *
 * @param {Object} [stamp] - `image.provenance` from {@link stampGeneratedImage}.
 * @returns {Object|null} Null for an image without a stamp.
 */
export function publicImageProvenance(stamp) {
  if (!stamp?.outputId || !stamp?.contentHash) return null;
  return {
    spec: PROVENANCE_SPEC,
    ai_generated: true,
    kind: 'image',
    model: {
      id: stamp.modelId ?? null,
      watermark: stamp.watermark || { by: 'none', applied: false }
    },
    output_id: String(stamp.outputId),
    ...(stamp.createdAt ? { created_at: String(stamp.createdAt) } : {}),
    content_hash: {
      alg: HASH_ALG,
      normalization: NORMALIZATION_NONE,
      value: String(stamp.contentHash)
    }
  };
}

/**
 * Build the provenance object of a media output.
 *
 * @param {Object} input
 * @param {string} input.outputId
 * @param {'image'|'audio'} input.kind
 * @param {string} input.contentHash - SHA-256 hex of the raw bytes.
 * @param {number} input.byteLength
 * @param {string} [input.mimeType]
 * @param {{id: string}} input.model
 * @param {Object} [input.modelConfig]
 * @param {Object|null} [input.c2pa] - {@link readC2pa} result.
 * @param {string} [input.createdAt] - ISO time of the stamp; default now.
 * @param {string} input.installationId
 * @param {string} [input.version]
 * @returns {Object}
 */
export function buildMediaRecord({
  outputId,
  kind,
  contentHash,
  byteLength,
  mimeType,
  model,
  modelConfig,
  c2pa,
  createdAt,
  installationId,
  version = getAppVersion()
}) {
  const record = buildProvenance({
    outputId,
    ...(createdAt ? { createdAt } : {}),
    kind,
    hash: contentHash,
    normalization: NORMALIZATION_NONE,
    model,
    modelConfig,
    installationId,
    version
  });
  record.content_hash = {
    ...record.content_hash,
    bytes: byteLength,
    ...(mimeType ? { mime_type: mimeType } : {})
  };
  record.provider_marking = buildProviderMarking(c2pa, modelConfig, kind);
  return record;
}

/**
 * Read the manifest of a generated image and store its record. Best effort: a
 * failure costs the record, never the answer. Records exist whether or not the
 * artifact store accepts the image (size cap, count, disabled), and for every
 * channel (chat, agents, workflows, MCP, A2A).
 *
 * @param {Object} image - A stamped image (`data` base64, `mimeType`, `provenance`).
 * @param {Object} context
 * @param {Object} context.model - Model config (`id`, `contentMarking`).
 * @param {Object|null} [context.user] - The acting user (`provenance.recordUser`).
 * @returns {Promise<Object|null>} The stored object, or null.
 */
export async function recordGeneratedImage(image, { model, user } = {}) {
  try {
    if (!isEuAiActEnabled()) return null;
    const stamp = image?.provenance;
    if (!stamp?.outputId || !stamp?.contentHash) return null;
    const settings = provenanceSettings();
    if (!settings.storeRecords) return null;
    const store = getProvenanceStore();
    if (!store.isAvailable()) return null;
    // Decoded again here rather than held from the stamp: a 25 MB image is not
    // kept alive between the chunk and the end of the stream by this feature.
    const bytes = Buffer.from(image.data, 'base64');
    const sniffed = sniffMedia(bytes);
    const mimeType = sniffed?.mimeType || image.mimeType;
    const c2pa = settings.media.readC2pa ? await readC2pa(bytes, { mimeType }) : null;
    const record = buildMediaRecord({
      outputId: stamp.outputId,
      kind: 'image',
      contentHash: stamp.contentHash,
      byteLength: bytes.length,
      mimeType,
      model: { id: model?.id ?? null },
      modelConfig: model,
      c2pa,
      createdAt: stamp.createdAt,
      installationId: await store.installationId()
    });
    const named = await recordedUser({ user });
    if (named) record.user = named;
    await store.record(record);
    return record;
  } catch (error) {
    logger.warn('Could not record a generated image', {
      component: COMPONENT,
      error: error.message
    });
    return null;
  }
}
