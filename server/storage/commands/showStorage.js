#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:show`: print one stored document, one append-log stream,
 * one spill blob or one file of a store outside the storage layer (agent
 * memory, inbox, artifact, tool-job result, short links) decrypted, for support. With encryption at rest,
 * `cat contents/data/chats/<id>.json` no longer shows content; this does,
 * without switching encryption off.
 *
 *     node server/storage/commands/showStorage.js --doc chats <chatId>
 *     node server/storage/commands/showStorage.js --stream run:<runId>
 *     node server/storage/commands/showStorage.js --blob run:<runId> <name>
 *     node server/storage/commands/showStorage.js --file agent-memory <profileId>.md
 *
 * **For the administrator of the server, on its shell.** It needs read access
 * to the data directory and the master key (`contents/.encryption-key` or
 * `TOKEN_ENCRYPTION_KEY`), and whoever has both can read everything anyway.
 * It is no API and has no access check of its own. Every use writes one line
 * to the server log (what was shown and by which OS user, never the content).
 *
 * It only reads. It works with the server running or stopped, whatever the
 * switch says, and reads plaintext and encrypted objects alike.
 *
 * Exit code 0: printed. 1: not found, or it cannot be opened. 2: a wrong argument.
 *
 * @module storage/commands/showStorage
 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import logger from '../../utils/logger.js';
import { readStoreFile } from '../atRest/sealedFiles.js';
import { createProvider, resolveStorageConfig } from '../index.js';
import { loadPlatformConfigFromDisk, quietServerLog } from './commandSupport.js';

const USAGE = `Usage: npm run storage:show -- --doc <namespace> <key>
       npm run storage:show -- --stream <stream>
       npm run storage:show -- --blob <stream> <name>
       npm run storage:show -- --file <store> <name>

Prints one stored object decrypted (JSON for a document or a stream, the raw
bytes for a spill blob or a file). For the server's administrator; needs the master key.

  --doc <namespace> <key>   one document, with its metadata
  --stream <stream>         every record of an append-log stream, by seq, one per line
  --blob <stream> <name>    one spill blob of a stream
  --file <store> <name>     one file of agent-memory (<profileId>.md), agent-inboxes
                            (<inboxId>.md), agent-artifacts (<runId>/<name>),
                            tool-jobs (<jobId>.result) or short-links (shortlinks.json)
  --verbose                 also print the server's log lines (to stderr)
`;

const loadKeyModule = () => import('../../crypto/KeyProvider.js');

/**
 * The command.
 *
 * @param {string[]} [argv] - Arguments after the script name.
 * @param {Object} [io]
 * @param {(text: string|Buffer) => void} [io.out] - Receives the output.
 * @param {Object} [io.env]
 * @param {() => Promise<Object>} [io.loadKeys] - Key module (tests).
 * @param {Object} [io.platformConfig] - Platform configuration (tests).
 * @returns {Promise<number>} Exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    out = text => process.stdout.write(text),
    env = process.env,
    loadKeys = loadKeyModule,
    platformConfig
  } = {}
) {
  const args = argv.filter(argument => argument !== '--verbose');
  const [kind, first, second, ...rest] = args;
  const arity = { '--doc': 2, '--stream': 1, '--blob': 2, '--file': 2 }[kind];
  const given = [first, second].filter(value => typeof value === 'string').length;
  if (
    !arity ||
    given !== arity ||
    rest.length > 0 ||
    [first, second].some(v => v?.startsWith('--'))
  ) {
    out(USAGE);
    return kind === '--help' ? 0 : 2;
  }

  // Before the log is silenced: the one line that records this read.
  logger.warn('A stored object is shown decrypted on the server shell (storage:show)', {
    component: 'StorageShow',
    code: 'STORAGE_SHOW',
    kind: kind.slice(2),
    target: arity === 2 ? `${first}/${second}` : first,
    osUser: os.userInfo().username
  });
  quietServerLog(argv.includes('--verbose'));

  const config = platformConfig || (await loadPlatformConfigFromDisk());
  const { provider: name, config: providerConfig } = resolveStorageConfig(config, env);
  // Mode `off`: reads plaintext and encrypted objects, and this command never writes.
  const provider = createProvider(name, {
    ...providerConfig,
    encryption: { mode: 'off', loadKeys }
  });
  try {
    if (kind === '--doc') {
      const document = await provider.documents.get(first, second);
      if (!document) {
        out(`No document ${first}/${second}.\n`);
        return 1;
      }
      out(`${JSON.stringify(document, null, 2)}\n`);
      return 0;
    }
    if (kind === '--stream') {
      const records = await provider.logs.read(first);
      if (records.length === 0) {
        out(`No records in stream ${first}.\n`);
        return 1;
      }
      for (const record of records) out(`${JSON.stringify(record)}\n`);
      return 0;
    }
    if (kind === '--file') {
      const keys = await loadKeys();
      await keys.ensureMasterKey();
      const file =
        typeof provider.contentsDir === 'string'
          ? await readStoreFile({
              contentsDir: provider.contentsDir,
              store: first,
              name: second,
              keyProvider: keys.getKeyProvider()
            })
          : null;
      if (!file) {
        out(`No file ${second} in store ${first}.\n`);
        return 1;
      }
      out(file);
      return 0;
    }
    const blob = await provider.logs.getBlob(first, second);
    if (!blob) {
      out(`No blob ${second} in stream ${first}.\n`);
      return 1;
    }
    out(blob);
    return 0;
  } catch (error) {
    out(`It cannot be shown: ${error.message}\n`);
    return 1;
  } finally {
    await provider.shutdown?.().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { runAtRestCommand } = await import('./atRestCli.js');
  await runAtRestCommand(main);
}
