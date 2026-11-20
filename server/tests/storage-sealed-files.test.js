// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Encryption at rest of the stores that keep user content in files of their
 * own, outside the storage layer (`storage/atRest/sealedFiles.js`): agent
 * artifacts, agent memory, agent inboxes and the short-link file, written and
 * read through their real services. (Tool-job results need cluster workers:
 * `toolJobsCluster.test.js`. The artifact routes: `agentArtifactRoutesErrors.test.js`.)
 *
 * It is the sibling of `storage-nothing-readable.test.js` for these stores:
 * with the switch on, a marker written through every service is found in no
 * file of the **contents** directory. The data directory is `contents/data`
 * here, as in an installation, because the services write below `contents/`.
 *
 * `feedback.jsonl` is written too and is expected to stay readable: it is
 * left in plaintext on purpose (read with `jq` and rotated by hand).
 */
import { contentsDir } from './support/scratchContents.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-sealed-files-'));
const baseDir = path.join(contentsDir, 'data');

// Everything that loads the server configuration is imported after
// CONTENTS_DIR is set: the services write below it.
const { filesUnder, findReadable } = await import('./support/atRestTestSupport.js');
const { getContentsPath } = await import('../utils/contentsPath.js');
assert.equal(getContentsPath(), contentsDir, 'the services write into the scratch directory');

const storage = await import('../storage/index.js');
const { beginAtRestPreparation, endAtRestPreparation } =
  await import('../storage/atRest/policy.js');
const { prepareStorageEncryption } = await import('../storage/atRest/prepare.js');
const { atRestStatePath, readAtRestState } = await import('../storage/atRest/state.js');
const sealedFiles = await import('../storage/atRest/sealedFiles.js');
const { isSealedFile } = await import('../crypto/fileSeal.js');
const { main: encryptCommand } = await import('../storage/commands/encryptStorage.js');
const { main: showCommand } = await import('../storage/commands/showStorage.js');
const { writeArtifactDirect } = await import('../agents/runtime/artifactStore.js');
const memoryFile = await import('../agents/memory/memoryFile.js');
const inboxStore = await import('../agents/inbox/inboxStore.js');
const shortLinks = await import('../shortLinkManager.js');
const feedback = await import('../feedbackStorage.js');

const MARKER = `IHUB-FILE-CANARY-${crypto.randomBytes(8).toString('hex')}`;
const RUN_ID = 'run-canary-1';

const platformConfig = enabled => ({
  storage: {
    provider: 'filesystem',
    filesystem: { baseDir, fenceSweepIntervalMs: 0, flushIntervalMs: 25 },
    encryption: { enabled }
  }
});
const start = enabled =>
  storage.initializeStorage({ env: {}, platformConfig: platformConfig(enabled) });
const prepare = (enabled, options = {}) =>
  prepareStorageEncryption({ env: {}, platformConfig: platformConfig(enabled), ...options });

const paths = {
  artifact: name => path.join(baseDir, 'agent-artifacts', RUN_ID, name),
  memory: id => path.join(contentsDir, 'agents', 'memory', `${id}.md`),
  inbox: id => path.join(baseDir, 'agent-inboxes', `${id}.md`),
  links: () => path.join(baseDir, 'shortlinks.json'),
  feedback: () => path.join(baseDir, 'feedback.jsonl')
};

/** The files of the sealed stores that exist, relative to the contents directory. */
async function storeFiles() {
  const all = await filesUnder(contentsDir);
  return all
    .map(file => path.relative(contentsDir, file))
    .filter(
      relative =>
        /^(data\/agent-artifacts|data\/agent-inboxes|agents\/memory)\//.test(relative) ||
        relative === path.join('data', 'shortlinks.json')
    )
    .filter(relative => !relative.endsWith('.lock'));
}

/** Which of the store files are sealed on disk. */
async function sealedState() {
  const state = {};
  for (const relative of await storeFiles()) {
    state[relative] = isSealedFile(await fs.readFile(path.join(contentsDir, relative)));
  }
  return state;
}

