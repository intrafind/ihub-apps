// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The S3 blob backend: the S3 store, the encrypting store in front of it, and
 * the check that both are usable.
 *
 * This is the only place that puts the two together, and it only ever hands
 * out the encrypting store. With `storage.encryption.enabled` everything that
 * reaches the bucket through `backend.blobs` is ciphertext, a plaintext object
 * in the bucket is refused on read, and a key check object ties the bucket to
 * the master key. With encryption off, blobs are uploaded as they are (a
 * warning says so at every start), blobs encrypted earlier are still
 * decrypted, and the key check object is not used.
 *
 * @module storage/providers/s3/createS3BlobBackend
 */
import logger from '../../../utils/logger.js';
import { FORMAT_ID } from '../../../crypto/streamingAead.js';
import { EncryptingBlobStore, maxStoredBytes } from '../../EncryptingBlobStore.js';
import { blobProbeError, runBlobProbe } from '../../blobProbe.js';
import { StorageError } from '../../errors.js';
import { blobRoundTrip, checkMasterKey } from '../../localBlobBackend.js';
import { INTERNAL_BLOB_NAMESPACE } from '../../namespaces.js';
import { S3BlobStore } from './S3BlobStore.js';
import { createS3Client } from './s3Client.js';
import { DEV_ACCESS_KEY_ID, isLoopbackHost, resolveS3BlobConfig } from './s3Config.js';

const COMPONENT = 'BlobStorage';

/** Registry name of this backend. */
export const S3_BLOB_BACKEND = 's3';

/** Environment switch that adopts a bucket holding objects but no key check, for one start. */
export const ADOPT_BUCKET_ENV_VAR = 'IHUB_S3_ADOPT_BUCKET';

/**
 * Build the S3 blob backend from `storage.blobs.s3`.
 *
 * Validates the block and throws on a wrong one; does no I/O. The client is
 * built, the stored secret decrypted and the master key loaded on first use.
 *
 * @param {Object} rawConfig - `storage.blobs.s3`, `${VAR}` placeholders resolved.
 * @param {Object} [context]
 * @param {Object} [context.platformConfig] - `{ ssl, proxy }` for the transport.
 * @param {Object|null} [context.locks] - Lock manager for `delete`.
 * @param {Object} [context.env] - Read for {@link ADOPT_BUCKET_ENV_VAR}.
 * @param {{enabled: boolean, plaintextReads?: 'reject'|'accept'}} [context.encryption] -
 *   `storage.encryption`. Enabled and strict when omitted.
 * @param {() => Promise<Object>} context.loadKeys - Resolves with the key
 *   module (`crypto/KeyProvider.js`): `ensureMasterKey`, `getKeyProvider`,
 *   `openConfigSecret`. Loaded lazily because it reads the contents directory.
 * @param {(config: Object, options: Object) => Promise<Object>} [context.createClient] -
 *   Client factory (tests); `createS3Client` by default.
 * @returns {import('../../blobBackends.js').BlobBackend}
 * @throws {StorageError} Code `INVALID_STORAGE_CONFIG` for a wrong block.
 */
