#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V185__ifinder_apps_require_integration.js';

function fakeCtx(files) {
  return {
    files,
    listFiles: async () => Object.keys(files).map(p => p.replace('apps/', '')),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    deleteFile: async p => {
      delete files[p];
    },
    log: () => {},
    warn: () => {}
  };
}

test('version', () => assert.equal(version, '185'));

test('removes the old app and gates the iFinder apps, keeping their enabled flag', async () => {
  const ctx = fakeCtx({
    'apps/ifinder-document-actions.json': { id: 'ifinder-document-actions' },
    'apps/iassistant.json': { id: 'iassistant', enabled: false },
    'apps/ifinder-search.json': { id: 'ifinder-search', enabled: true },
    'apps/chat.json': { id: 'chat' },
    'apps/parliamentary-questions.json': {
      id: 'parliamentary-questions',
      rendererConfig: { iAssistantAppId: 'ifinder-document-actions' }
    }
  });
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.equal('apps/ifinder-document-actions.json' in ctx.files, false);
  assert.deepEqual(ctx.files['apps/iassistant.json'].requiredIntegrations, ['ifinder']);
  assert.equal(ctx.files['apps/iassistant.json'].enabled, false);
  assert.deepEqual(ctx.files['apps/ifinder-search.json'].requiredIntegrations, ['ifinder']);
  assert.equal('requiredIntegrations' in ctx.files['apps/chat.json'], false);
  assert.equal(
    ctx.files['apps/parliamentary-questions.json'].rendererConfig.iAssistantAppId,
    'ifinder-search'
  );
});

test('is idempotent', async () => {
  const ctx = fakeCtx({
    'apps/iassistant.json': { id: 'iassistant', requiredIntegrations: ['ifinder'] }
  });
  await up(ctx);
  await up(ctx);
  assert.deepEqual(ctx.files['apps/iassistant.json'].requiredIntegrations, ['ifinder']);
});
