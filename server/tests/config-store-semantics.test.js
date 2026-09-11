/**
 * The three read/write semantics the configuration store had to preserve
 * exactly, because the rest of the server was built on them:
 *
 *  - **D3 — a failed read is `null`, never a throw and never `{}`.**
 *    `configLoader.loadFile` has folded ENOENT, EACCES and a malformed body
 *    into `null` for years, and `configCache` branches on `data !== null` in
 *    eleven places. A store that threw would turn one bad file mode or one
 *    missing comma into a server that will not boot; a store that answered
 *    `{}` would turn it into a server that boots with an empty configuration,
 *    which is worse.
 *  - **D4 — a file name may diverge from the `id` inside it.** The admin
 *    routes have always scanned for the file carrying an id rather than
 *    assuming `<id>.json`, because installations have files that were renamed.
 *    A store that wrote straight to `<id>.json` would fork such a resource
 *    into two files, and `resourceLoader` would then load both.
 *  - **D5 — a page keeps its per-language body files.** The registry entry
 *    lives in `config/ui.json` and the bodies stay at
 *    `pages/<lang>/<id>.<md|jsx>`. Nothing about routing configuration through
 *    the provider moves page content.
 *
 * Everything runs against a real provider over a scratch `contents/`.
 *
 * Contract: `CONFIG_STORE_CONTRACT.md` D3, D4, D5 and §5.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Scratch installation root, pointed at before any server module is imported —
 * `server/config.js` reads `APP_ROOT_DIR` once, at import time, and the store
 * resolves `contents/` under it.
 */
const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-config-sem-')));
const CONTENTS = path.join(ROOT, 'contents');
fsSync.mkdirSync(CONTENTS, { recursive: true });

// Pinned rather than inherited: a developer `.env` that sets CONTENTS_DIR
// would otherwise move the fixture out from under these tests.
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { default: configStore } = await import('../services/config/ConfigStore.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { default: logger } = await import('../utils/logger.js');

/** Platform configuration as `server.js` would hand it to the bootstrap. */
const PLATFORM_CONFIG = { storage: { provider: 'filesystem', filesystem: {} } };

/** Running as root defeats the permission bits, so the EACCES case cannot be
 * staged there. Reported as a skip rather than as a test that silently passes. */
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * Write a file into the scratch `contents/` behind the store's back.
 *
 * @param {string} relPath - Path relative to `contents/`
 * @param {string} bytes - Exact contents
 * @returns {Promise<string>} The absolute path written
 */
async function place(relPath, bytes) {
  const target = path.join(CONTENTS, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, 'utf8');
  return target;
}

/**
 * Everything under a directory of the scratch `contents/`, recursively.
 *
 * @param {string} relDir - Directory relative to `contents/`
 * @returns {Promise<string[]>} Relative `/`-separated paths, sorted
 */
async function treeUnder(relDir) {
  const base = path.join(CONTENTS, relDir);
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
      else found.push(path.relative(CONTENTS, full).split(path.sep).join('/'));
    }
  };
  await walk(base);
  return found.sort();
}

/**
 * Record what the code under test logs while `fn` runs.
 *
 * The logger's methods are swapped rather than its output captured: patching
 * `process.stdout.write` inside a `node --test` child also swallows the
 * runner's own result stream, and tests then vanish from the run instead of
 * failing.
 *
 * @param {() => Promise<void>} fn - Body to run
 * @returns {Promise<Array<{level: string, message: unknown}>>} What was logged
 */
async function recordLogs(fn) {
  const lines = [];
  const levels = ['error', 'warn', 'info', 'debug'];
  const originals = levels.map(level => logger[level]);
  levels.forEach(level => {
    logger[level] = message => lines.push({ level, message });
  });
  try {
    await fn();
  } finally {
    levels.forEach((level, index) => {
      logger[level] = originals[index];
    });
  }
  return lines;
}

