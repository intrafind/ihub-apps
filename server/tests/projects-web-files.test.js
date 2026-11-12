// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files linked from websites (#3536): a URL that serves a document becomes a
 * `web-file` item, downloaded through the page reader's guarded fetch and
 * stored like an upload (quotas, scan, extraction); HTML stays a `url` item
 * (a stored snapshot since #3622, see `projects-web-pages.test.js`).
 * The refresh TTL (platform, project, item, `never`) drives the reconciler's
 * refresh of expired files, with conditional requests.
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
  documentFromUrl,
  downloadWebFile,
  fileNameOf,
  probeWebUrl
} from '../services/projects/webFileDownload.js';
import { ProjectIngestService } from '../services/projects/ProjectIngestService.js';
import {
  DEFAULT_REFRESH_TTL_SECONDS,
  effectiveRefreshTtl,
  isRefreshDue,
  normalizeRefreshTtl,
  refreshScheduleOf
} from '../services/projects/refreshTtl.js';
import { projectSettings } from '../services/projects/projectSettings.js';
import { serializeItem } from '../services/projects/projectView.js';
import { crawlSite, isDocumentResponse, linkTypeOf } from '../services/projects/siteCrawler.js';
import * as migration from '../migrations/V237__project_refresh_ttl.js';
import { buildDocx, p as docxP } from './helpers/docxFile.js';
import { buildPptx, shape, slide } from './helpers/pptxFile.js';
import { buildOdf, p as odfP } from './helpers/odfFile.js';
import { selfSignedCertificate } from './helpers/mockIFinder.js';

const MASTER = crypto.createHash('sha256').update('web-files-master').digest('hex');
const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let scratch = null;
let platform = null;
let server = null;
let tlsServer = null;
let base = '';
let blockedBase = '';
let tlsBase = '';
/** path → { status?, headers, body, etag?, chunked? } */
const files = new Map();
/** Requests the website saw: { path, headers }. */
const seen = [];

function setPlatform(overrides = {}) {
  platform = { ...platform, ...overrides };
  configCache.setCacheEntry('config/platform.json', platform);
}

function setProjects(projects) {
  setPlatform({ projects: { ...(platform?.projects || {}), ...projects } });
}

function answer(req, res) {
  const url = new URL(req.url, 'http://localhost');
  seen.push({ path: url.pathname, headers: req.headers });
  const file = files.get(url.pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (file.etag && req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, { etag: file.etag });
    res.end();
    return;
  }
  const headers = { ...file.headers, ...(file.etag ? { etag: file.etag } : {}) };
  if (!file.chunked) headers['content-length'] = String(file.body.length);
  res.writeHead(file.status || 200, headers);
  if (file.chunked) {
    // Without a declared length: the reader finds the size as it goes.
    for (let at = 0; at < file.body.length; at += 64 * 1024) {
      res.write(file.body.subarray(at, at + 64 * 1024));
    }
    res.end();
  } else {
    res.end(file.body);
  }
}

function serve(pathname, body, headers, extra = {}) {
  files.set(pathname, { body: Buffer.from(body), headers, ...extra });
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
    return item && item.status !== 'pending' && item.status !== 'extracting' && !item.refreshingAt
      ? item
      : null;
  });
}

async function makePdf(text) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 300]).drawText(text, { x: 20, y: 250, size: 10, font });
  return Buffer.from(await doc.save());
}

async function makeXlsx() {
  const XLSX = (await import('xlsx')).default || (await import('xlsx'));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Item', 'Amount'],
      ['Rent', 1200]
    ]),
    'Budget'
  );
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

