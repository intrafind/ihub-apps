#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A small S3-compatible HTTP server for tests and local development.
 *
 * **Development only.** It keeps no access control worth the name: it checks
 * that a request carries a SigV4 `Authorization` header for the expected
 * access key ID and does **not** verify the signature. It has no multipart
 * upload, no versioning, no ACLs and no TLS of its own unless a certificate is
 * supplied. Never expose it to a network; it binds to 127.0.0.1.
 *
 * What it implements, path-style only (`/<bucket>/<key>`):
 * - `HeadBucket`, `PutObject`, `GetObject` (also with a `Range: bytes=a-b`
 *   header), `HeadObject`, `DeleteObject`
 * - `ListObjectsV2` with `prefix`, `start-after`, `continuation-token`,
 *   `max-keys` (capped at 1000) and `encoding-type=url`, keys in UTF-8 byte
 *   order as S3 lists them
 * - S3 XML error bodies (`NoSuchKey`, `NoSuchBucket`, `AccessDenied`,
 *   `InvalidAccessKeyId`, …)
 *
 * Buckets exist only when named in `buckets` (or added with `addBucket`).
 * `CreateBucket` is answered with 501, so a client that tries to create one is
 * caught by its test.
 *
 * For tests it also offers:
 * - `requests`: a log of every request (operation, bucket, key, headers)
 * - `inject(rule)`: answer matching requests with a status code, after a
 *   delay, with a truncated body, or by closing the connection
 * - raw access behind the client's back: `rawObjects`, `rawGet`, `rawPut`,
 *   `rawDelete`
 *
 * Standalone (`npm run s3:dev`): serves one bucket from a directory, so data
 * survives a restart, and prints the settings for `platform.json`.
 *
 * @module tests/support/fakeS3Server
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Access key ID and secret the server expects by default. Obviously not secrets. */
export const FAKE_S3_ACCESS_KEY_ID = 'ihub-dev-not-a-secret';
export const FAKE_S3_SECRET_ACCESS_KEY = 'ihub-dev-not-a-secret';

const MAX_KEYS = 1000;
const OBJECT_SUFFIX = '.obj';

/** Escape text for an XML element. */
function xml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Object keys in the order S3 lists them: by UTF-8 bytes. */
function compareKeys(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** S3's URL encoding of a key in a listing (`encoding-type=url`). */
function encodeKey(key) {
  return encodeURIComponent(key).replaceAll('%2F', '/');
}

/**
 * Take the payload out of an `aws-chunked` request body
 * (`<hex size>;chunk-signature=…\r\n<bytes>\r\n … 0\r\n<trailers>`).
 *
 * @param {Buffer} body
 * @returns {Buffer}
 */
function decodeAwsChunked(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(body.toString('latin1', offset, lineEnd).split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    chunks.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(chunks);
}

/**
 * Objects of one bucket: in memory, or as files in a directory.
 *
 * On disk an object is one file named by the SHA-256 of its key, holding a
 * JSON line with the key and metadata followed by the bytes. The index is
 * rebuilt from those files at start.
 */
class BucketStore {
  /** @param {string|null} dir - Directory to persist to, or null for memory. */
  constructor(dir) {
    this.dir = dir;
    /** @type {Map<string, {size: number, etag: string, lastModified: string, contentType: string, data?: Buffer, file?: string, offset?: number}>} */
    this.objects = new Map();
    if (dir) this._load();
  }

  _load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(OBJECT_SUFFIX)) continue;
      const file = path.join(this.dir, name);
      try {
        const content = fs.readFileSync(file);
        const lineEnd = content.indexOf(0x0a);
        const meta = JSON.parse(content.toString('utf8', 0, lineEnd));
        this.objects.set(meta.key, {
          size: content.length - lineEnd - 1,
          etag: meta.etag,
          lastModified: meta.lastModified,
          contentType: meta.contentType,
          file,
          offset: lineEnd + 1
        });
      } catch {
        // Not one of ours, or half written: not an object.
      }
    }
  }

  /**
   * @param {string} key
   * @param {Buffer} data
   * @param {string} [contentType]
   * @returns {string} The ETag.
   */
  put(key, data, contentType = 'application/octet-stream') {
    // S3 defines the ETag of a single-part object as the MD5 of its bytes; it
    // identifies the content and protects nothing.
    const etag = `"${crypto.createHash('md5').update(data).digest('hex')}"`; // NOSONAR
    const entry = { size: data.length, etag, lastModified: new Date().toISOString(), contentType };
    if (this.dir) {
      const file = path.join(
        this.dir,
        crypto.createHash('sha256').update(key).digest('hex') + OBJECT_SUFFIX
      );
      const head = Buffer.from(
        `${JSON.stringify({ key, etag, lastModified: entry.lastModified, contentType })}\n`,
        'utf8'
      );
      const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(temp, Buffer.concat([head, data]));
      fs.renameSync(temp, file);
      entry.file = file;
      entry.offset = head.length;
    } else {
      entry.data = Buffer.from(data);
    }
    this.objects.set(key, entry);
    return etag;
  }

  /**
   * @param {string} key
   * @returns {Buffer|null}
   */
  read(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    if (entry.data) return entry.data;
    return fs.readFileSync(entry.file).subarray(entry.offset);
  }

  /** @param {string} key */
  delete(key) {
    const entry = this.objects.get(key);
    if (!entry) return false;
    if (entry.file) fs.rmSync(entry.file, { force: true });
    this.objects.delete(key);
    return true;
  }

  /** @returns {string[]} Every key, in listing order. */
  keys() {
    return [...this.objects.keys()].sort(compareKeys);
  }
}

