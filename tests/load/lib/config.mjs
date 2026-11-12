// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Configuration = defaults ← profile JSON (profiles/<name>.json) ← LT_* env.
 * Every knob a run needs on a laptop or in a Kubernetes Job is reachable by
 * environment variable; see tests/load/README.md for the full list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOAD_DIR = path.resolve(HERE, '..');

export const DEFAULTS = {
  name: 'custom',
  description: '',
  baseUrl: 'http://localhost:3000',
  appId: 'chat',
  modelId: null,
  // Reasoning models (Qwen3): true/false sends thinkingEnabled; null = model default.
  thinking: null,
  language: 'en',
  answerLengthHint: 'Answer in about 120 words.',
  users: { prefix: 'lt-', password: 'LoadTest-2026!', count: null, group: 'users' },
  admin: { username: 'admin', password: 'password123' },
  stages: [{ name: 'smoke', vus: 2, rampSec: 10, holdSec: 60 }],
  gracefulStopSec: 120,
  // Open-ended capacity runs: end the ramp after this many failing load levels.
  stopOnFailure: false,
  failuresBeforeStop: 1,
  // Share of sessions that start with a page load (new tab / reload).
  pageLoadProbability: 0.3,
  // Rate-limit recommendation: how many concurrent users may share one client
  // IP (corporate NAT / proxy without X-Forwarded-For). null = target or capacity.
  rateLimitUsersPerIp: null,
  thinkTimeSec: [20, 60],
  sessionPauseSec: [10, 40],
  turnTimeoutSec: 300,
  streamIdleTimeoutSec: 120,
  loginConcurrency: 4,
  mix: { chat: 45, chatFile: 15, projectChat: 30, projectBuild: 5, browse: 5, inference: 0 },
  scenarios: {
    chat: { turns: [2, 5], ephemeral: false },
    chatFile: { turns: [2, 4], maxFileBytes: 10_000_000, ephemeral: false },
    projectChat: { turns: [3, 6], preferShared: 0.5, ephemeral: false },
    projectBuild: {
      files: [3, 8],
      uploadParallel: 2,
      maxFileBytes: 12_000_000,
      ingestTimeoutSec: 600,
      chatTurns: 2,
      deleteAfter: true,
      crawl: {
        url: 'https://intrafind.com/de',
        maxPages: 30,
        maxDepth: 2,
        addPages: 10,
        maxConcurrent: 2
      }
    },
    inference: { requests: [3, 10], pauseSec: [2, 10], model: null }
  },
  setup: {
    enableFeatures: true,
    sharedProjects: 5,
    ownProjects: true,
    // Cap: at 2,000 users one project each would mean 12,000 uploads before the test.
    ownProjectsMax: 200,
    docsPerProject: 6,
    // Real LLM: registered as model `loadtest-gpu` when `url` is set. The model
    // name is discovered from the server's /v1/models unless `modelName` is given.
    gpu: {
      id: 'loadtest-gpu',
      url: 'https://gpu-01.local.intrafind.io',
      modelName: null,
      apiKey: null,
      provider: 'local',
      // gpu-01 serves Qwen/Qwen3.6-35B-A3B-FP8 with max_model_len 173184; setup
      // takes the discovered value when the server reports one.
      contextWindow: 173184,
      // Room for Qwen3's thinking tokens before the answer.
      maxOutputTokens: 4096,
      // 'auto' lets project chats call the knowledge_* tools (vLLM must run with
      // --enable-auto-tool-choice); 'none' keeps every turn a single LLM call.
      supportsTools: 'auto',
      // iHub's own queue in front of the model (1–100). The platform default of 5
      // would make iHub, not the GPU, the limit.
      concurrency: 100
    },
    // Paced fake LLM (stub/server.mjs) for measuring iHub itself: model `loadtest-stub`.
    // Same context window as the GPU model, so project chats inject as much text.
    stub: { id: 'loadtest-stub', url: null, contextWindow: 173184, maxOutputTokens: 4096 }
  },
  llm: { expectedTtftMs: null },
  server: { workers: null, vcpus: null },
  sampling: {
    intervalSec: 5,
    server: true,
    stubStatsUrl: null,
    // vLLM's own /metrics. "auto" = <setup.gpu.url>/metrics when the run uses loadtest-gpu.
    vllmMetricsUrl: 'auto',
    // Prometheus, or Grafana's datasource proxy:
    //   https://grafana.example/api/datasources/proxy/uid/<prometheus-uid>  + service account token
    prometheus: {
      url: null,
      token: null,
      namespace: 'ihub',
      podRegex: 'ihub.*',
      gpuSelector: '',
      queries: {}
    }
  },
  slo: {
    ttftP95Ms: null,
    ttftOverheadP95Ms: 1500,
    apiP95Ms: 500,
    turnErrorPct: 1,
    httpErrorPct: 2,
    workerCpuAvgPct: 80,
    eventLoopDelayMaxMs: 150,
    ingestReadyP95Sec: 180
  },
  sizing: { targetConcurrentUsers: null, headroom: 0.7, concurrencyRatio: 0.1 },
  fixtures: { dir: null },
  results: { dir: path.join(LOAD_DIR, 'results'), toStdout: false },
  runId: null,
  shard: { index: 0, count: 1 }
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadProfile(nameOrPath) {
  if (!nameOrPath) return {};
  const candidates = [nameOrPath, path.join(LOAD_DIR, 'profiles', `${nameOrPath}.json`)];
  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
  throw new Error(`Profile not found: ${nameOrPath}`);
}

/** "10:60:240,20:60:240" → stages (vus:rampSec:holdSec) */
function parseStages(spec) {
  return spec.split(',').map((part, i) => {
    const [vus, rampSec, holdSec] = part.split(':').map(Number);
    return { name: `stage-${i + 1}`, vus, rampSec: rampSec || 0, holdSec: holdSec || 0 };
  });
}

/** "chat=50,projectChat=30" → mix */
function parseMix(spec) {
  return Object.fromEntries(
    spec.split(',').map(p => {
      const [k, v] = p.split('=');
      return [k.trim(), Number(v)];
    })
  );
}

const num = v => (v === undefined || v === '' ? undefined : Number(v));

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      args[k] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    }
  }
  const profileName = args.profile || env.LT_PROFILE || 'smoke';
  const profile = loadProfile(profileName);
  let cfg = deepMerge(structuredClone(DEFAULTS), profile);
  // A profile's mix is the whole mix: scenarios it leaves out do not run.
  if (profile.mix) {
    cfg.mix = { ...Object.fromEntries(Object.keys(DEFAULTS.mix).map(k => [k, 0])), ...profile.mix };
  }

  const set = (pathKeys, value) => {
    if (value === undefined || value === null || value === '') return;
    let o = cfg;
    for (const k of pathKeys.slice(0, -1)) o = o[k] ??= {};
    o[pathKeys.at(-1)] = value;
  };

  set(['baseUrl'], args['base-url'] || env.LT_BASE_URL);
  set(['appId'], args.app || env.LT_APP_ID);
  set(['modelId'], args.model || env.LT_MODEL_ID);
  if (env.LT_THINKING === 'on' || env.LT_THINKING === 'true') cfg.thinking = true;
  if (env.LT_THINKING === 'off' || env.LT_THINKING === 'false') cfg.thinking = false;
  set(['users', 'prefix'], env.LT_USER_PREFIX);
  set(['users', 'password'], env.LT_USER_PASSWORD);
  set(['users', 'count'], num(args.users || env.LT_USER_COUNT));
  set(['admin', 'username'], env.LT_ADMIN_USER);
  set(['admin', 'password'], env.LT_ADMIN_PASSWORD);
  set(['shard', 'index'], num(args.shard ?? env.LT_SHARD_INDEX ?? env.JOB_COMPLETION_INDEX));
  set(['shard', 'count'], num(args.shards || env.LT_SHARD_COUNT));
  set(['scenarios', 'projectBuild', 'crawl', 'url'], args['crawl-url'] || env.LT_CRAWL_URL);
  set(['fixtures', 'dir'], args.fixtures || env.LT_FIXTURES_DIR);
  set(['results', 'dir'], args.results || env.LT_RESULTS_DIR);
  set(
    ['results', 'toStdout'],
    env.LT_RESULT_TO_STDOUT === '1' || env.LT_RESULT_TO_STDOUT === 'true' || undefined
  );
  set(['runId'], args['run-id'] || env.LT_RUN_ID);
  set(['llm', 'expectedTtftMs'], num(env.LT_EXPECTED_LLM_TTFT_MS));
  set(['server', 'workers'], num(args.workers || env.LT_SERVER_WORKERS));
  set(['server', 'vcpus'], num(env.LT_SERVER_VCPUS));
  set(['sampling', 'stubStatsUrl'], env.LT_STUB_STATS_URL);
  set(['sampling', 'vllmMetricsUrl'], env.LT_VLLM_METRICS_URL);
  set(['sampling', 'prometheus', 'url'], env.LT_PROM_URL);
  set(['sampling', 'prometheus', 'token'], env.LT_PROM_TOKEN);
  set(['sampling', 'prometheus', 'namespace'], env.LT_PROM_IHUB_NAMESPACE);
  set(['sampling', 'prometheus', 'podRegex'], env.LT_PROM_IHUB_POD_REGEX);
  set(['sampling', 'prometheus', 'gpuSelector'], env.LT_PROM_GPU_SELECTOR);
  if (env.LT_STOP_ON_FAILURE)
    cfg.stopOnFailure = env.LT_STOP_ON_FAILURE === '1' || env.LT_STOP_ON_FAILURE === 'true';
  set(['rateLimitUsersPerIp'], num(env.LT_USERS_PER_IP));
  set(['sizing', 'targetConcurrentUsers'], num(args.target || env.LT_TARGET_CONCURRENT_USERS));
  set(['setup', 'stub', 'url'], args['stub-url'] || env.LT_STUB_MODEL_URL);
  set(['setup', 'gpu', 'url'], args['llm-url'] || env.LT_LLM_URL);
  set(['setup', 'gpu', 'modelName'], env.LT_LLM_MODEL_NAME);
  set(['setup', 'gpu', 'apiKey'], env.LT_LLM_API_KEY);
  set(['setup', 'gpu', 'supportsTools'], env.LT_LLM_SUPPORTS_TOOLS);
  set(['setup', 'gpu', 'concurrency'], num(env.LT_LLM_CONCURRENCY));
  set(['setup', 'gpu', 'contextWindow'], num(env.LT_LLM_CONTEXT_WINDOW));
  set(['setup', 'docsPerProject'], num(env.LT_DOCS_PER_PROJECT));
  set(['setup', 'sharedProjects'], num(env.LT_SHARED_PROJECTS));
  set(['setup', 'ownProjectsMax'], num(env.LT_OWN_PROJECTS_MAX));
  set(['scenarios', 'projectBuild', 'crawl', 'maxConcurrent'], num(env.LT_CRAWL_MAX_CONCURRENT));
  // LT_LLM_URL= (empty) or "none" skips registering the GPU model.
  if (args['llm-url'] === 'none' || env.LT_LLM_URL === '' || env.LT_LLM_URL === 'none')
    cfg.setup.gpu.url = null;
  if (env.LT_SAMPLE_SERVER === '0' || env.LT_SAMPLE_SERVER === 'false') cfg.sampling.server = false;

  const stagesSpec = args.stages || env.LT_STAGES;
  if (stagesSpec) cfg.stages = parseStages(stagesSpec);
  const mixSpec = args.mix || env.LT_MIX;
  if (mixSpec)
    cfg.mix = deepMerge(
      Object.fromEntries(Object.keys(cfg.mix).map(k => [k, 0])),
      parseMix(mixSpec)
    );
  const scale = num(args['vu-scale'] || env.LT_VU_SCALE);
  if (scale)
    cfg.stages = cfg.stages.map(s => ({ ...s, vus: Math.max(1, Math.round(s.vus * scale)) }));

  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  if (cfg.sampling.vllmMetricsUrl === 'auto') {
    const gpu = cfg.setup.gpu?.url;
    const stubStats = cfg.sampling.stubStatsUrl;
    if (gpu && cfg.modelId === cfg.setup.gpu.id) {
      cfg.sampling.vllmMetricsUrl = `${gpu.replace(/\/+$/, '').replace(/\/v1(\/chat\/completions)?$/, '')}/metrics`;
    } else if (stubStats && cfg.modelId === cfg.setup.stub?.id) {
      // The stub publishes the same vLLM metric names.
      cfg.sampling.vllmMetricsUrl = stubStats.replace(/\/__stats$/, '/metrics');
    } else cfg.sampling.vllmMetricsUrl = null;
  } else if (cfg.sampling.vllmMetricsUrl === 'none') cfg.sampling.vllmMetricsUrl = null;
  cfg.maxVus = Math.max(...cfg.stages.map(s => s.vus));
  if (!cfg.users.count) cfg.users.count = cfg.maxVus;
  if (!cfg.runId)
    cfg.runId = `${cfg.name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  cfg.args = args;
  return cfg;
}

export function userName(cfg, index) {
  return `${cfg.users.prefix}${String(index + 1).padStart(4, '0')}`;
}

/** Config without secrets, for the result file. */
export function publicConfig(cfg) {
  const { admin, users, args: _args, setup, ...rest } = cfg;
  return {
    ...rest,
    setup: { ...setup, gpu: { ...setup.gpu, apiKey: setup.gpu?.apiKey ? '***' : null } },
    sampling: {
      ...rest.sampling,
      prometheus: {
        ...rest.sampling.prometheus,
        token: rest.sampling.prometheus?.token ? '***' : null
      }
    },
    users: { prefix: users.prefix, count: users.count },
    admin: { username: admin.username }
  };
}
