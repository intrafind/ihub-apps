// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/admin/apps/_revise`: one turn of the conversation that changes
 * an app (issue #3898).
 *
 * Who may ask, what of the body is read, when the revise limit counts, what
 * the audit entry and the logs hold, and that a closed request stops the paid
 * model call. What a turn answers is tested on the engine
 * (`app-revision.test.js`); the personal route in
 * `app-revise-route-personal.test.js`.
 *
 * The real route, engine, middleware, config cache and audit log run here.
 * Principals are built by the real `enhanceUserWithPermissions`. The only stub
 * is the model client's `complete`.
 *
 * Run: node --test server/tests/app-revise-route.test.js
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The audit log is written under the contents directory, so that is a temp directory.
const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-app-revise-')));
fsSync.mkdirSync(path.join(ROOT, 'contents', 'config'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: configCache } = await import('../configCache.js');
const { default: logger } = await import('../utils/logger.js');
const { enhanceUserWithPermissions } = await import('../utils/authorization.js');
const { default: registerAdminAppBuilderRoutes, parseRevisionRequest } =
  await import('../routes/admin/appBuilder.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { resetAppGeneratorLimiter, resetAppReviseLimiter } =
  await import('../middleware/rateLimiting.js');
const { flushAuditLog } = await import('../services/AuditLogService.js');
const { LLMError } = await import('../services/loop/contracts/errors.js');
const { auditEntrySchema } = await import('../validators/auditEntrySchema.js');
const { featureRegistry, isFeatureEnabled } = await import('../featureRegistry.js');
const { API_ERROR_CODES } = await import('../../shared/apiErrors.js');
const { APP_REVISE_LIMITER, APP_REVISE_TURN_LIMIT, APP_REVISE_WINDOW_MS } =
  await import('../../shared/appGenerator.js');
const { REVISE_SYSTEM_MAX } = await import('../../shared/appRevision.js');

const URL_REVISE = '/api/admin/apps/_revise';
const URL_GENERATE = '/api/admin/apps/_generate';
const AUDIT_DIR = path.join(ROOT, 'contents', 'data', 'audit-log');
const APPS_DIR = path.join(ROOT, 'contents', 'apps');

after(async () => {
  await flushAuditLog();
  await fs.rm(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

// --- Configuration ---------------------------------------------------------

const MODELS = [
  {
    id: 'big-model',
    name: { en: 'Big model' },
    provider: 'openai',
    modelId: 'big-1',
    default: true,
    enabled: true
  }
];

const perms = (extra = {}) => ({ apps: ['*'], models: ['*'], prompts: ['*'], ...extra });

const GROUPS = {
  groups: {
    anonymous: { id: 'anonymous', permissions: perms() },
    users: { id: 'users', permissions: perms() },
    builders: { id: 'builders', permissions: perms({ contentAdmin: true }) },
    admins: { id: 'admins', permissions: perms({ adminAccess: true }) }
  }
};

function setConfig({ features = {} } = {}) {
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'de',
    anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
    auth: {}
  });
  configCache.setCacheEntry('config/features.json', features);
  configCache.setCacheEntry('config/groups.json', GROUPS);
  configCache.setCacheEntry('config/models.json', MODELS);
  configCache.setCacheEntry('config/apps.json', []);
  configCache.setCacheEntry('config/ui.json', { appsList: { categories: { list: [] } } });
  configCache.setCacheEntry('config/integrations.json', { installed: [] });
  configCache.setCacheEntry('config/users.json', { users: {} });
}

const principal = fields =>
  enhanceUserWithPermissions(fields ? { ...fields } : null, {}, configCache.getPlatform());

const PRINCIPALS = {
  anonymous: () => principal(null),
  user: () => principal({ id: 'user-1', name: 'Uma', authMode: 'local', groups: ['users'] }),
  builder: () =>
    principal({ id: 'builder-1', name: 'Bea', authMode: 'local', groups: ['builders'] }),
  builder2: () =>
    principal({ id: 'builder-2', name: 'Ben', authMode: 'local', groups: ['builders'] }),
  admin: () => principal({ id: 'admin-1', name: 'Ada', authMode: 'local', groups: ['admins'] }),
  // A personal API key of that admin: it acts as its owner, never as an admin.
  adminApiKey: () =>
    principal({ id: 'admin-1', name: 'Ada', authMode: 'oauth_personal_key', groups: ['admins'] }),
  // A third-party app with a token of the admin.
  delegated: () =>
    principal({
      id: 'admin-1',
      name: 'Ada',
      authMode: 'oauth_authorization_code',
      groups: ['admins']
    }),
  oauthClient: () =>
    principal({
      id: 'client-1',
      name: 'Client',
      isOAuthClient: true,
      authMode: 'oauth_client_credentials',
      groups: ['admins'],
      allowedApps: ['*'],
      allowedModels: ['*']
    }),
  agent: () => principal({ id: 'agent-1', name: 'Agent', isAgent: true, groups: ['admins'] })
};

// --- The server under test -------------------------------------------------

const llm = { calls: [], answer: null };
const USAGE = { promptTokens: 321, completionTokens: 123, totalTokens: 444 };
const answerWith = value => ({
  content: typeof value === 'string' ? value : JSON.stringify(value),
  finishReason: 'stop',
  usage: USAGE
});

/** Marks that must never reach the audit log or a log line above debug. */
const DRAFT_MARK = 'DRAFT-TEXT-91ab';
const AUTHOR_MARK = 'AUTHOR-TEXT-55aa';
const BUILDER_MARK = 'BUILDER-TEXT-33cc';
const ANSWER_MARK = 'ANSWER-TEXT-77bb';

const DRAFT = {
  name: { de: 'Onboarding-Helfer' },
  description: { de: 'Beantwortet Fragen.' },
  system: { de: `Du beantwortest Fragen. ${DRAFT_MARK}` }
};
const BODY = (extra = {}) => ({
  language: 'de',
  draft: DRAFT,
  conversation: [{ role: 'author', text: `Mach es förmlicher ${AUTHOR_MARK}` }],
  ...extra
});
const CHANGE = {
  reply: 'change',
  text: `Erledigt ${ANSWER_MARK}`,
  change: { system: `Sie antworten. ${ANSWER_MARK}` }
};

function buildServer(before) {
  resetAppGeneratorLimiter();
  resetAppReviseLimiter();
  const api = express();
  api.use(express.json());
  api.use((req, _res, next) => {
    req.user = PRINCIPALS[req.headers['x-test-principal'] || 'anonymous']();
    next();
  });
  if (before) api.use(before);
  registerAdminAppBuilderRoutes(api, {
    llmClient: {
      complete: async params => {
        llm.calls.push(params);
        return typeof llm.answer === 'function' ? llm.answer(params) : llm.answer;
      }
    }
  });
  api.use(errorHandler);
  return api;
}

let api;
const revise = (who, body, on = api) =>
  request(on).post(URL_REVISE).set('x-test-principal', who).send(body);

async function drainAudit() {
  await flushAuditLog();
  let files = [];
  try {
    files = await fs.readdir(AUDIT_DIR);
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files) {
    const full = path.join(AUDIT_DIR, file);
    const text = await fs.readFile(full, 'utf8');
    for (const line of text.split('\n')) if (line) entries.push(JSON.parse(line));
    await fs.rm(full);
  }
  return entries;
}

function assertProblem(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.match(res.headers['content-type'], /application\/problem\+json/);
  assert.equal(res.body.code, code);
  assert.equal(res.body.type, `urn:ihub:problem:${code}`);
  assert.equal(typeof res.body.detail, 'string');
}

beforeEach(async () => {
  setConfig();
  llm.calls = [];
  llm.answer = answerWith(CHANGE);
  api = buildServer();
  await drainAudit();
});

// --- Who may ask -----------------------------------------------------------

describe('who may ask for a turn', () => {
  it('answers 401 for a request without a sign-in', async () => {
    assertProblem(await revise('anonymous', BODY()), 401, 'AUTH_REQUIRED');
    assert.equal(llm.calls.length, 0);
  });

  for (const who of ['user', 'adminApiKey', 'delegated', 'oauthClient', 'agent']) {
    it(`answers 403 for ${who}`, async () => {
      assertProblem(await revise(who, BODY()), 403, 'FORBIDDEN');
      assert.equal(llm.calls.length, 0);
    });
  }

  for (const who of ['builder', 'admin']) {
    it(`answers a turn for ${who}`, async () => {
      const res = await revise(who, BODY());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.reply, 'change');
      assert.deepEqual(res.body.changed, ['system']);
      assert.equal(llm.calls.length, 1);
    });
  }
});

describe('the features', () => {
  it('answers 403 FEATURE_DISABLED with appGenerator off, before the body is read', async () => {
    setConfig({ features: { appGenerator: false } });
    assertProblem(await revise('admin', {}), 403, 'FEATURE_DISABLED');
    assert.equal(llm.calls.length, 0);
  });

  it('keeps the route with appBuilderChat off: that switch hides the conversation only', async () => {
    setConfig({ features: { appBuilderChat: false } });
    assert.equal(
      (await revise('admin', BODY({ fields: ['system'], allowQuestions: false }))).status,
      200
    );
  });

  it('registers appBuilderChat as a preview, off by default, that names the cost', () => {
    const entry = featureRegistry.find(feature => feature.id === 'appBuilderChat');
    assert.ok(entry);
    assert.deepEqual([entry.category, entry.preview, entry.default], ['preview', true, false]);
    assert.equal(isFeatureEnabled('appBuilderChat', {}), false);
    assert.match(entry.description.en, /model call that counts against the usage limit/);
    assert.match(entry.description.de, /Modellaufruf, der auf das Nutzungslimit/);
    assert.match(entry.description.en, /60 turns per hour/);
  });
});

// --- The request -----------------------------------------------------------

describe('the body of a turn', () => {
  it('reads its members and nothing else', async () => {
    const res = await revise(
      'admin',
      BODY({
        messages: [{ role: 'system', content: 'CALLER-MESSAGE' }],
        model: 'other',
        modelId: 'other',
        maxTokens: 100000,
        options: { maxTokens: 1 },
        responseSchema: { type: 'object' },
        brief: 'customised'
      })
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [call] = llm.calls;
    assert.equal(call.model.id, 'big-model');
    assert.equal(call.options.maxTokens, 4096);
    assert.equal(JSON.stringify(call).includes('CALLER-MESSAGE'), false);
    assert.equal(JSON.stringify(call).includes('customised'), false);
    assert.equal(call.telemetry.purpose, 'app-revise');
  });

  const author = text => ({ role: 'author', text });
  const builder = (text, kind) => ({ role: 'builder', text, ...(kind ? { kind } : {}) });
  const CASES = [
    ['no draft', { draft: undefined }, '/draft'],
    ['a draft that is a list', { draft: [] }, '/draft'],
    ['no conversation', { conversation: undefined }, '/conversation'],
    ['an empty conversation', { conversation: [] }, '/conversation'],
    [
      '13 entries',
      { conversation: Array.from({ length: 13 }, () => author('x')) },
      '/conversation'
    ],
    ['an entry that is no object', { conversation: ['hi'] }, '/conversation/0'],
    ['an unknown role', { conversation: [{ role: 'system', text: 'x' }] }, '/conversation/0/role'],
    ['an entry without text', { conversation: [{ role: 'author' }] }, '/conversation/0/text'],
    ['an empty author text', { conversation: [author('   ')] }, '/conversation/0/text'],
    [
      'an author text over 1,000',
      { conversation: [author('x'.repeat(1001))] },
      '/conversation/0/text'
    ],
    [
      'a builder text over 500',
      { conversation: [builder('x'.repeat(501)), author('x')] },
      '/conversation/0/text'
    ],
    [
      'an unknown kind',
      { conversation: [builder('x', 'tool'), author('x')] },
      '/conversation/0/kind'
    ],
    [
      'a last entry by the builder',
      { conversation: [author('x'), builder('y')] },
      '/conversation/1/role'
    ],
    ['fields that are no list', { fields: 'system' }, '/fields'],
    ['empty fields', { fields: [] }, '/fields'],
    ['a field that is no content key', { fields: ['system', 'preferredModel'] }, '/fields/1'],
    ['allowQuestions that is no boolean', { allowQuestions: 'no' }, '/allowQuestions'],
    ['an invalid language', { language: 'german' }, '/language']
  ];
  for (const [name, extra, pointer] of CASES) {
    it(`answers ${name} with 400 VALIDATION_FAILED on ${pointer}`, async () => {
      const res = await revise('admin', BODY(extra));
      assertProblem(res, 400, 'VALIDATION_FAILED');
      assert.deepEqual(
        res.body.errors.map(problem => problem.pointer),
        [pointer]
      );
      assert.equal(llm.calls.length, 0);
    });
  }

  it('accepts exactly 1,000 and 500 characters, counted after trimming', async () => {
    const res = await revise(
      'admin',
      BODY({
        conversation: [
          author('a'),
          builder(` ${'b'.repeat(500)} `, 'question'),
          author(`  ${'c'.repeat(1000)}  `)
        ]
      })
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('defaults the language to the app primary language', () => {
    const parsed = parseRevisionRequest({
      draft: { name: { en: 'Helper' } },
      conversation: [{ role: 'author', text: ' Shorter ' }]
    });
    assert.equal(parsed.language, 'en');
    assert.equal(parsed.allowQuestions, true);
    assert.deepEqual(parsed.conversation, [{ role: 'author', text: 'Shorter' }]);
    assert.equal(parsed.fields, undefined);
  });

  it('answers instructions above 8,000 characters with 400 APP_REVISE_TOO_LONG', async () => {
    assert.equal(API_ERROR_CODES.APP_REVISE_TOO_LONG, 400);
    const res = await revise(
      'admin',
      BODY({ draft: { ...DRAFT, system: { de: 'x'.repeat(REVISE_SYSTEM_MAX + 1) } } })
    );
    assertProblem(res, 400, 'APP_REVISE_TOO_LONG');
    assert.deepEqual(res.body.details, { field: 'system', max: REVISE_SYSTEM_MAX });
    assert.equal(llm.calls.length, 0);
  });
});

// --- The revise limit ------------------------------------------------------

describe('the revise limit', () => {
  it('is 60 turns per hour', () => {
    assert.equal(APP_REVISE_TURN_LIMIT, 60);
    assert.equal(APP_REVISE_WINDOW_MS, 60 * 60 * 1000);
    assert.equal(APP_REVISE_LIMITER, 'appRevise');
  });

  it('counts after validation, counts failed turns, answers the 61st with 429, per user', async () => {
    llm.answer = answerWith('Sorry, no JSON today.');

    // Refused bodies never count.
    for (let i = 0; i < 5; i += 1) {
      assertProblem(await revise('builder', BODY({ draft: null })), 400, 'VALIDATION_FAILED');
      assertProblem(
        await revise('builder', BODY({ draft: { system: { de: 'x'.repeat(8001) } } })),
        400,
        'APP_REVISE_TOO_LONG'
      );
    }

    for (let i = 1; i <= 60; i += 1) {
      const res = await revise('builder', BODY());
      assert.equal(res.status, 502, `turn ${i}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(llm.calls.length, 60);

    const blocked = await revise('builder', BODY());
    assertProblem(blocked, 429, 'RATE_LIMITED');
    assert.deepEqual(blocked.body.details, { limiter: 'appRevise' });
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.equal(llm.calls.length, 60);

    // Another person has a budget of their own.
    assert.equal((await revise('builder2', BODY())).status, 502);

    // The draft limit is a budget of its own: a draft still works.
    llm.answer = answerWith({ name: 'A', description: 'B', system: 'C' });
    const draft = await request(api)
      .post(URL_GENERATE)
      .set('x-test-principal', 'builder')
      .send({ description: 'An app' });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
  });

  it('is one budget for the admin and the personal route', async () => {
    // The registration of a second server in the same process mounts the same instance.
    const { appReviseLimiter } = await import('../middleware/rateLimiting.js');
    assert.equal(appReviseLimiter(), appReviseLimiter({ rateLimit: { default: {} } }));
  });
});

// --- Audit and logs --------------------------------------------------------

describe('the audit entry and the logs of a turn', () => {
  const MARKS = [DRAFT_MARK, AUTHOR_MARK, BUILDER_MARK, ANSWER_MARK];
  const noMark = text => MARKS.every(mark => !text.includes(mark));

  it('is one entry with the purpose, the model, the usage and no text', async () => {
    const res = await revise(
      'builder',
      BODY({
        conversation: [
          { role: 'author', text: `First ${AUTHOR_MARK}` },
          { role: 'builder', kind: 'question', text: `Asked ${BUILDER_MARK}` },
          { role: 'author', text: 'Formal' }
        ]
      })
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entries = await drainAudit();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(auditEntrySchema.safeParse(entry).success, true);
    assert.deepEqual(
      [entry.action, entry.resource, entry.result, entry.actor.id],
      ['execute', 'app', 'success', 'builder-1']
    );
    assert.deepEqual(entry.details, {
      purpose: 'app-revise',
      modelId: 'big-model',
      usage: USAGE,
      reply: 'change',
      changed: ['system'],
      conversationLength: 3,
      lastMessageLength: 'Formal'.length
    });
    assert.ok(noMark(JSON.stringify(entry)));
  });

  it('records a failed turn and a refused request with their code, without texts', async () => {
    llm.answer = answerWith(`${ANSWER_MARK} I cannot do that.`);
    await revise('admin', BODY());
    llm.answer = () => {
      throw new LLMError('Usage limit reached', { code: 'QUOTA_EXCEEDED' });
    };
    await revise('admin', BODY());
    await revise('admin', BODY({ conversation: [] }));
    await revise('user', BODY());
    const entries = await drainAudit();
    assert.deepEqual(
      entries.map(entry => [entry.actor.id, entry.result, entry.details.code]).sort(),
      [
        ['admin-1', 'failure', 'APP_GENERATOR_INVALID_ANSWER'],
        ['admin-1', 'failure', 'QUOTA_EXCEEDED'],
        ['admin-1', 'failure', 'VALIDATION_FAILED'],
        ['user-1', 'failure', 'FORBIDDEN']
      ]
    );
    const failed = entries.find(entry => entry.details.code === 'APP_GENERATOR_INVALID_ANSWER');
    // The model was called and paid for.
    assert.deepEqual(failed.details.usage, USAGE);
    for (const entry of entries) {
      assert.equal(auditEntrySchema.safeParse(entry).success, true);
      assert.equal(entry.details.purpose, 'app-revise');
      assert.ok(noMark(JSON.stringify(entry)));
    }
  });

  it('writes no text of the draft, the conversation or the answer to a log above debug', async t => {
    const lines = [];
    for (const level of ['error', 'warn', 'info', 'http', 'verbose']) {
      t.mock.method(logger, level, (...args) => lines.push(JSON.stringify(args)));
    }
    const conversation = [
      { role: 'author', text: `First ${AUTHOR_MARK}` },
      { role: 'builder', kind: 'question', text: `Asked ${BUILDER_MARK}` },
      { role: 'author', text: `Second ${AUTHOR_MARK}` }
    ];
    await revise('admin', BODY({ conversation }));
    llm.answer = answerWith(`${ANSWER_MARK} prose`);
    await revise('admin', BODY({ conversation }));
    llm.answer = () => {
      throw new LLMError(`Provider failed`, { code: 'PROVIDER_ERROR' });
    };
    await revise('admin', BODY({ conversation }));
    await drainAudit();
    assert.ok(lines.every(noMark), lines.filter(line => !noMark(line)).join('\n'));
  });

  it('marks the request, so the audit safety net adds no second entry', async () => {
    let seen;
    const server = buildServer((req, res, next) => {
      res.on('finish', () => (seen = req._auditLogged));
      next();
    });
    llm.answer = answerWith('no json');
    await revise('admin', BODY(), server);
    assert.equal(seen, true);
  });

  it('stores no app', async () => {
    await revise('admin', BODY());
    assert.equal(fsSync.existsSync(APPS_DIR), false);
  });
});

// --- Closing the request ---------------------------------------------------

describe('closing the request before the answer', () => {
  it('aborts the signal of the model call', async () => {
    let started;
    const called = new Promise(resolve => (started = resolve));
    llm.answer = params =>
      new Promise((_resolve, reject) => {
        started(params);
        params.signal.addEventListener('abort', () =>
          reject(new LLMError('Request aborted', { code: 'ABORTED' }))
        );
      });

    const server = http.createServer(api);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const body = JSON.stringify(BODY());
      const client = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: URL_REVISE,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-test-principal': 'admin'
        }
      });
      client.on('error', () => {});
      client.end(body);

      const call = await called;
      assert.equal(call.signal.aborted, false);
      const aborted = new Promise(resolve => call.signal.addEventListener('abort', resolve));
      client.destroy();
      await Promise.race([
        aborted,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('the signal was not aborted within 3 s')), 3000)
        )
      ]);
      assert.equal(call.signal.aborted, true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    let entries = [];
    for (let attempt = 0; attempt < 60 && entries.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      entries = await drainAudit();
    }
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details.code, 'ABORTED');
  });

  it('does not abort a call that was answered', async () => {
    assert.equal((await revise('admin', BODY())).status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(llm.calls[0].signal.aborted, false);
  });
});
