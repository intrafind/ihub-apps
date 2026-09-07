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