/**
 * A failure to inject.
 *
 * @typedef {Object} FakeS3Injection
 * @property {string|string[]} [op] - Operation(s) it applies to: `PutObject`,
 *   `GetObject`, `HeadObject`, `DeleteObject`, `ListObjectsV2`, `HeadBucket`.
 *   Every operation when omitted.
 * @property {RegExp|string} [key] - Only objects whose key matches (a string
 *   is a substring match).
 * @property {number} [times=Infinity] - How many requests it applies to.
 * @property {number} [status] - Answer with this status instead of serving.
 * @property {string} [code] - S3 error code of that answer (`SlowDown`,
 *   `AccessDenied`, …); a default is chosen from the status.
 * @property {number} [delayMs] - Wait before answering (or before serving).
 * @property {Promise<void>} [hold] - Wait for this promise before answering
 *   (or before serving). The request is in `requests` while it waits, so a
 *   test can hold requests until a number of them have arrived.
 * @property {number} [truncateBody] - Serve a `GetObject` with its full
 *   `Content-Length`, send this many bytes, then close the connection.
 * @property {number} [stallBody] - Serve a `GetObject` with its full
 *   `Content-Length`, send this many bytes, then send nothing more and keep
 *   the connection open (a body that stalls mid-stream).
 * @property {boolean} [chunked] - Serve a `GetObject` without a
 *   `Content-Length` (chunked transfer), so the client cannot know the size
 *   before it reads.
 * @property {boolean} [meterBody] - Serve a `GetObject` body in 64 KiB pieces
 *   that wait for the client to take them, and record on the request's log
 *   entry how many bytes were handed to the socket before the response ended
 *   or the client went away (`bodyBytesSent`, `bodyComplete`). Shows whether
 *   a client stopped reading early.
 * @property {boolean} [destroy] - Close the connection without an answer.
 * @property {string} [rawBody] - Answer 200 with this body as it is (a
 *   malformed listing, for one).
 */

/**
 * Start the server.
 *
 * @param {Object} [options]
 * @param {number} [options.port=0] - 0 picks a free port.
 * @param {string} [options.host='127.0.0.1'] - Address to bind.
 * @param {string[]} [options.buckets=['ihub-test']] - Buckets that exist.
 * @param {string|null} [options.accessKeyId] - Expected access key ID; null
 *   accepts any (a SigV4 header is still required).
 * @param {string} [options.dataDir] - Persist objects below this directory.
 * @param {{key: string|Buffer, cert: string|Buffer}} [options.tls] - Serve
 *   HTTPS with this key and certificate.
 * @returns {Promise<Object>} The running server: `endpoint`, `port`,
 *   `requests`, `inject`, `clearInjections`, `addBucket`, `removeBucket`,
 *   `rawObjects`, `rawGet`, `rawPut`, `rawDelete`, `close`.
 *
 * @example
 * const s3 = await startFakeS3Server({ buckets: ['ihub-test'] });
 * s3.inject({ op: 'GetObject', status: 503, times: 1 });
 * // … use s3.endpoint with forcePathStyle: true …
 * await s3.close();
 */