async function listen(created) {
  await new Promise(resolve => created.listen(0, '127.0.0.1', resolve));
  return created.address().port;
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-web-files-'));
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
    // `localhost` is trusted (the SSRF guard lets it through, its certificate
    // is not checked); `127.0.0.1` is not.
    ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['localhost'] }
  };
  setProjects({
    limits: {
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxProjectBytes: 50 * 1024 * 1024,
      maxProjectsPerUser: 0
    }
  });
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
  evictItemText();
  evictItemKeys();
  await new Promise(resolve => server.close(resolve));
  if (tlsServer) await new Promise(resolve => tlsServer.close(resolve));
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('refresh TTL rules', () => {
  const settings = projectSettings({ projects: { refreshTtl: 7200 } });
  const file = { kind: 'web-file', status: 'ready', snapshotAt: '2026-11-01T00:00:00.000Z' };

  it('takes the item, then the project, then the platform, then the built-in default', () => {
    assert.deepEqual(effectiveRefreshTtl(file, {}, settings), { ttl: 7200, from: 'platform' });
    assert.deepEqual(effectiveRefreshTtl(file, { refreshTtl: 3600 }, settings), {
      ttl: 3600,
      from: 'project'
    });
    assert.deepEqual(
      effectiveRefreshTtl({ ...file, refreshTtl: 'never' }, { refreshTtl: 3600 }, settings),
      {
        ttl: 'never',
        from: 'item'
      }
    );
    assert.equal(projectSettings({}).refreshTtl, DEFAULT_REFRESH_TTL_SECONDS);
    // A stored value out of bounds is clamped, junk ignored.
    assert.equal(normalizeRefreshTtl(10), 900);
    assert.equal(normalizeRefreshTtl('soon'), null);
  });

  it('says when a file or a web page is due, never for `never`', () => {
    const at = Date.parse(file.snapshotAt);
    assert.equal(isRefreshDue(file, {}, settings, at + 7199 * 1000), false);
    assert.equal(isRefreshDue(file, {}, settings, at + 7200 * 1000), true);
    // A later check counts, not the snapshot.
    assert.equal(
      isRefreshDue(
        { ...file, checkedAt: '2026-11-01T01:00:00.000Z' },
        {},
        settings,
        at + 7200 * 1000
      ),
      false
    );
    assert.equal(isRefreshDue({ ...file, refreshTtl: 'never' }, {}, settings, at + 1e12), false);
    assert.equal(isRefreshDue({ ...file, refreshingAt: 'x' }, {}, settings, at + 1e12), false);
    // A picked cloud document stays manual: its refresh needs the picker's connection.
    assert.equal(isRefreshDue({ ...file, kind: 'office365' }, {}, settings, at + 1e12), false);
    const schedule = refreshScheduleOf(file, {}, settings);
    assert.equal(schedule.nextAt, new Date(at + 7200 * 1000).toISOString());
    // A web page is a snapshot refreshed on schedule like a file (#3622).
    const page = { ...file, kind: 'url' };
    assert.equal(refreshScheduleOf(page, { refreshTtl: 86400 }, settings).scheduled, true);
    assert.equal(isRefreshDue(page, {}, settings, at + 7200 * 1000), true);
    assert.equal(refreshScheduleOf({ kind: 'upload' }, {}, settings), null);
    assert.equal(serializeItem(file, { refreshTtl: 3600 }, settings).refresh.ttl, 3600);
  });
});

