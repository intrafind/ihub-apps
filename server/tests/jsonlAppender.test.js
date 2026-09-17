import { jest } from '@jest/globals';

/**
 * Unit tests for the shared jsonlAppender utility (extracted from
 * feedbackStorage.js/UsageEventLog.js/AuditLogService.js) — covers
 * debounced append/flush, the periodic safety-net flush, per-path grouping
 * with partial-failure re-buffering, the overflow cap (drop-oldest +
 * warn-once), and withWriteLock serializing a flush against a concurrent
 * read-modify-rewrite.
 */

const files = new Map(); // path -> string contents
let appendImpls = []; // queue of one-shot overrides: null | () => never (throws)

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    mkdir: jest.fn(async () => {}),
    appendFile: jest.fn(async (filePath, data) => {
      const override = appendImpls.shift();
      if (override) override();
      files.set(filePath, (files.get(filePath) ?? '') + data);
    }),
    readFile: jest.fn(async filePath => {
      if (!files.has(filePath)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    }),
    writeFile: jest.fn(async (filePath, data) => {
      files.set(filePath, data);
    })
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

jest.useFakeTimers();

const { createJsonlAppender } = await import('../utils/jsonlAppender.js');

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  files.clear();
  appendImpls = [];
});

function linesOf(filePath) {
  return (files.get(filePath) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

describe('append / flush', () => {
  it('does not write until flushed and coalesces queued entries into one appendFile call', async () => {
    const appender = createJsonlAppender({ getFilePath: () => '/fake/a.jsonl' });
    appender.append({ v: 1 });
    appender.append({ v: 2 });
    expect(files.has('/fake/a.jsonl')).toBe(false);

    const count = await appender.flush();
    expect(count).toBe(2);
    expect(linesOf('/fake/a.jsonl')).toEqual([{ v: 1 }, { v: 2 }]);

    // Second flush with nothing queued is a no-op.
    expect(await appender.flush()).toBe(0);
    appender.stop();
  });

  it('debounces via scheduleFlush and the periodic safety net', async () => {
    const appender = createJsonlAppender({
      getFilePath: () => '/fake/a.jsonl',
      flushIntervalMs: 1000
    });
    appender.append({ v: 1 });
    expect(files.has('/fake/a.jsonl')).toBe(false);

    await jest.advanceTimersByTimeAsync(1000);
    expect(linesOf('/fake/a.jsonl')).toEqual([{ v: 1 }]);
    appender.stop();
  });
});

describe('per-path grouping', () => {
  it('groups entries by resolved file path in a single flush', async () => {
    const appender = createJsonlAppender({ getFilePath: entry => `/fake/${entry.date}.jsonl` });
    appender.append({ date: '2026-01-01', v: 1 });
    appender.append({ date: '2026-01-02', v: 2 });
    appender.append({ date: '2026-01-01', v: 3 });

    await appender.flush();
    expect(linesOf('/fake/2026-01-01.jsonl')).toEqual([
      { date: '2026-01-01', v: 1 },
      { date: '2026-01-01', v: 3 }
    ]);
    expect(linesOf('/fake/2026-01-02.jsonl')).toEqual([{ date: '2026-01-02', v: 2 }]);
    appender.stop();
  });

  it('re-buffers only the group whose write failed, not groups that already succeeded', async () => {
    const appender = createJsonlAppender({ getFilePath: entry => `/fake/${entry.date}.jsonl` });
    appender.append({ date: '2026-01-01', v: 'ok' });
    appender.append({ date: '2026-01-02', v: 'fails' });

    // Map iteration order is insertion order, so 2026-01-01 writes first and
    // succeeds; 2026-01-02 is the one that fails and must be re-buffered.
    appendImpls = [
      null,
      () => {
        throw new Error('disk full');
      }
    ];

    await expect(appender.flush()).rejects.toThrow('disk full');
    expect(linesOf('/fake/2026-01-01.jsonl')).toEqual([{ date: '2026-01-01', v: 'ok' }]);
    expect(files.has('/fake/2026-01-02.jsonl')).toBe(false);

    // Retry succeeds and doesn't duplicate the already-written 2026-01-01 entry.
    const count = await appender.flush();
    expect(count).toBe(1);
    expect(linesOf('/fake/2026-01-01.jsonl')).toEqual([{ date: '2026-01-01', v: 'ok' }]);
    expect(linesOf('/fake/2026-01-02.jsonl')).toEqual([{ date: '2026-01-02', v: 'fails' }]);
    appender.stop();
  });
});

describe('overflow cap', () => {
  it('drops the oldest entries once maxQueueSize is exceeded', async () => {
    const appender = createJsonlAppender({ getFilePath: () => '/fake/a.jsonl', maxQueueSize: 3 });
    appender.append({ v: 1 });
    appender.append({ v: 2 });
    appender.append({ v: 3 });
    appender.append({ v: 4 }); // should drop v:1

    await appender.flush();
    expect(linesOf('/fake/a.jsonl').map(e => e.v)).toEqual([2, 3, 4]);
    appender.stop();
  });
});

describe('withWriteLock', () => {
  it('serializes a flush against a concurrent read-modify-rewrite', async () => {
    const appender = createJsonlAppender({ getFilePath: () => '/fake/a.jsonl' });
    files.set('/fake/a.jsonl', JSON.stringify({ v: 'existing' }) + '\n');
    appender.append({ v: 'queued' });

    const cleanup = appender.withWriteLock(async () => {
      // Drain first (as real cleanup call sites do), then rewrite based on
      // the now-current file contents.
      await appender.drainToDisk();
      const current = linesOf('/fake/a.jsonl');
      files.set('/fake/a.jsonl', current.map(e => JSON.stringify(e)).join('\n') + '\n');
      return current.length;
    });

    // A concurrent flush() call must wait for the lock rather than
    // interleaving with the drain-then-rewrite above.
    const [cleanupCount] = await Promise.all([cleanup, appender.flush()]);

    expect(cleanupCount).toBe(2);
    expect(linesOf('/fake/a.jsonl')).toEqual([{ v: 'existing' }, { v: 'queued' }]);
    appender.stop();
  });
});
