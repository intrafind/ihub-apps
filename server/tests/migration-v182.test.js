#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version
} from '../migrations/V182__remove_passthrough_content_prompt.js';

function fakeCtx(files) {
  return {
    files,
    listFiles: async () => Object.keys(files).map(p => p.replace('apps/', '')),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    log: () => {},
    warn: () => {}
  };
}

test('version', () => assert.equal(version, '182'));

test('drops pass-through templates and keeps real ones', async () => {
  const ctx = fakeCtx({
    'apps/a.json': { id: 'a', prompt: { en: '{{content}}' } },
    'apps/b.json': { id: 'b', prompt: { en: ' {{ content }}\n', de: 'Übersetze: {{content}}' } },
    'apps/c.json': { id: 'c', prompt: { en: 'Summarize:\n\n{{content}}' } },
    'apps/d.json': { id: 'd', prompt: '{{content}}' },
    'apps/e.json': { id: 'e' }
  });
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.equal('prompt' in ctx.files['apps/a.json'], false);
  assert.deepEqual(ctx.files['apps/b.json'].prompt, { de: 'Übersetze: {{content}}' });
  assert.deepEqual(ctx.files['apps/c.json'].prompt, { en: 'Summarize:\n\n{{content}}' });
  assert.equal('prompt' in ctx.files['apps/d.json'], false);
  assert.equal(ctx.files['apps/e.json'].id, 'e');
});
