#!/usr/bin/env node

/**
 * CI guard: configuration is read and written through the storage provider,
 * not through the filesystem.
 *
 * Since #2307 every read and write of an installation's configuration goes
 * through `ConfigStore` (`server/services/config/ConfigStore.js`), which
 * delegates to the raw namespaces of the filesystem storage provider. The
 * point of that seam is that a future database-backed provider can serve
 * configuration without every admin route having to change — which only holds
 * for as long as nothing reaches around the seam and touches the files
 * directly. A single `atomicWriteJSON(join(contentsDir, 'apps', id + '.json'))`
 * added in a hurry silently reintroduces the coupling, and nothing else in the
 * test suite notices: the write succeeds, the file is correct, and the
 * abstraction is quietly dead.
 *
 * So this guard reads the config-owning source files and fails on any direct
 * filesystem call in them. It is a lexical check, not a type check — it looks
 * at what the code says, because that is what a reviewer looks at too.
 *
 * A handful of subsystems cannot honour the rule and are excluded by reasoned
 * exception rather than by silence: see CONTRACT_EXCLUSIONS below. Their
 * reasons are printed on every run, so the exceptions stay arguable instead of
 * turning into folklore nobody can explain in six months, and an exception
 * whose call site has since disappeared fails the guard rather than lingering.
 *
 * Usage:
 *   node scripts/check-config-fs-access.js          # fails with exit 1 on violations
 *   node scripts/check-config-fs-access.js --quiet  # only print on failure
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

/**
 * Directories under `contents/` that hold configuration.
 *
 * `server/storage/namespaces.js` is the single source of truth for this map;
 * the copy here exists only so the guard does not have to import server code
 * (and its config/env side effects) to run. `assertNamespacesInSync()` below
 * compares the two and fails the guard if they drift, so adding a namespace
 * there extends the guard here automatically instead of quietly widening the
 * hole.
 *
 * `pages` is listed in addition to the storage namespaces: page bodies live in
 * `contents/pages/<lang>/` and are config in every sense that matters here,
 * even though the store addresses them through `ui.json`'s registry (D5).
 *
 * @type {string[]}
 */
const CONFIG_DIRS = [
  'config',
  'apps',
  'models',
  'prompts',
  'tools',
  'workflows',
  'agents/profiles',
  'locales',
  'pages'
];

/**
 * Source locations that own configuration — the guard's scope.
 *
 * Entries ending in `/` are directory prefixes, so a new admin route file is
 * covered the day it is added. Everything outside this list is checked by the
 * narrower tree-wide rule further down.
 *
 * The list is the inventory of direct config filesystem access that #2307
 * converted, plus the files that were excluded from the conversion — an
 * excluded file stays in scope precisely so its exemption has to be spelled
 * out in CONTRACT_EXCLUSIONS rather than being invisible.
 *
 * @type {string[]}
 */
const CONFIG_OWNING_PATHS = [
  'server/configCache.js',
  'server/configLoader.js',
  'server/migrations/',
  'server/routes/admin/',
  'server/routes/pageRoutes.js',
  'server/routes/setup.js',
  'server/routes/workflow/workflowRoutes.js',
  'server/services/TokenStorageService.js',
  'server/services/marketplace/',
  'server/utils/authorization.js',
  'server/utils/installationCleanup.js',
  'server/utils/oauthClientManager.js',
  'server/utils/resourceLoader.js',
  'server/utils/setupUtils.js',
  'server/utils/userManager.js'
];

/**
 * Where the seam itself lives. These implement the provider and the store, so
 * they are the one place raw filesystem access is the whole point.
 *
 * @type {string[]}
 */
const SEAM_PATHS = ['server/storage/', 'server/services/config/', 'server/utils/atomicWrite.js'];

/**
 * Subsystems that cannot read configuration through the provider.
 *
 * The first four are the exclusions named in the #2307 contract, section 1;
 * the fifth surfaced during the conversion. Each carries the reason it cannot
 * go through the provider, and every reason is printed on every run — an
 * exception nobody can restate in six months is one nobody can re-examine.
 *
 * An entry without `fn` or `arg` exempts the whole file or directory; with
 * them it exempts only the matching call sites, so the rest of the file stays
 * guarded. Adding one here is an architectural claim and belongs in
 * `docs/storage.md` too.
 *
 * @type {Array<{path: string, fn?: RegExp, arg?: RegExp, reason: string}>}
 */
