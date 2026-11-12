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
      stubInflightMax: max(gaugeValues(gauges, /^stub\.inflight$/, k))
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
  if (stat.server.workerCpuAvg > 80)
    return 'Workers are CPU-bound — capacity scales with more workers / vCPU.';
  if (stat.server.eldMax > 150 && (stat.server.workerCpuAvg ?? 0) < 80)
    return 'Event-loop stalls without full CPU: blocking work (text extraction, corpus index rebuild, large JSON) — check projectBuild/chatFile share and ingest concurrency.';
  if (stat.server.primaryCpuAvg > 80)
    return 'Primary process near a full core: the cross-worker SSE relay is the bottleneck — prefer more replicas with fewer workers each.';
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
      const perPod = 4;
      sizing.target = {
        concurrentUsers: target,
        namedUsersApprox: cfg.sizing.concurrencyRatio
          ? Math.round(target / cfg.sizing.concurrencyRatio)
          : null,
        workers: need,
        vcpu: need + (need > 4 ? 1 : 0),
        ramGb: rssMb
          ? round((need * rssMb * 1.3 + (capacity.server.rssPrimaryMaxMb || 150) + 1024) / 1024, 1)
          : null,
        replicasAt4Workers: Math.ceil(need / perPod),
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
        `- For **${t.concurrentUsers} concurrent users**${t.namedUsersApprox ? ` (≈ ${t.namedUsersApprox} named users at ${cfg.sizing.concurrencyRatio * 100}% peak concurrency)` : ''} with ${t.headroom * 100}% target utilisation: **${t.workers} workers ≈ ${t.vcpu} vCPU, ${t.ramGb ?? '?'} GiB RAM**, e.g. ${t.replicasAt4Workers} replica(s) × 4 workers (multi-replica needs cookie affinity + shared contents volume).`
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
