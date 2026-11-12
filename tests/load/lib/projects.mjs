// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Project API helpers shared by setup.mjs and the projectBuild scenario.
 *
 *   POST   /api/projects                         → 201 { id, … }
 *   POST   /api/projects/{id}/items  multipart   → 202 { id, status:"pending" }
 *   POST   /api/projects/{id}/items  {kind:"url"} → 201 ready | 202 pending (document URL)
 *   GET    /api/projects/{id}/items/{itemId}     → { status: pending|extracting|ready|failed|stale }
 *   POST   /api/projects/pickers/url/_crawl      → 200 { ok, pages[] } (synchronous, ≤ 25 s)
 *   PUT    /api/projects/{id}/members            → share
 *   DELETE /api/projects/{id}                    → 204
 */

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './http.mjs';
import { multipart } from './fixtures.mjs';

export async function createProject(client, { name, description, instructions }) {
  const res = await client.request('POST', '/api/projects', {
    json: { name, description, ...(instructions ? { instructions } : {}) },
    name: 'project.create'
  });
  if (res.status !== 201) throw new HttpError('project.create', res.status, res.body);
  return res.body;
}

export async function uploadItem(client, projectId, file) {
  const t0 = performance.now();
  const res = await client.request('POST', `/api/projects/${projectId}/items`, {
    form: multipart(file, { name: file.name }),
    name: 'project.upload'
  });
  if (res.status !== 202 && res.status !== 201)
    throw new HttpError('project.upload', res.status, res.body);
  return { item: res.body, acceptedAt: t0 + res.ms };
}

export async function addUrlItem(client, projectId, url) {
  const res = await client.request('POST', `/api/projects/${projectId}/items`, {
    json: { kind: 'url', ref: { url } },
    name: 'project.addUrl'
  });
  if (res.status !== 201 && res.status !== 202)
    throw new HttpError('project.addUrl', res.status, res.body);
  return res.body;
}

/**
 * Poll items until each is ready/failed. Records `project.ingestReady` (ms from
 * upload accepted to ready) and `project.ingest.<status|code>` counters.
 */
export async function waitForItems(
  client,
  metrics,
  projectId,
  pending,
  { timeoutMs, pollMs = 2000 }
) {
  const open = new Map(pending.map(p => [p.item.id, p]));
  const deadline = performance.now() + timeoutMs;
  const results = { ready: 0, failed: 0, timedOut: 0 };
  while (open.size > 0 && performance.now() < deadline) {
    await delay(pollMs);
    for (const [itemId, p] of [...open]) {
      const res = await client.request('GET', `/api/projects/${projectId}/items/${itemId}`, {
        name: 'project.pollItem'
      });
      if (res.status !== 200) continue;
      const status = res.body?.status;
      if (status === 'ready' || status === 'stale') {
        metrics?.trend('project.ingestReady', performance.now() - p.acceptedAt);
        metrics?.count('project.ingest.ready');
        results.ready += 1;
        open.delete(itemId);
      } else if (status === 'failed') {
        metrics?.count(`project.ingest.failed.${res.body?.error?.code || 'UNKNOWN'}`);
        metrics?.error('project.ingest', res.body?.error?.code || 'FAILED');
        results.failed += 1;
        open.delete(itemId);
      }
    }
  }
  if (open.size > 0) {
    metrics?.count('project.ingest.timeout', open.size);
    metrics?.error('project.ingest', 'TIMEOUT');
    results.timedOut = open.size;
  }
  return results;
}

export async function crawl(client, metrics, { url, maxPages, maxDepth }) {
  const t0 = performance.now();
  const res = await client.request('POST', '/api/projects/pickers/url/_crawl', {
    json: { url, maxPages, maxDepth, samePath: true },
    name: 'project.crawl',
    timeoutMs: 60_000
  });
  if (res.status !== 200) throw new HttpError('project.crawl', res.status, res.body);
  if (!res.body?.ok) {
    const code = res.body?.errorCode || res.body?.code || 'CRAWL_FAILED';
    metrics?.error('project.crawl', code);
    throw Object.assign(new Error(`crawl failed: ${code} ${res.body?.error || ''}`), { code });
  }
  const pages = res.body.pages || [];
  metrics?.trend('project.crawlPages', pages.length);
  metrics?.trend('project.crawlMsPerPage', (performance.now() - t0) / Math.max(1, pages.length));
  return pages;
}

export async function shareWithGroup(client, projectId, groupId) {
  const res = await client.request('PUT', `/api/projects/${projectId}/members`, {
    json: { members: [{ type: 'group', id: groupId, role: 'user' }] }
  });
  if (res.status >= 300) throw new HttpError('project.share', res.status, res.body);
}

export async function deleteProject(client, projectId) {
  const res = await client.request('DELETE', `/api/projects/${projectId}`, {
    name: 'project.delete'
  });
  if (res.status !== 204 && res.status !== 404)
    throw new HttpError('project.delete', res.status, res.body);
}

export async function listProjects(client) {
  const res = await client.request('GET', '/api/projects?scope=all', { name: 'project.list' });
  if (res.status !== 200) throw new HttpError('project.list', res.status, res.body);
  return res.body?.items || [];
}
