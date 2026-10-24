// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Model endpoint discovery (admin "Import from URL"): the URL the admin pastes
 * is turned into the `/models` listing, the listing is called with or without
 * a key, and the answers of OpenAI, vLLM, Mistral, T-Systems LLM Hub,
 * Anthropic and Google are normalized into one entry shape.
 *
 * The fetch is injected, so nothing here touches the network.
 */
import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelsEndpoint,
  buildDiscoveryHeaders,
  buildInferenceUrl,
  buildSpeechTarget,
  parseModelsResponse,
  discoverModels,
  comparableUrl,
  stripTrailingSlashes,
  ModelDiscoveryError
} from '../services/ModelEndpointDiscovery.js';

/** Trimmed copy of a real T-Systems LLM Hub `/v2/models` answer. */
const LLM_HUB_BODY = {
  object: 'list',
  data: [
    {
      id: 'Mistral-Small-4-119B-2603',
      object: 'model',
      owned_by: 'T-Systems International',
      meta_data: {
        model_type: 'LLM',
        max_sequence_length: 262144,
        max_output_length: 128000,
        display_name: 'Mistral Small 4 119B Instruct',
        input_modalities: ['text', 'image'],
        end_of_life_date: null
      }
    },
    {
      id: 'Qwen3-VL-30B-A3B-Instruct-FP8',
      object: 'model',
      owned_by: 'T-Systems International',
      meta_data: {
        model_type: 'LLM',
        max_sequence_length: 128000,
        max_output_length: 128000,
        display_name: 'Qwen 3 VL 30B Instruct',
        input_modalities: ['text', ' image'],
        end_of_life_date: '2026-10-01T00:00:00Z'
      }
    },
    {
      id: 'text-embedding-bge-m3',
      object: 'model',
      owned_by: 'T-Systems International',
      meta_data: { model_type: 'EMBEDDING', max_sequence_length: 8192, max_output_length: 0 }
    }
  ]
};

function fakeResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => text
  };
}

function fakeFetch(response) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, calls };
}

test('resolveModelsEndpoint accepts the listing, the API base, an inference URL and a bare host', () => {
  const cases = [
    [
      'https://llm-server.llmhub.t-systems.net/v2/models',
      'https://llm-server.llmhub.t-systems.net/v2'
    ],
    ['https://llm-server.llmhub.t-systems.net/v2', 'https://llm-server.llmhub.t-systems.net/v2'],
    ['https://llm-server.llmhub.t-systems.net/v2/', 'https://llm-server.llmhub.t-systems.net/v2'],
    ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1'],
    ['http://localhost:8000', 'http://localhost:8000/v1'],
    ['http://10.0.0.5:8000/v1?foo=bar#x', 'http://10.0.0.5:8000/v1']
  ];
  for (const [input, base] of cases) {
    const { modelsUrl, baseUrl } = resolveModelsEndpoint(input, 'openai');
    assert.equal(baseUrl, base, input);
    assert.equal(modelsUrl, `${base}/models`, input);
  }
  assert.equal(
    resolveModelsEndpoint('https://api.anthropic.com/v1/messages', 'anthropic').modelsUrl,
    'https://api.anthropic.com/v1/models'
  );
  assert.equal(
    resolveModelsEndpoint(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent',
      'google'
    ).modelsUrl,
    'https://generativelanguage.googleapis.com/v1beta/models'
  );
  assert.equal(
    resolveModelsEndpoint('https://generativelanguage.googleapis.com', 'google').modelsUrl,
    'https://generativelanguage.googleapis.com/v1beta/models'
  );
});

test('resolveModelsEndpoint rejects non-http URLs and credentials in the URL', () => {
  for (const input of ['', 'not a url', 'ftp://host/v1', 'file:///etc/passwd']) {
    assert.throws(
      () => resolveModelsEndpoint(input, 'openai'),
      err =>
        err instanceof ModelDiscoveryError && err.messageKey === 'invalidUrl' && err.status === 400
    );
  }
  assert.throws(
    () => resolveModelsEndpoint('https://user:secret@host/v1', 'openai'),
    err => err.messageKey === 'credentialsInUrl'
  );
});

