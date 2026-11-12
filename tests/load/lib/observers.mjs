// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optional outside views during a run:
 *
 * vLLM: scrapes the model server's own Prometheus endpoint (vLLM serves
 * `/metrics` on its API port). Running vs waiting requests and KV-cache use
 * say whether the GPU is the limit; token counters give the GPU's throughput.
 *
 * Prometheus (directly, or through Grafana's datasource proxy with a service
 * account token): GPU utilisation from the DCGM exporter on the node, and CPU,
 * CPU throttling and memory of every iHub pod — the per-replica numbers the
 * admin resources endpoint cannot give behind a load balancer.
 */

/** Parse Prometheus text exposition into [{ name, labels, value }]. */
export function parsePromText(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels = {};
    if (m[3]) {
      for (const lm of m[3].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2];
    }
    const value = Number(m[4]);
    if (Number.isFinite(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

const sumOf = (samples, ...names) => {
  const hits = samples.filter(s => names.includes(s.name));
  return hits.length ? hits.reduce((a, s) => a + s.value, 0) : null;
};

/**
 * vLLM gauges per sample: llm.running, llm.waiting, llm.kvCachePct, and per-second
 * rates of prompt/generation tokens and preemptions (from the counters).
 */
export function createVllmObserver({ url, metrics, log }) {
  let last = null;
  let failures = 0;
  return async function tick() {
    if (failures >= 5) return;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const samples = parsePromText(await res.text());
      failures = 0;
      const now = Date.now();
      const running = sumOf(samples, 'vllm:num_requests_running');
      const waiting = sumOf(samples, 'vllm:num_requests_waiting');
      // V0 name, V1 name; the value is a fraction.
      const kv = sumOf(samples, 'vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc');
      if (running !== null) metrics.gauge('llm.running', running);
      if (waiting !== null) metrics.gauge('llm.waiting', waiting);
      if (kv !== null) metrics.gauge('llm.kvCachePct', kv * 100);
      const counters = {
        prompt: sumOf(samples, 'vllm:prompt_tokens_total'),
        gen: sumOf(samples, 'vllm:generation_tokens_total'),
        preempt: sumOf(samples, 'vllm:num_preemptions_total')
      };
      if (last) {
        const dt = (now - last.t) / 1000;
        if (dt > 0) {
          const rate = (a, b) => (a !== null && b !== null && a >= b ? (a - b) / dt : null);
          const p = rate(counters.prompt, last.prompt);
          const g = rate(counters.gen, last.gen);
          const x = rate(counters.preempt, last.preempt);
          if (p !== null) metrics.gauge('llm.promptTokPerSec', p);
          if (g !== null) metrics.gauge('llm.genTokPerSec', g);
          if (x !== null) metrics.gauge('llm.preemptionsPerSec', x);
        }
      }
      last = { t: now, ...counters };
    } catch (err) {
      failures += 1;
      metrics.count('sampler.vllm.failed');
      if (failures === 5) log(`vLLM metrics at ${url} unreachable (${err.message}) — giving up`);
    }
  };
}

/**
 * Default PromQL. `$NS`, `$POD` and `$GPU` are replaced from the config; adapt
 * label names to your exporters in the profile (`sampling.prometheus.queries`).
 */
export const DEFAULT_PROM_QUERIES = {
  gpuUtilPct: 'avg(DCGM_FI_DEV_GPU_UTIL{$GPU})',
  gpuMemUsedPct:
    '100 * sum(DCGM_FI_DEV_FB_USED{$GPU}) / (sum(DCGM_FI_DEV_FB_USED{$GPU}) + sum(DCGM_FI_DEV_FB_FREE{$GPU}))',
  ihubCpuCores:
    'sum(rate(container_cpu_usage_seconds_total{namespace="$NS",pod=~"$POD",container!="",container!="POD"}[1m]))',
  ihubCpuThrottledPct:
    '100 * sum(rate(container_cpu_cfs_throttled_periods_total{namespace="$NS",pod=~"$POD",container!=""}[1m])) / sum(rate(container_cpu_cfs_periods_total{namespace="$NS",pod=~"$POD",container!=""}[1m]))',
  ihubMemoryMb:
    'sum(container_memory_working_set_bytes{namespace="$NS",pod=~"$POD",container!="",container!="POD"}) / 1048576',
  ihubPodsReady: 'sum(kube_pod_status_ready{namespace="$NS",pod=~"$POD",condition="true"})',
  ihubMaxPodCpuCores:
    'max(sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="$NS",pod=~"$POD",container!="",container!="POD"}[1m])))'
};

export function createPrometheusObserver({ prom, metrics, log }) {
  const base = prom.url.replace(/\/+$/, '');
  const vars = { NS: prom.namespace, POD: prom.podRegex, GPU: prom.gpuSelector || '' };
  const queries = Object.entries({ ...DEFAULT_PROM_QUERIES, ...(prom.queries || {}) })
    .filter(([, q]) => q)
    .map(([name, q]) => [name, q.replace(/\$(NS|POD|GPU)/g, (_, k) => vars[k] ?? '')]);
  const dead = new Set();
  return async function tick() {
    await Promise.all(
      queries.map(async ([name, q]) => {
        if (dead.has(name)) return;
        try {
          const res = await fetch(`${base}/api/v1/query?query=${encodeURIComponent(q)}`, {
            headers: prom.token ? { Authorization: `Bearer ${prom.token}` } : {},
            signal: AbortSignal.timeout(8000)
          });
          const body = await res.json();
          if (body.status !== 'success') throw new Error(body.error || `HTTP ${res.status}`);
          const result = body.data?.result || [];
          if (result.length === 0) return; // no such series (exporter absent) — keep trying
          const value = Number(result[0].value?.[1]);
          if (Number.isFinite(value)) metrics.gauge(`prom.${name}`, value);
        } catch (err) {
          metrics.count(`sampler.prom.${name}.failed`);
          if (/parse error|bad_data/i.test(err.message)) {
            dead.add(name);
            log(`Prometheus query ${name} rejected: ${err.message}`);
          }
        }
      })
    );
  };
}
