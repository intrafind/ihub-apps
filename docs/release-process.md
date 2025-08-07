# Release Process

This document describes the automated release process for iHub Apps, including version synchronization between GitHub releases and package.json files.

## Overview

When creating a GitHub release, the system automatically:

1. **Syncs version numbers** between the release tag and all package.json files
2. **Builds binaries** for Linux, macOS, and Windows
3. **Builds Docker images** and publishes them to GitHub Container Registry
4. **Updates documentation** with the new version
5. **Commits version changes** back to the repository

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

### 3. Build Process

**Binary Builds:**
- Creates standalone executables for Linux, macOS, Windows
- Uses Node.js SEA (Single Executable Application) feature
- Archives binaries with versioned names: `ai-hub-apps-v3.4.0-linux.tar.gz`

**Docker Builds:**
- Builds and publishes Docker images with proper version tags
- Performs security scanning with Trivy
- Tests container startup before publishing

### 4. Automated Commit Back

After successful builds, the system:
- Commits the updated package.json files back to the repository
- Uses commit message format: `chore: update version to 3.4.0 for release v3.4.0`
- Pushes changes to the main branch

## Manual Version Sync

You can manually sync versions using the provided script:

```bash
# Sync version without committing
npm run version:sync v3.4.0

# Sync version and commit changes
node scripts/sync-release-version.js v3.4.0 --commit
```

## Script Details

### `scripts/sync-release-version.js`

This script handles:

- **Version Extraction**: Removes 'v' prefix from release tags
- **Package.json Updates**: Updates root, client, and server package.json files
- **Documentation Updates**: Calls `npm run docs:update-version` to update docs
- **Git Commits**: Optional automatic commit with `--commit` flag

### Features

- **Idempotent**: Safe to run multiple times with same version
- **Comprehensive**: Updates all package.json files and documentation
- **Flexible**: Works with or without 'v' prefix in version tags
- **Safe**: Validates input and provides clear error messages

## Workflow Files Modified

1. **`.github/workflows/build-binaries.yml`**:
   - Added version sync step before building
   - Added commit-version job to push changes back
   - Enhanced with proper permissions and error handling

2. **`.github/workflows/docker-ci.yml`**:
   - Added version sync step for Docker builds
   - Ensures Docker images have correct version metadata

## Version Format

- **Release Tags**: `v3.4.0` (with 'v' prefix)
- **Package.json**: `3.4.0` (semantic version without prefix)
- **Documentation**: `Version: 3.4.0` (displayed in README)
- **HTML Metadata**: `<meta name="version" content="3.4.0">`

## Troubleshooting

### Version Mismatch
If versions get out of sync, manually run:
```bash
node scripts/sync-release-version.js v3.4.0
```

### Failed Builds
Check GitHub Actions logs for:
- Permission issues (needs `contents: write`)
- Git configuration (automatically handled by the script)
- Network issues during npm install or git operations

### Commit Failures
The commit step includes error handling:
- Configures git user if not set
- Checks for changes before attempting commit
- Provides clear error messages on failure

## Future Enhancements

Potential improvements to consider:
- **Changelog Generation**: Automatically generate CHANGELOG.md
- **Pre-release Support**: Handle alpha, beta, rc versions
- **Multi-branch Support**: Support releases from different branches
- **Rollback Mechanism**: Ability to revert failed releases