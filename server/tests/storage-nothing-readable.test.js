// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Nothing readable in the data directory": with `storage.encryption.enabled`
 * on a filesystem installation, a chat is written the way the server writes
 * it (chat document with a title, transcript, run ledger events, a spilled
 * tool result, an uploaded file) and then every file under the data directory
 * is read raw, behind the provider's back, and searched for the marker.
 *
 * A marker document also goes into every declared runtime namespace and a
 * marker blob into every declared blob namespace, so a namespace added later
 * is covered without touching this file.
 *
 * What stays visible by design, and is asserted as such: file names (ids,
 * never content), owner ids, timestamps, sizes and sequence numbers.
 */
import './support/scratchContents.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filesUnder, findReadable } from './support/atRestTestSupport.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-fs-readable-'));
const storage = await import('../storage/index.js');
const { BLOB_NAMESPACES, RUNTIME_NAMESPACES } = await import('../storage/namespaces.js');
const { ChatRepository } = await import('../services/chat/ChatRepository.js');
const { RunLedgerStore } = await import('../services/loop/runLedgerStore.js');

const MARKER = `IHUB-PLAINTEXT-CANARY-${crypto.randomBytes(8).toString('hex')}`;
const OWNER = 'anna@example.org';
const CHAT_ID = 'chat-canary-1';
const RUN_ID = 'run-canary-1';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const baseDir = path.join(scratch, 'data');
let provider;

/** Start storage as a server start composes it from platform.json. */
const start = enabled =>
  storage.initializeStorage({
    env: {},
    platformConfig: {
      storage: {
        provider: 'filesystem',
        filesystem: { baseDir, fenceSweepIntervalMs: 0, flushIntervalMs: 25 },
        encryption: { enabled }
      }
    }
  });

/** Write one chat with the marker in title, messages, ledger events, a spill and a file. */
async function writeChat() {
  const chats = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: quiet
  });
  await chats.ensureChat({
    chatId: CHAT_ID,
    ownerId: OWNER,
    identityMode: 'default',
    appId: 'chat',
    modelId: 'model-1',
    title: `${MARKER} in the title`
  });
  await chats.appendMessage(CHAT_ID, {
    role: 'user',
    content: `${MARKER} in the question`,
    runId: RUN_ID
  });
  await chats.appendMessage(CHAT_ID, {
    role: 'assistant',
    content: `${MARKER} in the answer, with Umlauten äöü`,
    runId: RUN_ID
  });

  const ledger = new RunLedgerStore({
    logs: provider.logs,
    documents: provider.documents,
    locks: provider.locks
  });
  const events = [
    ['message/user', { content: `${MARKER} ledger question` }],
    ['tool/call', { name: 'search', arguments: { query: `${MARKER} tool argument` } }],
    ['tool/result', { output: `${MARKER} tool result` }],
    ['message/assistant', { content: `${MARKER} ledger answer` }]
  ];
  events.forEach(([type, data], index) =>
    ledger.appendEvent(RUN_ID, {
      seq: index + 1,
      ts: new Date().toISOString(),
      runId: RUN_ID,
      type,
      data
    })
  );
  await ledger.putSpill(
    RUN_ID,
    'tool-result-1.json',
    JSON.stringify({ rows: [`${MARKER} spilled`] }),
    'application/json'
  );
  await provider.logs.flush();

  await provider.blobs.put(
    'chat-files',
    `chat__${CHAT_ID}__file-1.txt`,
    `${MARKER} uploaded file text `.repeat(40)
  );
  return { chats, ledger };
}

before(async () => {
  provider = await start(true);
});

