// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which S3 server a test runs against: the in-repo fake, or a real
 * S3-compatible server named by environment variables.
 *
 * The fake (`fakeS3Server.js`) is written by the people who wrote the adapter
 * and does not verify signatures, so a green run on it proves the adapter
 * against our reading of S3. The same suites therefore also run against a real
 * server when one is configured:
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `IHUB_TEST_S3_ENDPOINT` | e.g. `http://127.0.0.1:7070`; selects the external backend |
 * | `IHUB_TEST_S3_REGION` | default `us-east-1` |
 * | `IHUB_TEST_S3_BUCKET` | must exist and must contain `test` in its name |
 * | `IHUB_TEST_S3_ACCESS_KEY` | access key ID |
 * | `IHUB_TEST_S3_SECRET_KEY` | secret access key |
 * | `IHUB_TEST_S3_REQUIRED` | `1`: a missing or unreachable backend FAILS, never skips |
 *
 * Use {@link describeS3Targets} in a test file: it registers the suite once
 * for the fake and once for the external backend. Without an endpoint the
 * external copy is skipped with a reason that names the command to start a
 * backend; with `IHUB_TEST_S3_REQUIRED=1` it fails instead.
 *
 * Every open backend works under its own random key prefix (`test-<hex>`) and
 * removes it on close, so runs can share one bucket.
 *
 * @module tests/support/s3TestBackend
 */
import crypto from 'node:crypto';
import { describe } from 'node:test';
import { startFakeS3Server } from './fakeS3Server.js';

const START_HINT =
  'start one with `npm run s3:up` and export the IHUB_TEST_S3_* variables listed at the top of docker/docker-compose.s3.yml';

/**
 * The external backend as the environment describes it.
 *
 * @param {Object} [env=process.env]
 * @returns {{configured: boolean, required: boolean, missing: string[], endpoint?: string,
 *   region: string, bucket?: string, accessKeyId?: string, secretAccessKey?: string}}
 */
export function readExternalS3Env(env = process.env) {
  const value = name => (typeof env[name] === 'string' ? env[name].trim() : '');
  const settings = {
    endpoint: value('IHUB_TEST_S3_ENDPOINT'),
    bucket: value('IHUB_TEST_S3_BUCKET'),
    accessKeyId: value('IHUB_TEST_S3_ACCESS_KEY'),
    secretAccessKey: value('IHUB_TEST_S3_SECRET_KEY')
  };
  const names = {
    endpoint: 'IHUB_TEST_S3_ENDPOINT',
    bucket: 'IHUB_TEST_S3_BUCKET',
    accessKeyId: 'IHUB_TEST_S3_ACCESS_KEY',
    secretAccessKey: 'IHUB_TEST_S3_SECRET_KEY'
  };
  const missing = Object.keys(settings)
    .filter(key => !settings[key])
    .map(key => names[key]);
  return {
    ...settings,
    region: value('IHUB_TEST_S3_REGION') || 'us-east-1',
    required: value('IHUB_TEST_S3_REQUIRED') === '1',
    // Selected by the endpoint; the other variables are then mandatory.
    configured: Boolean(settings.endpoint),
    missing
  };
}

/**
 * Whether the external copy of a suite runs, is skipped, or must fail.
 *
 * @param {Object} [env=process.env]
 * @returns {{mode: 'run'|'skip'|'fail', reason: string}}
 */
export function externalS3Mode(env = process.env) {
  const external = readExternalS3Env(env);
  if (external.configured && external.missing.length === 0) return { mode: 'run', reason: '' };
  const reason = external.configured
    ? `the external S3 backend is incomplete: ${external.missing.join(', ')} not set`
    : `no external S3 backend (IHUB_TEST_S3_ENDPOINT is not set); ${START_HINT}`;
  return { mode: external.required ? 'fail' : 'skip', reason };
}

