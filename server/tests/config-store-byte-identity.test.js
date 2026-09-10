/**
 * The acceptance test for routing configuration through the storage provider:
 * an installation's `contents/` is byte-identical before and after.
 *
 * Configuration is not ordinary application data. Every file under `contents/`
 * is hand-edited, git-tracked, docker-mounted, seeded from `server/defaults/`
 * and rewritten by 89 checksum-frozen migrations. If the storage provider
 * relocated a config file, wrapped it in the document envelope, or changed its
 * serialization by so much as a trailing newline, the first admin save after an
 * upgrade would rewrite files nobody edited: a diff in every installation's
 * repository, a docker mount that no longer matches the image, a migration
 * checksum that no longer holds. That is the failure this file exists to catch,
 * and it catches it the only way that is convincing — by hashing every file of
 * a populated tree, driving real reads and writes through the store, and
 * comparing the hashes again.
 *
 * The fixture is `server/defaults/` itself, which is exactly what
 * `performInitialSetup` copies into a fresh `contents/`, plus four files that
 * a real installation grows and a defaults tree never has: one formatted by
 * hand with tabs, one whose file name diverges from the `id` inside it, one
 * that is malformed, and a locale override. Their bytes are deliberately not
 * what `JSON.stringify(data, null, 2)` produces, so a read path that quietly
 * normalized a file would show up here as a changed hash.
 *
 * Two properties are asserted separately because they fail for different
 * reasons:
 *
 *  - **Reading writes nothing.** No lock file, no owner index, no temp file, no
 *    mtime-only touch. A sidecar dropped into `contents/apps/` would be loaded
 *    as an app by `resourceLoader` on the next boot.
 *  - **Writing emits exactly what `atomicWriteJSON` emits.** Asserted
 *    differentially: the same object is written through the store and through
 *    `atomicWriteJSON` into a reference tree outside `contents/`, and the two
 *    files must be equal byte for byte.
 *
 * The one place new files may legitimately appear is `contents/data/`, the
 * provider's own directory — the raw store's lock files live at
 * `contents/data/.config-locks/` precisely so that nothing it creates ever
 * lands next to a configuration file.
 *
 * Contract: `CONFIG_STORE_CONTRACT.md` D0, §4, §6 and §8.
 */
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Repository root, computed from this file rather than from `getRootDir()`,
 * which the fixture below deliberately redirects. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Scratch installation root. Built and pointed at before a single server module
 * is imported: `server/config.js` reads `APP_ROOT_DIR` once, at import time, and
 * `ConfigStore` resolves `contents/` under it — so a test that set this later
 * would read and write the developer's real `contents/` tree.
 */
const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-config-bytes-')));
const CONTENTS = path.join(ROOT, 'contents');

/** Where the `atomicWriteJSON` reference files go — outside `contents/`, so
 * they can never be mistaken for part of the installation. */
const REFERENCE = path.join(ROOT, 'reference');

fsSync.cpSync(path.join(REPO_ROOT, 'server', 'defaults'), CONTENTS, { recursive: true });

/**
 * Files a populated installation has and a freshly copied defaults tree does
 * not. Every one of them is formatted the way a person or an older release
 * left it, never the way `JSON.stringify(data, null, 2)` would.
 */
const HAND_WRITTEN = {
  // Tabs, a trailing newline, and keys in no particular order.
  'config/hand-edited.json': '{\n\t"note": "hand edited",\n\t"z": 1,\n\t"a": 2\n}\n',
  // The file name and the id inside it diverge, which admin routes have always
  // allowed; the byte check proves nothing here gets forked into `<id>.json`.
  'apps/legacy-file-name.json': '{\n    "id": "renamed-app",\n    "name": {"en": "Renamed"}\n}\n',
  // Truncated mid-object: read as absent, never repaired, never rewritten.
  'apps/broken.json': '{ "id": "broken", ',
  // Locale overrides are optional, so the defaults tree has no `locales/`.
  'locales/en.json': '{\n  "greeting": "hello"\n}\n'
};

