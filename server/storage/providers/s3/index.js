// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * S3 blob backend — module entry point.
 *
 * Importing this module has no side effect on a registry and does not load
 * the AWS SDK; `registerBlobBackend('s3', …)` lives in `server/storage/index.js`.
 *
 * @module storage/providers/s3
 */
export { S3BlobStore } from './S3BlobStore.js';
export { createS3Client } from './s3Client.js';
export {
  ADOPT_BUCKET_ENV_VAR,
  S3_BLOB_BACKEND,
  createS3BlobBackend
} from './createS3BlobBackend.js';
export { DEV_ACCESS_KEY_ID, S3_DEFAULTS, isLoopbackHost, resolveS3BlobConfig } from './s3Config.js';
export { classifyS3Error, isNotFound, mapS3Error } from './s3Errors.js';
