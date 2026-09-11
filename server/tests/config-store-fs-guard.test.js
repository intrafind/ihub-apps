/**
 * The CI guard that keeps configuration on the storage provider.
 *
 * The point of #2307 is not that today's call sites go through
 * `ConfigStore` — it is that tomorrow's do too. Nothing in the language stops
 * the next admin route from reaching for `atomicWriteJSON` again, and the
 * regression would be invisible until a database-backed provider shipped and
 * one endpoint kept writing to a file nobody reads. `scripts/check-config-fs-access.js`
 * is what makes that a build failure instead, so this file tests the guard the
 * only way a guard can be tested: by introducing the violation it exists to
 * catch and requiring it to fail.
 *
 * Four subsystems are excluded by reasoned exception rather than by having
 * been quietly skipped — the migration runner (it runs before any provider
 * exists, and its 89 migrations are checksum-frozen), `TokenStorageService`'s
 * key material (needed before a provider can be constructed, and not JSON
 * documents), `routes/admin/backup.js` (a directory zip and an `fs.rename`
 * swap of the live tree) and the builtin `shared/i18n` locales (outside
 * `contents/` entirely). The guard prints them with their reasons when it
 * runs, so the exceptions stay visible instead of becoming folklore, and the
 * test below asserts that they do.
 *
 * Contract: `CONFIG_STORE_CONTRACT.md` §1 and §7.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);

/** Repository root — the guard scans the tree relative to it. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The guard, as `package.json` invokes it. */
const GUARD = 'scripts/check-config-fs-access.js';

/**
 * The deliberate violation. Named so it is obvious in a `git status` if a run
 * is ever killed between writing and removing it, and placed in the directory
 * the guard cares most about — `routes/admin/` held 37 of the
 * `atomicWriteJSON` call sites this change converted.
 */
const PROBE = 'server/routes/admin/__config-access-guard-probe__.js';

/** A config write of exactly the shape the guard has to reject. */
const PROBE_SOURCE = `/**
 * Temporary fixture written by server/tests/config-store-fs-guard.test.js.
 * If this file is still here, a test run was killed between writing it and
 * removing it again — delete it.
 */
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

/**
 * @param {Object} data - Platform configuration to write
 * @returns {Promise<void>}
 */
export async function writeProbeConfig(data) {
  await atomicWriteJSON('contents/config/platform.json', data);
}
`;

/** A probe outside the guard's own scan list, so only the tree-wide rules can catch it. */
const DOLLAR_PROBE = 'server/utils/__config-access-dollar-probe__.js';

/**
 * The same violation reached through a `$`-prefixed binding, far enough from
 * the literal that only the binding rule can see it.
 *
 * `$` is legal in a JavaScript identifier and is a regex anchor, so a name
 * interpolated into a pattern unescaped built one that cannot match — and the
 * guard went quiet on exactly the code that uses this naming style, rather
 * than erroring. A silent guard is worse than no guard.
 */
const DOLLAR_PROBE_SOURCE = `/**
 * Temporary fixture written by server/tests/config-store-fs-guard.test.js.
 * If this file is still here, a test run was killed between writing it and
 * removing it again — delete it.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';

${Array.from({ length: 12 }, (_unused, i) => `// spacer ${i}`).join('\n')}

/**
 * @param {string} data - Serialized platform configuration
 * @returns {void}
 */
export function writeDollarProbeConfig(data) {
  const $configPath = 'contents/config/platform.json';
${Array.from({ length: 12 }, (_unused, i) => `  // spacer ${i}`).join('\n')}
  const target = join('/srv', $configPath);
  writeFileSync(target, data);
}
`;

/**
 * Run the guard and report how it went, whatever its exit status.
 *
 * @returns {Promise<{code: number, output: string}>} Exit code and the
 *   combined stdout/stderr the guard produced
 */
async function runGuard() {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [GUARD], { cwd: REPO_ROOT });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

/**
 * Plant a probe file, run the guard, and take the probe away again whatever
 * happens — a fixture left behind fails every later run in the working tree
 * and is confusing to find.
 *
 * @param {string} repoPath - Repo-relative path to write the probe at
 * @param {string} source - Probe file contents
 * @returns {Promise<{code: number, output: string}>} The guard's verdict with
 *   the probe in place
 */
async function withProbe(repoPath, source) {
  const probePath = path.join(REPO_ROOT, repoPath);
  await fs.writeFile(probePath, source, 'utf8');
  try {
    return await runGuard();
  } finally {
    await fs.rm(probePath, { force: true });
  }
}

/**
 * A probe body that leaks a config path through one filesystem call.
 *
 * Every one of these sits in `server/utils/`, outside the guard's list of
 * config-owning paths, so the blanket "this file may not touch the filesystem"
 * rule cannot carry the test. Only the tree-wide rules can catch them, which
 * is the point: each probe is shaped like the one thing the guard could not
 * see before, and the rest of the file is deliberately ordinary.
 *
 * @param {string} imports - Import lines
 * @param {string} body - Function body, already indented
 * @returns {string} A complete ES module
 */
function probeModule(imports, body) {
  return `/**
 * Temporary fixture written by server/tests/config-store-fs-guard.test.js.
 * If this file is still here, a test run was killed between writing it and
 * removing it again — delete it.
 */
