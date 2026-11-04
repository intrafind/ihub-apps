// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V224 — carry the pre-provider runtime records into the storage
 * provider
 *
 * Releases before 5.5.2 (the storage provider) kept what ran in files under
 * `contents/data/`:
 *
 * - `workflow-state/<executionId>/latest.json` — workflow checkpoints, and
 *   `workflow-state/execution-registry.json` — every workflow and agent run
 *   (both since 5.2, so any supported installation can have them);
 * - `run-log/index/<YYYY-MM-DD>.jsonl` — the run ledger's per-day index, and
 *   `run-log/runs/<runId>.jsonl` with `run-log/spill/<runId>/` — one run's
 *   events and the payloads spilled from them (since 5.4.23, written while the
 *   Run Ledger feature was on);
 * - `run-log/interactions.json` — pending interactions (5.4.23–5.5.1 only).
 *
 * Until now the server imported them on every start and kept reading the old
 * layouts as a fallback. The provider is mandatory now and nothing reads the
 * old layouts any more, so this migration imports them once:
 *
 * - checkpoints → the `workflow-state` namespace (one document per execution),
 * - ledger index + registry → one run summary per run in the `runs` namespace,
 * - run event files → the run's append-log stream, spills → blobs beside it,
 * - pending interactions → the `interactions` namespace (pending ones only: a
 *   settled record is a tombstone and importing it would let a stale record be
 *   answered again).
 *
 * An installation whose server already ran the boot-time importers has their
 * markers in the `runtime-imports` namespace; those imports are skipped, since
 * a second import would bring back records deleted since. A record that already
 * has a document is never overwritten. The legacy files stay on disk.
 *
 * Runs before the server's own storage bootstrap, so it brings the configured
 * provider up itself and shuts it down again.
 */
import {
  hasLegacyRuntimeData,
  importPendingInteractions,
  importRunEvents,
  importRunSummaries,
  importWorkflowStates,
  legacyLocations
} from './support/legacyRuntimeImport.js';

export const version = '224';
export const description = 'import_legacy_runtime_stores';

export async function precondition(ctx) {
  return hasLegacyRuntimeData(ctx.contentsDir);
}

export async function up(ctx) {
  const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
  let platform = {};
  try {
    platform = await ctx.readJson('config/platform.json');
  } catch {
    // a missing or unreadable platform.json means the default (filesystem) provider
  }

  const provider = await bootstrapStorage(platform);
  const log = { info: ctx.log, warn: ctx.warn };
  const where = legacyLocations(ctx.contentsDir);
  try {
    const states = await importWorkflowStates({
      documents: provider.documents,
      stateDir: where.stateDir,
      log
    });
    const runs = await importRunSummaries({
      documents: provider.documents,
      locks: provider.locks,
      indexDir: where.indexDir,
      registryFile: where.registryFile,
      log
    });
    const events = await importRunEvents({
      logs: provider.logs,
      documents: provider.documents,
      runsDir: where.runsDir,
      spillDir: where.spillDir,
      log
    });
    const interactions = await importPendingInteractions({
      documents: provider.documents,
      file: where.interactionsFile,
      log
    });
    ctx.log(
      `Imported legacy runtime records: ${states.imported} workflow states, ` +
        `${runs.imported} runs, ${events.runs} run event logs, ` +
        `${interactions.imported} pending interactions`
    );
  } finally {
    await shutdownStorageBootstrap();
  }
}
