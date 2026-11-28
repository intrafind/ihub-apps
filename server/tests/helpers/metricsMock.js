// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A stand-in for `telemetry/metrics.js` in `jest.unstable_mockModule`: every
 * function the module exports is a no-op, every other export an empty frozen
 * array. ESM mocks must name every export a loaded module imports, so a mock
 * that lists only the functions one test cares about breaks as soon as code
 * the test loads records a new metric.
 *
 *   jest.unstable_mockModule('../telemetry/metrics.js', () =>
 *     metricsMock({ recordAuthEvent: (...args) => calls.push(args) })
 *   );
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../../telemetry/metrics.js', import.meta.url));

/**
 * @param {Object<string, *>} [overrides] - Exports to replace with your own
 * @returns {Object<string, *>} The mock module
 */
export function metricsMock(overrides = {}) {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const mock = {};
  for (const [, name] of source.matchAll(/^export (?:async )?function (\w+)/gm)) {
    mock[name] = () => {};
  }
  for (const [, name] of source.matchAll(/^export const (\w+)/gm)) {
    mock[name] = Object.freeze([]);
  }
  return { ...mock, ...overrides };
}
