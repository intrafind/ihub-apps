// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an S3 or network failure means, in the storage layer's terms.
 *
 * Two outputs from one table: the {@link StorageError} a blob call rejects
 * with (`STORAGE_UNAVAILABLE` for everything an operator fixes outside iHub,
 * `IO_ERROR` for the rest), and the operator code a start-up check, a check
 * command or a status page shows (`S3_CREDENTIALS_REJECTED`, …).
 *
 * Nothing the remote side sent is put into a message: only the error name and
 * the HTTP status. The original error stays on `cause` for the log.
 *
 * @module storage/providers/s3/s3Errors
 */
import { StorageError } from '../../errors.js';

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO'
]);

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  // The endpoint's name resolved to an address the transport refuses.
  'ERR_ADDRESS_REFUSED'
]);

const TIMEOUT_NAMES = new Set(['TimeoutError', 'RequestTimeout', 'AbortError']);

/** HTTP status of an SDK error, or null. */
function statusOf(error) {
  const status = error?.$metadata?.httpStatusCode;
  return Number.isInteger(status) ? status : null;
}

/** The innermost system error code (`ECONNREFUSED`, a TLS code), or null. */
function systemCodeOf(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (typeof current.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(current.code)) {
      return current.code;
    }
  }
  return null;
}

/**
 * Whether a failed `GetObject` is the S3 answer "there is no object at that
 * key": an error body whose code is `NoSuchKey`.
 *
 * Only that. A 404 without that body comes from something else in front of
 * the bucket (a reverse proxy, an ingress, a wrong virtual host) and says
 * nothing about the object; read as "no blob" it would make an outage look
 * like an empty file. What is relied on: an S3-compatible server answers a
 * `GetObject` of a missing key with `<Error><Code>NoSuchKey</Code>…`, as AWS
 * S3, MinIO, Ceph RGW, Garage, SeaweedFS and versitygw do.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNoSuchKey(error) {
  if (!error || typeof error !== 'object') return false;
  return error.name === 'NoSuchKey' || error.Code === 'NoSuchKey' || error.code === 'NoSuchKey';
}

/**
 * Whether a failed `HeadObject` means "there is no object at that key".
 *
 * @param {unknown} error
 * @returns {boolean} True for `NoSuchKey`, and for `NotFound` (a HEAD carries
 *   no error body, so the SDK only has the status). False for `NoSuchBucket`.
 *   The caller confirms it with `HeadBucket`; a `GetObject` uses
 *   {@link isNoSuchKey} instead.
 */
export function isNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'NoSuchBucket') return false;
  return error.name === 'NoSuchKey' || error.name === 'NotFound';
}

/**
 * Classify a failure of an S3 call.
 *
 * @param {unknown} error - What the SDK or the socket threw.
 * @returns {{probeCode: string, storageCode: 'STORAGE_UNAVAILABLE'|'IO_ERROR', reason: string}}
 *   `probeCode` is the operator code; `reason` is the error name or system
 *   code and the HTTP status, safe to show.
 *
 * @example
 * classifyS3Error(Object.assign(new Error('x'), { name: 'NoSuchBucket' })).probeCode;
 * // 'S3_BUCKET_NOT_FOUND'
 */
export function classifyS3Error(error) {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  const status = statusOf(error);
  const systemCode = systemCodeOf(error);
  const reason = [systemCode || name, status ? `HTTP ${status}` : null].filter(Boolean).join(', ');
  const unavailable = probeCode => ({ probeCode, storageCode: 'STORAGE_UNAVAILABLE', reason });

  if (systemCode && TLS_CODES.has(systemCode)) return unavailable('S3_TLS_UNTRUSTED');
  if ((systemCode && NETWORK_CODES.has(systemCode)) || TIMEOUT_NAMES.has(name)) {
    return unavailable('S3_ENDPOINT_UNREACHABLE');
  }
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return unavailable('S3_CREDENTIALS_REJECTED');
  }
  if (name === 'RequestTimeTooSkewed') return unavailable('S3_CLOCK_SKEW');
  if (name === 'NoSuchBucket') return unavailable('S3_BUCKET_NOT_FOUND');
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed' || status === 301) {
    return unavailable('S3_REGION_MISMATCH');
  }
  if (name === 'AccessDenied' || status === 401 || status === 403) {
    return unavailable('S3_ACCESS_DENIED');
  }
  if (name === 'SlowDown' || name === 'ServiceUnavailable' || (status && status >= 500)) {
    return unavailable('S3_SERVICE_ERROR');
  }
  return { probeCode: 'S3_ERROR', storageCode: 'IO_ERROR', reason };
}

/**
 * The storage error a failed S3 call rejects with.
 *
 * @param {unknown} error - What the SDK threw.
 * @param {{op: string, ns?: string, key?: string}} where - The blob call.
 * @returns {StorageError} With `probeCode` and `reason` from {@link classifyS3Error}.
 */
export function mapS3Error(error, { op, ns, key } = {}) {
  if (error instanceof StorageError) return error;
  const { probeCode, storageCode, reason } = classifyS3Error(error);
  const target = [ns, key].filter(Boolean).join('/');
  const mapped = new StorageError(
    `S3 ${op}${target ? ` of blob ${target}` : ''} failed (${probeCode}: ${reason})`,
    { code: storageCode, cause: error }
  );
  mapped.probeCode = probeCode;
  mapped.reason = reason;
  return mapped;
}

/**
 * What of an SDK error may be logged: its name, status and request id. Never
 * the error itself, which can carry request input.
 *
 * @param {unknown} error
 * @returns {{name: string, status: number|null, requestId: string|null, systemCode: string|null}}
 */
export function describeS3Error(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    status: statusOf(error),
    requestId: error?.$metadata?.requestId || null,
    systemCode: systemCodeOf(error)
  };
}