const CONTRACT_EXCLUSIONS = [
  {
    path: 'server/migrations/',
    reason:
      'The migration runner executes in the cluster primary before configCache and before any ' +
      'provider exists — the provider needs platform.json, which a migration may be creating. ' +
      'Its migrations are frozen by checksum and use moveFile/deleteFile/listFiles(glob), which ' +
      'have no document-store equivalent.'
  },
  {
    path: 'server/services/TokenStorageService.js',
    reason:
      'Key material (.encryption-key, .jwt-*, .usage-pepper) is needed before a provider can be ' +
      'constructed, and none of it is a JSON document.'
  },
  {
    path: 'server/routes/admin/backup.js',
    reason:
      'Export and import are a directory zip and an fs.rename swap of the live contents tree. ' +
      'It operates on the tree as a tree; a document API is the wrong shape for it.'
  },
  {
    path: 'server/configLoader.js',
    // Pinned on the path expression rather than the enclosing function. `fn`
    // resolved scope by scanning upward for the nearest preceding declaration,
    // which is not the lexical parent: adding any local arrow above an
    // exempted call made the call a violation *and* reported the exemption as
    // stale, while a module-level read placed after the exempted function's
    // closing brace was silently exempted by it. An argument name is exact and
    // needs no parser.
    arg: /\b(filePath|i18nDir)\b/,
    reason:
      'The builtin locales live in shared/i18n/, which ships with the application rather than ' +
      'with an installation. They are outside contents/ entirely, so no configuration provider ' +
      'owns them.'
  },
  {
    path: 'server/utils/authorization.js',
    arg: /\bconfigPath\b/,
    reason:
      'loadGroupsConfiguration() is synchronous and cannot become async: adminAuth and ' +
      'contentAdminAuth call it in the middleware path of every admin request. It reads ' +
      'configCache first — which is populated through the store — and only falls back to disk ' +
      'for a cache that has not been initialized yet, which the async store cannot serve.'
  }
];

/**
 * Call sites inside guarded files whose target is not configuration.
 *
 * These are not exceptions to the rule — they are outside its subject matter:
 * uploaded assets, tool implementation scripts, key material, skill directory
 * trees, shipped release notes, runtime data under the provider's own dataDir.
 * They are pinned by the path expression (or enclosing function) rather than
 * by line number, so the exemption does not silently widen when a genuine
 * config write is added to the same file later.
 *
 * `arg` is matched (unanchored) against the call's first argument as written.
 *
 * @type {Array<{path: string, fn?: RegExp, arg?: RegExp, reason: string}>}
 */
const NON_CONFIG_SITES = [
  {
    path: 'server/routes/admin/changelog.js',
    arg: /\b(releasesDir|versionDir)\b/,
    reason: 'Reads docs/releases/ — release notes shipped with the application, not contents/.'
  },
  {
    path: 'server/routes/admin/tools.js',
    arg: /\bscriptPath\b/,
    reason: 'Tool implementation scripts under server/tools/ are application code, not config.'
  },
  {
    path: 'server/routes/admin/ui.js',
    arg: /\b(filepath|assetsDir)\b/,
    reason: 'Uploaded UI assets (images, fonts) under contents/uploads/ — binaries, not documents.'
  },
  {
    path: 'server/routes/admin/browserExtension.js',
    arg: /\b(signingKeyPath|extDir)\b/,
    reason:
      'The extension signing key is key material (same class as TokenStorageService above); the ' +
      'manifest is read from the shipped browser-extension/ directory.'
  },
  {
    path: 'server/routes/admin/usage.js',
    arg: /\bfeedbackFile\b/,
    reason: 'contents/data/feedback.jsonl is runtime data under the provider dataDir, not config.'
  },
  {
    path: 'server/routes/admin/skills.js',
    // `skillDir` is here because `fs.cp(skillDir, targetPath)` passes the
    // source first, and the exemption matches the call's *first* argument.
    arg: /\b(destPath|skillDir|skillPathResolved|targetPath|tempDir)\b/,
    reason:
      'Skills are whole markdown directory trees under contents/skills/, installed and removed ' +
      'as a unit. They are not a configuration namespace and have no document key.'
  },
  {
    path: 'server/services/marketplace/ContentInstaller.js',
    arg: /\b(filePath|skillDir)\b/,
    reason:
      'Same skill directory trees as above — every other content type this installer writes goes ' +
      'through configStore.'
  },
  {
    path: 'server/utils/setupUtils.js',
    reason:
      'Initial setup seeds a fresh contents/ from server/defaults/ inside prepareContents(), ' +
      'before configCache and before a provider exists — the same pre-provider ordering as the ' +
      'migration runner.'
  },
  {
    path: 'server/utils/userManager.js',
    arg: /\bfullPath\b/,
    reason:
      'localAuth.usersFile may point outside contents/ (a mounted secret volume, a test temp ' +
      'dir). Such a path has no place in the store, so those reads and writes stay absolute; the ' +
      'in-contents case goes through configStore.'
  },
  {
    path: 'server/utils/oauthClientManager.js',
    arg: /\bfullPath\b/,
    reason: 'Same out-of-contents escape hatch as userManager.js, for oauth.clientsFile.'
  }
];

