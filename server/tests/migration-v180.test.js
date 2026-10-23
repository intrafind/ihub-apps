// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V180 — the project catalog switch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  description,
  precondition,
  up,
  version
} from '../migrations/V180__project_catalog_sharing.js';
import { setDefault } from '../migrations/utils.js';

function makeCtx(files) {
  const logs = [];
  return {
    logs,
    files,
    fileExists: async rel => Object.hasOwn(files, rel),
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = data;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

describe('V180 project catalog sharing', () => {
  it('is versioned and described', () => {
    assert.equal(version, '180');
    assert.equal(description, 'project_catalog_sharing');
  });

  it('only runs where there is a platform config', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/platform.json': {} })), true);
  });

  it('adds the switch, off, next to the other sharing audiences', async () => {
    const ctx = makeCtx({
      'config/platform.json': { projects: { sharing: { allowUsers: true, allowEveryone: true } } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].projects.sharing, {
      allowUsers: true,
      allowEveryone: true,
      allowCatalog: false
    });
  });

  it('keeps a value an admin already set', async () => {
    const ctx = makeCtx({
      'config/platform.json': { projects: { sharing: { allowCatalog: true } } }
    });
    await up(ctx);
    assert.equal(ctx.files['config/platform.json'].projects.sharing.allowCatalog, true);
  });
});