describe('downloads through the page reader', () => {
  it('download from a whitelisted host and refuse one that is not', async () => {
    serve('/guarded.pdf', await makePdf('Guarded'), { 'content-type': 'application/pdf' });
    const ok = await downloadWebFile(`${base}/guarded.pdf`, { maxBytes: 1024 * 1024 });
    assert.equal(ok.contentType, 'application/pdf');
    assert.equal(ok.name, 'guarded.pdf');
    await assert.rejects(
      downloadWebFile(`${blockedBase}/guarded.pdf`, { maxBytes: 1024 * 1024 }),
      error => error.code === 'SSRF_BLOCKED'
    );
    // At add time an unreachable or refused address stays a link, as before.
    assert.equal(await probeWebUrl(`${blockedBase}/guarded.pdf`), null);
  });

  it('accept a self-signed certificate only on a whitelisted host', async t => {
    if (!tlsServer) return t.skip('openssl is not available');
    serve('/tls.pdf', await makePdf('Over TLS'), { 'content-type': 'application/pdf' });
    const ok = await downloadWebFile(`${tlsBase}/tls.pdf`, { maxBytes: 1024 * 1024 });
    assert.equal(ok.bytes.subarray(0, 5).toString(), '%PDF-');
    setPlatform({
      ssl: { ignoreInvalidCertificates: true, domainWhitelist: [] },
      ssrf: { allowedHosts: ['localhost'] }
    });
    try {
      await assert.rejects(downloadWebFile(`${tlsBase}/tls.pdf`, { maxBytes: 1024 * 1024 }));
    } finally {
      setPlatform({
        ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['localhost'] },
        ssrf: {}
      });
    }
  });

  it('read the file name from Content-Disposition, else from the path', () => {
    assert.equal(
      fileNameOf('attachment; filename="Q3 Report.pptx"', 'https://x/a'),
      'Q3 Report.pptx'
    );
    assert.equal(
      fileNameOf("attachment; filename*=UTF-8''Gr%C3%BC%C3%9Fe.docx", 'https://x/a'),
      'Grüße.docx'
    );
    assert.equal(fileNameOf('attachment; filename="../../etc/passwd"', 'https://x/a'), 'passwd');
    assert.equal(fileNameOf(null, 'https://x/docs/Plan%20B.odt?v=2'), 'Plan B.odt');
  });
});

