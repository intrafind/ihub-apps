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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
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
  MSG_MIME,
  acceptedTypeOf,
  extractText,
  msgContentOf,
  sniffBytes
} from '../services/projects/extractText.js';
import {
  CommandScanner,
  NoneScanner,
  scannerFor,
  splitCommand
} from '../services/projects/scan/MalwareScanner.js';
import {
  INTERRUPTED,
  ProjectIngestService,
  startIngestReconciler,
  stopIngestReconciler
} from '../services/projects/ProjectIngestService.js';
import { ProjectError, getProjectService } from '../services/projects/ProjectService.js';
import {
  PROJECT_FILES_NAMESPACE,
  getProjectRepository
} from '../services/projects/ProjectRepository.js';
import {
  getItemKind,
  isItemKindEnabled,
  registerItemKind
} from '../services/projects/kinds/registry.js';
import {
  bootstrapProjects,
  getIngestService,
  shutdownProjects
} from '../services/projects/bootstrap.js';
import { evictItemText, getItemText } from '../services/knowledge/ItemTextService.js';
import registerProjectRoutes from '../routes/projectRoutes.js';
import { countBodyBytes, probeUrl } from '../sources/SourceManager.js';
import { assertPublicTarget } from '../utils/ssrfGuard.js';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const MASTER = crypto.createHash('sha256').update('test-master').digest('hex');
const PREVIOUS = crypto.createHash('sha256').update('previous-master').digest('hex');

const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', groups: ['authenticated'] };

let scratch = null;
let platform = null;

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
    use: () => {
      // Middleware registrations are not part of what the tests look at.
    }
  });
  return routes;
}

function handlersFor(routes, method, suffix) {
  const route = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

function makeResponse() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: null,
    headers: {},
    writableEnded: false
  });
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
      await waitFor(() => advanced || responded, { timeoutMs: 3000, stepMs: 5 }).catch(() => {
        // A middleware that never answers is reported through `failure` below.
      });
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

function settled(projectId, itemId) {
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
  it('hands the truncation recorded at ingest to the readers, cached or not', async () => {
    const repository = getProjectRepository();
    const project = { id: 'prj_cut' };
    for (const truncated of [true, false]) {
      const itemId = truncated ? 'itm_cut' : 'itm_whole';
      const block = await storeText({
        projectId: project.id,
        itemId,
        text: `The rent is due monthly. ${itemId}`,
        original: { contentType: 'application/pdf', bytes: 2000, pages: 500 },
        truncated,
        platform,
        repository
      });
      assert.equal(block.truncated === true, truncated);
      const item = { id: itemId, kind: 'upload', storage: 'text', status: 'ready', text: block };
      evictItemText(block.blobKey);
      const fresh = await getItemText(project, item, { user: ADA });
      assert.equal(fresh.cached, false);
      assert.equal(fresh.truncated, truncated, `uncached, truncated=${truncated}`);
      const cached = await getItemText(project, item, { user: ADA });
      assert.equal(cached.cached, true);
      assert.equal(cached.truncated, truncated, `cached, truncated=${truncated}`);
      assert.match(cached.text, /due monthly/);
    }
  });

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

/**
 * A minimal Outlook message as an OLE2 compound file: the subject and the
 * plain body as UTF-16 property streams in the mini stream, one FAT sector,
 * one directory sector, one mini FAT sector. Enough for msgreader, and free
 * of anyone's mail.
 */
function makeMsg({ subject, body }) {
  const SECTOR = 512;
  const MINI = 64;
  const ENDOFCHAIN = 0xfffffffe;
  const FATSECT = 0xfffffffd;
  const FREESECT = 0xffffffff;
  const NOSTREAM = 0xffffffff;
  const streams = [
    { name: '__substg1.0_0037001F', data: Buffer.from(subject, 'utf16le') },
    { name: '__substg1.0_1000001F', data: Buffer.from(body, 'utf16le') }
  ];
  const miniSectors = [];
  const miniFat = [];
  for (const stream of streams) {
    stream.start = miniSectors.length;
    const count = Math.max(1, Math.ceil(stream.data.length / MINI));
    for (let i = 0; i < count; i += 1) {
      const chunk = Buffer.alloc(MINI);
      stream.data.copy(chunk, 0, i * MINI, Math.min(stream.data.length, (i + 1) * MINI));
      miniSectors.push(chunk);
      miniFat.push(i === count - 1 ? ENDOFCHAIN : stream.start + i + 1);
    }
  }
  const miniStream = Buffer.concat(miniSectors);
  const containerSectors = Math.ceil(miniStream.length / SECTOR);
  // Sectors: 0 FAT, 1 directory, 2 mini FAT, 3… the mini stream container.
  const fat = Buffer.alloc(SECTOR, 0xff);
  const fatEntries = [FATSECT, ENDOFCHAIN, ENDOFCHAIN];
  for (let i = 0; i < containerSectors; i += 1) {
    fatEntries.push(i === containerSectors - 1 ? ENDOFCHAIN : 4 + i);
  }
  fatEntries.forEach((value, index) => fat.writeUInt32LE(value, index * 4));
  const miniFatSector = Buffer.alloc(SECTOR, 0xff);
  miniFat.forEach((value, index) => miniFatSector.writeUInt32LE(value, index * 4));
  const entry = ({ name, type, left, right, child, start, size }) => {
    const buf = Buffer.alloc(128);
    const utf16 = Buffer.from(name, 'utf16le');
    utf16.copy(buf, 0);
    buf.writeUInt16LE(utf16.length + 2, 64);
    buf.writeUInt8(type, 66);
    buf.writeUInt8(1, 67); // black
    buf.writeUInt32LE(left, 68);
    buf.writeUInt32LE(right, 72);
    buf.writeUInt32LE(child, 76);
    buf.writeUInt32LE(start, 116);
    buf.writeUInt32LE(size, 120);
    return buf;
  };
  const directory = Buffer.concat([
    entry({
      name: 'Root Entry',
      type: 5,
      left: NOSTREAM,
      right: NOSTREAM,
      child: 1,
      start: 3,
      size: miniStream.length
    }),
    entry({
      name: streams[0].name,
      type: 2,
      left: NOSTREAM,
      right: 2,
      child: NOSTREAM,
      start: streams[0].start,
      size: streams[0].data.length
    }),
    entry({
      name: streams[1].name,
      type: 2,
      left: NOSTREAM,
      right: NOSTREAM,
      child: NOSTREAM,
      start: streams[1].start,
      size: streams[1].data.length
    }),
    Buffer.alloc(128)
  ]);
  const header = Buffer.alloc(SECTOR);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x3e, 24); // minor version
  header.writeUInt16LE(3, 26); // major version
  header.writeUInt16LE(0xfffe, 28); // byte order
  header.writeUInt16LE(9, 30); // sector shift
  header.writeUInt16LE(6, 32); // mini sector shift
  header.writeUInt32LE(1, 44); // FAT sectors
  header.writeUInt32LE(1, 48); // first directory sector
  header.writeUInt32LE(4096, 56); // mini stream cutoff
  header.writeUInt32LE(2, 60); // first mini FAT sector
  header.writeUInt32LE(1, 64); // mini FAT sectors
  header.writeUInt32LE(ENDOFCHAIN, 68); // first DIFAT sector
  header.writeUInt32LE(0, 72); // DIFAT sectors
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i === 0 ? 0 : FREESECT, 76 + i * 4);
  const container = Buffer.alloc(containerSectors * SECTOR);
  miniStream.copy(container, 0);
  return Buffer.concat([header, fat, directory, miniFatSector, container]);
}

