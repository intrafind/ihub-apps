#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:check`: check the configured blob storage without the
 * server. Exit code 0 when a server start would get a usable blob storage,
 * 1 when not, 2 for a wrong argument.
 *
 * The command itself is `server/storage/commands/storageCheck.js`, which is
 * also what an installation without this `scripts/` directory runs:
 * `node server/storage/commands/run.js check`.
 *
 * Usage: node scripts/storage-check.js [--json] [--verbose]
 */
import { runCommand } from '../server/storage/commands/run.js';

await runCommand('check', process.argv.slice(2));
