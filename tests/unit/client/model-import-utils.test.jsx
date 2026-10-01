import { describe, it, expect } from '@jest/globals';
import {
  buildImportedModelConfig,
  buildNewProviderConfig,
  findIdProblems,
  getImportableProviders,
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

describe('getImportableProviders', () => {
  it('keeps LLM providers whose API type lists models', () => {
    const ids = getImportableProviders([
      { id: 'openai' },
      { id: 'bedrock', category: 'llm' },
      { id: 'llmhub', category: 'llm', apiType: 'openai' },
      { id: 'brave', category: 'websearch' },
      { id: 'my-keys', category: 'custom' }
    ]).map(p => p.id);
    expect(ids).toEqual(['openai', 'llmhub']);
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
