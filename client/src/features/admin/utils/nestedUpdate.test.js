#!/usr/bin/env node

/**
 * Tests for the immutable nested-update helpers used by the app-form
 * section components to replace repeated `{...a, b: {...a.b, c: value}}`
 * spread pyramids. Pure (no React) so it runs under node.
 *
 * Run directly: `node client/src/features/admin/utils/nestedUpdate.test.js`.
 */

import { updateIn, updateAt } from './nestedUpdate.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 updateIn\n');
{
  const original = {
    upload: { enabled: true, imageUpload: { enabled: false, maxFileSizeMB: 10 } }
  };

  const result = updateIn(original, ['upload', 'imageUpload', 'enabled'], true);
  check(
    'sets a deeply nested value',
    result.upload.imageUpload.enabled === true,
    JSON.stringify(result)
  );
  check(
    'preserves sibling nested keys',
    result.upload.imageUpload.maxFileSizeMB === 10,
    JSON.stringify(result)
  );
  check('preserves sibling top-level keys', result.upload.enabled === true);

  check('does not mutate the original object', original.upload.imageUpload.enabled === false);
  check('returns a new top-level object', result !== original);
  check('returns a new nested object at the changed branch', result.upload !== original.upload);
  check(
    'leaves untouched nested branches referentially equal is not required, only value-equal',
    JSON.stringify(result.upload.imageUpload) !== JSON.stringify(original.upload.imageUpload)
  );

  const fromMissing = updateIn({}, ['upload', 'audioUpload', 'enabled'], true);
  check(
    'creates missing intermediate objects along the path',
    fromMissing.upload.audioUpload.enabled === true,
    JSON.stringify(fromMissing)
  );

  const dotPath = updateIn(original, 'upload.imageUpload.maxFileSizeMB', 25);
  check(
    'accepts a dot-delimited string path',
    dotPath.upload.imageUpload.maxFileSizeMB === 25,
    JSON.stringify(dotPath)
  );

  const topLevel = updateIn({ a: 1, b: 2 }, ['a'], 99);
  check('single-key path sets a top-level field', topLevel.a === 99 && topLevel.b === 2);

  const wholeValue = updateIn({ a: 1 }, [], { replaced: true });
  check('empty path returns the replacement value as-is', wholeValue.replaced === true);
}

console.log('\n🧪 updateAt\n');
{
  const variables = [
    { name: 'a', predefinedValues: [] },
    { name: 'b', predefinedValues: [] },
    { name: 'c', predefinedValues: [] }
  ];

  const result = updateAt(variables, 1, { name: 'b-renamed' });
  check('patches only the item at the given index', result[1].name === 'b-renamed');
  check('leaves other items untouched by value', result[0].name === 'a' && result[2].name === 'c');
  check('does not mutate the original array', variables[1].name === 'b');
  check('returns a new array', result !== variables);
  check(
    'unpatched items are the same object reference (no unnecessary copies)',
    result[0] === variables[0] && result[2] === variables[2]
  );
}

console.log(`\n${failures === 0 ? '✅ All tests passed' : `❌ ${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
