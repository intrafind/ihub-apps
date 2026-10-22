// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The upload and extraction pipeline of projects (#1036, spec 3): the
 * streaming AEAD format and its fixtures, the key provider, the encrypted
 * text store, extraction per type, the ingest service over a filesystem
 * storage provider (upload, text, pick, refresh, quotas, scan, reconciler)
 * and the multipart route.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import {
  DEFAULT_SEGMENT_BYTES,
  FORMAT_ID,
  StreamingAeadError,
  associatedDataOf,
  decrypt,
  encrypt,
  newDataKey
} from '../services/projects/crypto/streamingAead.js';
import {
  KeyAccessDenied,
  LocalFileKeyProvider,
  _resetKeyProvider,
  getKeyProvider,
  registerKeyProvider
} from '../services/projects/crypto/KeyProvider.js';
import { evictItemKeys, readText, storeText } from '../services/projects/ItemTextStore.js';
import {
  ACCEPTED_TYPES,
  ExtractionError,
  acceptedTypeOf,
  extractText,
  sniffBytes
} from '../services/projects/extractText.js';
import {
  CommandScanner,
  NoneScanner,
  scannerFor,
  splitCommand
} from '../services/projects/scan/MalwareScanner.js';
import { INTERRUPTED, ProjectIngestService } from '../services/projects/ProjectIngestService.js';
import { ProjectError, getProjectService } from '../services/projects/ProjectService.js';
import {
  PROJECT_FILES_NAMESPACE,
  getProjectRepository
} from '../services/projects/ProjectRepository.js';
import { registerItemKind } from '../services/projects/kinds/registry.js';
import {
  bootstrapProjects,
  getIngestService,
  shutdownProjects
} from '../services/projects/bootstrap.js';
import { evictItemText, getItemText } from '../services/knowledge/ItemTextService.js';
import registerProjectRoutes from '../routes/projectRoutes.js';
import { countBodyBytes } from '../sources/SourceManager.js';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const MASTER = crypto.createHash('sha256').update('test-master').digest('hex');
const PREVIOUS = crypto.createHash('sha256').update('previous-master').digest('hex');

const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };

let scratch;
let platform;

function setPlatform(overrides = {}) {
  platform = {
    defaultLanguage: 'en',
    anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
    ...platform,
    ...overrides
  };
  configCache.setCacheEntry('config/platform.json', platform);
}

function setLimits(limits) {
  setPlatform({
    projects: {
      ...(platform?.projects || {}),
      limits: {
        maxFiles: 25,
        maxFileBytes: 20 * 1024 * 1024,
        maxProjectBytes: 200 * 1024 * 1024,
        maxProjectsPerUser: 0,
        ...limits
      }
    }
  });
}

function captureRoutes(register) {
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {}
  });
  return routes;
}

function handlersFor(routes, method, suffix) {
  const route = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

function makeResponse() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.end = () => res;
  res.send = value => {
    res.body = value;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  res.getHeader = name => res.headers[String(name).toLowerCase()];
  return res;
}

async function drive(handlers, { params = {}, query = {}, body = {}, user, req: given } = {}) {
  const req =
    given ||
    Object.assign(new PassThrough(), {
      params,
      query,
      body,
      headers: {},
      ip: '127.0.0.1',
      method: 'GET',
      url: '/'
    });
  req.params = req.params || params;
  req.query = req.query || query;
  req.user = user ? { ...user, groups: [...(user.groups || [])] } : undefined;
  req.is = type =>
    /^multipart\/form-data/i.test(String(req.headers['content-type'] || '')) &&
    type === 'multipart/form-data';
  const res = makeResponse();
  let responded = false;
  for (const method of ['json', 'send', 'end']) {
    const original = res[method];
    res[method] = value => {
      responded = true;
      return original(value);
    };
  }
  for (const handler of handlers) {
    let advanced = false;
    let failure = null;
    await handler(req, res, error => {
      if (error) failure = error;
      advanced = true;
    });
    // A middleware that hands the request to a stream (multer) calls `next`
    // or answers later than its own return.
    if (!advanced && !responded) {
      await waitFor(() => advanced || responded, { timeoutMs: 3000, stepMs: 5 }).catch(() => {});
    }
    if (failure) throw failure;
    if (!advanced) break;
  }
  return res;
}

function multipartRequest({ name, contentType, bytes, fields = {} }) {
  const boundary = `----ihub${crypto.randomBytes(6).toString('hex')}`;
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  const body = Buffer.concat(parts);
  const req = new PassThrough();
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length)
  };
  req.params = {};
  req.query = {};
  req.body = {};
  req.ip = '127.0.0.1';
  req.method = 'POST';
  req.url = '/';
  req.end(body);
  return req;
}

async function waitFor(check, { timeoutMs = 10000, stepMs = 25 } = {}) {
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

async function settled(projectId, itemId) {
  return waitFor(async () => {
    const item = await itemOf(projectId, itemId);
    return item && item.status !== 'pending' && item.status !== 'extracting' ? item : null;
  });
}

async function makePdf(pages, { blank = false } = {}) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([400, 300]);
    if (!blank) {
      page.drawText(`Page ${index + 1} of the lease agreement says the rent is due monthly.`, {
        x: 20,
        y: 250,
        size: 10,
        font
      });
    }
  }
  return Buffer.from(await doc.save());
}

