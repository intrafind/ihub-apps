#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Merge shard results and write the report.
 *
 *   node tests/load/report.mjs tests/load/results/<runId>            # shard-*.json in a dir
 *   node tests/load/report.mjs --from-log k8s-logs.txt --out <dir>   # ##LT-RESULT## lines from kubectl logs
 *   ... --target 400                                                  # sizing for 400 concurrent users
 *   ... --workers 4                                                   # if the server could not be sampled
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { mergeMetrics } from './lib/metrics.mjs';
import { renderMarkdown, timelineCsv } from './lib/report.mjs';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

let shards = [];
let outDir = opt('out');
const fromLog = opt('from-log');
if (fromLog) {
  const parts = new Map(); // key runId:shard -> {total, chunks[]}
  for (const line of fs.readFileSync(fromLog, 'utf8').split('\n')) {
    const at = line.indexOf('##LT-RESULT## ');
    if (at === -1) continue;
    const [runId, shard, idx, total, data] = line
      .slice(at + 14)
      .trim()
      .split(' ');
    const key = `${runId}:${shard}`;
    const entry = parts.get(key) || { total: Number(total), chunks: [] };
    entry.chunks[Number(idx)] = data;
    parts.set(key, entry);
  }
  for (const [key, { total, chunks }] of parts) {
    if (chunks.filter(Boolean).length !== total) {
      console.error(
        `incomplete result for ${key}: ${chunks.filter(Boolean).length}/${total} chunks`
      );
      continue;
    }
    shards.push(
      JSON.parse(zlib.gunzipSync(Buffer.from(chunks.join(''), 'base64')).toString('utf8'))
    );
  }
  outDir ||= path.join('tests/load/results', shards[0]?.meta.config.runId || 'from-log');
} else {
  const dir = args.find(a => !a.startsWith('--') && fs.existsSync(a));
  if (!dir) {
    console.error('usage: report.mjs <results dir> | --from-log <file> [--target N] [--workers N]');
    process.exit(1);
  }
  shards = fs
    .readdirSync(dir)
    .filter(f => /^shard-\d+\.json$/.test(f))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  outDir ||= dir;
}
if (!shards.length) {
  console.error('no shard results found');
  process.exit(1);
}

const base = shards.find(s => s.meta.shardIndex === 0) || shards[0];
const merged = {
  meta: {
    ...base.meta,
    shards: shards.length,
    startedAt: Math.min(...shards.map(s => s.meta.startedAt)),
    endedAt: Math.max(...shards.map(s => s.meta.endedAt))
  },
  metrics: mergeMetrics(shards.map(s => s.metrics))
};
if (shards.length !== base.meta.shardCount) {
  console.warn(
    `warning: ${shards.length} of ${base.meta.shardCount} shards present — VU counts in the report are the configured totals`
  );
}
if (opt('target'))
  merged.meta.config.sizing = {
    ...merged.meta.config.sizing,
    targetConcurrentUsers: Number(opt('target'))
  };
if (opt('workers'))
  merged.meta.config.server = { ...merged.meta.config.server, workers: Number(opt('workers')) };

fs.mkdirSync(outDir, { recursive: true });
const { markdown, analysis } = renderMarkdown(merged);
fs.writeFileSync(path.join(outDir, 'report.md'), markdown);
fs.writeFileSync(path.join(outDir, 'timeline.csv'), timelineCsv(merged));
fs.writeFileSync(
  path.join(outDir, 'summary.json'),
  JSON.stringify(
    {
      config: merged.meta.config,
      capacity: analysis.capacity,
      sizing: analysis.sizing,
      hint: analysis.hint,
      stages: analysis.stats
    },
    null,
    2
  )
);
console.log(markdown);
console.log(`\nwritten to ${outDir}/report.md, summary.json, timeline.csv`);
