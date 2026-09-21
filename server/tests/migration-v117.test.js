#!/usr/bin/env node

/**
 * Migration V117 specs — `useLocalOfficejs` becomes an Office.js source mode.
 *
 * The boolean chose between Microsoft's CDN and the bundled npm snapshot. The
 * replacement adds two more options (proxy through this server, or a custom
 * CDN), so the migration has one job that matters: carry the existing choice
 * over unchanged. An install that was serving the bundled copy must keep
 * serving it — silently moving it to the CDN would break exactly the
 * air-gapped deployments the flag existed for, and silently moving a CDN
 * install to `bundled` would freeze it on a snapshot.
 *
 * It also must not overwrite values an admin has already set, because a
 * migration runs on every install, not just a pristine one.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setDefault, removeKey } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V117__office_js_source_modes.js';

const DEFAULT_CDN_URL = 'https://officeapis.public.onecdn.static.microsoft/1/office.js';
const LEGACY_CDN_URL = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';

let baseDir;

/** A migration context over a scratch contents directory. */
function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    setDefault,
    removeKey,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel =>
      fs
        .readFile(path.join(dir, rel), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** Write a platform.json into a fresh scratch dir and run the migration on it. */
async function runWith(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  const ctx = makeCtx(dir);
  await ctx.writeJson('config/platform.json', platform);
  await up(ctx);
  return { office: (await ctx.readJson('config/platform.json'))?.officeIntegration, ctx };
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v117-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V117 — Office.js source modes', () => {
  it('is registered as version 117', () => {
    assert.equal(version, '117');
    assert.equal(typeof description, 'string');
  });

  it('only runs where platform.json exists', async () => {
    const empty = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(empty)), false);

    const dir = await fs.mkdtemp(path.join(baseDir, 'present-'));
    const ctx = makeCtx(dir);
    await ctx.writeJson('config/platform.json', { officeIntegration: {} });
    assert.equal(await precondition(ctx), true);
  });

  it('keeps an offline install on the bundled copy', async () => {
    const { office } = await runWith({ officeIntegration: { useLocalOfficejs: true } });

    assert.equal(office.officeJsMode, 'bundled');
    assert.equal(office.officeJsCustomUrl, '');
    assert.ok(!('useLocalOfficejs' in office), 'the replaced flag is removed');
  });

  it('leaves an upgraded install on the CDN host it was already using', async () => {
    // The add-in HTML hard-coded appsforoffice.microsoft.com before this
    // change. Moving an upgrade to the newer host would break any customer who
    // allowlisted that exact FQDN, so only fresh installs get the new default.
    const { office } = await runWith({ officeIntegration: { useLocalOfficejs: false } });
    assert.equal(office.officeJsCdnUrl, LEGACY_CDN_URL);
    assert.notEqual(office.officeJsCdnUrl, DEFAULT_CDN_URL);
  });

  it('keeps a normal install on the CDN', async () => {
    const { office } = await runWith({ officeIntegration: { useLocalOfficejs: false } });

    assert.equal(office.officeJsMode, 'cdn');
    assert.ok(!('useLocalOfficejs' in office));
  });

  it('treats a missing flag as the CDN', async () => {
    const { office } = await runWith({ officeIntegration: { enabled: true } });
    assert.equal(office.officeJsMode, 'cdn');
  });

  it('leaves the rest of the Office block alone', async () => {
    const { office } = await runWith({
      officeIntegration: {
        enabled: true,
        oauthClientId: 'abc123',
        useLocalOfficejs: true,
        startPage: { defaultPage: 'apps', featuredAppIds: ['chat'] }
      }
    });

    assert.equal(office.enabled, true);
    assert.equal(office.oauthClientId, 'abc123');
    assert.deepEqual(office.startPage, { defaultPage: 'apps', featuredAppIds: ['chat'] });
  });

  it('does not overwrite values an admin already set', async () => {
    const { office } = await runWith({
      officeIntegration: {
        useLocalOfficejs: true,
        officeJsMode: 'proxy',
        officeJsCdnUrl: LEGACY_CDN_URL,
        officeJsCustomUrl: 'https://cdn.corp/office/office.js'
      }
    });

    assert.equal(office.officeJsMode, 'proxy');
    assert.equal(office.officeJsCdnUrl, LEGACY_CDN_URL);
    assert.equal(office.officeJsCustomUrl, 'https://cdn.corp/office/office.js');
    assert.ok(!('useLocalOfficejs' in office), 'the replaced flag still goes');
  });

  it('is a no-op when there is no Office block at all', async () => {
    const { office, ctx } = await runWith({ auth: { mode: 'local' } });

    assert.equal(office, undefined);
    assert.ok(ctx.logs.some(([, message]) => /nothing to migrate/i.test(message)));
  });

  it('is idempotent across repeated runs', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'idem-'));
    const ctx = makeCtx(dir);
    await ctx.writeJson('config/platform.json', {
      officeIntegration: { useLocalOfficejs: true }
    });

    await up(ctx);
    const first = (await ctx.readJson('config/platform.json')).officeIntegration;
    await up(ctx);
    const second = (await ctx.readJson('config/platform.json')).officeIntegration;

    assert.deepEqual(second, first);
  });
});
