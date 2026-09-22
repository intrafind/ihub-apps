/**
 * Artifact policy — what this installation is willing to store, and what an
 * artifact may be.
 *
 * Separate from the repository for the same reason `chatPersistence` is
 * separate from `ChatRepository`: several producers (a chat turn today, a
 * workflow report and an agent run next) have to agree on the answer, and a
 * policy re-derived per producer is a policy that eventually disagrees with
 * itself.
 *
 * Import-light on purpose — pure functions over configuration the caller has
 * already loaded, plus one live-config convenience.
 *
 * @module services/artifacts/artifactPolicy
 */
import configCache from '../../configCache.js';

/**
 * Largest single artifact stored, in bytes of base64, when
 * `platform.artifacts.maxBytes` says nothing.
 *
 * An artifact is the one thing a run produces that is measured in megabytes
 * rather than kilobytes. Ten megabytes of base64 is roughly a 7.5 MB file —
 * past anything the image models here return, so the cap only ever catches
 * the pathological case.
 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/**
 * Artifacts one producer records in one go — one chat answer, one workflow
 * node — when `platform.artifacts.maxPerBatch` says nothing. A turn that
 * produced more than this asked for a contact sheet, not an answer.
 */
export const DEFAULT_MAX_ARTIFACTS_PER_BATCH = 8;

/**
 * What an artifact may be, and the media types each kind may be served as.
 *
 * The type comes from whatever produced the artifact — a model response, a
 * tool — and it ends up in a `Content-Type` header on a same-origin URL. An
 * allowlist per kind is what keeps a producer from having the server hand a
 * browser `text/html`. Two deliberate absences:
 *
 * - `image/svg+xml` is not an image here. SVG is a document that can run
 *   script, and `nosniff` does not help when the type is honest.
 * - `text/html` is not a document here, for the same reason.
 *
 * Adding a kind is an entry here plus a renderer on the client; nothing in
 * the storage path is kind-specific.
 *
 * @type {ReadonlyMap<string, ReadonlySet<string>>}
 */
export const ARTIFACT_KINDS = new Map([
  [
    'image',
    new Set([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/avif',
      'image/bmp',
      'image/heic',
      'image/heif'
    ])
  ],
  [
    'document',
    new Set(['text/markdown', 'text/plain', 'text/csv', 'application/json', 'application/pdf'])
  ]
]);

/** The kind an artifact is stored as when the producer names none. */
export const DEFAULT_ARTIFACT_KIND = 'image';

/**
 * Spellings producers use that are not the registered media type. A `Map`
 * rather than an object literal because the key comes from a model response,
 * and a plain lookup of `constructor` on an object answers with something.
 */
const MEDIA_TYPE_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['text/x-markdown', 'text/markdown'],
  ['application/markdown', 'text/markdown']
]);

/** Served instead of a type this server is not willing to name. */
export const OPAQUE_MEDIA_TYPE = 'application/octet-stream';

/**
 * The kind an artifact is filed under — one of {@link ARTIFACT_KINDS}.
 *
 * @param {unknown} kind - Kind as the producer named it.
 * @returns {string} A known kind, or the default one.
 */
export function artifactKind(kind) {
  return typeof kind === 'string' && ARTIFACT_KINDS.has(kind) ? kind : DEFAULT_ARTIFACT_KIND;
}

/**
 * The media type an artifact of this kind is written and served under.
 *
 * @param {unknown} kind - Artifact kind.
 * @param {unknown} mimeType - Type as the producer reported it.
 * @returns {string} An allowlisted type for the kind, or {@link OPAQUE_MEDIA_TYPE}.
 */
export function artifactMediaType(kind, mimeType) {
  const allowed = ARTIFACT_KINDS.get(artifactKind(kind));
  if (!allowed || typeof mimeType !== 'string') return OPAQUE_MEDIA_TYPE;
  const declared = mimeType.split(';')[0].trim().toLowerCase();
  const normalized = MEDIA_TYPE_ALIASES.get(declared) || declared;
  return allowed.has(normalized) ? normalized : OPAQUE_MEDIA_TYPE;
}

/**
 * Read a numeric setting, keeping zero and negative values — both are
 * meaningful ("disable this rule") and must survive as written.
 *
 * @param {unknown} value - Configured value.
 * @param {number} fallback - Default for a missing or unparseable value.
 * @returns {number}
 */
function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * How this installation stores artifacts.
 *
 * `enabled: false` turns the whole thing off for every producer — a chat
 * still stores its transcript, a workflow still runs, and what they produced
 * is exactly what it was before this store existed: visible while the client
 * is looking at it and gone afterwards. `maxBytes` and `maxPerBatch` of zero
 * or less remove their cap.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {{enabled: boolean, maxBytes: number, maxPerBatch: number}}
 */
export function artifactSettings(platformConfig) {
  const artifacts = platformConfig?.artifacts || {};
  return {
    enabled: artifacts.enabled !== false,
    maxBytes: readNumber(artifacts.maxBytes, DEFAULT_MAX_ARTIFACT_BYTES),
    maxPerBatch: readNumber(artifacts.maxPerBatch, DEFAULT_MAX_ARTIFACTS_PER_BATCH)
  };
}

/**
 * The policy in force right now, read from the live platform config.
 *
 * Resolved per write rather than captured, so an admin who switches artifact
 * storage off does not have to restart the server for the next run to honour
 * it.
 *
 * @returns {{enabled: boolean, maxBytes: number, maxPerBatch: number}}
 */
export function artifactPolicy() {
  // `getPlatform()` returns the config itself, not a `{ data }` cache entry.
  return artifactSettings(configCache.getPlatform?.() || {});
}
