#!/usr/bin/env node

/**
 * Tests for FeatureFlags.isAppFeatureEnabled — object-valued features must
 * count as enabled unless explicitly `false`.
 *
 * Run directly: `node shared/featureFlags.test.js`.
 */

import { FeatureFlags } from './featureFlags.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 isAppFeatureEnabled\n');
{
  const flags = new FeatureFlags();

  const objectFeatureApp = { features: { shortLinks: { maxLinks: 5 } } };
  check(
    'object value → enabled regardless of defaultValue=false',
    flags.isAppFeatureEnabled(objectFeatureApp, 'shortLinks', false) === true
  );
  check(
    'object value → enabled regardless of defaultValue=true',
    flags.isAppFeatureEnabled(objectFeatureApp, 'shortLinks', true) === true
  );

  const disabledApp = { features: { shortLinks: false } };
  check(
    'explicit false → disabled',
    flags.isAppFeatureEnabled(disabledApp, 'shortLinks', true) === false
  );

  const enabledBooleanApp = { features: { shortLinks: true } };
  check(
    'explicit true → enabled',
    flags.isAppFeatureEnabled(enabledBooleanApp, 'shortLinks', false) === true
  );

  const missingPathApp = { features: {} };
  check(
    'missing path → falls back to defaultValue (true)',
    flags.isAppFeatureEnabled(missingPathApp, 'shortLinks', true) === true
  );
  check(
    'missing path → falls back to defaultValue (false)',
    flags.isAppFeatureEnabled(missingPathApp, 'shortLinks', false) === false
  );

  check(
    'no app.features → falls back to defaultValue',
    flags.isAppFeatureEnabled({}, 'shortLinks', true) === true
  );

  const nestedObjectApp = { features: { magicPrompt: { enabled: true, model: 'gpt' } } };
  check(
    'nested dot-path object value → enabled',
    flags.isAppFeatureEnabled(nestedObjectApp, 'magicPrompt', false) === true
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
