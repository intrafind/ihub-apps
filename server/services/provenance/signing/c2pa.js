/**
 * C2PA signing and reading via `@contentauth/c2pa-node` (the official Node
 * bindings to c2pa-rs).
 *
 * The package is an optional dependency: it is a ~40 MB native addon with
 * prebuilt binaries for Linux (glibc) x64/arm64, macOS and Windows x64. Where
 * it is missing (Alpine/musl, Windows arm64, an install without optional
 * dependencies) iHub keeps running; image and file signing then report
 * "signing unavailable", which the EU AI Act page shows as non-conforming.
 *
 * c2pa-rs embeds manifests into images (PNG, JPEG, WebP, GIF, TIFF, AVIF,
 * HEIC, SVG) and media. It does not write PDF or OOXML yet, so those formats
 * get the signed iHub manifest instead (see `export/ExportSigner.js`).
 *
 * @module services/provenance/signing/c2pa
 */
import logger from '../../../utils/logger.js';

const COMPONENT = 'C2pa';

/** MIME types c2pa-rs can embed a manifest into. */
export const C2PA_WRITABLE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/svg+xml'
]);

/** MIME types c2pa-rs can read a manifest from (writable ones plus PDF). */
export const C2PA_READABLE_TYPES = Object.freeze([...C2PA_WRITABLE_TYPES, 'application/pdf']);

let modulePromise = null;
let loadError = null;

/**
 * The c2pa-node module, or null when it is not installed.
 * @returns {Promise<Object|null>}
 */
export async function loadC2pa() {
  if (!modulePromise) {
    modulePromise = import('@contentauth/c2pa-node').catch(error => {
      loadError = error;
      logger.warn('C2PA signing unavailable: @contentauth/c2pa-node could not be loaded', {
        component: COMPONENT,
        error: error.message
      });
      return null;
    });
  }
  return modulePromise;
}

/** Why c2pa-node is unavailable, if it is. */
export function c2paLoadError() {
  return loadError ? loadError.message : null;
}

/** Whether c2pa-node loads on this platform. */
export async function isC2paAvailable() {
  return (await loadC2pa()) !== null;
}

/** Test hook. */
export function _resetC2paModule() {
  modulePromise = null;
  loadError = null;
}

/**
 * Embed a signed C2PA manifest.
 *
 * @param {Buffer} buffer - asset bytes
 * @param {string} mimeType
 * @param {Object} manifest - manifest definition (claim_generator_info, title, assertions, …)
 * @param {Object} signer
 * @param {string} signer.chainPem
 * @param {string} signer.keyPem
 * @param {string} [signer.alg='es256']
 * @param {string} [signer.tsaUrl]
 * @param {Object} [opts]
 * @param {{buffer: Buffer, mimeType: string, title?: string, relationship?: string}[]} [opts.ingredients]
 *   - source assets whose own manifests are kept as ingredients (CoP Measure 1.2)
 * @returns {Promise<Buffer>} the signed asset
 */
export async function signAsset(buffer, mimeType, manifest, signer, { ingredients = [] } = {}) {
  const c2pa = await loadC2pa();
  if (!c2pa) throw new Error('C2PA signing is not available on this installation');
  const settings = {
    builder: { thumbnail: { enabled: false } },
    verify: { verifyAfterSign: false }
  };
  const builder = c2pa.Builder.withJson(manifest, settings);
  for (const ingredient of ingredients) {
    try {
      await builder.addIngredient(
        JSON.stringify({
          title: ingredient.title || 'source',
          relationship: ingredient.relationship || 'parentOf'
        }),
        { buffer: ingredient.buffer, mimeType: ingredient.mimeType }
      );
    } catch (error) {
      logger.warn('Could not add C2PA ingredient', { component: COMPONENT, error: error.message });
    }
  }
  const localSigner = c2pa.LocalSigner.newSigner(
    Buffer.from(signer.chainPem),
    Buffer.from(signer.keyPem),
    signer.alg || 'es256',
    signer.tsaUrl || undefined
  );
  const output = { buffer: null };
  builder.sign(localSigner, { buffer, mimeType }, output);
  if (!Buffer.isBuffer(output.buffer)) throw new Error('C2PA signing produced no output');
  return output.buffer;
}

/**
 * Read and validate the C2PA manifest store of an asset.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {{trustAnchors?: string[]}} [opts] - PEM anchors that make a signer `Trusted`
 * @returns {Promise<{present: boolean, available: boolean, validationState?: string, activeManifest?: Object, issues?: Object[], manifestStore?: Object, error?: string}>}
 */
export async function readAsset(buffer, mimeType, { trustAnchors = [] } = {}) {
  const c2pa = await loadC2pa();
  if (!c2pa) return { present: false, available: false, error: c2paLoadError() };
  let context;
  if (trustAnchors.length && c2pa.Context) {
    context = new c2pa.Context({
      verify: { verifyTrust: true, remoteManifestFetch: false },
      trust: { trustAnchors: trustAnchors.join('\n') }
    });
  } else if (c2pa.Context) {
    context = new c2pa.Context({ verify: { remoteManifestFetch: false } });
  }
  try {
    const reader = await c2pa.Reader.fromAsset({ buffer, mimeType }, context);
    if (!reader) return { present: false, available: true };
    const store = reader.json();
    return {
      present: true,
      available: true,
      validationState: store.validation_state,
      activeManifest: reader.getActive() || null,
      issues: store.validation_status || [],
      manifestStore: store
    };
  } catch (error) {
    const message = String(error?.message || error);
    if (/no.*manifest|JumbfNotFound|not found/i.test(message)) {
      return { present: false, available: true };
    }
    return { present: false, available: true, error: message };
  }
}