/** Collect a stream body into one Buffer. */
async function collect(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Open the in-repo fake as a test backend.
 *
 * @returns {Promise<Object>} See {@link openS3Target}.
 */
async function openFake() {
  const bucket = 'ihub-test';
  const fake = await startFakeS3Server({ buckets: [bucket] });
  const prefix = `test-${crypto.randomBytes(6).toString('hex')}`;
  return {
    kind: 'fake',
    fake,
    bucket,
    prefix,
    endpoint: fake.endpoint,
    config: (overrides = {}) => ({
      endpoint: fake.endpoint,
      bucket,
      prefix,
      accessKeyId: fake.accessKeyId,
      secretAccessKey: fake.secretAccessKey,
      maxAttempts: 2,
      ...overrides
    }),
    rawObjects: async (under = `${prefix}/`) => fake.rawObjects(bucket, under),
    rawGet: async key => fake.rawGet(bucket, key),
    rawPut: async (key, data) => fake.rawPut(bucket, key, data),
    rawDelete: async key => void fake.rawDelete(bucket, key),
    close: async () => fake.close()
  };
}

/**
 * Open the external backend. Raw access goes through an SDK client of its
 * own, built here and not by the adapter, with default SDK settings.
 *
 * @param {Object} external - From {@link readExternalS3Env}.
 * @returns {Promise<Object>} See {@link openS3Target}.
 * @throws {Error} When the bucket cannot be reached. Never a skip.
 */
async function openExternal(external) {
  if (!/test/i.test(external.bucket)) {
    throw new Error(
      `IHUB_TEST_S3_BUCKET is "${external.bucket}": the tests write and delete objects and only ` +
        'run in a bucket whose name contains "test"'
    );
  }
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    endpoint: external.endpoint,
    region: external.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: external.accessKeyId,
      secretAccessKey: external.secretAccessKey
    },
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, throwOnRequestTimeout: true }
  });
  const Bucket = external.bucket;
  try {
    await client.send(new sdk.HeadBucketCommand({ Bucket }));
  } catch (error) {
    client.destroy();
    throw new Error(
      `The external S3 backend at ${external.endpoint} (bucket "${Bucket}") cannot be used: ` +
        `${error.code || error.cause?.code || error.name}${error.$metadata?.httpStatusCode ? ` (HTTP ${error.$metadata.httpStatusCode})` : ''}. ` +
        'This is a failure, not a skip: IHUB_TEST_S3_ENDPOINT is set.',
      { cause: error }
    );
  }
  const prefix = `test-${crypto.randomBytes(6).toString('hex')}`;
  const rawObjects = async (under = `${prefix}/`) => {
    const objects = [];
    let token;
    do {
      const page = await client.send(
        new sdk.ListObjectsV2Command({ Bucket, Prefix: under, ContinuationToken: token })
      );
      for (const entry of page.Contents || []) objects.push({ key: entry.Key, size: entry.Size });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects;
  };
  return {
    kind: 'external',
    fake: null,
    bucket: Bucket,
    prefix,
    endpoint: external.endpoint,
    config: (overrides = {}) => ({
      endpoint: external.endpoint,
      region: external.region,
      bucket: Bucket,
      prefix,
      accessKeyId: external.accessKeyId,
      secretAccessKey: external.secretAccessKey,
      maxAttempts: 2,
      ...overrides
    }),
    rawObjects,
    rawGet: async key => {
      try {
        const response = await client.send(new sdk.GetObjectCommand({ Bucket, Key: key }));
        return await collect(response.Body);
      } catch (error) {
        if (error.name === 'NoSuchKey') return null;
        throw error;
      }
    },
    rawPut: async (key, data) =>
      void (await client.send(
        new sdk.PutObjectCommand({ Bucket, Key: key, Body: Buffer.from(data) })
      )),
    rawDelete: async key =>
      void (await client.send(new sdk.DeleteObjectCommand({ Bucket, Key: key }))),
    close: async () => {
      try {
        // Everything this run wrote, also under sibling prefixes it derived
        // from its own (`<prefix>2/…`).
        for (const { key } of await rawObjects(prefix)) {
          await client.send(new sdk.DeleteObjectCommand({ Bucket, Key: key }));
        }
      } finally {
        client.destroy();
      }
    }
  };
}

/**
 * Open a test backend.
 *
 * @param {'fake'|'external'} kind
 * @param {Object} [env=process.env]
 * @returns {Promise<{kind: string, fake: Object|null, bucket: string, prefix: string,
 *   endpoint: string, config: (overrides?: Object) => Object,
 *   rawObjects: (under?: string) => Promise<Array<{key: string, size: number}>>,
 *   rawGet: (key: string) => Promise<Buffer|null>,
 *   rawPut: (key: string, data: Buffer|string) => Promise<void>,
 *   rawDelete: (key: string) => Promise<void>, close: () => Promise<void>}>}
 *   `config()` is a `storage.blobs.s3` block under this run's own prefix;
 *   the raw functions work behind the adapter's back and take full object names.
 * @throws {Error} For `external` when it is not configured or not reachable.
 */
export async function openS3Target(kind, env = process.env) {
  if (kind === 'fake') return openFake();
  const external = readExternalS3Env(env);
  if (!external.configured || external.missing.length > 0) {
    throw new Error(externalS3Mode(env).reason);
  }
  return openExternal(external);
}

/**
 * Register a suite once per S3 backend: always the fake, and the external
 * backend when configured.
 *
 * @param {string} title - Suite title; the backend is appended.
 * @param {(target: {kind: 'fake'|'external', open: () => Promise<Object>}) => void} define -
 *   Registers the tests. Call `target.open()` in a `before` hook and `close()`
 *   the result in `after`.
 * @param {Object} [options]
 * @param {Array<'fake'|'external'>} [options.kinds] - Restrict to these.
 * @param {Object} [options.env=process.env]
 * @returns {void}
 *
 * @example
 * describeS3Targets('S3 contract edges', target => {
 *   let s3;
 *   before(async () => { s3 = await target.open(); });
 *   after(() => s3?.close());
 *   it('…', async () => { … });
 * });
 */
export function describeS3Targets(
  title,
  define,
  { kinds = ['fake', 'external'], env = process.env } = {}
) {
  if (kinds.includes('fake')) {
    describe(`${title} [in-repo fake S3]`, () =>
      define({ kind: 'fake', open: () => openS3Target('fake', env) }));
  }
  if (!kinds.includes('external')) return;
  const { mode, reason } = externalS3Mode(env);
  const name = `${title} [external S3]`;
  if (mode === 'skip') {
    describe(name, { skip: reason }, () => {});
    return;
  }
  // 'fail' goes through the same path: open() throws in the suite's `before`,
  // which fails every test of the suite.
  describe(name, () => define({ kind: 'external', open: () => openS3Target('external', env) }));
}
