// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V240 specs — the shipped footer text becomes a translation reference.
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
} from '../migrations/V240__footer_text_translation_reference.js';

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

async function runWith(footer) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/ui.json'),
    JSON.stringify({ title: { en: 'X' }, footer }),
    'utf8'
  );
  await up(makeCtx(dir));
  return JSON.parse(await fs.readFile(path.join(dir, 'config/ui.json'), 'utf8'));
}

describe('migration V240 — footer text translation reference', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v240-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('has its version and description', () => {
    assert.equal(version, '240');
    assert.equal(description, 'footer_text_translation_reference');
  });

  it('skips an install without a ui.json', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('replaces the shipped footer text with the reference', async () => {
    const ui = await runWith({
      text: {
        en: '© 2025 IntraFind Software AG. All rights reserved.',
        de: '© 2025 IntraFind Software AG. Alle Rechte vorbehalten.'
      }
    });
    assert.deepEqual(ui.footer.text, { en: '$t(footer.legal)', de: '$t(footer.legal)' });
  });

  it('keeps a footer text an admin wrote', async () => {
    const text = { en: '© Acme', de: '© Acme' };
    assert.deepEqual((await runWith({ text })).footer.text, text);
  });

  it('keeps a shipped footer text that gained another language', async () => {
    const text = {
      en: '© 2025 IntraFind Software AG. All rights reserved.',
      de: '© 2025 IntraFind Software AG. Alle Rechte vorbehalten.',
      fr: '© Acme'
    };
    assert.deepEqual((await runWith({ text })).footer.text, text);
  });

  it('keeps an empty footer text and an install without one', async () => {
    assert.deepEqual((await runWith({ text: {} })).footer.text, {});
    assert.equal((await runWith({})).footer.text, undefined);
  });
});
