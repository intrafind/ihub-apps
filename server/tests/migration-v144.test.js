#!/usr/bin/env node

/**
 * Migration V144 specs — unused app creation wizard fields leave app files.
 *
 * The wizard used to save its own form state (`useAI`, `useTemplate`,
 * `useManual`, `aiGenerated`, `aiPrompt`, a top-level `imageUpload`) and a
 * `parentId` of `null` into new apps. Admin saves now reject fields that are
 * not part of an app, so the migration removes exactly these and nothing else.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description
} from '../migrations/V144__remove_app_wizard_fields.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    listFiles: async (directory, pattern) => {
      let entries;
      try {
        entries = await fs.readdir(path.join(dir, directory));
      } catch {
        return [];
      }
      return pattern === '*.json' ? entries.filter(e => e.endsWith('.json')) : entries;
    },
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function freshDir(files) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  for (const [rel, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(
      path.join(dir, rel),
      typeof data === 'string' ? data : JSON.stringify(data),
      'utf8'
    );
  }
  return dir;
}

const read = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v144-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V144 remove_app_wizard_fields', () => {
  it('declares its version and description', () => {
    assert.equal(version, '144');
    assert.equal(description, 'remove_app_wizard_fields');
  });

  it('runs only when there are app files', async () => {
    assert.equal(await precondition(makeCtx(await freshDir({}))), false);
    const dir = await freshDir({ 'apps/chat.json': { id: 'chat' } });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('removes the wizard fields and a null parentId, and keeps everything else', async () => {
    const dir = await freshDir({
      'apps/wizard.json': {
        id: 'wizard',
        name: { en: 'Wizard app' },
        useAI: true,
        useTemplate: false,
        useManual: false,
        aiGenerated: true,
        aiPrompt: 'An app that helps',
        imageUpload: { enabled: true },
        parentId: null,
        upload: { enabled: true, imageUpload: { enabled: true } }
      }
    });
    await up(makeCtx(dir));
    assert.deepEqual(await read(dir, 'apps/wizard.json'), {
      id: 'wizard',
      name: { en: 'Wizard app' },
      upload: { enabled: true, imageUpload: { enabled: true } }
    });
  });

  it('keeps a parentId that names a parent app', async () => {
    const dir = await freshDir({
      'apps/child.json': { id: 'child', parentId: 'base', useAI: true }
    });
    await up(makeCtx(dir));
    assert.deepEqual(await read(dir, 'apps/child.json'), { id: 'child', parentId: 'base' });
  });

  it('leaves files without wizard fields untouched', async () => {
    const raw = '{"id":"plain","name":{"en":"Plain"}}';
    const dir = await freshDir({ 'apps/plain.json': raw });
    await up(makeCtx(dir));
    assert.equal(await fs.readFile(path.join(dir, 'apps/plain.json'), 'utf8'), raw);
  });

  it('skips a file that is not valid JSON and continues with the others', async () => {
    const dir = await freshDir({
      'apps/broken.json': '{ not json',
      'apps/wizard.json': { id: 'wizard', useManual: true }
    });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal(await fs.readFile(path.join(dir, 'apps/broken.json'), 'utf8'), '{ not json');
    assert.deepEqual(await read(dir, 'apps/wizard.json'), { id: 'wizard' });
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('broken.json')));
  });
});
