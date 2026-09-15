#!/usr/bin/env node

/**
 * Google adapter thinkingConfig specs.
 *
 * Gemini has two incompatible thinking schemas — 2.5's `thinkingBudget` and
 * 3.x's `thinkingLevel`, which the API rejects if sent together — and one
 * field that belongs to both: `includeThoughts`, which asks for the thought
 * summaries the chat UI renders as the thinking panel.
 *
 * The Gemini 3 branch used to send `thinkingLevel` alone, so every model moved
 * onto `thinking.level` silently stopped returning thoughts while still
 * spending reasoning tokens. These specs pin the field to both shapes, and pin
 * that the two level/budget keys never travel together.
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

  it('never sends thinkingBudget with thinkingLevel', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, level: 'low', budget: -1 });

    assert.equal(cfg.thinkingLevel, 'low');
    assert.equal(cfg.thinkingBudget, undefined, 'Gemini 3 returns an error when both are present');
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

describe('Gemini 2.5 shape (thinkingBudget)', () => {
  it('keeps sending budget and thoughts together', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, budget: -1, thoughts: true });

    assert.equal(cfg.thinkingBudget, -1);
    assert.equal(cfg.includeThoughts, true);
    assert.equal(cfg.thinkingLevel, undefined, 'thinkingLevel 400s on a 2.5 endpoint');
  });

  it('defaults thoughts on when the config does not say', async () => {
    const cfg = await thinkingConfigFor({ enabled: true, budget: 1024 });

    assert.equal(cfg.includeThoughts, true);
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
