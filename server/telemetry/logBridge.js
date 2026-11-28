// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sends application log lines to the OpenTelemetry logs pipeline (OTLP to the
 * collector, then Loki or a SIEM) when `telemetry.logs.enabled` is on.
 *
 * The container log keeps the full line. What leaves the server is less:
 * - the message (already redacted by `utils/logger.js`), cut to 2000 characters;
 * - the severity, from the winston level;
 * - a short list of structured fields that carry no content or identity
 *   ({@link EXPORTED_FIELDS}): the component, codes, ids from config, counts;
 * - the user only pseudonymised (`telemetry/identity.js`), never the IP;
 * - the trace and span id of the active span, so a log record leads to its trace.
 *
 * `telemetry.logs.level` sets the lowest level exported (default `info`).
 *
 * @module telemetry/logBridge
 */

import winston from 'winston';
import { logs, SeverityNumber } from '@opentelemetry/api';
import { userSpanAttributes } from './identity.js';

/** Structured fields exported as they are (primitives only). */
const EXPORTED_FIELDS = new Set([
  'component',
  'code',
  'errorCode',
  'providerCode',
  'status',
  'provider',
  'modelId',
  'appId',
  'toolId',
  'nodeType',
  'workflowId',
  'signal',
  'reason',
  'durationMs',
  'attempt',
  'count',
  'workerIndex',
  'event'
]);

const SEVERITY = {
  error: [SeverityNumber.ERROR, 'ERROR'],
  warn: [SeverityNumber.WARN, 'WARN'],
  info: [SeverityNumber.INFO, 'INFO'],
  http: [SeverityNumber.INFO2, 'INFO'],
  verbose: [SeverityNumber.DEBUG2, 'DEBUG'],
  debug: [SeverityNumber.DEBUG, 'DEBUG'],
  silly: [SeverityNumber.TRACE, 'TRACE']
};

/**
 * The attributes of one log line that may leave the server.
 *
 * @param {Object} info - The winston log entry
 * @returns {Object}
 */
export function exportedLogAttributes(info) {
  const attributes = {};
  for (const key of EXPORTED_FIELDS) {
    const value = info?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) attributes[key] = value;
    else if (typeof value === 'boolean') attributes[key] = value;
    else if (typeof value === 'string' && value !== '') attributes[key] = value.slice(0, 256);
  }
  const error = info?.error;
  if (error && typeof error === 'object') {
    const type = typeof error.code === 'string' ? error.code : error.name;
    if (typeof type === 'string' && /^[\w.]{1,64}$/.test(type)) attributes['error.type'] = type;
  }
  return { ...attributes, ...userSpanAttributes(info?.userId) };
}

/** A winston transport that emits OpenTelemetry log records. */
export class OtelLogTransport extends winston.Transport {
  constructor({ level = 'info' } = {}) {
    super({ level });
    this.otelLogger = logs.getLogger('ihub-apps');
  }

  log(info, callback) {
    try {
      const [severityNumber, severityText] = SEVERITY[info.level] || SEVERITY.info;
      const message = typeof info.message === 'string' ? info.message : String(info.message);
      this.otelLogger.emit({
        severityNumber,
        severityText,
        body: message.slice(0, 2000),
        attributes: exportedLogAttributes(info)
      });
    } catch {
      /* logging must never break the caller */
    }
    callback();
  }
}
