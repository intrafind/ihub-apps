#!/usr/bin/env node

/**
 * Migration V163 specs — `supportsTools` becomes none / auto / required.
 *
 * Exercised through a fake migration context so the real contents/ is never
 * touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V163__tool_support_levels.js';

/** In-memory migration context mirroring the ctx surface V163 uses. */
function fakeCtx(files) {
  const logs = [];
  const warnings = [];
  const dirOf = path => path.slice(0, path.indexOf('/'));
  return {
    files,
    logs,
    warnings,
    fileExists: async p =>
      Object.prototype.hasOwnProperty.call(files, p) ||
      Object.keys(files).some(name => dirOf(name) === p),
    listFiles: async directory =>
      Object.keys(files)
        .filter(name => dirOf(name) === directory)
        .map(name => name.slice(directory.length + 1)),
    readJson: async p => {
      if (files[p] instanceof Error) throw files[p];
      return structuredClone(files[p]);
    },
    writeJson: async (p, data) => {
      files[p] = data;
    },
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

const HOSTED_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  'openai-responses': 'https://api.openai.com/v1/responses',
  mistral: 'https://api.mistral.ai/v1/chat/completions'
};

const model = (provider, supportsTools, extra = {}) => ({
  id: `${provider}-model`,
  modelId: `${provider}-upstream`,
  provider,
  url: HOSTED_URLS[provider] || `https://${provider}.example.com/v1`,
  supportsTools,
  ...extra
});

test('version is the next unused number', () => {
  assert.equal(version, '163');
});

test('false becomes none, whatever the provider', async () => {
  const ctx = fakeCtx({
    'models/a.json': model('openai', false),
    'models/b.json': model('local', false)
  });

  assert.equal(await precondition(ctx), true);
  await up(ctx);

  assert.equal(ctx.files['models/a.json'].supportsTools, 'none');
  assert.equal(ctx.files['models/b.json'].supportsTools, 'none');
});

test('true becomes required where the endpoint is a hosted API that takes a forced tool choice, auto elsewhere', async () => {
  const ctx = fakeCtx({
    'models/openai.json': model('openai', true),
    'models/responses.json': model('openai-responses', true),
    'models/mistral.json': model('mistral', true),
    'models/google.json': model('google', true, { modelId: 'gemini-3.1-pro' }),
    'models/google-image.json': model('google', true, { modelId: 'gemini-3-pro-image' }),
    'models/claude.json': model('anthropic', true),
    'models/vllm.json': model('vllm', true),
    'models/local.json': model('local', true),
    'models/azure.json': model('openai', true, {
      url: 'https://my-resource.openai.azure.com/openai/deployments/gpt-4.1/chat/completions'
    }),
    // vLLM is a `local` model; a gateway or LM Studio may be an `openai` one with its own URL.
    'models/vllm-local.json': model('local', true, {
      url: 'http://vllm.internal:8000/v1/chat/completions'
    }),
    'models/gateway-openai.json': model('openai', true, {
      url: 'http://gateway.internal:8000/v1/chat/completions'
    }),
    'models/lmstudio.json': model('openai', true, {
      url: 'http://localhost:1234/v1/chat/completions'
    }),
    'models/proxy-responses.json': model('openai-responses', true, {
      url: 'https://gateway.example.com/v1/responses'
    }),
    'models/mistral-self-hosted.json': model('mistral', true, {
      url: 'http://mistral.internal/v1/chat/completions'
    }),
    'models/no-url.json': model('openai', true, { url: undefined }),
    'models/bad-url.json': model('openai', true, { url: 'not a url' }),
    'models/bedrock-claude.json': model('bedrock', true, {
      modelId: 'eu.anthropic.claude-sonnet-4-6-v1:0'
    }),
    'models/bedrock-nova.json': model('bedrock', true, { modelId: 'amazon.nova-pro-v1:0' }),
    'models/bedrock-llama.json': model('bedrock', true, { modelId: 'meta.llama3-3-70b' })
  });

  await up(ctx);

  const levels = Object.fromEntries(
    Object.entries(ctx.files).map(([path, data]) => [path.slice(7, -5), data.supportsTools])
  );
  assert.deepEqual(levels, {
    openai: 'required',
    responses: 'required',
    mistral: 'required',
    google: 'required',
    'google-image': 'auto',
    claude: 'auto',
    vllm: 'auto',
    local: 'auto',
    azure: 'required',
    'vllm-local': 'auto',
    'gateway-openai': 'auto',
    lmstudio: 'auto',
    'proxy-responses': 'auto',
    'mistral-self-hosted': 'auto',
    'no-url': 'auto',
    'bad-url': 'auto',
    'bedrock-claude': 'required',
    'bedrock-nova': 'required',
    'bedrock-llama': 'auto'
  });
  assert.match(ctx.logs[0], /19 model\(s\)/);
});

test('the rest of a model file is left as it was', async () => {
  const original = model('openai', true, { enabled: true, contextWindow: 128000 });
  const ctx = fakeCtx({ 'models/a.json': original });

  await up(ctx);

  assert.deepEqual(ctx.files['models/a.json'], { ...original, supportsTools: 'required' });
});

test('an app filter on supportsTools keeps matching the models it matched', async () => {
  const ctx = fakeCtx({
    'apps/with.json': {
      id: 'with',
      settings: { model: { enabled: true, filter: { supportsTools: true, supportsVision: true } } }
    },
    'apps/without.json': {
      id: 'without',
      settings: { model: { filter: { supportsTools: false } } }
    }
  });

  assert.equal(await precondition(ctx), true);
  await up(ctx);

  assert.deepEqual(ctx.files['apps/with.json'].settings.model, {
    enabled: true,
    filter: { supportsTools: ['auto', 'required'], supportsVision: true }
  });
  assert.deepEqual(ctx.files['apps/without.json'].settings.model.filter, {
    supportsTools: 'none'
  });
  assert.match(ctx.logs[0], /2 app model filter\(s\)/);
});

test('apps with other filters or none are not touched', async () => {
  const ctx = fakeCtx({
    'apps/image.json': {
      id: 'image',
      settings: { model: { filter: { supportsImageGeneration: true } } }
    },
    'apps/plain.json': { id: 'plain' }
  });

  assert.equal(await precondition(ctx), false);
});

test('is skipped when nothing carries a boolean (fresh install or already migrated)', async () => {
  const ctx = fakeCtx({
    'models/a.json': model('openai', 'required'),
    'models/b.json': { id: 'b', provider: 'openai' },
    'apps/a.json': {
      id: 'a',
      settings: { model: { filter: { supportsTools: ['auto', 'required'] } } }
    }
  });

  assert.equal(await precondition(ctx), false);
});

test('runs twice without changing the result', async () => {
  const ctx = fakeCtx({ 'models/a.json': model('openai', true) });

  await up(ctx);
  assert.equal(await precondition(ctx), false);
  await up(ctx);

  assert.equal(ctx.files['models/a.json'].supportsTools, 'required');
});

test('a file that cannot be read is skipped, not fatal', async () => {
  const ctx = fakeCtx({
    'models/broken.json': new Error('Unexpected token'),
    'models/ok.json': model('openai', true)
  });

  await up(ctx);

  assert.equal(ctx.files['models/ok.json'].supportsTools, 'required');
  assert.ok(ctx.files['models/broken.json'] instanceof Error);
  assert.match(ctx.warnings[0], /models\/broken\.json/);
});

test('a missing models or apps directory is fine', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
});
