#!/usr/bin/env node

/**
 * CI guard: a pull request's new migrations must not collide with the
 * migrations already on the base branch.
 *
 * Migration numbers are picked as "highest on disk + 1". Two branches opened
 * from the same main therefore both pick the same number, and each is green
 * on its own. Whichever merges second leaves main with two V<NNN> files, and
 * the runner refuses to boot on a duplicate version (see RENAMED_MIGRATIONS in
 * server/migrations/runner.js for how often that has happened).
 *
 * GitHub builds a pull request against the base as it was when the PR was last
 * pushed, so that check does not notice when another PR takes the number in the
 * meantime. This guard fetches the *current* base branch and compares the
 * migrations the PR adds (relative to its merge base) against it:
 *
 *   - duplicate:    the base already has a different file with the same version
 *   - out of order: the base already has a higher version, so upgraded installs
 *                   would run this migration after that one while fresh
 *                   installs run it before
 *   - mismatch:     the file's `export const version` differs from its name
 *   - self-duplicate: the PR itself adds two files with the same version
 *
 * The migration-version-check workflow re-runs this for open PRs whenever
 * migrations land on the base branch, so the second PR turns red as soon as
 * the first one merges rather than on its next push.
 *
 * Usage:
 *   node scripts/check-migration-versions.js [--base <ref>] [--head <ref>]
 *
 *   --base  ref holding the current base branch (default: origin/main)
 *   --head  ref holding the PR head (default: HEAD)
 */

import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { fileURLToPath } from 'url';

export const MIGRATIONS_DIR = 'server/migrations';
const MIGRATION_FILE_PATTERN = /^V(\d{3})__(.+)\.js$/;
const VERSION_EXPORT_PATTERN = /export\s+const\s+version\s*=\s*['"](\d+)['"]/;

/**
 * Parse migration file names into { version, file }, ignoring anything that
 * isn't a migration (runner.js, utils.js, README.md).
 * @param {string[]} names
 */
export function parseMigrationFiles(names) {
  return names
    .map(name => {
      const match = name.match(MIGRATION_FILE_PATTERN);
      return match ? { version: match[1], file: name } : null;
    })
    .filter(Boolean);
}

/**
 * Compare the migrations a PR adds against the migrations on the base branch.
 *
 * @param {object} params
 * @param {string[]} params.baseFiles - migration file names on the current base branch
 * @param {string[]} params.addedFiles - migration file names the PR adds
 * @param {(file: string) => string | null} [params.readSource] - source of an added file
 * @returns {{ problems: Array<{file: string, kind: string, message: string}>, nextVersion: string }}
 */
export function findMigrationConflicts({ baseFiles, addedFiles, readSource = () => null }) {
  const base = parseMigrationFiles(baseFiles);
  const added = parseMigrationFiles(addedFiles).filter(m => !baseFiles.includes(m.file));

  const baseByVersion = new Map(base.map(m => [m.version, m.file]));
  const baseMax = base.reduce((max, m) => Math.max(max, Number(m.version)), 0);
  const problems = [];

  const addedByVersion = new Map();
  for (const m of added) {
    const list = addedByVersion.get(m.version) || [];
    list.push(m.file);
    addedByVersion.set(m.version, list);
  }

  for (const m of added) {
    const onBase = baseByVersion.get(m.version);
    if (onBase) {
      problems.push({
        file: m.file,
        kind: 'duplicate',
        message: `V${m.version} is already taken on the base branch by ${onBase}.`
      });
    } else if (Number(m.version) < baseMax) {
      problems.push({
        file: m.file,
        kind: 'out-of-order',
        message: `V${m.version} is lower than V${pad(baseMax)}, the highest migration on the base branch. Installs that already ran V${pad(baseMax)} would apply it out of order.`
      });
    }

    const siblings = addedByVersion.get(m.version);
    if (siblings.length > 1) {
      problems.push({
        file: m.file,
        kind: 'self-duplicate',
        message: `V${m.version} is used by more than one file in this PR: ${siblings.join(', ')}.`
      });
    }

    const source = readSource(m.file);
    if (source != null) {
      const declared = source.match(VERSION_EXPORT_PATTERN)?.[1];
      if (declared !== m.version) {
        problems.push({
          file: m.file,
          kind: 'mismatch',
          message: declared
            ? `The file name says V${m.version} but it exports version '${declared}'.`
            : `The file does not export \`const version = '${m.version}'\`.`
        });
      }
    }
  }

  return { problems, nextVersion: pad(baseMax + 1) };
}

function pad(n) {
  return String(n).padStart(3, '0');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function listMigrations(ref) {
  const out = git(['ls-tree', '--name-only', `${ref}:${MIGRATIONS_DIR}`]);
  return out ? out.split('\n') : [];
}

function parseArgs(argv) {
  const args = { base: 'origin/main', head: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--head') args.head = argv[++i];
  }
  return args;
}

function main() {
  const { base, head } = parseArgs(process.argv.slice(2));

  const mergeBase = git(['merge-base', base, head]);
  const forkFiles = new Set(listMigrations(mergeBase));
  const baseFiles = listMigrations(base);
  const addedFiles = listMigrations(head).filter(f => !forkFiles.has(f));

  const { problems, nextVersion } = findMigrationConflicts({
    baseFiles,
    addedFiles,
    readSource: file => git(['show', `${head}:${MIGRATIONS_DIR}/${file}`])
  });

  const added = parseMigrationFiles(addedFiles);
  if (added.length === 0) {
    console.log('This PR adds no migrations.');
    return;
  }

  console.log(`Base: ${base}. Migrations added by this PR: ${added.map(m => m.file).join(', ')}`);

  if (problems.length === 0) {
    console.log('No migration version conflicts with the base branch.');
    return;
  }

  const lines = problems.map(p => `- \`${p.file}\` (${p.kind}): ${p.message}`);
  const advice = [
    '',
    `The next free version on the base branch is **V${nextVersion}**. To fix:`,
    '',
    `1. Merge the base branch into this PR.`,
    `2. Rename each conflicting migration to the next free number(s) starting at V${nextVersion}, keeping their relative order.`,
    `3. Update \`export const version\` and the JSDoc header in the file, the matching \`server/tests/migration-v<NNN>.test.js\` and its entry in \`test:migrations\` in package.json.`,
    `4. If the old number was ever run outside CI (a shared dev or test install), add a \`RENAMED_MIGRATIONS\` entry in \`server/migrations/runner.js\`.`
  ];

  for (const p of problems) {
    console.log(`::error file=${MIGRATIONS_DIR}/${p.file}::${p.message}`);
  }
  console.log(['', 'Migration version conflicts:', ...lines, ...advice].join('\n'));

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['## Migration version conflicts', '', ...lines, ...advice, ''].join('\n')
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
