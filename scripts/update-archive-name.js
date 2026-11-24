#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Prints the release archive name for a tag and build-matrix platform, so the
 * release workflow and the updater share one definition
 * (server/update/archiveNames.js).
 *
 * Usage: node scripts/update-archive-name.js v5.6.0 win            → ihub-apps-v5.6.0-win.zip
 *        node scripts/update-archive-name.js v5.6.0 win --legacy   → ihub-apps-v5.6.0-windows.tar.gz
 *
 * `--legacy` prints the extra archive for installations that update with the updater of a
 * version before 5.6.2, and nothing for a platform that needs none.
 */
import {
  getLegacyUpdaterArchiveName,
  getUpdateArchiveName
} from '../server/update/archiveNames.js';

const args = process.argv.slice(2);
const legacy = args.includes('--legacy');
const [tag, platform] = args.filter(arg => arg !== '--legacy');
if (!tag || !platform) {
  console.error('Usage: node scripts/update-archive-name.js <tag> <linux|macos|win> [--legacy]');
  process.exit(1);
}
const name = legacy
  ? getLegacyUpdaterArchiveName(tag, platform)
  : getUpdateArchiveName(tag, platform);
if (name) process.stdout.write(`${name}\n`);
