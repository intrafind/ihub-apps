#!/usr/bin/env node

/**
 * Migration V146 specs — dictation moves from the `speech.realtime` vLLM
 * endpoint onto a transcription model: the endpoint lands on a model (reused or
 * written), every `vllm-realtime` choice points at it, groups that could
 * dictate keep the right to, and only the connection limits stay behind.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  up,
  precondition,
  version
} from '../migrations/V146__dictation_via_transcription_models.js';
import { setDefault } from '../migrations/utils.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';

const shippedModel = JSON.parse(
  fs.readFileSync(new URL('../defaults/models/voxtral-mini-realtime.json', import.meta.url), 'utf8')
);
const ENDPOINT = 'ws://gpu-box:8000/v1/realtime';
const ENC_KEY = 'ENC[v1:abc]';

function fakeCtx(files, { defaults = { 'models/voxtral-mini-realtime.json': shippedModel } } = {}) {
  const logs = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    files,
    logs,
    fileExists: async p => p in files || Object.keys(files).some(name => name.startsWith(`${p}/`)),
    listFiles: async (dir, pattern) => {
      const suffix = pattern.replace('*', '');
      return Object.keys(files)
        .filter(name => name.startsWith(`${dir}/`) && name.endsWith(suffix))
        .map(name => name.slice(dir.length + 1))
        .filter(name => !name.includes('/'));
    },
    readJson: async p => clone(files[p]),
    readDefaultJson: async p => {
      if (!(p in defaults)) throw new Error(`missing default ${p}`);
      return clone(defaults[p]);
    },
    writeJson: async (p, data) => {
      files[p] = clone(data);
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const platform = (speech = {}) => ({
  'config/platform.json': {
    speech: {
      defaultService: 'browser',
      transcription: { defaultModelId: '' },
      realtime: {
        enabled: true,
        url: ENDPOINT,
        model: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
        apiKey: ENC_KEY
      },
      ...speech
    }
  }
});

const voxtral = overrides => ({
  'models/voxtral-mini-realtime.json': {
    ...shippedModel,
    url: ENDPOINT,
    modelId: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
    ...overrides
  }
});

const groups = {
  'config/groups.json': {
    groups: {
      admins: { permissions: { models: ['*'] } },
      anonymous: { permissions: { models: ['gemini-flash-latest'] } },
      authenticated: { inherits: ['anonymous'], permissions: { models: ['*'] } },
      // Grants nothing itself, but inherits a wildcard: needs nothing.
      'team-01': { inherits: ['authenticated'], permissions: { models: [] } },
      // Inherits only what anonymous has: needs the model too.
      guests: { inherits: ['anonymous'], permissions: { models: [] } }
    }
  }
};

const dictatingApp = {
  'apps/meeting.json': {
    id: 'meeting',
    settings: { speechRecognition: { service: 'vllm-realtime' } }
  }
};

test('version matches the file name', () => {
  assert.equal(version, '146');
});

test('precondition requires platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('a fresh install drops the unused endpoint and writes no model', async () => {
  const ctx = fakeCtx({
    ...platform({
      realtime: { enabled: false, url: 'ws://localhost:8080/v1/realtime', model: 'm', apiKey: '' }
    }),
    ...groups
  });
  await up(ctx);

  const { speech } = ctx.files['config/platform.json'];
  assert.equal(speech.realtime, undefined);
  assert.deepEqual(speech.dictation, { modelId: '' });
  assert.equal(speech.defaultService, 'browser');
  assert.equal(
    Object.keys(ctx.files).some(name => name.startsWith('models/')),
    false
  );
  assert.deepEqual(ctx.files['config/groups.json'], groups['config/groups.json']);
  assert.equal(platformConfigSchema.safeParse(ctx.files['config/platform.json']).success, true);
});

test('the platform default moves to the model already on the endpoint, enabled', async () => {
  const ctx = fakeCtx({
    ...platform({ defaultService: 'vllm-realtime' }),
    ...voxtral({ enabled: false }),
    ...groups
  });
  await up(ctx);

  const { speech } = ctx.files['config/platform.json'];
  assert.equal(speech.defaultService, 'model');
  assert.deepEqual(speech.dictation, { modelId: 'voxtral-mini-realtime' });
  assert.equal(speech.realtime, undefined);
  assert.equal(ctx.files['models/voxtral-mini-realtime.json'].enabled, true);
  // The model had no key of its own; the endpoint's (still encrypted) moves over.
  assert.equal(ctx.files['models/voxtral-mini-realtime.json'].apiKey, ENC_KEY);
  assert.equal(platformConfigSchema.safeParse(ctx.files['config/platform.json']).success, true);

  // Whoever could dictate still can; a group with a wildcard, its own or
  // inherited, needs nothing.
  const { groups: after } = ctx.files['config/groups.json'];
  assert.deepEqual(after.anonymous.permissions.models, [
    'gemini-flash-latest',
    'voxtral-mini-realtime'
  ]);
  assert.deepEqual(after.guests.permissions.models, ['voxtral-mini-realtime']);
  assert.deepEqual(after.admins.permissions.models, ['*']);
  assert.deepEqual(after['team-01'].permissions.models, []);
});

test('an app moves to a new model when the shipped one points elsewhere', async () => {
  const ctx = fakeCtx({
    ...platform(),
    ...voxtral({ url: 'ws://other:9000/v1/realtime' }),
    ...dictatingApp
  });
  await up(ctx);

  const model = ctx.files['models/voxtral-mini-realtime-dictation.json'];
  assert.equal(model.id, 'voxtral-mini-realtime-dictation');
  assert.equal(model.url, ENDPOINT);
  assert.equal(model.modelId, 'mistralai/Voxtral-Mini-4B-Realtime-2602');
  assert.equal(model.apiKey, ENC_KEY);
  assert.equal(model.enabled, true);
  assert.equal(model.provider, 'vllm-realtime');
  assert.equal(model.modelType, 'transcription');
  // The admin's own model is untouched.
  assert.equal(ctx.files['models/voxtral-mini-realtime.json'].url, 'ws://other:9000/v1/realtime');

  assert.deepEqual(ctx.files['apps/meeting.json'].settings.speechRecognition, {
    service: 'model',
    modelId: 'voxtral-mini-realtime-dictation'
  });
  // The platform default was the browser and stays so.
  assert.equal(ctx.files['config/platform.json'].speech.defaultService, 'browser');
});

test('without any Voxtral model file, the shipped one is written with the endpoint', async () => {
  const ctx = fakeCtx(platform({ defaultService: 'vllm-realtime' }));
  await up(ctx);

  const model = ctx.files['models/voxtral-mini-realtime.json'];
  assert.equal(model.id, 'voxtral-mini-realtime');
  assert.equal(model.url, ENDPOINT);
  assert.equal(model.apiKey, ENC_KEY);
  assert.equal(model.enabled, true);
  assert.equal(ctx.files['config/platform.json'].speech.dictation.modelId, 'voxtral-mini-realtime');
});

test('a reused model keeps a key of its own', async () => {
  const ctx = fakeCtx({
    ...platform({ defaultService: 'vllm-realtime' }),
    ...voxtral({ apiKey: 'ENC[v1:model-own]' })
  });
  await up(ctx);
  assert.equal(ctx.files['models/voxtral-mini-realtime.json'].apiKey, 'ENC[v1:model-own]');
});

test('a switched-off endpoint still moves, but stays off and grants nothing', async () => {
  const ctx = fakeCtx({
    ...platform({
      defaultService: 'vllm-realtime',
      realtime: { enabled: false, url: ENDPOINT, model: 'mistralai/Voxtral-Mini-4B-Realtime-2602' }
    }),
    ...voxtral({ enabled: false }),
    ...groups
  });
  await up(ctx);

  assert.equal(ctx.files['models/voxtral-mini-realtime.json'].enabled, false);
  assert.equal(ctx.files['config/platform.json'].speech.defaultService, 'model');
  assert.deepEqual(ctx.files['config/groups.json'], groups['config/groups.json']);
});

test('connection limits stay under speech.realtime', async () => {
  const ctx = fakeCtx(
    platform({
      realtime: {
        enabled: false,
        url: '',
        model: '',
        apiKey: '',
        maxConnections: 10,
        maxSessionSeconds: 600
      }
    })
  );
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].speech.realtime, {
    maxConnections: 10,
    maxSessionSeconds: 600
  });
});

test('an inheritance cycle does not hang the grant', async () => {
  const ctx = fakeCtx({
    ...platform({ defaultService: 'vllm-realtime' }),
    ...voxtral(),
    'config/groups.json': {
      groups: {
        a: { inherits: ['b'], permissions: { models: [] } },
        b: { inherits: ['a'], permissions: { models: [] } }
      }
    }
  });
  await up(ctx);
  const { groups: after } = ctx.files['config/groups.json'];
  assert.deepEqual(after.a.permissions.models, ['voxtral-mini-realtime']);
  assert.deepEqual(after.b.permissions.models, ['voxtral-mini-realtime']);
});

test('a second run changes nothing', async () => {
  const ctx = fakeCtx({
    ...platform({ defaultService: 'vllm-realtime' }),
    ...voxtral({ url: 'ws://other:9000/v1/realtime' }),
    ...dictatingApp,
    ...groups
  });
  await up(ctx);
  const once = JSON.parse(JSON.stringify(ctx.files));
  await up(ctx);
  assert.deepEqual(ctx.files, once);
});

test('a half-finished run resumes on the same model', async () => {
  // The model was written, platform.json was not: the endpoint finds it again.
  const ctx = fakeCtx({
    ...platform({ defaultService: 'vllm-realtime' }),
    ...voxtral({ url: 'ws://other:9000/v1/realtime' }),
    'models/voxtral-mini-realtime-dictation.json': {
      ...shippedModel,
      id: 'voxtral-mini-realtime-dictation',
      url: ENDPOINT,
      modelId: 'mistralai/Voxtral-Mini-4B-Realtime-2602'
    }
  });
  await up(ctx);
  assert.equal(
    ctx.files['config/platform.json'].speech.dictation.modelId,
    'voxtral-mini-realtime-dictation'
  );
  assert.equal(ctx.files['models/voxtral-mini-realtime-dictation-2.json'], undefined);
});

test('without the shipped default to build on, choices fall back to the browser', async () => {
  const ctx = fakeCtx(
    {
      ...platform({
        defaultService: 'vllm-realtime',
        realtime: { enabled: true, url: '', model: '' }
      }),
      ...dictatingApp
    },
    { defaults: {} }
  );
  await up(ctx);
  assert.equal(ctx.files['config/platform.json'].speech.defaultService, 'browser');
  assert.equal(ctx.files['apps/meeting.json'].settings.speechRecognition.service, 'default');
});
