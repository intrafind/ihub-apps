// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Validation of `platform.json → storage.blobs.s3`.
 *
 * The block is read from the raw file at storage bootstrap, before the
 * configuration cache and its schema exist, so everything the S3 blob store
 * relies on is checked here, with defaults, and a wrong value stops the start
 * with a message that names the field.
 *
 * @module storage/providers/s3/s3Config
 */
import net from 'node:net';
import { StorageError } from '../../errors.js';

/** Defaults of the optional settings. */
export const S3_DEFAULTS = Object.freeze({
  region: 'us-east-1',
  prefix: '',
  forcePathStyle: true,
  allowInsecureHttp: false,
  // Above the default size limit of an artifact ZIP (100 MB), so an artifact
  // the server accepts is never refused by its blob store.
  maxObjectBytes: 128 * 1024 * 1024,
  connectTimeoutMs: 5000,
  requestTimeoutMs: 60000,
  maxAttempts: 3,
  // How long one blob call may take with all its attempts, before the time
  // its payload needs is added: what a waiting HTTP request can live with.
  operationTimeoutMs: 30000,
  // The slowest transfer that is still accepted: 1 MiB per second. A call is
  // given `bytes / this` on top, so a large object on a slow link is not cut.
  minThroughputBytesPerSecond: 1024 * 1024
});

/** Connections kept to the endpoint. A constant, not a setting. */
export const S3_MAX_SOCKETS = 32;

/** The access key the local development server (`npm run s3:dev`) accepts. */
export const DEV_ACCESS_KEY_ID = 'ihub-dev-not-a-secret';

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9-]{1,64}$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/;

/**
 * A configuration error of the S3 blob store.
 *
 * @param {string} field - Setting name below `storage.blobs.s3`.
 * @param {string} problem - What is wrong with it, as a sentence fragment.
 * @returns {StorageError} Code `INVALID_STORAGE_CONFIG`, with `field` and
 *   `probeCode: 'S3_CONFIG_INCOMPLETE'`.
 */
function configError(field, problem) {
  const error = new StorageError(`storage.blobs.s3.${field} ${problem}`, {
    code: 'INVALID_STORAGE_CONFIG'
  });
  error.field = field;
  error.probeCode = 'S3_CONFIG_INCOMPLETE';
  return error;
}

/**
 * A required string setting, with an unresolved `${VAR}` reported by name.
 *
 * @param {Object} raw
 * @param {string} field
 * @returns {string}
 */
function requiredString(raw, field) {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim() === '') throw configError(field, 'is missing');
  const placeholder = PLACEHOLDER.exec(value);
  if (placeholder) {
    throw configError(
      field,
      `refers to the environment variable ${placeholder[1]}, which is not set`
    );
  }
  return value;
}

/**
 * A positive integer setting or its default.
 *
 * @param {Object} raw
 * @param {string} field
 * @param {number} max
 * @returns {number}
 */
function positiveInt(raw, field, max) {
  const value = raw[field];
  if (value === undefined || value === null) return S3_DEFAULTS[field];
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw configError(field, `must be a whole number from 1 to ${max}`);
  }
  return value;
}

/**
 * A boolean setting or its default.
 *
 * @param {Object} raw
 * @param {string} field
 * @returns {boolean}
 */
function bool(raw, field) {
  const value = raw[field];
  if (value === undefined || value === null) return S3_DEFAULTS[field];
  if (typeof value !== 'boolean') throw configError(field, 'must be true or false');
  return value;
}

/**
 * A host as an address check needs it: lower case, without IPv6 brackets,
 * and an IPv4-mapped IPv6 address (`::ffff:169.254.169.254`, which a URL
 * spells `::ffff:a9fe:a9fe`) as the IPv4 address it stands for.
 *
 * @param {string} hostname - As `URL.hostname` gives it, or an address.
 * @returns {string}
 */
function plainHost(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!net.isIPv6(host)) return host;
  const dotted = /^(?:0{0,4}:){2,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted && net.isIPv4(dotted[1])) return dotted[1];
  const hex = /^(?:0{0,4}:){2,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return host;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Whether a host is this machine: the name `localhost`, 127.0.0.0/8 or `::1`.
 * Not `anything.localhost`: that is a name DNS answers, and it may answer
 * with another machine.
 *
 * @param {string} hostname - As `URL.hostname` gives it (IPv6 in brackets).
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  const host = plainHost(hostname);
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  return host === '::1';
}

/**
 * Whether a host or a resolved address is link-local (cloud metadata
 * services live there): 169.254.0.0/16, also IPv4-mapped, `fe80::/10` and
 * the EC2 IPv6 metadata address.
 *
 * @param {string} hostname - A host name or an IP address.
 * @returns {boolean}
 */
export function isLinkLocalHost(hostname) {
  const host = plainHost(hostname);
  if (net.isIPv4(host)) return host.startsWith('169.254.');
  return net.isIPv6(host) && (/^fe[89ab]/.test(host) || host === 'fd00:ec2::254');
}

/**
 * Validate the endpoint and decide whether plain http is acceptable.
 *
 * @param {Object} raw
 * @param {string} region
 * @param {boolean} allowInsecureHttp
 * @returns {{endpoint: string, endpointHost: string, insecureHttp: boolean}}
 */
