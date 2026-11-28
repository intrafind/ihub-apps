// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether telemetry is on and actually exporting.
 *
 * Before this, an export that failed (a rotated collector certificate, a proxy
 * in the way, a wrong port) only printed to stdout through the OTel diag
 * logger, and a deployment with telemetry off said nothing at all. Dashboards
 * went flat and looked like "no traffic".
 *
 * This module keeps, per signal (`traces`, `metrics`, `logs`):
 * - whether it is enabled and which exporter it uses,
 * - the time of the last successful export and of the last failure,
 * - the reason of the last failure, from a closed set ({@link exportFailureReason}),
 * - the number of failures since start.
 *
 * It feeds `ihub.telemetry.export.failures`, `ihub.telemetry.export.last_success`,
 * the `telemetry` block of `/api/health` and the admin system view, and logs a
 * WARN when a signal starts failing and an INFO when it recovers (transitions
 * only, so a down collector does not flood the log).
 *
 * @module telemetry/exportStatus
 */

import logger from '../utils/logger.js';
import { recordTelemetryExportFailure } from './metrics.js';

/** The signals tracked. */
export const SIGNALS = Object.freeze(['traces', 'metrics', 'logs']);

/** The closed set of failure reasons. */
export const EXPORT_FAILURE_REASONS = Object.freeze([
  'tls',
  'connection_refused',
  'dns',
  'timeout',
  'network',
  'authentication',
  'http_4xx',
  'http_5xx',
  'deferred',
  'incomplete',
  'unknown'
]);

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO'
]);

let state = freshState();

function freshState() {
  return {
    enabled: false,
    provider: null,
    signals: Object.fromEntries(
      SIGNALS.map(signal => [
        signal,
        {
          enabled: false,
          exporter: null,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastFailureReason: null,
          failures: 0,
          failing: false
        }
      ])
    )
  };
}

/**
 * Classify an export failure into {@link EXPORT_FAILURE_REASONS}. Never the
 * message: it can carry the collector URL or a header.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function exportFailureReason(error) {
  if (!error || typeof error !== 'object') return 'unknown';
  const seen = new Set();
  // Network errors often arrive wrapped (`cause`); look one or two levels down.
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    const code = typeof current.code === 'string' ? current.code : undefined;
    const status =
      typeof current.code === 'number'
        ? current.code
        : (current.status ?? current.statusCode ?? undefined);
    if (code && TLS_CODES.has(code)) return 'tls';
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'connection_refused';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || current.name === 'TimeoutError') {
      return 'timeout';
    }
    if (Number.isInteger(status)) {
      if (status === 401 || status === 403) return 'authentication';
      if (status >= 400 && status < 500) return 'http_4xx';
      if (status >= 500 && status < 600) return 'http_5xx';
    }
    if (current.deferred === true) return 'deferred';
    if (current.incomplete === true) return 'incomplete';
    if (code && /^E[A-Z]+$/.test(code)) return 'network';
  }
  return 'unknown';
}

/**
 * Note what telemetry was started with.
 *
 * @param {Object} setup
 * @param {boolean} setup.enabled
 * @param {string|null} [setup.provider]
 * @param {Object<string, string|null>} [setup.exporters] - Exporter per signal, null when off
 */
export function setTelemetrySetup({ enabled, provider = null, exporters = {} }) {
  state = freshState();
  state.enabled = enabled === true;
  state.provider = provider;
  for (const signal of SIGNALS) {
    const exporter = exporters[signal] ?? null;
    state.signals[signal].enabled = state.enabled && exporter !== null;
    state.signals[signal].exporter = exporter;
  }
}

/** Record a successful export (or a served Prometheus scrape). */
export function recordExportSuccess(signal) {
  const entry = state.signals[signal];
  if (!entry) return;
  entry.lastSuccessAt = Date.now();
  if (entry.failing) {
    entry.failing = false;
    logger.info('Telemetry export recovered', { component: 'Telemetry', signal });
  }
}

/** Record a failed export. */
export function recordExportFailure(signal, error) {
  const entry = state.signals[signal];
  if (!entry) return;
  const reason = exportFailureReason(error);
  entry.lastFailureAt = Date.now();
  entry.lastFailureReason = reason;
  entry.failures += 1;
  recordTelemetryExportFailure(signal, reason);
  if (!entry.failing) {
    entry.failing = true;
    logger.warn('Telemetry export failing', {
      component: 'Telemetry',
      signal,
      exporter: entry.exporter,
      reason
    });
  }
}

/**
 * Make an exporter report its results here. Wraps `export(items, callback)`
 * in place, so every other method and property of the exporter stays as the
 * SDK expects it.
 *
 * @template T
 * @param {T} exporter - A span, metric or log record exporter
 * @param {string} signal
 * @returns {T} The same exporter
 */
export function trackExporter(exporter, signal) {
  if (!exporter || typeof exporter.export !== 'function') return exporter;
  const original = exporter.export.bind(exporter);
  exporter.export = (items, resultCallback) =>
    original(items, result => {
      try {
        // ExportResultCode.SUCCESS is 0.
        if (result?.code === 0) recordExportSuccess(signal);
        else recordExportFailure(signal, result?.error);
      } catch {
        /* status keeping must never break an export */
      }
      resultCallback(result);
    });
  return exporter;
}

/**
 * The telemetry status for `/api/health` and the admin system view. Times are
 * ISO strings; no endpoint, header or error text.
 *
 * @returns {{enabled: boolean, provider: string|null, signals: Object}}
 */
export function getTelemetryStatus() {
  const iso = ms => (ms ? new Date(ms).toISOString() : null);
  return {
    enabled: state.enabled,
    provider: state.provider,
    signals: Object.fromEntries(
      SIGNALS.map(signal => {
        const entry = state.signals[signal];
        return [
          signal,
          {
            enabled: entry.enabled,
            exporter: entry.exporter,
            status: !entry.enabled
              ? 'off'
              : entry.failing
                ? 'failing'
                : entry.lastSuccessAt
                  ? 'ok'
                  : 'pending',
            lastSuccessAt: iso(entry.lastSuccessAt),
            lastFailureAt: iso(entry.lastFailureAt),
            lastFailureReason: entry.lastFailureReason,
            failures: entry.failures
          }
        ];
      })
    )
  };
}

/**
 * The compact status for the public `/api/health` probe: on or off, and per
 * signal its state and last success. No reasons or counts.
 *
 * @returns {{enabled: boolean, signals: Object<string, {status: string, lastSuccessAt: string|null}>}}
 */
export function getTelemetryHealth() {
  const full = getTelemetryStatus();
  return {
    enabled: full.enabled,
    signals: Object.fromEntries(
      Object.entries(full.signals).map(([signal, entry]) => [
        signal,
        { status: entry.status, lastSuccessAt: entry.lastSuccessAt }
      ])
    )
  };
}

/**
 * The last successful export per signal, in seconds since the epoch, for the
 * `ihub.telemetry.export.last_success` gauge.
 *
 * @returns {Array<[string, number]>}
 */
export function lastSuccessTimestamps() {
  return SIGNALS.filter(signal => state.signals[signal].lastSuccessAt).map(signal => [
    signal,
    state.signals[signal].lastSuccessAt / 1000
  ]);
}

/** Reset (tests only). */
export function resetExportStatusForTests() {
  state = freshState();
}
