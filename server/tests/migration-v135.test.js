import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version } from '../migrations/V135__raise_bundled_output_token_limits.js';

let dir;

function makeCtx(base) {
  return {
    readJson: async rel => JSON.parse(await fs.readFile(path.join(base, rel), 'utf8')),
    writeJson: async (rel, data) =>
      fs.writeFile(path.join(base, rel), JSON.stringify(data, null, 2), 'utf8'),
    listFiles: async subdir =>
      (await fs.readdir(path.join(base, subdir))).filter(f => f.endsWith('.json')),
    log: () => {}
  };
}

async function put(id, maxOutputTokens) {
  await fs.writeFile(
    path.join(dir, 'models', `${id}.json`),
    JSON.stringify({ id, maxOutputTokens })
  );
}
async function read(id) {
  return JSON.parse(await fs.readFile(path.join(dir, 'models', `${id}.json`), 'utf8'));
}

describe('migration V135', () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v135-'));
    await fs.mkdir(path.join(dir, 'models'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('has version 135', () => assert.equal(version, '135'));

  it('raises bundled models that still carry the shipped value', async () => {
    await put('claude-haiku-4-5', 8000);
    await put('mistral-large', 8000);
    await put('local-vllm', 8000);
    await up(makeCtx(dir));
    assert.equal((await read('claude-haiku-4-5')).maxOutputTokens, 64000);
    assert.equal((await read('mistral-large')).maxOutputTokens, 32000);
    assert.equal((await read('local-vllm')).maxOutputTokens, 16000);
  });

  it('leaves an admin-chosen value and unrelated models alone', async () => {
    await put('local-vllm', 12000);
    await put('mistral-small', 4000);
    await put('my-own-model', 8000);
    await up(makeCtx(dir));
    assert.equal((await read('local-vllm')).maxOutputTokens, 12000);
    assert.equal((await read('mistral-small')).maxOutputTokens, 4000);
    assert.equal((await read('my-own-model')).maxOutputTokens, 8000);
  });
});
