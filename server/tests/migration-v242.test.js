// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V242 specs — AI-use acknowledgement defaults (#3326).
 * Run: node --test server/tests/migration-v242.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setDefault } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V242__ai_acknowledgement_defaults.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';

const PLATFORM = 'config/platform.json';

function fakeCtx(files) {
  return {
    files,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, data) => {
      files[p] = data;
    },
    setDefault,
    log: () => {},
    warn: () => {}
  };
}

test('version, description and precondition', async () => {
  assert.equal(version, '242');
  assert.equal(description, 'ai_acknowledgement_defaults');
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ [PLATFORM]: {} })), true);
});

test('fresh file: adds the defaults and is idempotent', async () => {
  const ctx = fakeCtx({ [PLATFORM]: { defaultLanguage: 'de' } });
  await up(ctx);
  const block = ctx.files[PLATFORM].aiAcknowledgement;
  assert.equal(block.enabled, true);
  assert.equal(block.enforce, true);
  assert.equal(block.requiredVersion, 1);
  assert.equal(block.resetAt, null);
  assert.equal(block.policyUrl, '');
  assert.ok(block.text.en && block.text.de);
  assert.equal(ctx.files[PLATFORM].defaultLanguage, 'de');
  const once = JSON.stringify(ctx.files[PLATFORM]);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files[PLATFORM]), once);
});

test('partial file: keeps what the admin already set', async () => {
  const ctx = fakeCtx({
    [PLATFORM]: {
      aiAcknowledgement: {
        enforce: false,
        requiredVersion: 4,
        text: { en: 'Custom' },
        policyUrl: 'https://example.com/policy'
      }
    }
  });
  await up(ctx);
  const block = ctx.files[PLATFORM].aiAcknowledgement;
  assert.equal(block.enforce, false);
  assert.equal(block.requiredVersion, 4);
  assert.equal(block.text.en, 'Custom');
  assert.ok(block.text.de, 'the missing language is filled in');
  assert.equal(block.enabled, true);
  assert.equal(block.policyUrl, 'https://example.com/policy');
});

test('the shipped defaults match the migration and validate', async () => {
  const shipped = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL('../defaults/config/platform.json', import.meta.url)),
      'utf8'
    )
  );
  const ctx = fakeCtx({ [PLATFORM]: {} });
  await up(ctx);
  assert.deepEqual(shipped.aiAcknowledgement, ctx.files[PLATFORM].aiAcknowledgement);
  assert.equal(platformConfigSchema.safeParse(shipped).success, true);
});

test('platform schema: policyUrl accepts http(s) and relative, rejects the rest', () => {
  const ok = policyUrl =>
    platformConfigSchema.safeParse({ aiAcknowledgement: { policyUrl } }).success;
  assert.equal(ok(''), true);
  assert.equal(ok('https://example.com/ai'), true);
  assert.equal(ok('/pages/ai-policy'), true);
  assert.equal(ok('javascript:alert(1)'), false);
  assert.equal(ok('//evil.example'), false);
  assert.equal(ok('data:text/html,x'), false);
  const base = platformConfigSchema.parse({});
  assert.equal(base.aiAcknowledgement.requiredVersion, 1);
  assert.equal(base.aiAcknowledgement.enforce, true);
});
