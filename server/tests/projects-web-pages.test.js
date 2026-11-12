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
import { DEFAULT_REFRESH_TTL_SECONDS, refreshScheduleOf } from '../services/projects/refreshTtl.js';
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
  seen.push({ path: url.pathname, headers: req.headers });
  const page = pages.get(url.pathname);
  if (!page) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (page.etag && req.headers['if-none-match'] === page.etag) {
    res.writeHead(304, { etag: page.etag });
    res.end();
    return;
  }
  if (
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
    assert.match((await getItemText({ id: project.id }, moved, { user: ADA })).text, /new page/);
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
