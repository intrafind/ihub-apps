/**
 * The TrustMark ONNX models, fetched by iHub and never by c2pa-node.
 *
 * `Trustmark.newTrustmark` in c2pa-node downloads missing models inside the
 * native call, synchronously on the main thread. On a slow or blocked network
 * that froze the whole server — every request, the login included — until the
 * download finished or timed out, and it tried again on every image. iHub
 * downloads the two files itself: asynchronously, through the configured
 * proxy, with timeouts, a pinned size and SHA-256, and a pause after a failure.
 * The TrustMark instance is only created once both files are on disk.
 *
 * Offline installations copy the two files into the model path.
 *
 * @module services/provenance/image/trustmarkModels
 */
import crypto from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpFetch } from '../../../utils/httpConfig.js';
import logger from '../../../utils/logger.js';

const COMPONENT = 'ImageMarker';

/** Where c2pa-node 0.9.7 fetches the models from. */
export const TRUSTMARK_MODEL_BASE_URL =
  'https://cai-watermark.adobe.net/watermarking/trustmark-models';

/** The variant P models (BCH_5 payload), with the size and hash c2pa-node 0.9.7 loads. */
export const TRUSTMARK_MODEL_FILES = Object.freeze([
  Object.freeze({
    name: 'encoder_P.onnx',
    size: 17312208,
    sha256: '053441c9c9f05fc158ccba71c610d9d58fcd2c82d1912bf0ffcee988cf2f74c8'
  }),
  Object.freeze({
    name: 'decoder_P.onnx',
    size: 47400467,
    sha256: 'be6d7c33f8a7b376f179e75f3f7c58ff816a9ac7bb6d37fd0a729a635f624c35'
  })
]);

/** No response headers, or no bytes, for this long aborts the download. */
const STALL_TIMEOUT_MS = 30 * 1000;
/** After a failed download, wait this long before trying again. */
export const RETRY_AFTER_MS = 15 * 60 * 1000;

/** modelPath -> in-flight download promise */
const inFlight = new Map();
/** modelPath -> { at, error } of the last failed download */
const failures = new Map();

/**
 * Whether every model file is in the directory.
 * @param {string} modelPath
 * @param {readonly {name: string}[]} [files]
 */
export function trustmarkModelsPresent(modelPath, files = TRUSTMARK_MODEL_FILES) {
  return files.every(file => existsSync(path.join(modelPath, file.name)));
}

/**
 * Download state for the EU AI Act page.
 * @param {string} modelPath
 * @returns {{downloading: boolean, error: string|null}}
 */
export function trustmarkModelDownloadState(modelPath) {
  return {
    downloading: inFlight.has(modelPath),
    error: failures.get(modelPath)?.error || null
  };
}

/**
 * Make sure the model files are in `modelPath`, downloading the missing ones.
 * Concurrent callers share one download; after a failure the next attempt
 * waits {@link RETRY_AFTER_MS} and callers get the failure straight away.
 *
 * @param {string} modelPath
 * @param {Object} [options]
 * @param {string} [options.baseUrl]
 * @param {readonly {name: string, size: number, sha256: string}[]} [options.files]
 * @param {number} [options.stallTimeoutMs]
 * @param {number} [options.retryAfterMs]
 * @returns {Promise<void>} rejects when a file is still missing
 */
export async function ensureTrustmarkModels(modelPath, options = {}) {
  const {
    baseUrl = TRUSTMARK_MODEL_BASE_URL,
    files = TRUSTMARK_MODEL_FILES,
    stallTimeoutMs = STALL_TIMEOUT_MS,
    retryAfterMs = RETRY_AFTER_MS
  } = options;
  if (trustmarkModelsPresent(modelPath, files)) return;
  if (inFlight.has(modelPath)) return inFlight.get(modelPath);

  const failure = failures.get(modelPath);
  if (failure && Date.now() - failure.at < retryAfterMs) {
    throw new Error(`TrustMark model download failed: ${failure.error}`);
  }

  const download = (async () => {
    try {
      await fs.mkdir(modelPath, { recursive: true });
      for (const file of files) {
        const dest = path.join(modelPath, file.name);
        if (existsSync(dest)) continue;
        logger.info('Downloading TrustMark model', {
          component: COMPONENT,
          file: file.name,
          bytes: file.size
        });
        await downloadModel(`${baseUrl}/${file.name}`, dest, file, stallTimeoutMs);
      }
      failures.delete(modelPath);
      logger.info('TrustMark models ready', { component: COMPONENT, modelPath });
    } catch (error) {
      failures.set(modelPath, { at: Date.now(), error: error.message });
      throw new Error(`TrustMark model download failed: ${error.message}`);
    } finally {
      inFlight.delete(modelPath);
    }
  })();
  inFlight.set(modelPath, download);
  return download;
}

/**
 * Stream one model into a temporary file, verify it and move it into place.
 * @param {string} url
 * @param {string} dest
 * @param {{name: string, size: number, sha256: string}} expected
 * @param {number} stallTimeoutMs
 */
async function downloadModel(url, dest, expected, stallTimeoutMs) {
  const controller = new AbortController();
  let stallTimer = null;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
    stallTimer.unref?.();
  };
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  armStallTimer();
  try {
    const response = await httpFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'application/octet-stream' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${expected.name}`);

    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        armStallTimer();
        received += chunk.length;
        if (received > expected.size) {
          callback(new Error(`${expected.name} is larger than ${expected.size} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(response.body, meter, createWriteStream(tmp, { mode: 0o644 }));

    if (received !== expected.size) {
      throw new Error(`${expected.name} has ${received} bytes, expected ${expected.size}`);
    }
    const digest = hash.digest('hex');
    if (digest !== expected.sha256) {
      throw new Error(`${expected.name} does not match its pinned SHA-256`);
    }
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (controller.signal.aborted) {
      throw new Error(
        `no data from ${new URL(url).host} for ${stallTimeoutMs / 1000} s (${expected.name})`
      );
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }
}

/** Forget in-flight and failed downloads (tests). */
export function resetTrustmarkModelState() {
  inFlight.clear();
  failures.clear();
}
