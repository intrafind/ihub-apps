#!/usr/bin/env node

/**
 * Migration V117 specs — iAssistant models get room, and a dead key goes.
 *
 * Two invariants carry the weight. A model that already carries a
 * `streamIdleTimeoutMs` is never overwritten, including the deliberate `0`
 * that disables the ceiling — an operator who tuned this knows their
 * installation better than the migration does. And `iAssistant.timeout` has
 * to go even though removing config is normally the risky direction, because
 * the whole problem with it was that it looked like the dial for the 60 s
 * cancellation and was wired to nothing.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  version,
  description
} from '../migrations/V117__iassistant_stream_ceiling_and_grounding.js';

let dir;

/** A migration context over a scratch contents directory. */
function makeCtx(base) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(base, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(base, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
      await fs.writeFile(path.join(base, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    listFiles: async (subdir, pattern) => {
      const entries = await fs.readdir(path.join(base, subdir)).catch(() => []);
      if (!pattern) return entries;
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return entries.filter(e => new RegExp(`^${escaped}$`).test(e));
    },
    setDefault: (obj, dotPath, value) => {
      const keys = dotPath.split('.');
      const last = keys.pop();
      let cur = obj;
      for (const k of keys) {
        if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
      }
      if (Object.prototype.hasOwnProperty.call(cur, last)) return false;
      cur[last] = value;
      return true;
    },
    removeKey: (obj, dotPath) => {
      const keys = dotPath.split('.');
      const last = keys.pop();
      let cur = obj;
      for (const k of keys) {
        if (cur[k] == null || typeof cur[k] !== 'object') return false;
        cur = cur[k];
      }
      if (!Object.prototype.hasOwnProperty.call(cur, last)) return false;
      delete cur[last];
      return true;
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function writeModel(id, model) {
  await fs.mkdir(path.join(dir, 'models'), { recursive: true });
  await fs.writeFile(path.join(dir, `models/${id}.json`), JSON.stringify(model, null, 2), 'utf8');
}

async function readModel(id) {
  return JSON.parse(await fs.readFile(path.join(dir, `models/${id}.json`), 'utf8'));
}

async function writePlatform(platform) {
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/platform.json'),
    JSON.stringify(platform, null, 2),
    'utf8'
  );
}

async function readPlatform() {
  return JSON.parse(await fs.readFile(path.join(dir, 'config/platform.json'), 'utf8'));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v117-'));
  await fs.mkdir(path.join(dir, 'models'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('V117 metadata', () => {
  it('declares its version and description', () => {
    assert.equal(version, '117');
    assert.equal(description, 'iassistant_stream_ceiling_and_grounding');
  });
});

describe('V117 model ceilings', () => {
  it('gives an iAssistant conversation model 180 s between chunks', async () => {
    await writeModel('iassistant-conversation', {
      id: 'iassistant-conversation',
      provider: 'iassistant-conversation'
    });

    await up(makeCtx(dir));

    assert.equal((await readModel('iassistant-conversation')).streamIdleTimeoutMs, 180000);
  });

  it('leaves every other provider on the installation-wide ceiling', async () => {
    await writeModel('gpt-5', { id: 'gpt-5', provider: 'openai' });

    await up(makeCtx(dir));

    assert.equal((await readModel('gpt-5')).streamIdleTimeoutMs, undefined);
  });

  it('keeps a ceiling the operator already chose', async () => {
    await writeModel('iassistant-conversation', {
      id: 'iassistant-conversation',
      provider: 'iassistant-conversation',
      streamIdleTimeoutMs: 240000
    });

    await up(makeCtx(dir));

    assert.equal((await readModel('iassistant-conversation')).streamIdleTimeoutMs, 240000);
  });

  it('treats a deliberate 0 as a choice, not an absent value', async () => {
    // 0 disables the ceiling. Seeding over it would re-arm a timeout the
    // operator switched off on purpose.
    await writeModel('iassistant-conversation', {
      id: 'iassistant-conversation',
      provider: 'iassistant-conversation',
      streamIdleTimeoutMs: 0
    });

    await up(makeCtx(dir));

    assert.equal((await readModel('iassistant-conversation')).streamIdleTimeoutMs, 0);
  });

  it('skips a model file that does not parse instead of failing startup', async () => {
    await fs.writeFile(path.join(dir, 'models/broken.json'), '{ not json', 'utf8');
    await writeModel('iassistant-conversation', {
      id: 'iassistant-conversation',
      provider: 'iassistant-conversation'
    });

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal((await readModel('iassistant-conversation')).streamIdleTimeoutMs, 180000);
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('broken.json')));
  });
});

describe('V117 platform config', () => {
  it('removes the timeout key that nothing read', async () => {
    await writePlatform({
      iAssistant: { defaultProfileId: 'iassistant-workspace', timeout: 60000 }
    });

    await up(makeCtx(dir));

    const platform = await readPlatform();
    assert.ok(!('timeout' in platform.iAssistant));
    assert.equal(platform.iAssistant.defaultProfileId, 'iassistant-workspace');
  });

  it('says so loudly when the removed timeout had been tuned', async () => {
    // A number other than the shipped default means somebody raised it trying
    // to fix exactly the cancellation this migration addresses.
    await writePlatform({ iAssistant: { timeout: 300000 } });

    const ctx = makeCtx(dir);
    await up(ctx);

    const warning = ctx.logs.find(([level]) => level === 'warn');
    assert.ok(warning, 'expected a warning about the tuned timeout');
    assert.match(warning[1], /300000/);
    assert.match(warning[1], /streamIdleTimeoutMs/);
  });

  it('stays quiet when the removed timeout was still the shipped default', async () => {
    await writePlatform({ iAssistant: { timeout: 60000 } });

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal(
      ctx.logs.filter(([level]) => level === 'warn').length,
      0,
      'removing an untouched default is not worth a warning'
    );
  });

  it('writes out the search-profile fallback that used to be a code literal', async () => {
    await writePlatform({ iAssistant: { defaultProfileId: '' } });

    await up(makeCtx(dir));

    assert.equal((await readPlatform()).iAssistant.defaultSearchProfile, 'searchprofile-standard');
  });

  it('keeps a search-profile fallback the operator already set', async () => {
    await writePlatform({ iAssistant: { defaultSearchProfile: 'searchprofile-legal' } });

    await up(makeCtx(dir));

    assert.equal((await readPlatform()).iAssistant.defaultSearchProfile, 'searchprofile-legal');
  });

  it('leaves an installation without an iAssistant block alone', async () => {
    await writePlatform({ auth: { mode: 'local' } });

    await up(makeCtx(dir));

    const platform = await readPlatform();
    assert.equal(platform.iAssistant, undefined);
    assert.deepEqual(platform.auth, { mode: 'local' });
  });

  it('runs on an installation with no platform.json at all', async () => {
    await up(makeCtx(dir));

    assert.equal(await makeCtx(dir).fileExists('config/platform.json'), false);
  });
});