test('buildDiscoveryHeaders sends no credential without a key and the provider header with one', () => {
  assert.equal(buildDiscoveryHeaders('openai', '').Authorization, undefined);
  assert.equal(buildDiscoveryHeaders('openai', 'k').Authorization, 'Bearer k');
  assert.equal(buildDiscoveryHeaders('local', 'k').Authorization, 'Bearer k');
  const anthropic = buildDiscoveryHeaders('anthropic', 'k');
  assert.equal(anthropic['x-api-key'], 'k');
  assert.equal(anthropic.Authorization, undefined);
  assert.equal(anthropic['anthropic-version'], '2023-06-01');
  const google = buildDiscoveryHeaders('google', 'k');
  assert.equal(google['x-goog-api-key'], 'k');
  assert.equal(google.Authorization, undefined);
});

test('buildInferenceUrl picks the call each API type is made on', () => {
  const base = 'https://host/v1';
  assert.equal(buildInferenceUrl('openai', base, 'm'), 'https://host/v1/chat/completions');
  assert.equal(buildInferenceUrl('local', base, 'm'), 'https://host/v1/chat/completions');
  assert.equal(buildInferenceUrl('mistral', base, 'm'), 'https://host/v1/chat/completions');
  assert.equal(buildInferenceUrl('openai-responses', base, 'm'), 'https://host/v1/responses');
  assert.equal(buildInferenceUrl('anthropic', base, 'm'), 'https://host/v1/messages');
  assert.equal(
    buildInferenceUrl('google', 'https://g/v1beta', 'gemini-x'),
    'https://g/v1beta/models/gemini-x:streamGenerateContent'
  );
});

test('LLM Hub metadata: display name, context window, vision, type and end of life', () => {
  const [mistral, qwen, embedding] = parseModelsResponse(LLM_HUB_BODY);
  assert.equal(mistral.id, 'Mistral-Small-4-119B-2603');
  assert.equal(mistral.name, 'Mistral Small 4 119B Instruct');
  assert.equal(mistral.contextWindow, 262144);
  assert.equal(mistral.maxOutputTokens, 128000);
  assert.equal(mistral.supportsVision, true);
  assert.equal(mistral.type, 'chat');
  assert.equal(mistral.ownedBy, 'T-Systems International');

  // " image" (leading space) still counts; an output cap as large as the
  // window is dropped so iHub's default applies.
  assert.equal(qwen.supportsVision, true);
  assert.equal(qwen.maxOutputTokens, null);
  assert.equal(qwen.endOfLife, '2026-10-01T00:00:00Z');

  assert.equal(embedding.type, 'embedding');
  assert.equal(embedding.maxOutputTokens, null);
});

test('vLLM, Mistral, Anthropic and Google listings are normalized', () => {
  const [vllm] = parseModelsResponse({
    object: 'list',
    data: [{ id: 'Qwen/Qwen3-8B', owned_by: 'vllm', max_model_len: 32768 }]
  });
  assert.equal(vllm.contextWindow, 32768);
  assert.equal(vllm.type, 'chat');
  assert.equal(vllm.supportsVision, null);

  const mistral = parseModelsResponse({
    data: [
      {
        id: 'mistral-large-latest',
        name: 'mistral-large-latest',
        description: 'Flagship',
        max_context_length: 131072,
        type: 'base',
        capabilities: { completion_chat: true, function_calling: true, vision: true }
      },
      {
        id: 'mistral-embed',
        max_context_length: 8192,
        type: 'base',
        capabilities: { completion_chat: false, function_calling: false }
      }
    ]
  });
  const large = mistral.find(m => m.id === 'mistral-large-latest');
  assert.equal(large.supportsTools, true);
  assert.equal(large.supportsVision, true);
  assert.equal(large.description, 'Flagship');
  assert.equal(mistral.find(m => m.id === 'mistral-embed').type, 'embedding');

  const [claude] = parseModelsResponse({
    data: [{ type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }],
    has_more: false
  });
  assert.equal(claude.name, 'Claude Sonnet 5');
  assert.equal(claude.type, 'chat');

  const google = parseModelsResponse({
    models: [
      {
        name: 'models/gemini-3.1-pro-preview',
        displayName: 'Gemini 3.1 Pro',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent', 'countTokens']
      },
      {
        name: 'models/text-embedding-004',
        supportedGenerationMethods: ['embedContent']
      }
    ]
  });
  const pro = google.find(m => m.id === 'gemini-3.1-pro-preview');
  assert.equal(pro.name, 'Gemini 3.1 Pro');
  assert.equal(pro.contextWindow, 1048576);
  assert.equal(pro.maxOutputTokens, 65536);
  const embed = google.find(m => m.id === 'text-embedding-004');
  assert.equal(embed.type, 'embedding');
  assert.equal(embed.name, 'text-embedding-004');
});

