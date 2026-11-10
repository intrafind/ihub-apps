// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V238 specs — short links use the SSRF allowlist.
 *
 * The entries of `shortLinks.allowedHosts` and the hosts of stored, unexpired
 * short links move onto `ssrf.allowedHosts`; the old key goes.
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
} from '../migrations/V238__short_link_hosts_to_ssrf_allowlist.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
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
    await fs.writeFile(path.join(dir, rel), JSON.stringify(data), 'utf8');
  }
  return dir;
}

const readPlatform = async dir =>
  JSON.parse(await fs.readFile(path.join(dir, 'config/platform.json'), 'utf8'));

const link = (url, extra = {}) => ({ code: Math.random().toString(36).slice(2), url, ...extra });

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v238-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V238 short_link_hosts_to_ssrf_allowlist', () => {
  it('declares its version and description', () => {
    assert.equal(version, '238');
    assert.equal(description, 'short_link_hosts_to_ssrf_allowlist');
  });

  it('runs only when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx(await freshDir({}))), false);
    const dir = await freshDir({ 'config/platform.json': {} });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('moves the short link entries and stored link hosts onto the SSRF list', async () => {
    const dir = await freshDir({
      'config/platform.json': {
        ssrf: { allowedHosts: ['intranet', 'Docs.Example.com'] },
        shortLinks: { allowedHosts: ['docs.example.com', '*.intrafind.io', '/(a|b)\\.example/'] }
      },
      'data/shortlinks.json': {
        links: [
          link('https://www.qwant.com/'),
          link('https://www.qwant.com/?q=x'),
          link('/apps/chat'),
          link('https://old.example/', { expiresAt: '2000-01-01T00:00:00.000Z' }),
          link('http://[::1]:3000/'),
          link('mailto:a@b.c')
        ]
      }
    });
    const ctx = makeCtx(dir);
    await up(ctx);

    const platform = await readPlatform(dir);
    assert.deepEqual(platform.ssrf.allowedHosts, [
      'intranet',
      'Docs.Example.com',
      '*.intrafind.io',
      'www.qwant.com'
    ]);
    assert.equal(platform.shortLinks, undefined);

    const warnings = ctx.logs.filter(([level]) => level === 'warn').map(([, m]) => m);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /\(a\|b\)/);
    assert.match(warnings[1], /\[::1\]/);
    assert.ok(ctx.logs.some(([, m]) => /Added www\.qwant\.com .*2 stored short links/.test(m)));
  });

  it('keeps other shortLinks settings and an SSRF list it does not need to change', async () => {
    const dir = await freshDir({
      'config/platform.json': {
        ssrf: { allowedHosts: ['docs.example.com'] },
        shortLinks: { allowedHosts: ['docs.example.com'], other: true }
      }
    });
    await up(makeCtx(dir));
    const platform = await readPlatform(dir);
    assert.deepEqual(platform.ssrf, { allowedHosts: ['docs.example.com'] });
    assert.deepEqual(platform.shortLinks, { other: true });
  });

  it('adds nothing to a platform without short links', async () => {
    const dir = await freshDir({ 'config/platform.json': { defaultLanguage: 'en' } });
    await up(makeCtx(dir));
    assert.deepEqual(await readPlatform(dir), { defaultLanguage: 'en' });
  });
});
