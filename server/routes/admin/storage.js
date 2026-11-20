// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → System resources → "Blob storage": where the blobs of the running
 * server are kept, whether that backend answers, how the content is
 * encrypted, and whether the saved configuration differs from the running
 * one. Read-only; the backend is configured in `platform.json`.
 *
 * Everything the page shows is decided here. The client renders `provider`,
 * `status`, `encryption.scope` and the rest as sent and infers nothing from a
 * provider name.
 *
 * Never in a response: the access key ID, the secret key (not even redacted),
 * or the endpoint URL. The endpoint is its host (and port) only.
 *
 * The check result is the one the blob backend holds (`lastProbe`). A read
 * refreshes it when it is older than a minute, at most one check at a time per
 * server process; in a cluster every worker keeps its own result.
 */
import path from 'node:path';
import { loadJson } from '../../configLoader.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { getRootDir } from '../../pathUtils.js';
import { blobErrorHint } from '../../storage/blobOperatorGuide.js';
import * as storageBootstrap from '../../storage/bootstrap.js';
import {
  DEFAULT_BLOB_BACKEND,
  createBlobBackend,
  resolveBlobStorageConfig,
  resolveStorageConfig
} from '../../storage/index.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { ServiceError } from '../../utils/ServiceError.js';

const COMPONENT = 'AdminStorage';

/** A held check result older than this is refreshed on the next read. */
export const PROBE_MAX_AGE_MS = 60_000;

/** How long a read waits for a refresh before it answers with what it holds. */
export const PROBE_WAIT_MS = 2_000;

/**
 * A host name with its port, from a host or a URL, without scheme, user info,
 * path or query. Defence in depth: the backend already reports the host only.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 *
 * @example
 * hostOnly('https://key:secret@s3.example.internal:9000/bucket?x=1'); // 's3.example.internal:9000'
 */
export function hostOnly(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Where the blobs are, as the page may show it.
 *
 * @param {Object} provider - The running storage provider.
 * @param {Object} backend - Its blob backend.
 * @param {Object} description - `backend.describe()`.
 * @returns {Object} `{ endpointHost, bucket, region, prefix }` for a remote
 *   backend, `{ path }` for blobs the storage provider keeps itself.
 */
function describeLocation(provider, backend, description) {
  if (backend.remote) {
    const { endpointHost, bucket, region, prefix } = description.location || {};
    const host = hostOnly(endpointHost);
    return {
      ...(host ? { endpointHost: host } : {}),
      ...(typeof bucket === 'string' ? { bucket } : {}),
      ...(typeof region === 'string' ? { region } : {}),
      ...(typeof prefix === 'string' ? { prefix } : {})
    };
  }
  const baseDir = typeof provider.baseDir === 'string' ? provider.baseDir : null;
  if (!baseDir) return {};
  const blobDir = path.join(baseDir, 'blobs');
  const relative = path.relative(getRootDir(), blobDir);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return { path: inside ? relative.split(path.sep).join('/') : blobDir };
}

/** A plain object without the members that are null or undefined. */
function withoutNulls(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== null && member !== undefined)
  );
}

/**
 * Encryption at rest of the running storage, for the whole installation:
 * whether the switch is on, what it covers (`none`, `blobs`, `storage`) and
 * how far the one-time conversion of existing data has come.
 *
 * The provider answers this itself (`describeEncryption()`, which is also
 * what `describeStorageEncryption()` of `storage/bootstrap.js` reads). For a
 * provider that does not, it is derived from the running blob backend, and
 * from the saved configuration when there is none.
 *
 * @param {Object} provider - The running storage provider.
 * @param {Object|null} backend - Its blob backend.
 * @param {{enabled: boolean}} configured - `storage.encryption` as saved.
 * @returns {{enabled: boolean, scope: string, conversion: Object, sealedDataExists?: boolean}}
 */
