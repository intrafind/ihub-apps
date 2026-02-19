#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

/**
 * Sync package.json version with release tag
 * Usage: node sync-release-version.js <release_tag> [--commit]
 */
async function syncReleaseVersion() {
  try {
    const releaseTag = process.argv[2];
    const shouldCommit = process.argv.includes('--commit');

    if (!releaseTag) {
      console.error('❌ Error: Release tag is required');
      console.error('Usage: node sync-release-version.js <release_tag> [--commit]');
      process.exit(1);
    }

    // Remove 'v' prefix if present
    const version = releaseTag.startsWith('v') ? releaseTag.slice(1) : releaseTag;

    console.log(`🔄 Syncing version with release tag: ${releaseTag}`);
    console.log(`📦 Target version: ${version}`);

    // Read current package.json
    const packageJsonPath = join(rootDir, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const currentVersion = packageJson.version;

    console.log(`📋 Current package.json version: ${currentVersion}`);

    if (currentVersion === version) {
      console.log('✅ Version is already synchronized');
      return;
    }

    // Update package.json version
    packageJson.version = version;
    await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
    console.log(`✅ Updated package.json version: ${currentVersion} → ${version}`);

    // Update client package.json if it exists
    const clientPackageJsonPath = join(rootDir, 'client', 'package.json');
    try {
      const clientPackageJsonContent = await readFile(clientPackageJsonPath, 'utf-8');
      const clientPackageJson = JSON.parse(clientPackageJsonContent);
      const clientCurrentVersion = clientPackageJson.version;

      if (clientCurrentVersion !== version) {
        clientPackageJson.version = version;
        await writeFile(
          clientPackageJsonPath,
          JSON.stringify(clientPackageJson, null, 2) + '\n',
          'utf-8'
        );
        console.log(`✅ Updated client/package.json version: ${clientCurrentVersion} → ${version}`);
      }
    } catch {
      console.log('ℹ️ No client/package.json found, skipping');
    }

    // Update server package.json if it exists
    const serverPackageJsonPath = join(rootDir, 'server', 'package.json');
    try {
      const serverPackageJsonContent = await readFile(serverPackageJsonPath, 'utf-8');
      const serverPackageJson = JSON.parse(serverPackageJsonContent);
      const serverCurrentVersion = serverPackageJson.version;

      if (serverCurrentVersion !== version) {
        serverPackageJson.version = version;
        await writeFile(
          serverPackageJsonPath,
          JSON.stringify(serverPackageJson, null, 2) + '\n',
          'utf-8'
        );
        console.log(`✅ Updated server/package.json version: ${serverCurrentVersion} → ${version}`);
      }
    } catch {
      console.log('ℹ️ No server/package.json found, skipping');
    }

    // Update documentation version
    console.log('📚 Updating documentation version...');
    try {
      execSync('npm run docs:update-version', {
        stdio: 'inherit',
        cwd: rootDir
      });
      console.log('✅ Documentation version updated');
    } catch (error) {
      console.warn('⚠️ Failed to update documentation version:', error.message);
    }

    if (shouldCommit) {
      console.log('🔨 Committing version changes...');
      try {
        // Configure git user if not already configured
        try {
          execSync('git config --get user.email', { stdio: 'ignore' });
        } catch {
          execSync('git config user.email "action@github.com"');
          execSync('git config user.name "GitHub Action"');
        }

        // Check if there are changes to commit
        try {
          execSync('git diff --quiet HEAD', { stdio: 'ignore' });
          console.log('ℹ️ No changes to commit');
          return;
        } catch {
          // There are changes, proceed with commit
        }

        // Add and commit changes
        execSync(
          'git add package.json client/package.json server/package.json docs/README.md docs/theme/head.hbs || true'
        );
        execSync(
          `git commit -m "chore: update version to ${version} for release ${releaseTag}

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"`,
          { stdio: 'inherit' }
        );

        console.log(`✅ Committed version changes for ${releaseTag}`);
      } catch (error) {
        console.error('❌ Failed to commit changes:', error.message);
        process.exit(1);
      }
    } else {
      console.log('ℹ️ Use --commit flag to commit changes automatically');
    }

    console.log(`🎉 Version sync completed successfully!`);
  } catch (error) {
    console.error('❌ Error syncing release version:', error);
    process.exit(1);
  }
}

syncReleaseVersion();
