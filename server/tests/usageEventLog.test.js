import { jest } from '@jest/globals';

/**
 * Unit tests for UsageEventLog.js — focused on the write-lock added to
 * serialize flushQueue (append) against cleanupEvents (read-filter-rewrite)
 * so a queued-but-unflushed event can never be silently dropped by a
 * concurrent cleanup pass.
 */

let fileContents = null;
let appendCallCount = 0;
let failNextAppend = false;

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    readFile: jest.fn(async () => {
      if (fileContents === null) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return fileContents;
    }),
    writeFile: jest.fn(async (_file, data) => {
      fileContents = data;
    }),
    appendFile: jest.fn(async (_file, data) => {
      appendCallCount += 1;
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error('disk full');
      }
      fileContents = (fileContents ?? '') + data;
    }),
    mkdir: jest.fn(async () => {})
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

// The module registers a real periodic setInterval on import; fake timers
// keep that handle from holding the process (and the Jest worker) open once
// the test file finishes, since tests below drive flushing/cleanup directly.
jest.useFakeTimers();

const { logUsageEvent, flushQueue, cleanupEvents, readEvents } =
  await import('../services/UsageEventLog.js');

afterAll(() => {
  jest.useRealTimers();
});

function entry(overrides = {}) {
  return {
    type: 'chat',
    userId: 'u1',
    appId: 'a1',
    modelId: 'm1',
    promptTokens: 1,
    completionTokens: 1,
    ...overrides
  };
}

beforeEach(() => {
  fileContents = null;
  appendCallCount = 0;
  failNextAppend = false;
});

describe('cleanupEvents', () => {
  it('retains events within retention and drops events older than the cutoff', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    fileContents =
      [JSON.stringify({ ts: now, type: 'chat' }), JSON.stringify({ ts: old, type: 'chat' })].join(
        '\n'
      ) + '\n';

    await cleanupEvents(90);

    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].ts).toBe(now);
  });

  it('does not touch the file when nothing is expired', async () => {
    const now = new Date().toISOString();
    fileContents = JSON.stringify({ ts: now, type: 'chat' }) + '\n';
    const before = fileContents;

    await cleanupEvents(90);

    expect(fileContents).toBe(before);
  });
});

describe('flushQueue / cleanupEvents race', () => {
  it('a queued event survives a concurrent cleanup instead of being overwritten', async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    fileContents = JSON.stringify({ ts: old, type: 'chat' }) + '\n';

    logUsageEvent(entry());

    // Fire both without awaiting the first — the in-process write lock must
    // serialize them so the queued event is drained to disk before (or after,
    // but never lost during) the cleanup rewrite.
    await Promise.all([flushQueue(), cleanupEvents(90)]);

    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('chat');
    expect(events[0].uid).toBe('u1');
  });
});

describe('flushQueue append failure', () => {
  it('re-buffers the queue instead of dropping events when appendFile fails', async () => {
    logUsageEvent(entry({ userId: 'u2' }));
    failNextAppend = true;

    await expect(flushQueue()).rejects.toThrow('disk full');
    expect(fileContents).toBeNull();

    await flushQueue();

    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe('u2');
    expect(appendCallCount).toBe(2);
  });
});
