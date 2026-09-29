/**
 * Marks every AI-generated image with two machine-readable layers before it
 * is streamed, stored or served (CoP Measure 1.1; concept §5.2, §8.1 hook 1;
 * issue #2569):
 *
 * 1. an **invisible watermark** (Adobe TrustMark, variant P / BCH_5) carrying
 *    a random 61-bit id, which is also the C2PA soft binding — the id leads
 *    back to the provenance record even after the metadata was stripped;
 * 2. a **signed C2PA manifest**: `c2pa.created` with digital source type
 *    `trainedAlgorithmicMedia`, `c2pa.watermarked`, the soft binding and an
 *    iHub provenance assertion (content id, signpost). No personal data.
 *
 * Plus the IPTC/XMP `DigitalSourceType` fallback. An upstream mark (Google
 * SynthID in Gemini images) lives in the pixels and survives: TrustMark adds
 * a low-strength residual on top and never re-generates the image. A C2PA
 * manifest the image arrived with, and those of uploaded source images, are
 * kept as ingredients (CoP Measure 1.2).
 *
 * The hook sits in the LLM client, so the SSE delta, the stored artifact, the
 * download and the inference API all carry the marked bytes — artifacts are
 * served `immutable`, so marking later would be too late.
 *
 * @module services/provenance/image/ImageMarker
 */
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import config from '../../../config.js';
import { getRootDir } from '../../../pathUtils.js';
import { getAppVersion } from '../../../utils/versionHelper.js';
import logger from '../../../utils/logger.js';
import {
  DIGITAL_SOURCE_TYPES,
  normalizeContentMarking
} from '../../../../shared/aiTransparency.js';
import { getAiTransparencyConfig, isAiTransparencyActive } from '../config.js';
import { getInstallationUrl } from '../installation.js';
import signingService from '../signing/SigningService.js';
import { isC2paAvailable, loadC2pa, readAsset, signAsset } from '../signing/c2pa.js';
import provenanceStore, { hashBytes } from '../ProvenanceStore.js';
import {
  buildXmpPacket,
  decodeRgb,
  embedXmp,
  encodeRgb,
  sniffImageType,
  supportsPixelWatermark
} from './imageFormats.js';

const COMPONENT = 'ImageMarker';
export const TRUSTMARK_VARIANT = 'P';
export const TRUSTMARK_VERSION = 'BCH_5';
/** Payload bits TrustMark BCH_5 carries. */
export const TRUSTMARK_PAYLOAD_BITS = 61;
export const TRUSTMARK_SOFT_BINDING_ALG = `com.adobe.trustmark.${TRUSTMARK_VARIANT}`;

let trustmarkPromise = null;
let trustmarkError = null;
let trustmarkQueue = Promise.resolve();

/** Directory holding the TrustMark ONNX models. */
export function trustmarkModelPath(cfg = getAiTransparencyConfig()) {
  if (cfg.images.trustmarkModelPath) return cfg.images.trustmarkModelPath;
  return path.join(
    getRootDir(),
    config.CONTENTS_DIR,
    config.DATA_DIR || 'data',
    'trustmark-models'
  );
}

function modelsPresent(modelPath) {
  return (
    existsSync(path.join(modelPath, `encoder_${TRUSTMARK_VARIANT}.onnx`)) &&
    existsSync(path.join(modelPath, `decoder_${TRUSTMARK_VARIANT}.onnx`))
  );
}

/**
 * The TrustMark instance. The first call loads the ONNX models; when they
 * are missing, c2pa-node downloads them (~65 MB) into the model path, which
 * needs network access once. Offline installations copy the two files there.
 * @returns {Promise<Object|null>}
 */