test('OpenAI ids without metadata are typed by name; duplicates and id-less entries are dropped', () => {
  const models = parseModelsResponse({
    data: [
      { id: 'gpt-5' },
      { id: 'text-embedding-3-small' },
      { id: 'whisper-1' },
      { id: 'gpt-4o-transcribe' },
      { id: 'gpt-4o-mini-tts' },
      { id: 'dall-e-3' },
      { id: 'omni-moderation-latest' },
      { id: 'gpt-5' },
      { object: 'model' }
    ]
  });
  const types = Object.fromEntries(models.map(m => [m.id, m.type]));
  assert.deepEqual(types, {
    'dall-e-3': 'image',
    'gpt-4o-mini-tts': 'tts',
    'gpt-4o-transcribe': 'transcription',
    'gpt-5': 'chat',
    'omni-moderation-latest': 'moderation',
    'text-embedding-3-small': 'embedding',
    'whisper-1': 'transcription'
  });
});

test('a speech-to-text model is a transcription model, called on the audio API', async () => {
  const body = {
    data: [
      ...LLM_HUB_BODY.data,
      {
        id: 'whisper-large-v3-turbo',
        object: 'model',
        owned_by: 'T-Systems International',
        meta_data: { model_type: 'STT', display_name: 'Whisper Large v3 Turbo' }
      }
    ]
  };
  const { fetch } = fakeFetch(fakeResponse(200, body));
  const { models } = await discoverModels(
    { url: 'https://llm-server.llmhub.t-systems.net/v2', provider: 'openai', apiKey: 'k' },
    { fetch }
  );
  const whisper = models.find(m => m.id === 'whisper-large-v3-turbo');
  assert.equal(whisper.type, 'transcription');
  assert.equal(whisper.url, 'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions');
  assert.equal(whisper.modelType, 'transcription');
  assert.equal(whisper.backend, 'openai');
  // Other types keep their chat URL.
  const embed = models.find(m => m.id === 'text-embedding-bge-m3');
  assert.equal(embed.url, 'https://llm-server.llmhub.t-systems.net/v2/chat/completions');
});

/** The model configs iHub ships as examples, which an import must reproduce. */
const exampleModel = async file =>
  JSON.parse(await fs.readFile(new URL(`../../examples/models/${file}`, import.meta.url), 'utf8'));

test('Google speech models are imported for the backend that runs them', async () => {
  const body = {
    models: [
      {
        name: 'models/gemini-3.5-transcribe',
        displayName: 'Gemini 3.5 Transcribe',
        inputTokenLimit: 98304,
        supportedGenerationMethods: ['generateContent', 'countTokens']
      },
      {
        name: 'models/gemini-3.5-transcribe-live',
        displayName: 'Gemini 3.5 Transcribe Live',
        inputTokenLimit: 131072,
        supportedGenerationMethods: ['bidiGenerateContent']
      },
      {
        name: 'models/gemini-3.8-flash-tts',
        displayName: 'Gemini 3.8 Flash TTS',
        supportedGenerationMethods: ['generateContent', 'countTokens']
      },
      {
        name: 'models/gemini-3.8-flash-native-audio',
        supportedGenerationMethods: ['bidiGenerateContent']
      },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }
    ]
  };
  const { fetch } = fakeFetch(fakeResponse(200, body));
  const { models } = await discoverModels(
    { url: 'https://generativelanguage.googleapis.com/v1beta', provider: 'google', apiKey: 'k' },
    { fetch }
  );
  const byId = Object.fromEntries(models.map(m => [m.id, m]));

  // Same backend and URL as the shipped examples, so a model already set up
  // from one of them shows as "Already added".
  for (const [id, type] of [
    ['gemini-3.5-transcribe', 'transcription'],
    ['gemini-3.5-transcribe-live', 'transcription'],
    ['gemini-3.8-flash-tts', 'tts']
  ]) {
    const example = await exampleModel(`google/${id}.json`);
    assert.equal(byId[id].type, type, id);
    assert.equal(byId[id].modelType, example.modelType, id);
    assert.equal(byId[id].backend, example.provider, id);
    assert.equal(byId[id].url, example.url, id);
  }
  assert.equal(byId['gemini-3.5-transcribe-live'].backend, 'google-live');
  assert.equal(byId['gemini-3.5-transcribe'].backend, 'google-transcribe');

  // A Live API model that is not a transcription model stays an audio model.
  assert.equal(byId['gemini-3.8-flash-native-audio'].type, 'audio');
  assert.equal(byId['gemini-3.8-flash-native-audio'].modelType, undefined);
  assert.equal(byId['gemini-3.8-flash'].type, 'chat');
  assert.equal(byId['gemini-3.8-flash'].modelType, undefined);
});