function describeEncryption(provider, backend, configured) {
  try {
    const described =
      typeof provider.describeEncryption === 'function'
        ? provider.describeEncryption()
        : storageBootstrap.getStorage?.() === provider &&
            typeof storageBootstrap['describeStorageEncryption'] === 'function'
          ? storageBootstrap['describeStorageEncryption']()
          : null;
    if (described && typeof described === 'object') {
      // The blob backend knows what it writes: blobs that are encrypted are
      // never reported as "none" because the provider does not count them.
      const blobsEncrypted = backend?.describe?.().encryption?.scope === 'all';
      const enabled = described.enabled === true || blobsEncrypted;
      const conversion =
        described.conversion && typeof described.conversion === 'object'
          ? withoutNulls(described.conversion)
          : { state: typeof described.conversion === 'string' ? described.conversion : 'none' };
      return {
        enabled,
        scope:
          typeof described.scope === 'string' && !(described.scope === 'none' && blobsEncrypted)
            ? described.scope
            : enabled
              ? 'blobs'
              : 'none',
        conversion,
        ...(typeof described.sealedDataExists === 'boolean'
          ? { sealedDataExists: described.sealedDataExists }
          : {})
      };
    }
  } catch (error) {
    logger.warn('The storage encryption status could not be read', {
      component: COMPONENT,
      error: error.message
    });
  }
  let enabled = configured?.enabled === true;
  try {
    const scope = backend?.describe?.().encryption?.scope;
    if (typeof scope === 'string') enabled = scope !== 'none';
  } catch {
    // Keep what the configuration says.
  }
  return { enabled, scope: enabled ? 'blobs' : 'none', conversion: { state: 'none' } };
}

/**
 * Whether a restart would bring up another blob storage than the running one:
 * another provider for documents, another blob backend, another bucket,
 * prefix, region or endpoint, or another encryption setting. Changed
 * credentials and timeouts are not visible here.
 *
 * @param {Object} provider - The running storage provider.
 * @param {Object} backend - Its blob backend.
 * @param {Object} platformConfig - `platform.json` as saved (raw file).
 * @param {Object} env
 * @returns {{restartRequired: boolean, configuredBlobProvider: string,
 *   configured: ReturnType<typeof resolveBlobStorageConfig>}}
 */
function compareWithSaved(provider, backend, platformConfig, env) {
  const configured = resolveBlobStorageConfig(platformConfig, env);
  const running = backend.describe();
  let differs =
    configured.provider !== backend.name ||
    resolveStorageConfig(platformConfig, env).provider !== provider.name ||
    configured.encryption.enabled !== (running.encryption?.scope !== 'none');
  if (!differs && configured.provider !== DEFAULT_BLOB_BACKEND) {
    try {
      // Building a backend validates the block and does no I/O.
      const saved = createBlobBackend(configured.provider, configured.config, {
        platformConfig: configured.platformConfig,
        locks: null,
        encryption: configured.encryption,
        loadKeys: () => import('../../crypto/KeyProvider.js'),
        env
      }).describe();
      differs =
        JSON.stringify(saved.location) !== JSON.stringify(running.location) ||
        saved.maxObjectBytes !== running.maxObjectBytes;
    } catch {
      // The saved block is not valid: it is not what the server runs with.
      differs = true;
    }
  }
  return {
    restartRequired: differs,
    configuredBlobProvider:
      configured.provider === DEFAULT_BLOB_BACKEND
        ? resolveStorageConfig(platformConfig, env).provider
        : configured.provider,
    configured
  };
}

/**
 * The status reader behind both routes.
 *
 * @param {Object} [deps] - Replaceable for tests.
 * @param {() => Object|null} [deps.getProvider] - The running storage provider.
 * @param {() => Promise<Object|null>} [deps.loadPlatformConfig] - `platform.json`
 *   as a start reads it (the raw file).
 * @param {Object} [deps.env=process.env]
 * @param {() => number} [deps.now=Date.now]
 * @param {number} [deps.maxAgeMs] - See {@link PROBE_MAX_AGE_MS}.
 * @param {number} [deps.waitMs] - See {@link PROBE_WAIT_MS}.
 * @returns {{read: () => Promise<Object>, test: () => Promise<Object>}}
 */
