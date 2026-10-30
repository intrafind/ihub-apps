#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V191 specs — the inline scope picker placement becomes the "+"
 * menu, other placements stay as they are.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V191__integration_scope_picker_in_menu.js';

function makeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    logs,
    files,
    writes,
    listFiles: async dir =>
      Object.keys(files)
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith('.json'))
        .map(rel => rel.slice(dir.length + 1)),
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes.push(rel);
      files[rel] = data;
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

describe('V191 integration scope picker in the "+" menu', () => {
  it('has a version and description', () => {
    assert.equal(version, '191');
    assert.ok(description);
  });

  it('only runs when there are apps', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'apps/a.json': { id: 'a' } })), true);
  });

  it('moves the inline picker of the iFinder Search app to the menu', async () => {
    const ctx = makeCtx({
      'apps/ifinder-search.json': {
        id: 'ifinder-search',
        integrations: { ifinder: { scopePicker: 'inline', defaultScope: 'contracts' } }
      }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['apps/ifinder-search.json'].integrations, {
      ifinder: { scopePicker: 'menu', defaultScope: 'contracts' }
    });
  });

  it('moves every inline integration of any app', async () => {
    const ctx = makeCtx({
      'apps/custom.json': {
        id: 'custom',
        integrations: {
          ifinder: { scopePicker: 'inline' },
          iassistant: { scopePicker: 'inline', allowAllSearchProfiles: true }
        }
      }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['apps/custom.json'].integrations, {
      ifinder: { scopePicker: 'menu' },
      iassistant: { scopePicker: 'menu', allowAllSearchProfiles: true }
    });
  });

  it('leaves menu, hidden and apps without integrations untouched', async () => {
    const ctx = makeCtx({
      'apps/menu.json': { id: 'menu', integrations: { ifinder: { scopePicker: 'menu' } } },
      'apps/hidden.json': { id: 'hidden', integrations: { iassistant: { scopePicker: 'hidden' } } },
      'apps/plain.json': { id: 'plain' }
    });
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
  });
});