test('Mistral realtime transcription and text-to-speech are imported; batch transcription is not supported', async () => {
  const notChat = { completion_chat: false, function_calling: false, vision: false };
  const body = {
    data: [
      { id: 'voxtral-mini-transcribe-realtime-2602', capabilities: notChat },
      { id: 'voxtral-mini-tts-2603', capabilities: notChat },
      { id: 'voxtral-mini-transcribe-2507', capabilities: notChat },
      { id: 'mistral-small-latest', capabilities: { completion_chat: true } }
    ]
  };
  const { fetch } = fakeFetch(fakeResponse(200, body));
  const { models } = await discoverModels(
    { url: 'https://api.mistral.ai/v1', provider: 'mistral', apiKey: 'k' },
    { fetch }
  );
  const byId = Object.fromEntries(models.map(m => [m.id, m]));

  const realtime = await exampleModel('mistral/voxtral-mini-transcribe-realtime.json');
  assert.equal(byId['voxtral-mini-transcribe-realtime-2602'].modelType, 'transcription');
  assert.equal(byId['voxtral-mini-transcribe-realtime-2602'].backend, realtime.provider);
  assert.equal(byId['voxtral-mini-transcribe-realtime-2602'].url, realtime.url);

  const tts = await exampleModel('mistral/voxtral-mini-tts.json');
  assert.equal(byId['voxtral-mini-tts-2603'].type, 'tts');
  assert.equal(byId['voxtral-mini-tts-2603'].modelType, 'tts');
  assert.equal(byId['voxtral-mini-tts-2603'].backend, tts.provider);
  assert.equal(byId['voxtral-mini-tts-2603'].url, tts.url);

  // iHub runs Mistral transcription over the realtime API only.
  assert.equal(byId['voxtral-mini-transcribe-2507'].type, 'transcription');
  assert.equal(byId['voxtral-mini-transcribe-2507'].unsupported, true);
  assert.equal(byId['voxtral-mini-transcribe-2507'].modelType, undefined);
  assert.equal(byId['mistral-small-latest'].unsupported, undefined);
});

test('buildSpeechTarget follows the host and scheme of the endpoint', () => {
  assert.deepEqual(
    buildSpeechTarget('google', 'https://gemini-proxy.example/v1alpha', {
      id: 'gemini-x-transcribe-live',
      type: 'transcription',
      realtime: true
    }),
    {
      modelType: 'transcription',
      backend: 'google-live',
      url: 'wss://gemini-proxy.example/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'
    }
  );
  // A gateway's path prefix stays (Cloudflare AI Gateway: …/google-ai-studio/v1beta).
  const gateway = 'https://gateway.example/v1/acct/gw/google-ai-studio/v1beta';
  assert.equal(
    buildSpeechTarget('google', gateway, { id: 'gemini-x-transcribe', type: 'transcription' }).url,
    'https://gateway.example/v1/acct/gw/google-ai-studio'
  );
  assert.equal(
    buildSpeechTarget('google', gateway, {
      id: 'gemini-x-transcribe-live',
      type: 'transcription',
      realtime: true
    }).url,
    'wss://gateway.example/v1/acct/gw/google-ai-studio/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
  );
  assert.equal(
    buildSpeechTarget('mistral', 'http://voxtral.local:8000/v1', {
      id: 'voxtral-realtime',
      type: 'transcription',
      realtime: true
    }).url,
    'ws://voxtral.local:8000/v1/audio/transcriptions/realtime'
  );
  // No backend for OpenAI text-to-speech or Anthropic speech.
  assert.equal(
    buildSpeechTarget('openai', 'https://api.openai.com/v1', { id: 'tts-1', type: 'tts' }),
    null
  );
  assert.equal(
    buildSpeechTarget('google', 'https://g/v1beta', { id: 'gemini', type: 'chat' }),
    null
  );
});