/** Compressed RTF in its uncompressed ("MELA") form, as decompressrtf reads it. */
function uncompressedRtf(rtf) {
  const raw = Buffer.from(rtf, 'latin1');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(raw.length + 12, 0);
  header.writeUInt32LE(raw.length, 4);
  header.write('MELA', 8, 'latin1');
  header.writeUInt32LE(0, 12);
  return Buffer.concat([header, raw]);
}

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

  it('accepts an Outlook message by name or type and refuses legacy Office files', () => {
    assert.equal(acceptedTypeOf({ name: 'mail.msg' }), MSG_MIME);
    assert.equal(
      acceptedTypeOf({ name: 'mail.msg', contentType: 'application/octet-stream' }),
      MSG_MIME
    );
    assert.equal(acceptedTypeOf({ name: 'mail', contentType: MSG_MIME }), MSG_MIME);
    assert.equal(acceptedTypeOf({ name: 'old.doc', contentType: 'application/msword' }), null);
    assert.equal(sniffBytes(Buffer.from('d0cf11e0a1b11ae100000000', 'hex')), 'ole2');
    assert.ok(ACCEPTED_TYPES.extensions.includes('.msg'));
    assert.ok(ACCEPTED_TYPES.mimeTypes.includes(MSG_MIME));
  });

  it('reads the subject and the body of an Outlook message, and names a .doc for what it is', async () => {
    const bytes = makeMsg({
      subject: 'Quarterly review — Zürich office',
      body: 'Hello team,\r\n\r\nthe figures are attached; the rent is due monthly.\r\n'
    });
    const result = await extractText({ bytes, name: 'review.msg' });
    assert.equal(result.contentType, MSG_MIME);
    assert.match(result.text, /^Subject: Quarterly review — Zürich office/);
    assert.match(result.text, /the rent is due monthly\./);
    assert.equal(result.truncated, false);
    // The same bytes under a generic type still read as a message.
    const generic = await extractText({
      bytes,
      name: 'review.msg',
      contentType: 'application/octet-stream'
    });
    assert.equal(generic.contentType, MSG_MIME);
    await assert.rejects(
      extractText({ bytes, name: 'old.doc', contentType: 'application/msword' }),
      error => error instanceof ExtractionError && /legacy Office/.test(error.message)
    );
    await assert.rejects(
      extractText({ bytes: Buffer.from('not a compound file at all'), name: 'broken.msg' }),
      error => error.code === 'UNSUPPORTED_TYPE' && /Outlook message/.test(error.message)
    );
  });

  it('turns the parsed fields of a message into text: headers, recipients, each body form', async () => {
    const windows1252 = Uint8Array.from([...'<p>Grüße aus München</p>'].map(c => c.charCodeAt(0)));
    const htmlOnly = await msgContentOf({
      subject: 'Newsletter',
      senderName: 'Franz',
      senderEmail: '/O=EXCHANGE/OU=FIRST/CN=FRANZ',
      senderSmtpAddress: 'franz@example.com',
      recipients: [
        { name: 'Ada', smtpAddress: 'ada@example.com', recipType: 'to' },
        { name: 'Grace', email: '/O=EXCHANGE/CN=GRACE', recipType: 'cc' }
      ],
      messageDeliveryTime: '2026-10-21T08:00:00.000Z',
      attachments: [{ fileName: 'figures.xlsx' }, { name: 'map.png' }],
      html: windows1252,
      internetCodepage: 1252
    });
    assert.equal(
      htmlOnly,
      [
        'Subject: Newsletter',
        'From: Franz <franz@example.com>',
        'To: Ada <ada@example.com>',
        'Cc: Grace',
        'Date: 2026-10-21T08:00:00.000Z',
        'Attachments: figures.xlsx, map.png',
        '',
        'Grüße aus München'
      ].join('\n')
    );
    const plainWins = await msgContentOf({ body: 'plain wins', bodyHtml: '<p>html loses</p>' });
    assert.equal(plainWins, 'plain wins');
    const htmlString = await msgContentOf({ bodyHtml: '<h1>Title</h1><p>Para</p>' });
    assert.equal(htmlString, '# Title\n\nPara');
    const rtf = await msgContentOf({
      compressedRtf: uncompressedRtf(
        '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 First line\\par Second line\\par}'
      )
    });
    assert.equal(rtf, 'First line\nSecond line');
    assert.equal(await msgContentOf({ subject: 'Empty' }), 'Subject: Empty');
    assert.equal(await msgContentOf(null), '');
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

  it('reads each e-mail body part in the charset it declares, 8bit parts included', async () => {
    const latin = text => Buffer.from(text, 'latin1');
    const multipart = await extractText({
      bytes: Buffer.concat([
        latin(
          'From: ada@example.com\r\nSubject: Miete\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b2"\r\n\r\n--b2\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
        ),
        latin('Die Miete ist fällig. Grüße aus Köln.'),
        latin(
          '\r\n--b2\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
        ),
        Buffer.from('Die Kaution beträgt 2400 €.', 'utf8'),
        latin('\r\n--b2--\r\n')
      ]),
      name: 'latin.eml'
    });
    assert.match(multipart.text, /^Subject: Miete$/m);
    assert.match(multipart.text, /Die Miete ist fällig\. Grüße aus Köln\./);
    assert.match(multipart.text, /Die Kaution beträgt 2400 €\./);
    assert.doesNotMatch(multipart.text, /\uFFFD/);

    // A single-part message, and a header in raw UTF-8 (RFC 6532).
    const single = await extractText({
      bytes: Buffer.concat([
        Buffer.from('Subject: Kündigung\r\n', 'utf8'),
        latin(
          'Content-Type: text/plain; charset="ISO-8859-1"\r\nContent-Transfer-Encoding: 8bit\r\n\r\nSehr geehrte Damen und Herren, hiermit kündige ich.\r\n'
        )
      ]),
      name: 'single.eml'
    });
    assert.match(single.text, /^Subject: Kündigung$/m);
    assert.match(single.text, /hiermit kündige ich\./);
  });

  it('bounds the columns and cells of a sparse worksheet before converting it', async () => {
    // Column A on 2000 rows and one value in the last column, XFD2000:
    // a 2000 x 16384 range from a file of a few kilobytes (written by hand,
    // as a writer would fill the range).
    const { default: JSZip } = await import('jszip');
    const cell = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
    const rows = [];
    for (let row = 1; row <= 2000; row += 1) {
      const far = row === 2000 ? cell('XFD2000', 'far away') : '';
      rows.push(`<row r="${row}">${cell(`A${row}`, `Row ${row}`)}${far}</row>`);
    }
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    );
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    );
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sparse" sheetId="1" r:id="rId1"/></sheets></workbook>'
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD2000"/><sheetData>${rows.join('')}</sheetData></worksheet>`
    );
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.ok(bytes.length < 100 * 1024);
    const started = Date.now();
    const result = await extractText({ bytes, name: 'sparse.xlsx' });
    assert.ok(Date.now() - started < 15000, 'the sparse range is not materialized');
    assert.match(result.text, /Row 1\b/);
    assert.match(result.text, /columns beyond 1000 omitted/);
    assert.match(result.text, /rows omitted/);
    assert.doesNotMatch(result.text, /far away/);
    assert.equal(result.truncated, true);
  });

  it('reports content an extractor left out on its own limits as truncated', async () => {
    // The production limits leave these small files whole.
    const whole = await extractText({ bytes: await makeXlsx(), name: 'budget.xlsx' });
    assert.equal(whole.truncated, false);
    const pdf = await extractText({ bytes: await makePdf(3), name: 'lease.pdf' });
    assert.equal(pdf.truncated, false);
    assert.equal(pdf.pages, 3);

    // Rows past the sheet's row limit: the notice is in the text, and the flag is set.
    const rows = await extractText(
      { bytes: await makeXlsx(), name: 'budget.xlsx' },
      { sheetRows: 2 }
    );
    assert.match(rows.text, /rows omitted/);
    assert.doesNotMatch(rows.text, /Deposit/);
    assert.equal(rows.truncated, true);

    // Pages past the page limit, though the text is far below the character cap.
    const pages = await extractText(
      { bytes: await makePdf(3), name: 'lease.pdf' },
      { maxPages: 2 }
    );
    assert.equal(pages.pages, 2);
    assert.equal(pages.truncated, true);

    // The character cap still counts on its own.
    const capped = await extractText(
      { bytes: await makeXlsx(), name: 'budget.xlsx' },
      { maxChars: 20 }
    );
    assert.equal(capped.text.length, 20);
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
  let service = null;
  let fakeFetch = null;

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
        // What the source holds now; a one-shot `gate` then holds the download.
        const { bytes, lastModified, gate } = fakeFetch;
        fakeFetch.gate = null;
        if (gate) {
          fakeFetch.entered = true;
          await gate;
        }
        return {
          bytes,
          contentType: 'text/markdown',
          name: 'cloud.md',
          lastModified,
          source: { site: 'Fake cloud', lastModified }
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

  it('replaces the text of a written document in place, and refuses it for a link', async () => {
    const project = await newProject();
    const { item } = await service.addItem(
      project.id,
      {
        kind: 'upload',
        ref: { contentType: 'text/plain' },
        name: 'Notes.txt',
        text: 'The rent is due monthly.'
      },
      { user: ADA, origin: 'uploaded' }
    );
    const oldKey = item.text.blobKey;
    const edited = await service.replaceItemText(
      project.id,
      item.id,
      '# Notes\n\nThe rent is due on the first of the month.',
      { user: GRACE }
    );
    assert.equal(edited.item.status, 'ready');
    assert.notEqual(edited.item.text.blobKey, oldKey, 'a new blob holds the new text');
    assert.equal(edited.item.provenance.origin, 'written');
    assert.equal(edited.item.provenance.by.id, GRACE.id);
    assert.equal(edited.item.ref.contentType, 'text/markdown');
    assert.equal(edited.item.refreshingAt, undefined);
    assert.equal(edited.item.ingestAttempt, undefined);
    const stored = await getProjectRepository().get(project.id);
    const { text } = await getItemText(stored, edited.item, { user: ADA });
    assert.equal(text, '# Notes\n\nThe rent is due on the first of the month.');
    assert.equal(stored.usage.bytes, Buffer.byteLength(text));
    const blobs = await getProjectRepository().blobs.list(PROJECT_FILES_NAMESPACE, {
      prefix: `${project.id}__`
    });
    assert.equal(blobs.items.length, 1, 'the old blob went with the edit');
    await assert.rejects(
      service.replaceItemText(project.id, item.id, '   \n', { user: ADA }),
      error => error.code === 'INVALID_REF'
    );
    const { item: link } = await service.addItem(
      project.id,
      { kind: 'url', ref: { url: 'https://example.com/policy' } },
      { user: ADA }
    );
    await assert.rejects(
      service.replaceItemText(project.id, link.id, 'not a stored text', { user: ADA }),
      error => error.code === 'INVALID_REF'
    );
    await assert.rejects(
      service.replaceItemText(project.id, 'itm_missing', 'x', { user: ADA }),
      error => error.code === 'ITEM_NOT_FOUND'
    );
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
    // The directory goes in the job's last step, after the item is ready.
    await waitFor(() =>
      fs.stat(dir).then(
        () => null,
        () => true
      )
    );
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
    // The directory goes once the job has recorded the failure.
    await waitFor(() =>
      fs.stat(dir).then(
        () => null,
        () => true
      )
    );
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

  it('discards a refresh another worker released, so it cannot overwrite a newer one', async () => {
    const project = await newProject();
    const repository = getProjectRepository();
    const { item } = await service.addItem(
      project.id,
      { kind: 'fake-cloud', ref: { fileId: 'fenced' } },
      { user: ADA }
    );
    const picked = await settled(project.id, item.id);
    assert.equal(picked.status, 'ready', JSON.stringify(picked.error));
    let open = null;
    try {
      // Refresh A downloads an older version and hangs in the download.
      fakeFetch.bytes = Buffer.from('# Cloud doc A\n\nThe older version.');
      fakeFetch.lastModified = '2026-10-05T00:00:00.000Z';
      fakeFetch.entered = false;
      fakeFetch.gate = new Promise(resolve => {
        open = resolve;
      });
      const reserved = await service.refreshItem(project.id, item.id, { user: ADA });
      assert.equal(typeof reserved.item.ingestAttempt, 'string');
      await waitFor(() => fakeFetch.entered);

      // Another worker's reconciler (its own job map, this project only)
      // finds the refresh past `staleAfterMinutes` and releases it.
      const scoped = Object.create(repository);
      scoped.listAdmin = async () => [];
      scoped.scanUser = async () => ({
        projects: [await repository.get(project.id)],
        truncated: false,
        skipped: 0
      });
      scoped.hasBlobs = () => false;
      const other = new ProjectIngestService({
        service,
        repository: scoped,
        platform: () => platform,
        tempDir: path.join(scratch, 'tmp-other-worker')
      });
      const released = await other.reconcile({ now: Date.now() + 3 * 60 * 60 * 1000 });
      assert.equal(released.interrupted, 1);
      const interrupted = await itemOf(project.id, item.id);
      assert.equal(interrupted.status, 'stale');
      assert.equal(interrupted.error.code, INTERRUPTED);
      assert.equal(interrupted.ingestAttempt, undefined);

      // Refresh B runs to the end with the newer version.
      fakeFetch.bytes = Buffer.from('# Cloud doc B\n\nThe newer version.');
      fakeFetch.lastModified = '2026-10-07T00:00:00.000Z';
      const newer = await service.refreshItem(project.id, item.id, { user: ADA, wait: true });
      assert.equal(newer.item.status, 'ready');

      // A wakes up: its attempt is gone, it installs and records nothing.
      open();
      await waitFor(() => !service.ingest.isActive(item.id));
      const final = await itemOf(project.id, item.id);
      assert.equal(final.status, 'ready');
      assert.equal(final.error, null);
      assert.equal(final.refreshingAt, undefined);
      assert.equal(final.text.blobKey, newer.item.text.blobKey);
      assert.equal(final.provenance.source.lastModified, '2026-10-07T00:00:00.000Z');
      assert.match(
        (await getItemText({ id: project.id }, final, { user: ADA })).text,
        /The newer version/
      );
      // A's blob went with it; only B's text is stored for the item.
      const page = await repository.blobs.list(PROJECT_FILES_NAMESPACE, {
        prefix: `${project.id}__${item.id}__`
      });
      assert.deepEqual(
        page.items.map(blob => blob.key),
        [final.text.blobKey]
      );
    } finally {
      open?.();
      fakeFetch.gate = null;
      fakeFetch.lastModified = '2026-10-01T00:00:00.000Z';
      fakeFetch.bytes = Buffer.from('# Cloud doc\n\nPicked from the cloud.');
    }
  });

  it('discards a slow first pick another worker released, after a refresh replaced it', async () => {
    const project = await newProject();
    const repository = getProjectRepository();
    let open = null;
    try {
      // The first pick hangs in its download.
      fakeFetch.bytes = Buffer.from('# Cloud doc A\n\nThe older version.');
      fakeFetch.lastModified = '2026-10-05T00:00:00.000Z';
      fakeFetch.entered = false;
      fakeFetch.gate = new Promise(resolve => {
        open = resolve;
      });
      const { item } = await service.addItem(
        project.id,
        { kind: 'fake-cloud', ref: { fileId: 'slow-pick' } },
        { user: ADA }
      );
      assert.equal(typeof (await itemOf(project.id, item.id)).ingestAttempt, 'string');
      await waitFor(() => fakeFetch.entered);

      // Another worker's reconciler releases it past `staleAfterMinutes`.
      const scoped = Object.create(repository);
      scoped.listAdmin = async () => [];
      scoped.scanUser = async () => ({
        projects: [await repository.get(project.id)],
        truncated: false,
        nextCursor: null,
        skipped: 0
      });
      scoped.hasBlobs = () => false;
      const other = new ProjectIngestService({
        service,
        repository: scoped,
        platform: () => platform,
        tempDir: path.join(scratch, 'tmp-other-pick')
      });
      assert.equal(
        (await other.reconcile({ now: Date.now() + 3 * 60 * 60 * 1000 })).interrupted,
        1
      );
      const released = await itemOf(project.id, item.id);
      assert.equal(released.status, 'failed');
      assert.equal(released.error.code, INTERRUPTED);
      assert.equal(released.ingestAttempt, undefined);

      // The editor refreshes the failed item; the newer version is installed.
      fakeFetch.bytes = Buffer.from('# Cloud doc B\n\nThe newer version.');
      fakeFetch.lastModified = '2026-10-07T00:00:00.000Z';
      const newer = await service.refreshItem(project.id, item.id, { user: ADA, wait: true });
      assert.equal(newer.item.status, 'ready');

      // The first pick wakes up: it installs and records nothing.
      open();
      await waitFor(() => !service.ingest.isActive(item.id));
      const final = await itemOf(project.id, item.id);
      assert.equal(final.status, 'ready');
      assert.equal(final.error, null);
      assert.equal(final.text.blobKey, newer.item.text.blobKey);
      assert.match(
        (await getItemText({ id: project.id }, final, { user: ADA })).text,
        /The newer version/
      );
      const page = await repository.blobs.list(PROJECT_FILES_NAMESPACE, {
        prefix: `${project.id}__${item.id}__`
      });
      assert.deepEqual(
        page.items.map(blob => blob.key),
        [final.text.blobKey]
      );
    } finally {
      open?.();
      fakeFetch.gate = null;
      fakeFetch.lastModified = '2026-10-01T00:00:00.000Z';
      fakeFetch.bytes = Buffer.from('# Cloud doc\n\nPicked from the cloud.');
    }
  });

  it('reserves a refresh before queueing it, so a second one is refused', async () => {
    const project = await newProject();
    const { item } = await service.addItem(
      project.id,
      { kind: 'fake-cloud', ref: { fileId: 'busy' } },
      { user: ADA }
    );
    const picked = await settled(project.id, item.id);
    assert.equal(picked.status, 'ready', JSON.stringify(picked.error));
    const ingest = service.ingest;
    // Every slot taken: the refresh waits in the queue, not yet in `_run`.
    const occupied = ingest.settings().ingest.concurrency;
    ingest.running += occupied;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ingest.running -= occupied;
      ingest._pump();
    };
    try {
      const queued = await service.refreshItem(project.id, item.id, { user: ADA });
      assert.equal(typeof queued.item.refreshingAt, 'string');
      assert.equal(queued.item.status, 'ready');
      assert.equal(queued.item.text.blobKey, picked.text.blobKey);
      assert.equal(ingest.queue.filter(entry => entry.job.itemId === item.id).length, 1);
      await assert.rejects(
        service.refreshItem(project.id, item.id, { user: ADA }),
        error => error.code === 'PROJECT_MISMATCH'
      );
      assert.equal(ingest.queue.filter(entry => entry.job.itemId === item.id).length, 1);
      // The old snapshot stays readable while the refresh waits.
      const waiting = await itemOf(project.id, item.id);
      assert.match(
        (await getItemText({ id: project.id }, waiting, { user: ADA })).text,
        /Picked from the cloud/
      );
      release();
      const done = await waitFor(async () => {
        const current = await itemOf(project.id, item.id);
        return current.refreshingAt === undefined && !ingest.isActive(item.id) && current;
      });
      assert.equal(done.status, 'ready');
      // Once it is done, the item can be refreshed again.
      const again = await service.refreshItem(project.id, item.id, { user: ADA, wait: true });
      assert.equal(again.item.refreshingAt, undefined);
    } finally {
      release();
    }
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
    let kept = null;
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

  it('leaves an item another worker or a new refresh took over since the inventory', async () => {
    const project = await newProject();
    const repository = getProjectRepository();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const base = {
      kind: 'fake-cloud',
      ref: { fileId: 'f1' },
      storage: 'text',
      pinned: false,
      error: null,
      provenance: { origin: 'picked', by: { id: ADA.id }, at: old },
      createdAt: old,
      updatedAt: old
    };
    await repository.mutate(project.id, p => ({
      ...p,
      items: [
        { ...base, id: 'itm_refresh', name: 'refresh', status: 'ready', refreshingAt: old },
        { ...base, id: 'itm_upload', name: 'upload', kind: 'upload', ref: {}, status: 'pending' },
        { ...base, id: 'itm_dead', name: 'dead', status: 'ready', refreshingAt: old }
      ]
    }));
    // Between the inventory and the locked write, another worker settled the
    // interrupted refresh and the user started a new one; the queued upload's
    // job started extracting. Only the untouched item is still the stale one.
    const fresh = new Date().toISOString();
    const racing = Object.create(service);
    racing.patchItem = async (projectId, itemId, update, options) => {
      if (itemId !== 'itm_dead') {
        await repository.mutate(projectId, p => {
          const item = p.items.find(entry => entry.id === itemId);
          if (itemId === 'itm_refresh') item.refreshingAt = fresh;
          else item.status = 'extracting';
          item.updatedAt = fresh;
          return p;
        });
      }
      return service.patchItem(projectId, itemId, update, options);
    };
    const ingest = new ProjectIngestService({
      service: racing,
      repository,
      platform: () => platform,
      tempDir: path.join(scratch, 'tmp-race')
    });
    const result = await ingest.reconcile();
    assert.equal(result.interrupted, 1);
    const refreshing = await itemOf(project.id, 'itm_refresh');
    assert.equal(refreshing.refreshingAt, fresh);
    assert.equal(refreshing.status, 'ready');
    assert.equal(refreshing.error, null);
    const extracting = await itemOf(project.id, 'itm_upload');
    assert.equal(extracting.status, 'extracting');
    assert.equal(extracting.error, null);
    const dead = await itemOf(project.id, 'itm_dead');
    assert.equal(dead.refreshingAt, undefined);
    assert.equal(dead.status, 'failed');
    assert.equal(dead.error.code, INTERRUPTED);
  });

  it('keeps the upload directories of queued and running jobs, and sweeps the rest each tick', async () => {
    const ingest = new ProjectIngestService({
      service,
      platform: () => platform,
      tempDir: path.join(scratch, 'tmp-busy')
    });
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const dirs = {};
    for (const name of ['u-running', 'u-queued', 'u-scratch', 'u-abandoned']) {
      dirs[name] = path.join(ingest.tempDir, name);
      await fs.mkdir(dirs[name], { recursive: true });
      await fs.writeFile(path.join(dirs[name], 'original'), 'plaintext');
      await fs.utimes(dirs[name], past, past);
    }
    ingest.active.add({
      itemId: 'itm_running',
      input: { path: path.join(dirs['u-running'], 'original'), cleanupDir: dirs['u-running'] }
    });
    ingest.active.add({
      itemId: 'itm_picked',
      input: {},
      scratchDir: dirs['u-scratch']
    });
    ingest.queue.push({
      job: { itemId: 'itm_queued', input: { path: path.join(dirs['u-queued'], 'original') } },
      resolve: () => {}
    });
    try {
      assert.equal(await ingest.cleanTempDir(), 1);
      await assert.rejects(fs.stat(dirs['u-abandoned']));
      await fs.stat(dirs['u-running']);
      await fs.stat(dirs['u-queued']);
      await fs.stat(dirs['u-scratch']);
    } finally {
      ingest.active.clear();
      ingest.queue.length = 0;
    }

    // The periodic tick runs the sweep after the reconciler, even when the
    // reconciler fails.
    const calls = [];
    stopIngestReconciler();
    startIngestReconciler(
      {
        reconcile: async () => {
          calls.push('reconcile');
          throw new Error('inventory failed');
        },
        cleanTempDir: async () => {
          calls.push('clean');
          return 0;
        }
      },
      { intervalMs: 10 }
    );
    try {
      await waitFor(() => calls.includes('clean'));
    } finally {
      stopIngestReconciler();
    }
    assert.deepEqual(calls.slice(0, 2), ['reconcile', 'clean']);
  });

  it('keeps cloud kinds closed while the integrations feature is off', async () => {
    const features = configCache.getFeatures();
    const savedPlatform = platform;
    const providers = [{ id: 'o365', type: 'office365', enabled: true }];
    setPlatform({ cloudStorage: { providers } });
    const office365 = getItemKind('office365');
    assert.ok(office365, 'the cloud kinds are registered');
    assert.equal(
      isItemKindEnabled('office365', { platform, features: { integrations: true } }),
      true
    );
    assert.equal(
      isItemKindEnabled('office365', { platform, features: { integrations: false } }),
      false
    );
    const project = await newProject();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await getProjectRepository().mutate(project.id, p => ({
      ...p,
      items: [
        {
          id: 'itm_o365',
          kind: 'office365',
          name: 'Lease.docx',
          ref: { providerId: 'o365', fileId: 'file-1' },
          storage: 'text',
          pinned: false,
          status: 'ready',
          error: null,
          provenance: { origin: 'picked', by: { id: ADA.id }, at: old },
          createdAt: old,
          updatedAt: old
        }
      ]
    }));
    configCache.setCacheEntry('config/features.json', { ...features, integrations: false });
    try {
      // A pick is refused before anything is queued.
      await assert.rejects(
        service.addItem(
          project.id,
          { kind: 'office365', ref: { providerId: 'o365', fileId: 'file-2' } },
          { user: ADA, wait: true }
        ),
        error => error.code === 'KIND_DISABLED'
      );
      // A refresh skips the availability check; the download refuses itself.
      await assert.rejects(
        service.refreshItem(project.id, 'itm_o365', { user: ADA, wait: true }),
        error => error.code === 'FEATURE_DISABLED'
      );
      await assert.rejects(
        office365.fetch({ ref: { providerId: 'o365', fileId: 'file-1' } }, { user: ADA }),
        error => error.code === 'FEATURE_DISABLED'
      );
      const item = await itemOf(project.id, 'itm_o365');
      assert.equal(item.refreshingAt, undefined);
      assert.equal(item.error.code, 'FEATURE_DISABLED');
    } finally {
      configCache.setCacheEntry('config/features.json', features);
      platform = savedPlatform;
      configCache.setCacheEntry('config/platform.json', platform);
    }
  });

  it('follows the inventory past its first page of user projects', async () => {
    const repository = getProjectRepository();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stuckIds = [];
    for (const name of ['Paged A', 'Paged B']) {
      const project = await newProject(name);
      await repository.mutate(project.id, p => ({
        ...p,
        items: [
          {
            id: 'itm_paged',
            kind: 'upload',
            name: 'paged',
            ref: {},
            storage: 'text',
            pinned: false,
            status: 'extracting',
            error: null,
            provenance: { origin: 'uploaded', by: { id: ADA.id }, at: old },
            createdAt: old,
            updatedAt: old
          }
        ]
      }));
      stuckIds.push(project.id);
    }
    const oldVersion = `${(Date.now() - 3 * 60 * 60 * 1000).toString(36).padStart(9, '0')}deadbeef`;
    const orphan = `prj_pagedgone__itm_lost__${oldVersion}`;
    await repository.blobs.put(PROJECT_FILES_NAMESPACE, orphan, Buffer.from('orphan'));
    // An installation larger than a page: every page holds one project.
    const scoped = Object.create(repository);
    let pages = 0;
    scoped.scanUser = options => {
      pages += 1;
      return repository.scanUser({ ...options, max: 1, maxScanned: 1 });
    };
    const ingest = new ProjectIngestService({
      service,
      repository: scoped,
      platform: () => platform,
      tempDir: path.join(scratch, 'tmp-paged')
    });
    const result = await ingest.reconcile();
    assert.ok(pages > 2, `the inventory read ${pages} pages`);
    assert.ok(result.interrupted >= 2);
    for (const projectId of stuckIds) {
      const item = await itemOf(projectId, 'itm_paged');
      assert.equal(item.status, 'failed');
      assert.equal(item.error.code, INTERRUPTED);
    }
    // The whole inventory was read: the orphan is swept.
    assert.equal(await repository.blobs.get(PROJECT_FILES_NAMESPACE, orphan), null);
  });

  it('parses blob keys from the right and keeps the ones it cannot parse', async () => {
    const repository = getProjectRepository();
    const oldVersion = `${(Date.now() - 3 * 60 * 60 * 1000).toString(36).padStart(9, '0')}deadbeef`;
    const newVersion = `${Date.now().toString(36).padStart(9, '0')}cafebabe`;
    // An admin project id may hold `__`, and so may the base64url of an item id.
    const keys = {
      old: `policies__eu__itm_gone__${oldVersion}`,
      young: `policies__eu__itm_young__${newVersion}`,
      busy: `policies__eu__itm_b__sy__${oldVersion}`,
      unparsable: `policies__eu__itm_odd__not-a-version`,
      bare: `policies__${oldVersion}`
    };
    for (const key of Object.values(keys)) {
      await repository.blobs.put(PROJECT_FILES_NAMESPACE, key, Buffer.from('text'));
    }
    const ingest = new ProjectIngestService({
      service,
      repository,
      platform: () => platform,
      tempDir: path.join(scratch, 'tmp-keys')
    });
    ingest.active.add({ itemId: 'itm_b__sy', input: {} });
    try {
      await ingest.reconcile();
    } finally {
      ingest.active.clear();
    }
    const left = async key => Boolean(await repository.blobs.get(PROJECT_FILES_NAMESPACE, key));
    assert.equal(await left(keys.old), false, 'an old orphan is swept');
    assert.equal(await left(keys.young), true, 'a young blob is kept');
    assert.equal(await left(keys.busy), true, 'a blob of a running job is kept');
    assert.equal(await left(keys.unparsable), true, 'a key without a version is kept');
    assert.equal(await left(keys.bare), true, 'a key without an item is kept');
    for (const key of Object.values(keys)) {
      await repository.blobs.delete(PROJECT_FILES_NAMESPACE, key).catch(() => false);
    }
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

      // Readable, but its id was changed by hand, or is no valid id: the
      // lenient listing skips it, the strict one refuses, the blobs stay.
      for (const id of ['admin_renamed', 'not a valid id!']) {
        await fs.writeFile(tornAdmin, JSON.stringify({ id, name: 'Torn', items: [] }), 'utf8');
        await assert.rejects(repository.listAdmin({ strict: true }));
        assert.deepEqual(await repository.listAdmin(), []);
        assert.equal((await ingest.reconcile()).orphans, 0);
        assert.ok(await repository.blobs.get(PROJECT_FILES_NAMESPACE, adminBlob));
      }
    } finally {
      await fs.rm(tornUser, { force: true });
      await fs.rm(tornAdmin, { force: true });
    }
    // Both inventories whole again: the blobs no project names are swept.
    assert.equal((await ingest.reconcile()).orphans, 2);
  });
});

describe('built-in cloud kinds', () => {
  let server = null;
  let base = null;
  const restore = [];
  const sockets = new Set();
  /** Path → the Authorization header the request carried (or null). */
  const seen = new Map();

  function stub(target, key, value) {
    const had = Object.prototype.hasOwnProperty.call(target, key);
    const previous = target[key];
    restore.push(() => {
      if (had) target[key] = previous;
      else delete target[key];
    });
    target[key] = value;
  }

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://local');
      seen.set(url.pathname, req.headers.authorization || null);
      const send = (status, body, headers = {}) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      const graphFile = (id, downloadUrl) =>
        send(
          200,
          JSON.stringify({
            id,
            name: 'Lease.txt',
            size: 22,
            file: { mimeType: 'text/plain' },
            '@microsoft.graph.downloadUrl': downloadUrl
          }),
          { 'content-type': 'application/json' }
        );
      if (url.pathname === '/graph/me/drive/items/doc-evil') {
        return graphFile('doc-evil', 'http://169.254.169.254/latest/meta-data/');
      }
      if (url.pathname === '/graph/me/drive/items/doc-redirect') {
        return graphFile('doc-redirect', `${base}/redirect`);
      }
      if (url.pathname === '/redirect') {
        return send(302, '', { location: 'http://10.0.0.1/internal' });
      }
      if (url.pathname === '/graph/me/drive/items/doc-foreign') {
        return graphFile(
          'doc-foreign',
          `${base.replace('127.0.0.1', 'localhost')}/content/foreign`
        );
      }
      if (url.pathname === '/content/foreign') {
        return send(200, 'The rent is due monthly.', { 'content-type': 'text/plain' });
      }
      if (url.pathname === '/graph/me/drive/items/doc-1') {
        return send(
          200,
          JSON.stringify({
            id: 'doc-1',
            name: 'Lease.txt',
            size: 22,
            file: { mimeType: 'text/plain' },
            lastModifiedDateTime: '2026-10-03T08:00:00Z',
            '@microsoft.graph.downloadUrl': `${base}/content/o365`
          }),
          { 'content-type': 'application/json' }
        );
      }
      if (url.pathname === '/drive/files/doc-2' && url.searchParams.get('alt') === 'media') {
        return send(200, 'The rent is due monthly.', { 'content-type': 'text/plain' });
      }
      if (url.pathname === '/drive/files/doc-2') {
        assert.match(url.searchParams.get('fields'), /modifiedTime/);
        return send(
          200,
          JSON.stringify({
            id: 'doc-2',
            name: 'Lease.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-10-04T09:00:00.000Z'
          }),
          { 'content-type': 'application/json' }
        );
      }
      if (url.pathname === '/drive/files/stall' && url.searchParams.get('alt') === 'media') {
        // Headers and a first chunk, then nothing: a body that never ends.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('The rent ');
        return undefined;
      }
      if (url.pathname === '/drive/files/stall') {
        return send(
          200,
          JSON.stringify({ id: 'stall', name: 'Stall.txt', mimeType: 'text/plain' }),
          {
            'content-type': 'application/json'
          }
        );
      }
      if (url.pathname === '/content/o365') {
        return send(200, 'The rent is due monthly.', { 'content-type': 'text/plain' });
      }
      if (url.pathname.startsWith('/nextcloud/')) {
        return send(200, 'The rent is due monthly.', {
          'content-type': 'text/plain',
          'last-modified': 'Mon, 05 Oct 2026 10:00:00 GMT'
        });
      }
      return send(404, 'not found');
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const tokens = async () => ({ accessToken: 'token', providerId: 'p1', nextcloudUserId: 'ada' });
    const { default: office365, downloadGuard } =
      await import('../services/integrations/Office365Service.js');
    const { default: googleDrive } = await import('../services/integrations/GoogleDriveService.js');
    const { default: nextcloud } = await import('../services/integrations/NextcloudService.js');
    stub(office365, 'graphApiUrl', `${base}/graph`);
    stub(office365, 'getUserTokens', tokens);
    // The test server is on loopback: let it through, the real guard for the rest.
    stub(downloadGuard, 'checkTarget', url =>
      url.hostname === '127.0.0.1' || url.hostname === 'localhost'
        ? { ok: true }
        : assertPublicTarget(url)
    );
    stub(googleDrive, 'driveApiUrl', `${base}/drive`);
    stub(googleDrive, 'getUserTokens', tokens);
    stub(nextcloud, 'getUserTokens', tokens);
    stub(nextcloud, '_getProviderConfig', () => ({ serverUrl: `${base}/nextcloud` }));
  });

  after(async () => {
    while (restore.length) restore.pop()();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  it('report the modification time the source holds now', async () => {
    const cases = [
      ['office365', { providerId: 'p1', fileId: 'doc-1' }, '2026-10-03T08:00:00Z'],
      ['google-drive', { providerId: 'p1', fileId: 'doc-2' }, '2026-10-04T09:00:00.000Z'],
      ['nextcloud', { providerId: 'p1', path: '/Leases/Lease.txt' }, '2026-10-05T10:00:00.000Z']
    ];
    for (const [kindId, ref, lastModified] of cases) {
      const fetched = await getItemKind(kindId).fetch({ ref }, { user: ADA });
      assert.equal(fetched.bytes.toString(), 'The rent is due monthly.', kindId);
      assert.equal(fetched.lastModified, lastModified, kindId);
      assert.equal(fetched.source.lastModified, lastModified, kindId);
    }
  });

  it('accept only one-segment Graph ids, for the kind and the service', async () => {
    const kind = getItemKind('office365');
    for (const fileId of ['doc-1/content', 'doc-1?select=x', '../me', 'doc 1', '']) {
      assert.equal(kind.refSchema.safeParse({ providerId: 'p1', fileId }).success, false, fileId);
    }
    assert.equal(
      kind.refSchema.safeParse({ providerId: 'p1', fileId: 'doc-1', driveId: 'b!x/items' }).success,
      false
    );
    assert.equal(
      kind.refSchema.safeParse({ providerId: 'p1', fileId: 'ABC123!105', driveId: 'b!Xk3-_.' })
        .success,
      true
    );
    const { default: office365 } = await import('../services/integrations/Office365Service.js');
    seen.clear();
    await assert.rejects(
      office365.downloadFile(ADA.id, 'doc-1/content', null, 'p1'),
      /fileId contains invalid characters/
    );
    await assert.rejects(
      office365.downloadFile(ADA.id, 'doc-1', '../drives', 'p1'),
      /driveId contains invalid characters/
    );
    assert.equal(seen.size, 0, 'no request reached Graph');
  });

  it('download only from public addresses, with the token only for Graph', async () => {
    const kind = getItemKind('office365');
    const fetchOf = fileId => kind.fetch({ ref: { providerId: 'p1', fileId } }, { user: ADA });
    // A download URL at an internal address, directly or through a redirect.
    await assert.rejects(fetchOf('doc-evil'), /download URL is not allowed .*private/);
    seen.clear();
    await assert.rejects(fetchOf('doc-redirect'), /download URL is not allowed .*private/);
    assert.ok(seen.has('/redirect'));
    // Outside the Graph origin: downloaded, but without the bearer token.
    seen.clear();
    const foreign = await fetchOf('doc-foreign');
    assert.equal(foreign.bytes.toString(), 'The rent is due monthly.');
    assert.equal(seen.get('/content/foreign'), null);
    assert.equal(seen.get('/graph/me/drive/items/doc-foreign'), 'Bearer token');
    // On the Graph origin the token goes along.
    seen.clear();
    await fetchOf('doc-1');
    assert.equal(seen.get('/content/o365'), 'Bearer token');
  });

  it('abort a download whose body stalls when the signal fires', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('deadline')), 100);
    const started = Date.now();
    try {
      await assert.rejects(
        getItemKind('google-drive').fetch(
          { ref: { providerId: 'p1', fileId: 'stall' } },
          { user: ADA, signal: controller.signal }
        )
      );
    } finally {
      clearTimeout(timer);
    }
    assert.ok(Date.now() - started < 5000);
  });

  it('call a missing cloud connection forbidden, not an extraction failure', async () => {
    const { default: office365 } = await import('../services/integrations/Office365Service.js');
    const tokens = office365.getUserTokens;
    office365.getUserTokens = async () => {
      throw new Error('User not authenticated with microsoft');
    };
    try {
      await assert.rejects(
        getItemKind('office365').fetch(
          { ref: { providerId: 'p1', fileId: 'doc-1' } },
          { user: ADA }
        ),
        error => error.code === 'SOURCE_FORBIDDEN' && error.status === 403
      );
    } finally {
      office365.getUserTokens = tokens;
    }
  });

  it('fail a fetch that outlives its deadline and free its queue slot', async () => {
    const service = getProjectService();
    const ingest = service.ingest;
    let seen = null;
    registerItemKind({
      id: 'fake-stall',
      name: { en: 'Stalling cloud' },
      storage: { ihub: 'text' },
      credentials: 'picking-user',
      picker: { type: 'cloud', provider: 'stall' },
      refSchema: z.object({ fileId: z.string() }).strict(),
      describe: ref => ({ name: `stall-${ref.fileId}` }),
      // Ignores its signal: the deadline must hold anyway.
      fetch: (_item, ctx) => {
        seen = ctx.signal;
        return new Promise(() => {});
      }
    });
    const timeout = ingest.fetchTimeoutMs;
    ingest.fetchTimeoutMs = 100;
    try {
      const project = await service.createUserProject({ owner: ADA, content: { name: 'Stall' } });
      const { item } = await service.addItem(
        project.id,
        { kind: 'fake-stall', ref: { fileId: 'f' } },
        { user: ADA }
      );
      const failed = await settled(project.id, item.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'SOURCE_TIMEOUT');
      assert.equal(seen?.aborted, true);
      await waitFor(() => !ingest.isActive(item.id));
      assert.equal(ingest.running, 0);
    } finally {
      ingest.fetchTimeoutMs = timeout;
    }
  });
});

