// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/projects/:projectId/items/_import` ("Copy to project"): a chat
 * artifact the caller may read, or an uploaded file, becomes a project
 * document like any upload; a ZIP archive becomes one document per file it
 * holds. The copy does not depend on its chat.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PNG } from 'pngjs';

import configCache from '../configCache.js';
import llmClient from '../services/loop/LLMClient.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import registerProjectRoutes from '../routes/projectRoutes.js';
import errorHandler from '../middleware/errorHandler.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getChatShareRepository } from '../services/chat/ChatShareRepository.js';
import {
  LocalFileKeyProvider,
  _resetKeyProvider,
  registerKeyProvider
} from '../services/projects/crypto/KeyProvider.js';
import { bootstrapProjects, shutdownProjects } from '../services/projects/bootstrap.js';
import { getProjectRepository } from '../services/projects/ProjectRepository.js';
import { readOriginal, readText } from '../services/projects/ItemTextStore.js';
import { evictItemText } from '../services/knowledge/ItemTextService.js';
import { isZipArchive, unpackZip } from '../services/projects/itemImport.js';
import { fetchSourceFile, ingestFromSource } from '../services/chatFiles/fileSources.js';
import { chatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import { getChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import { getProjectService } from '../services/projects/ProjectService.js';

const MASTER = crypto.createHash('sha256').update('item-import-master').digest('hex');
const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', groups: ['authenticated'] };

let scratch;
let platform;

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

const projectRoutes = captureRoutes(registerProjectRoutes);

function handlersFor(method, suffix) {
  const route = projectRoutes.find(
    entry => entry.method === method && entry.routePath.endsWith(suffix)
  );
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
  res.location = value => res.setHeader('Location', value);
  return res;
}

async function drive(handlers, { params = {}, query = {}, body = {}, user } = {}) {
  const req = {
    params,
    query,
    body,
    headers: { 'content-type': 'application/json' },
    is: type => type === 'application/json',
    user: user ? { ...user, groups: [...(user.groups || [])] } : undefined,
    ip: '127.0.0.1',
    method: 'POST',
    url: '/'
  };
  const res = makeResponse();
  for (const handler of handlers) {
    let advanced = false;
    let refusal = null;
    try {
      await handler(req, res, error => {
        if (error) refusal = error;
        else advanced = true;
      });
      if (refusal) throw refusal;
    } catch (error) {
      errorHandler(error, req, res, () => {});
      break;
    }
    if (!advanced) break;
  }
  return res;
}

const route = {
  create: handlersFor('post', '/api/projects'),
  members: handlersFor('put', '/api/projects/:projectId/members'),
  importItems: handlersFor('post', '/api/projects/:projectId/items/_import')
};

async function createProject(user, name = 'Offers') {
  const res = await drive(route.create, { user, body: { name } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body;
}

let chatCounter = 0;

async function seedChat(user) {
  chatCounter += 1;
  const chatId = `import-chat-${chatCounter}`;
  await getChatRepository().ensureChat({
    chatId,
    ownerId: user.id,
    appId: 'analysis',
    title: 'An analysis'
  });
  return chatId;
}

async function seedArtifact(chatId, { kind = 'document', mimeType, name, bytes }) {
  const repository = getChatRepository();
  const stored = await repository.artifactStore().put(repository.artifactScope(chatId), {
    kind,
    mimeType,
    name,
    data: bytes.toString('base64')
  });
  assert.ok(stored?.id, 'the artifact was stored');
  return stored;
}

async function importArtifact(user, projectId, ref) {
  return drive(route.importItems, {
    user,
    params: { projectId },
    body: { source: { kind: 'chat-artifact', ref } }
  });
}

/** Wait until every listed item of the project has been processed. */
async function settled(projectId, itemIds) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const project = await getProjectRepository().get(projectId);
    const items = itemIds.map(id => project.items.find(entry => entry.id === id));
    if (items.every(item => item && ['ready', 'failed'].includes(item.status))) {
      return { project, items };
    }
    if (Date.now() > deadline) throw new Error(`items not settled: ${JSON.stringify(items)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function zipOf(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function setLimits(limits = {}) {
  platform.projects = {
    limits: {
      maxFiles: 25,
      maxFileBytes: 1024 * 1024,
      maxProjectBytes: 10 * 1024 * 1024,
      maxProjectsPerUser: 0,
      ...limits
    },
    sharing: { allowUsers: true, allowGroups: true, allowEveryone: false }
  };
  configCache.setCacheEntry('config/platform.json', platform);
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-item-import-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const users = {};
  for (const user of [ADA, GRACE]) {
    users[user.id] = { ...user, username: user.id.replace('user-', ''), active: true };
  }
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  platform = {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    chats: {
      enabled: true,
      sharing: { enabled: true, allowAuthenticated: true, allowArtifacts: true }
    }
  };
  setLimits();
  configCache.setCacheEntry('config/features.json', {
    projects: true,
    userProjects: true,
    chatPersistence: true,
    chatSharing: true
  });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          inherits: ['anonymous'],
          permissions: { apps: ['*'], projects: true, projectSharing: true }
        },
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: [] } }
      }
    })
  );
  configCache.setCacheEntry('config/apps.json', [
    { id: 'analysis', name: { en: 'Analysis' }, enabled: true }
  ]);
  configCache.setCacheEntry('config/projects.json', []);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  registerKeyProvider(
    'local-file',
    () => new LocalFileKeyProvider({ readMasterKey: () => MASTER, readPreviousKey: () => null })
  );
  _resetKeyProvider();
  await bootstrapProjects({ reconcile: false });
});

beforeEach(() => setLimits());

after(async () => {
  shutdownProjects();
  evictItemText();
  await shutdownStorageBootstrap();
  // Ingest jobs of the last test may still be finishing their writes.
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('POST /api/projects/:projectId/items/_import', () => {
  it('copies an artifact of the caller’s chat; the copy outlives the chat', async () => {
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const markdown = Buffer.from('# Summary\n\nThe analysis found three risks.\n');
    const artifact = await seedArtifact(chatId, {
      mimeType: 'text/markdown',
      name: 'summary.md',
      bytes: markdown
    });

    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.equal(res.headers.location, `/api/projects/${project.id}/items`);
    assert.equal(res.body.items.length, 1);
    assert.deepEqual(res.body.skipped, []);
    const added = res.body.items[0];
    assert.equal(added.kind, 'upload');
    assert.equal(added.name, 'summary.md');
    assert.equal(added.provenance.origin, 'uploaded');
    assert.deepEqual(added.provenance.from, {
      type: 'chat',
      chatId,
      appId: 'analysis',
      artifactId: artifact.id
    });

    await getChatRepository().deleteChat(chatId);

    const { project: stored, items } = await settled(project.id, [added.id]);
    assert.equal(items[0].status, 'ready');
    assert.match(await readText(stored, items[0]), /three risks/);
    assert.deepEqual(await readOriginal(stored, items[0]), markdown);
  });

  it('copies an artifact shared with the caller, and only one the share names', async () => {
    const chatId = await seedChat(ADA);
    const shared = await seedArtifact(chatId, {
      mimeType: 'text/csv',
      name: 'risks.csv',
      bytes: Buffer.from('risk,impact\nlate delivery,high\n')
    });
    const other = await seedArtifact(chatId, {
      mimeType: 'text/markdown',
      name: 'private.md',
      bytes: Buffer.from('# Not shared\n')
    });
    const share = await getChatShareRepository().createShare({
      chatId,
      ownerId: ADA.id,
      identityMode: 'default',
      mode: 'authenticated',
      target: 'artifact',
      artifact: shared
    });
    assert.ok(share?.id);
    const project = await createProject(GRACE, 'Grace’s risks');

    const res = await importArtifact(GRACE, project.id, {
      shareId: share.id,
      artifactId: shared.id
    });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body.items[0].provenance.from, {
      type: 'share',
      shareId: share.id,
      artifactId: shared.id
    });

    const refused = await importArtifact(GRACE, project.id, {
      shareId: share.id,
      artifactId: other.id
    });
    assert.equal(refused.statusCode, 404);
  });

  it('answers 404 for an artifact of a chat the caller cannot read', async () => {
    const chatId = await seedChat(ADA);
    const artifact = await seedArtifact(chatId, {
      mimeType: 'text/markdown',
      name: 'ada.md',
      bytes: Buffer.from('# Ada only\n')
    });
    const project = await createProject(GRACE);
    const res = await importArtifact(GRACE, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  it('needs the edit role on the project', async () => {
    const project = await createProject(ADA);
    const members = await drive(route.members, {
      user: ADA,
      params: { projectId: project.id },
      body: { members: [{ type: 'user', id: GRACE.id, role: 'user' }] }
    });
    assert.equal(members.statusCode, 200, JSON.stringify(members.body));
    const chatId = await seedChat(GRACE);
    const artifact = await seedArtifact(chatId, {
      mimeType: 'text/markdown',
      name: 'g.md',
      bytes: Buffer.from('# G\n')
    });
    const res = await importArtifact(GRACE, project.id, { chatId, artifactId: artifact.id });
    assert.ok([403, 404].includes(res.statusCode), String(res.statusCode));
  });

  it('refuses an image: projects do not take images yet', async () => {
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const artifact = await seedArtifact(chatId, {
      kind: 'image',
      mimeType: 'image/png',
      name: 'chart.png',
      bytes: png
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 415);
    assert.equal(res.body.code, 'UNSUPPORTED_TYPE');
    const stored = await getProjectRepository().get(project.id);
    assert.equal((stored.items || []).length, 0);
  });

  it('unpacks a ZIP archive into one document per supported file', async () => {
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const archive = await zipOf({
      'report.md': '# Report\n\nAll good.\n',
      'notes/todo.txt': 'call the customer\n',
      'data/figures.csv': 'a,b\n1,2\n',
      'chart.png': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
      'inner.zip': await zipOf({ 'x.md': '# x\n' }),
      '__MACOSX/._report.md': 'junk',
      '.DS_Store': 'junk'
    });
    const artifact = await seedArtifact(chatId, {
      kind: 'archive',
      mimeType: 'application/zip',
      name: 'bundle.zip',
      bytes: archive
    });

    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body.items.map(item => item.name).sort(), [
      'data/figures.csv',
      'notes/todo.txt',
      'report.md'
    ]);
    assert.deepEqual(res.body.skipped.map(entry => [entry.name, entry.code]).sort(), [
      ['chart.png', 'UNSUPPORTED_TYPE'],
      ['inner.zip', 'UNSUPPORTED_TYPE']
    ]);
    for (const item of res.body.items) {
      assert.equal(item.provenance.from.archive, 'bundle.zip');
      assert.equal(item.provenance.from.chatId, chatId);
    }
    const { project: stored, items } = await settled(
      project.id,
      res.body.items.map(item => item.id)
    );
    assert.ok(items.every(item => item.status === 'ready'));
    const todo = items.find(item => item.name === 'notes/todo.txt');
    assert.match(await readText(stored, todo), /call the customer/);
  });

  it('refuses an archive with nothing a project takes, listing what it skipped', async () => {
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const archive = await zipOf({ 'a.png': Buffer.from('89504e470d0a1a0a', 'hex') });
    const artifact = await seedArtifact(chatId, {
      kind: 'archive',
      mimeType: 'application/zip',
      name: 'images.zip',
      bytes: archive
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 415);
    assert.equal(res.body.code, 'UNSUPPORTED_TYPE');
    assert.equal(res.body.details.skipped[0].name, 'a.png');
  });

  it('stops an entry at the file limit, whatever the archive declares', async () => {
    setLimits({ maxFileBytes: 4096 });
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const archive = await zipOf({
      'bomb.txt': 'a'.repeat(5 * 1024 * 1024),
      'small.md': '# small\n'
    });
    assert.ok(archive.length < 64 * 1024, 'the archive itself is small');
    const artifact = await seedArtifact(chatId, {
      kind: 'archive',
      mimeType: 'application/zip',
      name: 'bomb.zip',
      bytes: archive
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.items.map(item => item.name),
      ['small.md']
    );
    assert.deepEqual(res.body.skipped, [
      {
        name: 'bomb.txt',
        code: 'QUOTA_FILE_BYTES',
        message: 'The file is larger than a project document may be'
      }
    ]);
  });

  it('adds only as many files as the project has room for', async () => {
    setLimits({ maxFiles: 2 });
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const archive = await zipOf({ 'a.md': '# a\n', 'b.md': '# b\n', 'c.md': '# c\n' });
    const artifact = await seedArtifact(chatId, {
      kind: 'archive',
      mimeType: 'application/zip',
      name: 'three.zip',
      bytes: archive
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.skipped.length, 1);
    assert.equal(res.body.skipped[0].code, 'QUOTA_FILES');
  });

  it('does not spend the last document slot on an entry it refuses', async () => {
    setLimits({ maxFiles: 1 });
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const archive = await zipOf({
      // Sorted first: a picture under a text name, refused by its bytes.
      'a-bad.txt': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
      'b-good.txt': 'the good one\n'
    });
    const artifact = await seedArtifact(chatId, {
      kind: 'archive',
      mimeType: 'application/zip',
      name: 'one-slot.zip',
      bytes: archive
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.items.map(item => item.name),
      ['b-good.txt']
    );
    assert.deepEqual(
      res.body.skipped.map(entry => [entry.name, entry.code]),
      [['a-bad.txt', 'UNSUPPORTED_TYPE']]
    );
  });

  it('skips an entry whose bytes do not match its checksum', async () => {
    const project = await createProject(ADA);
    const chatId = await seedChat(ADA);
    const archive = await zipOf({ 'intact.md': '# intact\n', 'tampered.md': '# original text\n' });
    // Uncompressed entries (STORE) keep their text verbatim in the archive.
    const stored = await new JSZip()
      .file('intact.md', '# intact\n')
      .file('tampered.md', '# original text\n')
      .generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const at = stored.indexOf(Buffer.from('original'));
    assert.ok(at > 0 && archive.length > 0);
    stored.write('ORIGINAL', at, 'latin1');
    const artifact = await seedArtifact(chatId, {
      kind: 'archive',
      mimeType: 'application/zip',
      name: 'tampered.zip',
      bytes: stored
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.items.map(item => item.name),
      ['intact.md']
    );
    assert.equal(res.body.skipped[0].name, 'tampered.md');
    assert.match(res.body.skipped[0].message, /checksum/);
  });

  it('refuses a request that names no file and no artifact', async () => {
    const project = await createProject(ADA);
    const res = await drive(route.importItems, {
      user: ADA,
      params: { projectId: project.id },
      body: { source: { kind: 'nextcloud', ref: {} } }
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('with text recognition (#3986)', () => {
  const originalComplete = llmClient.complete;
  let calls;
  before(() => {
    configCache.setCacheEntry('config/models.json', [
      {
        id: 'ocr-vision',
        modelId: 'ocr-vision',
        name: { en: 'OCR' },
        provider: 'local',
        url: 'http://localhost:9/v1/chat/completions',
        supportsImages: true,
        enabled: true
      }
    ]);
  });
  beforeEach(() => {
    calls = 0;
    llmClient.complete = async () => {
      calls += 1;
      return { content: 'Whiteboard: next steps for the ACME offer.' };
    };
    platform.ocr = { modelId: 'ocr-vision', maxPages: 10 };
    configCache.setCacheEntry('config/platform.json', platform);
  });
  after(() => {
    llmClient.complete = originalComplete;
    delete platform.ocr;
    configCache.setCacheEntry('config/platform.json', platform);
  });

  const picture = () => {
    const image = new PNG({ width: 20, height: 10 });
    image.data.fill(90);
    return PNG.sync.write(image);
  };

  it('copies an image into a project, with its recognized text', async () => {
    const project = await createProject(ADA, 'Whiteboards');
    const chatId = await seedChat(ADA);
    const bytes = picture();
    const artifact = await seedArtifact(chatId, {
      kind: 'image',
      mimeType: 'image/png',
      name: 'whiteboard.png',
      bytes
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    const { project: stored, items } = await settled(project.id, [res.body.items[0].id]);
    assert.equal(items[0].status, 'ready', JSON.stringify(items[0].error));
    assert.equal(calls, 1);
    assert.match(await readText(stored, items[0]), /ACME offer/);
    assert.deepEqual(await readOriginal(stored, items[0]), bytes);
    assert.equal(items[0].text.recognized.modelId, 'ocr-vision');
  });

  it('unpacks the images of a ZIP archive too', async () => {
    const project = await createProject(ADA, 'Scans');
    const chatId = await seedChat(ADA);
    const archive = await zipOf({
      'notes.md': '# Notes\n',
      'photo.png': picture(),
      'clip.mp4': 'x'
    });
    const artifact = await seedArtifact(chatId, {
      kind: 'archive',
      mimeType: 'application/zip',
      name: 'scans.zip',
      bytes: archive
    });
    const res = await importArtifact(ADA, project.id, { chatId, artifactId: artifact.id });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body.items.map(item => item.name).sort(), ['notes.md', 'photo.png']);
    assert.deepEqual(
      res.body.skipped.map(entry => entry.name),
      ['clip.mp4']
    );
  });
});

describe('isZipArchive', () => {
  it('unpacks a .zip, never an Office or OpenDocument package', async () => {
    const bytes = await zipOf({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w/>' });
    assert.equal(isZipArchive({ name: 'bundle.zip', bytes }), true);
    assert.equal(isZipArchive({ name: 'bundle', contentType: 'application/zip', bytes }), true);
    assert.equal(
      isZipArchive({ name: 'offer.docx', contentType: 'application/zip', bytes }),
      false
    );
    assert.equal(isZipArchive({ name: 'sheet.ods', bytes }), false);
    assert.equal(isZipArchive({ name: 'fake.zip', bytes: Buffer.from('not a zip at all') }), false);
  });
});

describe('Use in app: copying into a chat as a file', () => {
  /** Copy `source` into a new chat of `user`, as `POST /api/chats/:chatId/files` does. */
  async function useInApp(user, source) {
    chatCounter += 1;
    const scope = { type: 'chat', id: `use-in-app-${chatCounter}` };
    const file = await ingestFromSource({
      source,
      user,
      scope,
      ownerId: user.id,
      policy: chatFilePolicy(),
      store: getChatFileRepository()
    });
    return { scope, file };
  }

  async function uploadTo(projectId, user, name, bytes, extra = {}) {
    const { item } = await getProjectService().addItem(
      projectId,
      {
        kind: 'upload',
        ref: {},
        file: { buffer: bytes, name, contentType: 'text/markdown' },
        ...extra
      },
      { user, wait: true }
    );
    return item;
  }

  it('copies an artifact of the caller’s chat; the copy outlives the chat', async () => {
    const chatId = await seedChat(ADA);
    const bytes = Buffer.from('# Findings\n\nThe supplier is late.\n');
    const artifact = await seedArtifact(chatId, {
      mimeType: 'text/markdown',
      name: 'findings.md',
      bytes
    });

    const { scope, file } = await useInApp(ADA, {
      kind: 'chat-artifact',
      ref: { chatId, artifactId: artifact.id }
    });
    assert.equal(file.name, 'findings.md');
    assert.equal(file.origin, 'connector');
    assert.equal(file.hasOriginal, true);
    assert.equal(file.source.kind, 'chat-artifact');
    assert.deepEqual(file.source.ref, { chatId, artifactId: artifact.id });
    assert.equal(file.source.refreshOnRun, undefined);

    await getChatRepository().deleteChat(chatId);

    const original = await getChatFileRepository().getOriginal(scope, file.id);
    assert.deepEqual(original.data, bytes);
    const text = await getChatFileRepository().getText(scope, file.id);
    assert.match(text.text, /supplier is late/);
  });

  it('refuses an artifact of a chat the caller cannot read', async () => {
    const chatId = await seedChat(ADA);
    const artifact = await seedArtifact(chatId, {
      mimeType: 'text/markdown',
      name: 'secret.md',
      bytes: Buffer.from('# Secret\n')
    });
    await assert.rejects(
      fetchSourceFile({
        source: { kind: 'chat-artifact', ref: { chatId, artifactId: artifact.id } },
        user: GRACE
      }),
      error => error.code === 'SOURCE_GONE' && error.status === 404
    );
  });

  it('copies an artifact shared with the caller without recording the owner’s chat', async () => {
    const chatId = await seedChat(ADA);
    const artifact = await seedArtifact(chatId, {
      mimeType: 'text/csv',
      name: 'prices.csv',
      bytes: Buffer.from('item,price\nbolt,1\n')
    });
    const share = await getChatShareRepository().createShare({
      chatId,
      ownerId: ADA.id,
      identityMode: 'default',
      mode: 'authenticated',
      target: 'artifact',
      artifact
    });
    const { file } = await useInApp(GRACE, {
      kind: 'chat-artifact',
      ref: { shareId: share.id, artifactId: artifact.id }
    });
    assert.equal(file.name, 'prices.csv');
    assert.deepEqual(file.source.ref, { shareId: share.id, artifactId: artifact.id });
  });

  it('refuses an image: chats take documents as files', async () => {
    const chatId = await seedChat(ADA);
    const artifact = await seedArtifact(chatId, {
      kind: 'image',
      mimeType: 'image/png',
      name: 'chart.png',
      bytes: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    });
    await assert.rejects(
      useInApp(ADA, { kind: 'chat-artifact', ref: { chatId, artifactId: artifact.id } }),
      error => error.code === 'UNSUPPORTED_TYPE'
    );
  });

  it('hands over a project document as its original', async () => {
    const project = await createProject(ADA, 'Templates');
    const bytes = Buffer.from('# Offer template\n\nDear {{customer}},\n');
    const item = await uploadTo(project.id, ADA, 'offer-template.md', bytes);

    const { scope, file } = await useInApp(ADA, {
      kind: 'project-item',
      ref: { projectId: project.id, itemId: item.id }
    });
    assert.equal(file.name, 'offer-template.md');
    assert.deepEqual(file.source.ref, { projectId: project.id, itemId: item.id });
    const original = await getChatFileRepository().getOriginal(scope, file.id);
    assert.deepEqual(original.data, bytes);
  });

  it('hands over the text as Markdown when the project kept no original', async () => {
    platform.uploads = { storageMode: 'server_text_only' };
    configCache.setCacheEntry('config/platform.json', platform);
    try {
      const project = await createProject(ADA, 'Text only');
      const item = await uploadTo(project.id, ADA, 'notes.txt', Buffer.from('plain notes'));
      const fetched = await fetchSourceFile({
        source: { kind: 'project-item', ref: { projectId: project.id, itemId: item.id } },
        user: ADA
      });
      assert.equal(fetched.name, 'notes.md');
      assert.equal(fetched.contentType, 'text/markdown');
      assert.match(fetched.bytes.toString('utf8'), /plain notes/);
    } finally {
      delete platform.uploads;
      configCache.setCacheEntry('config/platform.json', platform);
    }
  });

  it('refuses a project document while projects are switched off', async () => {
    const project = await createProject(ADA, 'Switched off');
    const item = await uploadTo(project.id, ADA, 'off.md', Buffer.from('# Off\n'));
    const features = configCache.getFeatures();
    configCache.setCacheEntry('config/features.json', { ...features, projects: false });
    try {
      await assert.rejects(
        fetchSourceFile({
          source: { kind: 'project-item', ref: { projectId: project.id, itemId: item.id } },
          user: ADA
        }),
        error => error.code === 'SOURCE_FORBIDDEN' && error.status === 403
      );
    } finally {
      configCache.setCacheEntry('config/features.json', features);
    }
  });

  it('refuses a document marked Not for AI, and a project the caller cannot use', async () => {
    const project = await createProject(ADA, 'Mixed');
    const hidden = await uploadTo(project.id, ADA, 'hr.md', Buffer.from('# HR\n'), {
      excludedFromAi: true
    });
    const open = await uploadTo(project.id, ADA, 'open.md', Buffer.from('# Open\n'));
    await assert.rejects(
      fetchSourceFile({
        source: { kind: 'project-item', ref: { projectId: project.id, itemId: hidden.id } },
        user: ADA
      }),
      error => error.code === 'SOURCE_FORBIDDEN' && error.status === 403
    );
    await assert.rejects(
      fetchSourceFile({
        source: { kind: 'project-item', ref: { projectId: project.id, itemId: open.id } },
        user: GRACE
      }),
      error => error.code === 'SOURCE_GONE' && error.status === 404
    );
  });
});

describe('unpackZip', () => {
  it('unpacks with every limit switched off', async () => {
    const bytes = await zipOf({ 'a.md': '# a\n', 'b.txt': 'b' });
    const seen = [];
    const { skipped } = await unpackZip(
      bytes,
      { maxFiles: Infinity, maxFileBytes: Infinity, maxTotalBytes: Infinity },
      async file => {
        seen.push([file.name, file.bytes.toString('utf8')]);
        return true;
      }
    );
    assert.deepEqual(skipped, []);
    assert.deepEqual(seen.sort(), [
      ['a.md', '# a\n'],
      ['b.txt', 'b']
    ]);
  });
});
