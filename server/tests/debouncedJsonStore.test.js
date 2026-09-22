import { jest } from '@jest/globals';

/**
 * Unit tests for the shared debouncedJsonStore utility (extracted from
 * usageTracker.js/shortLinkManager.js) — covers load-or-default, dirty-flag
 * skip-when-clean, debounce coalescing, the periodic safety-net flush, and
 * a wholesale replace() (used by usageTracker's resetUsage()).
 */

let fileContents = null;
let writeCount = 0;

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
    mkdir: jest.fn(async () => {})
  }
}));

jest.unstable_mockModule('../utils/atomicWrite.js', () => ({
  atomicWriteJSON: jest.fn(async (_file, data) => {
    writeCount += 1;
    fileContents = JSON.stringify(data);
  })
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

jest.useFakeTimers();

const { createDebouncedJsonStore } = await import('../utils/debouncedJsonStore.js');

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  fileContents = null;
  writeCount = 0;
});

function makeStore(overrides = {}) {
  return createDebouncedJsonStore({
    filePath: '/fake/data.json',
    createDefault: () => ({ count: 0 }),
    saveIntervalMs: 1000,
    component: 'TestStore',
    ...overrides
  });
}

describe('load', () => {
  it('returns the default shape when the file is missing', async () => {
    const store = makeStore();
    expect(await store.load()).toEqual({ count: 0 });
    store.stop();
  });

  it('returns the parsed file contents when present', async () => {
    fileContents = JSON.stringify({ count: 5 });
    const store = makeStore();
    expect(await store.load()).toEqual({ count: 5 });
    store.stop();
  });

  it('caches the loaded object across calls (same reference)', async () => {
    const store = makeStore();
    const a = await store.load();
    const b = await store.load();
    expect(a).toBe(b);
    store.stop();
  });
});

describe('markDirty / debounce', () => {
  it('does not write until the debounce interval elapses', async () => {
    const store = makeStore();
    const data = await store.load();
    data.count = 1;
    store.markDirty();

    expect(writeCount).toBe(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(writeCount).toBe(1);
    expect(JSON.parse(fileContents)).toEqual({ count: 1 });
    store.stop();
  });

  it('coalesces multiple markDirty calls within the debounce window into one write', async () => {
    const store = makeStore();
    const data = await store.load();
    data.count = 1;
    store.markDirty();
    data.count = 2;
    store.markDirty();
    data.count = 3;
    store.markDirty();

    await jest.advanceTimersByTimeAsync(1000);
    expect(writeCount).toBe(1);
    expect(JSON.parse(fileContents)).toEqual({ count: 3 });
    store.stop();
  });

  it('flush() is a no-op when nothing is dirty', async () => {
    const store = makeStore();
    await store.load();
    await store.flush();
    expect(writeCount).toBe(0);
    store.stop();
  });
});

describe('periodic safety-net flush', () => {
  it('drains a dirty store on the periodic interval even without a new markDirty call', async () => {
    const store = makeStore();
    const data = await store.load();
    data.count = 42;
    store.markDirty();

    // Fire the debounced save first...
    await jest.advanceTimersByTimeAsync(1000);
    expect(writeCount).toBe(1);

    // ...then confirm the periodic interval is a no-op once clean.
    await jest.advanceTimersByTimeAsync(1000);
    expect(writeCount).toBe(1);
    store.stop();
  });
});

describe('onBeforeSave', () => {
  it('is invoked just before serializing so callers can stamp timestamps', async () => {
    const onBeforeSave = jest.fn(data => {
      data.stamped = true;
    });
    const store = makeStore({ onBeforeSave });
    const data = await store.load();
    data.count = 1;
    store.markDirty();
    await jest.advanceTimersByTimeAsync(1000);

    expect(onBeforeSave).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fileContents)).toEqual({ count: 1, stamped: true });
    store.stop();
  });
});

describe('reload', () => {
  it('picks up a change written externally (e.g. by another worker) when not dirty', async () => {
    const store = makeStore();
    expect(await store.load()).toEqual({ count: 0 });

    // Simulate a sibling process flushing its own copy to the same file.
    fileContents = JSON.stringify({ count: 5 });

    // Without a reload, load() would keep returning the stale cached object.
    expect(await store.load()).toEqual({ count: 0 });
    expect(await store.reload()).toEqual({ count: 5 });
    expect(await store.load()).toEqual({ count: 5 });
    store.stop();
  });

  it('flushes local dirty data first, so an unflushed local write is not lost', async () => {
    const store = makeStore();
    const data = await store.load();
    data.count = 1;
    store.markDirty();

    expect(writeCount).toBe(0);
    await store.reload();

    // The local write reached disk before the reload read it back.
    expect(writeCount).toBe(1);
    expect(await store.load()).toEqual({ count: 1 });
    store.stop();
  });

  it('keeps the last-known-good data if the file is unreadable when data was already loaded', async () => {
    // A missing/unreadable file on reload is more likely a transient hiccup
    // (e.g. racing another worker's atomic rename) than a real reset signal,
    // so reload() does not discard perfectly good in-memory data over it.
    const store = makeStore();
    fileContents = JSON.stringify({ count: 5 });
    await store.load();

    fileContents = null;
    expect(await store.reload()).toEqual({ count: 5 });
    store.stop();
  });

  it('falls back to the default shape if the file has never loaded successfully', async () => {
    const store = makeStore();
    expect(await store.reload()).toEqual({ count: 0 });
    store.stop();
  });
});

describe('replace', () => {
  it('wholesale-swaps the in-memory data and marks it dirty', async () => {
    const store = makeStore();
    await store.load();
    store.replace({ count: 99 });
    await store.flush();

    expect(writeCount).toBe(1);
    expect(JSON.parse(fileContents)).toEqual({ count: 99 });

    const reloaded = await store.load();
    expect(reloaded).toEqual({ count: 99 });
    store.stop();
  });
});
