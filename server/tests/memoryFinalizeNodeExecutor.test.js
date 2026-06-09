#!/usr/bin/env node

/**
 * Unit tests for MemoryFinalizeNodeExecutor.
 *
 * The deterministic memory-finalize node drains state.data._pendingMemoryUpdates
 * by calling memoryFile.writeMemory() directly — no LLM involvement, so the
 * grounding swap can never strip it. Verifies:
 *
 *   - Empty / missing queue → noop success.
 *   - Each pending entry triggers one writeMemory() call with the expected
 *     args. State updates clear _pendingMemoryUpdates afterwards.
 *   - VERSION_CONFLICT is retried once; if the retry succeeds, the entry
 *     counts as written; if the retry also fails, the entry is skipped
 *     (logged) and we continue.
 *   - No-profile case returns a clear noop.
 *
 * Run directly: `node server/tests/memoryFinalizeNodeExecutor.test.js`.
 */

import { MemoryFinalizeNodeExecutor } from '../services/workflow/executors/MemoryFinalizeNodeExecutor.js';
import memoryFile from '../agents/memory/memoryFile.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

function makeExecutor() {
  // Inject a silent logger so the test output stays clean.
  return new MemoryFinalizeNodeExecutor({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  });
}

function makeState(overrides = {}) {
  return {
    executionId: 'test-run',
    data: {
      ...overrides
    }
  };
}

function makeContext(profileId = 'test-agent') {
  return {
    chatId: 'test-chat',
    user: profileId ? { id: 'agent-svc', profileId, isAgent: true } : { id: 'anon' }
  };
}

async function run() {
  // ── Test 1: empty queue → noop success ────────────────────────────────
  {
    const calls = [];
    const orig = memoryFile.writeMemory;
    memoryFile.writeMemory = async (...args) => {
      calls.push(args);
      return { version: 1 };
    };
    try {
      const executor = makeExecutor();
      const result = await executor.execute(
        { id: 'memory-finalize', type: 'memory-finalize', config: {} },
        makeState(),
        makeContext()
      );
      check('empty queue → completed', result.status === 'completed');
      check('empty queue → noop flag', result.output?.noop === true);
      check('empty queue → no writeMemory call', calls.length === 0);
    } finally {
      memoryFile.writeMemory = orig;
    }
  }

  // ── Test 2: writes each pending entry, drains queue ───────────────────
  {
    const calls = [];
    const orig = memoryFile.writeMemory;
    memoryFile.writeMemory = async (profileId, payload) => {
      calls.push({ profileId, payload });
      return { version: 2 };
    };
    try {
      const executor = makeExecutor();
      const state = makeState({
        _pendingMemoryUpdates: [
          { mode: 'append', content: 'Learned X', summary: 'X summary' },
          { mode: 'append', content: 'Learned Y' }
        ]
      });
      const result = await executor.execute(
        { id: 'memory-finalize', type: 'memory-finalize', config: {} },
        state,
        makeContext('test-agent')
      );
      check('two writes → completed', result.status === 'completed');
      check('two writes → written count', result.output?.written === 2);
      check('two writes → calls count', calls.length === 2);
      check(
        'first call has expected args',
        calls[0]?.profileId === 'test-agent' &&
          calls[0]?.payload?.mode === 'append' &&
          calls[0]?.payload?.content === 'Learned X' &&
          calls[0]?.payload?.summary === 'X summary'
      );
      check(
        'second call has no summary',
        calls[1]?.payload?.content === 'Learned Y' && calls[1]?.payload?.summary === undefined
      );
      check(
        'state drained',
        Array.isArray(result.stateUpdates?._pendingMemoryUpdates) &&
          result.stateUpdates._pendingMemoryUpdates.length === 0
      );
      check(
        'step log recorded',
        !!result.stateUpdates?._stepLogs?.['memory-finalize'] &&
          result.stateUpdates._stepLogs['memory-finalize'].written === 2
      );
    } finally {
      memoryFile.writeMemory = orig;
    }
  }

  // ── Test 3: VERSION_CONFLICT retried once successfully ────────────────
  {
    let attempt = 0;
    const orig = memoryFile.writeMemory;
    memoryFile.writeMemory = async () => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error('Memory version mismatch: expected 1, found 2');
        err.code = 'VERSION_CONFLICT';
        err.currentVersion = 2;
        throw err;
      }
      return { version: 3 };
    };
    try {
      const executor = makeExecutor();
      const state = makeState({
        _pendingMemoryUpdates: [{ mode: 'append', content: 'retry me' }]
      });
      const result = await executor.execute(
        { id: 'memory-finalize', type: 'memory-finalize', config: {} },
        state,
        makeContext('test-agent')
      );
      check('conflict → completed', result.status === 'completed');
      check('conflict → 2 attempts', attempt === 2);
      check('conflict → written count 1', result.output?.written === 1);
    } finally {
      memoryFile.writeMemory = orig;
    }
  }

  // ── Test 4: VERSION_CONFLICT also fails on retry → entry skipped ──────
  {
    const orig = memoryFile.writeMemory;
    memoryFile.writeMemory = async () => {
      const err = new Error('Memory version mismatch: expected 1, found 2');
      err.code = 'VERSION_CONFLICT';
      err.currentVersion = 2;
      throw err;
    };
    try {
      const executor = makeExecutor();
      const state = makeState({
        _pendingMemoryUpdates: [{ mode: 'append', content: 'fails twice' }]
      });
      const result = await executor.execute(
        { id: 'memory-finalize', type: 'memory-finalize', config: {} },
        state,
        makeContext('test-agent')
      );
      check('persistent conflict → completed (best effort)', result.status === 'completed');
      check('persistent conflict → written count 0', result.output?.written === 0);
    } finally {
      memoryFile.writeMemory = orig;
    }
  }

  // ── Test 5: missing profileId → noop ──────────────────────────────────
  {
    const calls = [];
    const orig = memoryFile.writeMemory;
    memoryFile.writeMemory = async (...args) => {
      calls.push(args);
      return { version: 1 };
    };
    try {
      const executor = makeExecutor();
      const state = makeState({
        _pendingMemoryUpdates: [{ mode: 'append', content: 'orphan' }]
      });
      const result = await executor.execute(
        { id: 'memory-finalize', type: 'memory-finalize', config: {} },
        state,
        // no profileId on user, no _agentProfile in state
        { chatId: 'c', user: { id: 'anon' } }
      );
      check(
        'no profile → completed noop',
        result.status === 'completed' && result.output?.noop === true
      );
      check('no profile → no writeMemory call', calls.length === 0);
    } finally {
      memoryFile.writeMemory = orig;
    }
  }

  // ── Test 6: invalid entries are filtered out ──────────────────────────
  {
    const calls = [];
    const orig = memoryFile.writeMemory;
    memoryFile.writeMemory = async (profileId, payload) => {
      calls.push({ profileId, payload });
      return { version: 4 };
    };
    try {
      const executor = makeExecutor();
      const state = makeState({
        _pendingMemoryUpdates: [
          { mode: 'append', content: '' }, // empty content → filtered
          { mode: 'bogus', content: 'no-mode' }, // bad mode → filtered
          { mode: 'append', content: 'good' } // valid
        ]
      });
      const result = await executor.execute(
        { id: 'memory-finalize', type: 'memory-finalize', config: {} },
        state,
        makeContext('test-agent')
      );
      check('filter invalid → written 1', result.output?.written === 1);
      check('filter invalid → calls 1', calls.length === 1);
      check('filter invalid → only good one persisted', calls[0]?.payload?.content === 'good');
    } finally {
      memoryFile.writeMemory = orig;
    }
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
