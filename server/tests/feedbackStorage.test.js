import { jest } from '@jest/globals';

/**
 * Unit tests for feedbackStorage.js after its port onto the shared
 * jsonlAppender (server/utils/jsonlAppender.js) — focused on the queue/flush
 * mechanics (debounced append, re-buffer on failure) and the
 * flushQueue/cleanupFeedback write-lock race, since this module previously
 * had no test coverage at all.
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

jest.unstable_mockModule('../configLoader.js', () => ({
  loadJson: async () => ({ features: { feedbackTracking: true } })
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { storeFeedback, cleanupFeedback } = await import('../feedbackStorage.js');

function feedback(overrides = {}) {
  return {
    messageId: 'm1',
    appId: 'a1',
    chatId: 'c1',
    modelId: 'model1',
    rating: 5,
    ...overrides
  };
}

async function readAllLines() {
  if (!fileContents) return [];
  return fileContents
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

beforeEach(() => {
  fileContents = null;
  appendCallCount = 0;
  failNextAppend = false;
});

describe('storeFeedback', () => {
  it('does nothing when messageId is missing', async () => {
    storeFeedback(feedback({ messageId: undefined }));
    // Give the fire-and-forget config load a tick, then confirm nothing queued.
    await Promise.resolve();
    await cleanupFeedback(1); // any retention triggers a drain
    expect(fileContents).toBeNull();
  });
});

describe('cleanupFeedback', () => {
  it('drains queued entries before filtering, then removes only expired ones', async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    fileContents = JSON.stringify({ timestamp: old, messageId: 'old1' }) + '\n';

    storeFeedback(feedback({ messageId: 'new1' }));

    const result = await cleanupFeedback(90);
    expect(result).toEqual({ removed: 1, kept: 1 });

    const lines = await readAllLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].messageId).toBe('new1');
  });

  it('preserves malformed lines instead of dropping them', async () => {
    fileContents = 'not json\n';
    const result = await cleanupFeedback(1);
    expect(result).toEqual({ removed: 0, kept: 1 });
    expect(fileContents).toBe('not json\n');
  });

  it('is a no-op for a non-positive retention value', async () => {
    fileContents = JSON.stringify({ timestamp: new Date(0).toISOString() }) + '\n';
    const before = fileContents;
    expect(await cleanupFeedback(-1)).toEqual({ removed: 0, kept: 0 });
    expect(fileContents).toBe(before);
  });
});

describe('flush / cleanup race and failure handling', () => {
  it('re-buffers the queue instead of dropping entries when appendFile fails', async () => {
    storeFeedback(feedback({ messageId: 'm2' }));
    failNextAppend = true;

    await expect(cleanupFeedback(1)).resolves.toBeDefined(); // drain failure is swallowed internally
    // Entry must still be queued (not lost) and land on the next successful drain.
    await cleanupFeedback(1);

    const lines = await readAllLines();
    expect(lines.some(l => l.messageId === 'm2')).toBe(true);
    expect(appendCallCount).toBe(2);
  });
});