/**
 * Fixture files the write sweep is allowed to pick as its representative —
 * the locale namespace has no document in `server/defaults/` at all, and the
 * one in {@link HAND_WRITTEN} is reserved for the untouched-bytes assertion.
 */
const WRITABLE_EXTRAS = {
  'locales/de.json': '{\n  "greeting": "hallo"\n}\n'
};

for (const [relPath, bytes] of Object.entries({ ...HAND_WRITTEN, ...WRITABLE_EXTRAS })) {
  const target = path.join(CONTENTS, relPath);
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(target, bytes, 'utf8');
}

// Both halves of the contents path are pinned, not just the root: a developer
// `.env` that sets CONTENTS_DIR or DATA_DIR must not move the fixture out from
// under the assertions below.
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';
process.env.DATA_DIR = 'data';

const { default: configStore } = await import('../services/config/ConfigStore.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { atomicWriteJSON } = await import('../utils/atomicWrite.js');
const { CONFIG_NAMESPACES } = await import('../storage/namespaces.js');

/** Platform configuration as `server.js` would hand it to the bootstrap. */
const PLATFORM_CONFIG = { storage: { provider: 'filesystem', filesystem: {} } };

/**
 * The one directory the provider owns inside `contents/`. Files appearing here
 * are expected — the raw store's locks live under it — and files appearing
 * anywhere else are the failure this suite is looking for.
 */
const PROVIDER_DIR = 'data/';

/**
 * Hex sha256 of a buffer.
 *
 * @param {Buffer} bytes - File contents
 * @returns {string} Digest
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash every file under a directory tree.
 *
 * @param {string} dir - Directory to walk
 * @param {string} [base=dir] - Root the returned paths are relative to
 * @param {Map<string, string>} [into] - Accumulator
 * @returns {Promise<Map<string, string>>} Relative `/`-separated path → digest
 */
async function snapshot(dir, base = dir, into = new Map()) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await snapshot(full, base, into);
    } else if (entry.isFile()) {
      into.set(
        path.relative(base, full).split(path.sep).join('/'),
        sha256(await fs.readFile(full))
      );
    }
  }
  return into;
}

/**
 * What changed between two snapshots.
 *
 * @param {Map<string, string>} before - Earlier snapshot
 * @param {Map<string, string>} after - Later snapshot
 * @returns {{added: string[], removed: string[], changed: string[]}} Sorted paths
 */
function compare(before, after) {
  const added = [...after.keys()].filter(key => !before.has(key)).sort();
  const removed = [...before.keys()].filter(key => !after.has(key)).sort();
  const changed = [...after.keys()]
    .filter(key => before.has(key) && before.get(key) !== after.get(key))
    .sort();
  return { added, removed, changed };
}

/**
 * Drop the provider's own directory from a path list.
 *
 * @param {string[]} paths - Relative paths
 * @returns {string[]} The ones outside `contents/data/`
 */
function outsideProviderDir(paths) {
  return paths.filter(relPath => !relPath.startsWith(PROVIDER_DIR));
}

/**
 * Every file under a directory of the fixture, relative to `contents/`.
 *
 * @param {string} relDir - Directory relative to `contents/`
 * @param {RegExp} pattern - Which file names to keep
 * @returns {Promise<string[]>} Relative `/`-separated paths
 */
async function filesUnder(relDir, pattern) {
  const found = [];
  const walk = async current => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && pattern.test(entry.name)) {
        found.push(path.relative(CONTENTS, full).split(path.sep).join('/'));
      }
    }
  };
  await walk(path.join(CONTENTS, relDir));
  return found.sort();
}

/**
 * The first document of a namespace that is safe to rewrite: an object body,
 * and not one of the hand-written fixture files whose bytes later assertions
 * depend on staying exactly as a person left them.
 *
 * @param {string} ns - Raw namespace name
 * @param {string} dir - Its directory under `contents/`
 * @returns {Promise<{relPath: string, data: Object}>} The chosen document
 */
