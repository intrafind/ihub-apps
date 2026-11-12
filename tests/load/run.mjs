#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iHub load test runner.
 *
 *   node tests/load/run.mjs --profile smoke
 *   LT_BASE_URL=https://ihub.example.com LT_PROFILE=capacity-stub node tests/load/run.mjs
 *
 * Prerequisite: `node tests/load/setup.mjs` (users, projects, models, flags).
 * One process is one shard; in Kubernetes an Indexed Job runs N shards that
 * together produce the profile's VU counts (LT_SHARD_COUNT, JOB_COMPLETION_INDEX).
 * Results: <results.dir>/<runId>/shard-<k>.json, plus report.md when 1 shard.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { loadConfig, userName, publicConfig } from './lib/config.mjs';
import { Metrics } from './lib/metrics.mjs';
import { Client, login } from './lib/http.mjs';
import { loadFixtures } from './lib/fixtures.mjs';
import { listProjects } from './lib/projects.mjs';
import { runSchedule, buildTimeline } from './lib/scheduler.mjs';
import { startSamplers } from './lib/sampler.mjs';
import { renderMarkdown, timelineCsv } from './lib/report.mjs';
import {
  between,
  pick,
  pickWeighted,
  sleep,
  mapLimit,
  withRetry,
  log,
  Semaphore
} from './lib/util.mjs';
import chat from './scenarios/chat.mjs';
import chatFile from './scenarios/chatFile.mjs';
import projectChat from './scenarios/projectChat.mjs';
import projectBuild from './scenarios/projectBuild.mjs';
import browse from './scenarios/browse.mjs';
import inference from './scenarios/inference.mjs';

const SCENARIOS = { chat, chatFile, projectChat, projectBuild, browse, inference };

const cfg = loadConfig();
const { index: shardIndex, count: shardCount } = cfg.shard;
const metrics = new Metrics();
const outDir = path.join(cfg.results.dir, cfg.runId);

for (const name of Object.keys(cfg.mix)) {
  if (cfg.mix[name] > 0 && !SCENARIOS[name]) throw new Error(`Unknown scenario in mix: ${name}`);
}

log(
  `profile ${cfg.name} · shard ${shardIndex + 1}/${shardCount} · target ${cfg.baseUrl} · app ${cfg.appId} · model ${cfg.modelId || '(app default)'}`
);
const timelinePreview = buildTimeline(cfg.stages);
const totalSec = Math.round(timelinePreview.at(-1).hold.end / 1000);
log(
  `stages: ${cfg.stages.map(s => `${s.vus}VU`).join(' → ')} · ${Math.round(totalSec / 60)} min · mix ${JSON.stringify(cfg.mix)}`
);

// --- preflight -----------------------------------------------------------
const probe = new Client({ baseUrl: cfg.baseUrl });
const health = await probe
  .get('/api/health', { timeoutMs: 15_000 })
  .catch(err => ({ status: 0, body: err.message }));
if (health.status !== 200) {
  console.error(`Health check failed (${health.status}): ${JSON.stringify(health.body)}`);
  process.exit(2);
}
log(`server ${health.body?.version || '?'} healthy`);

const fixtures = loadFixtures(cfg.fixtures.dir);
log(
  `fixtures: ${fixtures.length} files, ${(fixtures.reduce((a, f) => a + f.buffer.length, 0) / 1048576).toFixed(1)} MB${cfg.fixtures.dir ? ` from ${cfg.fixtures.dir}` : ' (generated)'}`
);

// --- log in this shard's users before the clock starts -------------------
const ownedVus = [];
for (let i = shardIndex; i < cfg.maxVus; i += shardCount) ownedVus.push(i);
const userIndexes = [...new Set(ownedVus.map(i => i % cfg.users.count))];
if (cfg.users.count < cfg.maxVus) {
  log(
    `note: ${cfg.maxVus} VUs share ${cfg.users.count} users — VUs of the same user run concurrently`
  );
}

async function loginUser(idx) {
  const username = userName(cfg, idx);
  const { client } = await withRetry(
    () => login({ baseUrl: cfg.baseUrl, username, password: cfg.users.password }),
    { label: `login ${username}` }
  );
  client.metrics = metrics;
  let projects = { own: [], shared: [] };
  try {
    const items = (await listProjects(client)).filter(p => String(p.name).startsWith('LT-chat'));
    const own = items.filter(p => p.permissions?.isOwner === true);
    projects = { own, shared: items.filter(p => !own.includes(p)) };
  } catch (err) {
    log(`warning: cannot list projects for ${username}: ${err.message}`);
  }
  return { idx, username, client, projects };
}

const t0Login = performance.now();
const sessions = new Map();
await mapLimit(userIndexes, cfg.loginConcurrency, async idx => {
  sessions.set(idx, await loginUser(idx));
});
const withProjects = [...sessions.values()].filter(
  s => s.projects.own.length + s.projects.shared.length > 0
).length;
log(
  `logged in ${sessions.size} users in ${((performance.now() - t0Login) / 1000).toFixed(1)} s · ${withProjects} see LT-chat projects`
);
if (cfg.mix.projectChat > 0 && withProjects === 0) {
  console.error(
    'projectChat is in the mix but no user sees an LT-chat project. Run setup.mjs first.'
  );
  process.exit(2);
}

