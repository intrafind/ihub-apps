// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Memory of parallel uploads and of building a ZIP archive, measured in a
 * child process (`support/uploadMemoryProbe.js`, `node --expose-gc`) so that
 * this runner's own memory is not counted.
 *
 * Parallel uploads through the spool hold a bounded amount whatever their
 * number: the files that are being read (`uploads.extraction.concurrency`),
 * not every file. The same uploads through the code path before the spool
 * (`multer.memoryStorage()`, kept in `support/uploadTestApp.js` for this
 * comparison) hold all of them at once.
 *
 * The sizes here are scaled down to keep the test short; the probe's header
 * says how to run it at full size (20 uploads of 25 MiB, a 100 MiB archive).
 */
import './support/scratchContents.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXTRACTION_CONCURRENCY } from '../services/uploads/extractionLimiter.js';

const MIB = 1024 * 1024;
const PROBE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'support',
  'uploadMemoryProbe.js'
);

/** Run the probe and return what it printed. */
function probe(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', PROBE], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', code => {
      const line = stdout.split('\n').find(text => text.startsWith('{"probe"'));
      if (code !== 0 || !line) {
        return void reject(new Error(`The probe failed (${code}): ${stderr.slice(-2000)}`));
      }
      resolve(JSON.parse(line));
    });
  });
}

const mib = bytes => `${(bytes / MIB).toFixed(1)} MiB`;

describe('memory of uploads and archives', () => {
  it(
    'parallel uploads hold the files being read, not every file',
    { timeout: 300_000 },
    async () => {
      const uploads = 12;
      const bytesEach = 8 * MIB;
      const result = await probe({
        PROBE_MODES: 'spool,memory',
        PROBE_UPLOADS: String(uploads),
        PROBE_UPLOAD_BYTES: String(bytesEach)
      });
      const { spool, memory } = result;
      assert.equal(spool.ok, true, `every spooled upload was stored: ${JSON.stringify(spool)}`);
      assert.equal(memory.ok, true, `every buffered upload was stored: ${JSON.stringify(memory)}`);

      // The bound: per file being read, the file itself and its extracted text
      // twice (the string from the extraction thread and the bytes that are
      // stored), plus the same again for a file whose text is being stored while
      // the next ones are read, plus 16 MiB for streams in flight and for what
      // the collector has not freed yet. It does not grow with the number of uploads.
      const bound = (DEFAULT_EXTRACTION_CONCURRENCY + 1) * 3 * bytesEach + 16 * MIB;
      const total = uploads * bytesEach;
      assert.ok(bound < total, 'the bound is below what holding every upload takes');
      assert.ok(
        spool.peakArrayBuffers < bound,
        `spooled: peak ${mib(spool.peakArrayBuffers)}, bound ${mib(bound)}`
      );
      // The old path held every upload at once.
      assert.ok(
        memory.peakArrayBuffers > total * 0.9,
        `buffered: peak ${mib(memory.peakArrayBuffers)} for ${mib(total)} of uploads`
      );
      assert.ok(
        spool.peakArrayBuffers < memory.peakArrayBuffers / 2,
        `spooled ${mib(spool.peakArrayBuffers)} against buffered ${mib(memory.peakArrayBuffers)}`
      );
    }
  );

  it(
    'an archive built into a spool file holds a few MiB, not the archive',
    { timeout: 300_000 },
    async () => {
      const zipBytes = 48 * MIB;
      const result = await probe({
        PROBE_MODES: 'zip-buffer,zip-file',
        PROBE_ZIP_BYTES: String(zipBytes),
        PROBE_ZIP_MEMBERS: '6'
      });
      const built = result['zip-file'];
      const buffered = result['zip-buffer'];
      assert.equal(built.contentBytes, zipBytes);
      assert.ok(built.archiveBytes >= zipBytes, 'random content does not compress');
      assert.ok(
        built.peakArrayBuffers < 16 * MIB,
        `spooled archive: peak ${mib(built.peakArrayBuffers)}`
      );
      assert.ok(
        buffered.peakArrayBuffers > zipBytes,
        `in-memory archive: peak ${mib(buffered.peakArrayBuffers)}`
      );
    }
  );
});