describe('configuration store: preserved read and write semantics', () => {
  before(async () => {
    const provider = await bootstrapStorage(PLATFORM_CONFIG);
    assert.equal(provider.contentsDir, CONTENTS, 'the store views the scratch installation');
  });

  after(async () => {
    await shutdownStorageBootstrap();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  describe('D3: a read that cannot answer resolves to null', () => {
    it('a file that was never created reads null, in a namespace and outside one', async () => {
      assert.equal(await configStore.readJson('config/never-written.json'), null);
      assert.equal(await configStore.readJson('apps/never-written.json'), null);
      assert.equal(await configStore.readText('pages/en/never-written.md'), null);
      assert.deepEqual(
        await treeUnder('config'),
        [],
        'and a failed read created neither the file nor its directory'
      );
    });

    it('a malformed body reads null instead of throwing', async () => {
      await place('config/malformed.json', '{ "half": ');
      await place('apps/malformed.json', '[1, 2,');
      assert.equal(await configStore.readJson('config/malformed.json'), null);
      assert.equal(await configStore.readJson('apps/malformed.json'), null);
      assert.equal(
        await fs.readFile(path.join(CONTENTS, 'config/malformed.json'), 'utf8'),
        '{ "half": ',
        'and the unreadable file was left exactly as the person who broke it left it'
      );
    });

    it('a directory where a document is expected reads null', async () => {
      await fs.mkdir(path.join(CONTENTS, 'config', 'directory.json'), { recursive: true });
      await place('config/valid.json', JSON.stringify({ ok: true }, null, 2));
      assert.equal(await configStore.readJson('config/directory.json'), null);
      assert.deepEqual(
        await configStore.list('config'),
        ['valid'],
        'a listing skips both the directory and the malformed file, and still finds the real one'
      );
    });

    it(
      'an unreadable file reads null',
      { skip: ROOT_USER ? 'root bypasses the permission bits this case needs' : false },
      async () => {
        const target = await place('config/forbidden.json', '{"secret": true}');
        await fs.chmod(target, 0o000);
        try {
          assert.equal(
            await configStore.readJson('config/forbidden.json'),
            null,
            'a file mode nobody meant to set must not take the boot down'
          );
        } finally {
          await fs.chmod(target, 0o600);
          await fs.rm(target);
        }
      }
    );

    it('a missing locale override is not reported as a failure', async () => {
      // Most installations have no `contents/locales/` at all, so an absent
      // override is the ordinary case, and `configLoader` has always read it
      // without a word. A boot that logged an error per untranslated language
      // would train operators to ignore the log.
      const quiet = await recordLogs(async () => {
        assert.equal(await configStore.readJson('locales/xx.json'), null);
      });
      assert.deepEqual(
        quiet.filter(line => line.level === 'error' || line.level === 'warn'),
        [],
        'a locale nobody translated is not a fault'
      );

      // The control, taken from the code under test rather than staged: a file
      // that really is broken does get reported, so the recorder works and the
      // assertion above is not vacuous.
      await place('config/reported.json', '{ "half": ');
      const noisy = await recordLogs(async () => {
        assert.equal(await configStore.readJson('config/reported.json'), null);
      });
      assert.ok(
        noisy.some(line => line.level === 'error' || line.level === 'warn'),
        'a malformed file is null to the caller and visible in the log'
      );
    });
  });

  describe('a corrupt file is distinguishable from an absent one', () => {
    // `readJson` folds missing, unreadable and malformed into one null, which
    // is right for the boot path and destructive on a read-modify-write: a
    // caller that reads null, calls it a first run and writes the result back
    // replaces everything the file held. The first guard written for this
    // asked the namespace listing whether the file was there — dead, because
    // a listing drops what it cannot parse, so the file was absent from it
    // exactly when the guard needed it present.
    it('exists() reports a malformed file as present, while list() cannot', async () => {
      await place('config/broken-store.json', '{ "credentials": { "a": ');

      assert.equal(await configStore.readJson('config/broken-store.json'), null);
      assert.equal(
        (await configStore.list('config')).includes('broken-store'),
        false,
        'the listing drops it — which is why a guard built on list() is dead'
      );
      assert.equal(await configStore.exists('config/broken-store.json'), true);
    });

    it('exists() is false for a file that was never written', async () => {
      assert.equal(await configStore.exists('config/never-written-at-all.json'), false);
      assert.equal(await configStore.exists('apps/never-written-at-all.json'), false);
    });

    it('readJsonStrict throws on a malformed file and returns null on an absent one', async () => {
      await place('config/strict-broken.json', 'not json at all');

      await assert.rejects(
        () => configStore.readJsonStrict('config/strict-broken.json'),
        /exists but could not be read/
      );
      assert.equal(await configStore.readJsonStrict('config/strict-absent.json'), null);
    });

    it('readJsonStrict returns the body of a file that is simply fine', async () => {
      await place('config/strict-fine.json', JSON.stringify({ credentials: { a: 1 } }));
      assert.deepEqual(await configStore.readJsonStrict('config/strict-fine.json'), {
        credentials: { a: 1 }
      });
    });
  });

  describe('D4: a file name may diverge from the id inside it', () => {
    before(async () => {
      await place(
        'apps/legacy-file-name.json',
        JSON.stringify({ id: 'renamed-app', name: { en: 'Renamed' } }, null, 2)
      );
      await place(
        'apps/plain.json',
        JSON.stringify({ id: 'plain', name: { en: 'Plain' } }, null, 2)
      );
    });

    it('resolves an id to the file that actually carries it', async () => {
      assert.equal(
        await configStore.resolveIdToPath('apps', 'renamed-app'),
        'apps/legacy-file-name.json'
      );
    });

    it('prefers the file named after the id when there is one', async () => {
      assert.equal(await configStore.resolveIdToPath('apps', 'plain'), 'apps/plain.json');
    });

    it('falls back to <id>.json for a resource that exists nowhere', async () => {
      assert.equal(
        await configStore.resolveIdToPath('apps', 'about-to-be-created'),
        'apps/about-to-be-created.json',
        'which is the right answer when the caller is creating one'
      );
    });

    it('answers null for a resource that exists nowhere when asked not to invent one', async () => {
      // What a read wants. The admin routes carried their own copy of this
      // whole resolution for exactly one reason: the fallback. Handed a path
      // to a file that does not exist, an update creates it — so an app whose
      // file was deleted underneath the UI would be silently recreated by the
      // next save instead of answering 404.
      assert.equal(
        await configStore.resolveIdToPath('apps', 'about-to-be-created', {
          createIfMissing: false
        }),
        null
      );
      // And it still finds one that does exist, by either route.
      assert.equal(
        await configStore.resolveIdToPath('apps', 'renamed-app', { createIfMissing: false }),
        'apps/legacy-file-name.json'
      );
      assert.equal(
        await configStore.resolveIdToPath('apps', 'plain', { createIfMissing: false }),
        'apps/plain.json'
      );
    });

    it('accepts the directory form resourceLoader is configured with', async () => {
      await place(
        'agents/profiles/renamed-profile-file.json',
        JSON.stringify({ id: 'analyst', name: 'Analyst' }, null, 2)
      );
      assert.equal(
        await configStore.resolveIdToPath('agents/profiles', 'analyst'),
        'agents/profiles/renamed-profile-file.json'
      );
    });

    it('saving through the resolved path updates the file instead of forking it', async () => {
      const relPath = await configStore.resolveIdToPath('apps', 'renamed-app');
      const app = await configStore.readJson(relPath);
      await configStore.writeJson(relPath, { ...app, enabled: false });

      assert.deepEqual(
        await treeUnder('apps'),
        ['apps/legacy-file-name.json', 'apps/malformed.json', 'apps/plain.json'],
        'a second file carrying the same id would be loaded as a second app'
      );
      assert.equal((await configStore.readJson(relPath)).enabled, false, 'the save landed');
    });
  });

  describe('D5: a page keeps its per-language body files', () => {
    /** The registry entry `routes/admin/pages.js` builds in `config/ui.json`. */
    const registryEntry = {
      title: { en: 'Frequently asked', de: 'Haeufige Fragen' },
      filePath: { en: 'pages/en/faq.md', de: 'pages/de/faq.md' },
      authRequired: false,
      allowedGroups: ['*'],
      contentType: 'markdown'
    };

    const bodies = {
      'pages/en/faq.md': '# FAQ\n\nA body with a trailing newline.\n',
      // No trailing newline, and a tab: the bytes are the author's, not the
      // store's idea of how markdown should look.
      'pages/de/faq.md': '# FAQ\n\n\tEine Antwort ohne Zeilenumbruch am Ende.'
    };

    it('round-trips a page across languages, bodies and registry together', async () => {
      for (const [relPath, text] of Object.entries(bodies)) {
        await configStore.writeText(relPath, text);
      }
      const ui = (await configStore.readJson('config/ui.json')) || {};
      await configStore.writeJson('config/ui.json', {
        ...ui,
        pages: { ...(ui.pages || {}), faq: registryEntry }
      });

      for (const [relPath, text] of Object.entries(bodies)) {
        assert.equal(await configStore.readText(relPath), text, `${relPath} round-trips verbatim`);
        assert.equal(
          await fs.readFile(path.join(CONTENTS, relPath), 'utf8'),
          text,
          `${relPath} is stored as itself, not wrapped or normalized`
        );
      }

      const stored = await configStore.readJson('config/ui.json');
      assert.deepEqual(stored.pages.faq, registryEntry, 'the registry entry survived the save');
      assert.deepEqual(
        await treeUnder('pages'),
        ['pages/de/faq.md', 'pages/en/faq.md'],
        'the bodies stay where every existing page already lives'
      );
    });

    it('serves a jsx page body the same way', async () => {
      const jsx = 'function UserComponent(props) {\n  return <div>hi</div>;\n}\n';
      await configStore.writeText('pages/en/widget.jsx', jsx);
      assert.equal(await configStore.readText('pages/en/widget.jsx'), jsx);
    });

    it('serves an edit made behind the store, without a stale window', async () => {
      // `loadText` used to sit behind a 60-second cache that nothing
      // invalidated, so a page an admin had just saved could be served stale
      // for up to a minute. Removing it left the page route doing a
      // containment walk and a full read on every request instead, so the read
      // is memoized again — but on mtime, not on a clock. An edit is visible
      // on the very next request, however it was made.
      const relPath = 'pages/en/cache-probe.md';
      const original = '# Probe\n\nThe body as the store wrote it.\n';
      await configStore.writeText(relPath, original);
      assert.equal(await configStore.readText(relPath), original, 'the body is cached');

      // A hand edit, a git checkout, a mounted volume changing underneath —
      // none of them go through `writeText`, so none of them can invalidate
      // anything. Only the file's own mtime can say.
      const edited = '# FAQ\n\nEdited on disk.\n';
      const absolute = path.join(CONTENTS, relPath);
      await fs.writeFile(absolute, edited, 'utf8');
      const later = new Date(Date.now() + 2000);
      await fs.utimes(absolute, later, later);

      assert.equal(await configStore.readText(relPath), edited, 'the next read sees it');

      // And a write through the store is exact, not probable. The mtime check
      // cannot see an edit that lands within the filesystem's timestamp
      // resolution of the cached read and produces the same number of bytes —
      // a one-word correction saved twice in a second on a filesystem with
      // coarse timestamps. Pinning the timestamp back is how that is made
      // reproducible rather than left to the disk.
      const sameLength = edited.replace('Edited', 'Ed1ted');
      assert.equal(sameLength.length, edited.length, 'the same number of bytes');
      const stat = await fs.stat(absolute);
      await configStore.writeText(relPath, sameLength);
      await fs.utimes(absolute, stat.atime, stat.mtime);
      assert.equal(
        await configStore.readText(relPath),
        sameLength,
        'a write through the store is never served from a stale entry'
      );

      await configStore.writeText(relPath, original);
      assert.equal(await configStore.readText(relPath), original);

      // A removed page stops being served, cached or not.
      await configStore.remove(relPath);
      assert.equal(await configStore.readText(relPath), null);
    });

    it('removing a language removes only that body file', async () => {
      assert.equal(await configStore.remove('pages/de/faq.md'), true);
      assert.equal(await configStore.remove('pages/de/faq.md'), false);
      assert.equal(
        await configStore.readText('pages/en/faq.md'),
        bodies['pages/en/faq.md'],
        'the other language is untouched'
      );
    });
  });
});
