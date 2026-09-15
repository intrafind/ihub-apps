#!/usr/bin/env node

/**
 * Google adapter thinkingConfig specs.
 *
 * There is one shape: `thinkingLevel` plus `includeThoughts`. Gemini 2.5's
 * `thinkingBudget` is retired, so the load-bearing assertion in most of these
 * is a negative one — `thinkingBudget` never reaches the wire, whatever the
 * model config or the request asks for, because a Gemini 3 endpoint answers a
 * request carrying it with a bare 400 naming no field.
 *
 * `includeThoughts` asks for the thought summaries the chat UI renders as the
 * thinking panel. It is sent whenever thinking is on; omitting it was why
 * models on `thinking.level` showed no reasoning while still being billed for
 * it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import GoogleAdapter from '../adapters/google.js';

const messages = [{ role: 'user', content: 'test' }];

/** A Gemini model config with the given thinking block. */
function model(thinking, overrides = {}) {
  return {
    modelId: 'gemini-3-pro',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent',
    provider: 'google',
    thinking,
    ...overrides
  };
}

async function thinkingConfigFor(thinking, options = {}, overrides = {}) {
  const request = await GoogleAdapter.createCompletionRequest(
    model(thinking, overrides),
    messages,
    'key',
    options
  );
  return request.body.generationConfig.thinkingConfig;
}

describe('Gemini 3 shape (thinkingLevel)', () => {
  it('asks for thought summaries alongside the level', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, level: 'high' });

    assert.equal(cfg.thinkingLevel, 'high');
    assert.equal(cfg.includeThoughts, true);
  });

  it('sends only the level and the thoughts flag', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, level: 'low' });

    assert.deepEqual(
      Object.keys(cfg).sort(),
      ['includeThoughts', 'thinkingLevel'],
      'anything else in thinkingConfig is a field Gemini 3 did not ask for'
    );
  });

  it('honours thoughts: false', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, level: 'medium', thoughts: false });

    assert.equal(cfg.thinkingLevel, 'medium');
    assert.equal(cfg.includeThoughts, false);
  });

  it('lets a per-request option override the model default', async () => {
    const cfg = await thinkingConfigFor(
      { enabled: true, level: 'high', thoughts: true },
      { thinkingThoughts: false }
    );

    assert.equal(cfg.includeThoughts, false);
  });

  it('normalizes the level to the lowercase JSON enum', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, level: 'HIGH' });

    assert.equal(cfg.thinkingLevel, 'high', 'uppercase spellings are SDK constants');
  });

  it('applies to image models too', async () => {
    const cfg = await thinkingConfigFor(
      { enabled: true, level: 'high' },
      {},
      {
        supportsImageGeneration: true
      }
    );

    assert.equal(cfg.includeThoughts, true);
  });
});

describe('the retired Gemini 2.5 budget', () => {
  it('never sends thinkingBudget, even when the model config still has one', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, budget: -1, thoughts: true });

    assert.equal(cfg.thinkingBudget, undefined, 'a Gemini 3 endpoint 400s on thinkingBudget');
    assert.equal(cfg.includeThoughts, true, 'thoughts still work without a level');
  });

  it('does not invent a level from a budget', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, budget: 8000 });

    assert.equal(
      cfg.thinkingLevel,
      undefined,
      'converting a budget here would be the second way this adapter no longer has'
    );
    assert.equal(cfg.includeThoughts, true);
  });

  it('ignores a per-request thinkingBudget too', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, level: 'low' }, { thinkingBudget: 8000 });

    assert.equal(cfg.thinkingBudget, undefined);
    assert.equal(cfg.thinkingLevel, 'low', 'the level still decides');
  });

  it('prefers the level when a config carries both', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, level: 'minimal', budget: 8000 });

    assert.equal(cfg.thinkingLevel, 'minimal');
    assert.equal(cfg.thinkingBudget, undefined);
  });
});

describe('thinking disabled', () => {
  it('sends no thinkingConfig when the model has thinking off', async () => {
    const cfg = await thinkingConfigFor({ enabled: false, level: 'high' });

    assert.equal(cfg, undefined);
  });

  it('sends no thinkingConfig when the request turns thinking off', async () => {
    const cfg = await thinkingConfigFor(
      { enabled: true, level: 'high' },
      { thinkingEnabled: false }
    );

    assert.equal(cfg, undefined);
  });
});