/**
 * Filesystem operations that read or mutate a file. `mkdir`/`stat`/`access`
 * are deliberately absent: they neither read nor write config content, and
 * banning them would bury the real findings in noise.
 *
 * @type {string[]}
 */
const FS_OPS = [
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'rename',
  'renameSync',
  'readdir',
  'readdirSync',
  // The copy and stream-open family. A config file written by copying one
  // over it is written just the same, and this list is the only thing that
  // produces a match — an op that is absent is invisible to both rules. Not
  // hypothetical: `setupUtils.js` already seeds config with `fs.copyFile`,
  // and `backup.js` and `skills.js` already use `fs.cp`, so the next
  // "restore config from backup" written as a copy would have sailed through.
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  'createReadStream',
  'open',
  'openSync',
  'truncate',
  'truncateSync'
];

/**
 * The project's atomic write helpers. They exist for exactly one purpose —
 * writing a pretty-printed JSON config file without a torn write — so their
 * appearance anywhere in scope is a finding regardless of the path expression.
 *
 * @type {string[]}
 */
const ATOMIC_HELPERS = ['atomicWriteJSON', 'atomicWriteFile', 'atomicCreateJSON'];

/** Module specifiers that yield a filesystem binding. */
const FS_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'tests', '__tests__']);

/**
 * A literal path into a configuration directory, e.g. `contents/apps` or
 * `join(root, CONTENTS_DIR, 'config', ...)`. Used only by the tree-wide rule,
 * where a hardcoded config path next to a filesystem call is the one signal
 * strong enough to act on without tracing data flow.
 *
 * @type {RegExp}
 */
const LITERAL_CONFIG_PATH = new RegExp(
  [
    // contents/config, contents/apps, contents/agents/profiles, ...
    `contents[/\\\\](?:${CONFIG_DIRS.map(d => d.replace('/', '[/\\\\]')).join('|')})\\b`,
    // join(..., 'contents', 'config', ...) and join(..., CONTENTS_DIR, 'apps', ...)
    `(?:['"\`]contents['"\`]|CONTENTS_DIR)\\s*,\\s*['"\`](?:${CONFIG_DIRS.map(d => d.split('/')[0]).join('|')})['"\`]`,
    // join(contentsDir, 'config', …) and `${contentsDir}/config/…` — the idiom
    // this codebase actually uses (`migrations/runner.js`, `ConfigStore`), and
    // the one the header names as the regression to catch. Without it a config
    // write in a file outside CONFIG_OWNING_PATHS passed in silence.
    `contentsDir\\s*,\\s*['"\`](?:${CONFIG_DIRS.map(d => d.split('/')[0]).join('|')})['"\`]`,
    `\\$\\{\\s*contentsDir\\s*\\}[/\\\\](?:${CONFIG_DIRS.map(d => d.replace('/', '[/\\\\]')).join('|')})\\b`
  ].join('|')
);

