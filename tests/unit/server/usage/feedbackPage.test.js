// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// feedbackStorage resolves its file at import time: a fixed per-process root.
jest.mock('../../../../server/utils/contentsPath.js', () => ({
  getContentsPath: (...segments) =>
    require('node:path').join(
      require('node:os').tmpdir(),
      `feedback-page-${process.pid}`,
      ...segments
    )
}));
const mockRoot = path.join(os.tmpdir(), `feedback-page-${process.pid}`);
jest.mock('../../../../server/configLoader.js', () => ({ loadJson: async () => ({}) }));
jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

import { readFeedbackPage } from '../../../../server/feedbackStorage.js';

beforeEach(() => {
  fs.mkdirSync(mockRoot, { recursive: true });
});
afterEach(() => fs.rmSync(mockRoot, { recursive: true, force: true }));

function writeFeedback(n) {
  fs.mkdirSync(path.join(mockRoot, 'data'), { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(JSON.stringify({ id: i, timestamp: `t${i}` }));
  lines.splice(2, 0, '{broken');
  fs.writeFileSync(path.join(mockRoot, 'data', 'feedback.jsonl'), lines.join('\n') + '\n');
}

describe('readFeedbackPage', () => {
  it('returns pages newest first without reading the rest', async () => {
    writeFeedback(10);
    const first = await readFeedbackPage({ limit: 3, offset: 0 });
    expect(first.total).toBe(11);
    expect(first.feedbackEntries.map(e => e.id)).toEqual([9, 8, 7]);
    const second = await readFeedbackPage({ limit: 3, offset: 3 });
    expect(second.feedbackEntries.map(e => e.id)).toEqual([6, 5, 4]);
  });

  it('skips malformed lines and handles a missing file', async () => {
    writeFeedback(4);
    const all = await readFeedbackPage({ limit: 100 });
    expect(all.feedbackEntries.map(e => e.id)).toEqual([3, 2, 1, 0]);
    fs.rmSync(path.join(mockRoot, 'data'), { recursive: true });
    await expect(readFeedbackPage()).resolves.toMatchObject({ feedbackEntries: [], total: 0 });
  });
});
