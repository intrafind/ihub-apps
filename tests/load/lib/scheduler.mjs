// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Closed-model scheduler: a virtual user (VU) is one concurrently active human.
 * Each stage ramps the total VU count linearly to `vus` over `rampSec`, then
 * holds it for `holdSec`. Metrics are filed under stage "<k>" while holding and
 * "ramp<k>" while ramping, so per-level numbers are not diluted by ramps.
 *
 * Sharding: global VU i belongs to shard (i % shardCount). Every shard follows
 * the same timeline, so N runner pods together produce the configured totals.
 */

import { setTimeout as delay } from 'node:timers/promises';

export function buildTimeline(stages) {
  let t = 0;
  let prev = 0;
  return stages.map((stage, index) => {
    const ramp = { start: t, end: t + (stage.rampSec || 0) * 1000, from: prev, to: stage.vus };
    t = ramp.end;
    const hold = { start: t, end: t + (stage.holdSec || 0) * 1000 };
    t = hold.end;
    prev = stage.vus;
    return { index, name: stage.name || `stage-${index + 1}`, vus: stage.vus, ramp, hold };
  });
}

function targetAt(timeline, elapsed) {
  for (const s of timeline) {
    if (elapsed < s.ramp.end) {
      const span = s.ramp.end - s.ramp.start;
      const f = span > 0 ? (elapsed - s.ramp.start) / span : 1;
      return {
        vus: Math.round(s.ramp.from + (s.ramp.to - s.ramp.from) * f),
        stage: `ramp${s.index}`
      };
    }
    if (elapsed < s.hold.end) return { vus: s.vus, stage: String(s.index) };
  }
  return null;
}

/**
 * @param {object} opts
 * @param {Array} opts.stages
 * @param {number} opts.shardIndex
 * @param {number} opts.shardCount
 * @param {import('./metrics.mjs').Metrics} opts.metrics
 * @param {(vuIndex:number, isActive:() => boolean) => Promise<void>} opts.runVu  runs sessions until isActive() is false
 * @param {number} [opts.gracefulStopSec]
 * @param {(info:object) => void} [opts.onTick]
 */
export async function runSchedule({
  stages,
  shardIndex = 0,
  shardCount = 1,
  metrics,
  runVu,
  gracefulStopSec = 120,
  onTick = () => {}
}) {
  const timeline = buildTimeline(stages);
  const startedAt = Date.now();
  const running = new Map(); // vuIndex -> Promise
  let target = 0;
  let lastStage = null;

  const isActiveFor = i => () => i < target;

  for (;;) {
    const elapsed = Date.now() - startedAt;
    const now = targetAt(timeline, elapsed);
    if (!now) break;
    target = now.vus;
    if (now.stage !== lastStage) {
      metrics.setStage(now.stage);
      lastStage = now.stage;
    }
    for (let i = shardIndex; i < target; i += shardCount) {
      if (!running.has(i)) {
        const p = runVu(i, isActiveFor(i))
          .catch(err => {
            metrics.error('vu', err.code || err.name || 'CRASH');
          })
          .finally(() => running.delete(i));
        running.set(i, p);
      }
    }
    metrics.gauge('runner.activeVus', running.size);
    onTick({ elapsed, target, stage: now.stage, active: running.size, timeline });
    await delay(1000);
  }

  // Let in-flight sessions finish their current step, then give up.
  target = 0;
  metrics.setStage('drain');
  const all = Promise.allSettled([...running.values()]);
  const timedOut = await Promise.race([
    all.then(() => false),
    delay(gracefulStopSec * 1000).then(() => true)
  ]);
  return { timeline, startedAt, endedAt: Date.now(), abandonedVus: timedOut ? running.size : 0 };
}
