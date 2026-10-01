/**
 * Requests without a token are checked against the anonymous principal.
 *
 * With `anonymousAuth.enabled`, setupMiddleware gives every tokenless request
 * the anonymous principal (id `anonymous`, the `anonymousAuth.defaultGroups`
 * and their permissions), so resource checks apply to it instead of being
 * skipped because `req.user` is missing. The routes below run behind the real
 * middleware chain; the model provider is a scripted transport.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import { setupMiddleware } from '../middleware/setup.js';
import { appAccessRequired, modelAccessRequired } from '../middleware/authRequired.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import registerOpenAIProxyRoutes from '../routes/openaiProxy.js';
import registerGeneralRoutes from '../routes/generalRoutes.js';
import registerModelRoutes from '../routes/modelRoutes.js';
import registerMagicPromptRoutes from '../routes/magicPromptRoutes.js';
import registerSessionRoutes from '../routes/chat/sessionRoutes.js';
import { createJob, canAccessJob, listJobs } from '../routes/toolsService/jobStore.js';
import { isAdminUser } from '../services/loop/runIdentity.js';
import { isAdmin as isWorkflowAdmin } from '../services/workflow/workflowAccess.js';
import { InteractionService } from '../services/loop/InteractionService.js';
import { getLocalizedError } from '../serverHelpers.js';
import { makeClient, sseResponse, openaiText } from './loop/helpers/llmFixtures.js';

const MODELS = [
  {
    id: 'open-model',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    default: true
  },
  {
    id: 'restricted-model',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false
  }
];

const APPS = [
  {
    id: 'open-app',
    name: { en: 'Open' },
    system: { en: 'You help.' },
    features: { magicPrompt: { enabled: true, prompt: 'Configured instruction.' } }
  },
  {
    id: 'restricted-app',
    name: { en: 'Restricted' },
    system: { en: 'Configured system prompt.' },
    features: { magicPrompt: { enabled: true, prompt: 'Restricted instruction.' } }
  }
];

const GROUPS = {
  groups: {
    anonymous: {
      id: 'anonymous',
      permissions: {
        apps: ['open-app'],
        models: ['open-model'],
        prompts: [],
        adminAccess: false
      }
    },
    admins: {
      id: 'admins',
      permissions: { apps: ['*'], models: ['*'], prompts: ['*'], adminAccess: true }
    }
  }
};

const PLATFORM = {
  defaultLanguage: 'en',
  anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
  auth: { mode: 'anonymous' }
};

const KEYS = [
  'config/platform.json',
  'config/groups.json',
  'config/apps.json',
  'config/models.json'
];
const saved = new Map();

function seed(platform = PLATFORM) {
  configCache.cache.set('config/platform.json', { data: platform, etag: 'p' });
  configCache.cache.set('config/groups.json', { data: GROUPS, etag: 'g' });
  configCache.cache.set('config/apps.json', { data: APPS, etag: 'a' });
  configCache.cache.set('config/models.json', { data: MODELS, etag: 'm' });
}

before(async () => {
  for (const key of KEYS) saved.set(key, configCache.cache.get(key));
  await configCache.loadAndCacheLocale('en');
  seed();
});

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) configCache.cache.delete(key);
    else configCache.cache.set(key, value);
  }
});

function buildApp(platform = PLATFORM) {
  seed(platform);
  const { client, calls } = makeClient({
    models: MODELS,
    transport: async () => sseResponse(openaiText(['ok']))
  });
  const app = express();
  app.use(express.json());
  setupMiddleware(app, platform);
  app.get('/probe/user', (req, res) => {
    res.json(
      req.user
        ? {
            id: req.user.id,
            groups: req.user.groups,
            isAdmin: req.user.isAdmin,
            adminAccess: req.user.permissions?.adminAccess,
            models: [...(req.user.permissions?.models || [])]
          }
        : null
    );
  });
  registerOpenAIProxyRoutes(app, { llmClient: client });
  registerGeneralRoutes(app, { getLocalizedError });
  registerModelRoutes(app, { getLocalizedError });
  registerMagicPromptRoutes(app);
  registerSessionRoutes(app, { getLocalizedError, DEFAULT_TIMEOUT: 1000 });
  return { app, calls };
}

const chat = model => ({ model, messages: [{ role: 'user', content: 'hi' }] });

describe('anonymous principal', () => {
  test('a tokenless request carries the anonymous principal and its group permissions', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/probe/user');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'anonymous');
    assert.deepEqual(res.body.groups, ['anonymous']);
    assert.deepEqual(res.body.models, ['open-model']);
    assert.equal(res.body.isAdmin, false);
  });

  test('the anonymous principal is never an administrator, whatever its default groups', async () => {
    const { app } = buildApp({
      ...PLATFORM,
      anonymousAuth: { enabled: true, defaultGroups: ['admins'] }
    });
    const res = await request(app).get('/probe/user');
    assert.equal(res.body.id, 'anonymous');
    assert.equal(res.body.isAdmin, false);
    assert.equal(res.body.adminAccess, false);
  });

  test('no principal is built when anonymous access is disabled', async () => {
    const { app } = buildApp({ ...PLATFORM, anonymousAuth: { enabled: false } });
    const res = await request(app).get('/probe/user');
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
  });
});

describe('inference API without a token', () => {
  test('lists only the models the anonymous group may use', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/inference/v1/models');
    assert.equal(res.status, 200);
    const ids = res.body.data.map(m => m.id);
    assert.ok(ids.includes('open-model'));
    assert.ok(!ids.includes('restricted-model'));
    assert.ok(ids.includes('app:open-app'));
    assert.ok(!ids.includes('app:restricted-app'));
  });

  test('refuses a model outside the anonymous group with 403', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .post('/api/inference/v1/chat/completions')
      .send(chat('restricted-model'));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0, 'no provider call');
  });

  test('refuses a model outside the anonymous group regardless of casing', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .post('/api/inference/v1/chat/completions')
      .send(chat('Restricted-Model'));
    assert.ok([403, 404].includes(res.status), `got ${res.status}`);
    assert.equal(calls.length, 0, 'no provider call');
  });

  test('serves a model the anonymous group may use', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .post('/api/inference/v1/chat/completions')
      .send(chat('open-model'));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });
});

describe('app and model details without a token', () => {
  test('GET /api/apps/:appId answers 404 for an app outside the anonymous group', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/apps/restricted-app');
    assert.equal(res.status, 404);
    assert.equal(res.body.system, undefined);
  });

  test('GET /api/apps/:appId answers 404 for an unknown app, the same as for a restricted one', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/apps/does-not-exist');
    assert.equal(res.status, 404);
  });

  test('GET /api/apps/:appId serves an app the anonymous group may use', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/apps/open-app');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'open-app');
  });

  test('GET /api/models/:modelId answers 404 for a model outside the anonymous group', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/models/restricted-model');
    assert.equal(res.status, 404);
  });

  test('GET /api/models/:modelId serves a model the anonymous group may use', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/models/open-model');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'open-model');
  });

  test('GET /api/models/:modelId/chat/test refuses a model outside the anonymous group', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/models/restricted-model/chat/test');
    assert.equal(res.status, 403);
  });
});

describe('magic prompt without a token', () => {
  test('refuses an explicitly requested model outside the anonymous group with 403', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/magic-prompt')
      .send({ input: 'draft', modelId: 'restricted-model', appId: 'open-app' });
    assert.equal(res.status, 403);
  });

  test('answers 404 for an app outside the anonymous group', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/magic-prompt')
      .send({ input: 'draft', appId: 'restricted-app' });
    assert.equal(res.status, 404);
  });

  test('answers 403 when the caller may use no model at all', async () => {
    const { app } = buildApp();
    configCache.cache.set('config/groups.json', {
      data: {
        groups: {
          anonymous: { id: 'anonymous', permissions: { apps: ['open-app'], models: [] } }
        }
      },
      etag: 'g2'
    });
    try {
      const res = await request(app)
        .post('/api/magic-prompt')
        .send({ input: 'draft', appId: 'open-app' });
      assert.equal(res.status, 403);
    } finally {
      seed();
    }
  });
});

describe('resource access middleware', () => {
  const run = (middleware, user, params) => {
    const req = { user, params };
    const res = {
      statusCode: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      }
    };
    let passed = false;
    middleware(req, res, () => {
      passed = true;
    });
    return { passed, status: res.statusCode };
  };

  test('denies a request without a principal', () => {
    assert.deepEqual(run(appAccessRequired, undefined, { appId: 'open-app' }), {
      passed: false,
      status: 401
    });
    assert.deepEqual(run(modelAccessRequired, undefined, { modelId: 'open-model' }), {
      passed: false,
      status: 401
    });
  });

  test('denies a principal without permissions', () => {
    assert.deepEqual(run(appAccessRequired, { id: 'u1' }, { appId: 'open-app' }), {
      passed: false,
      status: 403
    });
  });

  test('checks the anonymous principal like any other', () => {
    seed();
    const anonymous = enhanceUserWithPermissions(null, {}, PLATFORM);
    assert.equal(run(appAccessRequired, anonymous, { appId: 'open-app' }).passed, true);
    assert.deepEqual(run(appAccessRequired, anonymous, { appId: 'restricted-app' }), {
      passed: false,
      status: 403
    });
  });
});

describe('code that reads the principal directly', () => {
  const anonymous = () => {
    seed({ ...PLATFORM, anonymousAuth: { enabled: true, defaultGroups: ['anonymous', 'admins'] } });
    try {
      return enhanceUserWithPermissions(null, {}, configCache.getPlatform());
    } finally {
      seed();
    }
  };

  test('tool jobs do not belong to the anonymous principal', () => {
    const job = createJob('ocr', 'anonymous', {});
    const principal = enhanceUserWithPermissions(null, {}, PLATFORM);
    assert.equal(canAccessJob(job, principal), false);
    assert.deepEqual(listJobs('anonymous', false), []);
    assert.equal(canAccessJob(createJob('ocr', 'u1', {}), { id: 'u1', permissions: {} }), true);
  });

  test('group-name admin checks never treat the anonymous principal as an admin', () => {
    const principal = anonymous();
    assert.ok(principal.groups.includes('admins'));
    assert.equal(isAdminUser(principal), false);
    assert.equal(isWorkflowAdmin({ ...principal, groups: ['admin'] }), false);
    assert.equal(isAdminUser({ id: 'u1', groups: ['admins'] }), true);
  });

  test('the anonymous principal cannot answer an interaction that needs an approver', () => {
    const interaction = { policy: { approverGroups: ['anonymous'] } };
    const principal = enhanceUserWithPermissions(null, {}, PLATFORM);
    assert.throws(
      () => InteractionService.prototype.assertCanAnswer.call(null, interaction, principal),
      err => err.code === 'APPROVER_REQUIRED'
    );
  });

  test('the default groups are copied, not shared with the platform config', () => {
    const platform = {
      ...PLATFORM,
      anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] }
    };
    const principal = enhanceUserWithPermissions(null, {}, platform);
    principal.groups.push('other');
    assert.deepEqual(platform.anonymousAuth.defaultGroups, ['anonymous']);
  });
});
