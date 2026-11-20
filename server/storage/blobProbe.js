// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The blob storage check: named steps, one classified result.
 *
 * The same check runs in three places, so they can never disagree: at start
 * (a failure stops the server), in a command that runs without the server,
 * and behind an admin status page. Each backend supplies the steps; this
 * module runs them, stops at the first failure and says which step failed and
 * why, as one code from one table ({@link classifyBlobError}).
 *
 * Codes an operator sees:
 *
 * | Code | Meaning |
 * | --- | --- |
 * | `S3_CONFIG_INCOMPLETE` | a `storage.blobs.s3` setting is missing or malformed |
 * | `S3_ENDPOINT_UNREACHABLE` | DNS failure, connection refused, timeout, proxy error |
 * | `S3_TLS_UNTRUSTED` | certificate not verifiable, self-signed, host name mismatch |
 * | `S3_CREDENTIALS_REJECTED` | the access key or its signature was rejected |
 * | `S3_CLOCK_SKEW` | the clocks of iHub and the S3 service differ too much |
 * | `S3_BUCKET_NOT_FOUND` | the bucket does not exist (iHub never creates one) |
 * | `S3_ACCESS_DENIED` | the access key may not list, read, write or delete |
 * | `S3_REGION_MISMATCH` | the bucket is in another region |
 * | `S3_SERVICE_ERROR` | the S3 service answered 5xx or asked to slow down |
 * | `S3_PROBE_MISMATCH` | a test object did not read back as written |
 * | `S3_ERROR` | any other S3 failure |
 * | `BLOB_KEY_MISSING` | no master key is available, or it could not be saved |
 * | `BLOB_KEY_MISMATCH` | the store was written with another master key |
 * | `BLOB_KEY_CHECK_MISSING` | the store holds objects but no key check object |
 * | `BLOB_CORRUPT` | a stored object is not an encrypted blob of this store |
 * | `BLOB_PROVIDER_UNKNOWN` | `storage.blobs.provider` names no known backend |
 * | `BLOB_STORAGE_ERROR` | anything else |
 *
 * @module storage/blobProbe
 */
import { CorruptBlobError, KeyUnavailableError, StorageError } from './errors.js';

/**
 * One step of a check.
 *
 * @typedef {Object} BlobProbeStep
 * @property {string} name - `config`, `key`, `connect`, `keycheck`, `roundtrip`.
 * @property {'ok'|'failed'|'skipped'} status
 * @property {number} latencyMs
 * @property {string} [code] - Operator code, when failed.
 * @property {string} [detail] - One sentence, when failed or worth noting.
 */

/**
 * The outcome of a check.
 *
 * @typedef {Object} BlobProbeResult
 * @property {'ok'|'error'} status
 * @property {string} provider - Blob backend name: `default`, `s3`.
 * @property {BlobProbeStep[]} steps - In the order they ran.
 * @property {{code: string, detail: string, step: string}|null} error - The
 *   first failure. `detail` is written by iHub and holds no secret and no
 *   text the remote side sent.
 * @property {number} latencyMs - The whole check.
 * @property {string} checkedAt - ISO-8601.
 * @property {Object} [location] - Where the blobs are, without credentials.
 */

/**
 * The operator code and sentence for a failure of the blob storage.
 *
 * @param {unknown} error - A thrown value, usually a {@link StorageError}.
 * @returns {{code: string, detail: string}}
 *
 * @example
 * classifyBlobError(new KeyUnavailableError('x', { keyId: 'ab12cd34' })).code; // 'BLOB_KEY_MISMATCH'
 */
export function classifyBlobError(error) {
  const detail =
    error instanceof StorageError && typeof error.message === 'string'
      ? error.message
      : 'The blob storage check failed unexpectedly';
  if (typeof error?.probeCode === 'string') return { code: error.probeCode, detail };
  if (error instanceof KeyUnavailableError) {
    const missing = error.cause?.reason === 'not-initialized' || error.keyMissing === true;
    return { code: missing ? 'BLOB_KEY_MISSING' : 'BLOB_KEY_MISMATCH', detail };
  }
  if (error instanceof CorruptBlobError) return { code: 'BLOB_CORRUPT', detail };
  if (error?.code === 'KEY_CHECK_MISSING') return { code: 'BLOB_KEY_CHECK_MISSING', detail };
  if (error?.code === 'UNKNOWN_PROVIDER') return { code: 'BLOB_PROVIDER_UNKNOWN', detail };
  if (error?.code === 'INVALID_STORAGE_CONFIG') return { code: 'S3_CONFIG_INCOMPLETE', detail };
  return { code: 'BLOB_STORAGE_ERROR', detail };
}

/**
 * Run the steps of a check in order and stop at the first that throws.
 * Never rejects.
 *
 * @param {Object} options
 * @param {string} options.provider - Blob backend name.
 * @param {Array<{name: string, run: () => Promise<string|void>}>} options.steps -
 *   A step may resolve with a sentence worth showing (`detail`).
 * @param {Object} [options.location] - Copied into the result.
 * @returns {Promise<BlobProbeResult>}
 */
export async function runBlobProbe({ provider, steps, location }) {
  const startedAt = Date.now();
  const outcome = [];
  let failure = null;
  for (const step of steps) {
    if (failure) {
      outcome.push({ name: step.name, status: 'skipped', latencyMs: 0 });
      continue;
    }
    const stepStartedAt = Date.now();
    try {
      const detail = await step.run();
      outcome.push({
        name: step.name,
        status: 'ok',
        latencyMs: Date.now() - stepStartedAt,
        ...(typeof detail === 'string' && detail ? { detail } : {})
      });
    } catch (error) {
      const classified = classifyBlobError(error);
      failure = { ...classified, step: step.name };
      outcome.push({
        name: step.name,
        status: 'failed',
        latencyMs: Date.now() - stepStartedAt,
        ...classified
      });
    }
  }
  return {
    status: failure ? 'error' : 'ok',
    provider,
    steps: outcome,
    error: failure,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    ...(location ? { location } : {})
  };
}

/**
 * The result of a check that could not even build its backend (a setting is
 * missing, the backend is unknown), in the same shape as one that ran.
 *
 * @param {string} provider - Blob backend name as configured.
 * @param {unknown} error - What building the backend threw.
 * @returns {BlobProbeResult}
 */
export function failedBlobProbe(provider, error) {
  const classified = classifyBlobError(error);
  return {
    status: 'error',
    provider,
    steps: [{ name: 'config', status: 'failed', latencyMs: 0, ...classified }],
    error: { ...classified, step: 'config' },
    latencyMs: 0,
    checkedAt: new Date().toISOString()
  };
}

/**
 * The error a failed check stops the storage bootstrap with.
 *
 * @param {BlobProbeResult} result - A result with `status: 'error'`.
 * @returns {StorageError} Code `STORAGE_UNAVAILABLE`, with `probeCode` and the
 *   whole result on `probe`.
 */
export function blobProbeError(result) {
  const { code, detail, step } = result.error;
  const error = new StorageError(
    `Blob storage (${result.provider}) check failed at step "${step}" (${code}): ${detail}`,
    { code: 'STORAGE_UNAVAILABLE' }
  );
  error.probeCode = code;
  error.probe = result;
  return error;
}
