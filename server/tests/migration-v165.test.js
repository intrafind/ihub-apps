#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V165 specs — the shipped apps that had a document upload limit of
 * 5 MB are raised to 20 MB.
 *
 * Only the apps in the shipped list, and only a limit that is still exactly 5.
 * Every other value, other apps, and other upload types stay as they are.
 *
 * Run: node --test server/tests/migration-v165.test.js
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description
} from '../migrations/V165__raise_shipped_apps_document_upload_limit.js';

const DEFAULT_APPS_DIR = fileURLToPath(new URL('../defaults/apps', import.meta.url));

/** The default apps that shipped with 5 MB (the list the migration works on). */
const SHIPPED_APP_IDS = [
  'email-composer',
  'file-analysis',
  'ifinder-document-actions',
  'ihub-support-bot',
  'intrafind-websites-bot',
  'summarizer',
  'translator'
];

let baseDir = null;

/** A migration context over a real `contents/` directory, like the runner's. */
function makeCtx(dir) {
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    listFiles: async (directory, pattern) => {
      let entries;
      try {
        entries = await fs.readdir(path.join(dir, directory));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      return pattern === '*.json' ? entries.filter(name => name.endsWith('.json')) : entries;
    },
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes.push(rel);
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** A `contents/` directory holding the given app files (name -> JSON value or raw text). */
async function freshDir(apps = {}) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
  for (const [name, app] of Object.entries(apps)) {
    const text = typeof app === 'string' ? app : JSON.stringify(app, null, 2);
    await fs.writeFile(path.join(dir, 'apps', name), text, 'utf8');
  }
  return dir;
}

async function readApp(dir, name) {
  return JSON.parse(await fs.readFile(path.join(dir, 'apps', name), 'utf8'));
}

/** An app of the given id with the given upload block. */
const appWith = (id, upload) => ({
  id,
  name: { en: id },
  description: { en: id },
  upload
});

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v165-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V165 raise the document upload limit of the shipped apps', () => {
  it('exports its version and description, matching the file name', () => {
    assert.equal(version, '165');
    assert.equal(description, 'raise_shipped_apps_document_upload_limit');
  });

  it('runs only when there are app files', async () => {
    const noApps = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(noApps)), false);
    assert.equal(await precondition(makeCtx(await freshDir())), false);
    assert.equal(
      await precondition(
        makeCtx(await freshDir({ 'a.json': appWith('a', { fileUpload: { maxFileSizeMB: 5 } }) }))
      ),
      true
    );
  });

  it('raises every shipped app from 5 to 20 MB', async () => {
    const apps = Object.fromEntries(
      SHIPPED_APP_IDS.map(id => [
        `${id}.json`,
        appWith(id, { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: 5 } })
      ])
    );
    const dir = await freshDir(apps);
    const ctx = makeCtx(dir);

    await up(ctx);

    for (const id of SHIPPED_APP_IDS) {
      const app = await readApp(dir, `${id}.json`);
      assert.equal(app.upload.fileUpload.maxFileSizeMB, 20, id);
    }
    assert.equal(ctx.writes.length, SHIPPED_APP_IDS.length);
    assert.ok(ctx.logs.some(([level, message]) => level === 'info' && /raised/i.test(message)));
  });

  it('changes nothing else in the app file', async () => {
    const original = {
      id: 'translator',
      name: { en: 'Translator', de: 'Übersetzer' },
      color: '#4F46E5',
      tools: ['a', 'b'],
      upload: {
        enabled: true,
        allowMultiple: true,
        imageUpload: { enabled: true, maxFileSizeMB: 10 },
        fileUpload: {
          enabled: true,
          maxFileSizeMB: 5,
          supportedFormats: ['text/plain', 'application/pdf']
        }
      }
    };
    const dir = await freshDir({ 'translator.json': original });

    await up(makeCtx(dir));

    const expected = structuredClone(original);
    expected.upload.fileUpload.maxFileSizeMB = 20;
    assert.deepEqual(await readApp(dir, 'translator.json'), expected);
  });

  it('keeps any limit an admin set other than 5', async () => {
    const limits = { 'translator.json': 3, 'summarizer.json': 10, 'file-analysis.json': 20 };
    const apps = Object.fromEntries(
      Object.entries(limits).map(([name, limit]) => [
        name,
        appWith(name.replace('.json', ''), { fileUpload: { enabled: true, maxFileSizeMB: limit } })
      ])
    );
    apps['email-composer.json'] = appWith('email-composer', {
      fileUpload: { enabled: true, maxFileSizeMB: 50 }
    });
    const dir = await freshDir(apps);
    const ctx = makeCtx(dir);

    await up(ctx);

    for (const [name, limit] of Object.entries(limits)) {
      assert.equal((await readApp(dir, name)).upload.fileUpload.maxFileSizeMB, limit, name);
    }
    assert.equal((await readApp(dir, 'email-composer.json')).upload.fileUpload.maxFileSizeMB, 50);
    assert.deepEqual(ctx.writes, []);
  });

  it('writes nothing into a shipped app without a document limit', async () => {
    const dir = await freshDir({
      'translator.json': appWith('translator', { fileUpload: { enabled: true } }),
      'summarizer.json': appWith('summarizer', { enabled: true }),
      'file-analysis.json': appWith('file-analysis', undefined),
      'email-composer.json': { id: 'email-composer', name: { en: 'x' } }
    });
    const ctx = makeCtx(dir);

    await up(ctx);

    assert.deepEqual(ctx.writes, []);
    assert.deepEqual((await readApp(dir, 'translator.json')).upload, {
      fileUpload: { enabled: true }
    });
    assert.equal('upload' in (await readApp(dir, 'email-composer.json')), false);
  });

  it('leaves apps that did not ship with 5 MB alone, even at exactly 5', async () => {
    const dir = await freshDir({
      'my-custom-app.json': appWith('my-custom-app', { fileUpload: { maxFileSizeMB: 5 } }),
      'nda-risk-analyzer.json': appWith('nda-risk-analyzer', { fileUpload: { maxFileSizeMB: 5 } })
    });
    const ctx = makeCtx(dir);

    await up(ctx);

    assert.equal((await readApp(dir, 'my-custom-app.json')).upload.fileUpload.maxFileSizeMB, 5);
    assert.equal((await readApp(dir, 'nda-risk-analyzer.json')).upload.fileUpload.maxFileSizeMB, 5);
    assert.deepEqual(ctx.writes, []);
  });

  it('raises only the document limit, not the other upload types', async () => {
    const dir = await freshDir({
      'summarizer.json': appWith('summarizer', {
        imageUpload: { maxFileSizeMB: 5 },
        audioUpload: { maxFileSizeMB: 5 },
        videoUpload: { maxFileSizeMB: 5 },
        fileUpload: { maxFileSizeMB: 5 }
      })
    });

    await up(makeCtx(dir));

    const { upload } = await readApp(dir, 'summarizer.json');
    assert.equal(upload.fileUpload.maxFileSizeMB, 20);
    assert.equal(upload.imageUpload.maxFileSizeMB, 5);
    assert.equal(upload.audioUpload.maxFileSizeMB, 5);
    assert.equal(upload.videoUpload.maxFileSizeMB, 5);
  });

  it('finds a shipped app by its id, not by its file name', async () => {
    const dir = await freshDir({
      'summarizer-copy.json': appWith('summarizer', { fileUpload: { maxFileSizeMB: 5 } }),
      'translator.json': appWith('something-else', { fileUpload: { maxFileSizeMB: 5 } })
    });

    await up(makeCtx(dir));

    assert.equal((await readApp(dir, 'summarizer-copy.json')).upload.fileUpload.maxFileSizeMB, 20);
    assert.equal((await readApp(dir, 'translator.json')).upload.fileUpload.maxFileSizeMB, 5);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const dir = await freshDir({
      'translator.json': appWith('translator', { fileUpload: { maxFileSizeMB: 5 } })
    });
    await up(makeCtx(dir));
    const afterFirst = await fs.readFile(path.join(dir, 'apps/translator.json'), 'utf8');

    const second = makeCtx(dir);
    await up(second);

    assert.equal(await fs.readFile(path.join(dir, 'apps/translator.json'), 'utf8'), afterFirst);
    assert.deepEqual(second.writes, []);
  });

  it('skips files it cannot read or that are not an app, and carries on', async () => {
    const dir = await freshDir({
      '1-broken.json': '{ not json',
      '2-array.json': '[1, 2, 3]',
      '3-null.json': 'null',
      '4-no-id.json': { upload: { fileUpload: { maxFileSizeMB: 5 } } },
      '5-string-limit.json': appWith('translator', { fileUpload: { maxFileSizeMB: '5' } }),
      '6-ok.json': appWith('summarizer', { fileUpload: { maxFileSizeMB: 5 } })
    });
    const ctx = makeCtx(dir);

    await up(ctx);

    assert.equal((await readApp(dir, '6-ok.json')).upload.fileUpload.maxFileSizeMB, 20);
    assert.equal((await readApp(dir, '5-string-limit.json')).upload.fileUpload.maxFileSizeMB, '5');
    assert.equal((await readApp(dir, '4-no-id.json')).upload.fileUpload.maxFileSizeMB, 5);
    assert.deepEqual(ctx.writes, ['apps/6-ok.json']);
    assert.ok(
      ctx.logs.some(([level, message]) => level === 'warn' && /1-broken\.json/.test(message))
    );
  });

  it('ignores files that are not .json', async () => {
    const dir = await freshDir({
      'translator.json.bak': appWith('translator', { fileUpload: { maxFileSizeMB: 5 } })
    });
    const ctx = makeCtx(dir);

    await up(ctx);

    assert.deepEqual(ctx.writes, []);
    assert.equal((await readApp(dir, 'translator.json.bak')).upload.fileUpload.maxFileSizeMB, 5);
  });
});

