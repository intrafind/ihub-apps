#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:show`. The command itself is
 * `server/storage/commands/showStorage.js`, which an installation without
 * this `scripts/` directory (the container image) runs directly:
 * `node server/storage/commands/showStorage.js`.
 */
import { runAtRestCommand } from '../server/storage/commands/atRestCli.js';
import { main } from '../server/storage/commands/showStorage.js';

await runAtRestCommand(main);