test('only the OpenAI API types call a transcription model on the audio API', () => {
  assert.equal(
    buildInferenceUrl('local', 'http://gpu:8000/v1', 'whisper', 'transcription'),
    'http://gpu:8000/v1/audio/transcriptions'
  );
  assert.equal(
    buildInferenceUrl('mistral', 'https://api.mistral.ai/v1', 'voxtral-mini', 'transcription'),
    'https://api.mistral.ai/v1/chat/completions'
  );
});

test('a body that is not a model listing is rejected', () => {
  assert.throws(
    () => parseModelsResponse({ error: 'nope' }),
    err => err.messageKey === 'invalidResponse'
  );
});

test('discoverModels sends the key, does not follow redirects, and adds the inference URL', async () => {
  const { fetch, calls } = fakeFetch(fakeResponse(200, LLM_HUB_BODY));
  const result = await discoverModels(
    { url: 'https://llm-server.llmhub.t-systems.net/v2', provider: 'openai', apiKey: ' gen-key ' },
    { fetch }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://llm-server.llmhub.t-systems.net/v2/models');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gen-key');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.size, 10 * 1024 * 1024);
  assert.equal(result.models.length, 3);
  assert.equal(result.models[0].url, 'https://llm-server.llmhub.t-systems.net/v2/chat/completions');
});

test('discoverModels without a key sends no Authorization header', async () => {
  const { fetch, calls } = fakeFetch(fakeResponse(200, { data: [{ id: 'm' }] }));
  await discoverModels({ url: 'http://localhost:8000/v1', provider: 'local' }, { fetch });
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('discoverModels maps endpoint failures onto messageKeys', async () => {
  const cases = [
    [fakeResponse(401, ''), '', 'apiKeyRequired'],
    [fakeResponse(403, ''), '', 'apiKeyRequired'],
    [fakeResponse(401, ''), 'k', 'authenticationFailed'],
    [fakeResponse(403, ''), 'k', 'accessDenied'],
    [fakeResponse(404, ''), 'k', 'notFound'],
    [fakeResponse(500, ''), 'k', 'upstreamError'],
    [fakeResponse(301, '', { location: 'https://elsewhere/v1/models' }), 'k', 'redirected'],
    [fakeResponse(200, '<html>login</html>'), 'k', 'invalidResponse'],
    [
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      'k',
      'connectionRefused'
    ],
    [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'k', 'hostNotFound'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'k', 'timeout']
  ];
  for (const [response, apiKey, messageKey] of cases) {
    const { fetch } = fakeFetch(response);
    await assert.rejects(
      discoverModels({ url: 'https://host/v1', provider: 'openai', apiKey }, { fetch }),
      err =>
        err instanceof ModelDiscoveryError && err.messageKey === messageKey && err.status === 502,
      messageKey
    );
  }
});

test('Google answering a wrong key with HTTP 400 API_KEY_INVALID reads as a rejected key', async () => {
  const body = {
    error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }
  };
  const { fetch } = fakeFetch(fakeResponse(400, body));
  await assert.rejects(
    discoverModels({ url: 'https://g/v1beta', provider: 'google', apiKey: 'bad' }, { fetch }),
    err => err.messageKey === 'authenticationFailed' && err.upstreamStatus === 400
  );
  const other = fakeFetch(fakeResponse(400, { error: { message: 'Bad page size' } }));
  await assert.rejects(
    discoverModels(
      { url: 'https://g/v1beta', provider: 'google', apiKey: 'k' },
      { fetch: other.fetch }
    ),
    err => err.messageKey === 'upstreamError'
  );
});

test('the base URLs shipped on the built-in providers list models and build working inference URLs', async () => {
  const { providers } = JSON.parse(
    await fs.readFile(new URL('../defaults/config/providers.json', import.meta.url), 'utf8')
  );
  const baseUrlOf = id => providers.find(p => p.id === id).baseUrl;
  const cases = [
    {
      provider: 'openai',
      listing: 'https://api.openai.com/v1/models',
      header: ['Authorization', 'Bearer k'],
      body: { data: [{ id: 'gpt-x' }] },
      url: 'https://api.openai.com/v1/chat/completions'
    },
    {
      provider: 'anthropic',
      listing: 'https://api.anthropic.com/v1/models?limit=1000',
      header: ['x-api-key', 'k'],
      body: { data: [{ id: 'claude-x', display_name: 'Claude X' }] },
      url: 'https://api.anthropic.com/v1/messages'
    },
    {
      provider: 'google',
      listing: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      header: ['x-goog-api-key', 'k'],
      body: {
        models: [{ name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] }]
      },
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent'
    },
    {
      provider: 'mistral',
      listing: 'https://api.mistral.ai/v1/models',
      header: ['Authorization', 'Bearer k'],
      body: { data: [{ id: 'mistral-x' }] },
      url: 'https://api.mistral.ai/v1/chat/completions'
    }
  ];
  for (const c of cases) {
    const { fetch, calls } = fakeFetch(fakeResponse(200, c.body));
    const result = await discoverModels(
      { url: baseUrlOf(c.provider), provider: c.provider, apiKey: 'k' },
      { fetch }
    );
    assert.equal(calls[0].url, c.listing, c.provider);
    assert.equal(calls[0].init.headers[c.header[0]], c.header[1], c.provider);
    assert.equal(result.models[0].url, c.url, c.provider);
  }
});

test('discoverModels rejects an API type it cannot list', async () => {
  await assert.rejects(
    discoverModels({ url: 'https://host/v1', provider: 'bedrock' }, { fetch: async () => null }),
    err => err.messageKey === 'unsupportedProvider' && err.status === 400
  );
});

test('comparableUrl ignores case of the origin and trailing slashes, but not of the path', () => {
  assert.equal(
    comparableUrl('https://LLM-Server.example.com/v2/chat/completions/'),
    comparableUrl('https://llm-server.example.com/v2/chat/completions')
  );
  assert.notEqual(
    comparableUrl('https://host/v1/Foo/chat/completions'),
    comparableUrl('https://host/v1/foo/chat/completions')
  );
});

test('trailing slashes are stripped in linear time, also from a long run of them', () => {
  assert.equal(stripTrailingSlashes('https://host/v1///'), 'https://host/v1');
  assert.equal(stripTrailingSlashes('///'), '');
  const started = Date.now();
  const slashes = '/'.repeat(200000);
  assert.equal(
    resolveModelsEndpoint(`https://host/v1${slashes}`, 'openai').baseUrl,
    'https://host/v1'
  );
  assert.equal(comparableUrl(`https://host/v1${slashes}x`), `https://host/v1${slashes}x`);
  assert.ok(Date.now() - started < 1000, 'no quadratic backtracking');
});

test('a body cut off at the size limit is reported as too large', async () => {
  const tooLarge = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => {
      throw Object.assign(new Error('content size over limit'), { type: 'max-size' });
    }
  };
  const { fetch } = fakeFetch(tooLarge);
  await assert.rejects(
    discoverModels({ url: 'https://host/v1', provider: 'openai' }, { fetch }),
    err => err.messageKey === 'invalidResponse' && /too large/.test(err.message)
  );
});

test('OpenRouter: output modalities tell image and audio generators from chat models', () => {
  const models = parseModelsResponse({
    data: [
      {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Anthropic: Claude Sonnet 4.5',
        context_length: 200000,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        supported_parameters: ['tools', 'temperature'],
        top_provider: { max_completion_tokens: 64000 }
      },
      {
        id: 'black-forest-labs/flux-pro',
        name: 'Flux Pro',
        architecture: { input_modalities: ['text'], output_modalities: ['image'] }
      },
      {
        id: 'vendor/speaker',
        architecture: { input_modalities: ['text'], output_modalities: ['audio'] }
      }
    ]
  });
  const byId = Object.fromEntries(models.map(m => [m.id, m]));
  assert.equal(byId['anthropic/claude-sonnet-4.5'].type, 'chat');
  assert.equal(byId['anthropic/claude-sonnet-4.5'].supportsVision, true);
  assert.equal(byId['anthropic/claude-sonnet-4.5'].supportsTools, true);
  assert.equal(byId['anthropic/claude-sonnet-4.5'].maxOutputTokens, 64000);
  assert.equal(byId['black-forest-labs/flux-pro'].type, 'image');
  assert.equal(byId['vendor/speaker'].type, 'audio');
});