function resolveEndpoint(raw, region, allowInsecureHttp) {
  // Always explicit, so nothing from the SDK's environment variables or
  // shared config files (`AWS_ENDPOINT_URL`, `~/.aws/config`) can redirect it.
  if (raw.endpoint === undefined || raw.endpoint === null || raw.endpoint === '') {
    const host = `s3.${region}.amazonaws.com`;
    return { endpoint: `https://${host}`, endpointHost: host, insecureHttp: false };
  }
  const text = requiredString(raw, 'endpoint').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw configError('endpoint', 'is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw configError('endpoint', 'must start with https:// (or http://)');
  }
  if (url.username || url.password) throw configError('endpoint', 'must not hold credentials');
  if (url.search || url.hash) throw configError('endpoint', 'must not hold a query or fragment');
  if (url.pathname !== '/' && url.pathname !== '') {
    throw configError('endpoint', 'must not hold a path; the bucket goes into "bucket"');
  }
  if (isLinkLocalHost(url.hostname)) {
    throw configError('endpoint', 'must not be a link-local address');
  }
  const insecureHttp = url.protocol === 'http:';
  if (insecureHttp && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    throw configError(
      'endpoint',
      'uses plain http, which is refused for a host other than this machine: object names ' +
        'travel in clear text and signed requests can be replayed. Use https, or set ' +
        'storage.blobs.s3.allowInsecureHttp to true to accept that'
    );
  }
  return { endpoint: url.origin, endpointHost: url.host, insecureHttp };
}

/**
 * Validate the key prefix: empty, or `/`-separated segments of `[A-Za-z0-9._-]`.
 *
 * @param {Object} raw
 * @returns {string} The prefix without leading or trailing slash.
 */
function resolvePrefix(raw) {
  if (raw.prefix === undefined || raw.prefix === null || raw.prefix === '') return '';
  if (typeof raw.prefix !== 'string') throw configError('prefix', 'must be text');
  const prefix = raw.prefix.replace(/\/+$/, '');
  if (PLACEHOLDER.test(prefix)) throw configError('prefix', 'holds an unresolved ${VAR}');
  const segments = prefix.split('/');
  if (
    prefix.length > 512 ||
    segments.some(segment => !PREFIX_SEGMENT.test(segment) || segment === '.' || segment === '..')
  ) {
    throw configError(
      'prefix',
      'may hold letters, digits, ".", "_", "-" and "/" between segments, and no leading "/"'
    );
  }
  return prefix;
}

/**
 * Validate the S3 block and fill in its defaults.
 *
 * @param {Object} raw - `storage.blobs.s3`, with `${VAR}` placeholders resolved.
 * @param {Object} [options]
 * @param {(value: string) => string} [options.openSecret] - Turns a stored
 *   secret (`ENC[...]` or plain) into its plain text; throws when it cannot.
 * @returns {{endpoint: string, endpointHost: string, region: string, bucket: string,
 *   prefix: string, accessKeyId: string, secretAccessKey: string, forcePathStyle: boolean,
 *   allowInsecureHttp: boolean, insecureHttp: boolean, maxObjectBytes: number,
 *   connectTimeoutMs: number, requestTimeoutMs: number, maxAttempts: number,
 *   operationTimeoutMs: number, minThroughputBytesPerSecond: number}}
 * @throws {StorageError} Code `INVALID_STORAGE_CONFIG`; `error.field` names the setting.
 *
 * @example
 * resolveS3BlobConfig({
 *   endpoint: 'http://127.0.0.1:9000',
 *   bucket: 'ihub-dev',
 *   accessKeyId: 'ihub-dev-not-a-secret',
 *   secretAccessKey: 'ihub-dev-not-a-secret'
 * }).forcePathStyle; // true
 */
export function resolveS3BlobConfig(raw, { openSecret = value => value } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError('bucket', 'is missing: the storage.blobs.s3 block is not set');
  }
  const region = raw.region === undefined || raw.region === null ? S3_DEFAULTS.region : raw.region;
  if (typeof region !== 'string' || !REGION_PATTERN.test(region)) {
    throw configError('region', 'is not a region name');
  }
  const allowInsecureHttp = bool(raw, 'allowInsecureHttp');
  const bucket = requiredString(raw, 'bucket');
  if (!BUCKET_PATTERN.test(bucket)) {
    throw configError('bucket', 'is not a bucket name (lower case letters, digits, "." and "-")');
  }
  const accessKeyId = requiredString(raw, 'accessKeyId').trim();
  const storedSecret = requiredString(raw, 'secretAccessKey');
  let secretAccessKey;
  try {
    secretAccessKey = openSecret(storedSecret);
  } catch {
    throw configError(
      'secretAccessKey',
      'is stored encrypted and does not decrypt with the master key of this installation'
    );
  }
  if (typeof secretAccessKey !== 'string' || secretAccessKey === '') {
    throw configError('secretAccessKey', 'is missing');
  }
  return {
    ...resolveEndpoint(raw, region, allowInsecureHttp),
    region,
    bucket,
    prefix: resolvePrefix(raw),
    accessKeyId,
    secretAccessKey,
    forcePathStyle: bool(raw, 'forcePathStyle'),
    allowInsecureHttp,
    maxObjectBytes: positiveInt(raw, 'maxObjectBytes', 4 * 1024 * 1024 * 1024),
    connectTimeoutMs: positiveInt(raw, 'connectTimeoutMs', 600000),
    requestTimeoutMs: positiveInt(raw, 'requestTimeoutMs', 3600000),
    maxAttempts: positiveInt(raw, 'maxAttempts', 10),
    operationTimeoutMs: positiveInt(raw, 'operationTimeoutMs', 3600000),
    minThroughputBytesPerSecond: positiveInt(raw, 'minThroughputBytesPerSecond', 1024 ** 3)
  };
}
