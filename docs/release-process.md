# Release Process

This document describes the automated release process for iHub Apps: version synchronization
between GitHub releases and the `package.json` files, and how release notes reach the in-product
changelog.

## Overview

When creating a GitHub release, the system automatically:

1. **Syncs version numbers** between the release tag and all `package.json` files
2. **Publishes the release notes** written in `docs/releases/next/` under the release's version
3. **Builds binaries** for Linux, macOS, and Windows
4. **Builds Docker images** and publishes them to GitHub Container Registry
5. **Updates documentation** with the new version
6. **Commits the version and release-notes changes** back to the default branch

## Release Workflow

### 1. Creating a Release

When you create a new release with tag `v3.4.0`:

1. **Binary Build Workflow** (`.github/workflows/build-binaries.yml`) triggers
2. **Docker CI Workflow** (`.github/workflows/docker-ci.yml`) triggers

### 2. Version Synchronization

The system automatically updates:

- **Root package.json**: `3.3.0` → `3.4.0`
- **client/package.json**: Updates to match release version
- **server/package.json**: Updates to match release version
- **Documentation**: Updates version display in README.md and HTML metadata

### 3. Release Notes

Release notes live in `docs/releases/` and are shown in **Admin → What's New**:

- `docs/releases/next/` holds the entries for everything merged since the last release. Every PR
  with a visible change adds its entry there (the `/document-feature` skill enforces the rules).
- `docs/releases/<version>/` holds exactly what shipped in that release.

During a release, `scripts/finalize-release-notes.js` moves `next/` under the version:

1. In the build jobs it runs on the tagged checkout without committing, so the binaries and the
   Docker image ship `docs/releases/3.4.0/` and their changelog lists the release by number.
2. In the commit-back job it runs on the default branch with `--from-ref v3.4.0 --commit`: the
   entries `next/` held **at the tag** are written to `docs/releases/3.4.0/`, only the files with
   entries are created, and entries that were merged after the tag stay in `next/`.
3. If `next/` had no entries, nothing is created and the changelog does not list the release.
   If `docs/releases/3.4.0/` already exists (a re-run), nothing is changed.

Because the build then regenerates the **iHub Documentation** knowledge source
(`scripts/export-docs-markdown.js`, run by `build:server` and `build-sea.sh`), the binaries and the
Docker image also ship the current documentation with the release notes of every release up to
and including `3.4.0`. Installations re-sync that file into `contents/` on startup, so the iHub
Support Bot answers from the documentation of the version it runs. See
[Sources System](sources.md#built-in-sources).

### 4. Build Process

**Binary Builds:**

- Creates standalone executables for Linux, macOS, Windows
- Uses Node.js SEA (Single Executable Application) feature
- Archives binaries with versioned names: `ihub-apps-v3.4.0-linux.tar.gz`

**Docker Builds:**

- Builds and publishes Docker images with proper version tags
- Performs security scanning with Trivy
- Tests container startup before publishing

### 5. Automated Commit Back

After a successful build, the `commit-version` job checks out the **default branch** and pushes
two commits to it:

- `chore: update version to 3.4.0 for release v3.4.0` — the `package.json` and documentation
  version bump
- `docs(releases): publish release notes for v3.4.0` — `docs/releases/next/` →
  `docs/releases/3.4.0/`

If another merge lands on the branch meanwhile, the job rebases and retries the push a few times.
The job pushes to the default branch by name: the release event checks out the tag, and pushing to
`github.ref_name` would try to move the tag instead. Attaching the binaries to the release does not
depend on this job succeeding.

## Manual Version Sync

You can manually sync versions using the provided script:

```bash
# Sync version without committing
npm run version:sync v3.4.0

# Sync version and commit changes
node scripts/sync-release-version.js v3.4.0 --commit
```

## Manual Release Notes Publishing

```bash
# Move what docs/releases/next/ holds in the working tree under 3.4.0
node scripts/finalize-release-notes.js v3.4.0

# Take the entries as they were at the tag, keep later ones in next/, and commit
node scripts/finalize-release-notes.js v3.4.0 --from-ref v3.4.0 --commit
```

## Script Details

### `scripts/sync-release-version.js`

This script handles:

- **Version Extraction**: Removes 'v' prefix from release tags
- **Package.json Updates**: Updates root, client, and server package.json files
- **Documentation Updates**: Calls `npm run docs:update-version` to update docs
- **Git Commits**: Optional automatic commit with `--commit` flag

Features:

- **Idempotent**: Safe to run multiple times with same version
- **Comprehensive**: Updates all package.json files and documentation
- **Flexible**: Works with or without 'v' prefix in version tags
- **Safe**: Validates input and provides clear error messages

### `scripts/finalize-release-notes.js`

This script handles:

- **Publishing**: Writes the entries of `docs/releases/next/` to `docs/releases/<version>/`,
  one file per section that has entries, with the version in each file's title
- **Source selection**: The working tree by default, or `--from-ref <ref>` to read `next/` as it
  was at a git ref (the tag) when the branch has moved on
- **Trimming `next/`**: Removes the published entries from `next/` (matched by title) and leaves
  the three heading-only files behind
- **Git Commits**: Optional automatic commit with `--commit`

It exits successfully without changes when there is nothing to publish or when the version's
directory already exists, so a release build never fails on its notes. The parsing rules it shares
with the admin endpoint live in `server/utils/releaseNotes.js`.

## Workflow Files

1. **`.github/workflows/build-binaries.yml`**:
   - Version sync and release-notes publishing before building
   - `commit-version` job pushing both commits to the default branch
   - `release` job attaching binaries regardless of the commit-back's outcome

2. **`.github/workflows/docker-ci.yml`**:
   - Version sync and release-notes publishing before the Docker build
   - Ensures Docker images have correct version metadata and release notes

## Version Format

- **Release Tags**: `v3.4.0` (with 'v' prefix)
- **Package.json**: `3.4.0` (semantic version without prefix)
- **Release notes directory**: `docs/releases/3.4.0/`
- **Documentation**: `Version: 3.4.0` (displayed in README)
- **HTML Metadata**: `<meta name="version" content="3.4.0">`

## Troubleshooting

### Version Mismatch

If versions get out of sync, manually run:

```bash
node scripts/sync-release-version.js v3.4.0
```

### Release Notes Missing From a Release

If a release shows no entry in **What's New** although `next/` had entries at the tag, run the
publish step by hand on the default branch and push:

```bash
git fetch --tags
node scripts/finalize-release-notes.js v3.4.0 --from-ref v3.4.0 --commit
```

### Failed Builds

Check GitHub Actions logs for:

- Permission issues (needs `contents: write`)
- Git configuration (automatically handled by the scripts)
- Network issues during npm install or git operations

### Commit Failures

The commit-back job:

- Configures the git user if not set
- Checks for changes before attempting a commit
- Rebases onto the latest default branch and retries the push
- Fails visibly (without blocking the release assets) when the push is rejected — for example by a
  branch protection rule that GitHub Actions is not allowed to bypass

## Future Enhancements

Potential improvements to consider:

- **GitHub release body**: Copy the published release notes into the GitHub release description
- **Pre-release Support**: Handle alpha, beta, rc versions
- **Multi-branch Support**: Support releases from different branches
- **Rollback Mechanism**: Ability to revert failed releases
