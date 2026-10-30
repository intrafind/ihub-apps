// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * More generated file types and ZIP archives (#3055): the `files` system
 * skill's `create_file` and `create_zip`, the `code` and `archive` artifact
 * kinds, the type a text file is served as, path normalization inside an
 * archive, and the archive limits.
 *
 * Run: node --test server/tests/generated-files-zip.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';

import configCache from '../configCache.js';
import {
  GENERATED_FILE_MEDIA_TYPES,
  generatedFileKind,
  generatedFilesFromArtifacts,
  textFileMediaType
} from '../../shared/generatedFiles.js';
import {
  artifactKind,
  artifactMediaType,
  artifactSettings,
  servedMediaType
} from '../services/artifacts/artifactPolicy.js';
import {
  ZipLimitError,
  planZipEntries,
  uniqueArchivePath,
  writeZip,
  zipToBuffer
} from '../services/artifacts/artifactZip.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile,
  heldGeneratedFilesFor,
  safeArchivePath
} from '../services/documents/generatedFiles.js';
import {
  createFileMediaType,
  runCreateFile,
  runCreateZip,
  selectChatFiles
} from '../services/documents/files/fileTools.js';
import { isSystemSkillTool, systemSkillToolsFor } from '../services/systemSkillTools.js';
import { getSkillContent } from '../services/skillLoader.js';

const USER = { id: 'user-zip' };
const CHAT = 'chat-zip-1';

async function unzip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const files = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async('string');
  }
  return files;
}

describe('file types', () => {
  it('records a text file under the type its extension names', () => {
    assert.equal(textFileMediaType('src/index.ts'), 'application/typescript');
    assert.equal(textFileMediaType('app.PY'), 'text/x-python');
    assert.equal(textFileMediaType('data.json'), 'application/json');
    assert.equal(textFileMediaType('config.yml'), 'application/yaml');
    assert.equal(textFileMediaType('Dockerfile'), 'text/plain');
    // Never something a browser runs or renders as a page.
    assert.equal(textFileMediaType('page.html'), 'text/plain');
    assert.equal(textFileMediaType('logo.svg'), 'text/plain');
    assert.equal(textFileMediaType('constructor'), 'text/plain');
  });

  it('files each generated type under its artifact kind', () => {
    assert.equal(generatedFileKind('application/zip'), 'archive');
    assert.equal(generatedFileKind('text/javascript'), 'code');
    assert.equal(generatedFileKind('application/pdf'), 'document');
    for (const type of GENERATED_FILE_MEDIA_TYPES) {
      const kind = generatedFileKind(type);
      assert.equal(artifactKind(kind), kind, `${type} has a known kind`);
      assert.equal(artifactMediaType(kind, type), type, `${type} is allowlisted for ${kind}`);
    }
  });

  it('keeps html and svg out of every kind', () => {
    for (const kind of ['document', 'code', 'archive', 'image']) {
      assert.equal(artifactMediaType(kind, 'text/html'), 'application/octet-stream');
      assert.equal(artifactMediaType(kind, 'image/svg+xml'), 'application/octet-stream');
    }
  });

  it('serves a source file as plain text', () => {
    assert.equal(servedMediaType('text/javascript'), 'text/plain; charset=utf-8');
    assert.equal(servedMediaType('text/css'), 'text/plain; charset=utf-8');
    assert.equal(servedMediaType('application/xml'), 'text/plain; charset=utf-8');
    assert.equal(servedMediaType('application/json'), 'application/json; charset=utf-8');
    assert.equal(servedMediaType('text/markdown'), 'text/markdown; charset=utf-8');
    assert.equal(servedMediaType('application/zip'), 'application/zip');
    assert.equal(servedMediaType('image/png'), 'image/png');
  });

  it('draws download cards for code and archive artifacts', () => {
    const cards = generatedFilesFromArtifacts([
      { id: 'a'.repeat(32), kind: 'code', mimeType: 'text/x-python', name: 'app.py', bytes: 3 },
      { id: 'b'.repeat(32), kind: 'archive', mimeType: 'application/zip', name: 'p.zip' },
      { id: 'c'.repeat(32), kind: 'image', mimeType: 'image/png' }
    ]);
    assert.deepEqual(
      cards.map(card => card.name),
      ['app.py', 'p.zip']
    );
  });

  it('takes a declared type only when the extension does not tell', () => {
    assert.equal(createFileMediaType('run', 'text/x-python'), 'text/x-python');
    assert.equal(createFileMediaType('run.js', 'text/x-python'), 'text/javascript');
    assert.equal(createFileMediaType('run', 'text/html'), 'text/plain');
  });
});

