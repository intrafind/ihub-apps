// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V241 specs — AI disclosure first-turn notice defaults (#3325).
 * Run: node --test server/tests/migration-v241.test.js
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
} from '../migrations/V241__ai_disclosure_first_turn_notice.js';
import { AI_DISCLOSURE_RULE, resolveGuardrailRule } from '../services/provenance/guardrail.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { aiDisclosureClientConfig } from '../routes/chat/dataRoutes.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';

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
  assert.equal(version, '241');
  assert.equal(description, 'ai_disclosure_first_turn_notice');
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ [PLATFORM]: {} })), true);
});

test('adds the defaults, keeps everything else, is idempotent', async () => {
  const ctx = fakeCtx({ [PLATFORM]: { defaultLanguage: 'de' } });
  await up(ctx);
  assert.deepEqual(ctx.files[PLATFORM].aiDisclosure, {
    firstTurnNotice: { enabled: true, text: {} },
    guardrail: { text: '' }
  });
  assert.equal(ctx.files[PLATFORM].defaultLanguage, 'de');
  const once = JSON.stringify(ctx.files[PLATFORM]);
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files[PLATFORM]), once);
});

test('keeps admin values', async () => {
  const ctx = fakeCtx({
    [PLATFORM]: {
      aiDisclosure: {
        firstTurnNotice: { enabled: false, text: { en: 'Hi' } },
        guardrail: { text: 'Custom rule.' }
      }
    }
  });
  await up(ctx);
  assert.equal(ctx.files[PLATFORM].aiDisclosure.guardrail.text, 'Custom rule.');
  assert.deepEqual(ctx.files[PLATFORM].aiDisclosure.firstTurnNotice, {
    enabled: false,
    text: { en: 'Hi' }
  });
});

test('the shipped defaults match the migration', async () => {
  const shipped = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL('../defaults/config/platform.json', import.meta.url)),
      'utf8'
    )
  );
  const ctx = fakeCtx({ [PLATFORM]: {} });
  await up(ctx);
  assert.deepEqual(shipped.aiDisclosure, ctx.files[PLATFORM].aiDisclosure);
});

test('platform schema: defaults, validation, and no guardrail switch', () => {
  const base = platformConfigSchema.parse({});
  assert.equal(base.aiDisclosure.firstTurnNotice.enabled, true);
  assert.deepEqual(base.aiDisclosure.firstTurnNotice.text, {});
  assert.equal(
    platformConfigSchema.safeParse({
      aiDisclosure: { firstTurnNotice: { text: { 'not a code!': 'x' } } }
    }).success,
    false
  );
  assert.equal(base.aiDisclosure.guardrail.text, '');
  assert.equal(
    platformConfigSchema.safeParse({ aiDisclosure: { guardrail: { text: 'x'.repeat(2001) } } })
      .success,
    false
  );
  // The rule can be reworded but not switched off: an `enabled` key is not a setting.
  const parsed = platformConfigSchema.parse({
    aiDisclosure: { guardrail: { enabled: false, text: '' } }
  });
  assert.equal(resolveGuardrailRule(parsed), AI_DISCLOSURE_RULE);
});

test('client config exposes enabled and non-blank text only', () => {
  assert.deepEqual(aiDisclosureClientConfig(undefined), {
    firstTurnNotice: { enabled: true, text: {} }
  });
  assert.deepEqual(
    aiDisclosureClientConfig({ firstTurnNotice: { enabled: false, text: { en: 'A', de: '  ' } } }),
    { firstTurnNotice: { enabled: false, text: { en: 'A' } } }
  );
});

test('app schema accepts the override and rejects unknown keys', () => {
  const app = {
    id: 'legal-assistant',
    name: { en: 'X' },
    description: { en: 'X' },
    color: '#4F46E5',
    icon: 'chat'
  };
  const parse = aiDisclosure => appConfigSchema.safeParse({ ...app, aiDisclosure }).success;
  const known = appConfigSchema.safeParse(app).success;
  assert.equal(known, true, 'base app fixture is valid');
  {
    assert.equal(parse({ firstTurnNotice: { enabled: false } }), true);
    assert.equal(parse({ firstTurnNotice: { text: { en: 'Hi' } } }), true);
    assert.equal(parse({ guardrail: { text: 'x' } }), false); // the rule is platform-wide only
    assert.equal(parse({ firstTurnNotice: { other: 1 } }), false);
  }
});
