// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A real filesystem storage provider over a scratch directory, bootstrapped as
 * the process-wide provider. The storage provider is mandatory, so every test
 * that touches the run ledger, workflow state, interactions or run summaries
 * needs one — there is no memory mode to fall back to.
 *
 * @example
 * let storage;
 * before(async () => { storage = await startTestStorage(); });
 * after(async () => { await storage.stop(); });
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapStorage, shutdownStorageBootstrap } from '../../storage/bootstrap.js';
import { WorkflowStateRepository } from '../../services/workflow/WorkflowStateRepository.js';
import { StateManager } from '../../services/workflow/StateManager.js';

/**
 * Bring up the process-wide provider over a fresh scratch directory.
 *
 * @param {Object} [options]
 * @param {string} [options.prefix] - Scratch directory name prefix.
 * @returns {Promise<{dir: string, provider: Object, stop: () => Promise<void>}>}
 */
export async function startTestStorage({ prefix = 'ihub-test-storage-' } = {}) {
  await shutdownStorageBootstrap();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const provider = await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(dir, 'data'), flushIntervalMs: 25 }
    }
  });
  return {
    dir,
    provider,
    async stop() {
      await shutdownStorageBootstrap();
      // Writes queued by the code under test can land while the directory is
      // being removed, so give the removal a few retries.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  };
}

/**
 * A workflow state repository over a provider, for tests that need an isolated
 * `StateManager` (the manager has no private-directory mode any more).
 *
 * @param {{provider: Object}} storage - Result of {@link startTestStorage}.
 * @returns {WorkflowStateRepository}
 */
export function stateRepositoryFor(storage) {
  return new WorkflowStateRepository({
    documents: storage.provider.documents,
    locks: storage.provider.locks
  });
}

/**
 * A `StateManager` that checkpoints into the given provider.
 *
 * @param {{provider: Object}} storage - Result of {@link startTestStorage}.
 * @returns {StateManager}
 */
export function stateManagerFor(storage) {
  return new StateManager({ repository: stateRepositoryFor(storage) });
}

/**
 * A document store over a scratch filesystem provider that is not the
 * process-wide one, for tests that hand a store its own `documents`.
 *
 * @param {Object} [options]
 * @param {string} [options.prefix] - Scratch directory name prefix.
 * @returns {Promise<{documents: Object, provider: Object, dir: string,
 *   reset: () => Promise<void>, stop: () => Promise<void>}>}
 */
export async function scratchDocuments({ prefix = 'ihub-test-docs-' } = {}) {
  const { FilesystemStorageProvider } = await import('../../storage/providers/filesystem/index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const baseDir = path.join(dir, 'data');
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  return {
    documents: provider.documents,
    provider,
    dir,
    /** Forget every stored document (between cases that must not share state). */
    async reset() {
      for (const entry of await fs.readdir(baseDir)) {
        await fs.rm(path.join(baseDir, entry), { recursive: true, force: true });
      }
    },
    async stop() {
      await provider.shutdown();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  };
}
