// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Hardened extraction of update archives (server/update/archive.js): what a
 * release looks like is extracted, everything that could write outside the
 * staging directory or exhaust the disk is rejected before it is written.
 *
 * Run: node --test server/tests/update-archive.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ZipArchive } from 'archiver';
import {
  ArchiveRejectedError,
  decodeBase64File,
  extractArchive,
  normalizeEntryName
} from '../update/archive.js';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-update-archive-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const extractAll = () => 'extract';

/** One ustar header + data, padded. */
function tarEntry({ name, type = '0', data = Buffer.alloc(0), mode = 0o644, linkname = '' }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

function writeTarGz(name, entries, { end = true } = {}) {
  const parts = entries.map(tarEntry);
  if (end) parts.push(Buffer.alloc(1024));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
  return file;
}

async function writeZip(name, build) {
  const file = path.join(tmp, name);
  const archive = new ZipArchive();
  const out = fs.createWriteStream(file);
  const done = new Promise((resolve, reject) => {
    out.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(out);
  build(archive);
  await archive.finalize();
  await done;
  return file;
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ArchiveRejectedError, `expected ArchiveRejectedError, got ${error}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

describe('normalizeEntryName', () => {
  it('drops the ./ prefix `tar -czf … .` writes', () => {
    assert.equal(normalizeEntryName('./server/server.js'), 'server/server.js');
    assert.equal(normalizeEntryName('./'), '');
    assert.equal(normalizeEntryName('server/'), 'server');
  });

  it('rejects names that leave the archive root', () => {
    for (const name of ['../x', 'server/../../x', '/etc/passwd', 'C:/Windows/x', 'c:x']) {
      assert.throws(() => normalizeEntryName(name), ArchiveRejectedError, name);
    }
  });

  it('rejects backslashes in tar names and treats them as separators in zips', () => {
    assert.throws(() => normalizeEntryName('server\\x.js'), ArchiveRejectedError);
    assert.equal(normalizeEntryName('server\\x.js', { backslashIsSeparator: true }), 'server/x.js');
    assert.throws(
      () => normalizeEntryName('..\\..\\x', { backslashIsSeparator: true }),
      ArchiveRejectedError
    );
  });

  it('rejects NUL and NTFS alternate data streams', () => {
    assert.throws(() => normalizeEntryName('a\0b'), ArchiveRejectedError);
    assert.throws(() => normalizeEntryName('server/x.js:stream'), ArchiveRejectedError);
  });
});

describe('extractArchive (tar.gz)', () => {
  it('extracts a release packed like the workflow packs it (system tar, ./ prefix)', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(path.join(src, 'server', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(src, 'public'), { recursive: true });
    fs.writeFileSync(path.join(src, 'server', 'lib', 'a.js'), 'a');
    fs.writeFileSync(path.join(src, 'public', 'index.html'), '<html>');
    fs.writeFileSync(path.join(src, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    const archive = path.join(tmp, 'release.tar.gz');
    execFileSync('tar', ['-czf', archive, '.'], { cwd: src });

    const dest = path.join(tmp, 'out-release');
    const result = await extractArchive(archive, dest, {
      format: 'tar.gz',
      classifyTopLevel: extractAll
    });
    assert.deepEqual([...result.files.keys()].sort(), [
      'node',
      'public/index.html',
      'server/lib/a.js'
    ]);
    assert.equal(fs.readFileSync(path.join(dest, 'server', 'lib', 'a.js'), 'utf8'), 'a');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dest, 'node')).mode & 0o777, 0o755);
      assert.equal(fs.statSync(path.join(dest, 'public', 'index.html')).mode & 0o777, 0o644);
    }
    assert.equal(
      result.files.get('server/lib/a.js').sha256,
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
    );
  });

  const cases = [
    [
      'a symbolic link',
      [{ name: 'server/link', type: '2', linkname: '/etc/passwd' }],
      /symbolic link/
    ],
    ['a hard link', [{ name: 'server/link', type: '1', linkname: 'server/a' }], /hard link/],
    ['a device', [{ name: 'server/dev', type: '3' }], /not a file or directory/],
    ['a FIFO', [{ name: 'server/fifo', type: '6' }], /not a file or directory/],
    [
      'a path outside the root',
      [{ name: './../evil.js', data: Buffer.from('x') }],
      /outside its root/
    ],
    ['an absolute path', [{ name: '/tmp/evil.js', data: Buffer.from('x') }], /absolute path/],
    [
      'a duplicate entry',
      [
        { name: 'server/a.js', data: Buffer.from('1') },
        { name: 'server/a.js', data: Buffer.from('2') }
      ],
      /duplicate/
    ],
    [
      'names that differ only by case',
      [
        { name: 'server/A.js', data: Buffer.from('1') },
        { name: 'server/a.js', data: Buffer.from('2') }
      ],
      /case-colliding/
    ]
  ];
  for (const [label, entries, pattern] of cases) {
    it(`rejects ${label}`, async () => {
      const file = writeTarGz(`${label.replace(/\W+/g, '-')}.tar.gz`, entries);
      const dest = path.join(tmp, `out-${label.replace(/\W+/g, '-')}`);
      await rejects(
        extractArchive(file, dest, { format: 'tar.gz', classifyTopLevel: extractAll }),
        pattern
      );
      assert.equal(fs.existsSync(dest), false, 'the staging directory is removed again');
      assert.equal(fs.existsSync(path.join(tmp, 'evil.js')), false);
    });
  }

  it('rejects unexpected top-level entries and skips ignored ones', async () => {
    const file = writeTarGz('toplevel.tar.gz', [
      { name: 'server/a.js', data: Buffer.from('a') },
      { name: 'config.env', data: Buffer.from('SECRET=1') },
      { name: 'contents/config/platform.json', data: Buffer.from('{}') }
    ]);
    const classify = name =>
      name === 'server' ? 'extract' : name === 'config.env' ? 'ignore' : 'reject';
    await rejects(
      extractArchive(file, path.join(tmp, 'out-top'), {
        format: 'tar.gz',
        classifyTopLevel: classify
      }),
      /unexpected entry: contents/
    );

    const ok = writeTarGz('toplevel-ok.tar.gz', [
      { name: 'server/a.js', data: Buffer.from('a') },
      { name: 'config.env', data: Buffer.from('SECRET=1') }
    ]);
    const dest = path.join(tmp, 'out-top-ok');
    const result = await extractArchive(ok, dest, { format: 'tar.gz', classifyTopLevel: classify });
    assert.deepEqual([...result.files.keys()], ['server/a.js']);
    assert.deepEqual(result.ignored, ['config.env']);
    assert.equal(fs.existsSync(path.join(dest, 'config.env')), false);
  });

  it('skips macOS AppleDouble entries', async () => {
    const file = writeTarGz('appledouble.tar.gz', [
      { name: './._server', data: Buffer.from('xattr') },
      { name: './server/a.js', data: Buffer.from('a') }
    ]);
    const result = await extractArchive(file, path.join(tmp, 'out-ad'), {
      format: 'tar.gz',
      classifyTopLevel: name => (name === 'server' ? 'extract' : 'reject')
    });
    assert.deepEqual([...result.files.keys()], ['server/a.js']);
  });

  it('rejects a truncated archive', async () => {
    const whole = Buffer.concat([tarEntry({ name: 'server/a.js', data: Buffer.alloc(4096, 1) })]);
    const file = path.join(tmp, 'truncated.tar.gz');
    fs.writeFileSync(file, zlib.gzipSync(whole.subarray(0, 1500)));
    await rejects(
      extractArchive(file, path.join(tmp, 'out-trunc'), {
        format: 'tar.gz',
        classifyTopLevel: extractAll
      }),
      /truncated/
    );
  });

  it('rejects a file that is not gzip', async () => {
    const file = path.join(tmp, 'garbage.tar.gz');
    fs.writeFileSync(file, 'this is not an archive');
    await rejects(
      extractArchive(file, path.join(tmp, 'out-garbage'), {
        format: 'tar.gz',
        classifyTopLevel: extractAll
      })
    );
  });

  it('counts each decompressed byte once', async () => {
    const data = Buffer.alloc(1024 * 1024, 7);
    const file = writeTarGz('count.tar.gz', [{ name: 'server/blob', data }]);
    const result = await extractArchive(file, path.join(tmp, 'out-count'), {
      format: 'tar.gz',
      classifyTopLevel: extractAll
    });
    // The file plus its header, padding and the end-of-archive blocks.
    assert.ok(result.totalBytes < data.length + 4096, `${result.totalBytes} bytes counted`);
  });

  it('caps the entry count and the expanded size (archive bombs)', async () => {
    const many = writeTarGz(
      'many.tar.gz',
      Array.from({ length: 20 }, (_, i) => ({ name: `server/${i}.js`, data: Buffer.from('x') }))
    );
    await rejects(
      extractArchive(many, path.join(tmp, 'out-many'), {
        format: 'tar.gz',
        classifyTopLevel: extractAll,
        limits: { maxEntries: 10 }
      }),
      /more than 10 entries/
    );

    // 20 MB of zeros compress to ~20 KB: far beyond any real release's ratio.
    const bomb = writeTarGz('bomb.tar.gz', [
      { name: 'server/zeros', data: Buffer.alloc(20 * 1024 * 1024) }
    ]);
    await rejects(
      extractArchive(bomb, path.join(tmp, 'out-bomb'), {
        format: 'tar.gz',
        classifyTopLevel: extractAll
      }),
      /expands to more than/
    );
  });
});

describe('extractArchive (zip)', () => {
  it('extracts a zip release', async () => {
    const file = await writeZip('release.zip', archive => {
      archive.append('a', { name: 'server/lib/a.js' });
      archive.append('<html>', { name: 'public/index.html' });
      archive.append('MZ', { name: 'node.exe' });
    });
    const dest = path.join(tmp, 'out-zip');
    const result = await extractArchive(file, dest, {
      format: 'zip',
      classifyTopLevel: extractAll
    });
    assert.deepEqual([...result.files.keys()].sort(), [
      'node.exe',
      'public/index.html',
      'server/lib/a.js'
    ]);
    assert.equal(fs.readFileSync(path.join(dest, 'server', 'lib', 'a.js'), 'utf8'), 'a');
  });

  it('rejects a symbolic link', async () => {
    const file = await writeZip('symlink.zip', archive => {
      archive.append('a', { name: 'server/a.js' });
      archive.symlink('server/link', '/etc/passwd');
    });
    await rejects(
      extractArchive(file, path.join(tmp, 'out-zip-link'), {
        format: 'zip',
        classifyTopLevel: extractAll
      }),
      /symbolic link/
    );
  });

  it('rejects names that differ only by case (Windows is case-insensitive)', async () => {
    const file = await writeZip('case.zip', archive => {
      archive.append('1', { name: 'server/Readme.md' });
      archive.append('2', { name: 'server/README.md' });
    });
    await rejects(
      extractArchive(file, path.join(tmp, 'out-zip-case'), {
        format: 'zip',
        classifyTopLevel: extractAll
      }),
      /case-colliding/
    );
  });

  it('rejects a file that is not a zip', async () => {
    const file = path.join(tmp, 'garbage.zip');
    fs.writeFileSync(file, 'PK but not really');
    await rejects(
      extractArchive(file, path.join(tmp, 'out-zip-garbage'), {
        format: 'zip',
        classifyTopLevel: extractAll
      }),
      /not a valid zip/
    );
  });
});

describe('decodeBase64File', () => {
  it('decodes the published .base64.txt (wrapped lines) back into the archive', async () => {
    const original = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
    const wrapped = original
      .toString('base64')
      .match(/.{1,76}/g)
      .join('\n');
    const source = path.join(tmp, 'a.tar.gz.base64.txt');
    const dest = path.join(tmp, 'a.tar.gz');
    fs.writeFileSync(source, `${wrapped}\n`);
    await decodeBase64File(source, dest);
    assert.deepEqual(fs.readFileSync(dest), original);
  });

  it('rejects text that is not base64', async () => {
    const source = path.join(tmp, 'bad.base64.txt');
    fs.writeFileSync(source, 'not base64 at all!');
    await rejects(decodeBase64File(source, path.join(tmp, 'bad.bin')), /not valid base64/);
  });
});
