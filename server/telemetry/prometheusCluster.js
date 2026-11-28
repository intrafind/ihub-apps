// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One Prometheus endpoint for the whole cluster.
 *
 * In cluster mode every worker used to start its own Prometheus exporter on
 * the same port. Workers share a listening handle, so each scrape landed on a
 * random worker: counters looked like resets, histograms of different
 * processes mixed, and nothing told the series apart.
 *
 * Now every worker keeps its metrics in a Prometheus reader that does not
 * listen itself, and answers a cluster-bus question with its own exposition.
 * The worker that receives a scrape gathers the others' answers and merges
 * them into one response, every series labelled `cluster_worker_id` (the
 * worker's slot, stable across restarts of that slot). So whichever worker
 * the scrape hits, Prometheus sees every worker, each as its own series, and
 * a counter only resets when its own worker restarts. Dashboards `sum` per-
 * process series and `max` the cluster-union gauges.
 *
 * Outside cluster mode the same server answers with the one process's metrics.
 *
 * @module telemetry/prometheusCluster
 */

import http from 'node:http';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { gather, respond } from '../clusterBus.js';
import logger from '../utils/logger.js';
import { recordExportFailure, recordExportSuccess } from './exportStatus.js';

/** Cluster-bus channel the workers answer scrapes on. */
export const SCRAPE_CHANNEL = 'telemetry:prometheus-scrape';

/** Label added to every series. */
export const WORKER_LABEL = 'cluster_worker_id';

/** How long a scrape waits for the other workers. */
const GATHER_TIMEOUT_MS = 2000;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;

/**
 * Escape a label value for the exposition format.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Add a label to one sample line (`name{a="b"} 1` or `name 1`).
 *
 * @param {string} line
 * @param {string} label - `name="value"`, already escaped
 * @returns {string}
 */
function withLabel(line, label) {
  const match = METRIC_NAME.exec(line);
  if (!match) return line;
  const name = match[0];
  const rest = line.slice(name.length);
  // `target_info` already carries it (the `cluster.worker.id` resource
  // attribute); a label may appear only once per sample.
  if (rest.startsWith('{') && rest.includes(`${label.split('=')[0]}="`)) return line;
  if (rest.startsWith('{')) {
    return rest.startsWith('{}')
      ? `${name}{${label}}${rest.slice(2)}`
      : `${name}{${label},${rest.slice(1)}`;
  }
  return `${name}{${label}}${rest}`;
}

/**
 * Merge the expositions of several processes into one, each sample labelled
 * with its worker. A family's `# HELP` and `# TYPE` appear once, before all of
 * its samples, as the format requires.
 *
 * @param {Array<{workerId: string, text: string}>} expositions
 * @returns {string}
 */
export function mergeExpositions(expositions) {
  /** @type {Map<string, {meta: string[], samples: string[]}>} */
  const families = new Map();
  const familyOf = name => {
    if (!families.has(name)) families.set(name, { meta: [], samples: [] });
    return families.get(name);
  };
  for (const { workerId, text } of expositions) {
    if (typeof text !== 'string') continue;
    const label = `${WORKER_LABEL}="${escapeLabelValue(workerId)}"`;
    let current = null;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) {
        const name = line.slice(7).split(' ')[0];
        current = familyOf(name);
        const kind = line.slice(0, 7);
        if (!current.meta.some(existing => existing.startsWith(kind))) current.meta.push(line);
        continue;
      }
      if (line.startsWith('#')) continue;
      // A sample of the family announced last (histogram _bucket/_sum/_count
      // belong to their base family).
      const name = METRIC_NAME.exec(line)?.[0];
      if (!name) continue;
      (current ?? familyOf(name)).samples.push(withLabel(line, label));
    }
  }
  const out = [];
  for (const { meta, samples } of families.values()) {
    // One push per line: spreading a large family into push() would pass
    // every sample as an argument and overflow the stack.
    for (const line of meta) out.push(line);
    for (const line of samples) out.push(line);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Start the metric reader and, unless `listen` is false, the scrape server.
 *
 * @param {Object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.workerId - This process's `cluster_worker_id`
 * @param {number} options.workerCount - Workers configured (1 outside cluster mode)
 * @param {boolean} [options.listen=true]
 * @returns {{reader: PrometheusExporter, server: http.Server|null, scrape: () => Promise<string>, close: () => Promise<void>}}
 */
export function startPrometheusCluster({ host, port, workerId, workerCount, listen = true }) {
  const reader = new PrometheusExporter({ preventServerStart: true });
  const serializer = new PrometheusSerializer();

  const ownExposition = async () => {
    const { resourceMetrics, errors } = await reader.collect();
    if (errors?.length) {
      logger.warn('Prometheus metrics collection reported errors', {
        component: 'Telemetry',
        count: errors.length
      });
    }
    return { text: serializer.serialize(resourceMetrics), complete: !errors?.length };
  };

  const unsubscribe = respond(SCRAPE_CHANNEL, async () => {
    const { text, complete } = await ownExposition();
    // This worker's series are exported through whichever worker took the
    // scrape; its own status (/api/health, admin) says so too.
    if (complete) recordExportSuccess('metrics');
    else recordExportFailure('metrics', { incomplete: true });
    return { workerId, text, complete };
  });

  /**
   * One scrape across the cluster. `complete` is false when a worker did not
   * answer in time or a collection reported errors: the text is still served,
   * since the workers that answered are worth having, but it does not count
   * as a successful export.
   */
  const collectScrape = async () => {
    const [own, others] = await Promise.all([
      ownExposition(),
      workerCount > 1
        ? gather(SCRAPE_CHANNEL, null, {
            expected: workerCount - 1,
            timeoutMs: GATHER_TIMEOUT_MS
          })
        : Promise.resolve([])
    ]);
    const complete =
      own.complete &&
      others.length >= workerCount - 1 &&
      others.every(reply => reply?.complete !== false);
    return {
      text: mergeExpositions([{ workerId, text: own.text }, ...others]),
      complete
    };
  };

  const scrape = async () => (await collectScrape()).text;

  let server = null;
  if (listen) {
    server = http.createServer((request, response) => {
      let pathname;
      try {
        pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      } catch {
        pathname = null;
      }
      if (pathname !== '/metrics') {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }
      collectScrape().then(
        ({ text, complete }) => {
          if (complete) recordExportSuccess('metrics');
          else recordExportFailure('metrics', { incomplete: true });
          response.statusCode = 200;
          response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
          response.end(text);
        },
        error => {
          recordExportFailure('metrics', error);
          response.statusCode = 500;
          response.end('# failed to collect metrics\n');
        }
      );
    });
    server.unref();
    server.on('error', error => {
      logger.error('Prometheus metrics endpoint could not start', {
        component: 'Telemetry',
        host,
        port,
        code: error?.code
      });
      // Nobody can scrape: the export status says failing, not pending.
      recordExportFailure('metrics', error);
    });
    server.listen({ host, port });
  }

  const close = async () => {
    unsubscribe();
    if (server) await new Promise(resolve => server.close(() => resolve()));
  };

  return { reader, server, scrape, close };
}
