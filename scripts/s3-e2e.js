#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * End-to-end check of the S3 blob backend through the real server.
 *
 * It starts an S3 server, boots `server/server.js` on a throwaway contents
 * directory configured for `storage.blobs.provider: "s3"` with encryption on,
 * and then acts as a client over HTTP only:
 *
 *  1. log in as the default admin (`admin` / `password123`)
 *  2. upload a chat file (`POST /api/chats/{chatId}/files`, multipart)
 *  3. read it back (extracted text, original bytes, file list)
 *  4. look into the bucket behind the server's back: only ciphertext, no
 *     marker string, no file name, and nothing on local disk
 *  5. restart the server and read the file again
 *  6. delete the chat and wait for its objects to leave the bucket
 *  7. ask `GET /api/admin/storage` (skipped with a note when the route is not there)
 *
 * Why a plain script and not a Playwright spec: the run has to stop and start
 * the server in the middle, which Playwright's `webServer` cannot do, and it
 * needs no browser. It follows `scripts/smoke-boot.js`.
 *
 * S3 server: the in-repo one (`server/tests/support/fakeS3Server.js`) by
 * default. With `IHUB_TEST_S3_ENDPOINT` set (see
 * `server/tests/support/s3TestBackend.js`, `npm run s3:up`) it runs against
 * that real server instead, in a key prefix of its own that it removes.
 *
 * Usage: node scripts/s3-e2e.js [--keep]     (--keep leaves the contents directory)
 * Exit code 0 when every step passed, 1 otherwise.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  localBlobFiles,
  seedContents,
  startServer,
  writeStorageConfig
} from '../server/tests/support/serverProcess.js';
import { externalS3Mode, openS3Target } from '../server/tests/support/s3TestBackend.js';

const keep = process.argv.includes('--keep');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const MARKER = `IHUB-E2E-CANARY-${crypto.randomBytes(8).toString('hex')}`;
const NAME_MARKER = `confidential-merger-${crypto.randomBytes(4).toString('hex')}`;
const FILE_NAME = `${NAME_MARKER}.txt`;
const FILE_BYTES = Buffer.from(
  `${MARKER}\nQuarterly numbers, not for distribution.\n${'lorem ipsum dolor sit amet '.repeat(400)}\n${MARKER}\n`,
  'utf8'
);
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

const results = [];
/** Record one step. `status` is PASS, FAIL or NOTE. */
function record(status, step, detail = '') {
  results.push({ status, step, detail });
  console.log(`${status.padEnd(4)}  ${step}${detail ? `\n        ${detail}` : ''}`);
}