export async function getTrustmark() {
  if (!trustmarkPromise) {
    trustmarkPromise = (async () => {
      const c2pa = await loadC2pa();
      if (!c2pa?.Trustmark) throw new Error('TrustMark is not available (c2pa-node missing)');
      return c2pa.Trustmark.newTrustmark({
        variant: TRUSTMARK_VARIANT,
        version: TRUSTMARK_VERSION,
        modelPath: trustmarkModelPath()
      });
    })().catch(error => {
      trustmarkError = error.message;
      trustmarkPromise = null;
      logger.warn('TrustMark watermarking unavailable', {
        component: COMPONENT,
        error: error.message
      });
      return null;
    });
  }
  return trustmarkPromise;
}

/** Load TrustMark in the background (startup), so the first image is not slow. */
export function warmUpTrustmark() {
  const cfg = getAiTransparencyConfig();
  if (!isAiTransparencyActive() || cfg.images.watermark !== 'trustmark') return;
  getTrustmark().catch(() => {});
}

/** Serialise TrustMark calls: one ONNX session, one image at a time. */
function withTrustmark(fn) {
  const run = async () => {
    const tm = await getTrustmark();
    if (!tm) throw new Error(trustmarkError || 'TrustMark unavailable');
    return fn(tm);
  };
  const next = trustmarkQueue.then(run, run);
  trustmarkQueue = next.catch(() => {});
  return next;
}

/** Status for the EU AI Act page. */
export async function imageMarkerStatus() {
  const cfg = getAiTransparencyConfig();
  const modelPath = trustmarkModelPath(cfg);
  const c2paAvailable = await isC2paAvailable();
  const present = modelsPresent(modelPath);
  return {
    c2pa: cfg.images.c2pa,
    c2paAvailable,
    watermark: cfg.images.watermark,
    watermarkAvailable:
      c2paAvailable &&
      cfg.images.watermark === 'trustmark' &&
      (present || trustmarkPromise !== null) &&
      !trustmarkError,
    watermarkModelsPresent: present,
    watermarkError: trustmarkError || (present ? null : 'TrustMark models not downloaded yet'),
    modelPath,
    variant: `${TRUSTMARK_VARIANT}/${TRUSTMARK_VERSION}`,
    xmp: cfg.images.xmp
  };
}

/** A random watermark payload and the content id derived from it. */
export function newImagePayload() {
  const n = crypto.randomBytes(8).readBigUInt64BE() & ((1n << BigInt(TRUSTMARK_PAYLOAD_BITS)) - 1n);
  const bits = n.toString(2).padStart(TRUSTMARK_PAYLOAD_BITS, '0');
  return { bits, contentId: contentIdFromBits(bits) };
}

/** Content id of an image from its decoded watermark bits. */
export function contentIdFromBits(bits) {
  const clean = String(bits || '')
    .replace(/[^01]/g, '')
    .slice(0, TRUSTMARK_PAYLOAD_BITS);
  if (clean.length < TRUSTMARK_PAYLOAD_BITS) return null;
  return `prv_img${BigInt(`0b${clean}`).toString(16).padStart(16, '0')}`;
}

function extFor(mimeType) {
  return (
    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[
      mimeType
    ] || 'img'
  );
}

/**
 * Decode the TrustMark payload of an image (detection).
 * @param {Buffer} buffer
 * @returns {Promise<{found: boolean, bits?: string, contentId?: string, error?: string}>}
 */
export async function decodeImageWatermark(buffer) {
  const attempt = async bytes => {
    try {
      const bits = await withTrustmark(tm => tm.decode(bytes));
      const contentId = contentIdFromBits(bits);
      return contentId ? { found: true, bits, contentId } : { found: false };
    } catch (error) {
      const message = String(error?.message || error);
      if (/corrupt or missing|not found|no watermark/i.test(message)) return { found: false };
      return { found: false, error: message };
    }
  };
  const direct = await attempt(buffer);
  if (direct.found) return direct;
  // Metadata chunks (C2PA + XMP together) can trip TrustMark's own PNG
  // reader; the watermark is in the pixels, so read them ourselves and retry
  // on a clean PNG.
  const type = sniffImageType(buffer);
  if (supportsPixelWatermark(type)) {
    try {
      const clean = encodeRgb(decodeRgb(buffer, type), 'image/png');
      const retry = await attempt(clean);
      if (retry.found || retry.error) return retry;
    } catch {
      /* undecodable image: fall through */
    }
  }
  return direct;
}

