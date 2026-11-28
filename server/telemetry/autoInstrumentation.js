// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The library instrumentations `telemetry.autoInstrumentation: true` turns on.
 *
 * Previously every instrumentation of `auto-instrumentations-node` ran with its
 * defaults: `dns`, `net` and `fs` spans flooded the backend, the winston
 * instrumentation shipped every application log line, and the HTTP spans
 * carried query strings with OAuth codes and tokens. Now the list is explicit:
 *
 * - `http` (inbound requests, outbound calls through `httpFetch` / node-fetch),
 *   without health probes and static assets;
 * - `undici` (outbound calls through the global `fetch` of SDKs);
 * - `express` (route names for inbound spans);
 * - `winston`, for trace ids in log records only, never sending logs.
 *
 * URLs, query strings and caller addresses are stripped from these spans by
 * `spanRedaction.js` before export.
 *
 * @module telemetry/autoInstrumentation
 */

import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';

/** Paths of inbound requests that get no span: probes and static files. */
const IGNORED_PATH =
  /\/api\/(?:health|ready)(?:\/|$)|\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|txt)$|\/assets\//i;

/**
 * Whether an inbound request is left without a span.
 *
 * @param {{url?: string}} request
 * @returns {boolean}
 */
export function isIgnoredIncomingRequest(request) {
  const url = request?.url ?? '';
  const path = url.split(/[?#]/)[0];
  return IGNORED_PATH.test(path);
}

/**
 * Create the instrumentations. Sets `OTEL_SEMCONV_STABILITY_OPT_IN=http` (the
 * stable HTTP attribute names) unless the environment already chose.
 *
 * @returns {Array<import('@opentelemetry/instrumentation').Instrumentation>}
 */
export function createInstrumentations() {
  if (process.env.OTEL_SEMCONV_STABILITY_OPT_IN === undefined) {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http';
  }
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: isIgnoredIncomingRequest,
      // No header is copied onto spans.
      headersToSpanAttributes: { client: {}, server: {} }
    }),
    new UndiciInstrumentation(),
    new ExpressInstrumentation(),
    new WinstonInstrumentation({ disableLogSending: true })
  ];
}