/** How many lines above a call the tree-wide rule looks for a literal config path. */
const TREE_WIDE_CONTEXT_LINES = 6;

/**
 * Escape a string so it matches itself when interpolated into a regex.
 *
 * The names interpolated below are JavaScript identifiers read out of source
 * files, and `$` is legal in one and is a regex anchor. `$el` built
 * `(?<![.\\w$])$el(?![\\w$])`, which cannot match anything — the guard went
 * quiet on exactly the code that uses that naming style, and passed. A silent
 * guard is worse than no guard. Escaping the whole metacharacter set rather
 * than the one character that happens to appear here is what stops the next
 * such name from doing it again.
 *
 * @param {string} value - Literal text to match
 * @returns {string} The same text, safe to interpolate into a pattern
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Identifiers bound to a hardcoded config path anywhere in a file, so a call
 * that receives one through a variable is caught however far from the literal
 * it sits. `const usersFile = 'contents/config/users.json'` sixty lines above
 * `fs.writeFileSync(fullPath, ...)` is the shape the six-line window misses,
 * and it is the shape a real leak in `localAuth.js` actually had.
 *
 * Binding names are collected without regard to scope: two functions in one
 * file that both call their argument `usersFilePath` are treated as the same
 * name. That is unsound in both directions — it can flag a call that never
 * touches configuration, and a renamed intermediate loses the taint — which is
 * why the taint only ever starts from {@link LITERAL_CONFIG_PATH}. A bare
 * `'tools'` in `join(rootDir, 'server', 'tools')` is not a config path and
 * does not taint anything; `'contents/tools/x.json'` is and does. A false
 * positive costs one NON_CONFIG_SITES entry with a reason, which is the price
 * of catching the indirection at all.
 *
 * @param {string} source - File source
 * @returns {Set<string>} Identifier names carrying a config path
 */
function configPathBindings(source) {
  const tainted = new Set();
  // A declarator's initializer runs to the end of the line in every shape this
  // matters for; a multi-line join() still starts on the declaration line, and
  // the fixpoint below picks up whatever it was assigned from.
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g;
  const decls = [...source.matchAll(declRe)].map(m => [m[1], m[2]]);
  // Three passes settle every chain this codebase actually builds (literal →
  // path → dirname); a fixpoint loop would be the same answer more slowly.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [name, init] of decls) {
      if (tainted.has(name)) continue;
      if (LITERAL_CONFIG_PATH.test(init)) {
        tainted.add(name);
        continue;
      }
      for (const other of tainted) {
        if (new RegExp(`(?<![.\\w$])${escapeRegExp(other)}(?![\\w$])`).test(init)) {
          tainted.add(name);
          break;
        }
      }
    }
  }
  return tainted;
}

/**
 * Verify the local CONFIG_DIRS copy still matches `server/storage/namespaces.js`.
 *
 * Read as text rather than imported: importing server code pulls in the env
 * validation and the logger, which is both slower and able to fail for reasons
 * that have nothing to do with this check.
 *
 * @returns {string[]} Human-readable drift descriptions; empty when in sync
 */
