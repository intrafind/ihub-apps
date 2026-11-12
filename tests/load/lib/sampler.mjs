// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Resource sampling during a run — the data the sizing answer is built from.
 *
 * Server: GET /api/admin/system/resources (admin) every few seconds. It lists
 * every process of the instance that answered (primary + each worker) with
 * cpuPercent (100 = one core), RSS, heap and mean event-loop delay. Behind a
 * load balancer with several replicas it shows only the replica that served
 * the call — use Prometheus / `kubectl top` for the others.
 *
 * Runner: its own CPU and event-loop delay. If the runner is saturated, the
 * latencies it measures are its own, not the server's; the report flags that.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export function startSamplers({ cfg, metrics, adminClient }) {
  const timers = [];
  const intervalMs = cfg.sampling.intervalSec * 1000;
  const serverInfo = { workers: null, host: null };

  if (adminClient && cfg.sampling.server) {
    const tick = async () => {
      try {
        const res = await adminClient.request('GET', '/api/admin/system/resources', {
          timeoutMs: 10_000
        });
        if (res.status !== 200) {
          metrics.count(`sampler.server.status.${res.status}`);
          return;
        }
        const snap = res.body;
        serverInfo.host = snap.host;
        serverInfo.mode = snap.cluster?.mode;
        serverInfo.workers = snap.cluster?.configuredWorkers ?? null;
        let workers = 0;
        let cpuSum = 0;
        let rssSum = 0;
        for (const p of snap.processes || []) {
          const id = p.role === 'worker' ? `w${p.workerIndex}` : p.role;
          metrics.gauge(`server.cpu.${id}`, p.cpuPercent);
          metrics.gauge(`server.rss.${id}`, p.memory?.rss / 1048576);
          metrics.gauge(`server.heap.${id}`, p.memory?.heapUsed / 1048576);
          // { mean, max } over the server's sampling interval (older builds: a number)
          const eld = p.eventLoopDelayMs;
          if (typeof eld === 'number') metrics.gauge(`server.eld.${id}`, eld);
          else if (eld) {
            metrics.gauge(`server.eld.${id}`, eld.mean);
            metrics.gauge(`server.eldmax.${id}`, eld.max);
          }
          if (p.role !== 'primary') {
            workers += 1;
            cpuSum += p.cpuPercent || 0;
            rssSum += p.memory?.rss || 0;
          }
        }
        metrics.gauge('server.workerCount', workers);
        metrics.gauge('server.cpu.workersTotal', cpuSum);
        metrics.gauge('server.rss.total', rssSum / 1048576);
        if (snap.host?.cpu?.utilizationPercent != null) {
          metrics.gauge('server.host.cpuPercent', snap.host.cpu.utilizationPercent);
        }
        // Filesystem holding contents/data: its growth over a run gives storage
        // per chat turn / project (meaningful on a dedicated volume).
        const dataVol = (snap.storage?.volumes || []).find(v =>
          v.paths?.some(p => p.key === 'data')
        );
        if (dataVol?.used != null) metrics.gauge('server.disk.dataUsedMb', dataVol.used / 1048576);
        if (snap.host?.memory?.usedPercent != null) {
          metrics.gauge('server.host.memUsedPercent', snap.host.memory.usedPercent);
        }
      } catch {
        metrics.count('sampler.server.failed');
      }
    };
    tick();
    timers.push(setInterval(tick, intervalMs));
  }

  if (cfg.sampling.stubStatsUrl) {
    const tick = async () => {
      try {
        const res = await fetch(cfg.sampling.stubStatsUrl, { signal: AbortSignal.timeout(5000) });
        const s = await res.json();
        metrics.gauge('stub.inflight', s.inflight);
        metrics.gauge('stub.requestsTotal', s.requests);
        if (s.promptChars?.p95) metrics.gauge('stub.promptCharsP95', s.promptChars.p95);
      } catch {
        metrics.count('sampler.stub.failed');
      }
    };
    timers.push(setInterval(tick, intervalMs));
  }

  // Runner health
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let lastCpu = process.cpuUsage();
  let lastT = performance.now();
  timers.push(
    setInterval(() => {
      const cpu = process.cpuUsage(lastCpu);
      const now = performance.now();
      metrics.gauge('runner.cpuPercent', ((cpu.user + cpu.system) / 1000 / (now - lastT)) * 100);
      metrics.gauge('runner.eldP99', loop.percentile(99) / 1e6);
      metrics.gauge('runner.rssMb', process.memoryUsage().rss / 1048576);
      loop.reset();
      lastCpu = process.cpuUsage();
      lastT = now;
    }, intervalMs)
  );

  return {
    serverInfo,
    stop() {
      timers.forEach(clearInterval);
      loop.disable();
    }
  };
}
