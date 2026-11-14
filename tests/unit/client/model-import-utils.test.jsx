import { describe, it, expect } from '@jest/globals';
import {
  buildImportedModelConfig,
  buildNewProviderConfig,
  findIdProblems,
  getImportableProviders,
  isValidId,
  slugify,
  suggestModelId,
  translateDiscoveryError
} from '../../../client/src/features/admin/utils/modelImport';

const entry = {
  id: 'Mistral-Small-4-119B-2603',
  name: 'Mistral Small 4 119B Instruct',
  description: null,
  type: 'chat',
  contextWindow: 262144,
  maxOutputTokens: 128000,
  supportsVision: true,
  supportsTools: null,
  url: 'https://llm-server.llmhub.t-systems.net/v2/chat/completions'
};

describe('suggestModelId / slugify', () => {
  it('turns remote ids into valid iHub ids', () => {
    expect(suggestModelId('Qwen/Qwen3-8B')).toBe('qwen-qwen3-8b');
    expect(suggestModelId('/models/Llama 3.3:70b')).toBe('models-llama-3.3-70b');
    expect(suggestModelId('gpt-oss-120b', 'llmhub-')).toBe('llmhub-gpt-oss-120b');
    expect(suggestModelId('???')).toBe('');
    expect(slugify('T-Systems LLM Hub')).toBe('t-systems-llm-hub');
    expect(slugify('._-model-._')).toBe('model');
  });

  it('trims a long run of separators in linear time', () => {
    const started = Date.now();
    expect(slugify(`${'._'.repeat(100000)}x${'._'.repeat(100000)}`)).toBe('x');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('isValidId', () => {
  it('refuses what the server refuses, so an import fails before anything is created', () => {
    expect(isValidId('llmhub-gpt-oss-120b')).toBe(true);
    expect(isValidId('a'.repeat(100))).toBe(true);
    expect(isValidId('a'.repeat(101))).toBe(false);
    expect(isValidId('.')).toBe(false);
    expect(isValidId('a..b')).toBe(false);
    expect(isValidId('constructor')).toBe(false);
    expect(isValidId('__proto__')).toBe(false);
    expect(isValidId('Upper')).toBe(false);
    expect(isValidId('')).toBe(false);
  });
});

describe('findIdProblems', () => {
  it('flags invalid, existing and duplicate target ids', () => {
    const problems = findIdProblems(
      [
        { key: 'a', id: 'Bad ID' },
        { key: 'b', id: 'gpt-5' },
        { key: 'c', id: 'same' },
        { key: 'd', id: 'same' },
        { key: 'e', id: 'fine' }
      ],
      ['gpt-5']
    );
    expect(problems).toEqual({ a: 'invalid', b: 'exists', c: 'duplicate', d: 'duplicate' });
  });
});

describe('buildImportedModelConfig', () => {
  it('links the model to its provider and stores no key', () => {
    const config = buildImportedModelConfig(entry, {
      id: 'llmhub-mistral-small-4',
      apiType: 'openai',
      providerId: 'llmhub',
      modelsUrl: 'https://llm-server.llmhub.t-systems.net/v2/models'
    });
    expect(config).toEqual({
      id: 'llmhub-mistral-small-4',
      modelId: 'Mistral-Small-4-119B-2603',
      name: { en: 'Mistral Small 4 119B Instruct', de: 'Mistral Small 4 119B Instruct' },
      description: {
        en: 'Imported from llm-server.llmhub.t-systems.net.',
        de: 'Importiert von llm-server.llmhub.t-systems.net.'
      },
      url: 'https://llm-server.llmhub.t-systems.net/v2/chat/completions',
      provider: 'openai',
      providerId: 'llmhub',
      enabled: true,
      default: false,
      contextWindow: 262144,
      maxOutputTokens: 128000,
      supportsVision: true
    });
    expect(config.apiKey).toBeUndefined();
  });

  it('imports a model that advertises function calling as auto, never as required', () => {
    const options = { id: 'm', apiType: 'openai', modelsUrl: 'https://example.com/v1/models' };

    expect(buildImportedModelConfig({ ...entry, supportsTools: true }, options).supportsTools).toBe(
      'auto'
    );
    expect(
      buildImportedModelConfig({ ...entry, supportsTools: false }, options).supportsTools
    ).toBe('none');
    expect(buildImportedModelConfig(entry, options)).not.toHaveProperty('supportsTools');
  });

  it('copies what discovery decided about marking and image generation, per model', () => {
    const marking = { by: 'provider', scheme: 'synthid', statementRef: 'Google DeepMind, SynthID' };
    const options = { id: 'm', apiType: 'google', modelsUrl: 'https://example.com/v1beta/models' };
    const imageEntry = {
      ...entry,
      supportsImageGeneration: true,
      contentMarking: { text: marking, image: marking }
    };

    const a = buildImportedModelConfig(imageEntry, options);
    const b = buildImportedModelConfig(imageEntry, options);
    expect(a.supportsImageGeneration).toBe(true);
    expect(a.contentMarking).toEqual({ text: marking, image: marking });

    // Each model gets objects of its own.
    a.contentMarking.text.scheme = 'changed';
    expect(b.contentMarking.text.scheme).toBe('synthid');
    expect(imageEntry.contentMarking.text.scheme).toBe('synthid');
  });

  it('sets no marking or image generation for a model the provider says nothing about', () => {
    const config = buildImportedModelConfig(entry, {
      id: 'm',
      apiType: 'openai',
      modelsUrl: 'https://example.com/v1/models'
    });
    expect(config).not.toHaveProperty('contentMarking');
    expect(config).not.toHaveProperty('supportsImageGeneration');
  });

  it('keeps the link to a custom provider whose ID equals an API type', () => {
    const config = buildImportedModelConfig(entry, {
      id: 'm',
      apiType: 'openai-responses',
      providerId: 'openai-responses',
      modelsUrl: 'https://gateway.example.com/v1/models'
    });
    expect(config.providerId).toBe('openai-responses');
  });

  it('omits the link for a built-in provider of the same API type', () => {
    const config = buildImportedModelConfig(entry, {
      id: 'm',
      apiType: 'openai',
      providerId: 'openai',
      modelsUrl: 'https://api.openai.com/v1/models',
      enabled: false
    });
    expect(config.providerId).toBeUndefined();
    expect(config.enabled).toBe(false);
  });

  // As discovery returns it: the speech backend and URL it is imported with.
  const whisper = {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    type: 'transcription',
    modelType: 'transcription',
    backend: 'openai',
    url: 'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions',
    contextWindow: 4096
  };

  it('imports a speech-to-text model of an OpenAI endpoint as a transcription model', () => {
    const config = buildImportedModelConfig(whisper, {
      id: 'llmhub-whisper-large-v3-turbo',
      apiType: 'openai',
      providerId: 'llmhub',
      modelsUrl: 'https://llm-server.llmhub.t-systems.net/v2/models'
    });
    expect(config).toMatchObject({
      modelId: 'whisper-large-v3-turbo',
      url: 'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions',
      provider: 'openai',
      providerId: 'llmhub',
      modelType: 'transcription'
    });
    // Chat settings mean nothing to it.
    expect(config.contextWindow).toBeUndefined();
  });

  it('imports a Gemini live transcription model for the Live API backend', () => {
    const live = {
      id: 'gemini-3.5-transcribe-live',
      name: 'Gemini 3.5 Transcribe Live',
      type: 'transcription',
      modelType: 'transcription',
      backend: 'google-live',
      url: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
      contextWindow: 131072
    };
    const config = buildImportedModelConfig(live, {
      id: 'gemini-3.5-transcribe-live',
      apiType: 'google',
      providerId: 'google',
      modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models'
    });
    expect(config).toMatchObject({
      modelId: 'gemini-3.5-transcribe-live',
      provider: 'google-live',
      modelType: 'transcription',
      url: live.url
    });
    // Reached through the built-in Google provider: no link stored.
    expect(config.providerId).toBeUndefined();
    expect(config.contextWindow).toBeUndefined();
  });

  it('imports a text-to-speech model, keeping the link to a custom provider', () => {
    const tts = {
      id: 'voxtral-mini-tts-2603',
      name: 'Voxtral Mini TTS',
      type: 'tts',
      modelType: 'tts',
      backend: 'mistral',
      url: 'https://mistral-gw.example/v1/audio/speech'
    };
    const config = buildImportedModelConfig(tts, {
      id: 'gw-voxtral-mini-tts',
      apiType: 'mistral',
      providerId: 'mistral-gw',
      modelsUrl: 'https://mistral-gw.example/v1/models'
    });
    expect(config).toMatchObject({
      provider: 'mistral',
      providerId: 'mistral-gw',
      modelType: 'tts',
      url: tts.url
    });
  });

  it('leaves it a plain import when discovery names no speech backend', () => {
    const { modelType: _type, backend: _backend, ...unmapped } = whisper;
    const config = buildImportedModelConfig(unmapped, {
      id: 'm',
      apiType: 'mistral',
      providerId: 'mistral',
      modelsUrl: 'https://api.mistral.ai/v1/models'
    });
    expect(config.modelType).toBeUndefined();
    expect(config.provider).toBe('mistral');
  });
});

describe('buildImportedModelConfig for an iFinder Model Gateway', () => {
  const options = {
    id: 'gw-m',
    apiType: 'openai',
    providerId: 'ifinder-gw',
    modelsUrl: 'https://gw.example.com:9614/v1/gateway/models'
  };
  const gatewayEntry = {
    id: 'mistral-large-3',
    name: 'mistral-large-3',
    type: 'chat',
    url: 'https://gw.example.com:9614/v1/gateway/proxy/chat/completions',
    modelProvider: 'mistral',
    contextWindow: 131072,
    supportsVision: false,
    supportsTools: false
  };

  it("uses the adapter of the model's own dialect and links it to the gateway provider", () => {
    const config = buildImportedModelConfig(gatewayEntry, options);
    expect(config).toMatchObject({
      modelId: 'mistral-large-3',
      provider: 'mistral',
      providerId: 'ifinder-gw',
      url: 'https://gw.example.com:9614/v1/gateway/proxy/chat/completions',
      contextWindow: 131072,
      // The gateway does not support tool calling yet.
      supportsTools: 'none'
    });
    expect(config.supportsVision).toBeUndefined();
  });

  it('imports an OpenAI-dialect model with the provider API type', () => {
    const config = buildImportedModelConfig(
      { ...gatewayEntry, modelProvider: 'openai', supportsVision: true },
      options
    );
    expect(config.provider).toBe('openai');
    expect(config.supportsVision).toBe(true);
  });

  it('imports a realtime model on its speech backend as a transcription model', () => {
    const config = buildImportedModelConfig(
      {
        id: 'voxtral-realtime',
        name: 'voxtral-realtime',
        type: 'transcription',
        modelType: 'transcription',
        backend: 'vllm-realtime',
        url: 'wss://gw.example.com:9614/v1/gateway/proxy/realtime?model=voxtral-realtime'
      },
      options
    );
    expect(config).toMatchObject({
      provider: 'vllm-realtime',
      modelType: 'transcription',
      providerId: 'ifinder-gw'
    });
    expect(config.contextWindow).toBeUndefined();
  });
});

describe('buildNewProviderConfig', () => {
  it('creates an LLM provider entry with plain-text fields', () => {
    expect(
      buildNewProviderConfig({
        id: 'llmhub',
        name: ' T-Systems LLM Hub ',
        description: '',
        apiType: 'openai',
        baseUrl: 'https://llm-server.llmhub.t-systems.net/v2',
        apiKey: 'gen-key'
      })
    ).toEqual({
      id: 'llmhub',
      name: 'T-Systems LLM Hub',
      description: '',
      category: 'llm',
      apiType: 'openai',
      enabled: true,
      baseUrl: 'https://llm-server.llmhub.t-systems.net/v2',
      apiKey: 'gen-key'
    });
  });
});

describe('buildNewProviderConfig with a gateway', () => {
  it('stores the gateway marker only when one is chosen', () => {
    const base = { id: 'gw', name: 'Gateway', description: '', apiType: 'openai' };
    expect(buildNewProviderConfig({ ...base, gateway: 'ifinder-model-gateway' }).gateway).toBe(
      'ifinder-model-gateway'
    );
    expect(buildNewProviderConfig({ ...base, gateway: '' })).not.toHaveProperty('gateway');
  });
});

describe('getImportableProviders', () => {
  it('keeps LLM providers whose API type lists models', () => {
    const ids = getImportableProviders([
      { id: 'openai' },
      { id: 'bedrock', category: 'llm' },
      { id: 'llmhub', category: 'llm', apiType: 'openai' },
      { id: 'ifinder-gw', category: 'llm', apiType: 'openai', gateway: 'ifinder-model-gateway' },
      { id: 'brave', category: 'websearch' },
      { id: 'my-keys', category: 'custom' }
    ]).map(p => p.id);
    expect(ids).toEqual(['openai', 'llmhub', 'ifinder-gw']);
  });
});

describe('translateDiscoveryError', () => {
  const t = key => `translated(${key})`;
  it('translates known keys and falls back to the server text', () => {
    expect(translateDiscoveryError(t, 'apiKeyRequired', 'x')).toBe(
      'translated(admin.models.import.errors.apiKeyRequired)'
    );
    expect(translateDiscoveryError(t, 'somethingNew', 'raw')).toBe('raw');
  });
});
