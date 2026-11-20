#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:encrypt`. The command itself is
 * `server/storage/commands/encryptStorage.js`, which an installation without
 * this `scripts/` directory (the container image) runs directly:
 * `node server/storage/commands/encryptStorage.js`.
 */
import { runAtRestCommand } from '../server/storage/commands/atRestCli.js';
import { main } from '../server/storage/commands/encryptStorage.js';

await runAtRestCommand(main);
