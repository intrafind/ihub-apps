#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Prepares an iHub instance for a load test. Idempotent: rerun it safely.
 *
 *   node tests/load/setup.mjs --profile capacity-stub          # everything
 *   node tests/load/setup.mjs --check                          # preflight only
 *   node tests/load/setup.mjs --users 300 --skip-projects
 *
 * Steps
 *   1. Preflight: reads platform config and lists what will distort the test
 *      (rate limits, LLM throttle, AI acknowledgement, project limits).
 *   2. Enables the `userProjects` feature flag (preview, off by default).
 *   3. Registers the models: `loadtest-gpu` (real LLM, name discovered by the
 *      server) and/or `loadtest-stub` (paced fake LLM).
 *   4. Creates users lt-0001…lt-NNNN one at a time (the users file has no lock).
 *   5. Logs each user in once and confirms the AI-use notice if enforced.
 *   6. Creates "LT-chat" projects with documents for the projectChat scenario:
 *      one own project per user and a few shared with the users group.
 */

import { loadConfig, userName } from './lib/config.mjs';
import { login, HttpError } from './lib/http.mjs';
import { loadFixtures, TOPICS } from './lib/fixtures.mjs';
import {
  createProject,
  uploadItem,
  waitForItems,
  shareWithGroup,
  listProjects
} from './lib/projects.mjs';
import { mapLimit, withRetry, log, sleep } from './lib/util.mjs';

const cfg = loadConfig();
const flags = cfg.args;
const checkOnly = flags.check === 'true';
const warnings = [];
const warn = (msg, fix) => warnings.push({ msg, fix });

// --- 1. admin + preflight ---------------------------------------------------
const { client: admin } = await login({
  baseUrl: cfg.baseUrl,
  username: cfg.admin.username,
  password: cfg.admin.password
});
log(`admin ${cfg.admin.username} logged in at ${cfg.baseUrl}`);

const platformRes = await admin.get('/api/admin/configs/platform');
// The stored file, not the IHUB_PLATFORM__* overrides; the limits in effect
// come from /api/admin/rate-limits below.
const platform = platformRes.status === 200 ? platformRes.body : {};
const rlRes = await admin.get('/api/admin/rate-limits');
const rl =
  rlRes.status === 200 ? rlRes.body.running || rlRes.body.limiters || {} : platform.rateLimit || {};
const users = cfg.users.count;

if ((rl.authApi?.limit ?? 30) < users + 20) {
  warn(
    `authApi rate limit ${rl.authApi?.limit ?? 30}/${Math.round((rl.authApi?.windowMs ?? 900000) / 60000)} min < ${users} logins`,
    'IHUB_PLATFORM__RATE_LIMIT__AUTH_API__LIMIT=100000'
  );
}
if ((rl.publicApi?.limit ?? 500) < 20000) {
  warn(
    `publicApi rate limit ${rl.publicApi?.limit ?? 500}/min per IP and worker — all VUs of a runner share one IP`,
    'IHUB_PLATFORM__RATE_LIMIT__PUBLIC_API__LIMIT=1000000'
  );
}
if ((rl.adminApi?.limit ?? 100) < 1000) {
  warn(
    `adminApi rate limit ${rl.adminApi?.limit ?? 100}/min (user creation, sampler)`,
    'IHUB_PLATFORM__RATE_LIMIT__ADMIN_API__LIMIT=100000'
  );
}
if ((rl.inferenceApi?.limit ?? 500) < 20000 && cfg.mix.inference > 0) {
  warn(
    `inferenceApi rate limit ${rl.inferenceApi?.limit ?? 500}/min`,
    'IHUB_PLATFORM__RATE_LIMIT__INFERENCE_API__LIMIT=1000000'
  );
}
if (cfg.modelId && !/^loadtest-/.test(cfg.modelId)) {
  warn(
    `model ${cfg.modelId}: unless it has its own "concurrency", platform requestConcurrency (default 5) caps parallel LLM calls`,
    'set "concurrency" on the model, or IHUB_PLATFORM__REQUEST_CONCURRENCY=0 (loadtest-gpu/-stub get 100 from setup)'
  );
}
const ack = platform.aiAcknowledgement || {};
if (ack.enabled !== false && ack.enforce !== false) {
  warn(
    'AI-use acknowledgement enforced: setup confirms it per user (sequentially, writes users.json)',
    'or IHUB_PLATFORM__AI_ACKNOWLEDGEMENT__ENFORCE=false'
  );
}
const projectLimits = platform.projects?.limits || {};
if (
  cfg.mix.projectBuild > 0 &&
  (projectLimits.maxProjectsPerUser ?? 20) > 0 &&
  (projectLimits.maxProjectsPerUser ?? 20) < 5
) {
  warn(
    `maxProjectsPerUser ${projectLimits.maxProjectsPerUser}`,
    'IHUB_PLATFORM__PROJECTS__LIMITS__MAX_PROJECTS_PER_USER=50'
  );
}
log(`telemetry=${platform.telemetry?.enabled ? platform.telemetry.provider || 'on' : 'off'}`);

