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
import {
  estimateTokens,
  estimateTokensFor,
  estimateTokensMemo,
  FULL_COUNT_MAX_CHARS
} from '../../shared/tokenEstimator.js';

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

  it('counts long texts from samples, within a few percent and without blocking', () => {
    const prose = 'Die Plattform durchsucht Dokumente im Unternehmen und beantwortet Fragen. ';
    const text = prose.repeat(Math.ceil((FULL_COUNT_MAX_CHARS * 2) / prose.length));
    const exact =
      estimateTokens(text.slice(0, FULL_COUNT_MAX_CHARS)) * (text.length / FULL_COUNT_MAX_CHARS);
    const started = performance.now();
    const sampled = estimateTokens(text);
    const ms = performance.now() - started;
    assert.ok(Math.abs(sampled - exact) / exact < 0.05, `sampled ${sampled} vs ~${exact}`);
    assert.ok(ms < 100, `sampled count took ${ms} ms`);
    // A run without whitespace is the slow case of the exact count (~1.4 s per MB).
    const run = estimateTokens('a'.repeat(4 * 1024 * 1024));
    assert.ok(run > 0);
  });

  it('remembers the count on the owner and recounts when the text changes', () => {
    const message = { content: 'Die Plattform durchsucht Dokumente im Unternehmen.' };
    const first = estimateTokensFor(message, message.content);
    assert.equal(first, estimateTokens(message.content));
    assert.equal(estimateTokensFor(message, message.content), first);
    message.content = `${message.content} Und beantwortet Fragen zu Prozessen.`;
    assert.equal(estimateTokensFor(message, message.content), estimateTokens(message.content));
    assert.equal(estimateTokensFor(null, 'abc'), estimateTokens('abc'));
  });

  it('remembers counts by content, stays exact and keeps a bounded amount of text', () => {
    const text = 'Durchsucht Dokumente im Unternehmen und beantwortet Fragen. '.repeat(40);
    assert.equal(estimateTokensMemo(text), estimateTokens(text));
    assert.equal(estimateTokensMemo(`${text}`.slice(0)), estimateTokens(text));
    assert.equal(estimateTokensMemo('kurz'), estimateTokens('kurz'));
    assert.equal(estimateTokensMemo(undefined), 0);
    // Far more than the memo budget goes through without error and stays correct.
    for (let i = 0; i < 40; i++) {
      const big = `${i} ${'x y z '.repeat(60000)}`;
      assert.equal(estimateTokensMemo(big), estimateTokens(big));
    }
  });
});