describe('routes', () => {
  const routes = captureRoutes(registerProjectRoutes);
  const route = {
    create: handlersFor(routes, 'post', '/api/projects'),
    addItem: handlersFor(routes, 'post', '/api/projects/:projectId/items'),
    text: handlersFor(routes, 'get', '/api/projects/:projectId/items/:itemId/text'),
    editText: handlersFor(routes, 'put', '/api/projects/:projectId/items/:itemId/text'),
    refresh: handlersFor(routes, 'post', '/api/projects/:projectId/items/:itemId/refresh'),
    pages: handlersFor(routes, 'get', '/api/projects/pickers/pages'),
    urlCheck: handlersFor(routes, 'post', '/api/projects/pickers/url/check'),
    urlPreview: handlersFor(routes, 'post', '/api/projects/pickers/url/preview'),
    urlCrawl: handlersFor(routes, 'post', '/api/projects/pickers/url/crawl')
  };

  async function create() {
    const res = await drive(route.create, { user: ADA, body: { name: 'Uploads' } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    return res.body;
  }

  it('edits the text of a written item over PUT …/text and refuses an empty one', async () => {
    const project = await create();
    const added = await drive(route.addItem, {
      user: ADA,
      params: { projectId: project.id },
      body: { kind: 'upload', ref: {}, name: 'Notes.md', text: 'Old notes.' }
    });
    assert.equal(added.statusCode, 201, JSON.stringify(added.body));
    const edited = await drive(route.editText, {
      user: ADA,
      params: { projectId: project.id, itemId: added.body.item.id },
      body: { text: 'New notes.' }
    });
    assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.item.status, 'ready');
    assert.equal(edited.body.item.provenance.origin, 'written');
    const read = await drive(route.text, {
      user: ADA,
      params: { projectId: project.id, itemId: added.body.item.id }
    });
    assert.equal(read.body, 'New notes.');
    const empty = await drive(route.editText, {
      user: ADA,
      params: { projectId: project.id, itemId: added.body.item.id },
      body: { text: '  ' }
    });
    assert.equal(empty.statusCode, 400);
    const stranger = await drive(route.editText, {
      user: GRACE,
      params: { projectId: project.id, itemId: added.body.item.id },
      body: { text: 'Not mine.' }
    });
    // A project the caller is no member of does not exist for them.
    assert.equal(stranger.statusCode, 404);
  });

  it('refuses to edit a text longer than an edit may be', async () => {
    const project = await create();
    const added = await drive(route.addItem, {
      user: ADA,
      params: { projectId: project.id },
      body: { kind: 'upload', ref: {}, name: 'Big.md', text: 'Old notes.' }
    });
    assert.equal(added.statusCode, 201, JSON.stringify(added.body));
    // An imported text can be longer than an upload may be.
    await getProjectService().patchItem(project.id, added.body.item.id, item => {
      item.text.chars = 20_000_000;
    });
    const refused = await drive(route.editText, {
      user: ADA,
      params: { projectId: project.id, itemId: added.body.item.id },
      body: { text: 'Cut.' }
    });
    assert.equal(refused.statusCode, 400, JSON.stringify(refused.body));
    const read = await drive(route.text, {
      user: ADA,
      params: { projectId: project.id, itemId: added.body.item.id }
    });
    assert.equal(read.body, 'Old notes.', 'nothing was replaced');
  });

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

  it('keeps the characters of a UTF-8 file name', async () => {
    const project = await create();
    const name = 'Scope – Übersicht für Köln.md';
    const req = multipartRequest({
      name,
      contentType: 'text/markdown',
      bytes: Buffer.from('# Scope\n\nText.')
    });
    req.params = { projectId: project.id };
    const res = await drive(route.addItem, { user: ADA, req });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    // multer reads part headers as latin1 unless told otherwise: "–" came out as "â€\"".
    assert.equal(res.body.item.name, name);
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
    // The preview and the crawl read through the page reader, held to the same line.
    for (const picker of [route.urlPreview, route.urlCrawl]) {
      const badPick = await drive(picker, { user: ADA, body: { url: 'ftp://example.com' } });
      assert.equal(badPick.statusCode, 400);
      const insidePick = await drive(picker, {
        user: ADA,
        body: { url: 'http://127.0.0.1:9/admin' }
      });
      assert.equal(insidePick.statusCode, 200);
      assert.equal(insidePick.body.ok, false);
      assert.match(insidePick.body.error, /private/);
    }
    const tooDeep = await drive(route.urlCrawl, {
      user: ADA,
      body: { url: 'https://example.com/', maxDepth: 9 }
    });
    assert.equal(tooDeep.statusCode, 400);
  });

  it('runs one site crawl per user at a time', async () => {
    const crawl = url => drive(route.urlCrawl, { user: ADA, body: { url } });
    const [first, second] = await Promise.all([
      crawl('http://127.0.0.1:9/a'),
      crawl('http://127.0.0.1:9/b')
    ]);
    assert.match(first.body.error, /private/);
    assert.equal(second.body.ok, false);
    assert.equal(second.body.code, 'CRAWL_RUNNING');
    // The first one finished, so the next may start.
    const third = await crawl('http://127.0.0.1:9/c');
    assert.match(third.body.error, /private/);
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

  /**
   * A loopback server for the URL probe, with the target check that admits it.
   * `handle(req, res)` answers; every request is recorded with its headers.
   */
  async function probeServer(handle) {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      handle(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
      origin: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () =>
        new Promise(resolve => {
          server.closeAllConnections();
          server.close(resolve);
        })
    };
  }
  const loopback = { checkTarget: () => Promise.resolve({ ok: true, addresses: ['127.0.0.1'] }) };

  it('sends the configured probe headers to the original origin only', async () => {
    const other = await probeServer((req, res) => res.end('elsewhere'));
    const home = await probeServer((req, res) => {
      if (req.url === '/away') {
        res.writeHead(302, { location: `${other.origin}/landing` }).end();
      } else if (req.url === '/stay') {
        res.writeHead(302, { location: '/final' }).end();
      } else {
        res.end('home');
      }
    });
    try {
      const headers = { Authorization: 'Bearer s3cret', 'X-Api-Key': 'k' };
      const away = await probeUrl({ url: `${home.origin}/away`, headers }, loopback);
      assert.equal(away.status, 200);
      assert.equal(home.requests[0].headers.authorization, 'Bearer s3cret');
      // Another port is another origin: neither credential follows the redirect.
      assert.equal(other.requests.length, 1);
      assert.equal(other.requests[0].headers.authorization, undefined);
      assert.equal(other.requests[0].headers['x-api-key'], undefined);

      await probeUrl({ url: `${home.origin}/stay`, headers }, loopback);
      const final = home.requests.find(request => request.url === '/final');
      assert.equal(final.headers.authorization, 'Bearer s3cret');
    } finally {
      await home.close();
      await other.close();
    }
  });

  it('closes the unread bodies of a redirect and a failed probe', async () => {
    const closed = new Set();
    const server = await probeServer((req, res) => {
      res.on('close', () => closed.add(req.url));
      if (req.url === '/hang-redirect') {
        // A body that never ends: only the client dropping it closes it.
        res.writeHead(302, { location: '/ok' });
        res.write('moved');
      } else if (req.url === '/hang-error') {
        res.writeHead(500);
        res.write('broken');
      } else {
        res.end('fine');
      }
    });
    try {
      const ok = await probeUrl({ url: `${server.origin}/hang-redirect` }, loopback);
      assert.equal(ok.accessible, true);
      assert.equal(ok.contentLength, 4);
      await waitFor(() => closed.has('/hang-redirect'), { timeoutMs: 2000 });
      await assert.rejects(probeUrl({ url: `${server.origin}/hang-error` }, loopback), /HTTP 500/);
      await waitFor(() => closed.has('/hang-error'), { timeoutMs: 2000 });
    } finally {
      await server.close();
    }
  });
});