export function createStorageStatusReader({
  getProvider = storageBootstrap.getStorage,
  loadPlatformConfig = () => loadJson('config/platform.json'),
  env = process.env,
  now = Date.now,
  maxAgeMs = PROBE_MAX_AGE_MS,
  waitMs = PROBE_WAIT_MS
} = {}) {
  /** The check in flight per backend, so concurrent callers share one. */
  const inFlight = new WeakMap();
  /** When a check of a backend was last started here. */
  const startedAt = new WeakMap();

  /** Run the backend's check, one at a time. Never rejects. */
  function check(backend) {
    let pending = inFlight.get(backend);
    if (!pending) {
      startedAt.set(backend, now());
      pending = Promise.resolve()
        .then(() => backend.probe())
        .catch(error => {
          // `probe()` does not reject; a backend that does is reported, not thrown.
          logger.warn('The blob storage check could not run', {
            component: COMPONENT,
            error: error.message
          });
          return null;
        })
        .finally(() => inFlight.delete(backend));
      inFlight.set(backend, pending);
    }
    return pending;
  }

  /** The running provider and its blob backend, or a 503. */
  function running() {
    const provider = getProvider();
    if (!provider) {
      throw new ServiceError('STORAGE_UNAVAILABLE', 'The storage provider is not running');
    }
    return { provider, backend: provider.blobBackendHandle || null };
  }

  /** The response body from what the backend holds now. */
  async function describe(provider, backend) {
    const platformConfig = (await loadPlatformConfig()) || {};
    if (!backend) {
      // A provider that was not composed with a blob backend (a test double).
      const configured = resolveBlobStorageConfig(platformConfig, env);
      return {
        blobs: { provider: provider.name, status: 'unknown', source: configured.source },
        documents: { provider: provider.name },
        restartRequired: false,
        configuredBlobProvider: provider.name,
        localLeftovers: [],
        encryption: describeEncryption(provider, null, configured.encryption)
      };
    }
    const description = backend.describe();
    const probe = backend.lastProbe;
    const { restartRequired, configuredBlobProvider, configured } = compareWithSaved(
      provider,
      backend,
      platformConfig,
      env
    );
    const { scope, format, keyProvider } = description.encryption || {};
    return {
      blobs: {
        // The page names the place: the storage provider itself, or the backend.
        provider: backend.remote ? backend.name : provider.name,
        status: probe?.status || 'unknown',
        ...(probe ? { latencyMs: probe.latencyMs, checkedAt: probe.checkedAt } : {}),
        location: describeLocation(provider, backend, description),
        encryption: {
          scope: typeof scope === 'string' ? scope : 'none',
          ...(format ? { format } : {}),
          ...(keyProvider ? { keySource: keyProvider } : {})
        },
        // What decided the running backend: the environment is fixed for the
        // life of the process, so this is the saved file's answer otherwise.
        source: configured.source,
        ...(probe?.error
          ? {
              error: {
                code: probe.error.code,
                detail: probe.error.detail,
                step: probe.error.step,
                hint: blobErrorHint(probe.error.code)
              }
            }
          : {}),
        steps: (probe?.steps || []).map(({ name, status, latencyMs, code, detail }) => ({
          name,
          status,
          latencyMs,
          ...(code ? { code } : {}),
          ...(detail ? { detail } : {})
        }))
      },
      documents: { provider: provider.name },
      restartRequired,
      configuredBlobProvider,
      localLeftovers: Array.isArray(provider.localBlobLeftovers) ? provider.localBlobLeftovers : [],
      encryption: describeEncryption(provider, backend, configured.encryption)
    };
  }

  return {
    /**
     * The held status, refreshed first when it is older than `maxAgeMs`. A
     * refresh that takes longer than `waitMs` continues in the background and
     * the held result is answered.
     */
    async read() {
      const { provider, backend } = running();
      if (backend) {
        const checkedAt = Date.parse(backend.lastProbe?.checkedAt || '');
        const last = Math.max(Number.isNaN(checkedAt) ? 0 : checkedAt, startedAt.get(backend) || 0);
        if (inFlight.has(backend) || now() - last >= maxAgeMs) {
          let timer;
          await Promise.race([
            check(backend),
            new Promise(resolve => {
              timer = setTimeout(resolve, waitMs);
              timer.unref?.();
            })
          ]);
          clearTimeout(timer);
        }
      }
      return describe(provider, backend);
    },

    /** Run the check now and answer with its result. */
    async test() {
      const { provider, backend } = running();
      if (!backend) {
        throw new ServiceError(
          'STORAGE_UNAVAILABLE',
          'The running storage provider has no blob backend that could be tested'
        );
      }
      await check(backend);
      return describe(provider, backend);
    }
  };
}