describe('web files in a project', () => {
  let service = null;

  before(() => {
    service = getProjectService();
  });

  const newProject = (name = 'Web') => service.createUserProject({ owner: ADA, content: { name } });

  async function addUrl(project, url, extra = {}) {
    return service.addItem(project.id, { kind: 'url', ref: { url }, ...extra }, { user: ADA });
  }

  it('downloads a linked PDF like an upload and keeps the source URL', async () => {
    const pdf = await makePdf('The lease runs until 2030.');
    serve('/docs/lease.pdf', pdf, { 'content-type': 'application/pdf' });
    const project = await newProject();
    const { item } = await addUrl(project, `${base}/docs/lease.pdf`);
    assert.equal(item.kind, 'web-file');
    assert.equal(item.storage, 'text');
    assert.equal(item.provenance.origin, 'picked');
    assert.equal(item.name, 'lease.pdf');
    const ready = await settled(project.id, item.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(ready.provenance.source.url, `${base}/docs/lease.pdf`);
    assert.ok(ready.snapshotAt);
    const stored = await getProjectRepository().get(project.id);
    assert.equal(stored.usage.bytes, pdf.length, 'counted against the project like an upload');
    const { text } = await getItemText(stored, ready, { user: ADA });
    assert.match(text, /lease runs until 2030/);
  });

  it('reads every Office and OpenDocument type', async () => {
    const cell = text =>
      `<table:table-cell office:value-type="string">${odfP(text)}</table:table-cell>`;
    const cases = [
      ['/f/memo.docx', await buildDocx({ body: docxP('Word memo text') }), DOCX, /Word memo text/],
      [
        '/f/deck.pptx',
        await buildPptx([slide([shape(['Slide title text'], 'title')])], [0]),
        PPTX,
        /Slide title text/
      ],
      ['/f/budget.xlsx', await makeXlsx(), XLSX_MIME, /Rent/],
      [
        '/f/note.odt',
        await buildOdf('text', odfP('OpenDocument text body')),
        'application/vnd.oasis.opendocument.text',
        /OpenDocument text body/
      ],
      [
        '/f/sheet.ods',
        await buildOdf(
          'spreadsheet',
          `<table:table table:name="S"><table:table-row>${cell('Cell value')}</table:table-row></table:table>`
        ),
        'application/vnd.oasis.opendocument.spreadsheet',
        /Cell value/
      ],
      [
        '/f/talk.odp',
        await buildOdf(
          'presentation',
          `<draw:page><draw:frame><draw:text-box>${odfP('Presentation line')}</draw:text-box></draw:frame></draw:page>`
        ),
        'application/vnd.oasis.opendocument.presentation',
        /Presentation line/
      ]
    ];
    const project = await newProject('Office');
    for (const [pathname, body, type, expected] of cases) {
      // A generic type: the extension and the bytes decide, as for an upload.
      serve(pathname, body, {
        'content-type': pathname.endsWith('.docx') ? 'application/octet-stream' : type
      });
      const { item } = await addUrl(project, `${base}${pathname}`);
      assert.equal(item.kind, 'web-file', pathname);
      const ready = await settled(project.id, item.id);
      assert.equal(ready.status, 'ready', `${pathname}: ${JSON.stringify(ready.error)}`);
      const { text } = await getItemText({ id: project.id }, ready, { user: ADA });
      assert.match(text, expected, pathname);
    }
  });

  it('adds a document address it cannot check now as a file, which a retry downloads', async () => {
    files.set('/later/report.pdf', { status: 503, body: Buffer.from('busy'), headers: {} });
    const project = await newProject('Unreachable');
    const { item } = await addUrl(project, `${base}/later/report.pdf`);
    assert.equal(item.kind, 'web-file', 'the extension decides when the check fails');
    const failed = await settled(project.id, item.id);
    assert.equal(failed.status, 'failed');
    // The site is back: a retry (a refresh) downloads it.
    serve('/later/report.pdf', await makePdf('Back online.'), {
      'content-type': 'application/pdf'
    });
    const { item: ready } = await service.refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.equal(ready.status, 'ready');
    assert.match((await getItemText({ id: project.id }, ready, { user: ADA })).text, /Back online/);
    // A page address that cannot be checked stays a link, as before.
    files.set('/later/page', { status: 503, body: Buffer.from('busy'), headers: {} });
    const { item: page } = await addUrl(project, `${base}/later/page`);
    assert.equal(page.kind, 'url');
    assert.equal(documentFromUrl('https://x.example/a/notes.docx').name, 'notes.docx');
    assert.equal(documentFromUrl('https://x.example/a/old.doc'), null);
  });

  it('keeps an HTML page a web page item and refuses a type nothing reads', async () => {
    serve(
      '/page',
      '<html><head><title>A page</title></head><body><main>Hello</main></body></html>',
      {
        'content-type': 'text/html; charset=utf-8'
      }
    );
    serve('/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), {
      'content-type': 'image/png'
    });
    const project = await newProject('Links');
    const { item } = await addUrl(project, `${base}/page`);
    assert.equal(item.kind, 'url');
    assert.equal(item.storage, 'text');
    assert.equal((await settled(project.id, item.id)).name, 'A page');
    await assert.rejects(
      addUrl(project, `${base}/photo.png`),
      error => error.code === 'UNSUPPORTED_TYPE'
    );
    // A web page cannot be pointed at a file: that is a new item.
    serve('/later.pdf', await makePdf('Later'), { 'content-type': 'application/pdf' });
    await assert.rejects(
      service.updateItem(project.id, item.id, { ref: { url: `${base}/later.pdf` } }, { user: ADA }),
      error => error.code === 'INVALID_REF'
    );
  });

  it('refuses a file over maxFileBytes, declared or streamed', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 0x41);
    serve('/big.txt', big, { 'content-type': 'text/plain' });
    const project = await newProject('Big');
    await assert.rejects(
      addUrl(project, `${base}/big.txt`),
      error => error.code === 'QUOTA_FILE_BYTES'
    );
    // No Content-Length: the download is cut off as it passes the limit.
    serve('/stream.txt', big, { 'content-type': 'text/plain' }, { chunked: true });
    const { item } = await addUrl(project, `${base}/stream.txt`);
    const failed = await settled(project.id, item.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'QUOTA_FILE_BYTES');
  });

  it('runs the malware scan on a download', async () => {
    serve('/eicar.txt', 'X5O!P%@AP', { 'content-type': 'text/plain' });
    const ingest = getIngestService();
    const previous = ingest._scanner;
    ingest._scanner = { id: 'fake', scan: async () => ({ verdict: 'infected', detail: 'EICAR' }) };
    try {
      const project = await newProject('Scan');
      const { item } = await addUrl(project, `${base}/eicar.txt`);
      const failed = await settled(project.id, item.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'SCAN_REJECTED');
    } finally {
      ingest._scanner = previous;
    }
  });

  it('trusts a changed ETag over an unchanged Last-Modified, and keeps the text when a page answers', async () => {
    const stamp = 'Tue, 03 Nov 2026 10:00:00 GMT';
    serve(
      '/kept-mtime.txt',
      'Deployed version one.',
      { 'content-type': 'text/plain', 'last-modified': stamp },
      { etag: '"a"' }
    );
    const project = await newProject('Etag');
    const { item } = await addUrl(project, `${base}/kept-mtime.txt`);
    const first = await settled(project.id, item.id);
    // Same mtime (kept by the deploy), new ETag: a change.
    serve(
      '/kept-mtime.txt',
      'Deployed version two.',
      { 'content-type': 'text/plain', 'last-modified': stamp },
      { etag: '"b"' }
    );
    const { item: changed } = await service.refreshItem(project.id, item.id, {
      user: ADA,
      wait: true
    });
    assert.notEqual(changed.text.blobKey, first.text.blobKey);
    assert.match((await getItemText({ id: project.id }, changed, { user: ADA })).text, /two/);

    // The file now redirects to a sign-in page: refused, the text stays.
    serve('/kept-mtime.txt', '<html><body>Sign in</body></html>', {
      'content-type': 'text/html'
    });
    await assert.rejects(
      service.refreshItem(project.id, item.id, { user: ADA, wait: true }),
      error => error.code === 'SOURCE_FORBIDDEN'
    );
    const stale = await itemOf(project.id, item.id);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.text.blobKey, changed.text.blobKey);
  });

  it('refreshes after the TTL: an unchanged ETag keeps the text, a changed file replaces it', async () => {
    serve('/policy.txt', 'Policy version one.', { 'content-type': 'text/plain' }, { etag: '"v1"' });
    const project = await newProject('Refresh');
    const { item } = await addUrl(project, `${base}/policy.txt`);
    const first = await settled(project.id, item.id);
    assert.equal(first.provenance.source.etag, '"v1"');
    const blob = first.text.blobKey;
    const ingest = getIngestService();
    const later = Date.parse(first.checkedAt) + (DEFAULT_REFRESH_TTL_SECONDS + 1) * 1000;

    // Not due yet: nothing happens.
    const projectNow = await getProjectRepository().get(project.id);
    assert.equal(await ingest.refreshExpired([projectNow], { now: Date.now() }), 0);

    seen.length = 0;
    assert.equal(await ingest.refreshExpired([projectNow], { now: later }), 1);
    const unchanged = await waitFor(async () => {
      const current = await itemOf(project.id, item.id);
      return current && !current.refreshingAt && current.checkedAt !== first.checkedAt
        ? current
        : null;
    });
    assert.equal(unchanged.text.blobKey, blob, 'the text is kept');
    assert.equal(
      (await getProjectRepository().get(project.id)).lastActivityAt,
      projectNow.lastActivityAt,
      'a scheduled refresh is not activity: retention still sees the project as it was'
    );
    assert.equal(
      (await getProjectRepository().get(project.id)).updatedAt,
      projectNow.updatedAt,
      'nor an edit of the project'
    );
    assert.equal(seen.at(-1).headers['if-none-match'], '"v1"', 'asked conditionally');

    serve('/policy.txt', 'Policy version two.', { 'content-type': 'text/plain' }, { etag: '"v2"' });
    const again = Date.parse(unchanged.checkedAt) + (DEFAULT_REFRESH_TTL_SECONDS + 1) * 1000;
    assert.equal(
      await ingest.refreshExpired([await getProjectRepository().get(project.id)], { now: again }),
      1
    );
    const changed = await waitFor(async () => {
      const current = await itemOf(project.id, item.id);
      return current && current.text.blobKey !== blob && !current.refreshingAt ? current : null;
    });
    assert.equal(changed.provenance.source.etag, '"v2"');
    assert.match(
      (await getItemText({ id: project.id }, changed, { user: ADA })).text,
      /version two/
    );
  });

  it('never refreshes a file set to `never`, and follows the project and item TTL', async () => {
    serve('/static.txt', 'Static.', { 'content-type': 'text/plain' });
    const project = await newProject('Never');
    const { item } = await addUrl(project, `${base}/static.txt`);
    const ready = await settled(project.id, item.id);
    const ingest = getIngestService();
    const far = Date.parse(ready.checkedAt) + 10 * 365 * 24 * 3600 * 1000;

    await service.updateProject(project.id, { refreshTtl: 'never' }, { actor: ADA });
    assert.equal(
      await ingest.refreshExpired([await getProjectRepository().get(project.id)], { now: far }),
      0
    );

    // An item of its own overrides the project; null goes back to it.
    const { item: own } = await service.updateItem(
      project.id,
      item.id,
      { refreshTtl: 3600 },
      { user: ADA }
    );
    assert.equal(own.refreshTtl, 3600);
    assert.equal(
      serializeItem(own, await getProjectRepository().get(project.id)).refresh.from,
      'item'
    );
    const { item: back } = await service.updateItem(
      project.id,
      item.id,
      { refreshTtl: null },
      { user: ADA }
    );
    assert.equal(back.refreshTtl, undefined);
    assert.equal(
      await ingest.refreshExpired([await getProjectRepository().get(project.id)], { now: far }),
      0
    );

    // An upload has no schedule to set.
    const { item: upload } = await service.addItem(
      project.id,
      { kind: 'upload', ref: {}, name: 'n.md', text: 'Notes' },
      { user: ADA }
    );
    await assert.rejects(
      service.updateItem(project.id, upload.id, { refreshTtl: 3600 }, { user: ADA }),
      error => error.code === 'INVALID_REF'
    );
  });
});

