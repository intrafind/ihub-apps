#!/usr/bin/env node

/**
 * Migration V150 specs — dictation moves from the `speech.realtime` vLLM
 * endpoint onto a transcription model: the endpoint lands on a model (reused or
 * written), every `vllm-realtime` choice points at it, groups that could
 * dictate — those reaching an app that streamed to it — keep the right to, and
 * only the connection limits stay behind. What it cannot read fails it before
 * anything is written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  up,
  precondition,
  version
} from '../migrations/V150__dictation_via_transcription_models.js';
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
      const suffix = pattern.replace(/\*/g, '');
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
      admins: { permissions: { apps: ['*'], models: ['*'] } },
      anonymous: { permissions: { apps: ['chat'], models: ['gemini-flash-latest'] } },
      authenticated: { inherits: ['anonymous'], permissions: { apps: ['*'], models: ['*'] } },
      // Grants nothing itself, but inherits a wildcard: needs nothing.
      'team-01': { inherits: ['authenticated'], permissions: { apps: [], models: [] } },
      // Inherits anonymous: gets the model through it, not on its own.
      guests: { inherits: ['anonymous'], permissions: { apps: [], models: [] } },
      // Reaches no app that dictated through the endpoint.
      reporting: { permissions: { apps: ['reports'], models: [] } },
      // Reaches the dictating app, with no model list at all.
      'meeting-team': { permissions: { apps: ['meeting'] } }
    }
  }
};

// Follows the platform default.
const chatApp = { 'apps/chat.json': { id: 'chat', settings: { speechRecognition: {} } } };

const dictatingApp = {
  'apps/meeting.json': {
    id: 'meeting',
    settings: { speechRecognition: { service: 'vllm-realtime' } }
  }
};

test('version matches the file name', () => {
  assert.equal(version, '150');
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
    ...chatApp,
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

  // Whoever could dictate in an app that followed the default still can; a
  // group with a wildcard or the inherited grant needs nothing, and one that
  // reaches no such app gets nothing.
  const { groups: after } = ctx.files['config/groups.json'];
  assert.deepEqual(after.anonymous.permissions.models, [
    'gemini-flash-latest',
    'voxtral-mini-realtime'
  ]);
  assert.deepEqual(after.guests.permissions.models, []);
  assert.deepEqual(after.admins.permissions.models, ['*']);
  assert.deepEqual(after['team-01'].permissions.models, []);
  assert.deepEqual(after.reporting.permissions.models, []);
  assert.equal(after['meeting-team'].permissions.models, undefined);
});

test('for one app, only the groups reaching that app get the model', async () => {
  const ctx = fakeCtx({
    ...platform(),
    ...voxtral(),
    ...chatApp,
    ...dictatingApp,
    ...groups
  });
  await up(ctx);
  const { groups: after } = ctx.files['config/groups.json'];
  // A missing model list is started, not skipped.
  assert.deepEqual(after['meeting-team'].permissions.models, ['voxtral-mini-realtime']);
  // Anonymous reaches only the chat app, which kept the browser.
  assert.deepEqual(after.anonymous.permissions.models, ['gemini-flash-latest']);
  assert.deepEqual(after.reporting.permissions.models, []);
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
    ...chatApp,
    'config/groups.json': {
      groups: {
        a: { inherits: ['b'], permissions: { apps: ['chat'], models: [] } },
        b: { inherits: ['a'], permissions: { apps: [], models: [] } }
      }
    }
  });
  await up(ctx);
  const { groups: after } = ctx.files['config/groups.json'];
  const granted = [after.a, after.b].filter(g =>
    g.permissions.models.includes('voxtral-mini-realtime')
  );
  // Both reach the app; one grant covers both, since each inherits the other.
  assert.equal(granted.length, 1);
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

test('without the shipped default to build on, it fails and changes nothing', async () => {
  const files = {
    ...platform({
      defaultService: 'vllm-realtime',
      realtime: { enabled: true, url: '', model: '' }
    }),
    ...dictatingApp
  };
  const before = JSON.parse(JSON.stringify(files));
  const ctx = fakeCtx(files, { defaults: {} });
  await assert.rejects(up(ctx), /Cannot read the shipped voxtral-mini-realtime model/);
  assert.deepEqual(ctx.files, before);
});

test('an unreadable app fails it before anything is written, to run again later', async () => {
  const files = {
    ...platform({ defaultService: 'vllm-realtime' }),
    ...voxtral({ enabled: false }),
    ...dictatingApp,
    'apps/broken.json': null
  };
  const before = JSON.parse(JSON.stringify(files));
  const ctx = fakeCtx(files);
  const readJson = ctx.readJson;
  ctx.readJson = async p => {
    if (p === 'apps/broken.json') throw new SyntaxError('Unexpected end of JSON input');
    return readJson(p);
  };
  await assert.rejects(up(ctx), /Cannot read apps\/broken\.json/);
  // The endpoint is still there for the next run.
  assert.deepEqual(ctx.files, before);
});
