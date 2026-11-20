#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:copy-blobs`: copy the blobs on local disk into the
 * configured S3 blob storage. Run it while the server is stopped. It never
 * deletes a source file and never overwrites an object in the bucket. Exit
 * code 0 when every blob is in the bucket, 1 when not, 2 for a wrong argument.
 *
 * The command itself is `server/storage/commands/copyBlobs.js`, which is also
 * what an installation without this `scripts/` directory runs:
 * `node server/storage/commands/run.js copy-blobs`.
 *
 * Usage: node scripts/storage-copy-blobs.js [--dry-run] [--namespace=<name>] [--json] [--verbose]
 */
import { runCommand } from '../server/storage/commands/run.js';

await runCommand('copy-blobs', process.argv.slice(2));