describe('ingest queue', () => {
  it('starts a job someone waits for before scheduled refreshes, and keeps a slot for it', async () => {
    const ingest = new ProjectIngestService({
      service: {},
      platform: () => ({ projects: { ingest: { concurrency: 2 } } })
    });
    const started = [];
    const gates = new Map();
    ingest._run = job =>
      new Promise(resolve => {
        started.push(job.itemId);
        gates.set(job.itemId, resolve);
      });
    const enqueue = (itemId, scheduled) =>
      ingest.start({ id: 'p' }, { id: itemId }, { scheduled, fetch: () => null }, { wait: false });
    await enqueue('bg1', true);
    await enqueue('bg2', true);
    await enqueue('bg3', true);
    // Two slots: one background job runs, the last slot stays free.
    assert.deepEqual(started, ['bg1']);
    await enqueue('upload', false);
    assert.deepEqual(started, ['bg1', 'upload'], 'the upload starts at once');
    gates.get('upload')();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['bg1', 'upload'], 'still one background job at a time');
    gates.get('bg1')();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['bg1', 'upload', 'bg2']);
    // A waiting user job jumps every queued background job.
    await enqueue('pick', false);
    gates.get('bg2')();
    await new Promise(resolve => setImmediate(resolve));
    // Both slots are free: the pick first, then the last background job.
    assert.deepEqual(started.slice(3), ['pick', 'bg3']);
  });
});

