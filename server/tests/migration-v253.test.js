// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V253 specs — the shipped site title and PWA name become translation references.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version
} from '../migrations/V253__site_title_product_name_reference.js';

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

async function runWith(ui) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config/ui.json'), JSON.stringify(ui), 'utf8');
  const ctx = makeCtx(dir);
  await up(ctx);
  const first = JSON.parse(await fs.readFile(path.join(dir, 'config/ui.json'), 'utf8'));
  await up(ctx); // idempotent
  const second = JSON.parse(await fs.readFile(path.join(dir, 'config/ui.json'), 'utf8'));
  assert.deepEqual(second, first);
  return first;
}

describe('migration V253 — site title and PWA name refer to product.name', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v253-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('has version 253', () => assert.equal(version, '253'));

  it('needs a ui.json', async () => {
    assert.equal(await precondition({ fileExists: async () => false }), false);
  });

  it('replaces the shipped title and PWA name', async () => {
    const ui = await runWith({
      title: { en: 'iHub Apps', de: 'iHub Apps' },
      pwa: { enabled: true, name: 'iHub Apps', shortName: 'iHub' }
    });
    assert.deepEqual(ui.title, { en: '$t(product.name)', de: '$t(product.name)' });
    assert.equal(ui.pwa.name, '$t(product.name)');
    assert.equal(ui.pwa.shortName, 'iHub');
  });

  it('keeps names an admin wrote', async () => {
    const ui = await runWith({
      title: { en: 'Acme AI', de: 'iHub Apps' },
      pwa: { name: 'Acme' }
    });
    assert.deepEqual(ui.title, { en: 'Acme AI', de: 'iHub Apps' });
    assert.equal(ui.pwa.name, 'Acme');
  });

  it('adds nothing to an install without a title or PWA section', async () => {
    const ui = await runWith({ header: {} });
    assert.deepEqual(ui, { header: {} });
  });
});
