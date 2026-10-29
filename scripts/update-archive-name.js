#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Prints the release archive name for a tag and build-matrix platform, so the
 * release workflow and the updater share one definition
 * (server/update/archiveNames.js).
 *
 * Usage: node scripts/update-archive-name.js v5.6.0 win   → ihub-apps-v5.6.0-win.zip
 */
import { getUpdateArchiveName } from '../server/update/archiveNames.js';

const [tag, platform] = process.argv.slice(2);
if (!tag || !platform) {
  console.error('Usage: node scripts/update-archive-name.js <tag> <linux|macos|win>');
  process.exit(1);
}
process.stdout.write(`${getUpdateArchiveName(tag, platform)}\n`);
