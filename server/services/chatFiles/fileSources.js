// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Direct server-side ingest of files that live in a connected system: the
 * server fetches the raw bytes itself with the signed-in user's stored
 * credentials and passes them to `ingestChatFile`, so the original is kept (and
 * can serve as a template) without the file taking a detour through the browser.
 *
 *   { source: { kind: 'nextcloud' | 'office365' | 'google-drive' | 'ifinder-document',
 *               ref, refreshOnRun? } }
 *
 * The `ref` is the one the project item kinds use (`services/projects/kinds`):
 * `{providerId, path}` for Nextcloud, `{providerId, fileId, driveId?}` for
 * OneDrive/SharePoint, `{providerId, fileId}` for Google Drive (Docs, Sheets and
 * Slides are exported to `.docx`, `.xlsx`, `.pptx`), `{documentId, searchProfile?}`
 * for iFinder. The downloads go through the integration services, which honor the
 * SSL whitelist and proxy settings (`utils/httpConfig.js`).
 *
 * The `source` stays on the stored file. A task file with `refreshOnRun: true` is
 * fetched again at the start of every run, with the task owner's credentials
 * ({@link refreshTaskFiles}).
 *
 * @module services/chatFiles/fileSources
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { getItemKind, isItemKindEnabled } from '../projects/kinds/registry.js';
import '../projects/kinds/cloudKinds.js';
import '../projects/kinds/linkKinds.js';
import { chatFilePolicy } from './chatFilePolicy.js';
import { ChatFileQuotaError, getChatFileRepository } from './ChatFileRepository.js';
import { ChatFileError, ingestChatFile } from './ChatFileService.js';

const COMPONENT = 'ChatFileSources';

/** The systems a file can be fetched from. */
export const FILE_SOURCE_KINDS = Object.freeze([
  'nextcloud',
  'office365',
  'google-drive',
  'ifinder-document'
]);

const STATUS_BY_SOURCE_CODE = {
  SOURCE_FORBIDDEN: 403,
  SOURCE_GONE: 404,
  SOURCE_TIMEOUT: 504,
  FEATURE_DISABLED: 403,
  KIND_DISABLED: 400,
  INVALID_REF: 400
};

/**
 * Read a provider's content (a buffer, a string or a stream) into a buffer,
 * stopping at `maxBytes`.
 *
 * @param {{body?: Buffer|string, stream?: AsyncIterable<Buffer>}} content
 * @param {number} maxBytes - 0 or less: no cap.
 * @returns {Promise<Buffer>}
 */