/** Run one step; a thrown error fails it and the run goes on where it can. */
async function step(name, fn) {
  try {
    const detail = await fn();
    record('PASS', name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    record('FAIL', name, String(error?.message || error).slice(0, 600));
    return false;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** An HTTP client for one server and one login. */
function clientFor(baseUrl) {
  let cookie = '';
  const request = async (method, target, { body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${target}`, {
      method,
      body,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      signal: AbortSignal.timeout(30_000)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      // Not JSON.
    }
    return { status: response.status, headers: response.headers, bytes, json };
  };
  return {
    request,
    async login() {
      const response = await fetch(`${baseUrl}/api/auth/local/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password123' }),
        signal: AbortSignal.timeout(30_000)
      });
      expect(
        response.status === 200,
        `login answered ${response.status}: ${await response.text()}`
      );
      const token = response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .find(value => value.startsWith('authToken='));
      expect(token, 'the login set no authToken cookie');
      cookie = token;
    }
  };
}

/** Everything in the bucket under this run's prefix, with its bytes. */
async function bucketObjects(s3) {
  const objects = [];
  for (const { key } of await s3.rawObjects()) {
    objects.push({ key, data: await s3.rawGet(key) });
  }
  return objects;
}

/** What of the upload is readable in stored bytes or a name. */
function readableIn(buffer) {
  const found = [];
  const needles = {
    'the marker': Buffer.from(MARKER),
    'the marker (UTF-16)': Buffer.from(MARKER, 'utf16le'),
    'the marker (base64)': Buffer.from(Buffer.from(MARKER).toString('base64').slice(0, 20)),
    'the file name': Buffer.from(NAME_MARKER),
    'file text': Buffer.from('Quarterly numbers'),
    'file text (2)': Buffer.from('lorem ipsum dolor')
  };
  for (const [name, needle] of Object.entries(needles)) {
    if (buffer.includes(needle)) found.push(name);
  }
  return found;
}

async function main() {
  const external = externalS3Mode();
  if (external.mode === 'fail') throw new Error(external.reason);
  const kind = external.mode === 'run' ? 'external' : 'fake';
  const s3 = await openS3Target(kind);
  console.log(
    `S3 server: ${kind === 'fake' ? 'in-repo fake' : 'external'} at ${s3.endpoint}, bucket ${s3.bucket}, prefix ${s3.prefix}\n`
  );
  const contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-s3-e2e-'));
  const s3Block = s3.config({ maxAttempts: 2 });
  let server = null;
  let logs = '';
  const chatId = `e2e-${crypto.randomUUID()}`;
  let fileId = null;

  const boot = async label => {
    server = await startServer({ contentsDir });
    const outcome = await server.settled;
    if (!outcome.ready) {
      throw new Error(
        `${label}: the server did not come up (${outcome.reason}, exit ${outcome.exitCode})\n${server
          .output()
          .split('\n')
          .filter(line => /"level":"(error|warn)"/.test(line))
          .slice(-8)
          .join('\n')}`
      );
    }
    return outcome;
  };
  const stop = async () => {
    if (!server) return null;
    const end = await server.stop();
    logs += server.output();
    server = null;
    return end;
  };

  try {
    await step('seed a fresh contents directory and configure S3 with encryption on', async () => {
      await seedContents(contentsDir);
      const storage = await writeStorageConfig(contentsDir, {
        encryption: { enabled: true },
        blobs: { provider: 's3', s3: s3Block }
      });
      expect(storage.provider === 'filesystem', `storage.provider is ${storage.provider}`);
    });

    const up = await step(
      'boot the real server; /api/health reports the S3 blob store',
      async () => {
        const outcome = await boot('first boot');
        const blobs = outcome.health?.storage?.blobs;
        expect(outcome.health?.storage?.ready === true, 'storage is not ready');
        expect(
          blobs?.provider === 's3' && blobs?.status === 'ok',
          `health.storage.blobs is ${JSON.stringify(blobs)}`
        );
        return `health.storage = ${JSON.stringify(outcome.health.storage)}`;
      }
    );
    if (!up) return;

    let client = clientFor(server.baseUrl);
    if (!(await step('log in as the default admin', () => client.login()))) return;

    const uploaded = await step(
      'upload a chat file through POST /api/chats/{chatId}/files',
      async () => {
        const form = new FormData();
        form.append('file', new Blob([FILE_BYTES], { type: 'text/plain' }), FILE_NAME);
        const answer = await client.request('POST', `/api/chats/${chatId}/files`, { body: form });
        expect(
          answer.status === 201,
          `upload answered ${answer.status}: ${answer.bytes.toString('utf8').slice(0, 300)}`
        );
        fileId = answer.json?.id;
        expect(typeof fileId === 'string' && fileId, 'the answer carries no file id');
        expect(
          answer.headers.get('location')?.endsWith(`/files/${fileId}`),
          `Location is ${answer.headers.get('location')}`
        );
        return `file id ${fileId}, ${FILE_BYTES.length} bytes`;
      }
    );
    if (!uploaded) return;

    const readBack = label =>
      step(label, async () => {
        const text = await client.request(
          'GET',
          `/api/chats/${chatId}/files/${fileId}?format=text&raw=1`
        );
        expect(text.status === 200, `text read answered ${text.status}`);
        expect(text.bytes.toString('utf8').includes(MARKER), 'the extracted text lacks the marker');
        const original = await client.request('GET', `/api/chats/${chatId}/files/${fileId}`);
        expect(original.status === 200, `original read answered ${original.status}`);
        expect(
          sha256(original.bytes) === sha256(FILE_BYTES),
          `the original came back changed (${original.bytes.length} bytes)`
        );
        const listing = await client.request('GET', `/api/chats/${chatId}/files`);
        expect(listing.status === 200, `file list answered ${listing.status}`);
        expect(
          listing.json?.items?.some(item => item.id === fileId),
          'the file is not in the chat file list'
        );
        return `text and original (${original.bytes.length} bytes, sha256 equal) read back`;
      });
    await readBack('read the file back: extracted text, original bytes, file list');

    let chatObjects = [];
    await step(
      'the bucket holds only ciphertext: no marker, no file name, envelopes only',
      async () => {
        const objects = await bucketObjects(s3);
        chatObjects = objects.filter(object => object.key.includes('/chat-files/'));
        expect(
          chatObjects.length >= 1,
          `no chat-files object in the bucket: ${objects.map(o => o.key)}`
        );
        const total = objects.reduce((sum, object) => sum + object.data.length, 0);
        expect(total >= FILE_BYTES.length, `the bucket holds ${total} bytes, less than the upload`);
        for (const object of objects) {
          const inData = readableIn(object.data);
          expect(inData.length === 0, `${object.key} holds ${inData.join(', ')} in clear`);
          const inName = readableIn(Buffer.from(object.key));
          expect(inName.length === 0, `the object name ${object.key} holds ${inName.join(', ')}`);
          expect(
            object.data.subarray(0, 4).toString('latin1') === 'IHB1',
            `${object.key} is not an encrypted envelope`
          );
        }
        return `${objects.length} objects, ${total} bytes: ${objects.map(o => o.key.slice(s3.prefix.length + 1)).join(', ')}`;
      }
    );

    await step('no blob was written to local disk beside the bucket', async () => {
      const local = await localBlobFiles(contentsDir);
      expect(local.user.length === 0, `files under data/blobs: ${local.user.join(', ')}`);
      expect(
        local.internalNotEncrypted.length === 0,
        `not encrypted: ${local.internalNotEncrypted.join(', ')}`
      );
      for (const file of local.internal) {
        const data = await fs.readFile(path.join(contentsDir, 'data', 'blobs', file));
        expect(readableIn(data).length === 0, `${file} holds upload content`);
      }
      return local.internal.length > 0
        ? `only the storage layer's own encrypted files: ${local.internal.join(', ')}`
        : 'data/blobs is empty';
    });

    const restarted = await step('restart the server on the same contents and bucket', async () => {
      const end = await stop();
      expect(end.clean && end.exitCode === 0, `the server stopped with ${JSON.stringify(end)}`);
      const outcome = await boot('second boot');
      expect(
        outcome.health?.storage?.blobs?.status === 'ok',
        'blob storage is not ok after restart'
      );
      client = clientFor(server.baseUrl);
      await client.login();
    });
    if (!restarted) return;
    await readBack('read the file again after the restart');

    await step('delete the chat; its objects leave the bucket', async () => {
      const answer = await client.request('DELETE', `/api/chats/${chatId}`);
      expect([200, 204].includes(answer.status), `delete answered ${answer.status}`);
      const names = new Set(chatObjects.map(object => object.key));
      const deadline = Date.now() + 15_000;
      let left = [];
      do {
        left = (await s3.rawObjects()).filter(
          object => names.has(object.key) || object.key.includes(chatId)
        );
        if (left.length === 0) break;
        await sleep(250);
      } while (Date.now() < deadline);
      expect(
        left.length === 0,
        `still in the bucket after 15 s: ${left.map(o => o.key).join(', ')}`
      );
      const gone = await client.request('GET', `/api/chats/${chatId}/files/${fileId}`);
      expect(gone.status === 404, `the deleted file answers ${gone.status}`);
      const rest = (await s3.rawObjects()).map(object => object.key.slice(s3.prefix.length + 1));
      return `left in the bucket: ${rest.join(', ') || 'nothing'}`;
    });

    // The route ships with the S3 backend: a 404 here is a failure like any
    // other status (a removed route or a lost registration must not pass).
    await step('GET /api/admin/storage reports the S3 blob store and no credentials', async () => {
      const answer = await client.request('GET', '/api/admin/storage');
      expect(answer.status === 200, `answered ${answer.status}`);
      const text = answer.bytes.toString('utf8');
      expect(!text.includes(s3Block.secretAccessKey), 'the secret access key is in the answer');
      expect(/s3/.test(text), 'the answer does not mention s3');
      return text.slice(0, 400);
    });

    await step(
      'stop the server; the log holds neither the marker nor the secret access key',
      async () => {
        const end = await stop();
        expect(end.clean && end.exitCode === 0, `the server stopped with ${JSON.stringify(end)}`);
        expect(!logs.includes(MARKER), 'the file content marker is in the server log');
        expect(
          !logs.includes(s3Block.secretAccessKey),
          'the secret access key is in the server log'
        );
        const errors = logs.split('\n').filter(line => /"level":"error"/.test(line));
        expect(errors.length === 0, `error-level log lines:\n${errors.slice(0, 5).join('\n')}`);
      }
    );
  } finally {
    await stop().catch(() => {});
    await s3.close().catch(() => {});
    if (keep) console.log(`\ncontents directory kept: ${contentsDir}`);
    else await fs.rm(contentsDir, { recursive: true, force: true });
  }
}

main()
  .catch(error => record('FAIL', 'the run itself', String(error?.stack || error).slice(0, 800)))
  .finally(() => {
    const failed = results.filter(result => result.status === 'FAIL').length;
    const notes = results.filter(result => result.status === 'NOTE').length;
    const passed = results.filter(result => result.status === 'PASS').length;
    console.log(
      `\nS3 end-to-end: ${passed} passed, ${failed} failed, ${notes} skipped with a note`
    );
    process.exit(failed > 0 ? 1 : 0);
  });