after(async () => {
  await storage.shutdownStorage();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('filesystem storage with encryption on: nothing readable in the data directory', () => {
  it('reads the chat back through the repositories', async () => {
    const { chats, ledger } = await writeChat();
    assert.equal((await chats.getChat(CHAT_ID)).title, `${MARKER} in the title`);
    const transcript = await provider.documents.get('chat-messages', CHAT_ID);
    assert.equal(JSON.stringify(transcript.data).split(MARKER).length - 1, 2);
    const events = await provider.logs.read(`run:${RUN_ID}`);
    assert.deepEqual(
      events.map(event => event.type),
      ['message/user', 'tool/call', 'tool/result', 'message/assistant']
    );
    assert.equal(events[2].data.output, `${MARKER} tool result`);
    assert.ok(
      (await provider.logs.getBlob(`run:${RUN_ID}`, 'tool-result-1.json')).includes(MARKER)
    );
    void ledger;
  });

  it('writes the marker into every declared document and blob namespace', async () => {
    for (const ns of Object.values(RUNTIME_NAMESPACES)) {
      await provider.documents.put(
        ns,
        `scope__${ns}__canary`,
        { note: MARKER, list: [MARKER] },
        { ownerId: OWNER }
      );
      assert.equal(
        (await provider.documents.get(ns, `scope__${ns}__canary`)).data.note,
        MARKER,
        ns
      );
    }
    for (const ns of Object.values(BLOB_NAMESPACES)) {
      await provider.blobs.put(ns, 'scope__owner__canary', `${MARKER} blob in ${ns}`);
    }
    assert.ok(Object.values(RUNTIME_NAMESPACES).length >= 40, 'the declaration was read');
  });

  it('holds the marker in no file of the data directory, in any encoding', async () => {
    const files = await filesUnder(baseDir);
    const dirs = new Set(files.map(file => path.relative(baseDir, file).split(path.sep)[0]));
    for (const expected of ['chats', 'chat-messages', 'runs', 'logs', 'blobs', '.at-rest.json']) {
      assert.ok(dirs.has(expected), `wrote ${expected}`);
    }
    assert.ok(files.length > 100, `${files.length} files were searched`);
    const hits = await findReadable(baseDir, [
      MARKER,
      'in the question',
      'tool argument',
      'message/assistant'
    ]);
    assert.deepEqual(
      hits.map(hit => `${path.relative(baseDir, hit.file)}: ${hit.needle} (${hit.form})`),
      []
    );
  });

  it('holds every document as a sealed envelope and every log line as a key or sealed line', async () => {
    for (const ns of Object.values(RUNTIME_NAMESPACES)) {
      for (const name of await fs.readdir(path.join(baseDir, ns))) {
        if (!name.endsWith('.json')) continue;
        const stored = JSON.parse(await fs.readFile(path.join(baseDir, ns, name), 'utf8'));
        assert.deepEqual(
          [stored.v, stored.enc, typeof stored.data],
          [3, 'ihub-doc-v1', 'string'],
          `${ns}/${name}`
        );
        assert.equal('etag' in stored, false, `${ns}/${name} stores no plaintext hash`);
      }
    }
    const lines = (await fs.readFile(path.join(baseDir, 'logs', 'run', `${RUN_ID}.jsonl`), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.ok(lines.length >= 5);
    for (const line of lines)
      assert.ok(line.$key === 1 || line.$enc === 1, JSON.stringify(Object.keys(line)));
    const spill = await fs.readFile(
      path.join(baseDir, 'logs', 'run', `${RUN_ID}.blobs`, 'tool-result-1.json')
    );
    assert.equal(spill.toString('ascii', 0, 4), 'IHB1');
  });

  it('leaves visible what the store needs: ids in file names, the owner, timestamps, sizes, seq', async () => {
    const stored = JSON.parse(
      await fs.readFile(path.join(baseDir, 'chats', `${CHAT_ID}.json`), 'utf8')
    );
    assert.equal(stored.key, CHAT_ID);
    assert.equal(stored.ownerId, OWNER);
    assert.ok(stored.createdAt && stored.updatedAt && stored.size > 0);
  });

  it('the same writes with the switch off are readable: the search does find plaintext', async () => {
    await storage.shutdownStorage();
    provider = await start(false);
    await provider.documents.put(
      'chats',
      'plain-control',
      { title: `${MARKER} control` },
      { ownerId: OWNER }
    );
    const hits = await findReadable(baseDir, [MARKER]);
    assert.deepEqual(
      [...new Set(hits.map(hit => path.relative(baseDir, hit.file)))],
      [path.join('chats', 'plain-control.json')]
    );
  });
});