describe('V165 and the default apps that ship with the server', () => {
  const readDefaultApps = async () => {
    const names = (await fs.readdir(DEFAULT_APPS_DIR)).filter(name => name.endsWith('.json'));
    return Promise.all(
      names.map(async name =>
        JSON.parse(await fs.readFile(path.join(DEFAULT_APPS_DIR, name), 'utf8'))
      )
    );
  };

  it('every shipped app of the list is now shipped with 20 MB', async () => {
    const apps = await readDefaultApps();
    for (const id of SHIPPED_APP_IDS) {
      const app = apps.find(candidate => candidate.id === id);
      assert.ok(app, `server/defaults/apps has the app ${id}`);
      assert.equal(app.upload?.fileUpload?.maxFileSizeMB, 20, id);
    }
  });

  it('no default app is shipped with the old limit of 5 MB any more', async () => {
    for (const app of await readDefaultApps()) {
      assert.notEqual(app.upload?.fileUpload?.maxFileSizeMB, 5, app.id);
    }
  });

  it('what the migration leaves behind is what a new install gets', async () => {
    // An installed app at the old shipped value ends up like its default today
    const apps = await readDefaultApps();
    for (const id of SHIPPED_APP_IDS) {
      const shipped = apps.find(candidate => candidate.id === id);
      const installed = structuredClone(shipped);
      installed.upload.fileUpload.maxFileSizeMB = 5;
      const dir = await freshDir({ [`${id}.json`]: installed });

      await up(makeCtx(dir));

      assert.deepEqual(await readApp(dir, `${id}.json`), shipped, id);
    }
  });
});