async function makeDocx(paragraphs) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  const body = paragraphs
    .map(
      ({ text, heading }) =>
        `<w:p>${heading ? `<w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`
    )
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeXlsx() {
  const XLSX = (await import('xlsx')).default || (await import('xlsx'));
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Item', 'Amount'],
    ['Rent', 1200],
    ['Deposit', 2400]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Budget');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-ingest-'));
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
  platform = { localAuth: { usersFile }, chats: { enabled: true } };
  setLimits({});
  configCache.setCacheEntry('config/features.json', {
    projects: true,
    userProjects: true,
    chatPersistence: true
  });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          permissions: { apps: ['*'], projects: true, projectSharing: true }
        },
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: [] } }
      }
    })
  );
  configCache.setCacheEntry('config/apps.json', []);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/projects.json', []);
  registerKeyProvider(
    'local-file',
    () => new LocalFileKeyProvider({ readMasterKey: () => MASTER, readPreviousKey: () => null })
  );
  _resetKeyProvider();
  await bootstrapProjects({ reconcile: false });
  // Uploads wait under `contents/` by default; keep the test's in the scratch directory.
  getIngestService().tempDir = path.join(scratch, 'uploads');
});

after(async () => {
  shutdownProjects();
  evictItemText();
  evictItemKeys();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('streaming AEAD (tink-aes-gcm-hkdf-v1)', () => {
  it('round-trips every size around the segment boundaries', () => {
    const key = newDataKey();
    const aad = associatedDataOf({ projectId: 'prj_a', itemId: 'itm_b', versionId: 'v' });
    for (const size of [0, 1, 71, 72, 73, 112, 113, 300, 5000]) {
      const plain = crypto.randomBytes(size);
      const cipher = encrypt(plain, key, aad, { segmentBytes: 128 });
      assert.deepEqual(decrypt(cipher, key, aad, { segmentBytes: 128 }), plain, `size ${size}`);
    }
    const big = crypto.randomBytes(3 * DEFAULT_SEGMENT_BYTES + 7);
    assert.deepEqual(decrypt(encrypt(big, key, aad), key, aad), big);
  });

  it('rejects a wrong key, a wrong associated data, a flipped byte and a truncation', () => {
    const key = newDataKey();
    const aad = 'ihub/project-files/default/prj_a/itm_b/v';
    const plain = Buffer.from('x'.repeat(500));
    const cipher = encrypt(plain, key, aad, { segmentBytes: 128 });
    assert.throws(
      () => decrypt(cipher, newDataKey(), aad, { segmentBytes: 128 }),
      StreamingAeadError
    );
    assert.throws(() => decrypt(cipher, key, `${aad}2`, { segmentBytes: 128 }), StreamingAeadError);
    const flipped = Buffer.from(cipher);
    flipped[200] ^= 0x01;
    assert.throws(() => decrypt(flipped, key, aad, { segmentBytes: 128 }), StreamingAeadError);
    assert.throws(
      () => decrypt(cipher.subarray(0, cipher.length - 128), key, aad, { segmentBytes: 128 }),
      StreamingAeadError
    );
    assert.throws(
      () =>
        decrypt(Buffer.concat([cipher, cipher.subarray(40, 168)]), key, aad, { segmentBytes: 128 }),
      StreamingAeadError
    );
  });

  it('opens the recorded vectors', async () => {
    const file = path.join(here, 'fixtures', 'streaming-aead', 'vectors.json');
    const { format, vectors } = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(format, FORMAT_ID);
    assert.ok(vectors.length >= 5);
    for (const vector of vectors) {
      const plain = decrypt(
        Buffer.from(vector.ciphertextBase64, 'base64'),
        Buffer.from(vector.dataKeyHex, 'hex'),
        vector.associatedData,
        { segmentBytes: vector.segmentBytes }
      );
      assert.equal(plain.toString('utf8'), vector.plaintextUtf8, vector.name);
      const header = Buffer.from(vector.ciphertextBase64, 'base64');
      assert.equal(header[0], 40, 'header length byte');
    }
  });
});

describe('LocalFileKeyProvider', () => {
  it('wraps and unwraps bound to the associated data, and knows the previous key', async () => {
    const current = new LocalFileKeyProvider({
      readMasterKey: () => MASTER,
      readPreviousKey: () => null
    });
    const dataKey = newDataKey();
    const { keyId, wrapped } = await current.wrap(dataKey, 'aad-1');
    assert.equal(keyId.length, 8);
    assert.equal(wrapped.length, 1 + 12 + 16 + 32);
    assert.deepEqual(await current.unwrap(wrapped, keyId, 'aad-1'), dataKey);
    await assert.rejects(current.unwrap(wrapped, keyId, 'aad-2'), KeyAccessDenied);
    await assert.rejects(current.unwrap(wrapped, 'deadbeef', 'aad-1'), KeyAccessDenied);

    const rotated = new LocalFileKeyProvider({
      readMasterKey: () => PREVIOUS,
      readPreviousKey: () => MASTER
    });
    assert.deepEqual(await rotated.unwrap(wrapped, keyId, 'aad-1'), dataKey);
    assert.notEqual(await rotated.currentKeyId(), keyId);

    const empty = new LocalFileKeyProvider({
      readMasterKey: () => null,
      readPreviousKey: () => null
    });
    await assert.rejects(empty.wrap(dataKey, 'x'), KeyAccessDenied);
  });

  it('falls back to local-file for an unknown provider id', () => {
    _resetKeyProvider();
    assert.equal(getKeyProvider('vault-transit').id, 'local-file');
  });
});

describe('ItemTextStore', () => {
  it('stores an encrypted blob and reads it back, detecting tampering', async () => {
    const repository = getProjectRepository();
    const projectId = 'prj_store';
    const itemId = 'itm_store';
    const text = 'Die Miete ist monatlich fällig. '.repeat(50);
    const block = await storeText({
      projectId,
      itemId,
      text,
      original: { contentType: 'text/plain', bytes: 1600 },
      platform,
      repository
    });
    assert.equal(block.format, FORMAT_ID);
    assert.ok(block.blobKey.startsWith(`${projectId}__${itemId}__`));
    assert.equal(block.chars, text.length);
    assert.equal(block.key.provider, 'local-file');
    assert.equal(block.tenant, 'default');
    assert.equal(block.original.bytes, 1600);
    const blob = await repository.blobs.get(PROJECT_FILES_NAMESPACE, block.blobKey);
    assert.ok(blob.data.length > text.length);
    assert.ok(!blob.data.includes(Buffer.from('Miete')), 'the blob is ciphertext');

    const project = { id: projectId };
    const item = { id: itemId, text: block };
    assert.equal(await readText(project, item, { platform, repository }), text);
    evictItemKeys(block.blobKey);
    assert.equal(await readText(project, item, { platform, repository }), text);

    await assert.rejects(
      readText(
        project,
        { id: itemId, text: { ...block, sha256: '0'.repeat(64) } },
        { platform, repository }
      ),
      error => error.code === 'TEXT_UNAVAILABLE'
    );
    await assert.rejects(
      readText({ id: 'prj_other' }, { id: itemId, text: block }, { platform, repository }),
      error => error.code === 'KEY_ACCESS_DENIED' || error.code === 'TEXT_UNAVAILABLE'
    );
    await repository.blobs.delete(PROJECT_FILES_NAMESPACE, block.blobKey);
    evictItemKeys(block.blobKey);
    await assert.rejects(
      readText(project, item, { platform, repository }),
      error => error.code === 'TEXT_UNAVAILABLE'
    );
  });
});

describe('extractText', () => {
  it('decides the type from the declared type and the name', () => {
    assert.equal(acceptedTypeOf({ name: 'notes.md' }), 'text/markdown');
    assert.equal(
      acceptedTypeOf({ name: 'report.docx', contentType: 'application/octet-stream' }).endsWith(
        'wordprocessingml.document'
      ),
      true
    );
    assert.equal(acceptedTypeOf({ name: 'photo.png', contentType: 'image/png' }), null);
    assert.equal(acceptedTypeOf({ name: 'archive.zip', contentType: 'application/zip' }), null);
    assert.equal(
      acceptedTypeOf({ name: 'data', contentType: 'application/json' }),
      'application/json'
    );
    assert.equal(acceptedTypeOf({ name: 'x.exe' }), null);
    assert.ok(ACCEPTED_TYPES.extensions.includes('.pdf'));
    assert.equal(sniffBytes(Buffer.from('%PDF-1.7')), 'pdf');
    assert.equal(sniffBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'refused');
  });

  it('reads text, markdown, html, e-mail and refuses binary or non-UTF-8 input', async () => {
    const md = await extractText({
      bytes: Buffer.from('﻿# Title\r\n\r\nBody\u0000 text'),
      name: 'a.md'
    });
    assert.equal(md.text, '# Title\n\nBody text');
    assert.equal(md.contentType, 'text/markdown');
    const html = await extractText({
      bytes: Buffer.from(
        '<html><head><style>x{}</style><script>bad()</script></head><body><h1>Lease</h1><p>Rent is due.</p></body></html>'
      ),
      contentType: 'text/html'
    });
    assert.match(html.text, /# Lease/);
    assert.match(html.text, /Rent is due\./);
    assert.doesNotMatch(html.text, /bad\(\)/);
    const eml = await extractText({
      bytes: Buffer.from(
        'From: ada@example.com\r\nTo: grace@example.com\r\nSubject: =?UTF-8?B?TWlldGU=?= due\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nThe rent is f=C3=A4llig.\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>The rent is <b>due</b>.</p>\r\n--b1--\r\n'
      ),
      name: 'mail.eml'
    });
    assert.match(eml.text, /^Subject: Miete due/m);
    assert.match(eml.text, /The rent is fällig\./);
    assert.doesNotMatch(eml.text, /<b>/);
    await assert.rejects(
      extractText({
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        name: 'x.png'
      }),
      error => error instanceof ExtractionError && error.code === 'UNSUPPORTED_TYPE'
    );
    await assert.rejects(
      extractText({
        bytes: Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0x41, 0x42, 0x43, 0x44]),
        name: 'x.txt'
      }),
      error => error.code === 'UNSUPPORTED_TYPE'
    );
    await assert.rejects(
      extractText({ bytes: Buffer.from('   \n  '), name: 'empty.txt' }),
      error => error.code === 'NO_TEXT'
    );
    const capped = await extractText(
      { bytes: Buffer.from('a'.repeat(100)), name: 'long.txt' },
      { maxChars: 40 }
    );
    assert.equal(capped.text.length, 40);
    assert.equal(capped.truncated, true);
  });

  it('reads PDF pages and refuses a scan without a text layer', async () => {
    const pdf = await extractText({
      bytes: await makePdf(2),
      name: 'lease.pdf',
      contentType: 'application/octet-stream'
    });
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(pdf.pages, 2);
    assert.match(pdf.text, /rent is due monthly/);
    await assert.rejects(
      extractText({ bytes: await makePdf(3, { blank: true }), name: 'scan.pdf' }),
      error => error.code === 'NO_TEXT' && /OCR/.test(error.message)
    );
  });

  it('reads Word and Excel packages, deciding the package from its entries', async () => {
    const docx = await makeDocx([
      { text: 'Lease agreement', heading: 1 },
      { text: 'The tenant pays the rent monthly.' }
    ]);
    const word = await extractText({ bytes: docx, name: 'blob', contentType: 'application/zip' });
    assert.ok(word.contentType.endsWith('wordprocessingml.document'));
    assert.match(word.text, /# Lease agreement/);
    assert.match(word.text, /pays the rent monthly/);
    const xlsx = await extractText({ bytes: await makeXlsx(), name: 'budget.xlsx' });
    assert.ok(xlsx.contentType.endsWith('spreadsheetml.sheet'));
    assert.match(xlsx.text, /Budget/);
    assert.match(xlsx.text, /Deposit/);
    assert.match(xlsx.text, /2400/);
    await assert.rejects(
      extractText({ bytes: Buffer.from('PK\x03\x04garbage-not-a-zip'), name: 'x.docx' }),
      error => error.code === 'UNSUPPORTED_TYPE'
    );
  });
});

describe('MalwareScanner', () => {
  it('splits a command line and maps exit codes to verdicts', async () => {
    assert.deepEqual(splitCommand('clamdscan --no-summary "--fdpass" {path}'), [
      'clamdscan',
      '--no-summary',
      '--fdpass',
      '{path}'
    ]);
    assert.equal(scannerFor({ provider: 'none' }).id, 'none');
    assert.equal(scannerFor({}).id, 'none');
    // A scanner that is configured but cannot be set up answers `error`,
    // so `onError: reject` keeps uploads out rather than letting them pass.
    const unconfigured = scannerFor({ provider: 'command', command: '' });
    assert.equal(unconfigured.id, 'misconfigured');
    assert.equal((await unconfigured.scan({ path: '/x' })).verdict, 'error');
    const calls = [];
    const exec =
      (code, stdout = '') =>
      (binary, args, _options, cb) => {
        calls.push({ binary, args });
        if (code === 0) return cb(null, stdout, '');
        const error = new Error('exit');
        error.code = code;
        cb(error, stdout, '');
      };
    const clean = new CommandScanner({ command: 'scan --fdpass {path}', exec: exec(0, 'OK') });
    assert.equal((await clean.scan({ path: '/tmp/f' })).verdict, 'clean');
    assert.deepEqual(calls[0], { binary: 'scan', args: ['--fdpass', '/tmp/f'] });
    const infected = new CommandScanner({
      command: 'scan',
      exec: exec(1, 'Eicar-Test-Signature FOUND')
    });
    const verdict = await infected.scan({ path: '/tmp/f' });
    assert.equal(verdict.verdict, 'infected');
    assert.match(verdict.detail, /Eicar/);
    assert.deepEqual(calls[1].args, ['/tmp/f']);
    const broken = new CommandScanner({ command: 'scan', exec: exec(2) });
    assert.equal((await broken.scan({ path: '/tmp/f' })).verdict, 'error');
    assert.equal((await new NoneScanner().scan({})).verdict, 'clean');
  });
});

describe('ingest pipeline', () => {
  let service;
  let fakeFetch;

  before(() => {
    service = getProjectService();
    assert.ok(service.ingest, 'bootstrap wired the ingest service');
    fakeFetch = {
      bytes: Buffer.from('# Cloud doc\n\nPicked from the cloud.'),
      lastModified: '2026-10-01T00:00:00.000Z',
      fail: null
    };
    registerItemKind({
      id: 'fake-cloud',
      name: { en: 'Fake cloud' },
      storage: { ihub: 'text' },
      credentials: 'picking-user',
      picker: { type: 'cloud', provider: 'fake' },
      refSchema: z.object({ fileId: z.string(), size: z.number().optional() }).strict(),
      describe: ref => ({
        name: `cloud-${ref.fileId}`,
        site: 'Fake cloud',
        url: `https://cloud.example/${ref.fileId}`
      }),
      async fetch() {
        if (fakeFetch.fail) throw fakeFetch.fail;
        return {
          bytes: fakeFetch.bytes,
          contentType: 'text/markdown',
          name: 'cloud.md',
          lastModified: fakeFetch.lastModified,
          source: { site: 'Fake cloud', lastModified: fakeFetch.lastModified }
        };
      }
    });
  });

  async function newProject(name = 'Case') {
    return service.createUserProject({ owner: ADA, content: { name } });
  }

  it('stores handed-in text inline and makes it readable', async () => {
    const project = await newProject();
    const { item } = await service.addItem(
      project.id,
      {
        kind: 'upload',
        ref: { contentType: 'text/markdown' },
        name: 'Notes.md',
        text: '# Notes\n\nThe rent is due monthly.'
      },
      { user: ADA, origin: 'written' }
    );
    assert.equal(item.status, 'ready');
    assert.equal(item.provenance.origin, 'written');
    assert.equal(item.text.format, FORMAT_ID);
    assert.equal(item.text.original.contentType, 'text/markdown');
    assert.ok(item.text.tokens > 0);
    const stored = await getProjectRepository().get(project.id);
    assert.equal(stored.usage.bytes, Buffer.byteLength('# Notes\n\nThe rent is due monthly.'));
    const { text } = await getItemText(stored, item, { user: ADA });
    assert.equal(text, '# Notes\n\nThe rent is due monthly.');
    await service.removeItem(project.id, item.id, { user: ADA });
    const blobs = await getProjectRepository().blobs.list(PROJECT_FILES_NAMESPACE, {
      prefix: `${project.id}__`
    });
    assert.equal(blobs.items.length, 0, 'the blob went with the item');
  });

  it('extracts an uploaded file on the queue and removes the temp directory', async () => {
    const project = await newProject();
    const dir = await service.ingest.newTempDir();
    const file = path.join(dir, 'upload');
    await fs.writeFile(file, await makePdf(2));
    const { item } = await service.addItem(
      project.id,
      {
        kind: 'upload',
        ref: {},
        name: 'lease.pdf',
        file: {
          path: file,
          contentType: 'application/pdf',
          name: 'lease.pdf',
          bytes: 1000,
          cleanupDir: dir
        }
      },
      { user: ADA }
    );
    assert.equal(item.status, 'pending');
    assert.equal(item.provenance.origin, 'uploaded');
    const ready = await settled(project.id, item.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(ready.text.original.pages, 2);
    assert.equal(ready.text.original.contentType, 'application/pdf');
    assert.equal(ready.ref.contentType, 'application/pdf');
    await assert.rejects(fs.stat(dir), 'the upload directory is gone');
    const { text } = await getItemText({ id: project.id }, ready, { user: ADA });
    assert.match(text, /rent is due monthly/);
  });

  it('fails an unsupported or unreadable upload with the code the UI shows', async () => {
    const project = await newProject();
    const dir = await service.ingest.newTempDir();
    const file = path.join(dir, 'upload');
    await fs.writeFile(
      file,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    );
    const { item } = await service.addItem(
      project.id,
      {
        kind: 'upload',
        ref: {},
        file: { path: file, contentType: 'text/plain', name: 'x.txt', bytes: 11, cleanupDir: dir }
      },
      { user: ADA }
    );
    const failed = await settled(project.id, item.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'UNSUPPORTED_TYPE');
    assert.equal(failed.text, undefined);
    await assert.rejects(fs.stat(dir));
    await assert.rejects(
      service.addItem(project.id, { kind: 'upload', ref: {}, name: 'nothing' }, { user: ADA }),
      error => error instanceof ProjectError && error.code === 'INVALID_REF'
    );
  });

  it('enforces the quotas before and after receive', async () => {
    setLimits({ maxFileBytes: 100, maxProjectBytes: 150, maxFiles: 3 });
    try {
      const project = await newProject();
      await assert.rejects(
        service.addItem(
          project.id,
          { kind: 'upload', ref: {}, text: 'x'.repeat(101) },
          { user: ADA }
        ),
        error => error.code === 'QUOTA_FILE_BYTES'
      );
      await service.addItem(
        project.id,
        { kind: 'upload', ref: {}, name: 'a', text: 'a'.repeat(90) },
        { user: ADA }
      );
      await assert.rejects(
        service.addItem(
          project.id,
          { kind: 'upload', ref: {}, name: 'b', text: 'b'.repeat(90) },
          { user: ADA }
        ),
        error => error.code === 'QUOTA_PROJECT_BYTES'
      );
      // A picked document whose size the picker did not know is checked after the fetch.
      fakeFetch.bytes = Buffer.from('c'.repeat(90));
      const { item } = await service.addItem(
        project.id,
        { kind: 'fake-cloud', ref: { fileId: 'big' } },
        { user: ADA }
      );
      const failed = await settled(project.id, item.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'QUOTA_PROJECT_BYTES');
      await service.removeItem(project.id, item.id, { user: ADA });
      // Two fetched documents that each fit the free room alone are judged
      // under the project's lock when installed: only one of them lands.
      await service.removeItem(
        project.id,
        (await getProjectRepository().get(project.id)).items[0].id,
        { user: ADA }
      );
      fakeFetch.bytes = Buffer.from('d'.repeat(90));
      const [one, two] = await Promise.all(
        ['race-1', 'race-2'].map(fileId =>
          service.addItem(project.id, { kind: 'fake-cloud', ref: { fileId } }, { user: ADA })
        )
      );
      const outcomes = await Promise.all([
        settled(project.id, one.item.id),
        settled(project.id, two.item.id)
      ]);
      assert.deepEqual(outcomes.map(entry => entry.status).sort(), ['failed', 'ready']);
      assert.equal(
        outcomes.find(entry => entry.status === 'failed').error.code,
        'QUOTA_PROJECT_BYTES'
      );
      assert.ok((await getProjectRepository().get(project.id)).usage.bytes <= 150);
      for (const entry of outcomes) await service.removeItem(project.id, entry.id, { user: ADA });
      await service.addItem(
        project.id,
        { kind: 'upload', ref: {}, name: 'a', text: 'a'.repeat(90) },
        { user: ADA }
      );
      await service.addItem(
        project.id,
        { kind: 'url', ref: { url: 'https://example.com/a' } },
        { user: ADA }
      );
      await service.addItem(
        project.id,
        { kind: 'url', ref: { url: 'https://example.com/b' } },
        { user: ADA }
      );
      await assert.rejects(
        service.addItem(
          project.id,
          { kind: 'url', ref: { url: 'https://example.com/c' } },
          { user: ADA }
        ),
        error => error.code === 'QUOTA_FILES'
      );
    } finally {
      setLimits({});
      fakeFetch.bytes = Buffer.from('# Cloud doc\n\nPicked from the cloud.');
    }
  });

  it('picks a cloud document, refreshes it, keeps the old text on a failed refresh', async () => {
    const project = await newProject();
    const { item } = await service.addItem(
      project.id,
      { kind: 'fake-cloud', ref: { fileId: 'f1' } },
      { user: ADA }
    );
    assert.equal(item.provenance.origin, 'picked');
    assert.equal(item.name, 'cloud-f1');
    const picked = await settled(project.id, item.id);
    assert.equal(picked.status, 'ready', JSON.stringify(picked.error));
    assert.equal(picked.snapshotAt, picked.text.extractedAt);
    assert.equal(picked.provenance.source.lastModified, '2026-10-01T00:00:00.000Z');
    const firstBlob = picked.text.blobKey;

    // Unchanged at the source: a no-op.
    const unchanged = await service.refreshItem(project.id, item.id, { user: ADA, wait: true });
    assert.equal(unchanged.item.status, 'ready');
    assert.equal(unchanged.item.text.blobKey, firstBlob);

    // Changed at the source after the last fetch but before extraction
    // finished: compared with the fetched version, not with `snapshotAt`.
    fakeFetch.bytes = Buffer.from('# Cloud doc v2\n\nChanged in the cloud.');
    fakeFetch.lastModified = '2026-10-05T00:00:00.000Z';
    assert.ok(Date.parse(fakeFetch.lastModified) < Date.parse(picked.snapshotAt));
    const refreshed = await service.refreshItem(project.id, item.id, { user: ADA, wait: true });
    assert.equal(refreshed.item.status, 'ready');
    assert.equal(refreshed.item.refreshingAt, undefined);
    assert.equal(refreshed.item.provenance.source.lastModified, fakeFetch.lastModified);
    assert.notEqual(refreshed.item.text.blobKey, firstBlob);
    const repository = getProjectRepository();
    assert.equal(await repository.blobs.get(PROJECT_FILES_NAMESPACE, firstBlob), null);
    const { text } = await getItemText({ id: project.id }, refreshed.item, { user: ADA });
    assert.match(text, /Changed in the cloud/);

    // Gone at the source: stale, text still readable.
    fakeFetch.fail = new Error('Request failed: 404 Not Found');
    await assert.rejects(
      service.refreshItem(project.id, item.id, { user: ADA, wait: true }),
      error => error.code === 'SOURCE_GONE'
    );
    const stale = await itemOf(project.id, item.id);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.refreshingAt, undefined);
    assert.equal(stale.error.code, 'SOURCE_GONE');
    assert.equal(stale.text.blobKey, refreshed.item.text.blobKey);
    assert.match(
      (await getItemText({ id: project.id }, stale, { user: ADA })).text,
      /Changed in the cloud/
    );
    fakeFetch.fail = null;
    fakeFetch.lastModified = '2026-10-01T00:00:00.000Z';
    fakeFetch.bytes = Buffer.from('# Cloud doc\n\nPicked from the cloud.');

    await assert.rejects(
      service.refreshItem(project.id, 'itm_missing', { user: ADA }),
      error => error.code === 'ITEM_NOT_FOUND'
    );
  });

  it('rejects what the scanner flags and honours onError', async () => {
    const ingest = service.ingest;
    const exec = code => (_binary, _args, _options, cb) => {
      if (code === 0) return cb(null, '', '');
      const error = new Error('exit');
      error.code = code;
      cb(error, 'Eicar FOUND', '');
    };
    ingest._scanner = new CommandScanner({ command: 'fake {path}', exec: exec(1) });
    setPlatform({
      projects: {
        ...platform.projects,
        scan: { provider: 'command', command: 'fake {path}', onError: 'reject' }
      }
    });
    try {
      const project = await newProject();
      const { item } = await service.addItem(
        project.id,
        { kind: 'fake-cloud', ref: { fileId: 'virus' } },
        { user: ADA }
      );
      const rejected = await settled(project.id, item.id);
      assert.equal(rejected.status, 'failed');
      assert.equal(rejected.error.code, 'SCAN_REJECTED');
      assert.match(rejected.error.message, /Eicar/);

      ingest._scanner = new CommandScanner({ command: 'fake {path}', exec: exec(3) });
      const { item: errored } = await service.addItem(
        project.id,
        { kind: 'fake-cloud', ref: { fileId: 'err' } },
        { user: ADA }
      );
      assert.equal((await settled(project.id, errored.id)).error.code, 'SCAN_REJECTED');

      setPlatform({
        projects: {
          ...platform.projects,
          scan: { provider: 'command', command: 'fake {path}', onError: 'allow' }
        }
      });
      const { item: allowed } = await service.addItem(
        project.id,
        { kind: 'fake-cloud', ref: { fileId: 'ok' } },
        { user: ADA }
      );
      assert.equal((await settled(project.id, allowed.id)).status, 'ready');

      // Text handed in is scanned as well, as the bytes it is stored as.
      ingest._scanner = new CommandScanner({ command: 'fake {path}', exec: exec(1) });
      setPlatform({
        projects: {
          ...platform.projects,
          scan: { provider: 'command', command: 'fake {path}', onError: 'reject' }
        }
      });
      await assert.rejects(
        service.addItem(
          project.id,
          { kind: 'upload', ref: {}, name: 'eicar.txt', text: 'X5O!P%@AP' },
          { user: ADA }
        ),
        error => error.code === 'SCAN_REJECTED'
      );
      // A misconfigured scanner with `reject` keeps uploads out.
      ingest._scanner = null;
      setPlatform({
        projects: {
          ...platform.projects,
          scan: { provider: 'command', command: '', onError: 'reject' }
        }
      });
      await assert.rejects(
        service.addItem(
          project.id,
          { kind: 'upload', ref: {}, name: 'later.txt', text: 'fine' },
          { user: ADA }
        ),
        error => error.code === 'SCAN_REJECTED' && /misconfigured/.test(error.message)
      );
    } finally {
      ingest._scanner = null;
      setPlatform({ projects: { ...platform.projects, scan: { provider: 'none' } } });
    }
  });

  it('reconciles interrupted items and orphan blobs, and sweeps old temp directories', async () => {
    const project = await newProject();
    const repository = getProjectRepository();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await repository.mutate(project.id, p => ({
      ...p,
      items: [
        {
          id: 'itm_stuck',
          kind: 'upload',
          name: 'stuck',
          ref: {},
          storage: 'text',
          pinned: false,
          status: 'extracting',
          error: null,
          provenance: { origin: 'uploaded', by: { id: ADA.id }, at: old },
          createdAt: old,
          updatedAt: old
        },
        {
          id: 'itm_fresh',
          kind: 'upload',
          name: 'fresh',
          ref: {},
          storage: 'text',
          pinned: false,
          status: 'pending',
          error: null,
          provenance: { origin: 'uploaded', by: { id: ADA.id }, at: old },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    }));
    const oldVersion = `${(Date.now() - 3 * 60 * 60 * 1000).toString(36).padStart(9, '0')}deadbeef`;
    const newVersion = `${Date.now().toString(36).padStart(9, '0')}cafebabe`;
    await repository.blobs.put(
      PROJECT_FILES_NAMESPACE,
      `${project.id}__itm_gone__${oldVersion}`,
      Buffer.from('orphan')
    );
    await repository.blobs.put(
      PROJECT_FILES_NAMESPACE,
      `${project.id}__itm_new__${newVersion}`,
      Buffer.from('young')
    );
    // A blob of a project that no longer exists is an orphan too.
    await repository.blobs.put(
      PROJECT_FILES_NAMESPACE,
      `prj_vanished__itm_lost__${oldVersion}`,
      Buffer.from('orphan of a deleted project')
    );
    const ingest = new ProjectIngestService({
      service,
      repository,
      platform: () => platform,
      tempDir: path.join(scratch, 'tmp-test')
    });
    // An inventory that cannot be completed settles the items but sweeps
    // no blob: a project it could not read may still name them.
    const listAdmin = repository.listAdmin;
    repository.listAdmin = async () => {
      throw new Error('projects directory unreadable');
    };
    let kept;
    try {
      kept = await ingest.reconcile();
    } finally {
      repository.listAdmin = listAdmin;
    }
    assert.equal(kept.interrupted, 1);
    assert.equal(kept.orphans, 0);
    assert.ok(
      await repository.blobs.get(PROJECT_FILES_NAMESPACE, `${project.id}__itm_gone__${oldVersion}`)
    );
    const result = await ingest.reconcile();
    assert.equal(result.interrupted, 0);
    assert.equal(result.orphans, 2);
    const stuck = await itemOf(project.id, 'itm_stuck');
    assert.equal(stuck.status, 'failed');
    assert.equal(stuck.error.code, INTERRUPTED);
    assert.equal((await itemOf(project.id, 'itm_fresh')).status, 'pending');
    assert.equal(
      await repository.blobs.get(PROJECT_FILES_NAMESPACE, `${project.id}__itm_gone__${oldVersion}`),
      null
    );
    assert.ok(
      await repository.blobs.get(PROJECT_FILES_NAMESPACE, `${project.id}__itm_new__${newVersion}`)
    );
    assert.equal(
      await repository.blobs.get(PROJECT_FILES_NAMESPACE, `prj_vanished__itm_lost__${oldVersion}`),
      null
    );

    const oldDir = path.join(ingest.tempDir, 'u-old');
    const newDir = path.join(ingest.tempDir, 'u-new');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(newDir, { recursive: true });
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await fs.utimes(oldDir, past, past);
    assert.equal(await ingest.cleanTempDir(), 1);
    await assert.rejects(fs.stat(oldDir));
    await fs.stat(newDir);
  });

  it('sweeps no orphan blob while a project document cannot be read', async () => {
    const repository = getProjectRepository();
    const oldVersion = `${(Date.now() - 3 * 60 * 60 * 1000).toString(36).padStart(9, '0')}deadbeef`;
    const userBlob = `prj_torn__itm_kept__${oldVersion}`;
    const adminBlob = `admin_torn__itm_kept__${oldVersion}`;
    await repository.blobs.put(PROJECT_FILES_NAMESPACE, userBlob, Buffer.from('user text'));
    await repository.blobs.put(PROJECT_FILES_NAMESPACE, adminBlob, Buffer.from('admin text'));
    const ingest = new ProjectIngestService({
      service,
      repository,
      platform: () => platform,
      tempDir: path.join(scratch, 'tmp-torn')
    });
    // The test's storage keeps runtime documents under `<scratch>/data` and
    // configuration under `<scratch>` (its contents directory).
    const tornUser = path.join(scratch, 'data', 'user-projects', 'prj_torn.json');
    const tornAdmin = path.join(scratch, 'projects', 'admin_torn.json');
    await fs.mkdir(path.dirname(tornAdmin), { recursive: true });
    try {
      // A torn user project: the lenient listing skips it, but counts it.
      await fs.writeFile(tornUser, '{"v":1,"data":{"id":"prj_to', 'utf8');
      const scan = await repository.scanUser();
      assert.equal(scan.skipped, 1);
      assert.equal((await ingest.reconcile()).orphans, 0);
      assert.ok(await repository.blobs.get(PROJECT_FILES_NAMESPACE, userBlob));
      await fs.rm(tornUser);

      // A malformed admin project file: the strict admin listing refuses.
      await fs.writeFile(tornAdmin, '{"id": "admin_torn", ', 'utf8');
      await assert.rejects(repository.listAdmin({ strict: true }));
      assert.deepEqual(await repository.listAdmin(), []);
      assert.equal((await ingest.reconcile()).orphans, 0);
      assert.ok(await repository.blobs.get(PROJECT_FILES_NAMESPACE, adminBlob));
    } finally {
      await fs.rm(tornUser, { force: true });
      await fs.rm(tornAdmin, { force: true });
    }
    // Both inventories whole again: the blobs no project names are swept.
    assert.equal((await ingest.reconcile()).orphans, 2);
  });
});

