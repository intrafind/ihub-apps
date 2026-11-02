// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V201: the shipped iFinder app gets back the iFinder actions V192 emptied. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  up,
  precondition,
  version,
  restoreIFinderBinding,
  shipsAllIFinderActions
} from '../migrations/V201__restore_ifinder_actions_on_shipped_apps.js';
import { migrateApp as v192MigrateApp } from '../migrations/V192__ifinder_iassistant_installed_integrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shippedIFinderSearch = JSON.parse(
  readFileSync(path.join(here, '../defaults/apps/ifinder-search.json'), 'utf8')
);

function makeCtx(files, defaults = {}) {
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes.push(rel);
      files[rel] = data;
    },
    readDefaultJson: async rel => {
      if (!(rel in defaults)) throw new Error(`ENOENT ${rel}`);
      return structuredClone(defaults[rel]);
    },
    listFiles: async (dir, pattern) =>
      Object.keys(files)
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith(pattern.replaceAll('*', '')))
        .map(rel => rel.slice(dir.length + 1)),
    log: m => logs.push(m)
  };
}

describe('V201 restore the iFinder actions of shipped apps', () => {
  it('declares its version', () => assert.equal(version, '201'));

  it('the shipped iFinder app binds every action (no actions list)', () => {
    assert.equal(shipsAllIFinderActions(shippedIFinderSearch), true);
  });

  it('repairs a fresh install: V192 empties the shipped binding, V201 restores it', async () => {
    // What a fresh install does: copy the shipped app, then run the migrations.
    const app = v192MigrateApp(structuredClone(shippedIFinderSearch))?.app;
    assert.deepEqual(app?.integrations?.ifinder?.actions, [], 'V192 empties the binding (the bug)');

    const ctx = makeCtx(
      { 'apps/ifinder-search.json': app },
      { 'apps/ifinder-search.json': shippedIFinderSearch }
    );
    await up(ctx);
    const repaired = ctx.files['apps/ifinder-search.json'];
    assert.equal(Object.hasOwn(repaired.integrations.ifinder, 'actions'), false);
    assert.deepEqual(repaired.integrations.ifinder, shippedIFinderSearch.integrations.ifinder);
    assert.deepEqual(ctx.writes, ['apps/ifinder-search.json']);
  });

  it('keeps every other setting of the binding and the app', () => {
    const app = {
      id: 'ifinder-search',
      tools: ['ask_user'],
      integrations: {
        ifinder: { scopePicker: 'hidden', defaultScope: 'contracts', actions: [] },
        other: { actions: [] }
      }
    };
    assert.deepEqual(restoreIFinderBinding(app, shippedIFinderSearch), {
      id: 'ifinder-search',
      tools: ['ask_user'],
      integrations: {
        ifinder: { scopePicker: 'hidden', defaultScope: 'contracts' },
        other: { actions: [] }
      }
    });
  });

  it('leaves apps iHub does not ship, and named or non-empty action lists, alone', async () => {
    const files = {
      // custom app: an empty list may be the admin's choice (scope settings only)
      'apps/my-search.json': { id: 'my-search', integrations: { ifinder: { actions: [] } } },
      // shipped app the admin narrowed to two actions
      'apps/ifinder-search.json': {
        id: 'ifinder-search',
        integrations: { ifinder: { actions: ['search', 'getContent'] } }
      },
      // shipped app whose default names its actions
      'apps/narrow.json': { id: 'narrow', integrations: { ifinder: { actions: [] } } },
      // no iFinder binding at all
      'apps/chat.json': { id: 'chat' }
    };
    const ctx = makeCtx(structuredClone(files), {
      'apps/ifinder-search.json': shippedIFinderSearch,
      'apps/narrow.json': { id: 'narrow', integrations: { ifinder: { actions: ['search'] } } },
      'apps/chat.json': { id: 'chat' }
    });
    await up(ctx);
    assert.deepEqual(ctx.files, files);
    assert.deepEqual(ctx.writes, []);
    assert.deepEqual(ctx.logs, ['No shipped app with an emptied iFinder binding']);
  });

  it('is idempotent', async () => {
    const ctx = makeCtx(
      {
        'apps/ifinder-search.json': {
          ...shippedIFinderSearch,
          integrations: { ifinder: { scopePicker: 'menu', actions: [] } }
        }
      },
      { 'apps/ifinder-search.json': shippedIFinderSearch }
    );
    await up(ctx);
    const once = structuredClone(ctx.files);
    await up(ctx);
    assert.deepEqual(ctx.files, once);
    assert.equal(ctx.writes.length, 1);
  });

  it('runs whenever there are apps', async () => {
    assert.equal(await precondition(makeCtx({ 'apps/a.json': {} })), true);
    assert.equal(await precondition(makeCtx({})), false);
  });
});