function assertNamespacesInSync() {
  const source = readFileSync(join(rootDir, 'server/storage/namespaces.js'), 'utf8');
  // Fail closed on a marker that has moved. `indexOf` answers -1 for a
  // declaration that has merely been reformatted, and slicing from -1 yields
  // the file's last character: `declared` comes out empty and the check
  // reports "in sync" having compared nothing. That is the same silent-matcher
  // failure as CodeQL 640, forty lines up — a check that stops checking while
  // still printing a pass is worse than no check, because the green is taken
  // as evidence. The drift check is what makes the duplicated CONFIG_DIRS list
  // safe; once it is dead, a new raw namespace is never added here and direct
  // writes under that directory fall outside the scan.
  const at = source.indexOf('CONFIG_NAMESPACES = Object.freeze({');
  if (at === -1) {
    return [
      'scripts/check-config-fs-access.js can no longer find the CONFIG_NAMESPACES ' +
        'declaration in server/storage/namespaces.js — the drift check is dead. Fix the ' +
        'marker this guard looks for.'
    ];
  }
  // Bounded at the declaration's close rather than running to EOF, so a later
  // `dir: '…'` literal elsewhere in the file is not a phantom drift report.
  const end = source.indexOf('\n});', at);
  const body = source.slice(at, end === -1 ? undefined : end);
  const declared = new Set([...body.matchAll(/dir:\s*'([^']+)'/g)].map(m => m[1]));
  if (declared.size === 0) {
    return [
      'CONFIG_NAMESPACES parsed to zero namespaces — the drift check is not checking ' +
        'anything. Fix the parse in scripts/check-config-fs-access.js.'
    ];
  }
  const known = new Set(CONFIG_DIRS);
  const problems = [];
  for (const dir of declared) {
    if (!known.has(dir)) {
      problems.push(
        `server/storage/namespaces.js declares the raw namespace directory '${dir}', which ` +
          `CONFIG_DIRS in this guard does not list — add it there so the guard covers it.`
      );
    }
  }
  return problems;
}

/**
 * Collect every `.js` file under a directory, skipping vendored and test trees.
 *
 * @param {string} absDir - Absolute directory to walk
 * @param {string[]} [out] - Accumulator
 * @returns {string[]} Absolute file paths
 */
function collectJsFiles(absDir, out = []) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectJsFiles(join(absDir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(join(absDir, entry.name));
    }
  }
  return out;
}

/**
 * Normalise a path to the repo-relative, forward-slash form the allowlists use.
 *
 * @param {string} absPath - Absolute path
 * @returns {string} e.g. `server/routes/admin/apps.js`
 */
function toRepoPath(absPath) {
  return relative(rootDir, absPath).split(sep).join('/');
}

/**
 * @param {string} repoPath - Repo-relative path
 * @param {string[]} prefixes - Entries ending in `/` match as directory prefixes
 * @returns {boolean}
 */
function matchesAny(repoPath, prefixes) {
  return prefixes.some(p => (p.endsWith('/') ? repoPath.startsWith(p) : repoPath === p));
}

/**
 * Identifiers in a file that are bound to the filesystem module, split into
 * namespace bindings (`fs.readFile(...)`) and named bindings (`readFile(...)`).
 *
 * @param {string} source - File contents
 * `named` maps the **local** name to the **imported** name. Keeping only the
 * local was a hole: the local is what appears at the call site, but the
 * imported name is what says whether it is a filesystem operation, so
 * `import { writeFileSync as wf }` matched nothing and the guard passed. The
 * house style already renames — `import { promises as fs }` appears in about
 * fourteen server files — so hitting a name collision and renaming around it
 * is an ordinary thing for a contributor to do.
 *
 * @returns {{namespaces: Set<string>, named: Map<string, string>}}
 */
function findFsBindings(source) {
  const namespaces = new Set();
  const named = new Map();
  const importRe = /import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    if (!FS_MODULES.has(match[2])) continue;
    const clause = match[1].trim();
    const braceStart = clause.indexOf('{');
    const head = (braceStart === -1 ? clause : clause.slice(0, braceStart)).replace(/,\s*$/, '');
    // `import fs from 'fs'` / `import * as fs from 'fs'`
    const headName = head.replace(/^\*\s*as\s+/, '').trim();
    if (headName) namespaces.add(headName);
    if (braceStart !== -1) {
      const inner = clause.slice(braceStart + 1, clause.lastIndexOf('}'));
      for (const spec of inner.split(',')) {
        const [imported, local] = spec.split(/\s+as\s+/).map(s => s.trim());
        if (!imported) continue;
        // `{ promises as fs }` is a namespace; every other named import is a
        // bare callable in this file.
        if (imported === 'promises') namespaces.add(local || imported);
        else named.set(local || imported, imported);
      }
    }
  }
  // `const fs = await import('fs')` / `const fs = require('fs')` — rare, but a
  // guard that can be stepped around by changing the import form is no guard.
  const dynamicRe =
    /(?:const|let|var)\s+(?:\{\s*promises\s*:\s*)?([A-Za-z0-9_$]+)\s*\}?\s*=\s*(?:await\s+import|require)\(\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(dynamicRe)) {
    if (FS_MODULES.has(match[2])) namespaces.add(match[1]);
  }

  // `const { writeFile } = await import('fs/promises')` and
  // `const { writeFileSync } = fs;` — both reach an fs call through a bare
  // local the clauses above never see.
  const destructuredRe =
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:(?:await\s+import|require)\(\s*['"]([^'"]+)['"]\s*\)|([A-Za-z0-9_$]+)(?:\.promises)?)/g;
  for (const match of source.matchAll(destructuredRe)) {
    const fromModule = match[2];
    const fromNamespace = match[3];
    const isFs =
      (fromModule && FS_MODULES.has(fromModule)) ||
      (fromNamespace && namespaces.has(fromNamespace));
    if (!isFs) continue;
    for (const spec of match[1].split(',')) {
      const [imported, local] = spec.split(':').map(part => part.trim());
      if (!imported) continue;
      if (imported === 'promises') namespaces.add(local || imported);
      else named.set(local || imported, imported);
    }
  }
  return { namespaces, named };
}

