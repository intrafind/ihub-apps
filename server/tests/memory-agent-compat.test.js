/**
 * Characterization tests for agent memory.
 *
 * Agent memory (`server/agents/memory/memoryFile.js` and the `read_memory` /
 * `write_memory` handlers in `server/tools/agentTools.js`) had no tests before
 * it became the scheduled-task memory's sibling in the shared memory service.
 * These tests pin the behavior that has to stay exactly as it is: the file
 * format, the version rules, the conflict error, the prompt include and the
 * tool result shapes.
 *
 * `memoryFile.js` writes under the contents directory, so the directory is
 * pointed at a temp dir before anything is imported.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-memory-compat-')));
const CONTENTS = path.join(ROOT, 'contents');
fsSync.mkdirSync(CONTENTS, { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { default: memoryFile } = await import('../agents/memory/memoryFile.js');
const { readMemory, writeMemory } = await import('../tools/agentTools.js');
const { actionTracker } = await import('../actionTracker.js');

const MEMORY_DIR = path.join(CONTENTS, 'agents', 'memory');
const AGENT = { id: 'agent:researcher', isAgent: true, profileId: 'researcher' };

async function readRaw(profileId) {
  return fs.readFile(path.join(MEMORY_DIR, `${profileId}.md`), 'utf8');
}

after(() => fs.rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('memoryFile', () => {
  before(() => fs.mkdir(MEMORY_DIR, { recursive: true }));
  beforeEach(async () => {
    await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    await fs.mkdir(MEMORY_DIR, { recursive: true });
  });

  describe('readMemory', () => {
    it('returns version 0 and an empty body when there is no file', async () => {
      const mem = await memoryFile.readMemory('researcher');
      assert.equal(mem.profileId, 'researcher');
      assert.equal(mem.version, 0);
      assert.equal(mem.body, '');
      assert.equal(mem.raw, '');
      assert.equal(mem.updatedAt, null);
      assert.equal(mem.updatedBy, null);
      assert.deepEqual(mem.frontmatter, { profileId: 'researcher', version: 0 });
    });

    it('reads a file without frontmatter as a body of version 0', async () => {
      await fs.writeFile(path.join(MEMORY_DIR, 'researcher.md'), 'plain notes\n', 'utf8');
      const mem = await memoryFile.readMemory('researcher');
      assert.equal(mem.body, 'plain notes\n');
      assert.equal(mem.version, 0);
    });

    it('rejects ids that are not valid profile ids', async () => {
      for (const id of ['Researcher', '../escape', 'a/b', '', 'x', '-lead', 'trail-', null, 42]) {
        await assert.rejects(() => memoryFile.readMemory(id), /Invalid/, `id ${String(id)}`);
      }
    });
  });

  describe('writeMemory', () => {
    it('defaults to replace, adds frontmatter and a trailing newline, and starts at version 1', async () => {
      const result = await memoryFile.writeMemory('researcher', { content: 'first note' });
      assert.deepEqual(result, { version: 1, body: 'first note\n' });

      const raw = await readRaw('researcher');
      assert.match(raw, /^---\nprofileId: researcher\n/);
      assert.match(raw, /\nupdatedAt: \d{4}-\d{2}-\d{2}T[^\n]+\n/);
      assert.match(raw, /\nupdatedBy: system\n/);
      assert.match(raw, /\nversion: 1\n---\nfirst note\n$/);
    });

    it('keeps an existing trailing newline when replacing', async () => {
      const result = await memoryFile.writeMemory('researcher', { content: 'note\n' });
      assert.equal(result.body, 'note\n');
    });

    it('records updatedBy and the optional summary in the frontmatter', async () => {
      await memoryFile.writeMemory('researcher', {
        content: 'note',
        updatedBy: 'agent:researcher',
        summary: 'first pass'
      });
      const mem = await memoryFile.readMemory('researcher');
      assert.equal(mem.updatedBy, 'agent:researcher');
      assert.equal(mem.frontmatter.summary, 'first pass');
      assert.equal(mem.body, 'note\n');
    });

    it('appends to an existing body with exactly one newline between entries', async () => {
      await memoryFile.writeMemory('researcher', { content: 'a\n\n\n' });
      const result = await memoryFile.writeMemory('researcher', { mode: 'append', content: 'b' });
      assert.equal(result.body, 'a\nb\n');
    });

    it('appends to an empty memory without a leading blank line', async () => {
      const result = await memoryFile.writeMemory('researcher', { mode: 'append', content: 'b' });
      assert.equal(result.body, 'b\n');
    });

    it('increments the version on every write', async () => {
      assert.equal((await memoryFile.writeMemory('researcher', { content: 'one' })).version, 1);
      assert.equal((await memoryFile.writeMemory('researcher', { content: 'two' })).version, 2);
      assert.equal(
        (await memoryFile.writeMemory('researcher', { mode: 'append', content: 'three' })).version,
        3
      );
      assert.equal((await memoryFile.readMemory('researcher')).version, 3);
    });

    it('accepts a matching expectedVersion and is last-write-wins without one', async () => {
      await memoryFile.writeMemory('researcher', { content: 'one' });
      const matched = await memoryFile.writeMemory('researcher', {
        content: 'two',
        expectedVersion: 1
      });
      assert.equal(matched.version, 2);
      const unconditional = await memoryFile.writeMemory('researcher', { content: 'three' });
      assert.equal(unconditional.version, 3);
    });

    it('throws VERSION_CONFLICT with currentVersion on a stale expectedVersion', async () => {
      await memoryFile.writeMemory('researcher', { content: 'one' });
      await assert.rejects(
        () => memoryFile.writeMemory('researcher', { content: 'two', expectedVersion: 0 }),
        err => {
          assert.equal(err.code, 'VERSION_CONFLICT');
          assert.equal(err.currentVersion, 1);
          assert.match(err.message, /expected 0, found 1/);
          return true;
        }
      );
      assert.equal((await memoryFile.readMemory('researcher')).body, 'one\n');
    });

    it('rejects unsupported modes and invalid profile ids without writing', async () => {
      await assert.rejects(
        () => memoryFile.writeMemory('researcher', { mode: 'prepend', content: 'x' }),
        /Unsupported writeMemory mode/
      );
      await assert.rejects(
        () => memoryFile.writeMemory('../escape', { content: 'x' }),
        /Invalid profile id/
      );
      assert.deepEqual(await fs.readdir(MEMORY_DIR), []);
    });
  });

  describe('readMemoryBodyForPrompt', () => {
    it('returns null for an empty or whitespace-only memory', async () => {
      assert.equal(await memoryFile.readMemoryBodyForPrompt('researcher'), null);
      await memoryFile.writeMemory('researcher', { content: '   \n' });
      assert.equal(await memoryFile.readMemoryBodyForPrompt('researcher'), null);
    });

    it('returns the whole body with version and updatedAt when it fits', async () => {
      await memoryFile.writeMemory('researcher', { content: 'short note' });
      const result = await memoryFile.readMemoryBodyForPrompt('researcher', 100);
      assert.equal(result.body, 'short note\n');
      assert.equal(result.truncated, false);
      assert.equal(result.version, 1);
      assert.ok(result.updatedAt);
    });

    it('truncates to maxBytes characters and appends the marker', async () => {
      await memoryFile.writeMemory('researcher', { content: 'x'.repeat(50) });
      const result = await memoryFile.readMemoryBodyForPrompt('researcher', 10);
      assert.equal(result.truncated, true);
      assert.equal(
        result.body,
        `${'x'.repeat(10)}\n\n[memory truncated — use readMemory tool to fetch full body]`
      );
    });

    it('defaults to 8192 characters', async () => {
      await memoryFile.writeMemory('researcher', { content: 'y'.repeat(9000) });
      const result = await memoryFile.readMemoryBodyForPrompt('researcher');
      assert.equal(result.truncated, true);
      assert.ok(result.body.startsWith('y'.repeat(8192) + '\n\n[memory truncated'));
    });
  });
});

describe('agent memory tools', () => {
  beforeEach(async () => {
    await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    await fs.mkdir(MEMORY_DIR, { recursive: true });
  });

  function captureEvents() {
    const events = [];
    const listener = event => events.push(event);
    actionTracker.on('fire-sse', listener);
    return { events, stop: () => actionTracker.off('fire-sse', listener) };
  }

  it('read_memory returns the profile, version, author and body, and emits agent.memory.read', async () => {
    await memoryFile.writeMemory('researcher', { content: 'known fact', updatedBy: 'system' });
    const capture = captureEvents();
    try {
      const result = await readMemory({ user: AGENT, chatId: 'chat-1' });
      assert.equal(result.profileId, 'researcher');
      assert.equal(result.version, 1);
      assert.equal(result.updatedBy, 'system');
      assert.equal(result.body, 'known fact\n');
      assert.ok(result.updatedAt);
      assert.deepEqual(Object.keys(result).sort(), [
        'body',
        'profileId',
        'updatedAt',
        'updatedBy',
        'version'
      ]);
      const event = capture.events.find(e => e.event === 'agent.memory.read');
      assert.ok(event, 'agent.memory.read was emitted');
      assert.equal(event.chatId, 'chat-1');
      assert.equal(event.profileId, 'researcher');
      assert.equal(event.version, 1);
    } finally {
      capture.stop();
    }
  });

  it('read_memory on a profile without memory returns version 0 and an empty body', async () => {
    const result = await readMemory({ user: AGENT });
    assert.equal(result.version, 0);
    assert.equal(result.body, '');
  });

  it('write_memory appends by default, records the principal as author, and emits agent.memory.write', async () => {
    const capture = captureEvents();
    try {
      const first = await writeMemory({ user: AGENT, chatId: 'chat-2', content: 'one' });
      assert.deepEqual(first, { ok: true, version: 1 });
      const second = await writeMemory({
        user: AGENT,
        chatId: 'chat-2',
        content: 'two',
        summary: 'added two'
      });
      assert.deepEqual(second, { ok: true, version: 2 });

      const mem = await memoryFile.readMemory('researcher');
      assert.equal(mem.body, 'one\ntwo\n');
      assert.equal(mem.updatedBy, 'agent:researcher');
      assert.equal(mem.frontmatter.summary, 'added two');

      const writes = capture.events.filter(e => e.event === 'agent.memory.write');
      assert.equal(writes.length, 2);
      assert.equal(writes[1].version, 2);
      assert.equal(writes[1].mode, 'append');
      assert.equal(writes[1].summary, 'added two');
      assert.equal(writes[1].chatId, 'chat-2');
    } finally {
      capture.stop();
    }
  });

  it('write_memory with mode replace replaces the body', async () => {
    await writeMemory({ user: AGENT, content: 'old' });
    await writeMemory({ user: AGENT, mode: 'replace', content: 'new' });
    assert.equal((await memoryFile.readMemory('researcher')).body, 'new\n');
  });

  it('write_memory returns (does not throw) VERSION_CONFLICT with currentVersion', async () => {
    await writeMemory({ user: AGENT, content: 'one' });
    const result = await writeMemory({ user: AGENT, content: 'two', expectedVersion: 0 });
    assert.equal(result.error, true);
    assert.equal(result.code, 'VERSION_CONFLICT');
    assert.equal(result.currentVersion, 1);
    assert.match(result.message, /expected 0, found 1/);
    assert.equal((await memoryFile.readMemory('researcher')).body, 'one\n');
  });

  it('write_memory requires non-empty string content', async () => {
    for (const content of [undefined, '', 42]) {
      await assert.rejects(() => writeMemory({ user: AGENT, content }), /content is required/);
    }
  });

  it('refuses a principal that is not an agent', async () => {
    const ordinaryUser = { id: 'user-ada', name: 'Ada' };
    await assert.rejects(() => readMemory({ user: ordinaryUser }));
    await assert.rejects(() => writeMemory({ user: ordinaryUser, content: 'x' }));
    await assert.rejects(() => readMemory({ user: { ...AGENT, profileId: undefined } }));
    await assert.rejects(() => readMemory({}));
  });
});