// --- samplers (only shard 0 polls the server) ----------------------------
let adminClient = null;
if (shardIndex === 0 && cfg.sampling.server) {
  try {
    ({ client: adminClient } = await login({
      baseUrl: cfg.baseUrl,
      username: cfg.admin.username,
      password: cfg.admin.password
    }));
  } catch (err) {
    log(`warning: admin login failed (${err.message}); no server resource samples`);
  }
}
const samplers = startSamplers({ cfg, metrics, adminClient });

// --- virtual users --------------------------------------------------------
const crawlGate = new Semaphore(cfg.scenarios.projectBuild?.crawl?.maxConcurrent || 2);

async function runVu(vuIndex, isActive) {
  const session = sessions.get(vuIndex % cfg.users.count);
  const ctx = {
    config: cfg,
    client: session.client,
    metrics,
    fixtures,
    projects: session.projects,
    user: { username: session.username, index: session.idx },
    crawlGate,
    isActive,
    sleep,
    between,
    pick,
    think: () => sleep(between(cfg.thinkTimeSec) * 1000)
  };
  await sleep(Math.random() * 3000);
  while (isActive()) {
    const name = pickWeighted(cfg.mix);
    const t0 = performance.now();
    try {
      await SCENARIOS[name](ctx);
      metrics.count(`session.${name}.ok`);
      metrics.trend(`session.${name}.duration`, performance.now() - t0);
    } catch (err) {
      metrics.count(`session.${name}.error`);
      metrics.error(`session.${name}`, err.code || (err.status ? `HTTP_${err.status}` : err.name));
      if (err.status === 401) {
        const fresh = await loginUser(session.idx).catch(() => null);
        if (fresh) {
          session.client = fresh.client;
          ctx.client = fresh.client;
        }
      }
      await sleep(5000);
    }
    await sleep(between(cfg.sessionPauseSec) * 1000);
  }
}

let lastLog = 0;
const result = await runSchedule({
  stages: cfg.stages,
  shardIndex,
  shardCount,
  metrics,
  runVu,
  gracefulStopSec: cfg.gracefulStopSec,
  onTick: ({ elapsed, target, stage, active }) => {
    if (elapsed - lastLog < 30_000) return;
    lastLog = elapsed;
    const c = metrics.counts;
    const total = name => Object.values(c[name] || {}).reduce((a, b) => a + b, 0);
    const ok = ['chat', 'chatFile', 'projectChat', 'projectBuildChat', 'inference'].reduce(
      (a, l) => a + total(`${l}.turn.ok`),
      0
    );
    const err = ['chat', 'chatFile', 'projectChat', 'projectBuildChat', 'inference'].reduce(
      (a, l) => a + total(`${l}.turn.error`),
      0
    );
    log(
      `t=${Math.round(elapsed / 1000)}s/${totalSec}s stage ${stage} · target ${target} VUs (this shard ${active}) · turns ok ${ok} err ${err}`
    );
  }
});
samplers.stop();
if (result.abandonedVus)
  log(`warning: ${result.abandonedVus} VUs still busy after the graceful stop`);

// --- results --------------------------------------------------------------
const shardResult = {
  meta: {
    config: publicConfig(cfg),
    shardIndex,
    shardCount,
    shards: shardCount,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    timeline: result.timeline,
    serverInfo: samplers.serverInfo
  },
  metrics: metrics.toJSON()
};
fs.mkdirSync(outDir, { recursive: true });
const shardFile = path.join(outDir, `shard-${shardIndex}.json`);
fs.writeFileSync(shardFile, JSON.stringify(shardResult));
log(`wrote ${shardFile}`);

if (cfg.results.toStdout) {
  // For Kubernetes: `kubectl logs` is the collection channel (see k8s/collect.sh).
  const b64 = zlib.gzipSync(JSON.stringify(shardResult)).toString('base64');
  const size = 60_000;
  for (let i = 0; i * size < b64.length; i++) {
    console.log(
      `##LT-RESULT## ${cfg.runId} ${shardIndex} ${i} ${Math.ceil(b64.length / size)} ${b64.slice(i * size, (i + 1) * size)}`
    );
  }
}

if (shardCount === 1) {
  const { markdown } = renderMarkdown(shardResult);
  fs.writeFileSync(path.join(outDir, 'report.md'), markdown);
  fs.writeFileSync(path.join(outDir, 'timeline.csv'), timelineCsv(shardResult));
  console.log(`\n${markdown}`);
  log(`report: ${path.join(outDir, 'report.md')}`);
} else {
  log(`merge all shards with: node tests/load/report.mjs ${outDir}`);
}
process.exit(0);
