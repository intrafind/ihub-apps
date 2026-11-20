// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an operator or admin is told about a blob storage check: a label for
 * each step and, for each code of `classifyBlobError`, what to do about it.
 *
 * The code and the sentence (`detail`) come from the check itself
 * (`blobProbe.js`); this module only adds the words around them, so the check
 * command, the copy command and the admin status say the same thing. Command
 * output and the API are English; the admin page has its own translated hints
 * under `admin.systemResources.blobStorage.hints.<code>` and falls back to the
 * ones here.
 *
 * @module storage/blobOperatorGuide
 */

/** What each step of a check verifies, as a short label. */
export const BLOB_PROBE_STEP_LABELS = Object.freeze({
  config: 'Configuration complete',
  key: 'Master key available',
  connect: 'Endpoint reachable, credentials accepted, bucket found',
  keycheck: 'Encryption key matches the stored blobs',
  detect: 'Looked for blobs encrypted earlier',
  roundtrip: 'Write, read back and delete a test object',
  leftovers: 'No blobs left on local disk'
});

/** What to do about each failure code. */
export const BLOB_ERROR_HINTS = Object.freeze({
  S3_CONFIG_INCOMPLETE:
    'Correct the setting under storage.blobs.s3 in contents/config/platform.json, or set the environment variable it refers to.',
  S3_ENDPOINT_UNREACHABLE: 'Check the endpoint URL, the network path and the proxy settings.',
  S3_TLS_UNTRUSTED:
    "Add the issuing CA to the server's trust store (NODE_EXTRA_CA_CERTS), or add the host to Admin → Security → SSL → Domain Whitelist.",
  S3_CREDENTIALS_REJECTED:
    'Check the access key ID and the secret key. A secret with a trailing space or line break also causes this.',
  S3_CLOCK_SKEW: 'Synchronize the time on the iHub server.',
  S3_BUCKET_NOT_FOUND:
    'iHub does not create buckets. Create the bucket, or correct storage.blobs.s3.bucket.',
  S3_ACCESS_DENIED:
    'The access key needs permission to list, read, write and delete objects in this bucket.',
  S3_REGION_MISMATCH: "Set storage.blobs.s3.region to the bucket's region.",
  S3_SERVICE_ERROR:
    'The S3 service answered with an error or asked to slow down. Check the S3 service and try again.',
  S3_PROBE_MISMATCH:
    'The S3 service or something between it and iHub changes the data. Blob storage cannot be used like this.',
  S3_ERROR: 'See the server log for the cause.',
  BLOB_KEY_MISSING:
    'Restore contents/.encryption-key from a backup or set TOKEN_ENCRYPTION_KEY. Without the key the stored files cannot be read.',
  BLOB_KEY_MISMATCH:
    'Restore the original key, set it as TOKEN_ENCRYPTION_KEY_PREVIOUS, or use an empty bucket or prefix for a new installation.',
  BLOB_KEY_CHECK_MISSING:
    'Use an empty bucket or prefix, or set IHUB_S3_ADOPT_BUCKET=true for one start to adopt the objects as they are.',
  BLOB_CORRUPT:
    'Use one bucket or prefix per installation. If the object was changed, restore it from a backup of the bucket.',
  BLOB_PROVIDER_UNKNOWN: 'Set storage.blobs.provider to "default" or "s3".',
  BLOB_STORAGE_ERROR: 'See the server log for the cause.'
});

/**
 * The label of a check step; the step's own name when it has none.
 *
 * @param {string} name - Step name: `config`, `key`, `connect`, …
 * @returns {string}
 */
export function blobProbeStepLabel(name) {
  return Object.hasOwn(BLOB_PROBE_STEP_LABELS, name) ? BLOB_PROBE_STEP_LABELS[name] : String(name);
}

/**
 * What to do about a failure code.
 *
 * @param {string} code - A code of `classifyBlobError`.
 * @returns {string} The hint, or the generic one for a code without its own.
 *
 * @example
 * blobErrorHint('S3_CLOCK_SKEW'); // 'Synchronize the time on the iHub server.'
 */
export function blobErrorHint(code) {
  return Object.hasOwn(BLOB_ERROR_HINTS, code)
    ? BLOB_ERROR_HINTS[code]
    : BLOB_ERROR_HINTS.BLOB_STORAGE_ERROR;
}