/**
 * Register the blob storage status routes.
 *
 * @param {import('express').Application} app
 * @param {Parameters<typeof createStorageStatusReader>[0]} [deps] - For tests.
 * @returns {void}
 */
export default function registerAdminStorageRoutes(app, deps = {}) {
  const status = createStorageStatusReader(deps);

  /**
   * @swagger
   * /api/admin/storage:
   *   get:
   *     summary: Status of the blob storage
   *     description: |
   *       Where the running server keeps its blobs (uploaded files, extracted
   *       text, evidence content, artifacts, website corpora), how the last
   *       check of that backend went, how the content is encrypted, and whether
   *       the saved configuration differs from the running one.
   *
   *       The check result is held by the server and refreshed at most once a
   *       minute; reading this endpoint does not contact the backend on every
   *       call. The response holds no credential, and the endpoint only as a
   *       host name.
   *     tags:
   *       - Admin
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: The status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 blobs:
   *                   type: object
   *                   properties:
   *                     provider:
   *                       type: string
   *                       description: The storage provider's name (`filesystem`) or the blob backend (`s3`)
   *                     status:
   *                       type: string
   *                       enum: [ok, degraded, error, unknown]
   *                     latencyMs:
   *                       type: integer
   *                     checkedAt:
   *                       type: string
   *                       format: date-time
   *                     location:
   *                       type: object
   *                       description: "`endpointHost`, `bucket`, `region`, `prefix` for S3; `path` for local disk"
   *                     encryption:
   *                       type: object
   *                       description: "`scope` (`all` or `none`), `format`, `keySource`"
   *                     source:
   *                       type: string
   *                       enum: [environment, platform.json, default]
   *                     error:
   *                       type: object
   *                       description: "Present when the check failed: `code`, `detail`, `step`, `hint`"
   *                     steps:
   *                       type: array
   *                       items:
   *                         type: object
   *                 documents:
   *                   type: object
   *                   description: "`provider`: where chats, logs and locks are kept"
   *                 restartRequired:
   *                   type: boolean
   *                 configuredBlobProvider:
   *                   type: string
   *                 localLeftovers:
   *                   type: array
   *                   description: Namespaces that still hold blobs on local disk while another backend is active
   *                   items:
   *                     type: object
   *                     properties:
   *                       namespace:
   *                         type: string
   *                       count:
   *                         type: integer
   *                       capped:
   *                         type: boolean
   *                 encryption:
   *                   type: object
   *                   description: "`enabled`, `scope` (`none`, `blobs`, `storage`), `conversion` (`state`: `none`, `off`, `converting`, `complete`; `facets`, `skipped`, `keyId`, `completedAt`), `sealedDataExists`"
   *       403:
   *         description: Not an administrator (`FORBIDDEN`)
   *       503:
   *         description: The storage provider is not running (`STORAGE_UNAVAILABLE`)
   */
  app.get(buildServerPath('/api/admin/storage'), adminAuth, async (req, res) => {
    const body = await status.read();
    res.set('Cache-Control', 'no-store');
    res.json(body);
  });

  /**
   * @swagger
   * /api/admin/storage/_test:
   *   post:
   *     summary: Test the running blob storage now
   *     description: |
   *       Runs the check of the running blob backend: the master key, the
   *       connection, the key check object, and a test object that is written,
   *       read back, compared and removed. Answers 200 with the same body as
   *       `GET /api/admin/storage` whether the check passed or failed
   *       (`blobs.status`, `blobs.error`); only a test that could not run is an
   *       error. Takes no body. Concurrent calls share one check.
   *     tags:
   *       - Admin
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: The test ran; `blobs.status` reports the outcome
   *       403:
   *         description: Not an administrator (`FORBIDDEN`)
   *       503:
   *         description: The storage provider is not running (`STORAGE_UNAVAILABLE`)
   */
  app.post(buildServerPath('/api/admin/storage/_test'), adminAuth, async (req, res) => {
    const body = await status.test();
    res.set('Cache-Control', 'no-store');
    res.json(body);
  });
}
