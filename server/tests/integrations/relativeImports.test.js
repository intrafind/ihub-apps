// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `relativeImportsOf` finds the relative imports of an integration's code file. Its pattern must
 * not take quadratic time on a long run of blanks: a definition is third-party content that an
 * admin installs, and the check runs on every one of its files.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { relativeImportsOf } from '../../services/integrations/definitions/scriptModule.js';

describe('relativeImportsOf', () => {
  it('names each relative import once, whatever the form', () => {
    const source = [
      `import a from "./a.js";`,
      `import("../b");`,
      `const c = require( './c' );`,
      'const d = require(\t\n`./d`);',
      `export { e } from   './e';`,
      `import "./a.js";`,
      `import f from "lib";`
    ].join('\n');
    assert.deepEqual(relativeImportsOf(source), ['./a.js', '../b', './c', './d', './e']);
  });

  it('ignores a source that is not a string', () => {
    assert.deepEqual(relativeImportsOf(undefined), []);
    assert.deepEqual(relativeImportsOf(42), []);
  });

  it('stays fast on a very long run of blanks after a keyword', () => {
    const source = `require${'\t'.repeat(60000)}x`;
    const started = process.hrtime.bigint();
    assert.deepEqual(relativeImportsOf(source), []);
    const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
    // The old pattern needed about 1800 ms for this input; the new one well under 10.
    assert.ok(milliseconds < 500, `took ${milliseconds} ms`);
  });
});