export function createS3BlobBackend(rawConfig, context = {}) {
  const {
    platformConfig = {},
    locks = null,
    env = process.env,
    encryption = { enabled: true, plaintextReads: 'reject' },
    loadKeys,
    createClient = createS3Client
  } = context;
  const enabled = encryption?.enabled !== false;
  if (typeof loadKeys !== 'function') {
    throw new StorageError('The S3 blob backend needs access to the key provider', {
      code: 'INVALID_PROVIDER'
    });
  }
  // The secret stays as stored until the client is built: opening it needs
  // the master key, which is I/O.
  const config = resolveS3BlobConfig(rawConfig);

  /** @type {Object|null} The key module, once loaded. */
  let keys = null;
  let transport = null;
  let initialized = false;
  let initializing = null;
  let lastProbe = null;

  const store = new S3BlobStore({
    bucket: config.bucket,
    prefix: config.prefix,
    locks,
    endpointHost: config.endpointHost,
    maxObjectBytes: maxStoredBytes(config.maxObjectBytes),
    requestTimeoutMs: config.requestTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    maxAttempts: config.maxAttempts,
    connect: async () => {
      keys = keys || (await loadKeys());
      await keys.ensureMasterKey();
      const opened = resolveS3BlobConfig(rawConfig, { openSecret: keys.openConfigSecret });
      const connection = await createClient(opened, { platformConfig });
      transport = connection.transport || null;
      return connection;
    }
  });

  const blobs = new EncryptingBlobStore({
    inner: store,
    encryptWrites: enabled,
    plaintextReads: encryption?.plaintextReads || 'reject',
    maxBlobBytes: config.maxObjectBytes,
    // The platform's key provider. Resolved per use, and only once the key
    // module is loaded: before that there is no key and nothing is written.
    keyProvider: () => {
      if (!keys) throw new Error('the blob storage has not been initialized');
      return keys.getKeyProvider();
    }
  });

  const location = Object.freeze({
    endpointHost: config.endpointHost,
    bucket: config.bucket,
    region: config.region,
    prefix: store.basePrefix
  });

  /** Verify or write the key check object. */
  async function ensureKeyCheck({ adopt = false, create = true } = {}) {
    keys = keys || (await loadKeys());
    await keys.ensureMasterKey();
    return blobs.verifyKey({
      hasOtherObjects: () => store.hasObjectsOutside(INTERNAL_BLOB_NAMESPACE),
      create,
      adopt
    });
  }

  async function probe({ createKeyCheck = false, adopt = false } = {}) {
    const connect = { name: 'connect', run: () => store.headBucket() };
    const roundTrip = { name: 'roundtrip', run: () => blobRoundTrip(blobs, store) };
    lastProbe = await runBlobProbe({
      provider: S3_BLOB_BACKEND,
      location,
      steps: enabled
        ? [
            {
              name: 'key',
              run: async () => {
                keys = keys || (await loadKeys());
                return checkMasterKey(keys);
              }
            },
            connect,
            {
              name: 'keycheck',
              run: async () => {
                const { status } = await ensureKeyCheck({ adopt, create: createKeyCheck });
                return status === 'absent'
                  ? 'no key check object yet; the first start writes it'
                  : `key check object ${status}`;
              }
            },
            roundTrip
          ]
        : [
            connect,
            {
              // Not a key check: only whether blobs encrypted earlier exist,
              // which decides whether reads have to look for envelopes.
              name: 'detect',
              run: async () =>
                (await blobs.detectEnvelopes())
                  ? 'encrypted blobs from an earlier configuration exist and are still decrypted'
                  : 'no encrypted blobs'
            },
            roundTrip
          ]
    });
    return lastProbe;
  }

  async function initialize() {
    if (initialized) return;
    if (!initializing) {
      initializing = (async () => {
        const adopt = String(env?.[ADOPT_BUCKET_ENV_VAR] || '').toLowerCase() === 'true';
        const result = await probe({ createKeyCheck: true, adopt });
        const where = { component: COMPONENT, provider: S3_BLOB_BACKEND, ...location };
        if (result.status !== 'ok') {
          logger.error('Blob storage check failed', {
            ...where,
            code: result.error.code,
            step: result.error.step,
            detail: result.error.detail
          });
          throw blobProbeError(result);
        }
        if (config.insecureHttp && !isLoopbackHost(new URL(config.endpoint).hostname)) {
          logger.warn(
            'The S3 endpoint uses plain http (storage.blobs.s3.allowInsecureHttp): object names travel in clear text and signed requests can be replayed',
            where
          );
        }
        if (
          config.accessKeyId === DEV_ACCESS_KEY_ID &&
          !isLoopbackHost(new URL(config.endpoint).hostname)
        ) {
          logger.warn(
            'The S3 access key is the one of the local development server, used against another host',
            where
          );
        }
        if (!enabled) {
          logger.warn(
            'Blobs are uploaded to S3 without encryption (storage.encryption.enabled is false): whoever can read the bucket can read the files',
            { ...where, code: 'BLOB_ENCRYPTION_OFF' }
          );
        }
        logger.info(
          enabled
            ? 'Blob storage ready: every blob is encrypted before upload'
            : 'Blob storage ready',
          {
            ...where,
            latencyMs: result.latencyMs,
            proxy: transport?.routing?.decision,
            tlsVerification: transport?.tlsBypass ? 'skipped (ssl.domainWhitelist)' : 'on'
          }
        );
        initialized = true;
      })().finally(() => {
        initializing = null;
      });
    }
    return initializing;
  }

  return {
    name: S3_BLOB_BACKEND,
    remote: true,
    blobs,
    initialize,
    probe,
    ensureKeyCheck: ({ adopt = false } = {}) => ensureKeyCheck({ adopt, create: true }),
    get lastProbe() {
      return lastProbe;
    },
    describe: () => ({
      provider: S3_BLOB_BACKEND,
      location,
      encryption: enabled
        ? { scope: 'all', format: FORMAT_ID, keyProvider: 'local-file' }
        : { scope: 'none' },
      maxObjectBytes: config.maxObjectBytes
    }),
    shutdown: () => store.destroy()
  };
}
