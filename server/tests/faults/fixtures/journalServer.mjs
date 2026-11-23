// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A small server with a journal, for the self-test of the fault harness
 * (`harness.fault.test.js`). It is what a job with one write is reduced to:
 *
 * 1. `POST /jobs/<id>` writes "write started" to the journal, writes to the
 *    counter of the harness, and writes "write done" to the journal.
 * 2. When the server starts, it reads the journal. A job that started its write
 *    and never finished it was interrupted.
 *
 * What it does with an interrupted job is the protection the self-test
 * switches:
 *
 * - `FIXTURE_WRITE_GUARD` unset (the protection is on): the write is not
 *   repeated, because nobody knows whether it happened. The job ends as
 *   `needs-attention`.
 * - `FIXTURE_WRITE_GUARD=off`: the write is repeated. When the server died
 *   after the first write, the counter then shows 2.
 *
 * The switch lives here, in a fixture, so that the server of the product needs
 * no switch that turns a protection off. The self-test proves with it that the
 * harness sees a double write: a harness that reported 1 in both positions
 * would prove nothing about the product either.
 *
 * `GET /jobs/<id>` answers `{ id, state }`; `GET /health` answers once the
 * journal was read and interrupted jobs were dealt with.
 *
 * Environment: `PORT`, `FIXTURE_JOURNAL` (a file), `FIXTURE_COUNTER_URL`, and the
 * kill point variables of `server/utils/killPoint.js`.
 */

import fs from 'node:fs';
import http from 'node:http';
import { killPoint } from '../../../utils/killPoint.js';

const journalFile = process.env.FIXTURE_JOURNAL;
const counterUrl = process.env.FIXTURE_COUNTER_URL;
const guard = process.env.FIXTURE_WRITE_GUARD !== 'off';

/** @type {Map<string, string>} job id -> state */
const jobs = new Map();

const record = (id, event) => {
  // Synchronous: the line is in the file before the next step runs.
  fs.appendFileSync(journalFile, `${JSON.stringify({ id, event })}\n`);
  jobs.set(id, event);
};

async function write(id) {
  const response = await fetch(`${counterUrl}/count/${encodeURIComponent(id)}`, {
    method: 'POST'
  });
  if (!response.ok) throw new Error(`the counter answered ${response.status}`);
}

async function runJob(id) {
  record(id, 'write-started');
  killPoint('fixture-before-write');
  await write(id);
  killPoint('fixture-after-write');
  record(id, 'write-done');
}

/** Read the journal and deal with the jobs a dead process left behind. */
async function recover() {
  if (!fs.existsSync(journalFile)) return;
  for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
    if (!line) continue;
    const { id, event } = JSON.parse(line);
    jobs.set(id, event);
  }
  for (const [id, state] of [...jobs]) {
    if (state !== 'write-started') continue;
    if (guard) {
      record(id, 'needs-attention');
    } else {
      await write(id);
      record(id, 'write-done');
    }
  }
}

let recovered = false;

const server = http.createServer((req, res) => {
  const answer = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (req.url === '/health') return answer(recovered ? 200 : 503, { recovered });
  const job = /^\/jobs\/([A-Za-z0-9-]{1,64})$/.exec(req.url || '');
  if (!job) return answer(404, { error: 'not found' });
  const id = job[1];
  if (req.method === 'GET') return answer(200, { id, state: jobs.get(id) ?? null });
  if (req.method !== 'POST') return answer(405, { error: 'GET or POST' });
  runJob(id).then(
    () => answer(200, { id, state: jobs.get(id) }),
    error => answer(500, { error: error.message })
  );
});

server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  recover().then(
    () => {
      recovered = true;
    },
    error => {
      console.error(`[journalServer] recovery failed: ${error.message}`);
      process.exit(1);
    }
  );
});
