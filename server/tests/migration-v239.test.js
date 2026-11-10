// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V239 specs — the shipped header tagline becomes a translation reference.
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
} from '../migrations/V239__header_tagline_translation_reference.js';

let baseDir;

function makeCtx(dir) {
  return {
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: () => {},
    warn: () => {}
  };
}

async function runWith(header) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/ui.json'),
    JSON.stringify({ title: { en: 'X' }, header }),
    'utf8'
  );
  await up(makeCtx(dir));
  return JSON.parse(await fs.readFile(path.join(dir, 'config/ui.json'), 'utf8'));
}

describe('migration V239 — header tagline translation reference', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v239-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('has its version and description', () => {
    assert.equal(version, '239');
    assert.equal(description, 'header_tagline_translation_reference');
  });

  it('skips an install without a ui.json', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('replaces the shipped tagline with the reference', async () => {
    const ui = await runWith({ tagline: { en: 'by IntraFind', de: 'von IntraFind' } });
    assert.deepEqual(ui.header.tagline, {
      en: '$t(product.tagline)',
      de: '$t(product.tagline)'
    });
  });

  it('keeps a tagline an admin wrote', async () => {
    const tagline = { en: 'by Acme', de: 'von Acme' };
    assert.deepEqual((await runWith({ tagline })).header.tagline, tagline);
  });

  it('keeps a shipped tagline that gained another language', async () => {
    const tagline = { en: 'by IntraFind', de: 'von IntraFind', fr: 'par IntraFind' };
    assert.deepEqual((await runWith({ tagline })).header.tagline, tagline);
  });

  it('keeps an empty tagline and an install without one', async () => {
    assert.deepEqual((await runWith({ tagline: {} })).header.tagline, {});
    assert.equal((await runWith({})).header.tagline, undefined);
  });
});