async function applyWatermark(buffer, mimeType, bits, strength) {
  const { width, height } = decodeRgb(buffer, mimeType);
  const rgb = await withTrustmark(tm => tm.encode(buffer, strength, bits));
  if (!Buffer.isBuffer(rgb) || rgb.length !== width * height * 3) {
    throw new Error('TrustMark returned an unexpected pixel buffer');
  }
  return encodeRgb({ width, height, rgb }, mimeType, { quality: 95 });
}

/**
 * Mark one generated image.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - image bytes from the model
 * @param {string} [params.mimeType]
 * @param {Object|null} [params.model] - model config
 * @param {{buffer: Buffer, mimeType: string}[]} [params.sourceImages] - uploaded inputs (edits)
 * @returns {Promise<{buffer: Buffer, mimeType: string, provenance: Object}>}
 */
export async function markImage({ buffer, mimeType, model = null, sourceImages = [] }) {
  const cfg = getAiTransparencyConfig();
  const type = sniffImageType(buffer) || mimeType || 'image/png';
  const markings = [];
  const errors = [];
  const { bits, contentId } = newImagePayload();
  const version = getAppVersion();
  let out = buffer;

  // The image may arrive with its own C2PA manifest; keep it as an ingredient.
  const ingredients = [];
  if (cfg.images.c2pa) {
    const upstream = await readAsset(buffer, type).catch(() => null);
    if (upstream?.present) {
      ingredients.push({
        buffer,
        mimeType: type,
        title: 'model output',
        relationship: 'componentOf'
      });
      markings.push('upstream:c2pa');
    }
    for (const source of sourceImages) {
      const read = await readAsset(source.buffer, source.mimeType).catch(() => null);
      if (read?.present) {
        ingredients.push({ ...source, title: 'uploaded image', relationship: 'inputTo' });
      }
    }
  }

  let watermarked = false;
  if (cfg.images.watermark === 'trustmark') {
    if (supportsPixelWatermark(type)) {
      try {
        out = await applyWatermark(out, type, bits, cfg.images.watermarkStrength);
        watermarked = true;
        markings.push('trustmark');
      } catch (error) {
        errors.push(`watermark: ${error.message}`);
        logger.warn('Image watermark failed', { component: COMPONENT, error: error.message });
      }
    } else {
      errors.push(`watermark: ${type} is not supported`);
    }
  }

  if (cfg.images.xmp) {
    const xmp = buildXmpPacket({ creatorTool: `iHub Apps ${version}`, contentId });
    const result = embedXmp(out, type, xmp);
    out = result.buffer;
    if (result.embedded) markings.push('xmp');
  }

  const upstreamMark = normalizeContentMarking(model || {}).image;
  if (upstreamMark.kind === 'upstream') markings.push(`upstream:${upstreamMark.vendor}`);

  if (cfg.images.c2pa && cfg.signing.enabled) {
    try {
      const signer = await signingService.getActiveSigner();
      if (!signer) throw new Error('no signing certificate');
      const installationUrl = getInstallationUrl();
      const actions = [
        {
          action: 'c2pa.created',
          digitalSourceType: DIGITAL_SOURCE_TYPES.trainedAlgorithmicMedia,
          softwareAgent: { name: 'iHub Apps', version },
          ...(model
            ? { parameters: { 'com.intrafind.ihub.model': String(model.modelId || model.id) } }
            : {})
        }
      ];
      if (watermarked) {
        actions.push({
          action: 'c2pa.watermarked',
          softwareAgent: { name: 'iHub Apps', version },
          parameters: { description: `TrustMark ${TRUSTMARK_VARIANT} invisible watermark` }
        });
      }
      const assertions = [
        { label: 'c2pa.actions', data: { actions } },
        {
          label: 'com.intrafind.ihub.provenance',
          data: {
            contentId,
            aiGenerated: true,
            generator: 'iHub Apps',
            ...(model ? { model: { id: model.id, provider: model.provider } } : {}),
            ...(installationUrl ? { signpost: `${installationUrl}/.well-known/ai-provenance` } : {})
          }
        }
      ];
      if (watermarked) {
        assertions.push({
          label: 'c2pa.soft-binding',
          data: {
            alg: TRUSTMARK_SOFT_BINDING_ALG,
            blocks: [
              {
                scope: {},
                value: Buffer.from(
                  BigInt(`0b${bits}`).toString(16).padStart(16, '0'),
                  'hex'
                ).toString('base64')
              }
            ]
          }
        });
      }
      out = await signAsset(
        out,
        type,
        {
          claim_generator_info: [{ name: 'iHub Apps', version }],
          title: `ai-generated-image.${extFor(type)}`,
          format: type,
          assertions
        },
        signer,
        { ingredients }
      );
      markings.push('c2pa');
    } catch (error) {
      errors.push(`c2pa: ${error.message}`);
      logger.warn('Image C2PA signing failed', { component: COMPONENT, error: error.message });
    }
  }

  const sha256 = hashBytes(out);
  const conforming = markings.includes('c2pa') && markings.includes('trustmark');
  const provenance = { contentId, sha256, mimeType: type, markings, conforming };
  if (errors.length) provenance.errors = errors;
  await provenanceStore
    .recordImage({ contentId, sha256, mimeType: type, model, markings, conforming })
    .catch(() => {});
  return { buffer: out, mimeType: type, provenance };
}