export async function startFakeS3Server({
  port = 0,
  host = '127.0.0.1',
  buckets = ['ihub-test'],
  accessKeyId = FAKE_S3_ACCESS_KEY_ID,
  dataDir,
  tls
} = {}) {
  /** @type {Map<string, BucketStore>} */
  const stores = new Map();
  const addBucket = name => {
    if (!stores.has(name))
      stores.set(name, new BucketStore(dataDir ? path.join(dataDir, name) : null));
  };
  for (const name of buckets) addBucket(name);

  const requests = [];
  /** @type {Array<FakeS3Injection & {remaining: number}>} */
  let injections = [];
  const sockets = new Set();

  const sendError = (res, status, code, message, method) => {
    const body =
      method === 'HEAD'
        ? ''
        : `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${xml(code)}</Code><Message>${xml(message)}</Message><RequestId>fake</RequestId></Error>`;
    res.writeHead(status, {
      'content-type': 'application/xml',
      'content-length': Buffer.byteLength(body),
      'x-amz-request-id': 'fake'
    });
    res.end(body);
  };

  const defaultCode = status =>
    ({
      301: 'PermanentRedirect',
      400: 'InvalidRequest',
      403: 'AccessDenied',
      404: 'NoSuchKey',
      500: 'InternalError',
      503: 'ServiceUnavailable'
    })[status] || 'InternalError';

  /** The first injection that applies to a request, counted down. */
  const takeInjection = (op, key) => {
    for (const rule of injections) {
      if (rule.remaining <= 0) continue;
      if (rule.op && ![].concat(rule.op).includes(op)) continue;
      if (rule.key instanceof RegExp && !rule.key.test(key || '')) continue;
      if (typeof rule.key === 'string' && !(key || '').includes(rule.key)) continue;
      rule.remaining -= 1;
      return rule;
    }
    return null;
  };

  const list = (store, bucket, query, res) => {
    const prefix = query.get('prefix') || '';
    const startAfter = query.get('start-after') || '';
    const token = query.get('continuation-token');
    const encode = query.get('encoding-type') === 'url';
    const requested = Number.parseInt(query.get('max-keys') ?? `${MAX_KEYS}`, 10);
    const maxKeys = Math.min(
      MAX_KEYS,
      Number.isFinite(requested) && requested >= 0 ? requested : MAX_KEYS
    );
    let after = startAfter;
    if (token) {
      try {
        const decoded = Buffer.from(token, 'base64url').toString('utf8');
        if (compareKeys(decoded, after) > 0) after = decoded;
      } catch {
        return sendError(res, 400, 'InvalidArgument', 'The continuation token is not valid', 'GET');
      }
    }
    const matching = store
      .keys()
      .filter(key => key.startsWith(prefix) && (!after || compareKeys(key, after) > 0));
    const page = matching.slice(0, maxKeys);
    // max-keys=0 is answered empty and not truncated: there is no key a
    // continuation could start from.
    const truncated = maxKeys > 0 && matching.length > page.length;
    const show = key => xml(encode ? encodeKey(key) : key);
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${xml(bucket)}</Name>`,
      `<Prefix>${show(prefix)}</Prefix>`,
      startAfter ? `<StartAfter>${show(startAfter)}</StartAfter>` : '',
      token ? `<ContinuationToken>${xml(token)}</ContinuationToken>` : '',
      `<KeyCount>${page.length}</KeyCount>`,
      `<MaxKeys>${maxKeys}</MaxKeys>`,
      encode ? '<EncodingType>url</EncodingType>' : '',
      `<IsTruncated>${truncated}</IsTruncated>`,
      truncated && page.length > 0
        ? `<NextContinuationToken>${Buffer.from(page[page.length - 1], 'utf8').toString('base64url')}</NextContinuationToken>`
        : '',
      ...page.map(key => {
        const entry = store.objects.get(key);
        return `<Contents><Key>${show(key)}</Key><LastModified>${entry.lastModified}</LastModified><ETag>${xml(entry.etag)}</ETag><Size>${entry.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      }),
      '</ListBucketResult>'
    ].join('');
    res.writeHead(200, {
      'content-type': 'application/xml',
      'content-length': Buffer.byteLength(body)
    });
    res.end(body);
  };

  const handle = async (req, res, body) => {
    // The base only serves to parse the request path; nothing is fetched from it.
    const url = new URL(req.url, 'https://fake.invalid');
    const [, bucket = '', ...rest] = url.pathname.split('/');
    let key = '';
    try {
      key = rest.map(decodeURIComponent).join('/');
    } catch {
      return sendError(res, 400, 'InvalidURI', 'The object key is not valid', req.method);
    }
    const method = req.method;
    let op = 'Unknown';
    if (!bucket) op = 'ListBuckets';
    else if (!key) {
      op =
        method === 'HEAD'
          ? 'HeadBucket'
          : method === 'GET'
            ? 'ListObjectsV2'
            : method === 'PUT'
              ? 'CreateBucket'
              : method === 'DELETE'
                ? 'DeleteBucket'
                : 'Unknown';
    } else {
      op =
        { GET: 'GetObject', HEAD: 'HeadObject', PUT: 'PutObject', DELETE: 'DeleteObject' }[
          method
        ] || 'Unknown';
    }
    requests.push({ method, op, bucket, key, query: url.search, headers: { ...req.headers } });

    const rule = takeInjection(op, key);
    if (rule?.delayMs) await new Promise(resolve => setTimeout(resolve, rule.delayMs));
    if (rule?.hold) await rule.hold;
    if (res.destroyed) return undefined;
    if (rule?.destroy) return void req.socket.destroy();
    if (rule?.rawBody !== undefined) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return void res.end(rule.rawBody);
    }
    if (rule?.status) {
      const code = rule.code || defaultCode(rule.status);
      return sendError(res, rule.status, code, `Injected ${code}`, method);
    }

    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('AWS4-HMAC-SHA256 ')) {
      return sendError(
        res,
        403,
        'AccessDenied',
        'A SigV4 Authorization header is required',
        method
      );
    }
    const credential = /Credential=([^/,\s]+)\//.exec(authorization)?.[1];
    if (accessKeyId !== null && credential !== accessKeyId) {
      return sendError(res, 403, 'InvalidAccessKeyId', 'The access key ID is not known', method);
    }

    if (
      op === 'CreateBucket' ||
      op === 'DeleteBucket' ||
      op === 'ListBuckets' ||
      op === 'Unknown'
    ) {
      return sendError(res, 501, 'NotImplemented', `${op} is not implemented`, method);
    }
    const store = stores.get(bucket);
    if (!store) {
      return sendError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist', method);
    }
    if (op === 'HeadBucket') {
      res.writeHead(200, { 'x-amz-bucket-region': 'us-east-1' });
      return void res.end();
    }
    if (op === 'ListObjectsV2') {
      if (url.searchParams.get('list-type') !== '2') {
        return sendError(res, 501, 'NotImplemented', 'Only ListObjectsV2 is implemented', method);
      }
      return list(store, bucket, url.searchParams, res);
    }
    if (op === 'PutObject') {
      const chunked = String(req.headers['content-encoding'] || '').includes('aws-chunked');
      const streaming = String(req.headers['x-amz-content-sha256'] || '').startsWith('STREAMING-');
      const data = chunked || streaming ? decodeAwsChunked(body) : body;
      const etag = store.put(key, data, req.headers['content-type']);
      res.writeHead(200, { etag, 'content-length': 0 });
      return void res.end();
    }
    if (op === 'DeleteObject') {
      store.delete(key);
      res.writeHead(204);
      return void res.end();
    }
    const entry = store.objects.get(key);
    if (!entry) {
      return sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.', method);
    }
    const headers = {
      'content-type': entry.contentType || 'application/octet-stream',
      'content-length': entry.size,
      etag: entry.etag,
      'last-modified': new Date(entry.lastModified).toUTCString(),
      'accept-ranges': 'bytes'
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (op === 'GetObject' && range && Number(range[1]) < entry.size) {
      const first = Number(range[1]);
      const last = Math.min(entry.size - 1, range[2] === '' ? entry.size - 1 : Number(range[2]));
      const part = store.read(key).subarray(first, last + 1);
      res.writeHead(206, {
        ...headers,
        'content-length': part.length,
        'content-range': `bytes ${first}-${last}/${entry.size}`
      });
      return void res.end(part);
    }
    if (op === 'GetObject' && rule?.chunked) delete headers['content-length'];
    res.writeHead(200, headers);
    if (op === 'HeadObject') return void res.end();
    const data = store.read(key);
    if (rule && Number.isInteger(rule.truncateBody)) {
      res.write(data.subarray(0, rule.truncateBody), () => req.socket.destroy());
      return undefined;
    }
    if (rule && Number.isInteger(rule.stallBody)) {
      // Never ended: the socket stays open until the client or close() ends it.
      res.write(data.subarray(0, rule.stallBody));
      return undefined;
    }
    if (rule?.meterBody) {
      const entry = requests[requests.length - 1];
      entry.bodyBytesSent = 0;
      entry.bodyComplete = false;
      const piece = 64 * 1024;
      const closed = new Promise(resolve => res.once('close', resolve));
      for (let offset = 0; offset < data.length && !res.destroyed; offset += piece) {
        const chunk = data.subarray(offset, offset + piece);
        if (!res.write(chunk)) {
          let onDrain;
          await Promise.race([
            new Promise(resolve => res.once('drain', (onDrain = resolve))),
            closed
          ]);
          res.removeListener('drain', onDrain);
        }
        if (!res.destroyed) entry.bodyBytesSent += chunk.length;
      }
      if (!res.destroyed) {
        entry.bodyComplete = true;
        res.end();
      }
      return undefined;
    }
    return void res.end(data);
  };

  const listener = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      handle(req, res, Buffer.concat(chunks)).catch(error => {
        if (!res.headersSent) sendError(res, 500, 'InternalError', error.message, req.method);
        else res.destroy();
      });
    });
    req.on('error', () => {});
  };

  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, listener)
    : http.createServer(listener);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const scheme = tls ? 'https' : 'http';
  const bucketOf = name => {
    const store = stores.get(name);
    if (!store) throw new Error(`The fake S3 server has no bucket "${name}"`);
    return store;
  };

  return {
    /** Endpoint URL by IP address, e.g. `http://127.0.0.1:41233`. */
    endpoint: `${scheme}://${address.address}:${address.port}`,
    /** The same endpoint under another host name (`localhost`), for host-based rules. */
    endpointFor: hostname => `${scheme}://${hostname}:${address.port}`,
    port: address.port,
    host: address.address,
    accessKeyId: accessKeyId ?? FAKE_S3_ACCESS_KEY_ID,
    secretAccessKey: FAKE_S3_SECRET_ACCESS_KEY,
    /** Every request received, oldest first. */
    requests,
    clearRequests: () => void (requests.length = 0),
    /**
     * Inject a failure.
     *
     * @param {FakeS3Injection} rule
     * @returns {() => void} Removes the rule again.
     */
    inject(rule) {
      const entry = { ...rule, remaining: rule.times ?? Infinity };
      injections.push(entry);
      return () => {
        injections = injections.filter(candidate => candidate !== entry);
      };
    },
    clearInjections: () => void (injections = []),
    addBucket,
    removeBucket: name => void stores.delete(name),
    /** Keys and sizes of a bucket, in listing order, read behind the client's back. */
    rawObjects: (bucket, prefix = '') =>
      bucketOf(bucket)
        .keys()
        .filter(key => key.startsWith(prefix))
        .map(key => {
          const entry = stores.get(bucket).objects.get(key);
          return { key, size: entry.size, contentType: entry.contentType };
        }),
    /** The stored bytes of one object, or null. */
    rawGet: (bucket, key) => {
      const data = bucketOf(bucket).read(key);
      return data ? Buffer.from(data) : null;
    },
    /** Store bytes as they are, as someone with write access to the bucket could. */
    rawPut: (bucket, key, data) => void bucketOf(bucket).put(key, Buffer.from(data)),
    rawDelete: (bucket, key) => bucketOf(bucket).delete(key),
    /** Stop listening and close every open connection. */
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}

