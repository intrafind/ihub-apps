// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Web pages in projects are stored snapshots (#3622): a `url` item is fetched
 * by its ingest job, converted from HTML to Markdown once per changed version,
 * stored encrypted like a file from a website, and refreshed by the reconciler
 * after its TTL with a conditional request. Every other reader only decrypts
 * the stored text: a search with cold in-process caches sends nothing to the
 * website. A site crawl hands the pages it read to the add step, so a picked
 * page is not fetched again. Link items written before are converted (the
 * migration for admin project files, the reconciler for every project).
 *
 * A local HTTP(S) server plays the website. `localhost` is on
 * `ssl.domainWhitelist`, so the SSRF guard lets it through and, over HTTPS
 * with `ignoreInvalidCertificates`, its self-signed certificate is accepted;
 * `127.0.0.1` is not whitelisted, so the same server is refused there.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import { evictItemKeys } from '../services/projects/ItemTextStore.js';
import {
  LocalFileKeyProvider,
  _resetKeyProvider,
  registerKeyProvider
} from '../services/projects/crypto/KeyProvider.js';
import { getProjectService } from '../services/projects/ProjectService.js';
import { getProjectRepository } from '../services/projects/ProjectRepository.js';
import {
  bootstrapProjects,
  getIngestService,
  shutdownProjects
} from '../services/projects/bootstrap.js';
import { evictItemText, getItemText } from '../services/knowledge/ItemTextService.js';
import {
  LocalKnowledgeProvider,
  evictProjectIndex
} from '../services/knowledge/LocalKnowledgeProvider.js';
import { ProjectIngestService } from '../services/projects/ProjectIngestService.js';
import {
  DEFAULT_REFRESH_TTL_SECONDS,
  effectiveRefreshMode,
  isRefreshDue,
  isRefreshExpired,
  refreshScheduleOf
} from '../services/projects/refreshTtl.js';
import { providerFor } from '../services/knowledge/registry.js';
import { projectSettings } from '../services/projects/projectSettings.js';
import { crawlSite } from '../services/projects/siteCrawler.js';
import {
  keepCrawledPage,
  newCrawlId,
  takeCrawledPage
} from '../services/projects/crawlHandover.js';
import { downloadWebPage } from '../services/projects/webFileDownload.js';
import { _clearPageCache } from '../services/pageCache.js';
import * as migration from '../migrations/V247__project_web_pages_stored.js';
import { selfSignedCertificate } from './helpers/mockIFinder.js';

const MASTER = crypto.createHash('sha256').update('web-pages-master').digest('hex');
const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };

let scratch = null;
let platform = null;
let server = null;
let tlsServer = null;
let base = '';
let blockedBase = '';
let tlsBase = '';
/** path → { status?, headers, body, etag?, lastModified? } */
const pages = new Map();
/** Requests the website saw: { path, headers }. */
const seen = [];

function setPlatform(overrides = {}) {
  platform = { ...platform, ...overrides };
  configCache.setCacheEntry('config/platform.json', platform);
}

function answer(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const page = pages.get(url.pathname);
  // `delayMs`: a site that answers slowly, so an item stays in progress.
  if (page?.delayMs) {
    setTimeout(() => respond(req, res, url, page), page.delayMs);
    return;
  }
  respond(req, res, url, page);
}

function respond(req, res, url, page) {
  seen.push({ path: url.pathname, headers: req.headers });
  if (!page) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  // `ignoresConditional`: a server that answers every request in full.
  if (!page.ignoresConditional && page.etag && req.headers['if-none-match'] === page.etag) {
    res.writeHead(304, { etag: page.etag });
    res.end();
    return;
  }
  if (
    !page.ignoresConditional &&
    !page.etag &&
    page.lastModified &&
    req.headers['if-modified-since'] &&
    Date.parse(req.headers['if-modified-since']) >= Date.parse(page.lastModified)
  ) {
    res.writeHead(304, { 'last-modified': page.lastModified });
    res.end();
    return;
  }
  const headers = {
    ...page.headers,
    ...(page.etag ? { etag: page.etag } : {}),
    ...(page.lastModified ? { 'last-modified': page.lastModified } : {}),
    'content-length': String(page.body.length)
  };
  res.writeHead(page.status || 200, headers);
  res.end(page.body);
}

function html(title, body, { description = '', links = [] } = {}) {
  return `<!doctype html><html lang="en"><head><title>${title}</title>${
    description ? `<meta name="description" content="${description}">` : ''
  }</head><body><nav><a href="/">Home</a></nav><main><h1>${title}</h1><p>${body}</p>${links
    .map(link => `<a href="${link}">${link}</a>`)
    .join(' ')}</main></body></html>`;
}

function servePage(pathname, body, extra = {}) {
  pages.set(pathname, {
    body: Buffer.from(body),
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...extra
  });
}

/** Requests the website saw for one path. */
function hits(pathname) {
  return seen.filter(entry => entry.path === pathname).length;
}

