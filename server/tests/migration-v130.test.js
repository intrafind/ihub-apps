#!/usr/bin/env node

/**
 * Migration V130 specs — the iHub Documentation source description mentions
 * the release notes.
 *
 * The description is the tool description the model reads before calling the
 * source, so it has to say the release notes are in there. Each language is
 * replaced only while it still reads as V055 shipped it; anything an admin
 * wrote stays.
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
  description,
  DESCRIPTION,
  PREVIOUS_DESCRIPTION
} from '../migrations/V130__ihub_documentation_release_notes_description.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let baseDir;

/** A migration context over a scratch contents directory. */
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
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** Write a scratch contents dir holding this sources config (`null`: no file). */
async function seed(sources) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v130-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (sources !== null) {
    await fs.writeFile(
      path.join(dir, 'config/sources.json'),
      JSON.stringify(sources, null, 2),
      'utf8'
    );
  }
  return { dir, ctx: makeCtx(dir) };
}

/** The source entry as V055 added it. */
function ihubDocumentation(overrides = {}) {
  return {
    id: 'ihub-documentation',
    name: { en: 'iHub Documentation', de: 'iHub-Dokumentation' },
    description: { ...PREVIOUS_DESCRIPTION },
    type: 'filesystem',
    enabled: true,
    exposeAs: 'tool',
    config: { path: 'sources/ihub-documentation.md', encoding: 'utf-8' },
    ...overrides
  };
}

const FAQ = {
  id: 'faq',
  name: { en: 'FAQ' },
  description: { en: 'Frequently asked questions' },
  type: 'filesystem',
  config: { path: 'sources/faq.md' }
};

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v130-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V130 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '130');
    assert.equal(description, 'ihub_documentation_release_notes_description');
  });

  it('only runs when sources.json exists', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
    const { ctx: withSources } = await seed([]);
    assert.equal(await precondition(withSources), true);
  });

  it('matches what fresh installations ship', async () => {
    const defaults = JSON.parse(
      await fs.readFile(path.join(__dirname, '../defaults/config/sources.json'), 'utf8')
    );
    const shipped = defaults.find(s => s.id === 'ihub-documentation');
    assert.deepEqual(shipped.description, { ...DESCRIPTION });
  });

  it('mentions the release notes in every language', () => {
    assert.match(DESCRIPTION.en, /release notes/);
    assert.match(DESCRIPTION.en, /breaking changes/);
    assert.match(DESCRIPTION.de, /Versionshinweise/);
    // The description lands in an XML attribute of the sources template.
    for (const text of Object.values(DESCRIPTION)) assert.equal(text.includes('"'), false);
  });
});

describe('V130 updates the description', () => {
  it('replaces the description V055 shipped, and nothing else', async () => {
    const { ctx } = await seed([FAQ, ihubDocumentation()]);
    await up(ctx);
    const sources = await ctx.readJson('config/sources.json');
    assert.deepEqual(sources[0], FAQ);
    assert.deepEqual(sources[1], ihubDocumentation({ description: { ...DESCRIPTION } }));
  });

  it('keeps a language an admin rewrote and updates the other', async () => {
    const { ctx } = await seed([
      ihubDocumentation({
        description: { en: 'Our platform manual', de: PREVIOUS_DESCRIPTION.de, fr: 'Manuel' }
      })
    ]);
    await up(ctx);
    const [source] = await ctx.readJson('config/sources.json');
    assert.deepEqual(source.description, {
      en: 'Our platform manual',
      de: DESCRIPTION.de,
      fr: 'Manuel'
    });
  });

  it('leaves a fully customized description and does not rewrite the file', async () => {
    const custom = [ihubDocumentation({ description: { en: 'Manual', de: 'Handbuch' } })];
    const { ctx, dir } = await seed(custom);
    const before = await fs.readFile(path.join(dir, 'config/sources.json'), 'utf8');
    await up(ctx);
    assert.equal(await fs.readFile(path.join(dir, 'config/sources.json'), 'utf8'), before);
  });

  it('leaves a plain-string description alone', async () => {
    const { ctx } = await seed([ihubDocumentation({ description: 'Manual' })]);
    await up(ctx);
    const [source] = await ctx.readJson('config/sources.json');
    assert.equal(source.description, 'Manual');
  });

  it('does nothing when the source was removed', async () => {
    const { ctx } = await seed([FAQ]);
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/sources.json'), [FAQ]);
  });

  it('warns and skips when sources.json is not an array', async () => {
    const { ctx } = await seed({ sources: [] });
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/sources.json'), { sources: [] });
    assert.equal(ctx.logs[0][0], 'warn');
  });

  it('is idempotent', async () => {
    const { ctx } = await seed([ihubDocumentation()]);
    await up(ctx);
    const first = await ctx.readJson('config/sources.json');
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/sources.json'), first);
  });
});
