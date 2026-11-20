// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The S3 client of the blob store: the only place that imports the AWS SDK.
 *
 * Settings that matter for S3-compatible servers other than AWS:
 * - static credentials only. The SDK's default credential chain (instance
 *   role, web identity, shared config file) is never consulted, because
 *   credentials are always passed in.
 * - an explicit endpoint, path-style addressing by default.
 * - `requestChecksumCalculation` and `responseChecksumValidation` set to
 *   `WHEN_REQUIRED`: the SDK default adds CRC32 checksums that several
 *   S3-compatible servers reject. Integrity comes from the authenticated
 *   encryption, not from the transport.
 * - no `logger`: the SDK's logging middleware writes command input, including
 *   the request body.
 * - a dedicated keep-alive agent from `utils/httpConfig.js`, so the platform
 *   proxy and the SSL whitelist apply. The SDK destroys the agent it is given
 *   when the client is destroyed, so it must never get a shared one.
 *
 * The client is built once. A change of the SSL whitelist or the proxy
 * settings at runtime needs a restart to reach it.
 *
 * @module storage/providers/s3/s3Client
 */
import { S3_MAX_SOCKETS, isLinkLocalHost } from './s3Config.js';

/**
 * Build the client.
 *
 * The SDK and `httpConfig` are imported here, on first use: an installation
 * that keeps its blobs on the filesystem never loads the SDK, and `httpConfig`
 * pulls in the configuration cache, which must not be loaded by importing the
 * storage layer.
 *
 * @param {Object} config - A validated block from `resolveS3BlobConfig`.
 * @param {Object} [options]
 * @param {Object} [options.platformConfig] - Platform configuration whose
 *   `ssl` and `proxy` sections decide the transport (placeholders resolved).
 * @returns {Promise<{client: Object, commands: Object, destroy: () => void,
 *   transport: {routing: {decision: string, reason: string}, tlsBypass: boolean}}>}
 *   `commands` holds the six command classes the blob store sends.
 */
export async function createS3Client(config, { platformConfig = null } = {}) {
  const [sdk, { createDedicatedAgent }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('../../../utils/httpConfig.js')
  ]);
  const { agent, routing, tlsBypass } = createDedicatedAgent(config.endpoint, {
    keepAlive: true,
    maxSockets: S3_MAX_SOCKETS,
    platformConfig: platformConfig || {},
    // The endpoint rules refuse a link-local address in the configuration; a
    // name that resolves to one (a cloud metadata service) is refused here.
    refuseAddress: address =>
      isLinkLocalHost(address) ? 'the S3 endpoint resolves to a link-local address' : null
  });
  const client = new sdk.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    maxAttempts: config.maxAttempts,
    retryMode: 'standard',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    followRegionRedirects: false,
    // Handler options as a plain object; the SDK builds its Node handler from
    // them. The one agent serves whichever scheme the endpoint has.
    requestHandler: {
      httpAgent: agent,
      httpsAgent: agent,
      connectionTimeout: config.connectTimeoutMs,
      // Until the response headers are there; the handler's timer ends then.
      requestTimeout: config.requestTimeoutMs,
      // Without this the handler only logs a warning when the time is up and
      // keeps waiting: a bucket that hangs would hang the request with it.
      throwOnRequestTimeout: true,
      // Idle time on the socket, which also covers the response body: a server
      // that sends the headers and then nothing ends the read with an error.
      // The blob store adds an overall deadline for a body that only trickles.
      socketTimeout: config.requestTimeoutMs
    }
  });
  let destroyed = false;
  return {
    client,
    commands: {
      PutObjectCommand: sdk.PutObjectCommand,
      GetObjectCommand: sdk.GetObjectCommand,
      HeadObjectCommand: sdk.HeadObjectCommand,
      DeleteObjectCommand: sdk.DeleteObjectCommand,
      ListObjectsV2Command: sdk.ListObjectsV2Command,
      HeadBucketCommand: sdk.HeadBucketCommand
    },
    transport: { routing, tlsBypass },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      client.destroy();
      // The SDK closes the agents of its handler; this covers a handler that
      // was never used and so never took them over.
      agent.destroy?.();
    }
  };
}