/**
 * Extract a call's first argument as written, so an allowlist can pin the path
 * expression instead of a line number.
 *
 * @param {string} source - File contents
 * @param {number} openParenIndex - Index of the call's `(`
 * @returns {string} The first argument, whitespace-collapsed, or `''`
 */
function firstArgument(source, openParenIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openParenIndex; i < source.length && i < openParenIndex + 2000; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0)
        return source
          .slice(openParenIndex + 1, i)
          .replace(/\s+/g, ' ')
          .trim();
    } else if (ch === ',' && depth === 1) {
      return source
        .slice(openParenIndex + 1, i)
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return '';
}

/**
 * Name of the function a line sits in, for allowlists that are clearer keyed
 * on the function than on the path expression.
 *
 * @param {string[]} lines - File split into lines
 * @param {number} lineIndex - Zero-based index of the call
 * @returns {string} Function name, or `''` when the call is in an anonymous scope
 */
function enclosingFunction(lines, lineIndex) {
  // `if (…) {`, `catch (…) {` and friends are shaped exactly like a class
  // method declaration, so the method pattern has to rule them out by name.
  const notKeyword = '(?!(?:if|for|while|switch|catch|do|else|return|with|function)\\b)';
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\()/,
    new RegExp(
      `^\\s{2,}(?:static\\s+)?(?:async\\s+)?${notKeyword}([A-Za-z0-9_$]+)\\s*\\([^)]*\\)\\s*\\{\\s*$`
    )
  ];
  for (let i = lineIndex; i >= 0; i -= 1) {
    for (const pattern of patterns) {
      const match = pattern.exec(lines[i]);
      if (match) return match[1];
    }
  }
  return '';
}

/**
 * Does an allowlist entry cover this call site?
 *
 * @param {{path: string, fn?: RegExp, arg?: RegExp}} entry - Allowlist entry
 * @param {{repoPath: string, arg: string, fn: string}} site - The call site
 * @returns {boolean}
 */
function entryCovers(entry, site) {
  if (!matchesAny(site.repoPath, [entry.path])) return false;
  if (entry.fn && !entry.fn.test(site.fn)) return false;
  if (entry.arg && !entry.arg.test(site.arg)) return false;
  return true;
}

/**
 * Find every filesystem call in one file.
 *
 * @param {string} repoPath - Repo-relative path
 * @param {string} source - File contents
 * @returns {Array<{repoPath: string, line: number, column: number, symbol: string, arg: string, fn: string, text: string}>}
 */
