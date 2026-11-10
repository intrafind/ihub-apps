// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The server counts tokens with the real tokenizer, not with one token per
 * four characters: `shared/tokenEstimator.js` sits next to `server/`, so Node
 * does not look in `server/node_modules` from there by itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateTokens } from '../../shared/tokenEstimator.js';

describe('server token estimate', () => {
  it('depends on gpt-tokenizer and finds it from shared/', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.dependencies['gpt-tokenizer'], 'server/package.json depends on gpt-tokenizer');
    const sample =
      'Die Plattform durchsucht Dokumente im Unternehmen und beantwortet Fragen zu Prozessen.';
    assert.notEqual(estimateTokens(sample), Math.ceil(sample.length / 4));
  });

  it('counts empty and invalid input as zero', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(undefined), 0);
  });
});