/** Write the marker through every service; `tag` keeps the writes of one test apart. */
async function writeEverything(tag) {
  await writeArtifactDirect({
    runId: RUN_ID,
    name: `${tag}-report.md`,
    content: `# Report\n\n${MARKER} artifact ${tag} äöü\n`
  });
  await memoryFile.writeMemory(`agent-${tag}`, {
    mode: 'replace',
    content: `${MARKER} memory ${tag}`,
    updatedBy: 'test'
  });
  await memoryFile.writeMemory(`agent-${tag}`, { mode: 'append', content: `${MARKER} appended` });
  await inboxStore.writeInbox(`inbox-${tag}`, { body: `# Todo\n`, updatedBy: 'user:anna' });
  await inboxStore.addInboxItem(`inbox-${tag}`, { text: `${MARKER} item ${tag}`, priority: 'p1' });
  await inboxStore.addInboxItem(`inbox-${tag}`, { text: `${MARKER} second` });
  await inboxStore.markInboxItemDone(`inbox-${tag}`, { text: 'second', note: 'done' });
  return shortLinks.createLink({
    appId: 'chat',
    ownerId: 'anna',
    params: { prompt: `${MARKER} link ${tag}` },
    includeParams: true
  });
}

/** Read everything back through the services and compare. */
async function assertReadable(tag, link) {
  const memory = await memoryFile.readMemory(`agent-${tag}`);
  assert.equal(memory.version, 2);
  assert.equal(memory.body, `${MARKER} memory ${tag}\n${MARKER} appended\n`);
  assert.equal(memory.updatedBy, 'system');
  const inbox = await inboxStore.readInbox(`inbox-${tag}`);
  assert.equal(inbox.version, 4);
  assert.deepEqual(
    inbox.items.map(item => [item.status, item.priority, item.text]),
    [
      ['open', 'p1', `${MARKER} item ${tag}`],
      ['done', 'unprioritized', `${MARKER} second`]
    ]
  );
  const listed = (await inboxStore.listInboxes()).find(entry => entry.inboxId === `inbox-${tag}`);
  assert.deepEqual([listed.openCount, listed.totalCount], [1, 2]);
  assert.equal((await shortLinks.getLink(link.code)).params.prompt, `${MARKER} link ${tag}`);
  const artifact = await sealedFiles.readSealedText(
    'agent-artifacts',
    `${RUN_ID}/${tag}-report.md`,
    paths.artifact(`${tag}-report.md`)
  );
  assert.equal(artifact, `# Report\n\n${MARKER} artifact ${tag} äöü\n`);
}