function findFsCalls(repoPath, source) {
  const { namespaces, named } = findFsBindings(source);
  const lines = source.split('\n');
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const alternatives = [];
  for (const ns of namespaces) {
    const escaped = escapeRegExp(ns);
    alternatives.push(`${escaped}\\s*\\.\\s*(?:promises\\s*\\.\\s*)?(${FS_OPS.join('|')})\\s*\\(`);
  }
  // Filter on what was imported, match on what is called. `escapeRegExp` is
  // load-bearing now that these are arbitrary local identifiers rather than a
  // fixed list.
  const bareNames = [...named.entries()]
    .filter(([, imported]) => FS_OPS.includes(imported))
    .map(([local]) => escapeRegExp(local))
    .concat(ATOMIC_HELPERS);
  if (bareNames.length) {
    alternatives.push(`(?<![.\\w$])(${bareNames.join('|')})\\s*\\(`);
  }
  if (!alternatives.length) return [];

  const callRe = new RegExp(alternatives.join('|'), 'g');
  const found = [];
  for (const match of source.matchAll(callRe)) {
    const symbol = match.slice(1).find(Boolean);
    const index = match.index;
    let lineIndex = lineStarts.findIndex(start => start > index);
    lineIndex = lineIndex === -1 ? lines.length - 1 : lineIndex - 1;
    const text = lines[lineIndex].trim();
    // A mention inside a comment or a JSDoc block is documentation, not access.
    if (/^\s*(\*|\/\/)/.test(lines[lineIndex])) continue;
    found.push({
      repoPath,
      line: lineIndex + 1,
      column: index - lineStarts[lineIndex] + 1,
      symbol,
      arg: firstArgument(source, index + match[0].length - 1),
      fn: enclosingFunction(lines, lineIndex),
      text: text.length > 110 ? `${text.slice(0, 107)}...` : text
    });
  }
  return found;
}

/**
 * Run both rules over the tree.
 *
 * @returns {{violations: object[], exempted: number, scanned: number, unused: object[]}}
 */
function scan() {
  const files = collectJsFiles(join(rootDir, 'server'));
  const violations = [];
  // An exemption whose call site is gone has outlived its reason. Tracking use
  // is what stops the two lists growing into a graveyard nobody dares prune.
  const used = new Set();
  let exempted = 0;
  let scanned = 0;

  for (const absPath of files) {
    const repoPath = toRepoPath(absPath);
    if (matchesAny(repoPath, SEAM_PATHS)) continue;
    if (repoPath.endsWith('.test.js')) continue;

    const inScope = matchesAny(repoPath, CONFIG_OWNING_PATHS);
    // Whole-file contract exclusions are read for nothing, so skip the I/O.
    const wholeFile = CONTRACT_EXCLUSIONS.find(
      e => !e.fn && !e.arg && matchesAny(repoPath, [e.path])
    );
    if (inScope && wholeFile) {
      used.add(wholeFile);
      continue;
    }

    const source = readFileSync(absPath, 'utf8');
    // Both tree-wide rules start from a hardcoded config path, so a file
    // without one is not worth tokenizing.
    if (!inScope && !LITERAL_CONFIG_PATH.test(source)) continue;
    scanned += 1;

    const lines = source.split('\n');
    const bound = inScope ? null : configPathBindings(source);
    for (const site of findFsCalls(repoPath, source)) {
      const entry =
        CONTRACT_EXCLUSIONS.find(e => entryCovers(e, site)) ||
        NON_CONFIG_SITES.find(e => entryCovers(e, site));
      if (entry) {
        used.add(entry);
        exempted += 1;
        continue;
      }
      if (inScope) {
        violations.push({ ...site, rule: 'config-owning-file' });
        continue;
      }
      const from = Math.max(0, site.line - 1 - TREE_WIDE_CONTEXT_LINES);
      const window = lines.slice(from, site.line).join('\n');
      if (LITERAL_CONFIG_PATH.test(window)) {
        violations.push({ ...site, rule: 'hardcoded-config-path' });
        continue;
      }
      const carries = [...bound].some(name =>
        new RegExp(`(?<![.\\w$])${escapeRegExp(name)}(?![\\w$])`).test(site.arg || '')
      );
      if (carries) {
        violations.push({ ...site, rule: 'config-path-binding' });
      }
    }
  }

  const unused = [...CONTRACT_EXCLUSIONS, ...NON_CONFIG_SITES].filter(e => !used.has(e));
  return { violations, exempted, scanned, unused };
}

/**
 * Wrap a reason at 96 columns and indent continuation lines.
 *
 * @param {string} reason - The reason text
 * @param {string} indent - Leading whitespace for continuation lines
 * @returns {string}
 */
