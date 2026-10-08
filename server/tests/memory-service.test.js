/**
 * The shared memory service: which scope a principal gets, and that the agent
 * scope reads and writes the same files agent memory always used.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-memory-svc-')));
fsSync.mkdirSync(path.join(ROOT, 'contents'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const memoryService = await import('../services/memory/memoryService.js');
const { default: memoryFile } = await import('../agents/memory/memoryFile.js');

after(() => fs.rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const AGENT = { id: 'agent:researcher', isAgent: true, profileId: 'researcher' };

describe('resolveMemoryScope', () => {
  it('gives an agent principal its own profile', async () => {
    assert.deepEqual(await memoryService.resolveMemoryScope(AGENT), {
      kind: 'agent',
      profileId: 'researcher'
    });
  });

  it('gives nothing to anyone else', async () => {
    for (const user of [
      null,
      undefined,
      {},
      { id: 'user-ada' },
      { id: 'user-ada', profileId: 'researcher' },
      { id: 'agent:x', isAgent: true },
      { id: 'agent:x', isAgent: 'true', profileId: 'x' }
    ]) {
      assert.equal(await memoryService.resolveMemoryScope(user), null, JSON.stringify(user));
    }
  });
});

describe('agent scope', () => {
  const scope = { kind: 'agent', profileId: 'writer' };

  it('reads what memoryFile stores, as a document', async () => {
    await memoryFile.writeMemory('writer', {
      content: 'a note',
      summary: 'first',
      updatedBy: 'system'
    });
    const doc = await memoryService.readMemory(scope);
    assert.equal(doc.body, 'a note\n');
    assert.equal(doc.version, 1);
    assert.equal(doc.updatedBy, 'system');
    assert.equal(doc.summary, 'first');
    assert.equal(doc.chars, 'a note\n'.length);
    assert.ok(doc.updatedAt);
  });

  it('writes through memoryFile and reports the new size', async () => {
    const result = await memoryService.writeMemory(scope, {
      mode: 'append',
      content: 'second',
      updatedBy: 'agent:writer'
    });
    assert.deepEqual(result, {
      version: 2,
      body: 'a note\nsecond\n',
      chars: 'a note\nsecond\n'.length
    });
    assert.equal((await memoryFile.readMemory('writer')).updatedBy, 'agent:writer');
  });

  it('keeps the conflict error of memoryFile', async () => {
    await assert.rejects(
      () => memoryService.writeMemory(scope, { content: 'x', expectedVersion: 0 }),
      err => err.code === 'VERSION_CONFLICT' && err.currentVersion === 2
    );
  });

  it('does not apply a size cap to agent memory', async () => {
    const big = 'z'.repeat(5000);
    const result = await memoryService.writeMemory(scope, { content: big, maxChars: 10 });
    assert.equal(result.chars, 5001);
  });

  it('reads for a prompt with the memoryFile cap and marker', async () => {
    const prompt = await memoryService.readMemoryForPrompt(scope, 20);
    assert.equal(prompt.truncated, true);
    assert.match(prompt.body, /\[memory truncated/);
    assert.equal(
      await memoryService.readMemoryForPrompt({ kind: 'agent', profileId: 'empty-one' }),
      null
    );
  });
});

describe('scope handlers', () => {
  it('refuses a scope nobody handles', async () => {
    await assert.rejects(() => memoryService.readMemory({ kind: 'nope' }), /No memory store/);
    await assert.rejects(
      () => memoryService.writeMemory(null, { content: 'x' }),
      /No memory store/
    );
  });

  it('refuses a handler without a kind or a resolve function', () => {
    assert.throws(() => memoryService.registerMemoryScopeHandler({}), /kind and a resolve/);
    assert.throws(
      () => memoryService.registerMemoryScopeHandler({ kind: 'x' }),
      /kind and a resolve/
    );
  });

  it('uses a registered handler for its own kind', async () => {
    const calls = [];
    memoryService.registerMemoryScopeHandler({
      kind: 'test-kind',
      resolve: user => (user?.testScope ? { kind: 'test-kind', key: user.testScope } : null),
      read: async scope => {
        calls.push(['read', scope.key]);
        return {
          body: 'hi',
          version: 1,
          updatedAt: null,
          updatedBy: null,
          summary: null,
          chars: 2
        };
      },
      write: async () => ({ version: 2, body: 'x', chars: 1 }),
      readForPrompt: async () => null
    });
    const scope = await memoryService.resolveMemoryScope({ testScope: 'k1' });
    assert.deepEqual(scope, { kind: 'test-kind', key: 'k1' });
    assert.equal((await memoryService.readMemory(scope)).body, 'hi');
    assert.deepEqual(calls, [['read', 'k1']]);
    // Agents still resolve first.
    assert.equal((await memoryService.resolveMemoryScope(AGENT)).kind, 'agent');
  });
});