async function firstWritableDocument(ns, dir) {
  for (const key of await configStore.list(ns)) {
    const relPath = `${dir}/${key}.json`;
    if (Object.hasOwn(HAND_WRITTEN, relPath)) continue;
    const data = await configStore.readJson(relPath);
    if (data && typeof data === 'object' && !Array.isArray(data)) return { relPath, data };
  }
  throw new Error(`the fixture has no writable document in ${ns}`);
}

/**
 * The bytes `atomicWriteJSON` would leave for a body, produced by calling it.
 *
 * Deliberately not a second `JSON.stringify` call: the point is to compare the
 * store against the writer every existing config file was produced by, not
 * against this test's idea of what that writer does.
 *
 * @param {string} relPath - Path relative to `contents/`, for the reference file
 * @param {any} data - Document body
 * @returns {Promise<string>} Reference bytes
 */
async function atomicWriteJsonBytes(relPath, data) {
  const target = path.join(REFERENCE, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJSON(target, data);
  return fs.readFile(target, 'utf8');
}

describe('configuration through the storage provider: contents/ stays byte-identical', () => {
  before(async () => {
    const provider = await bootstrapStorage(PLATFORM_CONFIG);
    assert.ok(provider, 'the filesystem provider came up over the fixture');
    assert.equal(
      provider.contentsDir,
      CONTENTS,
      'the raw namespaces are views over the fixture, not over the real installation'
    );
  });

  after(async () => {
    await shutdownStorageBootstrap();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('reading every configuration file leaves the tree untouched', async () => {
    const before = await snapshot(CONTENTS);

    let jsonRead = 0;
    for (const [ns, descriptor] of Object.entries(CONFIG_NAMESPACES)) {
      const keys = await configStore.list(ns);
      for (const key of keys) {
        const data = await configStore.readJson(`${descriptor.dir}/${key}.json`);
        if (data !== null) jsonRead += 1;
      }
    }
    // Sanity: a sweep that silently read nothing would pass every assertion
    // below without exercising anything.
    assert.ok(jsonRead > 20, `the sweep read real configuration (${jsonRead} documents)`);
    assert.ok(await configStore.readJson('config/platform.json'), 'platform.json is readable');
    assert.deepEqual(
      await configStore.readJson('config/hand-edited.json'),
      { note: 'hand edited', z: 1, a: 2 },
      'a hand-formatted file is read as its parsed body'
    );

    const textFiles = [
      ...(await filesUnder('pages', /\.(md|jsx)$/)),
      ...(await filesUnder('renderers', /\.jsx$/)),
      ...(await filesUnder('sources', /\.md$/))
    ];
    assert.ok(textFiles.length > 0, 'the fixture has page bodies, renderers and sources');
    for (const relPath of textFiles) {
      const text = await configStore.readText(relPath);
      assert.equal(
        text,
        await fs.readFile(path.join(CONTENTS, relPath), 'utf8'),
        `${relPath} is served exactly as it is stored`
      );
    }

    assert.deepEqual(
      compare(before, await snapshot(CONTENTS)),
      { added: [], removed: [], changed: [] },
      'a read must not create a lock, an index, a temp file or a rewritten file'
    );
  });

  it('a write of each configuration type emits exactly the bytes atomicWriteJSON emits', async () => {
    const before = await snapshot(CONTENTS);

    // One representative document per raw namespace, plus the three shapes in
    // `config/` that behave differently everywhere else in the server.
    const targets = [];
    for (const relPath of ['config/platform.json', 'config/ui.json', 'config/groups.json']) {
      targets.push({ relPath, data: await configStore.readJson(relPath) });
    }
    for (const [ns, descriptor] of Object.entries(CONFIG_NAMESPACES)) {
      if (ns === 'config') continue;
      targets.push(await firstWritableDocument(ns, descriptor.dir));
    }

    const written = [];
    for (const { relPath, data: original } of targets) {
      assert.ok(
        original && typeof original === 'object' && !Array.isArray(original),
        `${relPath} holds an object to mutate`
      );

      // Appended last, so the key order of everything that was already there
      // has to survive the round trip for the byte comparison to hold.
      const mutated = { ...original, configStoreProbe: relPath };
      await configStore.writeJson(relPath, mutated);
      written.push(relPath);

      const bytes = await fs.readFile(path.join(CONTENTS, relPath), 'utf8');
      assert.equal(
        bytes,
        await atomicWriteJsonBytes(relPath, mutated),
        `${relPath} must be written exactly as atomicWriteJSON writes it`
      );
      assert.ok(!bytes.endsWith('\n'), `${relPath} keeps the absent trailing newline`);
      assert.deepEqual(JSON.parse(bytes), mutated, `${relPath} round-trips its body`);
      assert.deepEqual(
        Object.keys(JSON.parse(bytes)),
        [...Object.keys(original), 'configStoreProbe'],
        `${relPath} preserves key order; a reordering diff would touch every installation`
      );
    }

    const { added, removed, changed } = compare(before, await snapshot(CONTENTS));
    assert.deepEqual(changed.sort(), [...written].sort(), 'only the saved files changed');
    assert.deepEqual(removed, [], 'a save removes nothing');
    assert.deepEqual(
      outsideProviderDir(added),
      [],
      'a save adds nothing beside a configuration file — locks belong under contents/data/'
    );
  });

  it('creating and deleting a document touches only that one file', async () => {
    const before = await snapshot(CONTENTS);
    const relPath = 'apps/created-by-the-store.json';
    const body = { id: 'created-by-the-store', name: { en: 'Created' }, enabled: true };

    await configStore.createJson(relPath, body);
    assert.equal(
      await fs.readFile(path.join(CONTENTS, relPath), 'utf8'),
      await atomicWriteJsonBytes(relPath, body),
      'a create is written by the same serializer as a save'
    );

    const afterCreate = compare(before, await snapshot(CONTENTS));
    assert.deepEqual(outsideProviderDir(afterCreate.added), [relPath], 'only the new app appeared');
    assert.deepEqual(afterCreate.changed, [], 'creating one app rewrote nothing else');

    await assert.rejects(
      () => configStore.createJson(relPath, { id: 'other' }),
      error => error.code === 'EEXIST',
      'a second create loses rather than overwriting'
    );
    assert.deepEqual(
      await configStore.readJson(relPath),
      body,
      'and the losing create left the file alone'
    );

    assert.equal(await configStore.remove(relPath), true, 'the delete reports it removed a file');
    assert.equal(await configStore.remove(relPath), false, 'and reports nothing the second time');

    const afterDelete = compare(before, await snapshot(CONTENTS));
    assert.deepEqual(
      outsideProviderDir(afterDelete.added),
      [],
      'the delete left no tombstone beside the configuration'
    );
    assert.deepEqual(afterDelete.removed, [], 'and removed nothing that was there before');
    assert.deepEqual(afterDelete.changed, [], 'and rewrote nothing');
  });

  it('a file the store never touched is byte-identical to the byte', async () => {
    // The whole point, stated as one assertion over the files most likely to
    // be normalized by accident: hand formatting, a divergent file name, and a
    // malformed body that a repairing read would rewrite.
    for (const [relPath, bytes] of Object.entries(HAND_WRITTEN)) {
      assert.equal(
        await fs.readFile(path.join(CONTENTS, relPath), 'utf8'),
        bytes,
        `${relPath} was never rewritten`
      );
    }
    assert.equal(
      await configStore.readJson('apps/broken.json'),
      null,
      'a malformed file reads as absent — and stays malformed on disk'
    );
  });
});