${imports}

/**
 * @param {string} data - Serialized platform configuration
 * @returns {Promise<void>|void}
 */
export function leakProbeConfig(data) {
${body}
}
`;
}

/**
 * The shapes that reached a configuration file without the guard noticing,
 * one per hole. Each is a real idiom from this codebase, not a contrivance:
 * renaming on import is how fourteen server files already spell
 * `{ promises as fs }`; `const { writeFile } = await import(...)` is how a
 * lazily-loaded helper avoids a top-level fs dependency; `fs.cp` is what
 * `skills.js` and `backup.js` already call; and `join(contentsDir, 'config')`
 * is how `ConfigStore` and the migration runner spell a config path.
 */
const BLIND_SPOT_PROBES = [
  {
    name: 'a renamed fs import',
    file: 'server/utils/__config-access-renamed-probe__.js',
    // The local name is not in FS_OPS; the imported name is. Matching on the
    // local alone saw an unknown function and moved on.
    source: probeModule(
      "import { writeFileSync as persistBytes } from 'fs';\nimport { join } from 'path';",
      "  const target = join('/srv', 'contents/config/platform.json');\n  persistBytes(target, data);"
    )
  },
  {
    name: 'a destructured fs binding',
    file: 'server/utils/__config-access-destructured-probe__.js',
    // Neither an import statement nor a namespace assignment, so both binding
    // clauses missed it and the file produced no call sites at all.
    source: probeModule(
      "import fsPromises from 'fs/promises';\nimport { join } from 'path';",
      '  const { writeFile } = fsPromises;\n' +
        "  const target = join('/srv', 'contents/config/platform.json');\n" +
        '  return writeFile(target, data);'
    )
  },
  {
    name: 'a config directory overwritten by fs.cp',
    file: 'server/utils/__config-access-copy-probe__.js',
    // `cp` was not in FS_OPS. An op that is absent from that list is invisible
    // to both rules — the file scans clean, which reads as a pass.
    source: probeModule(
      "import fs from 'fs/promises';",
      "  void data;\n  return fs.cp('/srv/restore/config', 'contents/config', { recursive: true });"
    )
  },
  {
    name: 'a config path built from contentsDir',
    file: 'server/utils/__config-access-contentsdir-probe__.js',
    // The literal-path pattern knew `'contents', 'config'` and `CONTENTS_DIR`
    // but not the `contentsDir` variable this codebase actually uses, so the
    // file failed the cheap pre-filter and was never tokenized.
    source: probeModule(
      "import { writeFileSync } from 'fs';\nimport { join } from 'path';",
      "  const contentsDir = process.env.CONTENTS_DIR || 'data';\n" +
        "  const target = join(contentsDir, 'config', 'platform.json');\n" +
        '  writeFileSync(target, data);'
    )
  }
];

/** The namespace map the drift check parses. */
const NAMESPACES_FILE = 'server/storage/namespaces.js';

describe('the config filesystem-access guard', () => {
  it('exists and is wired into the scripts CI runs', async () => {
    await fs.access(path.join(REPO_ROOT, GUARD));
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.match(
      pkg.scripts['lint:config-access'] || '',
      /check-config-fs-access/,
      'lint:config-access runs the guard'
    );
    assert.match(
      pkg.scripts['test:quick'] || '',
      /lint:config-access/,
      'and test:quick runs it, or the guard only fires when somebody remembers to ask'
    );
  });

  it('prints the reasoned exclusions every time it runs', async () => {
    const { output } = await runGuard();
    for (const exclusion of [
      /migrations/i,
      /backup\.js/i,
      /i18n/i,
      /encryption-key|TokenStorage/i
    ]) {
      assert.match(
        output,
        exclusion,
        'an exception printed with its reason stays a decision; a silent skip becomes folklore'
      );
    }
  });

  it('reports no direct filesystem configuration access in the tree', async () => {
    const { code, output } = await runGuard();
    assert.equal(
      code,
      0,
      `configuration is still being read or written outside the store:\n${output}`
    );
  });

  it('fails when a config write is added outside the storage layer', async () => {
    // Differential rather than absolute: what has to be true is that the
    // guard reacts to this file, not that the rest of the tree happens to be
    // clean — that is the assertion above, and it should fail on its own.
    const baseline = await runGuard();
    assert.doesNotMatch(baseline.output, /__config-access-guard-probe__/, 'the probe is not there');

    const probePath = path.join(REPO_ROOT, PROBE);
    await fs.writeFile(probePath, PROBE_SOURCE, 'utf8');
    let planted;
    try {
      planted = await runGuard();
    } finally {
      await fs.rm(probePath, { force: true });
    }

    assert.notEqual(
      planted.code,
      0,
      'a direct atomicWriteJSON of a config path must fail the build.\n' +
        `The guard exited 0 with the violation in place at ${PROBE}. A guard that only ` +
        'scans git-tracked files would miss it — it has to scan the working tree.\n' +
        planted.output
    );
    assert.match(
      planted.output,
      /__config-access-guard-probe__/,
      'and it has to name the file, per file, so the failure is actionable'
    );

    const after = await runGuard();
    assert.doesNotMatch(after.output, /__config-access-guard-probe__/, 'the probe is gone again');
    assert.equal(after.code, baseline.code, 'and the guard is back to what it said before');
  });

  it('sees a config path carried by a $-named binding', async () => {
    // CodeQL found the escaping bug behind this (alert 640) as an incomplete
    // encoding; the consequence is what matters. The name reaches a `new
    // RegExp`, and unescaped `$name` compiled to a pattern that matches
    // nothing, so the guard passed a leak it was built to catch and said so
    // cheerfully.
    const probePath = path.join(REPO_ROOT, DOLLAR_PROBE);
    await fs.writeFile(probePath, DOLLAR_PROBE_SOURCE, 'utf8');
    let planted;
    try {
      planted = await runGuard();
    } finally {
      await fs.rm(probePath, { force: true });
    }

    assert.notEqual(
      planted.code,
      0,
      'a config path reaching an fs call through a $-named binding must fail the build.\n' +
        planted.output
    );
    assert.match(planted.output, /__config-access-dollar-probe__/, 'and it has to name the file');

    const after = await runGuard();
    assert.doesNotMatch(after.output, /__config-access-dollar-probe__/, 'the probe is gone again');
  });

  for (const probe of BLIND_SPOT_PROBES) {
    it(`sees a config write reached through ${probe.name}`, async () => {
      const planted = await withProbe(probe.file, probe.source);
      assert.notEqual(
        planted.code,
        0,
        `${probe.name} must fail the build. The guard exited 0 with the probe in place at ` +
          `${probe.file}, which is the failure mode that matters: it did not error, it passed. ` +
          `A pattern that silently stops matching is indistinguishable from a clean tree.\n` +
          planted.output
      );
      assert.match(
        planted.output,
        new RegExp(probe.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'and it has to name the file, per file, so the failure is actionable'
      );

      const after = await runGuard();
      assert.equal(after.code, 0, 'the probe is gone and the tree is clean again');
    });
  }

  it('keeps an exemption pinned to its call site when a local helper moves in above it', async () => {
    // The two narrowed contract exclusions are keyed on the argument name, not
    // on the enclosing function. `fn` was resolved by scanning upward for the
    // nearest preceding declaration, which is not the lexical parent — so a
    // local arrow declared anywhere above an exempted call took over as "the
    // enclosing function", and the exemption stopped covering the call it was
    // written for. The guard then failed the build twice over: once for the
    // call, once for the exemption now matching nothing. Neither has anything
    // to do with configuration moving off the provider, which is the only
    // thing this guard is for.
    const loaderPath = path.join(REPO_ROOT, 'server/configLoader.js');
    const original = await fs.readFile(loaderPath, 'utf8');
    const call = "    const data = await fs.readFile(filePath, 'utf8');";
    assert.ok(original.includes(call), 'the exempted builtin-locale read is where we expect');

    const withLocal = original.replace(
      call,
      `    const trim = (value) => String(value).trim();\n    void trim;\n${call}`
    );

    let planted;
    try {
      await fs.writeFile(loaderPath, withLocal, 'utf8');
      planted = await runGuard();
    } finally {
      await fs.writeFile(loaderPath, original, 'utf8');
    }

    assert.equal(
      planted.code,
      0,
      'declaring a local helper above an exempted read is not a configuration leak.\n' +
        planted.output
    );
    assert.equal(await fs.readFile(loaderPath, 'utf8'), original, 'restored byte for byte');
  });

  it('reports a dead namespace drift check instead of passing', async () => {
    // The drift check is what makes the guard's duplicated CONFIG_DIRS list
    // safe: add a raw namespace to the map and forget the guard, and writes
    // under that directory fall outside the scan entirely. It found its
    // marker with `indexOf`, which answers -1 for a declaration that has
    // merely been reformatted — and slicing a string from -1 yields its last
    // character, so zero namespaces parsed and the check reported agreement
    // having compared nothing.
    //
    // Reformatting is the mutation because it is the realistic one: nobody
    // deletes CONFIG_NAMESPACES, but Prettier rewrapping a long line, or a
    // type annotation landing between the name and the call, both move the
    // marker while leaving the map entirely intact.
    const nsPath = path.join(REPO_ROOT, NAMESPACES_FILE);
    const original = await fs.readFile(nsPath, 'utf8');
    const marker = 'CONFIG_NAMESPACES = Object.freeze({';
    assert.ok(original.includes(marker), 'the declaration is spelled the way the guard expects');

    let planted;
    try {
      await fs.writeFile(
        nsPath,
        original.replace(marker, 'CONFIG_NAMESPACES = Object.freeze(\n  {'),
        'utf8'
      );
      planted = await runGuard();
    } finally {
      await fs.writeFile(nsPath, original, 'utf8');
    }

    assert.notEqual(
      planted.code,
      0,
      'a drift check that can no longer find what it parses has to say so.\n' + planted.output
    );
    // On the specific message, not merely on failing: the other fail-closed
    // check catches this case too, and a guard that reports "the parse is
    // broken" when the parse is fine and the marker moved sends the next
    // maintainer to the wrong file.
    assert.match(
      planted.output,
      /can no longer find the CONFIG_NAMESPACES declaration/,
      'and it has to name the marker as the thing that moved'
    );

    const after = await runGuard();
    assert.equal(after.code, 0, `${NAMESPACES_FILE} is restored byte for byte`);
    assert.equal(await fs.readFile(nsPath, 'utf8'), original, 'restored byte for byte');
  });

  it('does not report drift for a dir descriptor outside the config map', async () => {
    // The block is read to its own closing brace rather than to end of file.
    // Unbounded, every `dir:` further down the module counted as a declared
    // config namespace — and `namespaces.js` is exactly where a second map
    // would go, since runtime namespaces (chats, runs, workflow state) are
    // declared by the same shape. The guard would then fail the build over a
    // directory it was never meant to cover, and the fix a maintainer reaches
    // for is to widen CONFIG_DIRS, which quietly extends the scan to a tree
    // that is not configuration.
    const nsPath = path.join(REPO_ROOT, NAMESPACES_FILE);
    const original = await fs.readFile(nsPath, 'utf8');
    const unrelated = `${original}\nconst UNRELATED_NAMESPACES = Object.freeze({\n  runs: Object.freeze({ dir: 'runs', raw: false })\n});\nvoid UNRELATED_NAMESPACES;\n`;

    let planted;
    try {
      await fs.writeFile(nsPath, unrelated, 'utf8');
      planted = await runGuard();
    } finally {
      await fs.writeFile(nsPath, original, 'utf8');
    }

    assert.equal(
      planted.code,
      0,
      `a 'dir' outside CONFIG_NAMESPACES is not a config namespace.\n${planted.output}`
    );
    assert.doesNotMatch(planted.output, /'runs'/, 'and it is not named as drift');
    assert.equal(await fs.readFile(nsPath, 'utf8'), original, 'restored byte for byte');
  });

  it('reports a namespace map it can still find but can no longer parse', async () => {
    // The sibling test above is caught by either fail-closed check on its own,
    // so it does not tell the two apart. This one does: the marker is exactly
    // where the guard expects it and the block is entirely intact — only the
    // quoting of the `dir` values changed, which is what a contributor pasting
    // from JSON produces. The marker check sees nothing wrong; only the
    // "parsed to zero namespaces" check stands between that and a guard that
    // reports agreement having compared nothing.
    const nsPath = path.join(REPO_ROOT, NAMESPACES_FILE);
    const original = await fs.readFile(nsPath, 'utf8');
    const requoted = original.replace(/dir: '([^']+)'/g, 'dir: "$1"');
    assert.notEqual(requoted, original, 'the namespace map still spells dir values in quotes');

    let planted;
    try {
      await fs.writeFile(nsPath, requoted, 'utf8');
      planted = await runGuard();
    } finally {
      await fs.writeFile(nsPath, original, 'utf8');
    }

    assert.notEqual(
      planted.code,
      0,
      'a parse that yields no namespaces is a dead check, not an empty map.\n' + planted.output
    );
    assert.match(
      planted.output,
      /parsed to zero namespaces/,
      'and it has to point at the parse, not at the marker it found exactly where it expected'
    );

    const after = await runGuard();
    assert.equal(after.code, 0, `${NAMESPACES_FILE} is restored byte for byte`);
    assert.equal(await fs.readFile(nsPath, 'utf8'), original, 'restored byte for byte');
  });
});
