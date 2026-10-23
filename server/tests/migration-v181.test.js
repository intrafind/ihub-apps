// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V181 — the iHub documentation project is published.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  description,
  precondition,
  up,
  version
} from '../migrations/V181__publish_ihub_documentation_project.js';
import { setDefault } from '../migrations/utils.js';

const FILE = 'projects/ihub-documentation.json';

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

describe('V181 publish the iHub documentation project', () => {
  it('is versioned and described', () => {
    assert.equal(version, '181');
    assert.equal(description, 'publish_ihub_documentation_project');
  });

  it('only runs where the project exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ [FILE]: { id: 'ihub-documentation' } })), true);
  });

  it('publishes the project', async () => {
    const ctx = makeCtx({ [FILE]: { id: 'ihub-documentation', enabled: true } });
    await up(ctx);
    assert.deepEqual(ctx.files[FILE], { id: 'ihub-documentation', enabled: true, published: true });
  });

  it('keeps a choice an admin already made', async () => {
    const ctx = makeCtx({ [FILE]: { id: 'ihub-documentation', published: false } });
    await up(ctx);
    assert.equal(ctx.files[FILE].published, false);
  });
});