/**
 * Uploaded images of the latest user message — the inputs of an image edit,
 * whose C2PA manifests become ingredients. `imageData` is `{base64, fileType}`
 * or an array of them; `base64` may be a data URL.
 * @param {Object[]} messages
 * @returns {{buffer: Buffer, mimeType: string}[]}
 */
export function sourceImagesFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const lastUser = [...messages].reverse().find(m => m?.role === 'user');
  if (!lastUser?.imageData) return [];
  const list = Array.isArray(lastUser.imageData) ? lastUser.imageData : [lastUser.imageData];
  const out = [];
  for (const img of list.slice(0, 4)) {
    if (!img?.base64 || typeof img.base64 !== 'string') continue;
    const raw = img.base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const buffer = Buffer.from(raw, 'base64');
      const mimeType = sniffImageType(buffer) || img.fileType || 'image/png';
      out.push({ buffer, mimeType });
    } catch {
      /* not decodable: skip */
    }
  }
  return out;
}

/**
 * Mark the images of one LLM stream chunk in place (`image.data` base64).
 * Called by the LLM client before a chunk is accumulated or yielded.
 *
 * @param {Object} chunk - normalised GenericChunk
 * @param {{model?: Object, sourceImages?: Object[]}} [ctx]
 */
export async function markChunkImages(chunk, { model = null, sourceImages = [] } = {}) {
  if (!Array.isArray(chunk?.images) || chunk.images.length === 0) return;
  if (!isAiTransparencyActive()) return;
  for (const image of chunk.images) {
    if (!image?.data || image.provenance) continue;
    try {
      const marked = await markImage({
        buffer: Buffer.from(image.data, 'base64'),
        mimeType: image.mimeType,
        model,
        sourceImages
      });
      image.data = marked.buffer.toString('base64');
      image.mimeType = marked.mimeType;
      image.provenance = marked.provenance;
    } catch (error) {
      logger.error('Could not mark generated image', {
        component: COMPONENT,
        error: error.message
      });
      image.provenance = { markings: [], conforming: false, errors: [error.message] };
    }
  }
}