async function waitFor(check, { timeoutMs = 15000, stepMs = 25 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  throw new Error('timed out waiting');
}

async function itemOf(projectId, itemId) {
  const project = await getProjectRepository().get(projectId);
  return (project?.items || []).find(entry => entry.id === itemId) || null;
}

function settled(projectId, itemId) {
  return waitFor(async () => {
    const item = await itemOf(projectId, itemId);
    return item &&
      item.status !== 'pending' &&
      item.status !== 'extracting' &&
      !item.refreshingAt &&
      !item.ingestAttempt
      ? item
      : null;
  });
}

/** Every in-process cache a reader could answer from: what a second worker starts with. */
function coldCaches() {
  evictItemText();
  evictItemKeys();
  evictProjectIndex();
  _clearPageCache();
}

async function listen(created) {
  await new Promise(resolve => created.listen(0, '127.0.0.1', resolve));
  return created.address().port;
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-web-pages-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const users = { [ADA.id]: { ...ADA, username: 'ada', active: true } };
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  platform = {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['localhost'] },
    projects: {
      limits: {
        maxFiles: 100,
        maxFileBytes: 1024 * 1024,
        maxProjectBytes: 50 * 1024 * 1024,
        maxProjectsPerUser: 0
      }
    }
  };
  setPlatform();
  configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          permissions: { apps: ['*'], projects: true }
        }
      }
    })
  );
  for (const key of ['apps', 'workflows', 'agents', 'projects']) {
    configCache.setCacheEntry(`config/${key}.json`, []);
  }
  registerKeyProvider(
    'local-file',
    () => new LocalFileKeyProvider({ readMasterKey: () => MASTER, readPreviousKey: () => null })
  );
  _resetKeyProvider();
  await bootstrapProjects({ reconcile: false });
  getIngestService().tempDir = path.join(scratch, 'uploads');

  server = http.createServer(answer);
  const port = await listen(server);
  base = `http://localhost:${port}`;
  blockedBase = `http://127.0.0.1:${port}`;
  const certificate = selfSignedCertificate();
  if (certificate) {
    tlsServer = https.createServer(certificate, answer);
    tlsBase = `https://localhost:${await listen(tlsServer)}`;
  }
});

