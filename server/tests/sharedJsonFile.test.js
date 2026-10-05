/**
 * A JSON file shared by cluster workers (utils/sharedJsonFile.js).
 *
 * Two instances on one path stand in for two workers: each has its own cached
 * copy, as separate processes would, and only the file and its lock file are
 * shared.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedJsonFile } from '../utils/sharedJsonFile.js';

describe('createSharedJsonFile', () => {
  let dir;
  let filePath;
  const open = () => createSharedJsonFile({ filePath, createDefault: () => ({ items: [] }) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-json-'));
    filePath = path.join(dir, 'nested', 'store.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts from the default when the file does not exist', async () => {
    assert.deepEqual(await open().read(), { items: [] });
  });

  it('a change one worker makes is read by the other', async () => {
    const workerA = open();
    const workerB = open();
    assert.deepEqual(await workerB.read(), { items: [] });

    await workerA.update(data => data.items.push('from-a'));

    assert.deepEqual(await workerB.read(), { items: ['from-a'] });
  });

  it('concurrent changes from two workers all land', async () => {
    const workerA = open();
    const workerB = open();
    const add = (worker, tag, i) => worker.update(data => data.items.push(`${tag}${i}`));

    await Promise.all(
      Array.from({ length: 15 }, (_, i) => [add(workerA, 'a', i), add(workerB, 'b', i)]).flat()
    );

    const { items } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(items.length, 30);
    assert.equal(new Set(items).size, 30);
  });

  it('a change starts from the file, not from a stale cached copy', async () => {
    const workerA = open();
    const workerB = open();
    await workerB.read(); // B caches the empty file
    await workerA.update(data => data.items.push('kept'));

    await workerB.update(data => data.items.push('added'));

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).items, ['kept', 'added']);
  });

  it('a change that throws leaves the file as it was and releases the lock', async () => {
    const worker = open();
    await worker.update(data => data.items.push('before'));

    await assert.rejects(
      worker.update(data => {
        data.items.push('never');
        throw new Error('refused');
      }),
      /refused/
    );

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).items, ['before']);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
    await worker.update(data => data.items.push('after'));
    assert.deepEqual((await open().read()).items, ['before', 'after']);
  });

  it('passes the change’s return value through', async () => {
    assert.equal(await open().update(() => 'result'), 'result');
  });
});
