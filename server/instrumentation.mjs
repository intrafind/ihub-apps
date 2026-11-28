// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Telemetry bootstrap, loaded with `node --import ./instrumentation.mjs` before
 * the server.
 *
 * Library instrumentation (HTTP, Express, undici, winston) works by patching a
 * module when it is loaded. The server is ESM, and `initTelemetry` used to run
 * after `express`, `http` and winston were already imported, so none of them
 * was patched: inbound requests had no span and no `http.route`, an incoming
 * `traceparent` was ignored, and outbound calls did not carry the trace on.
 *
 * This file runs before any application module. It reads the `telemetry` block
 * of `platform.json`, and when telemetry is on:
 * 1. registers the ESM loader hook of `@opentelemetry/instrumentation` (only
 *    with `autoInstrumentation: true`) and creates the instrumentations, so
 *    every module loaded from here on can be patched;
 * 2. starts the SDK (`initTelemetry`), handing it those instrumentations.
 *
 * The later `initTelemetry` call in `startup/worker.js` then finds the SDK
 * running and does nothing. Without this file (an older start command, tests)
 * the server starts telemetry as before, only without library spans.
 *
 * Not in a cluster primary (it only supervises) and not in worker threads
 * (they inherit `--import`). A failure here is logged and never stops the
 * server.
 */

import cluster from 'node:cluster';
import fs from 'node:fs';
import module from 'node:module';
import { isMainThread } from 'node:worker_threads';

/**
 * The `telemetry` block of platform.json, or null when the file is missing or
 * unreadable (first start: the defaults have telemetry off anyway).
 */
function readTelemetryBlock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.telemetry ?? null;
  } catch {
    return null;
  }
}

async function bootstrap() {
  if (!isMainThread) return;
  if (/^(true|1)$/i.test(process.env.OTEL_SDK_DISABLED ?? '')) return;

  // config.js and contentsPath.js load only dotenv and Node built-ins, so the
  // modules that must be patched are still unloaded after this.
  const { default: config } = await import('./config.js');
  if (cluster.isPrimary && config.WORKERS > 1) return;
  const { getContentsPath } = await import('./utils/contentsPath.js');
  const telemetry = readTelemetryBlock(getContentsPath('config', 'platform.json'));
  if (telemetry?.enabled !== true) return;

  let instrumentations = [];
  if (telemetry.autoInstrumentation === true) {
    module.register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
    const { createInstrumentations } = await import('./telemetry/autoInstrumentation.js');
    instrumentations = createInstrumentations();
  }

  const { initTelemetry } = await import('./telemetry.js');
  await initTelemetry(telemetry, { instrumentations, bootstrap: true });
}

try {
  await bootstrap();
} catch (error) {
  // The logger may not be loadable here; stderr is what is left.
  process.stderr.write(
    `${JSON.stringify({
      component: 'Telemetry',
      level: 'error',
      message: 'Telemetry bootstrap failed; the server starts without it',
      error: error?.message
    })}\n`
  );
}