describe('site crawler documents', () => {
  it('lists Office and OpenDocument links like PDFs, legacy Office not at all', () => {
    for (const ext of ['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp']) {
      assert.equal(linkTypeOf(`https://example.com/a.${ext}`), 'document', ext);
    }
    assert.equal(linkTypeOf('https://example.com/a.doc'), null);
    assert.equal(linkTypeOf('https://example.com/a'), 'page');
  });

  it('tells a document response without an extension by its content type', () => {
    assert.equal(isDocumentResponse(PPTX, 'https://example.com/download?id=7'), true);
    assert.equal(isDocumentResponse('application/pdf', 'https://example.com/get'), true);
    assert.equal(isDocumentResponse('text/html', 'https://example.com/get'), false);
    assert.equal(isDocumentResponse('application/json', 'https://example.com/api'), false);
    assert.equal(isDocumentResponse('image/png', 'https://example.com/p'), false);
  });
});

describe('crawler: documents on other hosts', () => {
  const html = links =>
    `<html><head><title>Start</title></head><body>${links
      .map(href => `<a href="${href}">x</a>`)
      .join('')}</body></html>`;
  const site = {
    'https://www.example.com/docs/': html([
      'guide',
      'https://cdn.example.net/files/handbook.pdf',
      'https://cdn.example.net/files/deck.pptx',
      'https://cdn.example.net/files/page',
      'https://other.example.org/blog/'
    ]),
    'https://www.example.com/docs/guide': html([])
  };
  const fetched = [];
  const deps = {
    fetchPage: async url => {
      fetched.push(url);
      if (!site[url]) throw new Error('HTTP 404');
      return { finalUrl: url, contentType: 'text/html', html: site[url] };
    },
    fetchRobots: async () => 'User-agent: *\nDisallow: /files/'
  };

  it("lists them only when asked, never crawls them, and never lists other hosts' pages", async () => {
    const hostOf = url => new URL(url).hostname;
    const plain = await crawlSite({ url: 'https://www.example.com/docs/', maxDepth: 1 }, deps);
    assert.ok(!plain.pages.some(entry => hostOf(entry.url) === 'cdn.example.net'));
    fetched.length = 0;
    const wide = await crawlSite(
      { url: 'https://www.example.com/docs/', maxDepth: 1, otherHostDocuments: true },
      deps
    );
    const listed = wide.pages.map(entry => [entry.url, entry.type]);
    assert.deepEqual(
      listed.filter(([url]) => hostOf(url) === 'cdn.example.net'),
      [
        ['https://cdn.example.net/files/handbook.pdf', 'document'],
        ['https://cdn.example.net/files/deck.pptx', 'document']
      ],
      "documents only, and the start site's robots.txt is not applied to another host"
    );
    assert.ok(!listed.some(([url]) => hostOf(url) === 'other.example.org'));
    assert.ok(
      !fetched.some(url => !url.startsWith('https://www.example.com/')),
      'nothing else is fetched'
    );
  });
});

describe('migration V237', () => {
  function context(initial) {
    let stored = initial;
    return {
      fileExists: async () => stored !== undefined,
      readJson: async () => structuredClone(stored),
      writeJson: async (_file, value) => {
        stored = value;
      },
      log: () => {},
      get stored() {
        return stored;
      }
    };
  }

  it('adds the default refresh TTL and keeps one an admin set', async () => {
    const fresh = context({ projects: { limits: {} } });
    await migration.up(fresh);
    assert.equal(fresh.stored.projects.refreshTtl, 86400);
    const chosen = context({ projects: { refreshTtl: 'never' } });
    await migration.up(chosen);
    assert.equal(chosen.stored.projects.refreshTtl, 'never');
    const none = context({ ssl: {} });
    await migration.up(none);
    assert.equal(none.stored.projects, undefined);
  });
});
