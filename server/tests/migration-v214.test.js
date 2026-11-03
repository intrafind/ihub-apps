// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V214: usage limit defaults (no limits, built-in reset schedule). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V214__usage_limits_defaults.js';
import { setDefault } from '../migrations/utils.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';

function makeCtx(files) {
  return {
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = structuredClone(data);
    },
    setDefault,
    log: () => {},
    warn: () => {}
  };
}

describe('V214 usage_limits_defaults', () => {
  it('has version 214', () => assert.equal(version, '214'));

  it('skips an installation without platform.json', async () => {
    assert.equal(await precondition(makeCtx({})), false);
  });

  it('adds an empty budget and the default reset schedule', async () => {
    const ctx = makeCtx({ 'config/platform.json': { defaultLanguage: 'en' } });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].usageLimits, {
      allModels: {},
      resets: {
        timezone: null,
        dailyAt: '00:00',
        weeklyOn: 'monday',
        weeklyAt: '00:00',
        monthlyAt: '00:00'
      }
    });
    assert.ok(platformConfigSchema.safeParse(ctx.files['config/platform.json']).success);
  });

  it('keeps what an admin already set', async () => {
    const ctx = makeCtx({
      'config/platform.json': {
        usageLimits: { allModels: { month: 5000 }, resets: { dailyAt: '06:00' } }
      }
    });
    await up(ctx);
    const limits = ctx.files['config/platform.json'].usageLimits;
    assert.deepEqual(limits.allModels, { month: 5000 });
    assert.equal(limits.resets.dailyAt, '06:00');
    assert.equal(limits.resets.weeklyOn, 'monday');
  });
});