const features = await admin.get('/api/admin/features');
const userProjectsOn = (features.body?.items || []).find(f => f.id === 'userProjects')?.enabled;

if (warnings.length) {
  console.log('\nPreflight findings (a restart is needed after changing platform settings):');
  for (const w of warnings) console.log(`  • ${w.msg}\n      fix: ${w.fix}`);
  console.log('');
}
if (checkOnly) {
  log(`userProjects feature: ${userProjectsOn ? 'on' : 'OFF'}`);
  process.exit(0);
}

// --- 2. feature flag ---------------------------------------------------------
if (!userProjectsOn && cfg.setup.enableFeatures) {
  await admin.request('PUT', '/api/admin/features', {
    json: { userProjects: true },
    expect: [200]
  });
  log('enabled feature userProjects');
}

// --- 3. models ---------------------------------------------------------------
async function upsertModel(model) {
  const res = await admin.request('POST', '/api/admin/models', { json: model });
  if (res.status === 409) {
    await admin.request('PUT', `/api/admin/models/${model.id}`, { json: model, expect: [200] });
    log(`updated model ${model.id}`);
  } else if (res.status >= 300) {
    throw new HttpError(`create model ${model.id}`, res.status, res.body);
  } else {
    log(`created model ${model.id}`);
  }
}

const v1 = url => `${url.replace(/\/+$/, '').replace(/\/v1(\/chat\/completions)?$/, '')}/v1`;

// The stub mirrors the GPU model's context window so project chats inject the same amount.
let discoveredContext = null;
if (cfg.setup.gpu?.url && !flags['skip-models']) {
  const g = cfg.setup.gpu;
  let modelName = g.modelName;
  if (!modelName) {
    // Discovery runs on the iHub server, so it also proves that iHub reaches the
    // GPU host through its proxy/TLS settings.
    const res = await admin.request('POST', '/api/admin/models/_discover', {
      json: { url: v1(g.url), apiType: 'openai', ...(g.apiKey ? { apiKey: g.apiKey } : {}) }
    });
    if (res.status !== 200 || !res.body?.models?.length) {
      console.error(
        `Model discovery at ${v1(g.url)} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}\n` +
          '  If the GPU uses the internal CA: add the host to ssl.domainWhitelist and set ssl.ignoreInvalidCertificates\n' +
          '  (IHUB_PLATFORM__SSL__DOMAIN_WHITELIST=\'["gpu-01.local.intrafind.io"]\'), or set LT_LLM_MODEL_NAME to skip discovery.'
      );
      process.exit(2);
    }
    modelName = res.body.models[0].id;
    discoveredContext = res.body.models.find(m => m.id === modelName)?.contextWindow || null;
    log(`GPU serves: ${res.body.models.map(m => m.id).join(', ')} → using ${modelName}`);
  }
  await upsertModel({
    id: g.id,
    modelId: modelName,
    name: { en: `Load test GPU (${modelName})` },
    description: { en: 'Real LLM for load tests' },
    url: `${v1(g.url)}/chat/completions`,
    provider: g.provider,
    contextWindow: discoveredContext || g.contextWindow,
    maxOutputTokens: g.maxOutputTokens,
    supportsTools: g.supportsTools,
    concurrency: g.concurrency,
    // Without it iHub never sends `enable_thinking`, so LT_THINKING has no effect
    // and gpu-01's template default (no thinking) applies. With it, thinking is on
    // unless a turn sends thinkingEnabled=false (LT_THINKING=off).
    thinking: { enabled: true },
    enabled: true,
    ...(g.apiKey ? { apiKey: g.apiKey } : {})
  });
}

if (cfg.setup.stub?.url && !flags['skip-models']) {
  const s = cfg.setup.stub;
  await upsertModel({
    id: s.id,
    modelId: 'loadtest-stub-model',
    name: { en: 'Load test stub (fake LLM)' },
    description: { en: 'Paced fake LLM for capacity tests of iHub itself' },
    url: `${v1(s.url)}/chat/completions`,
    provider: 'local',
    contextWindow: discoveredContext || s.contextWindow,
    maxOutputTokens: s.maxOutputTokens,
    supportsTools: 'none',
    concurrency: 100,
    enabled: true
  });
}

