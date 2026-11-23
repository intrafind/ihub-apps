// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The gauge `ihub.runs.active`: the runs on the run service in progress in
 * this process, by run kind and model. The run service registers its counts
 * when its module loads, which may be before telemetry starts: the provider
 * waits for the gauge, as the index-cache provider does.
 */

import { initializeMetrics, registerRunObservers } from '../telemetry/metrics.js';

function fakeMeterProvider() {
  const gauges = new Map();
  const meter = {
    createHistogram: () => ({ record: () => {} }),
    createCounter: () => ({ add: () => {} }),
    createObservableGauge: name => {
      const gauge = { callbacks: [], addCallback: cb => gauge.callbacks.push(cb) };
      gauges.set(name, gauge);
      return gauge;
    }
  };
  return { provider: { getMeter: () => meter }, gauges };
}

/** What one collection of a gauge observes. */
function observe(gauge) {
  const observed = [];
  for (const callback of gauge.callbacks) {
    callback({ observe: (value, attributes) => observed.push({ value, attributes }) });
  }
  return observed;
}

describe('ihub.runs.active', () => {
  test('observes one value per run kind and model, from a provider registered before telemetry', () => {
    const runs = [
      { kind: 'chat', model: 'gpt-golden', count: 2 },
      { kind: 'subagent', model: 'gpt-golden', count: 1 }
    ];
    registerRunObservers({ getActiveRuns: () => runs });
    const fake = fakeMeterProvider();
    initializeMetrics(fake.provider);
    expect(observe(fake.gauges.get('ihub.runs.active'))).toEqual([
      { value: 2, attributes: { 'run.kind': 'chat', 'gen_ai.request.model': 'gpt-golden' } },
      { value: 1, attributes: { 'run.kind': 'subagent', 'gen_ai.request.model': 'gpt-golden' } }
    ]);
  });

  test('a provider that throws observes nothing and does not break the collection', () => {
    const fake = fakeMeterProvider();
    initializeMetrics(fake.provider);
    registerRunObservers({
      getActiveRuns: () => {
        throw new Error('broken');
      }
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(observe(fake.gauges.get('ihub.runs.active'))).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });
});