/**
 * Standalone entry (`npm run s3:dev`): one bucket, persisted to a directory.
 *
 * Environment: `IHUB_S3_DEV_PORT` (9000), `IHUB_S3_DEV_BUCKET` (`ihub-dev`),
 * `IHUB_S3_DEV_DIR` (`.s3-dev-data` in the repository root).
 */
async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const port = Number.parseInt(process.env.IHUB_S3_DEV_PORT || '9000', 10);
  const bucket = process.env.IHUB_S3_DEV_BUCKET || 'ihub-dev';
  const dataDir = path.resolve(process.env.IHUB_S3_DEV_DIR || path.join(repoRoot, '.s3-dev-data'));
  const server = await startFakeS3Server({ port, buckets: [bucket], dataDir });
  const settings = {
    storage: {
      blobs: {
        provider: 's3',
        s3: {
          endpoint: server.endpoint,
          region: 'us-east-1',
          bucket,
          accessKeyId: FAKE_S3_ACCESS_KEY_ID,
          secretAccessKey: FAKE_S3_SECRET_ACCESS_KEY,
          forcePathStyle: true
        }
      }
    }
  };
  console.log(
    [
      '',
      'iHub local S3 server. DEVELOPMENT ONLY: it does not verify request signatures.',
      '',
      `  Endpoint           ${server.endpoint}  (bound to 127.0.0.1)`,
      `  Bucket             ${bucket}`,
      `  Access key ID      ${FAKE_S3_ACCESS_KEY_ID}`,
      `  Secret access key  ${FAKE_S3_SECRET_ACCESS_KEY}`,
      `  Data directory     ${dataDir}`,
      '',
      'These credentials are fixed, public and only accepted by this server.',
      'Merge this into contents/config/platform.json and restart iHub:',
      '',
      JSON.stringify(settings, null, 2),
      '',
      'Press Ctrl+C to stop.'
    ].join('\n')
  );
  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`The local S3 server could not start: ${error.message}`);
    process.exit(1);
  });
}