describe('routes', () => {
  const routes = captureRoutes(registerProjectRoutes);
  const route = {
    create: handlersFor(routes, 'post', '/api/projects'),
    addItem: handlersFor(routes, 'post', '/api/projects/:projectId/items'),
    text: handlersFor(routes, 'get', '/api/projects/:projectId/items/:itemId/text'),
    refresh: handlersFor(routes, 'post', '/api/projects/:projectId/items/:itemId/refresh'),
    pages: handlersFor(routes, 'get', '/api/projects/pickers/pages'),
    urlCheck: handlersFor(routes, 'post', '/api/projects/pickers/url/check')
  };

  async function create() {
    const res = await drive(route.create, { user: ADA, body: { name: 'Uploads' } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    return res.body;
  }

  it('accepts a multipart upload, answers 202 and serves the text once ready', async () => {
    const project = await create();
    const req = multipartRequest({
      name: 'notes.md',
      contentType: 'text/markdown',
      bytes: Buffer.from('# Upload\n\nThe deposit is two months of rent.'),
      fields: { pinned: 'true' }
    });
    req.params = { projectId: project.id };
    const res = await drive(route.addItem, { user: ADA, req });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.equal(res.body.item.status, 'pending');
    assert.equal(res.body.item.pinned, true);
    assert.equal(res.body.item.name, 'notes.md');
    assert.equal(res.body.item.text, null);
    const ready = await settled(project.id, res.body.item.id);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    const text = await drive(route.text, {
      user: ADA,
      params: { projectId: project.id, itemId: ready.id },
      query: { maxChars: '10' }
    });
    assert.equal(text.statusCode, 200, JSON.stringify(text.body));
    assert.equal(text.body, '# Upload\n\n');
    assert.equal(text.headers['x-item-truncated'], 'true');
    assert.match(text.headers['content-type'], /text\/plain/);
    const refresh = await drive(route.refresh, {
      user: ADA,
      params: { projectId: project.id, itemId: ready.id }
    });
    assert.equal(refresh.statusCode, 400, 'an upload cannot be refreshed');
    assert.equal(refresh.body.details.code, 'INVALID_REF');
  });

  it('refuses an unsupported type before accepting bytes and a file over the limit', async () => {
    const project = await create();
    const png = multipartRequest({
      name: 'photo.png',
      contentType: 'image/png',
      bytes: Buffer.alloc(10)
    });
    png.params = { projectId: project.id };
    const refused = await drive(route.addItem, { user: ADA, req: png });
    assert.equal(refused.statusCode, 415, JSON.stringify(refused.body));
    assert.equal(refused.body.details.code, 'UNSUPPORTED_TYPE');

    // Declared as text, but the bytes are a PNG: refused after receive, before any item exists.
    const lying = multipartRequest({
      name: 'notes.txt',
      contentType: 'text/plain',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    });
    lying.params = { projectId: project.id };
    const sniffed = await drive(route.addItem, { user: ADA, req: lying });
    assert.equal(sniffed.statusCode, 415, JSON.stringify(sniffed.body));
    assert.equal((await getProjectRepository().get(project.id)).items.length, 0);

    setLimits({ maxFileBytes: 50 });
    try {
      const big = multipartRequest({
        name: 'big.txt',
        contentType: 'text/plain',
        bytes: Buffer.alloc(200, 0x61)
      });
      big.params = { projectId: project.id };
      const tooBig = await drive(route.addItem, { user: ADA, req: big });
      assert.equal(tooBig.statusCode, 413, JSON.stringify(tooBig.body));
      assert.equal(tooBig.body.details.code, 'QUOTA_FILE_BYTES');
    } finally {
      setLimits({});
    }
    const entries = await fs.readdir(getIngestService().tempDir).catch(() => []);
    assert.equal(entries.length, 0, 'no upload directory is left behind');

    const stillJson = await drive(route.addItem, {
      user: ADA,
      params: { projectId: project.id },
      body: { kind: 'upload', ref: {}, name: 'Pasted', text: 'Pasted text for the project.' }
    });
    assert.equal(stillJson.statusCode, 201, JSON.stringify(stillJson.body));
    assert.equal(stillJson.body.item.status, 'ready');
  });

  it('lists readable pages and checks a URL', async () => {
    configCache.setCacheEntry('config/ui.json', {
      pages: {
        faq: { title: { en: 'FAQ' }, filePath: { en: 'pages/en/faq.md', de: 'pages/de/faq.md' } },
        secret: {
          title: 'Secret',
          filePath: { en: 'x' },
          authRequired: true,
          allowedGroups: ['admins']
        }
      }
    });
    const pages = await drive(route.pages, { user: ADA });
    assert.equal(pages.statusCode, 200);
    assert.deepEqual(
      pages.body.pages.map(page => page.id),
      ['faq']
    );
    assert.deepEqual(pages.body.pages[0].languages, ['en', 'de']);
    const bad = await drive(route.urlCheck, { user: ADA, body: { url: 'ftp://example.com' } });
    assert.equal(bad.statusCode, 400);
    // The probe is held to the reader's line: no private or internal target.
    const inside = await drive(route.urlCheck, {
      user: ADA,
      body: { url: 'http://127.0.0.1:9/admin' }
    });
    assert.equal(inside.statusCode, 200);
    assert.equal(inside.body.ok, false);
    assert.match(inside.body.error, /private/);
    const local = await drive(route.urlCheck, { user: ADA, body: { url: 'http://localhost/' } });
    assert.equal(local.body.ok, false);
  });

  it('sizes a probed body up to a bound and drops the rest', async () => {
    const { Readable } = await import('node:stream');
    let destroyed = false;
    const endless = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
      destroy(error, cb) {
        destroyed = true;
        cb(error);
      }
    });
    const counted = await countBodyBytes(endless, 200 * 1024);
    assert.deepEqual(counted, { bytes: 200 * 1024, truncated: true });
    assert.equal(destroyed, true);
    assert.deepEqual(await countBodyBytes(Readable.from([Buffer.from('abc')]), 1024), {
      bytes: 3,
      truncated: false
    });
  });
});