after(async () => {
  shutdownProjects();
  coldCaches();
  await new Promise(resolve => server.close(resolve));
  if (tlsServer) await new Promise(resolve => tlsServer.close(resolve));
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('a web page is a stored snapshot', () => {
  let service = null;

  before(() => {
    service = getProjectService();
  });

  const newProject = (name = 'Pages') =>
    service.createUserProject({ owner: ADA, content: { name } });

  function addUrl(project, url, extra = {}) {
    return service.addItem(project.id, { kind: 'url', ref: { url }, ...extra }, { user: ADA });
  }

  it('fetches the page once, converts it to Markdown and stores it encrypted', async () => {
    servePage(
      '/once',
      html('Pricing', 'Plans start at 42 euros a month.', {
        description: 'What iHub costs'
      }),
      { etag: '"p1"' }
    );
    const project = await newProject();
    seen.length = 0;
    const { item } = await addUrl(project, `${base}/once`);
    assert.equal(item.kind, 'url');
    assert.equal(item.storage, 'text');
    assert.equal(item.status, 'pending');
    const ready = await settled(project.id, item.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(hits('/once'), 1, 'the check on add hands its response to the ingest job');
    assert.equal(ready.name, 'Pricing', 'named after the page title');
    assert.equal(ready.title, 'Pricing');
    assert.equal(ready.description, 'What iHub costs');
    assert.equal(ready.provenance.source.url, `${base}/once`);
    assert.equal(ready.provenance.source.etag, '"p1"');
    assert.ok(ready.text?.blobKey, 'stored like an upload');
    assert.ok(ready.snapshotAt);
    assert.equal(ready.cache, undefined, 'no link cache lifetime any more');
    const stored = await getProjectRepository().get(project.id);
    assert.ok(stored.usage.bytes > 0, 'counted against the project');
    const { text } = await getItemText(stored, ready, { user: ADA });
    assert.match(text, /Plans start at 42 euros/);
    assert.doesNotMatch(text, /<main>/, 'Markdown, not HTML');
    // The blob is ciphertext.
    const blob = await getProjectRepository().blobs.get('project-files', ready.text.blobKey);
    assert.ok(!blob.data.toString('latin1').includes('Plans start at 42'));
  });

  it('searches without fetching, also on a worker whose caches are cold', async () => {
    servePage('/search', html('Opening hours', 'The office opens at nine o clock.'));
    const project = await newProject('Search');
    const { item } = await addUrl(project, `${base}/search`);
    await settled(project.id, item.id);
    const provider = new LocalKnowledgeProvider();
    const ctx = { user: ADA };
    seen.length = 0;
    const first = await provider.search(await getProjectRepository().get(project.id), ctx, {
      query: 'office opens'
    });
    assert.ok(first.hits.length > 0);
    // A second worker: nothing decrypted, indexed or read in this process yet.
    coldCaches();
    const secondWorker = new LocalKnowledgeProvider();
    const second = await secondWorker.search(await getProjectRepository().get(project.id), ctx, {
      query: 'nine o clock'
    });
    assert.ok(second.hits.length > 0);
    assert.match(second.hits[0].text, /opens at nine/);
    assert.equal(hits('/search'), 0, 'no reader fetches the page');
  });

  it('refreshes after the TTL only: an unchanged page is not converted again', async () => {
    servePage('/ttl', html('Policy', 'Version one of the policy.'), { etag: '"v1"' });
    const project = await newProject('TTL');
    const { item } = await addUrl(project, `${base}/ttl`);
    const first = await settled(project.id, item.id);
    const ingest = getIngestService();
    const settings = projectSettings(platform);
    assert.equal(refreshScheduleOf(first, project, settings).scheduled, true);

    seen.length = 0;
    const current = await getProjectRepository().get(project.id);
    assert.equal(await ingest.refreshExpired([current], { now: Date.now() }), 0);
    assert.equal(hits('/ttl'), 0, 'nothing is fetched before the TTL ran out');

    const later = Date.parse(first.checkedAt) + (DEFAULT_REFRESH_TTL_SECONDS + 1) * 1000;
    assert.equal(await ingest.refreshExpired([current], { now: later }), 1);
    // Settled, and its job off this worker's queue (a busy item is not refreshed).
    const unchanged = await waitFor(async () => {
      const entry = await itemOf(project.id, item.id);
      return entry &&
        !entry.refreshingAt &&
        entry.checkedAt !== first.checkedAt &&
        !ingest.isActive(item.id)
        ? entry
        : null;
    });
    assert.equal(hits('/ttl'), 1, 'one request per TTL');
    assert.equal(seen.at(-1).headers['if-none-match'], '"v1"', 'asked conditionally');
    assert.equal(unchanged.text.blobKey, first.text.blobKey, 'the stored text is kept');
    assert.equal(unchanged.text.extractedAt, first.text.extractedAt, 'not converted again');
    assert.equal(unchanged.status, 'ready');

    // A changed page is a new snapshot.
    servePage('/ttl', html('Policy', 'Version two of the policy.'), { etag: '"v2"' });
    const again = Date.parse(unchanged.checkedAt) + (DEFAULT_REFRESH_TTL_SECONDS + 1) * 1000;
    assert.equal(
      await ingest.refreshExpired([await getProjectRepository().get(project.id)], { now: again }),
      1
    );
    const changed = await waitFor(async () => {
      const entry = await itemOf(project.id, item.id);
      return entry && entry.text.blobKey !== first.text.blobKey && !entry.refreshingAt
        ? entry
        : null;
    });
    assert.equal(changed.provenance.source.etag, '"v2"');
    assert.match(
      (await getItemText({ id: project.id }, changed, { user: ADA })).text,
      /Version two/
    );
  });

  it('asks with Last-Modified when the page sends no ETag', async () => {
    const lastModified = new Date(Date.now() - 3600 * 1000).toUTCString();
    servePage('/dated', html('Dated', 'A dated page.'), { lastModified });
    const project = await newProject('Dated');
    const { item } = await addUrl(project, `${base}/dated`);
    const first = await settled(project.id, item.id);
    assert.equal(first.provenance.source.lastModified, lastModified);
    seen.length = 0;
    const { item: refreshed } = await service.refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.equal(seen.at(-1).headers['if-modified-since'], lastModified);
    assert.equal(refreshed.text.blobKey, first.text.blobKey);
    assert.equal(refreshed.text.extractedAt, first.text.extractedAt);
  });

  it('records a page that cannot be read as failed, and a retry fetches it', async () => {
    const project = await newProject('Failing');
    const { item } = await addUrl(project, `${base}/later`, { name: 'Later' });
    const failed = await settled(project.id, item.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'SOURCE_GONE');
    servePage('/later', html('Later', 'It is here now.'));
    const { item: retried } = await service.refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.equal(retried.status, 'ready', JSON.stringify(retried.error));
    assert.equal(retried.name, 'Later', 'a name the user chose is kept');
    assert.match((await getItemText({ id: project.id }, retried, { user: ADA })).text, /here now/);
  });

  it('points an item at another page: the new page is fetched, the old text goes', async () => {
    servePage('/old', html('Old', 'The old page.'));
    servePage('/new', html('New', 'The new page.'));
    const project = await newProject('Moved');
    const { item } = await addUrl(project, `${base}/old`);
    const first = await settled(project.id, item.id);
    await service.updateItem(project.id, item.id, { ref: { url: `${base}/new` } }, { user: ADA });
    const moved = await waitFor(async () => {
      const entry = await itemOf(project.id, item.id);
      return entry?.status === 'ready' && entry.text?.blobKey !== first.text.blobKey ? entry : null;
    });
    assert.equal(moved.ref.url, `${base}/new`);
    assert.equal(first.name, 'Old');
    assert.equal(moved.name, 'New', 'a name taken from the old title follows the new page');
    assert.match((await getItemText({ id: project.id }, moved, { user: ADA })).text, /new page/);

    // While its new page is being fetched, the item takes no other address.
    servePage('/slow', html('Slow', 'A slow page.'), { delayMs: 1500 });
    await service.updateItem(project.id, item.id, { ref: { url: `${base}/slow` } }, { user: ADA });
    await assert.rejects(
      service.updateItem(project.id, item.id, { ref: { url: `${base}/new` } }, { user: ADA }),
      error => error.code === 'PROJECT_MISMATCH'
    );
    await settled(project.id, item.id);
  });

  it('names a page with an address longer than a name after its title', async () => {
    const long = `/long-${'x'.repeat(400)}`;
    const longer = `/longer-${'y'.repeat(400)}`;
    servePage(long, html('Long', 'A long address.'));
    servePage(longer, html('Longer', 'An even longer address.'));
    const project = await newProject('Long');
    const { item } = await addUrl(project, `${base}${long}`);
    assert.equal((await settled(project.id, item.id)).name, 'Long');
    await service.updateItem(
      project.id,
      item.id,
      { ref: { url: `${base}${longer}` } },
      { user: ADA }
    );
    const moved = await waitFor(async () => {
      const entry = await itemOf(project.id, item.id);
      return entry?.status === 'ready' && entry.ref.url.endsWith('y') ? entry : null;
    });
    assert.equal(moved.name, 'Longer');
  });

  it('keeps a name sent with the new address, even when it is the address', async () => {
    servePage('/chosen', html('Chosen title', 'A page.'));
    servePage('/chosen-next', html('Next title', 'Another page.'));
    const project = await newProject('Chosen');
    const { item } = await addUrl(project, `${base}/chosen`);
    await settled(project.id, item.id);
    await service.updateItem(
      project.id,
      item.id,
      { ref: { url: `${base}/chosen-next` }, name: `${base}/chosen-next` },
      { user: ADA }
    );
    const moved = await waitFor(async () => {
      const entry = await itemOf(project.id, item.id);
      return entry?.status === 'ready' && entry.title === 'Next title' ? entry : null;
    });
    assert.equal(moved.name, `${base}/chosen-next`, 'the name the user sent stays');
  });

  it('turns a link not converted yet into a snapshot when its address changes', async () => {
    servePage('/linked-new', html('Linked', 'The address it points at now.'));
    const project = await newProject('Linked');
    const now = new Date().toISOString();
    const legacy = {
      id: `itm_${crypto.randomBytes(6).toString('hex')}`,
      kind: 'url',
      name: 'https://example.com/old',
      ref: { url: 'https://example.com/old' },
      storage: 'link',
      pinned: false,
      status: 'ready',
      error: null,
      provenance: { origin: 'linked', by: null, at: now, run: null, source: null },
      snapshotAt: null,
      createdAt: now,
      updatedAt: now,
      cache: { ttlSeconds: 7200 }
    };
    await getProjectRepository().mutate(project.id, current => {
      current.items = [...(current.items || []), legacy];
      return current;
    });
    await service.updateItem(
      project.id,
      legacy.id,
      { ref: { url: `${base}/linked-new` } },
      { user: ADA }
    );
    const ready = await settled(project.id, legacy.id);
    assert.equal(ready.storage, 'text');
    assert.equal(ready.cache, undefined);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
  });
});

describe('an unchanged page is not downloaded or converted again', () => {
  const newProject = name =>
    getProjectService().createUserProject({ owner: ADA, content: { name } });
  const addUrl = (project, url) =>
    getProjectService().addItem(project.id, { kind: 'url', ref: { url } }, { user: ADA });

  it('stops at the headers when a server ignores the conditional request', async () => {
    servePage('/stubborn', html('Stubborn', 'Always answers in full.'), {
      etag: '"s1"',
      ignoresConditional: true
    });
    const result = await downloadWebPage(`${base}/stubborn`, {
      maxBytes: 1024 * 1024,
      etag: '"s1"'
    });
    assert.equal(result.notModified, true, 'the same ETag in a 200 is the same version');
    assert.equal(result.bytes, undefined, 'the body is not read');

    const project = await newProject('Stubborn');
    const { item } = await addUrl(project, `${base}/stubborn`);
    const first = await settled(project.id, item.id);
    const { item: refreshed } = await getProjectService().refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.equal(refreshed.text.blobKey, first.text.blobKey);
    assert.equal(refreshed.text.extractedAt, first.text.extractedAt);
  });

  it('takes changed bytes as a new version, whatever Last-Modified says', async () => {
    // Stored without a version; later the site sends an old date with new content.
    servePage('/same-date', html('Same date', 'The first text.'));
    const project = await newProject('Same date');
    const { item } = await addUrl(project, `${base}/same-date`);
    const first = await settled(project.id, item.id);
    servePage('/same-date', html('Same date', 'The second text.'), {
      lastModified: new Date(Date.now() - 365 * 24 * 3600 * 1000).toUTCString()
    });
    const { item: changed } = await getProjectService().refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.notEqual(changed.text.blobKey, first.text.blobKey, 'the content decides');
    assert.match(
      (await getItemText({ id: project.id }, changed, { user: ADA })).text,
      /second text/
    );
  });

  it('compares the page itself when it names no version', async () => {
    servePage('/plain', html('Plain', 'No ETag, no Last-Modified.'));
    const project = await newProject('Plain');
    const { item } = await addUrl(project, `${base}/plain`);
    const first = await settled(project.id, item.id);
    assert.match(first.provenance.source.sha256, /^[0-9a-f]{64}$/);

    const { item: same } = await getProjectService().refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.equal(same.text.blobKey, first.text.blobKey, 'the same bytes are not converted');
    assert.equal(same.text.extractedAt, first.text.extractedAt);
    assert.notEqual(same.checkedAt, first.checkedAt, 'but the check is recorded');

    servePage('/plain', html('Plain', 'A new paragraph.'));
    const { item: changed } = await getProjectService().refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.notEqual(changed.text.blobKey, first.text.blobKey);
    assert.match(
      (await getItemText({ id: project.id }, changed, { user: ADA })).text,
      /new paragraph/
    );
  });
});

describe('outbound fetches honor the SSL whitelist', () => {
  it('download a page from a whitelisted host and refuse one that is not', async () => {
    servePage('/guarded', html('Guarded', 'Behind the guard.'));
    seen.length = 0;
    const ok = await downloadWebPage(`${base}/guarded`, { maxBytes: 1024 * 1024 });
    assert.match(ok.bytes.toString('utf8'), /Behind the guard/);
    assert.equal(ok.contentType, 'text/html');
    await assert.rejects(
      downloadWebPage(`${blockedBase}/guarded`, { maxBytes: 1024 * 1024 }),
      error => error.code === 'SSRF_BLOCKED'
    );
    assert.equal(hits('/guarded'), 1, 'nothing was sent to the host that is not whitelisted');

    const project = await getProjectService().createUserProject({
      owner: ADA,
      content: { name: 'Blocked' }
    });
    const { item } = await getProjectService().addItem(
      project.id,
      { kind: 'url', ref: { url: `${blockedBase}/guarded` } },
      { user: ADA }
    );
    const failed = await settled(project.id, item.id);
    assert.equal(failed.status, 'failed');
  });

  it('accept a self-signed certificate only on a whitelisted host', async t => {
    if (!tlsServer) return t.skip('openssl is not available');
    servePage('/tls', html('TLS', 'Over TLS.'));
    const ok = await downloadWebPage(`${tlsBase}/tls`, { maxBytes: 1024 * 1024 });
    assert.match(ok.bytes.toString('utf8'), /Over TLS/);
    const whitelist = platform.ssl;
    setPlatform({ ssl: { ignoreInvalidCertificates: true, domainWhitelist: [] } });
    try {
      await assert.rejects(downloadWebPage(`${tlsBase}/tls`, { maxBytes: 1024 * 1024 }));
    } finally {
      setPlatform({ ssl: whitelist });
    }
  });
});

describe('a site crawl hands its pages to the add step', () => {
  it('keeps only pages it read to the end', async () => {
    const kept = [];
    const crawlId = newCrawlId();
    await crawlSite(
      { url: 'https://site.test/', maxDepth: 1, maxPages: 5 },
      {
        fetchPage: async url =>
          url === 'https://site.test/'
            ? {
                finalUrl: url,
                contentType: 'text/html',
                html: '<a href="/cut">cut</a><a href="/whole">whole</a>',
                complete: true
              }
            : {
                finalUrl: url,
                contentType: 'text/html',
                html: '<p>part</p>',
                complete: !url.endsWith('/cut')
              },
        fetchRobots: async () => null,
        keepPage: async page => {
          kept.push(page.url);
          return keepCrawledPage({ ownerId: ADA.id, crawlId, ...page });
        }
      }
    );
    assert.deepEqual(kept.sort(), ['https://site.test/', 'https://site.test/whole']);
  });

  it('does not wait for a hand-over past the end of the crawl', async () => {
    const started = Date.now();
    const result = await crawlSite(
      { url: 'https://slow.test/', maxDepth: 0 },
      {
        fetchPage: async url => ({
          finalUrl: url,
          contentType: 'text/html',
          html: '<p>x</p>',
          complete: true
        }),
        fetchRobots: async () => null,
        keepPage: () => new Promise(() => {}),
        deadlineMs: 200
      }
    );
    assert.equal(result.pages.length, 1);
    assert.ok(Date.now() - started < 5000, 'the stuck write is left behind');
  });

  it('gives a kept page to one add only, also when two take it at once', async () => {
    const crawlId = newCrawlId();
    const url = `${base}/race`;
    await keepCrawledPage({ ownerId: ADA.id, crawlId, url, html: '<p>race</p>' });
    const taken = await Promise.all([
      takeCrawledPage({ ownerId: ADA.id, crawlId, url }),
      takeCrawledPage({ ownerId: ADA.id, crawlId, url })
    ]);
    assert.equal(taken.filter(Boolean).length, 1);
  });

  it('adds a crawled page without fetching it again', async () => {
    servePage('/site/', html('Site', 'Start.', { links: ['/site/a', '/site/b'] }));
    servePage('/site/a', html('Page A', 'Alpha content.'), { etag: '"a1"' });
    servePage('/site/b', html('Page B', 'Beta content.'));
    const crawlId = newCrawlId();
    seen.length = 0;
    const result = await crawlSite(
      { url: `${base}/site/`, maxDepth: 1, maxPages: 10 },
      { keepPage: page => keepCrawledPage({ ownerId: ADA.id, crawlId, ...page }) }
    );
    const listed = result.pages.map(page => page.url);
    assert.ok(listed.includes(`${base}/site/a`));
    assert.equal(hits('/site/a'), 1);

    const service = getProjectService();
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Crawl' } });
    const { item } = await service.addItem(
      project.id,
      { kind: 'url', ref: { url: `${base}/site/a` }, name: 'Page A', crawlId },
      { user: ADA }
    );
    const ready = await settled(project.id, item.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(hits('/site/a'), 1, 'the crawl read it; neither the check nor the job did');
    assert.equal(ready.provenance.source.etag, '"a1"', 'its version for the first refresh');
    assert.match((await getItemText({ id: project.id }, ready, { user: ADA })).text, /Alpha/);

    // Only the user who crawled may take a page, and only once.
    assert.equal(
      await takeCrawledPage({ ownerId: 'someone-else', crawlId, url: `${base}/site/b` }),
      null
    );
    assert.ok(await takeCrawledPage({ ownerId: ADA.id, crawlId, url: `${base}/site/b` }));
    assert.equal(await takeCrawledPage({ ownerId: ADA.id, crawlId, url: `${base}/site/b` }), null);
  });

  it('fetches a page the crawl did not keep', async () => {
    servePage('/site/c', html('Page C', 'Gamma content.'));
    const service = getProjectService();
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Crawl 2' } });
    seen.length = 0;
    const { item } = await service.addItem(
      project.id,
      { kind: 'url', ref: { url: `${base}/site/c` }, crawlId: newCrawlId() },
      { user: ADA }
    );
    const ready = await settled(project.id, item.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(hits('/site/c'), 1);
  });
});

describe('web pages that were links before', () => {
  /** A `url` item as stored before #3622: a live link. */
  function legacyItem(url) {
    const now = new Date().toISOString();
    return {
      id: `itm_${crypto.randomBytes(6).toString('hex')}`,
      kind: 'url',
      name: url,
      ref: { url },
      storage: 'link',
      pinned: false,
      status: 'ready',
      error: null,
      provenance: { origin: 'linked', by: null, at: now, run: null, source: { url } },
      snapshotAt: null,
      createdAt: now,
      updatedAt: now,
      cache: { ttlSeconds: 7200 }
    };
  }

  it('are converted by the reconciler and fetched by one worker only', async () => {
    servePage('/legacy', html('Legacy', 'A page added as a link.'));
    const service = getProjectService();
    const project = await service.createUserProject({ owner: ADA, content: { name: 'Old' } });
    const legacy = legacyItem(`${base}/legacy`);
    await getProjectRepository().mutate(project.id, current => {
      current.items = [...(current.items || []), legacy];
      return current;
    });
    const worker = () =>
      new ProjectIngestService({
        service: () => getProjectService(),
        repository: () => getProjectService().repository,
        platform: () => configCache.getPlatform(),
        tempDir: path.join(scratch, 'uploads')
      });
    seen.length = 0;
    // Two workers reconcile at the same time.
    await Promise.all([worker().reconcile(), worker().reconcile()]);
    const ready = await settled(project.id, legacy.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(ready.storage, 'text');
    assert.equal(ready.cache, undefined);
    assert.equal(hits('/legacy'), 1, 'one worker fetched it');
    assert.match((await getItemText({ id: project.id }, ready, { user: ADA })).text, /as a link/);
    // Nothing left to convert or fetch.
    seen.length = 0;
    await worker().reconcile();
    assert.equal(hits('/legacy'), 0);
  });

  it('waits in the queue without a reservation another worker would expire', async () => {
    servePage('/queued', html('Queued', 'Fetched after a long queue.'));
    const project = await getProjectService().createUserProject({
      owner: ADA,
      content: { name: 'Queued' }
    });
    const legacy = legacyItem(`${base}/queued`);
    await getProjectRepository().mutate(project.id, current => {
      current.items = [...(current.items || []), legacy];
      return current;
    });
    const make = () =>
      new ProjectIngestService({
        service: () => getProjectService(),
        repository: () => getProjectService().repository,
        platform: () => configCache.getPlatform(),
        tempDir: path.join(scratch, 'uploads')
      });
    const busy = make();
    // Every slot taken: the first fetch waits in this worker's queue.
    busy.running = 99;
    await busy.fetchWaiting([await getProjectRepository().get(project.id)]);
    const queued = await itemOf(project.id, legacy.id);
    assert.equal(queued.status, 'pending');
    assert.equal(queued.ingestAttempt, undefined, 'reserved when its job starts, not before');
    // Another worker, an hour later, does not take it for an interrupted job.
    const other = make();
    other.running = 99;
    await other.reconcile({ now: Date.now() + 60 * 60 * 1000 });
    assert.equal((await itemOf(project.id, legacy.id)).status, 'pending');
    busy.running = 0;
    busy._pump();
    const ready = await settled(project.id, legacy.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
  });

  it('are not refreshed as outdated snapshots before they are converted', async () => {
    const settings = projectSettings({});
    const old = { ...legacyItem('https://example.com/old'), checkedAt: '2020-01-01T00:00:00.000Z' };
    assert.equal(isRefreshExpired(old, {}, settings), false, 'a link has no snapshot to refresh');

    // A refresh by hand converts it and stores its snapshot.
    servePage('/by-hand', html('By hand', 'Refreshed before the reconciler ran.'));
    const project = await getProjectService().createUserProject({
      owner: ADA,
      content: { name: 'By hand' }
    });
    const legacy = legacyItem(`${base}/by-hand`);
    await getProjectRepository().mutate(project.id, current => {
      current.items = [...(current.items || []), legacy];
      return current;
    });
    const { item } = await getProjectService().refreshItem(project.id, legacy.id, {
      user: ADA,
      wait: true
    });
    assert.equal(item.storage, 'text');
    assert.equal(item.cache, undefined);
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
  });

  it('are converted in admin project files by migration V247', async () => {
    const files = new Map([
      [
        'projects/website.json',
        {
          id: 'website',
          ownership: 'admin',
          items: [
            legacyItem('https://example.com/a'),
            { ...legacyItem('https://example.com/b'), status: 'failed', error: { code: 'X' } },
            { id: 'itm_page', kind: 'page', storage: 'link', status: 'ready', ref: {} }
          ]
        }
      ],
      ['projects/notes.json', { id: 'notes', ownership: 'admin', items: [] }]
    ]);
    const written = [];
    const ctx = {
      listFiles: async () => [...files.keys()].map(file => path.basename(file)),
      fileExists: async file => files.has(file),
      readJson: async file => structuredClone(files.get(file)),
      writeJson: async (file, value) => {
        written.push(file);
        files.set(file, value);
      },
      log: () => {},
      warn: () => {}
    };
    assert.equal(await migration.precondition(ctx), true);
    await migration.up(ctx);
    assert.deepEqual(written, ['projects/website.json'], 'only the file with links is written');
    const [a, b, pageItem] = files.get('projects/website.json').items;
    for (const entry of [a, b]) {
      assert.equal(entry.storage, 'text');
      assert.equal(entry.status, 'pending');
      assert.equal(entry.error, null);
      assert.equal(entry.cache, undefined);
      assert.equal(entry.ingestAttempt, undefined);
    }
    assert.equal(pageItem.storage, 'link', 'an iHub page stays a link');
    // Running it again changes nothing.
    written.length = 0;
    await migration.up(ctx);
    assert.deepEqual(written, []);
  });
});

describe('refresh modes: automatically, when used, never', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const service = () => getProjectService();
  const newProject = name => service().createUserProject({ owner: ADA, content: { name } });
  const addUrl = (project, url) =>
    service().addItem(project.id, { kind: 'url', ref: { url } }, { user: ADA });

  /** Make an item's snapshot `days` old, and the project's last use `idleDays` ago. */
  async function age(projectId, itemId, { days = 2, idleDays = 0 } = {}) {
    const at = new Date(Date.now() - days * DAY).toISOString();
    await getProjectRepository().mutate(
      projectId,
      project => {
        const item = project.items.find(entry => entry.id === itemId);
        item.checkedAt = at;
        item.snapshotAt = at;
        project.lastActivityAt = new Date(Date.now() - idleDays * DAY).toISOString();
        return project;
      },
      { touchActivity: false, touchUpdated: false }
    );
    return getProjectRepository().get(projectId);
  }

  it('takes the mode from the item, the project or the platform', () => {
    const settings = projectSettings({ projects: { refreshMode: 'onDemand' } });
    assert.deepEqual(effectiveRefreshMode({}, {}, projectSettings({})), {
      mode: 'auto',
      from: 'platform'
    });
    assert.deepEqual(effectiveRefreshMode({}, {}, settings), {
      mode: 'onDemand',
      from: 'platform'
    });
    assert.deepEqual(effectiveRefreshMode({}, { refreshMode: 'auto' }, settings), {
      mode: 'auto',
      from: 'project'
    });
    assert.deepEqual(
      effectiveRefreshMode({ refreshMode: 'onDemand' }, { refreshMode: 'auto' }, settings),
      { mode: 'onDemand', from: 'item' }
    );
    // Junk falls through to the next level.
    assert.deepEqual(effectiveRefreshMode({ refreshMode: 'often' }, {}, projectSettings({})), {
      mode: 'auto',
      from: 'platform'
    });
  });

  it('refreshes in the background only automatically and while the project is used', () => {
    const settings = projectSettings({});
    const now = Date.now();
    const item = {
      kind: 'url',
      status: 'ready',
      checkedAt: new Date(now - 2 * DAY).toISOString()
    };
    const active = { lastActivityAt: new Date(now - DAY).toISOString() };
    const idle = { lastActivityAt: new Date(now - 30 * DAY).toISOString() };
    assert.equal(isRefreshDue(item, active, settings, now), true);
    assert.equal(isRefreshDue(item, idle, settings, now), false, 'idle: refreshed when used');
    assert.equal(isRefreshDue(item, { ...active, refreshMode: 'onDemand' }, settings, now), false);
    const schedule = refreshScheduleOf(item, idle, settings, now);
    assert.equal(schedule.mode, 'auto');
    assert.equal(schedule.background, false);
    assert.equal(schedule.idle, true);
    assert.equal(schedule.expired, true);
    assert.equal(schedule.nextAt, null, 'no background refresh is planned');
    assert.ok(schedule.outdatedAt);
    assert.equal(refreshScheduleOf(item, active, settings, now).background, true);
  });

  it('leaves an on-demand project alone in the background and refreshes it when used', async () => {
    servePage('/demand', html('Demand', 'Version one.'), { etag: '"d1"' });
    const project = await newProject('On demand');
    await service().updateProject(project.id, { refreshMode: 'onDemand' }, { actor: ADA });
    const { item } = await addUrl(project, `${base}/demand`);
    await settled(project.id, item.id);
    const old = await age(project.id, item.id);
    const ingest = getIngestService();

    seen.length = 0;
    assert.equal(await ingest.refreshExpired([old]), 0, 'the reconciler does not refresh it');
    assert.equal(hits('/demand'), 0);

    // Reading the project's knowledge is a use: its outdated pages are refreshed.
    servePage('/demand', html('Demand', 'Version two.'), { etag: '"d2"' });
    providerFor(old);
    const fresh = await waitFor(async () => {
      const entry = await itemOf(project.id, item.id);
      return entry?.provenance?.source?.etag === '"d2"' && !entry.refreshingAt ? entry : null;
    });
    assert.match((await getItemText({ id: project.id }, fresh, { user: ADA })).text, /two/);
    assert.equal(hits('/demand'), 1);

    // A second use soon after asks nothing: the page is current again.
    seen.length = 0;
    await ingest.refreshOnUse(await getProjectRepository().get(project.id));
    assert.equal(hits('/demand'), 0);
  });

  it('refreshes an idle project only when it is used, and never an item set to never', async () => {
    servePage('/idle', html('Idle', 'Idle page.'), { etag: '"i1"' });
    servePage('/fixed', html('Fixed', 'Fixed page.'), { etag: '"f1"' });
    const project = await newProject('Idle');
    const { item } = await addUrl(project, `${base}/idle`);
    const { item: fixed } = await addUrl(project, `${base}/fixed`);
    await settled(project.id, item.id);
    await settled(project.id, fixed.id);
    await service().updateItem(project.id, fixed.id, { refreshTtl: 'never' }, { user: ADA });
    await age(project.id, fixed.id, { days: 400, idleDays: 30 });
    const old = await age(project.id, item.id, { days: 2, idleDays: 30 });
    const ingest = getIngestService();

    seen.length = 0;
    assert.equal(
      await ingest.refreshExpired([old]),
      0,
      'idle for 30 days: nothing in the background'
    );
    const used = await ingest.refreshOnUse(old);
    assert.equal(used.refreshed, 1, 'the outdated page, not the one set to never');
    await waitFor(async () => {
      const entry = await itemOf(project.id, item.id);
      return entry && !entry.refreshingAt && !ingest.isActive(item.id) ? entry : null;
    });
    assert.equal(hits('/idle'), 1);
    assert.equal(hits('/fixed'), 0);
  });

  /** A page waiting for its first fetch, stored straight into a project. */
  async function waitingPage(project, url) {
    const now = new Date().toISOString();
    const waiting = {
      id: `itm_${crypto.randomBytes(6).toString('hex')}`,
      kind: 'url',
      name: url,
      ref: { url },
      storage: 'text',
      pinned: false,
      status: 'pending',
      error: null,
      provenance: { origin: 'linked', by: null, at: now, run: null, source: null },
      snapshotAt: null,
      createdAt: now,
      updatedAt: now
    };
    await getProjectRepository().mutate(project.id, current => {
      current.items = [...(current.items || []), waiting];
      return current;
    });
    return waiting;
  }

  it('fetches a first snapshot in the background in any mode: there is nothing to answer from', async () => {
    servePage('/later-page', html('Later', 'Fetched before any use.'));
    const project = await newProject('Waiting');
    await service().updateProject(project.id, { refreshMode: 'onDemand' }, { actor: ADA });
    const waiting = await waitingPage(project, `${base}/later-page`);
    // Idle as well: nobody used it for a month.
    await getProjectRepository().mutate(
      project.id,
      current => {
        current.lastActivityAt = new Date(Date.now() - 30 * DAY).toISOString();
        return current;
      },
      { touchActivity: false, touchUpdated: false }
    );
    seen.length = 0;
    await getIngestService().reconcile();
    const ready = await settled(project.id, waiting.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(ready.name, 'Later', 'named after its title');
    assert.equal(hits('/later-page'), 1);
  });

  it('takes a refresh and a new address for a page that waits for its first fetch', async () => {
    servePage('/waits', html('Waits', 'Waiting page.'));
    servePage('/waits-new', html('Waits new', 'Its new address.'));
    const project = await newProject('Waits');
    const first = await waitingPage(project, `${base}/waits`);
    const { item: refreshed } = await service().refreshItem(project.id, first.id, {
      user: ADA,
      wait: true
    });
    assert.equal(refreshed.status, 'ready', JSON.stringify(refreshed.error));

    const second = await waitingPage(project, `${base}/waits`);
    await service().updateItem(
      project.id,
      second.id,
      { ref: { url: `${base}/waits-new` } },
      { user: ADA }
    );
    const moved = await settled(project.id, second.id);
    assert.equal(moved.ref.url, `${base}/waits-new`);
    assert.equal(moved.status, 'ready', JSON.stringify(moved.error));
  });

  it('sets and clears the mode of a project and an item', async () => {
    servePage('/modes', html('Modes', 'Modes.'));
    const project = await newProject('Modes');
    const { item } = await addUrl(project, `${base}/modes`);
    await settled(project.id, item.id);
    const updated = await service().updateProject(
      project.id,
      { refreshMode: 'onDemand' },
      { actor: ADA }
    );
    assert.equal(updated.refreshMode, 'onDemand');
    const { item: own } = await service().updateItem(
      project.id,
      item.id,
      { refreshMode: 'auto' },
      { user: ADA }
    );
    assert.equal(own.refreshMode, 'auto');
    const { item: back } = await service().updateItem(
      project.id,
      item.id,
      { refreshMode: null },
      { user: ADA }
    );
    assert.equal(back.refreshMode, undefined);
    const cleared = await service().updateProject(
      project.id,
      { refreshMode: null },
      { actor: ADA }
    );
    assert.equal(cleared.refreshMode, undefined);
  });
});