// --- 4. users -----------------------------------------------------------------
if (!flags['skip-users']) {
  let created = 0;
  let existing = 0;
  for (let i = 0; i < users; i++) {
    const username = userName(cfg, i);
    const res = await withRetry(
      async () => {
        const r = await admin.request('POST', '/api/admin/auth/users', {
          json: {
            username,
            password: cfg.users.password,
            name: `Load Test ${i + 1}`,
            email: `${username}@loadtest.invalid`,
            internalGroups: [cfg.users.group],
            active: true,
            authMethods: ['local']
          }
        });
        if (r.status === 429)
          throw Object.assign(new HttpError('create user', 429, r.body), {
            retryAfter: r.headers.get('retry-after')
          });
        return r;
      },
      { label: `create ${username}` }
    );
    if (res.status === 409) existing += 1;
    else if (res.status < 300) created += 1;
    else throw new HttpError(`create user ${username}`, res.status, res.body);
    if ((i + 1) % 50 === 0) log(`users: ${i + 1}/${users}`);
  }
  log(`users: ${created} created, ${existing} already existed`);
}

// --- 5. log in, acknowledge ----------------------------------------------------
// Logins in parallel (bcrypt on the server); acknowledgements one at a time,
// because each one rewrites users.json.
const clients = new Array(users);
await mapLimit(
  Array.from({ length: users }, (_, i) => i),
  cfg.loginConcurrency,
  async i => {
    const username = userName(cfg, i);
    const { client } = await withRetry(
      () => login({ baseUrl: cfg.baseUrl, username, password: cfg.users.password }),
      { label: `login ${username}` }
    );
    clients[i] = { username, client };
  }
);
log(`logged in ${users} users`);
let acknowledged = 0;
for (const { client } of clients) {
  const me = await client.get('/api/eu-ai-act/acknowledgements/me');
  if (me.status === 200 && me.body?.enabled && me.body?.enforce && !me.body?.acknowledged) {
    await client.request('POST', '/api/eu-ai-act/acknowledgements/me', {
      json: {
        version: me.body.requiredVersion,
        textHash: me.body.textHash,
        language: me.body.language
      },
      expect: [200, 201]
    });
    acknowledged += 1;
  }
}
if (acknowledged) log(`confirmed the AI-use notice for ${acknowledged} users`);

// --- 6. LT-chat projects -----------------------------------------------------
if (!flags['skip-projects'] && (cfg.mix.projectChat > 0 || flags['force-projects'])) {
  const fixtures = loadFixtures(cfg.fixtures.dir).filter(
    f => f.buffer.length <= 5_000_000 && !f.noText
  );
  const docsFor = topicId => {
    const own = fixtures.filter(f => f.topic === topicId);
    const rest = fixtures.filter(f => f.topic !== topicId);
    return [...own, ...rest].slice(0, cfg.setup.docsPerProject);
  };

  async function ensureProject(owner, name, topicId, shared) {
    const existing = (await listProjects(owner.client)).find(p => p.name === name);
    if (existing) return { id: existing.id, created: false };
    const project = await createProject(owner.client, {
      name,
      description: `loadtest topic=${topicId}${shared ? ' shared' : ''}`,
      instructions: 'Answer from the project documents and name the document you used.'
    });
    const pending = [];
    for (const file of docsFor(topicId)) {
      pending.push(
        await withRetry(() => uploadItem(owner.client, project.id, file), {
          label: `upload ${file.name}`
        })
      );
    }
    const r = await waitForItems(owner.client, null, project.id, pending, {
      timeoutMs: 15 * 60_000
    });
    if (r.failed || r.timedOut)
      log(`warning: ${name}: ${r.failed} failed, ${r.timedOut} not ready`);
    if (shared) await shareWithGroup(owner.client, project.id, cfg.users.group);
    return { id: project.id, created: true };
  }

  const tasks = [];
  for (let s = 0; s < cfg.setup.sharedProjects; s++) {
    const topic = TOPICS[s % TOPICS.length];
    const owner = clients[s % clients.length];
    tasks.push(() => ensureProject(owner, `LT-chat ${topic.id} shared-${s + 1}`, topic.id, true));
  }
  if (cfg.setup.ownProjects) {
    // Own projects for the first N users only; the rest chat in the shared ones.
    clients.slice(0, cfg.setup.ownProjectsMax ?? clients.length).forEach((owner, i) => {
      const topic = TOPICS[i % TOPICS.length];
      tasks.push(() =>
        ensureProject(owner, `LT-chat ${topic.id} ${owner.username}`, topic.id, false)
      );
    });
  }
  let done = 0;
  let created = 0;
  await mapLimit(tasks, 4, async task => {
    const r = await task();
    if (r.created) created += 1;
    done += 1;
    if (done % 25 === 0) log(`projects: ${done}/${tasks.length}`);
  });
  log(
    `projects: ${created} created, ${tasks.length - created} already there (${cfg.setup.docsPerProject} docs each)`
  );
}

await sleep(100);
log('setup done');
