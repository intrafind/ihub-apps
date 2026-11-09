// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V236 specs — the old defaults of the project limits (25 items,
 * 200 MB per project) are raised to 100 items and 500 MB; values an admin
 * chose stay.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V236__raise_project_limit_defaults.js';

const PLATFORM = 'config/platform.json';
const MB = 1024 * 1024;

function makeCtx(files) {
  const logs = [];
  let writes = 0;
  return {
    logs,
    files,
    get writes() {
      return writes;
    },
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes++;
      files[rel] = data;
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

describe('V236 raise project limit defaults', () => {
  it('has a version and description', () => {
    assert.equal(version, '236');
    assert.equal(description, 'raise_project_limit_defaults');
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ [PLATFORM]: {} })), true);
  });

  it('raises the limits that still hold the old defaults', async () => {
    const ctx = makeCtx({
      [PLATFORM]: {
        defaultLanguage: 'en',
        projects: {
          tierPolicy: 'both',
          limits: {
            maxFiles: 25,
            maxFileBytes: 20 * MB,
            maxProjectBytes: 200 * MB,
            maxProjectsPerUser: 20
          }
        }
      }
    });
    await up(ctx);
    assert.equal(ctx.writes, 1);
    assert.deepEqual(ctx.files[PLATFORM], {
      defaultLanguage: 'en',
      projects: {
        tierPolicy: 'both',
        limits: {
          maxFiles: 100,
          maxFileBytes: 20 * MB,
          maxProjectBytes: 500 * MB,
          maxProjectsPerUser: 20
        }
      }
    });
  });

  it('keeps values an admin chose', async () => {
    const ctx = makeCtx({
      [PLATFORM]: { projects: { limits: { maxFiles: 40, maxProjectBytes: 1024 * MB } } }
    });
    await up(ctx);
    assert.equal(ctx.writes, 0);
    assert.deepEqual(ctx.files[PLATFORM].projects.limits, {
      maxFiles: 40,
      maxProjectBytes: 1024 * MB
    });
  });

  it('raises one and keeps the other', async () => {
    const ctx = makeCtx({
      [PLATFORM]: { projects: { limits: { maxFiles: 10, maxProjectBytes: 200 * MB } } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM].projects.limits, {
      maxFiles: 10,
      maxProjectBytes: 500 * MB
    });
  });

  it('leaves a platform.json without project limits alone', async () => {
    for (const platform of [{}, { projects: {} }, { projects: { limits: null } }]) {
      const ctx = makeCtx({ [PLATFORM]: platform });
      await up(ctx);
      assert.equal(ctx.writes, 0);
      assert.deepEqual(ctx.files[PLATFORM], platform);
    }
  });
});