describe('paths inside an archive', () => {
  it('cannot climb out, start at a root or name a drive', () => {
    assert.equal(safeArchivePath('../../etc/passwd'), 'etc/passwd');
    assert.equal(safeArchivePath('/abs/path.txt'), 'abs/path.txt');
    assert.equal(safeArchivePath('src\\win\\file.cs'), 'src/win/file.cs');
    assert.equal(safeArchivePath('C:/x.txt'), 'C/x.txt');
    assert.equal(safeArchivePath('a/./b/../c.py'), 'a/b/c.py');
    assert.equal(safeArchivePath('.gitignore'), '.gitignore');
    assert.equal(safeArchivePath('..'), '');
    assert.equal(safeArchivePath('bad\u0000name.txt'), 'bad name.txt');
    assert.equal(safeArchivePath(42), '');
  });

  it('is bounded in depth and length', () => {
    const deep = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/') + '/f.txt';
    assert.ok(safeArchivePath(deep).split('/').length <= 10);
    assert.ok(safeArchivePath(`${'x'.repeat(150)}/${'y'.repeat(150)}.txt`).length <= 200);
  });

  it('de-duplicates names, case-insensitively, keeping the extension', () => {
    const used = new Set();
    assert.equal(uniqueArchivePath('a.md', used), 'a.md');
    assert.equal(uniqueArchivePath('A.md', used), 'A (2).md');
    assert.equal(uniqueArchivePath('a.md', used), 'a (3).md');
    assert.equal(uniqueArchivePath('Makefile', used), 'Makefile');
    assert.equal(uniqueArchivePath('Makefile', used), 'Makefile (2)');
  });

  it('plans paths and refuses what is over the limits', () => {
    const planned = planZipEntries(
      [{ name: 'src' }, { name: 'src/a.js' }, { name: '' }, { name: 'src/a.js' }],
      { maxFiles: 10, maxBytes: 100, fallbackName: (_, i) => `fallback-${i}.txt` }
    );
    assert.deepEqual(
      planned.map(entry => entry.path),
      ['src (2)', 'src/a.js', 'fallback-2.txt', 'src/a (2).js']
    );
    assert.throws(
      () => planZipEntries([{ name: 'a' }, { name: 'b' }], { maxFiles: 1, maxBytes: 0 }),
      error => error instanceof ZipLimitError && error.code === 'too-many-files'
    );
    assert.throws(
      () => planZipEntries([{ name: 'a', bytes: 11 }], { maxFiles: 0, maxBytes: 10 }),
      error => error instanceof ZipLimitError && error.code === 'too-large'
    );
    assert.throws(
      () => planZipEntries([], { maxFiles: 0, maxBytes: 0 }),
      error => error.code === 'empty'
    );
    // Zero or less removes a cap.
    assert.equal(
      planZipEntries([{ name: 'a', bytes: 1e9 }], { maxFiles: 0, maxBytes: 0 }).length,
      1
    );
  });

  it('writes an archive that unpacks to the planned paths', async () => {
    const buffer = await zipToBuffer([
      { path: 'src/index.js', data: Buffer.from('console.log(1);\n') },
      { path: 'README.md', data: Buffer.from('# Hi\n') }
    ]);
    assert.deepEqual(await unzip(buffer), {
      'src/index.js': 'console.log(1);\n',
      'README.md': '# Hi\n'
    });
  });
});

describe('a download closed midway', () => {
  it('aborts the archive instead of waiting for a reader that is gone', async () => {
    // Incompressible and larger than the stream buffers, so the archive
    // blocks on backpressure once nobody reads.
    const output = new PassThrough({ highWaterMark: 1024 });
    const writing = writeZip([{ path: 'big.bin', data: randomBytes(4 * 1024 * 1024) }], output);
    setImmediate(() => output.destroy());
    await assert.rejects(
      writing,
      error => error instanceof ZipLimitError && error.code === 'closed'
    );
  });
});

describe('the archive limits are configurable', () => {
  it('reads them from platform.artifacts, with defaults', () => {
    const defaults = artifactSettings({});
    assert.equal(defaults.maxZipFiles, 200);
    assert.equal(defaults.maxZipBytes, 100 * 1024 * 1024);
    const set = artifactSettings({ artifacts: { maxZipFiles: 0, maxZipBytes: 5 } });
    assert.equal(set.maxZipFiles, 0);
    assert.equal(set.maxZipBytes, 5);
  });
});

describe('the files system skill', () => {
  it('brings create_file and create_zip', async () => {
    assert.ok(isSystemSkillTool('create_file'));
    assert.ok(isSystemSkillTool('create_zip'));
    const skill = await getSkillContent('files');
    assert.ok(skill?.isSystem, 'files is a system skill');
    const tools = systemSkillToolsFor(
      [{ name: 'files', isSystem: true, providedTools: ['create_file', 'create_zip'] }],
      { language: 'de' }
    );
    assert.deepEqual(
      tools.map(tool => tool.id),
      ['create_file', 'create_zip']
    );
    assert.equal(tools[0].name, 'Datei erstellen');
    assert.ok(tools.every(tool => tool.isSystemSkillTool));
  });
});

