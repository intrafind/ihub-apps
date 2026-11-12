// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A user building a project end to end:
 *   create → upload N documents → wait for ingestion → crawl a site →
 *   add the found pages as URL items → chat in the project → delete it.
 *
 * Ingestion runs on a per-worker queue (`projects.ingest.concurrency`, default 2)
 * and extraction is CPU on the event loop, so this scenario is what interferes
 * with chat latency. The crawl is synchronous (≤ 25 s, one per user per process).
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ChatSession } from '../lib/chat.mjs';
import { questionsFor } from '../lib/fixtures.mjs';
import {
  createProject,
  uploadItem,
  waitForItems,
  crawl,
  addUrlItem,
  deleteProject
} from '../lib/projects.mjs';

export default async function projectBuild(ctx) {
  const s = ctx.config.scenarios.projectBuild;
  const { client, metrics } = ctx;
  // No scans: a project cannot use a file without a text layer (NO_TEXT).
  const topicFiles = ctx.fixtures.filter(f => f.buffer.length <= s.maxFileBytes && !f.noText);
  const project = await createProject(client, {
    name: `LT-build ${ctx.user.username} ${randomUUID().slice(0, 8)}`,
    description: 'loadtest build scenario',
    instructions: 'Answer only from the project documents and cite the document name.'
  });

  try {
    // Upload like a user dropping several files: a few in parallel.
    const files = Array.from({ length: ctx.between(s.files) }, () => ctx.pick(topicFiles));
    const pending = [];
    for (let i = 0; i < files.length; i += s.uploadParallel) {
      const batch = files.slice(i, i + s.uploadParallel);
      const results = await Promise.allSettled(batch.map(f => uploadItem(client, project.id, f)));
      for (const r of results) {
        if (r.status === 'fulfilled') pending.push(r.value);
        else metrics.error('project.upload', r.reason?.code || 'FAILED');
      }
    }
    await waitForItems(client, metrics, project.id, pending, {
      timeoutMs: s.ingestTimeoutSec * 1000
    });

    if (s.crawl?.url) {
      let pages = [];
      try {
        // Capped per runner shard (crawl.maxConcurrent): the target is a real
        // website, and every crawl opens 4 parallel fetches against it.
        pages = await ctx.crawlGate.use(() => crawl(client, metrics, s.crawl));
      } catch (err) {
        if (err.code !== 'CRAWL_RUNNING') throw err;
      }
      const toAdd = pages.filter(p => p.type !== 'document').slice(0, s.crawl.addPages);
      const pendingDocs = [];
      for (const page of toAdd) {
        const item = await addUrlItem(client, project.id, page.url);
        if (item?.status === 'pending') pendingDocs.push({ item, acceptedAt: performance.now() });
      }
      metrics.trend('project.urlItemsAdded', toAdd.length);
      if (pendingDocs.length) {
        await waitForItems(client, metrics, project.id, pendingDocs, {
          timeoutMs: s.ingestTimeoutSec * 1000
        });
      }
    }

    if (s.chatTurns > 0) {
      const questions = questionsFor(files[0]?.topic);
      const session = await new ChatSession(ctx, {
        appId: ctx.config.appId,
        label: 'projectBuildChat'
      }).open();
      try {
        for (let t = 0; t < s.chatTurns && ctx.isActive(); t++) {
          await session.turn({
            content: `${ctx.pick(questions)} ${ctx.config.answerLengthHint}`.trim(),
            body: { projectId: project.id }
          });
          if (t < s.chatTurns - 1) await ctx.think();
        }
      } finally {
        session.close();
      }
    }
  } finally {
    if (s.deleteAfter) await deleteProject(client, project.id).catch(() => {});
  }
}