after(async () => {
  endAtRestPreparation();
  await storage.shutdownStorage();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('files outside the storage layer, switch on from the first start', () => {
  let link;

  it('round-trips artifacts, memory, inboxes and short links through their services', async () => {
    await start(true);
    assert.equal(sealedFiles.sealedFilesMode(), 'enforced');
    assert.equal((await readAtRestState(baseDir)).facets.files, 1);
    link = await writeEverything('on');
    await assertReadable('on', link);
  });

  it('holds the marker in no file of the contents directory, except the feedback log', async () => {
    feedback.storeFeedback({
      messageId: 'm1',
      appId: 'chat',
      rating: 1,
      comment: `${MARKER} feedback comment`,
      contentSnippet: `${MARKER} answer snippet`
    });
    assert.equal(
      (await feedback.readFeedbackPage()).items[0].comment,
      `${MARKER} feedback comment`
    );

    const files = await storeFiles();
    assert.deepEqual(files.sort(), [
      path.join('agents', 'memory', 'agent-on.md'),
      path.join('data', 'agent-artifacts', RUN_ID, 'on-report.md'),
      path.join('data', 'agent-inboxes', 'inbox-on.md'),
      path.join('data', 'shortlinks.json')
    ]);
    const hits = await findReadable(contentsDir, [MARKER, 'appended', 'Todo', 'unprioritized']);
    assert.deepEqual(
      [...new Set(hits.map(hit => path.relative(contentsDir, hit.file)))],
      [path.join('data', 'feedback.jsonl')],
      'only the feedback log, which is left in plaintext on purpose, is readable'
    );
    assert.deepEqual(Object.values(await sealedState()), [true, true, true, true]);
  });

  it('reports the size of the content, not of the sealed file', async () => {
    const file = paths.artifact('on-report.md');
    const stored = (await fs.stat(file)).size;
    const content = Buffer.byteLength(`# Report\n\n${MARKER} artifact on äöü\n`);
    assert.ok(stored > content + 512);
    assert.equal(await sealedFiles.contentSize(file, stored), content);
  });

  it('does not open a sealed file under another name or in another store', async () => {
    await fs.copyFile(paths.memory('agent-on'), paths.memory('agent-other'));
    await assert.rejects(memoryFile.readMemory('agent-other'), { code: 'CORRUPT_DOCUMENT' });
    await fs.copyFile(paths.memory('agent-on'), paths.inbox('inbox-moved'));
    await assert.rejects(inboxStore.readInbox('inbox-moved'), { code: 'CORRUPT_DOCUMENT' });
    await fs.rm(paths.memory('agent-other'));
    await fs.rm(paths.inbox('inbox-moved'));
  });

  it('rejects a plaintext file that appears after the conversion is recorded', async () => {
    await fs.writeFile(paths.memory('agent-planted'), '---\nversion: 9\n---\nplanted\n');
    await assert.rejects(memoryFile.readMemory('agent-planted'), { code: 'PLAINTEXT_FILE' });
    await assert.rejects(
      memoryFile.writeMemory('agent-planted', { content: 'x' }),
      { code: 'PLAINTEXT_FILE' },
      'a write reads the current version first and must not build on planted content'
    );
    await fs.rm(paths.memory('agent-planted'));
    await fs.writeFile(paths.inbox('inbox-planted'), '- [ ] planted\n');
    await assert.rejects(inboxStore.readInbox('inbox-planted'), { code: 'PLAINTEXT_FILE' });
    assert.deepEqual(
      (await inboxStore.listInboxes()).map(entry => entry.inboxId),
      ['inbox-on'],
      'the list leaves it out'
    );
    await fs.rm(paths.inbox('inbox-planted'));
  });

  it('shows a file decrypted on the server shell (storage:show --file)', async () => {
    const printed = [];
    const show = (...argv) => {
      printed.length = 0;
      return showCommand(argv, {
        out: text => printed.push(Buffer.isBuffer(text) ? text.toString('utf8') : text),
        env: {},
        platformConfig: platformConfig(true)
      });
    };
    assert.equal(await show('--file', 'agent-memory', 'agent-on.md'), 0);
    assert.match(printed.join(''), new RegExp(`${MARKER} memory on\\n${MARKER} appended`));
    assert.equal(await show('--file', 'agent-artifacts', `${RUN_ID}/on-report.md`), 0);
    assert.ok(printed.join('').includes(`${MARKER} artifact on`));
    assert.equal(await show('--file', 'short-links', 'shortlinks.json'), 0);
    assert.equal(JSON.parse(printed.join('')).links[0].code, link.code);
    assert.equal(await show('--file', 'agent-memory', '../../config/platform.json'), 1);
    assert.equal(await show('--file', 'agent-memory', 'nobody.md'), 1);
    assert.equal(await show('--file', 'no-such-store', 'x'), 1);
  });
});

describe('files outside the storage layer, switch off again', () => {
  it('writes plaintext, still reads what was sealed, and the search finds the plaintext', async () => {
    await storage.shutdownStorage();
    await start(false);
    assert.equal(sealedFiles.sealedFilesMode(), 'off');
    assert.equal((await readAtRestState(baseDir)).state, 'off');

    // Mixed state: sealed files from before, plaintext files from now.
    assert.equal(
      (await memoryFile.readMemory('agent-on')).body,
      `${MARKER} memory on\n${MARKER} appended\n`
    );
    const link = await writeEverything('off');
    await assertReadable('off', link);
    assert.equal((await inboxStore.readInbox('inbox-on')).items.length, 2);

    const state = await sealedState();
    assert.equal(state[path.join('agents', 'memory', 'agent-on.md')], true);
    assert.equal(state[path.join('data', 'agent-artifacts', RUN_ID, 'on-report.md')], true);
    assert.equal(state[path.join('agents', 'memory', 'agent-off.md')], false);
    assert.equal(state[path.join('data', 'agent-inboxes', 'inbox-off.md')], false);
    assert.equal(state[path.join('data', 'agent-artifacts', RUN_ID, 'off-report.md')], false);
    assert.equal(state[path.join('data', 'shortlinks.json')], false, 'rewritten as a whole');
    assert.equal(
      await fs.readFile(paths.artifact('off-report.md'), 'utf8'),
      `# Report\n\n${MARKER} artifact off äöü\n`,
      'the file is what it was before this feature'
    );
    assert.match(
      await fs.readFile(paths.memory('agent-off'), 'utf8'),
      /^---\nprofileId: agent-off\n/
    );
    assert.equal(JSON.parse(await fs.readFile(paths.links(), 'utf8')).links.length, 2);

    // A write to a sealed file with the switch off leaves it in plaintext.
    await memoryFile.writeMemory('agent-on', { mode: 'append', content: 'later' });
    assert.equal((await sealedState())[path.join('agents', 'memory', 'agent-on.md')], false);
    const hits = await findReadable(path.join(contentsDir, 'agents'), [MARKER]);
    assert.equal(hits.length > 0, true);
  });
});

describe('files outside the storage layer, conversion of an existing installation', () => {
  const OLD = new Date('2026-01-02T03:04:05.000Z');
  let plainBefore;

  it('a dry run counts the plaintext files and changes nothing', async () => {
    for (let index = 0; index < 30; index += 1) {
      await writeArtifactDirect({
        runId: RUN_ID,
        name: `bulk-${index}.md`,
        content: `${MARKER} bulk ${index}`
      });
    }
    await fs.utimes(paths.artifact('off-report.md'), OLD, OLD);
    await storage.shutdownStorage();
    plainBefore = Object.values(await sealedState()).filter(sealed => !sealed).length;
    // on-report.md and inbox-on.md are still sealed from the first start.
    assert.equal(plainBefore, (await storeFiles()).length - 2);

    const printed = [];
    const code = await encryptCommand(['--dry-run'], {
      out: text => printed.push(text),
      env: {},
      platformConfig: platformConfig(true)
    });
    assert.equal(code, 0);
    assert.match(
      printed.join(''),
      new RegExp(`files\\s+${plainBefore} of ${plainBefore + 2} \\(`),
      printed.join('')
    );
    assert.match(printed.join(''), /Not covered\s+data\/feedback\.jsonl \(stay in plaintext\)/);
    assert.doesNotMatch(printed.join(''), /agent-artifacts|agents\/memory|shortlinks\.json/);
    assert.equal(Object.values(await sealedState()).filter(sealed => !sealed).length, plainBefore);
    assert.equal((await readAtRestState(baseDir)).state, 'off');
  });

  it('a start with the switch on is refused until the files are converted', async () => {
    await assert.rejects(start(true), { code: 'ENCRYPTION_NOT_CONVERTED' });
  });

  it('an interrupted conversion leaves a mixed state that is read, and the next run finishes it', async () => {
    const interrupt = new AbortController();
    const first = await prepare(true, {
      signal: interrupt.signal,
      onObject: event => {
        if (event.facet === 'files') interrupt.abort();
      }
    });
    assert.equal(first.action, 'aborted');
    let state = await readAtRestState(baseDir);
    assert.equal(state.state, 'converting');
    assert.deepEqual(state.facets, { blobs: 1, documents: 1, logs: 1 });
    const sealedSoFar = Object.values(await sealedState()).filter(Boolean).length - 2;
    assert.ok(sealedSoFar >= 1 && sealedSoFar < plainBefore, `${sealedSoFar} of ${plainBefore}`);

    // The preparing process reads both forms and seals what it writes.
    beginAtRestPreparation();
    await start(true);
    assert.equal(sealedFiles.sealedFilesMode(), 'converting');
    assert.equal((await memoryFile.readMemory('agent-off')).version, 2);
    assert.equal((await inboxStore.readInbox('inbox-off')).items.length, 2);
    assert.equal((await inboxStore.readInbox('inbox-on')).items.length, 2);
    await storage.shutdownStorage();
    endAtRestPreparation();

    const second = await prepare(true);
    assert.equal(second.action, 'converted');
    state = await readAtRestState(baseDir);
    assert.equal(state.state, 'complete');
    assert.deepEqual(state.facets, { blobs: 1, documents: 1, logs: 1, files: 1 });
    assert.equal(state.converted.files, plainBefore - sealedSoFar);
    assert.deepEqual(second.plaintextStores, [path.join('data', 'feedback.jsonl')]);
    assert.ok(Object.values(await sealedState()).every(Boolean));
    assert.equal((await fs.stat(paths.artifact('off-report.md'))).mtimeMs, OLD.getTime());
    assert.deepEqual(
      (await fs.readdir(path.join(baseDir, 'agent-artifacts', RUN_ID))).filter(name =>
        name.startsWith('.')
      ),
      [],
      'no temporary file is left'
    );
  });

  it('after the conversion the services read everything, strictly, and nothing is readable', async () => {
    await start(true);
    assert.equal(sealedFiles.sealedFilesMode(), 'enforced');
    const links = await shortLinks.searchLinks({ ownerId: 'anna' });
    assert.deepEqual(
      links.map(link => link.params.prompt),
      [`${MARKER} link on`, `${MARKER} link off`]
    );
    await assertReadable('off', links[1]);
    assert.equal(
      (await memoryFile.readMemory('agent-on')).body,
      `${MARKER} memory on\n${MARKER} appended\nlater\n`
    );
    const hits = await findReadable(contentsDir, [MARKER]);
    assert.deepEqual(
      [...new Set(hits.map(hit => path.relative(contentsDir, hit.file)))],
      [path.join('data', 'feedback.jsonl')]
    );
    await storage.shutdownStorage();
  });

  it('a second run finds everything encrypted', async () => {
    const again = await prepare(true);
    assert.equal(again.action, 'verified');
  });

  it('an installation converted before this facet existed converts only the files', async () => {
    const record = await readAtRestState(baseDir);
    const { files: _files, ...facets } = record.facets;
    await fs.writeFile(atRestStatePath(baseDir), JSON.stringify({ ...record, facets }));
    await fs.writeFile(paths.memory('agent-late'), `---\nversion: 3\n---\n${MARKER} late\n`);
    // A tool-job result a worker left behind, and the temporary file of a write that died.
    const jobs = path.join(baseDir, 'tool-jobs');
    await fs.mkdir(jobs, { recursive: true });
    await fs.writeFile(path.join(jobs, 'job-1.result'), `${MARKER} ocr result`);
    await fs.writeFile(path.join(jobs, 'job-2.result.123.tmp'), 'half written');
    await assert.rejects(start(true), { code: 'ENCRYPTION_NOT_CONVERTED' });

    const result = await prepare(true);
    assert.equal(result.action, 'converted');
    assert.deepEqual(result.state.converted, {
      documents: 0,
      streams: 0,
      spillBlobs: 0,
      blobs: 0,
      files: 2
    });
    assert.equal(isSealedFile(await fs.readFile(path.join(jobs, 'job-1.result'))), true);
    assert.equal(
      await fs.readFile(path.join(jobs, 'job-2.result.123.tmp'), 'utf8'),
      'half written'
    );
    await start(true);
    const late = await memoryFile.readMemory('agent-late');
    assert.deepEqual([late.version, late.body], [3, `${MARKER} late\n`]);
    assert.equal(isSealedFile(await fs.readFile(paths.memory('agent-late'))), true);
  });
});

describe('storage commands of an installation that ships only server/', () => {
  it('run.js knows encrypt and show', () => {
    const run = fileURLToPath(new URL('../storage/commands/run.js', import.meta.url));
    const result = spawnSync(process.execPath, [run, 'no-such-command'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /<check\|copy-blobs\|encrypt\|show>/);
  });
});