describe('create_file', () => {
  beforeEach(() => clearHeldGeneratedFiles());

  it('holds the file under its path and type, without the content in the result', async () => {
    const result = await runCreateFile({
      user: USER,
      chatId: CHAT,
      name: '../src/main.py',
      content: 'print("hi")\n'
    });
    assert.equal(result.success, true);
    assert.equal(result.file.name, 'src/main.py');
    assert.equal(result.file.mimeType, 'text/x-python');
    assert.equal(result.file.bytes, 12);
    assert.deepEqual(result.files, [result.file]);
    assert.equal(JSON.stringify(result).includes('print('), false);
    const held = heldGeneratedFile(USER, result.file.id, { chatId: CHAT });
    assert.equal(held.data.toString('utf8'), 'print("hi")\n');
  });

  it('refuses a file without a name or content', async () => {
    assert.equal((await runCreateFile({ user: USER, name: '..', content: 'x' })).success, false);
    const empty = await runCreateFile({ user: USER, name: 'a.txt', content: '' });
    assert.equal(empty.success, false);
    assert.equal(empty.code, 'invalid');
  });
});

describe('create_zip', () => {
  let platform;
  beforeEach(() => {
    clearHeldGeneratedFiles();
    platform = configCache.getPlatform?.();
  });
  afterEach(() => {
    configCache.setCacheEntry('config/platform.json', platform || {});
  });

  it('packs new files with their folders', async () => {
    const result = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'todo-app',
      files: [
        { name: 'src/index.ts', content: 'export {};\n' },
        { name: '../../escape.txt', content: 'inside\n' }
      ]
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.file.name, 'todo-app.zip');
    assert.equal(result.file.mimeType, 'application/zip');
    assert.deepEqual(result.entries, ['src/index.ts', 'escape.txt']);
    const held = heldGeneratedFile(USER, result.file.id, { chatId: CHAT });
    assert.deepEqual(await unzip(held.data), {
      'src/index.ts': 'export {};\n',
      'escape.txt': 'inside\n'
    });
  });

  it('packs files created earlier in the chat, by name, id or all at once', async () => {
    const a = await runCreateFile({ user: USER, chatId: CHAT, name: 'src/a.js', content: '1' });
    await runCreateFile({ user: USER, chatId: CHAT, name: 'b.md', content: '2' });
    // Another user's and another chat's files are never packed.
    await runCreateFile({ user: { id: 'other' }, chatId: CHAT, name: 'x.txt', content: 'no' });
    await runCreateFile({ user: USER, chatId: 'chat-other', name: 'y.txt', content: 'no' });

    const byName = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'one',
      include: ['a.js']
    });
    assert.deepEqual(byName.entries, ['src/a.js']);

    const byId = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'id',
      include: [a.file.id]
    });
    assert.deepEqual(byId.entries, ['src/a.js']);

    const all = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'all',
      includeAll: true,
      files: [{ name: 'b.md', content: 'replaced' }]
    });
    assert.equal(all.success, true, all.error);
    const held = heldGeneratedFile(USER, all.file.id, { chatId: CHAT });
    // The earlier archives are not packed again; a new file replaces an old one.
    assert.deepEqual(await unzip(held.data), { 'src/a.js': '1', 'b.md': 'replaced' });
    assert.equal(heldGeneratedFilesFor(USER, { chatId: CHAT }).length, 5);
  });

  it('names what it could not find', async () => {
    await runCreateFile({ user: USER, chatId: CHAT, name: 'real.txt', content: 'x' });
    const result = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'x',
      include: ['missing.txt']
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'not-found');
    assert.match(result.error, /"missing\.txt"/);
    assert.match(result.error, /"real\.txt"/);
  });

  it('keeps to the configured limits', async () => {
    configCache.setCacheEntry('config/platform.json', {
      ...(platform || {}),
      artifacts: { maxZipFiles: 1, maxZipBytes: 0 }
    });
    const result = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'x',
      files: [
        { name: 'a.txt', content: 'a' },
        { name: 'b.txt', content: 'b' }
      ]
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'too-many-files');
  });

  it('refuses an archive the chat could not keep', async () => {
    configCache.setCacheEntry('config/platform.json', {
      ...(platform || {}),
      artifacts: { maxBytes: 1024 }
    });
    const result = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'big',
      files: [{ name: 'noise.txt', content: randomBytes(4096).toString('base64') }]
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'too-large');
    assert.match(result.error, /split them/);
  });

  it('refuses an empty archive and a malformed file', async () => {
    const empty = await runCreateZip({ user: USER, chatId: CHAT, filename: 'x' });
    assert.equal(empty.success, false);
    assert.equal(empty.code, 'empty');
    const bad = await runCreateZip({
      user: USER,
      chatId: CHAT,
      filename: 'x',
      files: [{ name: 'a' }]
    });
    assert.equal(bad.success, false);
    assert.equal(bad.code, 'invalid');
  });

  it('selects the newest of the same path', () => {
    const selected = selectChatFiles(
      [
        { id: '2', name: 'a.txt', kind: 'code', createdAt: '2026-02-01' },
        { id: '1', name: 'a.txt', kind: 'code', createdAt: '2026-01-01' },
        { id: '3', name: 'pic.png', kind: 'image', createdAt: '2026-01-01' }
      ],
      [],
      true
    );
    assert.deepEqual(
      selected.map(file => file.id),
      ['2']
    );
  });
});
