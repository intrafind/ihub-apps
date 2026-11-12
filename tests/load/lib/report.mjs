// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Turns merged shard results into per-stage numbers, an SLO verdict per stage,
 * the capacity (largest load level that met every SLO) and a sizing estimate:
 * concurrent users per worker → workers, vCPU and RAM for a target.
 */

import { summarize, round } from './metrics.mjs';

const CHAT_LABELS = ['chat', 'chatFile', 'projectChat', 'projectBuildChat', 'inference'];
const TTFT_LABELS = ['chat', 'chatFile', 'projectChat', 'projectBuildChat'];

const sum = (counts, name, stage) => counts[name]?.[stage] || 0;
const values = (trends, name, stage) => trends[name]?.[stage] || [];

function gaugeValues(gauges, pattern, stage) {
  const out = [];
  for (const [name, samples] of Object.entries(gauges)) {
    if (!pattern.test(name)) continue;
    for (const [, s, v] of samples) if (String(s) === String(stage)) out.push(v);
  }
  return out;
}

const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const max = arr => (arr.length ? Math.max(...arr) : null);
const fmt = (v, d = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : round(v, d).toLocaleString('en-US');

export function stageStats(result) {
  const { meta, metrics } = result;
  const { trends, counts, gauges } = metrics;
  const cfg = meta.config;
  return meta.timeline.map(stage => {
    const k = String(stage.index);
    const holdMin = (stage.hold.end - stage.hold.start) / 60000;
    let ok = 0;
    let err = 0;
    for (const l of CHAT_LABELS) {
      ok += sum(counts, `${l}.turn.ok`, k);
      err += sum(counts, `${l}.turn.error`, k);
    }
    const ttftAll = TTFT_LABELS.flatMap(l => values(trends, `${l}.ttft`, k));
    const ttft = summarize(ttftAll);
    const byLabel = Object.fromEntries(
      [...TTFT_LABELS, 'inference'].map(l => [l, summarize(values(trends, `${l}.ttft`, k))])
    );
    const duration = summarize(TTFT_LABELS.flatMap(l => values(trends, `${l}.duration`, k)));
    const firstToken = summarize(TTFT_LABELS.flatMap(l => values(trends, `${l}.firstToken`, k)));
    const g = re => gaugeValues(gauges, re, k);
    const api = summarize(
      Object.keys(trends)
        .filter(n => n.startsWith('http.browse.'))
        .flatMap(n => values(trends, n, k))
    );
    let httpTotal = 0;
    let httpErr = 0;
    const errorCodes = {};
    for (const [name, byStage] of Object.entries(counts)) {
      const n = byStage[k] || 0;
      if (!n) continue;
      const m = /^http\.(.+)\.status\.(\d+)$/.exec(name);
      if (m && m[1] !== 'auth.login') {
        httpTotal += n;
        if (Number(m[2]) >= 400) httpErr += n;
      }
      if (name.startsWith('error.')) errorCodes[name.slice(6)] = n;
    }
    const workerCpu = gaugeValues(gauges, /^server\.cpu\.(w\d+|standalone)$/, k);
    const primaryCpu = gaugeValues(gauges, /^server\.cpu\.primary$/, k);
    const eld = gaugeValues(gauges, /^server\.eld\.(w\d+|standalone)$/, k);
    // Per-interval maxima; the p95 of them ignores a single GC pause.
    const eldPeaks = gaugeValues(gauges, /^server\.eldmax\.(w\d+|standalone)$/, k);
    const rss = gaugeValues(gauges, /^server\.rss\.(w\d+|standalone)$/, k);
    const rssPrimary = gaugeValues(gauges, /^server\.rss\.primary$/, k);
    const expected = cfg.llm?.expectedTtftMs;
    return {
      index: stage.index,
      name: stage.name,
      vus: stage.vus,
      holdMin,
      turns: {
        ok,
        err,
        perMin: holdMin > 0 ? (ok + err) / holdMin : null,
        errorPct: ok + err ? (err / (ok + err)) * 100 : 0
      },
      ttft,
      ttftOverheadP95: ttft && Number.isFinite(expected) ? ttft.p95 - expected : null,
      byLabel,
      duration,
      api,
      chatUpload: summarize(values(trends, 'http.chatFile.upload', k)),
      projectUpload: summarize(values(trends, 'http.project.upload', k)),
      ingestReady: summarize(values(trends, 'project.ingestReady', k)),
      crawl: summarize(values(trends, 'http.project.crawl', k)),
      addUrl: summarize(values(trends, 'http.project.addUrl', k)),
      promptTokens: summarize(values(trends, 'projectChat.promptTokens', k)),
      tools: summarize(values(trends, 'projectChat.tools', k)),
      streamMiss: TTFT_LABELS.reduce((a, l) => a + sum(counts, `${l}.streamMiss`, k), 0),
      http: { total: httpTotal, errorPct: httpTotal ? (httpErr / httpTotal) * 100 : 0 },
      errorCodes,
      server: {
        workerCpuAvg: avg(workerCpu),
        workerCpuMax: max(workerCpu),
        primaryCpuAvg: avg(primaryCpu),
        eldMax: eldPeaks.length ? summarize(eldPeaks).p95 : max(eld),
        eldAvg: avg(eld),
        rssMaxMb: max(rss),
        rssPrimaryMaxMb: max(rssPrimary),
        workers: max(gaugeValues(gauges, /^server\.workerCount$/, k))
      },
      runner: {
        eldP99Max: max(gaugeValues(gauges, /^runner\.eldP99$/, k)),
        cpuMax: max(gaugeValues(gauges, /^runner\.cpuPercent$/, k))
      },
      stubInflightMax: max(gaugeValues(gauges, /^stub\.inflight$/, k)),
      firstToken,
      llm: {
        runningAvg: avg(g(/^llm\.running$/)),
        runningMax: max(g(/^llm\.running$/)),
        waitingAvg: avg(g(/^llm\.waiting$/)),
        waitingMax: max(g(/^llm\.waiting$/)),
        kvCacheMax: max(g(/^llm\.kvCachePct$/)),
        genTokPerSec: avg(g(/^llm\.genTokPerSec$/)),
        promptTokPerSec: avg(g(/^llm\.promptTokPerSec$/)),
        preemptionsPerMin: avg(g(/^llm\.preemptionsPerSec$/)) * 60 || null,
        gpuUtilAvg: avg(g(/^prom\.gpuUtilPct$/)),
        gpuMemMax: max(g(/^prom\.gpuMemUsedPct$/))
      },
      pod: {
        cpuCoresAvg: avg(g(/^prom\.ihubCpuCores$/)),
        cpuCoresMax: max(g(/^prom\.ihubCpuCores$/)),
        throttledPctAvg: avg(g(/^prom\.ihubCpuThrottledPct$/)),
        memoryMbMax: max(g(/^prom\.ihubMemoryMb$/)),
        podsReady: max(g(/^prom\.ihubPodsReady$/))
      }
    };
  });
}

export function checkSlo(stat, slo) {
  const v = [];
  if (slo.ttftP95Ms && stat.ttft && stat.ttft.p95 > slo.ttftP95Ms)
    v.push(`TTFT p95 ${fmt(stat.ttft.p95)} ms > ${slo.ttftP95Ms}`);
  if (
    slo.ttftOverheadP95Ms &&
    stat.ttftOverheadP95 !== null &&
    stat.ttftOverheadP95 > slo.ttftOverheadP95Ms
  )
    v.push(`TTFT overhead p95 ${fmt(stat.ttftOverheadP95)} ms > ${slo.ttftOverheadP95Ms}`);
  if (slo.apiP95Ms && stat.api && stat.api.p95 > slo.apiP95Ms)
    v.push(`API p95 ${fmt(stat.api.p95)} ms > ${slo.apiP95Ms}`);
  if (slo.turnErrorPct != null && stat.turns.errorPct > slo.turnErrorPct)
    v.push(`turn errors ${fmt(stat.turns.errorPct, 2)}% > ${slo.turnErrorPct}%`);
  if (slo.httpErrorPct != null && stat.http.errorPct > slo.httpErrorPct)
    v.push(`HTTP errors ${fmt(stat.http.errorPct, 2)}% > ${slo.httpErrorPct}%`);
  if (slo.workerCpuAvgPct && stat.server.workerCpuAvg > slo.workerCpuAvgPct)
    v.push(`worker CPU avg ${fmt(stat.server.workerCpuAvg)}% > ${slo.workerCpuAvgPct}%`);
  if (slo.eventLoopDelayMaxMs && stat.server.eldMax > slo.eventLoopDelayMaxMs)
    v.push(`event-loop delay peak p95 ${fmt(stat.server.eldMax)} ms > ${slo.eventLoopDelayMaxMs}`);
  if (
    slo.ingestReadyP95Sec &&
    stat.ingestReady &&
    stat.ingestReady.p95 / 1000 > slo.ingestReadyP95Sec
  )
    v.push(`ingest ready p95 ${fmt(stat.ingestReady.p95 / 1000)} s > ${slo.ingestReadyP95Sec}`);
  if (stat.turns.ok + stat.turns.err === 0) v.push('no chat turns completed');
  return v;
}

function bottleneckHint(stat) {
  if (!stat) return null;
  const codes = Object.keys(stat.errorCodes).join(' ');
  if (/HTTP_429|RATE_LIMIT/.test(codes))
    return 'HTTP 429s: rate limits are throttling the test — raise rateLimit.* (see README) and rerun; this is not capacity.';
  if (/AI_ACKNOWLEDGEMENT/.test(codes))
    return 'AI-use acknowledgement blocks chats — acknowledge in setup or set aiAcknowledgement.enforce=false.';
  if (/LOCK_TIMEOUT|HTTP_503/.test(codes))
    return 'Storage lock timeouts (503): filesystem persistence contention — check disk/NFS latency; more CPU will not help.';
  if (stat.runner.eldP99Max > 100)
    return 'The load generator itself is saturated (event-loop p99 > 100 ms) — add runner shards; these numbers are not trustworthy.';
  if (stat.llm.waitingAvg > 1 || stat.llm.kvCacheMax > 95)
    return `GPU saturated: vLLM queues requests (waiting avg ${fmt(stat.llm.waitingAvg, 1)}, KV cache max ${fmt(stat.llm.kvCacheMax)}%) — the LLM is the limit, not iHub. More GPU capacity, smaller project context or fewer thinking tokens.`;
  if (stat.pod.throttledPctAvg > 20)
    return `CPU throttling ${fmt(stat.pod.throttledPctAvg)}% of periods: the pod's CPU limit is below what its workers use — set WORKERS to the CPU limit (or raise the limit).`;
  if (stat.server.workerCpuAvg > 80)
    return 'Workers are CPU-bound — capacity scales with more workers / vCPU.';
  if (stat.server.eldMax > 150 && (stat.server.workerCpuAvg ?? 0) < 80)
    return 'Event-loop stalls without full CPU: blocking work (text extraction, corpus index rebuild, large JSON) — check projectBuild/chatFile share and ingest concurrency.';
  if (stat.server.primaryCpuAvg > 80)
    return 'Primary process near a full core: it relays the tokens of every chat whose stream sits on another worker, so more workers in this pod add no capacity. Beyond this point only a second replica helps (needs a shared RWX contents volume and cookie affinity).';
  if (stat.streamMiss > 0)
    return 'Stream misses: GET and POST reached different replicas — enable cookie session affinity on the ingress.';
  if (stat.ttftOverheadP95 !== null && stat.ttftOverheadP95 > 0)
    return 'TTFT rises while CPU is fine: queueing in the LLM throttle (requestConcurrency / model.concurrency) or upstream.';
  return null;
}

export function analyze(result) {
  const cfg = result.meta.config;
  const stats = stageStats(result);
  const verdicts = stats.map(s => ({ stat: s, violations: checkSlo(s, cfg.slo) }));
  let capacity = null;
  let firstFail = null;
  for (const v of verdicts) {
    if (v.violations.length === 0) {
      if (!firstFail) capacity = v.stat;
    } else if (!firstFail) firstFail = v;
  }
  const observedWorkers = max(stats.map(s => s.server.workers).filter(Number.isFinite));
  const workers = cfg.server?.workers || observedWorkers || null;
  const sizing = { workers, capacityVus: capacity?.vus ?? null };
  if (capacity && workers) {
    let perWorker = capacity.vus / workers;
    const rssMb = capacity.server.rssMaxMb;
    sizing.measuredUsersPerWorker = perWorker;
    // No level failed: the knee was not reached, and the last level is only a
    // lower bound. Extrapolate linearly on worker CPU up to the CPU SLO — an
    // estimate to confirm with a longer ramp, never the final number.
    const cpu = capacity.server.workerCpuAvg;
    const cpuCap = cfg.slo?.workerCpuAvgPct || 80;
    if (!firstFail && Number.isFinite(cpu) && cpu > 5 && cpu < cpuCap) {
      perWorker = perWorker * (cpuCap / cpu);
      sizing.extrapolated = true;
    }
    sizing.usersPerWorker = perWorker;
    sizing.rssPerWorkerMb = rssMb;
    sizing.cpuPerWorkerAtCapacity = capacity.server.workerCpuAvg;
    const target = cfg.sizing?.targetConcurrentUsers;
    if (target) {
      const headroom = cfg.sizing.headroom ?? 0.7;
      const need = Math.ceil(target / (perWorker * headroom));
      sizing.target = {
        concurrentUsers: target,
        namedUsersApprox: cfg.sizing.concurrencyRatio
          ? Math.round(target / cfg.sizing.concurrencyRatio)
          : null,
        workers: need,
        // One replica: the primary process (cluster manager + SSE relay) needs a core of its own.
        vcpu: need + 1,
        ramGb: rssMb
          ? round((need * rssMb * 1.3 + (capacity.server.rssPrimaryMaxMb || 150) + 1024) / 1024, 1)
          : null,
        headroom
      };
    }
  }
  return { stats, verdicts, capacity, firstFail, sizing, hint: bottleneckHint(firstFail?.stat) };
}

export function renderMarkdown(result) {
  const { meta } = result;
  const cfg = meta.config;
  const a = analyze(result);
  const L = [];
  L.push(`# Load test report: ${cfg.name}`);
  L.push('');
  L.push(
    `- Run: \`${cfg.runId}\` · ${new Date(meta.startedAt).toISOString()} → ${new Date(meta.endedAt).toISOString()}`
  );
  L.push(
    `- Target: ${cfg.baseUrl} · app \`${cfg.appId}\` · model \`${cfg.modelId || 'app default'}\``
  );
  const host = meta.serverInfo?.host;
  L.push(
    `- Server: ${meta.serverInfo?.mode || '?'} mode, ${a.sizing.workers ?? '?'} worker(s)` +
      (host
        ? ` · ${host.cpu?.limitCores ?? host.cpu?.cores} vCPU available · ${fmt((host.memory?.total || 0) / 1073741824, 1)} GiB RAM · Node ${host.nodeVersion}`
        : '')
  );
  L.push(
    `- Runner shards: ${meta.shards} · mix: ${Object.entries(cfg.mix)
      .filter(([, w]) => w > 0)
      .map(([k, w]) => `${k} ${w}`)
      .join(', ')}`
  );
  L.push(
    `- Think time ${cfg.thinkTimeSec.join('–')} s between turns, ${cfg.sessionPauseSec.join('–')} s between sessions${cfg.llm?.expectedTtftMs ? ` · LLM stub TTFT ${cfg.llm.expectedTtftMs} ms` : ''}`
  );
  L.push('');
  L.push('## Per load level (hold phase only)');
  L.push('');
  L.push(
    '| Stage | VUs | Turns/min | TTFT p50 / p95 (ms) | Overhead p95 | Turn p95 (s) | API p95 | Errors turn / HTTP | Worker CPU avg / max | ELD peak p95 | RSS/worker | Verdict |'
  );
  L.push('|---|---:|---:|---|---:|---:|---:|---|---|---:|---:|---|');
  for (const { stat: s, violations } of a.verdicts) {
    L.push(
      `| ${s.name} | ${s.vus} | ${fmt(s.turns.perMin, 1)} | ${fmt(s.ttft?.p50)} / ${fmt(s.ttft?.p95)} | ${fmt(s.ttftOverheadP95)} | ${fmt((s.duration?.p95 || NaN) / 1000, 1)} | ${fmt(s.api?.p95)} | ${fmt(s.turns.errorPct, 2)}% / ${fmt(s.http.errorPct, 2)}% | ${fmt(s.server.workerCpuAvg)}% / ${fmt(s.server.workerCpuMax)}% | ${fmt(s.server.eldMax)} ms | ${fmt(s.server.rssMaxMb)} MB | ${violations.length ? '❌' : '✅'} |`
    );
  }
  L.push('');
  L.push('### Projects, files and crawl');
  L.push('');
  L.push(
    '| Stage | Project chat TTFT p95 | Prompt tokens p95 | Chat upload p95 | Project upload p95 | Ingest ready p50 / p95 (s) | Crawl p95 (s) | Add URL p95 | Stream misses |'
  );
  L.push('|---|---:|---:|---:|---:|---|---:|---:|---:|');
  for (const s of a.stats) {
    L.push(
      `| ${s.name} | ${fmt(s.byLabel.projectChat?.p95)} | ${fmt(s.promptTokens?.p95)} | ${fmt(s.chatUpload?.p95)} | ${fmt(s.projectUpload?.p95)} | ${fmt((s.ingestReady?.p50 ?? NaN) / 1000, 1)} / ${fmt((s.ingestReady?.p95 ?? NaN) / 1000, 1)} | ${fmt((s.crawl?.p95 ?? NaN) / 1000, 1)} | ${fmt(s.addUrl?.p95)} | ${s.streamMiss} |`
    );
  }
  L.push('');
  L.push('## SLO violations');
  L.push('');
  const failing = a.verdicts.filter(v => v.violations.length);
  if (!failing.length) L.push('None — every level met the SLOs.');
  for (const v of failing)
    L.push(`- **${v.stat.name} (${v.stat.vus} VUs)**: ${v.violations.join('; ')}`);
  L.push('');
  L.push('## Capacity and sizing');
  L.push('');
  if (!a.capacity) {
    L.push('No load level met the SLOs: capacity is below the first stage. Start the ramp lower.');
  } else {
    const last = a.stats.at(-1);
    L.push(
      `- **Capacity: ${a.capacity.vus} concurrent active users** (stage ${a.capacity.name})${a.capacity === last ? ' — every stage passed, so the real limit is higher: extend the ramp.' : ''}`
    );
    if (a.sizing.extrapolated) {
      L.push(
        `- Measured: ${fmt(a.sizing.measuredUsersPerWorker, 1)} users/worker at only ${fmt(a.sizing.cpuPerWorkerAtCapacity)}% CPU/worker. ` +
          `**Estimate ≈ ${fmt(a.sizing.usersPerWorker, 1)} users/worker** by CPU extrapolation to ${cfg.slo?.workerCpuAvgPct || 80}% — ⚠️ not measured; ` +
          'event-loop stalls, storage or the relay may cap earlier. Confirm with a ramp that reaches the knee.'
      );
    } else if (a.sizing.usersPerWorker) {
      L.push(
        `- **≈ ${fmt(a.sizing.usersPerWorker, 1)} concurrent active users per worker** at ${fmt(a.sizing.cpuPerWorkerAtCapacity)}% CPU/worker, RSS ≈ ${fmt(a.sizing.rssPerWorkerMb)} MB/worker`
      );
    }
    const t = a.sizing.target;
    if (t) {
      L.push(
        `- For **${t.concurrentUsers} concurrent users**${t.namedUsersApprox ? ` (≈ ${t.namedUsersApprox} named users at ${cfg.sizing.concurrencyRatio * 100}% peak concurrency)` : ''} with ${t.headroom * 100}% target utilisation: **one pod with WORKERS=${t.workers}, ${t.vcpu} vCPU (workers + 1 for the primary), ${t.ramGb ?? '?'} GiB RAM**. Valid only up to the worker count where the worker sweep still scaled; beyond it the primary's SSE relay caps a single pod.`
      );
    } else {
      L.push(
        '- Set `LT_TARGET_CONCURRENT_USERS` (or `--target`) to get a workers / vCPU / RAM recommendation.'
      );
    }
  }
  const disk = (result.metrics.gauges['server.disk.dataUsedMb'] || []).map(([, , v]) => v);
  const turnsTotal = a.stats.reduce((acc, s) => acc + s.turns.ok, 0);
  if (disk.length > 1 && turnsTotal > 0) {
    const grownMb = disk.at(-1) - disk[0];
    L.push(
      `- Storage: data volume grew ${fmt(grownMb)} MB over the run ≈ **${fmt((grownMb / turnsTotal) * 1000)} MB per 1,000 chat turns** ` +
        '(uploads, chats, run ledger, project blobs; only meaningful when nothing else writes to that volume).'
    );
  }
  if (a.firstFail)
    L.push(`- First failing level: ${a.firstFail.stat.name} (${a.firstFail.stat.vus} VUs).`);
  if (a.hint) L.push(`- **Likely bottleneck:** ${a.hint}`);
  L.push('');
  L.push(...renderLlmAndPod(a));
  L.push(...renderRateLimits(result, a));
  L.push('## Errors by stage');
  L.push('');
  for (const s of a.stats) {
    const top = Object.entries(s.errorCodes)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8);
    if (top.length) L.push(`- ${s.name}: ${top.map(([c, n]) => `\`${c}\` ×${n}`).join(', ')}`);
  }
  if (a.stats.every(s => Object.keys(s.errorCodes).length === 0)) L.push('No errors recorded.');
  L.push('');
  L.push('## Load generator health');
  L.push('');
  const runnerMax = max(a.stats.map(s => s.runner.eldP99Max).filter(Number.isFinite));
  L.push(
    runnerMax > 100
      ? `⚠️ Runner event-loop p99 reached ${fmt(runnerMax)} ms — the generator was saturated; add shards (LT_SHARD_COUNT) and rerun.`
      : `Runner event-loop p99 max ${fmt(runnerMax)} ms — the generator was not the bottleneck.`
  );
  L.push('');
  return { markdown: L.join('\n'), analysis: a };
}

/** CSV of 10-second buckets: completed turns, errors, uploads — for charts. */
export function timelineCsv(result) {
  const rows = Object.entries(result.metrics.timeline).sort((x, y) => Number(x[0]) - Number(y[0]));
  const cols = new Set();
  for (const [, slot] of rows) {
    for (const k of Object.keys(slot)) if (/\.turn\.(ok|error)$|^error\./.test(k)) cols.add(k);
  }
  const header = ['time', ...cols];
  const lines = [header.join(',')];
  for (const [t, slot] of rows)
    lines.push([new Date(Number(t)).toISOString(), ...[...cols].map(c => slot[c] || 0)].join(','));
  return lines.join('\n');
}

const has = v => v !== null && v !== undefined && !Number.isNaN(v);

function renderLlmAndPod(a) {
  const L = [];
  if (a.stats.some(s => s.firstToken || has(s.llm.runningMax) || has(s.llm.gpuUtilAvg))) {
    L.push('### LLM / GPU');
    L.push('');
    L.push(
      '| Stage | First token p95 | Answer TTFT p95 | vLLM running avg / max | waiting avg / max | KV cache max | Gen tok/s | Prompt tok/s | Preemptions/min | GPU util avg | GPU mem max |'
    );
    L.push('|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|');
    for (const s of a.stats) {
      const l = s.llm;
      L.push(
        `| ${s.name} | ${fmt(s.firstToken?.p95)} | ${fmt(s.ttft?.p95)} | ${fmt(l.runningAvg, 1)} / ${fmt(l.runningMax)} | ${fmt(l.waitingAvg, 1)} / ${fmt(l.waitingMax)} | ${fmt(l.kvCacheMax)}% | ${fmt(l.genTokPerSec)} | ${fmt(l.promptTokPerSec)} | ${fmt(l.preemptionsPerMin, 1)} | ${fmt(l.gpuUtilAvg)}% | ${fmt(l.gpuMemMax)}% |`
      );
    }
    L.push('');
    L.push(
      '"First token" counts thinking tokens; "Answer TTFT" waits for visible answer text. A growing `waiting` count or KV cache near 100% means vLLM is queueing: the GPU is the limit.'
    );
    L.push('');
  }
  if (a.stats.some(s => has(s.pod.cpuCoresAvg) || has(s.pod.memoryMbMax))) {
    L.push('### iHub pod (Prometheus)');
    L.push('');
    L.push('| Stage | CPU cores avg / max | CPU throttled | Memory max | Pods ready |');
    L.push('|---|---|---:|---:|---:|');
    for (const s of a.stats) {
      const p = s.pod;
      L.push(
        `| ${s.name} | ${fmt(p.cpuCoresAvg, 2)} / ${fmt(p.cpuCoresMax, 2)} | ${fmt(p.throttledPctAvg)}% | ${fmt(p.memoryMbMax)} MB | ${fmt(p.podsReady)} |`
      );
    }
    L.push('');
  }
  return L;
}

/** Limiters counted in one store for the whole cluster (others count per worker). */
const CLUSTER_WIDE = new Set(['authApi', 'oauthApi']);

export function rateLimitAnalysis(result, a) {
  const { trends, counts } = result.metrics;
  const cfg = result.meta.config;
  const limits = result.meta.serverLimits?.rateLimits || {};
  const workers = a.sizing.workers || 1;
  const keys = a.stats.map(s => String(s.index));
  const collect = name => keys.flatMap(k => trends[name]?.[k] || []);
  const total = name => Object.values(counts[name] || {}).reduce((x, y) => x + y, 0);
  const usersPerIp =
    cfg.rateLimitUsersPerIp ||
    cfg.sizing?.targetConcurrentUsers ||
    a.capacity?.vus ||
    Math.max(...a.stats.map(s => s.vus));
  const rows = [];
  for (const cls of ['publicApi', 'inferenceApi', 'adminApi', 'oauthApi', 'unlimited']) {
    const perUser = summarize(collect(`rl.${cls}.perUserMin`));
    const perRunner = summarize(collect(`rl.${cls}.perRunnerMin`));
    if (!perUser && !perRunner) continue;
    const lim = limits[cls];
    const perMin = lim ? (lim.limit * 60000) / lim.windowMs : null;
    const spread = CLUSTER_WIDE.has(cls) ? 1 : workers;
    // One client IP is spread over the workers round robin, each counting alone.
    const ipBudgetPerMin = perMin !== null ? perMin * spread : null;
    const userRate = perUser ? Math.max(perUser.p99, 1) : null;
    const fit = ipBudgetPerMin !== null && userRate ? Math.floor(ipBudgetPerMin / userRate) : null;
    // 2x headroom for bursts (page loads, many tabs) and uneven worker spread.
    const neededPerMin = userRate ? Math.ceil((userRate * usersPerIp * 2) / spread) : null;
    const recommended =
      neededPerMin !== null && lim ? Math.ceil((neededPerMin * lim.windowMs) / 60000) : null;
    rows.push({
      cls,
      lim,
      perUser,
      perRunner,
      fit,
      recommended,
      n429: total(`rl.${cls}.429`),
      requests: total(`rl.${cls}.total`),
      spread
    });
  }
  return { rows, usersPerIp, workers, trustProxy: result.meta.serverLimits?.trustProxy };
}

function renderRateLimits(result, a) {
  const r = rateLimitAnalysis(result, a);
  if (!r.rows.length) return [];
  const L = ['## Rate limits: real demand vs configured limits', ''];
  L.push(
    `Requests per **active user per minute** as this workload produced them (page loads included), set against the limits the server ran with. Per-worker limiters are multiplied by ${r.workers} worker(s), because one client IP is spread over all workers. Recommendation: enough for **${r.usersPerIp} concurrent users behind one IP** (corporate NAT, or a proxy whose hops \`trustProxy\` does not cover) with 2× headroom.`
  );
  L.push('');
  L.push(
    '| Limiter | Configured | Scope | Per user/min p50 / p99 / max | Per runner IP/min max | Users per IP before 429 | 429s in run | Recommended `limit` |'
  );
  L.push('|---|---|---|---|---:|---:|---:|---|');
  for (const row of r.rows) {
    const conf = row.lim
      ? `${row.lim.limit} / ${Math.round(row.lim.windowMs / 60000)} min`
      : row.cls === 'unlimited'
        ? 'none'
        : '?';
    const verdict =
      row.recommended === null || !row.lim
        ? '–'
        : row.recommended <= row.lim.limit
          ? `keep (${row.lim.limit} ≥ ${row.recommended})`
          : `**raise to ≥ ${row.recommended}**`;
    L.push(
      `| ${row.cls} | ${conf} | ${row.spread > 1 ? 'per IP, per worker' : row.cls === 'unlimited' ? '–' : 'per IP, cluster-wide'} | ${fmt(row.perUser?.p50)} / ${fmt(row.perUser?.p99)} / ${fmt(row.perUser?.max)} | ${fmt(row.perRunner?.max)} | ${row.fit === null ? '–' : fmt(row.fit)} | ${row.n429} | ${verdict} |`
    );
  }
  L.push('');
  const auth = (result.meta.serverLimits?.rateLimits || {}).authApi;
  if (auth) {
    const wantAuth = Math.ceil(r.usersPerIp * 1.2);
    L.push(
      `- **authApi** (${auth.limit} per ${Math.round(auth.windowMs / 60000)} min, cluster-wide) counts only credential POSTs (local, LDAP, NTLM login); OIDC sign-in is exempt. With local/LDAP login, ${r.usersPerIp} users behind one IP logging in within one window need **≥ ${wantAuth}**${auth.limit >= wantAuth ? ' — the current value is enough.' : ` — **the current ${auth.limit} locks out everyone after the ${auth.limit}th login of the window** (e.g. the morning wave of an office behind NAT).`} Failed-login protection does not depend on this limit: accounts lock after 5 failures.`
    );
  }
  if (
    r.trustProxy === undefined ||
    r.trustProxy === null ||
    r.trustProxy === false ||
    r.trustProxy === 0
  ) {
    L.push(
      `- **trustProxy is ${JSON.stringify(r.trustProxy ?? 'unset')}**: behind an ingress or reverse proxy every request then carries the proxy's address, so *all users share one counter* and the limits above apply to the whole user base, not per user. Set \`trustProxy\` to the number of proxy hops (docs/rate-limiting.md).`
    );
  }
  L.push(
    '- These numbers come from simulated users; calibrate with production access logs (requests per user per minute at peak) before changing defaults.'
  );
  L.push('');
  return L;
}