function wrapReason(reason, indent) {
  const out = [];
  let line = '';
  for (const word of reason.split(' ')) {
    if (line && `${line} ${word}`.length > 96 - indent.length) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join(`\n${indent}`);
}

/**
 * How an allowlist entry is printed: the path, plus the qualifier that narrows
 * it to particular call sites. Both `fn` and `arg` narrow, so printing only
 * `fn` would have shown a per-argument exemption as if it covered the whole
 * file — which is the opposite of what the exception list is for.
 *
 * @param {{path: string, fn?: RegExp, arg?: RegExp}} entry - Allowlist entry
 * @returns {string}
 */
function describeScope(entry) {
  const qualifier = entry.fn?.source || entry.arg?.source;
  return qualifier ? `${entry.path} (${qualifier})` : entry.path;
}

/** Run the guard and exit 0 (clean) or 1 (violations, drift or stale exceptions). */
function main() {
  const quiet = process.argv.includes('--quiet');
  const drift = assertNamespacesInSync();
  const { violations, exempted, scanned, unused } = scan();

  if (!quiet) {
    console.log('Config filesystem-access guard');
    console.log(
      `  Configuration is read and written through ConfigStore; ${scanned} source file(s) checked.`
    );
    console.log('');
    console.log('  Documented exceptions (contract #2307 section 1):');
    for (const entry of CONTRACT_EXCLUSIONS) {
      console.log(`    - ${describeScope(entry)}`);
      console.log(`      ${wrapReason(entry.reason, '      ')}`);
    }
    console.log('');
    console.log('  Sites that are not configuration (uploads, scripts, key material, skills):');
    for (const entry of NON_CONFIG_SITES) {
      console.log(`    - ${entry.path}`);
      console.log(`      ${wrapReason(entry.reason, '      ')}`);
    }
    console.log('');
    console.log(`  ${exempted} exempted call site(s) matched the lists above.`);
    console.log('');
  }

  if (drift.length) {
    console.error('Config namespace map drift:');
    for (const problem of drift) console.error(`  - ${problem}`);
    console.error('');
  }

  if (unused.length) {
    console.error(`FAIL: ${unused.length} exception(s) no longer match any call site.`);
    console.error('  The code they justified is gone. Delete the entry from');
    console.error('  scripts/check-config-fs-access.js rather than leaving a reason');
    console.error('  standing for something that no longer happens:');
    for (const entry of unused) {
      console.error(`    - ${describeScope(entry)}`);
    }
    console.error('');
  }

  if (!violations.length && !drift.length && !unused.length) {
    if (!quiet)
      console.log('PASS: no direct filesystem configuration access outside the provider.');
    process.exit(0);
  }

  if (violations.length) {
    console.error(`FAIL: ${violations.length} direct filesystem configuration access(es).`);
    console.error('');
    const byFile = new Map();
    for (const v of violations) {
      if (!byFile.has(v.repoPath)) byFile.set(v.repoPath, []);
      byFile.get(v.repoPath).push(v);
    }
    for (const [file, sites] of [...byFile].sort()) {
      console.error(`  ${file}`);
      for (const site of sites.sort((a, b) => a.line - b.line)) {
        console.error(`    ${site.line}:${site.column}  ${site.symbol}  ${site.text}`);
      }
      console.error('');
    }
    console.error('  Configuration goes through the store, not the filesystem:');
    console.error("    import configStore from '<...>/services/config/ConfigStore.js';");
    console.error("    const data = await configStore.readJson('config/platform.json');");
    console.error("    await configStore.writeJson('apps/my-app.json', app);");
    console.error("    await configStore.remove('apps/my-app.json');");
    console.error("    const ids = await configStore.list('apps');");
    console.error('');
    console.error('  A read returns null for a missing, unreadable or malformed file — it never');
    console.error('  throws and never returns {}. Writes are atomic and byte-identical to what');
    console.error("  atomicWriteJSON produced, so an installation's contents/ does not churn.");
    console.error('');
    console.error('  If the path is genuinely not configuration, or genuinely cannot go through');
    console.error('  the provider, add it to NON_CONFIG_SITES or CONTRACT_EXCLUSIONS in');
    console.error('  scripts/check-config-fs-access.js with the reason — and to docs/storage.md');
    console.error('  if it is an architectural exception rather than simply a non-config path.');
  }

  process.exit(1);
}

main();