async function readContent(content, maxBytes) {
  const tooLarge = size =>
    new ChatFileQuotaError(
      'QUOTA_FILE_BYTES',
      `The file exceeds the maximum size of ${Math.floor(maxBytes / (1024 * 1024))} MB`,
      { limit: maxBytes, size },
      413
    );
  if (content.body !== undefined && content.body !== null) {
    const buffer = Buffer.isBuffer(content.body) ? content.body : Buffer.from(content.body);
    if (maxBytes > 0 && buffer.length > maxBytes) throw tooLarge(buffer.length);
    return buffer;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of content.stream || []) {
    size += chunk.length;
    if (maxBytes > 0 && size > maxBytes) {
      content.stream.destroy?.();
      throw tooLarge(size);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Translate what a connector threw into an answer the routes understand.
 *
 * @param {Error} error
 * @param {string} kind
 * @returns {Error}
 */
function failureOf(error, kind) {
  if (error instanceof ChatFileError || error instanceof ChatFileQuotaError) return error;
  const code = error?.code;
  if (code && STATUS_BY_SOURCE_CODE[code]) {
    return new ChatFileError(
      code === 'SOURCE_FORBIDDEN' || code === 'SOURCE_GONE' ? code : 'SOURCE_UNAVAILABLE',
      error.message,
      STATUS_BY_SOURCE_CODE[code]
    );
  }
  return new ChatFileError(
    'SOURCE_FAILED',
    `The file could not be fetched from ${kind}: ${error?.message || 'unknown error'}`,
    502
  );
}

/**
 * Fetch one file from a connected system.
 *
 * @param {Object} params
 * @param {{kind: string, ref: Object}} params.source
 * @param {Object} params.user - The principal whose stored credentials are used.
 * @param {number} [params.maxBytes] - Size cap (`maxFileBytes` of the policy).
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{bytes: Buffer, contentType: string, name: string, lastModified: string|null, ref: Object}>}
 * @throws {ChatFileError} `SOURCE_INVALID` (400), `SOURCE_UNAVAILABLE` (400/403/504), `SOURCE_FORBIDDEN` (403),
 *   `SOURCE_GONE` (404), `SOURCE_FAILED` (502); `ChatFileQuotaError` for a file over the size cap.
 */
export async function fetchSourceFile({ source, user, maxBytes = 0, signal } = {}) {
  const kind = source?.kind;
  if (!FILE_SOURCE_KINDS.includes(kind)) {
    throw new ChatFileError(
      'SOURCE_INVALID',
      `"source.kind" must be one of: ${FILE_SOURCE_KINDS.join(', ')}`,
      400
    );
  }
  const definition = getItemKind(kind);
  if (!definition) {
    throw new ChatFileError('SOURCE_UNAVAILABLE', `${kind} is not available here`, 400);
  }
  const platform = configCache.getPlatform?.() || {};
  const features = configCache.getFeatures?.() || {};
  // A `fetch` that exists for the cloud kinds checks the integrations feature
  // itself; the kind's own `enabled` says whether an installation is configured.
  if (!isItemKindEnabled(kind, { platform, features })) {
    throw new ChatFileError(
      'SOURCE_UNAVAILABLE',
      `${kind} is not enabled on this installation`,
      400
    );
  }
  if (!user?.id || user.id === 'anonymous') {
    throw new ChatFileError(
      'SOURCE_FORBIDDEN',
      'Sign in to attach files from a connected system',
      403
    );
  }
  const parsed = definition.refSchema.safeParse(source.ref);
  if (!parsed.success) {
    throw new ChatFileError(
      'SOURCE_INVALID',
      `"source.ref" is not valid for ${kind}: ${parsed.error.issues
        .map(issue => `${issue.path.join('.') || 'ref'}: ${issue.message}`)
        .join('; ')}`,
      400
    );
  }
  const ref = parsed.data;

  try {
    if (kind === 'ifinder-document') {
      // iFinder serves the original through its document link; a document without
      // one is read as text.
      const { default: provider } = await import('../sources/providers/ifinder.js');
      const request = {
        id: ref.documentId,
        ...(ref.searchProfile ? { scope: ref.searchProfile } : {})
      };
      let content;
      let text = false;
      try {
        content = await provider.content({ ref: request, user, format: 'original' });
      } catch {
        content = await provider.content({ ref: request, user, format: 'text' });
        text = true;
      }
      const bytes = await readContent(content, maxBytes);
      const name =
        content.fileName ||
        `${ref.documentId}${text || String(content.contentType || '').startsWith('text/') ? '.txt' : ''}`;
      return {
        bytes,
        contentType: String(
          content.contentType || (text ? 'text/plain' : 'application/octet-stream')
        ),
        name,
        lastModified: null,
        ref
      };
    }
    const fetched = await definition.fetch({ ref }, { user, signal });
    const bytes = Buffer.isBuffer(fetched.bytes) ? fetched.bytes : Buffer.from(fetched.bytes || []);
    if (maxBytes > 0 && bytes.length > maxBytes) {
      throw new ChatFileQuotaError(
        'QUOTA_FILE_BYTES',
        `The file exceeds the maximum size of ${Math.floor(maxBytes / (1024 * 1024))} MB`,
        { limit: maxBytes, size: bytes.length },
        413
      );
    }
    return {
      bytes,
      contentType: fetched.contentType || 'application/octet-stream',
      name: fetched.name || ref.name || 'document',
      lastModified: fetched.lastModified || null,
      ref
    };
  } catch (error) {
    throw failureOf(error, kind);
  }
}

/**
 * Fetch a file from a connected system and store it.
 *
 * Whatever the storage mode, the server fetched the bytes itself, so
 * `client_text_only` (no original file crosses the *browser's* network) is
 * served as `server_text_only`: the text is stored, the file is not.
 *
 * @param {Object} params
 * @param {{kind: string, ref: Object, refreshOnRun?: boolean}} params.source
 * @param {Object} params.user
 * @param {{type: 'chat'|'task', id: string}} params.scope
 * @param {string|null} params.ownerId
 * @param {Object|null} [params.appConfig]
 * @param {Object} [params.policy]
 * @param {Object} [params.store]
 * @param {string|null} [params.id] - Replace this stored file (a refresh).
 * @param {Awaited<ReturnType<typeof fetchSourceFile>>} [params.prefetched] - The file, when the caller already fetched it.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} The stored file's descriptor.
 */
export async function ingestFromSource({
  source,
  user,
  scope,
  ownerId,
  appConfig = null,
  policy = null,
  store = null,
  id = null,
  prefetched = null,
  signal
}) {
  const settings = policy || chatFilePolicy(appConfig);
  const fetched =
    prefetched ||
    (await fetchSourceFile({
      source,
      user,
      maxBytes: settings.quotas?.maxFileBytes ?? settings.maxFileBytes ?? 0,
      signal
    }));
  const mode =
    settings.storageMode === 'client_text_only' ? 'server_text_only' : settings.storageMode;
  return ingestChatFile({
    scope,
    ownerId,
    name: fetched.name,
    mimeType: fetched.contentType,
    buffer: fetched.bytes,
    origin: 'connector',
    // Only a task keeps its files fresh; a chat file is a snapshot.
    source: {
      kind: source.kind,
      ref: fetched.ref,
      ...(source.refreshOnRun === true && scope.type === 'task' ? { refreshOnRun: true } : {}),
      lastFetchedAt: new Date().toISOString(),
      ...(fetched.lastModified ? { sourceModified: fetched.lastModified } : {})
    },
    ...(id ? { id } : {}),
    appConfig,
    policy: { ...settings, storageMode: mode },
    store
  });
}

/**
 * Fetch again every file of a task that is kept fresh (`source.refreshOnRun`),
 * with the task owner's credentials, at the start of a run. A file that cannot be
 * refreshed (access revoked, document gone, system down) keeps its last stored
 * version; the run goes on and is told.
 *
 * Never throws.
 *
 * @param {string} taskId
 * @param {Object} user - The task owner as a principal.
 * @param {Object} [options]
 * @param {string|null} [options.ownerId] - Owner id the task's files are stored under (quotas).
 * @param {Object} [options.store]
 * @param {Object|null} [options.appConfig]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{fileId: string, name: string, status: 'refreshed'|'unchanged'|'failed', error?: string, code?: string}>>}
 */
export async function refreshTaskFiles(
  taskId,
  user,
  { ownerId = null, store = null, appConfig = null, signal } = {}
) {
  const repo = store || getChatFileRepository();
  if (!taskId || !repo?.isAvailable?.()) return [];
  const scope = { type: 'task', id: taskId };
  const results = [];
  let files;
  try {
    files = (await repo.list(scope)).filter(file => file.source?.refreshOnRun === true);
  } catch (error) {
    logger.warn('Could not list the task files to refresh', {
      component: COMPONENT,
      taskId,
      error: error.message
    });
    return [];
  }
  for (const file of files) {
    try {
      const before = file.sha256;
      const fetched = await fetchSourceFile({
        source: file.source,
        user,
        maxBytes: chatFilePolicy(appConfig).quotas.maxFileBytes,
        signal
      });
      const unchanged =
        before && (await sha256Of(fetched.bytes)) === before && file.hasOriginal === true;
      if (unchanged) {
        results.push({ fileId: file.id, name: file.name, status: 'unchanged' });
        continue;
      }
      await ingestFromSource({
        source: file.source,
        user,
        scope,
        ownerId: ownerId || user?.id || null,
        appConfig,
        store: repo,
        id: file.id,
        prefetched: fetched,
        signal
      });
      results.push({ fileId: file.id, name: file.name, status: 'refreshed' });
    } catch (error) {
      logger.warn(
        'A task file could not be refreshed from its source; keeping the stored version',
        {
          component: COMPONENT,
          taskId,
          fileId: file.id,
          kind: file.source?.kind,
          code: error.code,
          error: error.message
        }
      );
      results.push({
        fileId: file.id,
        name: file.name,
        status: 'failed',
        code: error.code || 'SOURCE_FAILED',
        error: error.message
      });
    }
  }
  return results;
}

async function sha256Of(buffer) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buffer).digest('hex');
}
