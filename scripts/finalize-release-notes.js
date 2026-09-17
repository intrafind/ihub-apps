#!/usr/bin/env node

/**
 * Publish the unreleased release notes under a release tag.
 *
 * Release notes are written to `docs/releases/next/` while work is unreleased. When a release is
 * tagged, this script moves what `next/` held at that moment to `docs/releases/<version>/`, so the
 * in-product changelog shows every release with exactly the notes for what it shipped — and only
 * when there is something to show.
 *
 *   node scripts/finalize-release-notes.js <tag> [--from-ref <ref>] [--commit]
 *
 *   <tag>            the release tag, `v5.5.8` or `5.5.8`
 *   --from-ref <ref> take the released entries from `docs/releases/next/` at that git ref
 *                    (normally the tag itself) instead of the working tree. Use this on a branch
 *                    that may have moved on since the tag: only the entries that were in `next/`
 *                    at the ref are published, and entries that landed afterwards stay in `next/`.
 *   --commit         `git add` and commit the result
 *
 * Nothing happens when `next/` has no entries (a release that only carried refactors) or when
 * `docs/releases/<version>/` already exists (the notes for that release were published before,
 * e.g. by a re-run). Both exit 0 so a release build never fails on its notes.
 *
 * Used by `.github/workflows/build-binaries.yml` and `docker-ci.yml`: once without `--commit` in
 * the build (so the artifact ships the right directory), and once with `--from-ref <tag> --commit`
 * on the default branch after the release. Safe to run by hand.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  RELEASE_SECTIONS,
  UNRELEASED_VERSION,
  countEntries,
  isReleaseVersionName,
  normalizeVersion,
  parseReleaseNotes,
  renderReleaseNotes,
  subtractEntries
} from '../server/utils/releaseNotes.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const releasesDir = join(rootDir, 'docs', 'releases');
const nextDir = join(releasesDir, UNRELEASED_VERSION);
const nextRelPath = `docs/releases/${UNRELEASED_VERSION}`;

function usage(message) {
  if (message) console.error(`❌ ${message}`);
  console.error(
    'Usage: node scripts/finalize-release-notes.js <tag> [--from-ref <ref>] [--commit]'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const options = { tag: null, fromRef: null, commit: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') {
      options.commit = true;
    } else if (arg === '--from-ref') {
      options.fromRef = argv[++i];
      if (!options.fromRef) usage('--from-ref needs a git ref');
    } else if (arg.startsWith('--')) {
      usage(`Unknown option ${arg}`);
    } else if (options.tag === null) {
      options.tag = arg;
    } else {
      usage(`Unexpected argument ${arg}`);
    }
  }
  if (!options.tag) usage('Release tag is required');
  return options;
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', ...options });
}

function readWorkingTreeFile(file) {
  const path = join(nextDir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** `docs/releases/next/<file>` as committed at `ref`; '' when the file did not exist there. */
function readRefFile(ref, file) {
  try {
    return git(['show', `${ref}:${nextRelPath}/${file}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function assertRefExists(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'pipe' });
  } catch {
    console.error(`❌ Git ref "${ref}" does not exist in this checkout (are tags fetched?)`);
    process.exit(1);
  }
}

function commit(tag, summary) {
  try {
    git(['config', '--get', 'user.email'], { stdio: 'ignore' });
  } catch {
    git(['config', 'user.email', 'action@github.com']);
    git(['config', 'user.name', 'GitHub Action']);
  }

  git(['add', '-A', 'docs/releases']);
  try {
    git(['diff', '--cached', '--quiet'], { stdio: 'ignore' });
    console.log('ℹ️ No release-notes changes to commit');
    return;
  } catch {
    // staged changes present
  }

  git(['commit', '-m', `docs(releases): publish release notes for ${tag}`, '-m', summary], {
    stdio: 'inherit'
  });
  console.log(`✅ Committed release notes for ${tag}`);
}

function main() {
  const { tag, fromRef, commit: shouldCommit } = parseArgs(process.argv.slice(2));
  const version = normalizeVersion(tag);

  if (!isReleaseVersionName(version) || version === UNRELEASED_VERSION) {
    usage(`"${tag}" is not a release version (expected e.g. v5.5.8 or 5.5.8)`);
  }

  if (fromRef) assertRefExists(fromRef);
  const source = fromRef ? `${nextRelPath} at ${fromRef}` : `${nextRelPath} (working tree)`;
  console.log(`📝 Publishing release notes for ${tag} from ${source}`);

  // What shipped: the entries `next/` held at the release.
  const released = {};
  for (const section of RELEASE_SECTIONS) {
    const markdown = fromRef
      ? readRefFile(fromRef, section.file)
      : readWorkingTreeFile(section.file);
    released[section.key] = parseReleaseNotes(markdown);
  }
  const counts = countEntries(released);
  if (counts.total === 0) {
    console.log(`ℹ️ Nothing to publish: ${source} has no entries`);
    return;
  }

  const targetDir = join(releasesDir, version);
  if (existsSync(targetDir)) {
    console.log(
      `ℹ️ ${relative(rootDir, targetDir)} already exists — release notes for ${version} were published before; leaving it and ${nextRelPath} untouched`
    );
    return;
  }

  // Frozen copy under the version. Only sections with entries get a file.
  mkdirSync(targetDir, { recursive: true });
  const lines = [];
  for (const section of RELEASE_SECTIONS) {
    const { entries, preamble } = released[section.key];
    if (entries.length === 0) continue;
    writeFileSync(
      join(targetDir, section.file),
      renderReleaseNotes({ sectionTitle: section.title, version, entries, preamble })
    );
    lines.push(`${entries.length} ${section.title.toLowerCase()}`);
    console.log(
      `✅ ${relative(rootDir, join(targetDir, section.file))}: ${entries.length} entries`
    );
  }

  // Whatever landed in `next/` after the release stays unreleased; the rest is gone from it.
  mkdirSync(nextDir, { recursive: true });
  let remainingTotal = 0;
  for (const section of RELEASE_SECTIONS) {
    const current = parseReleaseNotes(readWorkingTreeFile(section.file));
    const remaining = subtractEntries(current.entries, released[section.key].entries);
    remainingTotal += remaining.length;
    writeFileSync(
      join(nextDir, section.file),
      renderReleaseNotes({
        sectionTitle: section.title,
        version: UNRELEASED_VERSION,
        entries: remaining,
        preamble: current.preamble
      })
    );
  }
  console.log(
    `✅ Published ${counts.total} entries to ${relative(rootDir, targetDir)}; ${remainingTotal} remain unreleased in ${nextRelPath}`
  );

  if (shouldCommit) {
    commit(tag, `Moved from ${nextRelPath}: ${lines.join(', ')}.`);
  } else {
    console.log('ℹ️ Use --commit to commit the result');
  }
}

main();
