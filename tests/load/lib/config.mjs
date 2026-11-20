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
  mix: {
    chat: 45,
    chatFile: 15,
    projectChat: 30,
    projectBuild: 5,
    browse: 5,
    inference: 0,
    agentTurn: 0
  },
  scenarios: {
    chat: { turns: [2, 5], ephemeral: false },
    chatFile: { turns: [2, 4], maxFileBytes: 10_000_000, ephemeral: false },
    projectChat: { turns: [3, 6], preferShared: 0.5, hotShare: 0, ephemeral: false },
    projectBuild: {
      files: [3, 8],
      uploadParallel: 2,
      maxFileBytes: 12_000_000,
      ingestTimeoutSec: 600,
      chatTurns: 2,
      deleteAfter: true,
      crawl: {
        // The stub site (stub/server.mjs) as iHub reaches it in docker-compose.yml.
        url: 'http://loadtest-stubs:8980/docs/', // NOSONAR: the local stub site, no TLS
        maxPages: 30,
        maxDepth: 2,
        addPages: 10,
        maxConcurrent: 2
      }
    },
    inference: { requests: [3, 10], pauseSec: [2, 10], model: null },
    // A turn with tool rounds (scenarios/agentTurn.mjs), in the app and on the model
    // that setup.mjs registers for it (`setup.agent`). `tool` is one that only reads
    // and needs no network. `requireToolRounds`: a turn that ran fewer tool calls
    // than asked for counts as failed; switch it off for a real model, which decides
    // for itself whether to call a tool.
    agentTurn: {
      turns: [2, 4],
      toolRounds: [1, 3],
      tool: 'list_scheduled_tasks',
      requireToolRounds: true,
      ephemeral: false
    }
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
    // Several GPUs: `gpus` (URLs or { url, modelName, … }) or LT_LLM_URLS. Each one
    // becomes its own model, loadtest-gpu, loadtest-gpu-2, …; `gpu` holds the defaults.
    gpus: null,
    gpu: {
      id: 'loadtest-gpu',
      url: null, // LT_LLM_URL
      modelName: null,
      apiKey: null,
      provider: 'local',
      // Qwen/Qwen3.6-35B-A3B-FP8 served with max_model_len 173184; setup
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
    stub: { id: 'loadtest-stub', url: null, contextWindow: 173184, maxOutputTokens: 4096 },
    // For the `agentTurn` scenario, registered when it is in the mix: the same stub
    // as a model that is offered tools, and an app that binds iHub's own tools.
    agent: { appId: 'loadtest-agent', modelId: 'loadtest-stub-agent' }
  },
  llm: { expectedTtftMs: null },
  server: { workers: null, vcpus: null },
  sampling: {
    intervalSec: 5,
    server: true,
    stubStatsUrl: null,
    // vLLM's own /metrics. "auto" = <url>/metrics of every GPU model the run uses.
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
  const gpuUrls = args['llm-urls'] || env.LT_LLM_URLS;
  set(['setup', 'gpu', 'modelName'], env.LT_LLM_MODEL_NAME);
  set(['setup', 'gpu', 'apiKey'], env.LT_LLM_API_KEY);
  set(['setup', 'gpu', 'supportsTools'], env.LT_LLM_SUPPORTS_TOOLS);
  set(['setup', 'gpu', 'concurrency'], num(env.LT_LLM_CONCURRENCY));
  set(['setup', 'gpu', 'contextWindow'], num(env.LT_LLM_CONTEXT_WINDOW));
  set(['scenarios', 'projectChat', 'preferShared'], num(env.LT_PREFER_SHARED));
  set(['scenarios', 'projectChat', 'hotShare'], num(env.LT_HOT_SHARE));
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

  // GPU endpoints: LT_LLM_URLS, else LT_LLM_URL (one GPU), else setup.gpus, else setup.gpu.url.
  const gpuList = gpuUrls
    ? gpuUrls.split(',')
    : args['llm-url'] || env.LT_LLM_URL !== undefined || !cfg.setup.gpus
      ? [cfg.setup.gpu.url]
      : cfg.setup.gpus;
  const baseId = cfg.setup.gpu.id;
  cfg.setup.gpus = gpuList
    .map(e => (typeof e === 'string' ? { url: e.trim() } : e))
    .filter(e => e?.url && e.url !== 'none')
    .map((e, i) => ({
      ...cfg.setup.gpu,
      // A served name set for the first GPU does not fit the others: they discover theirs.
      ...(i > 0 ? { modelName: null } : {}),
      ...e,
      id: i === 0 ? baseId : `${baseId}-${i + 1}`
    }));
  cfg.setup.gpu.url = cfg.setup.gpus[0]?.url ?? null;
  // Spread over the GPU models: LT_MODEL_ID=loadtest-gpu-*, or loadtest-gpu while
  // several GPUs are configured. Each VU keeps one model (see modelForVu).
  const gpuIds = cfg.setup.gpus.map(g => g.id);
  if (cfg.modelId === `${baseId}-*` && !gpuIds.length)
    throw new Error(`${cfg.modelId}: no GPU configured (LT_LLM_URLS)`);
  cfg.vuModelIds =
    cfg.modelId === `${baseId}-*` || (gpuIds.length > 1 && cfg.modelId === baseId) ? gpuIds : null;

  // vLLM metrics targets: [{ id, url }]; id labels the gauges when there are several.
  const metricsUrl = cfg.sampling.vllmMetricsUrl;
  cfg.sampling.vllmTargets = [];
  if (metricsUrl === 'auto') {
    const used = cfg.vuModelIds ? cfg.setup.gpus : cfg.setup.gpus.filter(g => g.id === cfg.modelId);
    const stubStats = cfg.sampling.stubStatsUrl;
    if (used.length) {
      cfg.sampling.vllmTargets = used.map(g => ({
        id: used.length > 1 ? g.id : null,
        url: `${g.url.replace(/\/+$/, '').replace(/\/v1(\/chat\/completions)?$/, '')}/metrics`
      }));
    } else if (stubStats && cfg.modelId === cfg.setup.stub?.id) {
      // The stub publishes the same vLLM metric names.
      cfg.sampling.vllmTargets = [{ id: null, url: stubStats.replace(/\/__stats$/, '/metrics') }];
    }
  } else if (metricsUrl && metricsUrl !== 'none') {
    cfg.sampling.vllmTargets = [{ id: null, url: metricsUrl }];
  }
  cfg.maxVus = Math.max(...cfg.stages.map(s => s.vus));
  if (!cfg.users.count) cfg.users.count = cfg.maxVus;
  if (!cfg.runId)
    cfg.runId = `${cfg.name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  cfg.args = args;
  return cfg;
}

/** The model a VU uses for all its turns: round robin over the GPU models when spreading. */
export function modelForVu(cfg, vuIndex) {
  return cfg.vuModelIds ? cfg.vuModelIds[vuIndex % cfg.vuModelIds.length] : cfg.modelId;
}

export function userName(cfg, index) {
  return `${cfg.users.prefix}${String(index + 1).padStart(4, '0')}`;
}

/** Config without secrets, for the result file. */
export function publicConfig(cfg) {
  const { admin, users, args: _args, setup, ...rest } = cfg;
  return {
    ...rest,
    setup: {
      ...setup,
      gpu: { ...setup.gpu, apiKey: setup.gpu?.apiKey ? '***' : null },
      gpus: (setup.gpus || []).map(g => ({ ...g, apiKey: g.apiKey ? '***' : null }))
    },
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
