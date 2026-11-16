// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `providerMarkingOffer`: which marking kinds of an already configured model its provider
 * declares and the model does not carry. The EU AI Act overview uses it to point at the
 * Sync button of the model; Sync itself applies the same rule against the provider's listing.
 */
import { describe, test, expect } from '@jest/globals';

const { providerMarkingOffer } = await import('../services/gatewayDrift.js');

const anthropic = (extra = {}) => ({
  id: 'haiku',
  provider: 'anthropic',
  modelId: 'claude-haiku-4-5-20251001',
  url: 'https://api.anthropic.com/v1/messages',
  ...extra
});

describe('providerMarkingOffer', () => {
  test('Gemini text and Claude text are offered to a model that declares nothing', () => {
    expect(
      providerMarkingOffer({ id: 'g', provider: 'google', modelId: 'gemini-3.1-pro' })
    ).toEqual(['text']);
    expect(providerMarkingOffer(anthropic())).toEqual(['text']);
  });

  test('Nano Banana 2.1 (an id without "image") is an image model too', () => {
    expect(
      providerMarkingOffer({
        id: 'nb',
        provider: 'google',
        modelId: 'gemini-nano-banana-2.1',
        supportsImageGeneration: true
      })
    ).toEqual(['text', 'image']);
  });

  test('a Gemini image model is offered text and image', () => {
    expect(
      providerMarkingOffer({
        id: 'n',
        provider: 'google',
        modelId: 'gemini-3-pro-image-preview',
        supportsImageGeneration: true
      })
    ).toEqual(['text', 'image']);
  });

  test('a marking the model already has is never offered again', () => {
    const marked = { text: { by: 'provider', scheme: 'custom', statementRef: 'DPA' } };
    expect(providerMarkingOffer(anthropic({ contentMarking: marked }))).toEqual([]);
    // "none" counts as unset, like in the sync.
    expect(providerMarkingOffer(anthropic({ contentMarking: { text: { by: 'none' } } }))).toEqual([
      'text'
    ]);
  });

  test('Claude models Anthropic lists for its own API only are not offered through a cloud partner', () => {
    expect(providerMarkingOffer(anthropic({ url: 'https://example.invalid/v1/messages' }))).toEqual(
      []
    );
  });

  test('Sonnet 4.6 with a non-default sampling is not offered the mark', () => {
    const sonnet = anthropic({ modelId: 'claude-sonnet-4-6' });
    expect(providerMarkingOffer(sonnet)).toEqual(['text']);
    expect(providerMarkingOffer({ ...sonnet, sampling: { temperature: 0.2 } })).toEqual([]);
  });

  test('Mistral, OpenAI, speech models and Gemma declare nothing', () => {
    expect(
      providerMarkingOffer({ id: 'm', provider: 'mistral', modelId: 'mistral-large-latest' })
    ).toEqual([]);
    expect(providerMarkingOffer({ id: 'o', provider: 'openai', modelId: 'gpt-5' })).toEqual([]);
    expect(
      providerMarkingOffer({ id: 'gemma', provider: 'google', modelId: 'gemma-3-27b' })
    ).toEqual([]);
    expect(
      providerMarkingOffer({
        id: 't',
        provider: 'google',
        modelId: 'gemini-3.8-flash-tts',
        modelType: 'tts'
      })
    ).toEqual([]);
  });
});
