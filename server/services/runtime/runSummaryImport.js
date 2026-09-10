/**
 * One-time import of the run records an installation already has on disk into
 * the `runs` namespace.
 *
 * Before the consolidation, "what ran" lived in two places that this import
 * reads and the new store replaces:
 *
 *   `contents/data/run-log/index/<YYYY-MM-DD>.jsonl`
 *       one line per run start, one per run end, one tombstone per delete
 *   `contents/data/workflow-state/execution-registry.json`
 *       every workflow and agent execution, rewritten whole on each change
 *
 * Rules this import follows, because an upgrade must be survivable:
 *
 *   - **Idempotent.** A run that already has a summary is left alone, so a
 *     retry after a crash mid-import finishes the job rather than redoing it,
 *     and a run recorded by the new code path is never overwritten by an older
 *     copy of itself.
 *   - **Never destructive.** The legacy files stay exactly where they are. A
 *     later release removes them; until then they remain the fallback for
 *     everything this import could not carry over.
 *   - **Bounded.** A very large index is imported newest-first up to
 *     {@link MAX_IMPORT_RUNS} and the truncation is logged. The runs left
 *     behind are still readable through the legacy paths.
 *   - **Quiet when there is nothing to do.** A fresh installation records the
 *     marker and logs at debug.
 *
 * Anonymous runs are skipped, exactly as the ledger listing always skipped
 * them: they are never listable by owner, their ids are single-use, and
 * spending the import bound on them would push runs a user can actually see
 * out of the index. They stay authorizable from their ledger file.
 *
 * @module services/runtime/runSummaryImport
 */
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import config from '../../config.js';
import { getRootDir } from '../../pathUtils.js';
import logger from '../../utils/logger.js';
import { getRunSummaryRepository, normalizeRunSummary } from './RunSummaryRepository.js';

const COMPONENT = 'RunSummaryImport';

/** Namespace holding the "this import already ran" markers. */
export const IMPORT_STATE_NAMESPACE = 'runtime-imports';

/** Key of this import's marker within {@link IMPORT_STATE_NAMESPACE}. */
export const IMPORT_STATE_KEY = 'run-summaries';

/**
 * The ledger's per-day index directory as it has always been laid out.
 *
 * Deliberately computed here rather than read from `RunLog`: this is the
 * *legacy* location, frozen by what is already on disk, and it must not follow
 * a future change to where the ledger writes.
 */
export const LEGACY_LEDGER_INDEX_DIR = path.join(
  getRootDir(),
  config.CONTENTS_DIR,
  config.DATA_DIR,
  'run-log',
  'index'
);

/**
 * The execution registry file.
 *
 * `'data'` is hard-coded here because `ExecutionRegistry` hard-codes it too:
 * an installation with `DATA_DIR` overridden has its registry under
 * `contents/data/`, not under the override, and the import has to read the
 * file that actually exists.
 */
export const LEGACY_EXECUTION_REGISTRY_FILE = path.join(
  getRootDir(),
  config.CONTENTS_DIR,
  'data',
  'workflow-state',
  'execution-registry.json'
);

/** Hard bound on how many runs one import carries over. */
export const MAX_IMPORT_RUNS = 5000;

/**
 * Lease for the whole import. Long, because the import is the critical
 * section: a sibling worker that cannot take the lock skips the import
 * entirely rather than racing it.
 */
const LOCK_OPTIONS = { ttlMs: 300_000, waitMs: 1000 };

/**
 * Merge one legacy index line into the accumulating record for its run.
 *
 * The merge mirrors what `RunLog.listRuns` did when it rebuilt a run from the
 * same lines: later entries win field by field, while `startedAt` keeps the
 * timestamp of the earliest line seen — the run/start.
 *
 * @param {Object|undefined} previous - Record built so far.
 * @param {Object} entry - Parsed index line.
 * @returns {Object} The merged record.
 */
function mergeIndexEntry(previous, entry) {
  const merged = { ...(previous || {}), ...entry };
  merged.startedAt = previous?.startedAt || entry.ts;
  return merged;
}

/**
 * Turn a merged index record into a run summary.
 *
 * @param {Object} entry - Merged index record.
 * @returns {Object} Summary input for `normalizeRunSummary`.
 */
function summaryFromIndex(entry) {
  return {
    runId: entry.runId,
    kind: entry.kind,
    ownerId: entry.principalId,
    anonymous: entry.anonymous === true,
    parentRunId: entry.parentRunId,
    refs: entry.refs,
    status: entry.status,
    startedAt: entry.startedAt,
    updatedAt: entry.endedAt || entry.ts || entry.startedAt,
    endedAt: entry.endedAt,
    finishReason: entry.finishReason,
    usage: entry.usage
  };
}

/**
 * Turn a registry execution into a run summary.
 *
 * The registry's own vocabulary maps across: `executionId` is the run id,
 * `userId` is the owner and `completedAt` is when it ended. `kind` is derived
 * the way every authorization check already derives it — an `agent:` principal
 * means an agent run.
 *
 * @param {Object} execution - Registry record.
 * @returns {Object} Summary input for `normalizeRunSummary`.
 */
function summaryFromExecution(execution) {
  const ownerId = typeof execution.userId === 'string' ? execution.userId : null;
  return {
    runId: execution.executionId,
    kind: ownerId && ownerId.startsWith('agent:') ? 'agent' : 'workflow',
    ownerId,
    anonymous: false,
    refs: { executionId: execution.executionId },
    source: execution.source,
    status: execution.status,
    startedAt: execution.startedAt,
    updatedAt: execution.updatedAt,
    endedAt: execution.completedAt,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    currentNode: execution.currentNode,
    pendingCheckpoint: execution.pendingCheckpoint,
    inputPreview: execution.inputPreview,
    models: execution.models,
    triggeredBy: execution.triggeredBy,
    archived: execution.archived === true
  };
}

/**
 * Read every per-day ledger index file and rebuild one record per run.
 *
 * @param {string} indexDir - Directory holding `<YYYY-MM-DD>.jsonl` files.
 * @param {Object} log - Logger.
 * @returns {Promise<{records: Map<string, Object>, files: number}>}
 */
async function readLedgerIndex(indexDir, log) {
  const byRun = new Map();
  let files;
  try {
    files = (await fs.readdir(indexDir)).filter(name => name.endsWith('.jsonl')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log.warn('Could not read the legacy ledger index', {
        component: COMPONENT,
        indexDir,
        error: error.message
      });
    }
    return { records: byRun, files: 0 };
  }

  const deleted = new Set();
  for (const file of files) {
    const reader = createInterface({
      input: createReadStream(path.join(indexDir, file), 'utf8'),
      crlfDelay: Infinity
    });
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          // A torn last line of a crashed write; the rest of the file is fine.
          continue;
        }
        if (!entry || typeof entry.runId !== 'string') continue;
        if (entry.deleted) {
          // A deleted run must not come back to life as a summary.
          deleted.add(entry.runId);
          byRun.delete(entry.runId);
          continue;
        }
        if (deleted.has(entry.runId)) continue;
        if (entry.anonymous) continue;
        byRun.set(entry.runId, mergeIndexEntry(byRun.get(entry.runId), entry));
      }
    } finally {
      reader.close();
    }
  }
  return { records: byRun, files: files.length };
}

/**
 * Read the legacy execution registry file.
 *
 * @param {string} registryFile - Path to `execution-registry.json`.
 * @param {Object} log - Logger.
 * @returns {Promise<Object[]>} Executions, or an empty list when there is no
 *   readable registry.
 */
async function readExecutionRegistry(registryFile, log) {
  let raw;
  try {
    raw = await fs.readFile(registryFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log.warn('Could not read the legacy execution registry', {
        component: COMPONENT,
        registryFile,
        error: error.message
      });
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.executions) ? parsed.executions : [];
  } catch (error) {
    // A truncated registry is exactly the failure mode the whole-file rewrite
    // had; the checkpoint directories are still there for the registry's own
    // rescan, so this import skips it rather than failing the boot.
    log.warn('Legacy execution registry is not valid JSON; skipping it', {
      component: COMPONENT,
      registryFile,
      error: error.message
    });
    return [];
  }
}

/**
 * Merge a registry execution over whatever the ledger index knew about the
 * same run.
 *
 * The registry wins on every field it carries — including `ownerId`. The two
 * sources disagree there whenever `runLog.identityMode` is not `default`: the
 * ledger recorded the resolved principal (a hash under `pseudonymized`) while
 * the registry recorded the raw user id. The raw id is what "my executions"
 * lists by, so keeping it is what stops a workflow disappearing from its
 * owner's list; the ledger-side check falls through to the execution check for
 * the same run, exactly as it does today.
 *
 * @param {Object|undefined} fromIndex - Summary input built from the index.
 * @param {Object} fromRegistry - Summary input built from the registry.
 * @returns {Object} Merged summary input.
 */
function mergeSources(fromIndex, fromRegistry) {
  const merged = { ...(fromIndex || {}) };
  for (const [key, value] of Object.entries(fromRegistry)) {
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Import the legacy run records into the `runs` namespace, once.
 *
 * Safe to call on every boot: the marker document short-circuits the work
 * after the first successful run, and a worker that cannot take the import
 * lock leaves the job to the one that did.
 *
 * @param {Object} [options]
 * @param {import('./RunSummaryRepository.js').RunSummaryRepository} [options.repository]
 *   Repository to write through; defaults to the process-wide one.
 * @param {string} [options.indexDir] - Legacy ledger index directory.
 * @param {string} [options.registryFile] - Legacy execution registry file.
 * @param {number} [options.maxRuns] - Import bound.
 * @param {boolean} [options.force=false] - Import again even though the marker
 *   says it already ran (tests, a manual re-import).
 * @param {Object} [options.logger] - Logger.
 * @returns {Promise<{ran: boolean, reason?: string, imported: number, skipped: number,
 *   truncated: boolean, candidates: number}>} What the import did. `ran:false`
 *   means it decided there was nothing for it to do, never that it failed.
 */
export async function importLegacyRunSummaries({
  repository,
  indexDir = LEGACY_LEDGER_INDEX_DIR,
  registryFile = LEGACY_EXECUTION_REGISTRY_FILE,
  maxRuns = MAX_IMPORT_RUNS,
  force = false,
  logger: log = logger
} = {}) {
  const repo = repository || getRunSummaryRepository();
  const idle = { ran: false, imported: 0, skipped: 0, truncated: false, candidates: 0 };
  if (!repo.isAvailable()) {
    log.debug?.('No storage provider; legacy run summaries stay where they are', {
      component: COMPONENT
    });
    return { ...idle, reason: 'storage-unavailable' };
  }

  const documents = repo.documents;

  /**
   * Whether the import has already completed.
   *
   * Read twice: once before the lock, so the common case of a later boot
   * costs one document read, and once inside it, because on the *first* boot
   * every worker passes the outer check simultaneously and would otherwise
   * each redo the whole scan behind the lock — bounded and harmless, but on a
   * large installation that is four full legacy scans and four thousand
   * existence checks to import nothing.
   *
   * @returns {Promise<boolean>}
   */
  const alreadyImported = async () => {
    if (force) return false;
    const marker = await documents.get(IMPORT_STATE_NAMESPACE, IMPORT_STATE_KEY);
    return Boolean(marker?.data?.completedAt);
  };

  if (await alreadyImported()) return { ...idle, reason: 'already-imported' };

  const run = async () => {
    if (await alreadyImported()) return { ...idle, reason: 'already-imported' };
    const { records: indexRecords, files } = await readLedgerIndex(indexDir, log);
    const executions = await readExecutionRegistry(registryFile, log);

    const candidates = new Map();
    for (const [runId, entry] of indexRecords) {
      candidates.set(runId, summaryFromIndex(entry));
    }
    for (const execution of executions) {
      if (!execution || typeof execution.executionId !== 'string') continue;
      const runId = execution.executionId;
      candidates.set(runId, mergeSources(candidates.get(runId), summaryFromExecution(execution)));
    }

    // Newest first, so a bound that cuts the import keeps the runs a user is
    // most likely to go looking for.
    const ordered = [...candidates.values()]
      .map(candidate => normalizeRunSummary(candidate))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const truncated = ordered.length > maxRuns;
    const selected = truncated ? ordered.slice(0, maxRuns) : ordered;

    let imported = 0;
    let skipped = 0;
    for (const summary of selected) {
      // The existence check is what makes a retry cheap and keeps a summary
      // written by the live code path from being overwritten by its older
      // legacy copy.
      if (await repo.get(summary.runId)) {
        skipped += 1;
        continue;
      }
      if (await repo.put(summary)) imported += 1;
      else skipped += 1;
    }

    await documents.put(IMPORT_STATE_NAMESPACE, IMPORT_STATE_KEY, {
      completedAt: new Date().toISOString(),
      imported,
      skipped,
      truncated,
      candidates: ordered.length,
      sources: { indexFiles: files, executions: executions.length }
    });

    const result = {
      ran: true,
      imported,
      skipped,
      truncated,
      candidates: ordered.length
    };
    if (ordered.length === 0) {
      log.debug?.('No legacy run records to import', { component: COMPONENT });
    } else {
      log.info('Imported legacy run records into the runs namespace', {
        component: COMPONENT,
        ...result,
        ...(truncated ? { bound: maxRuns } : {})
      });
    }
    return result;
  };

  if (!repo.locks) return run();
  try {
    return await repo.locks.withLock('runtime-import:run-summaries', run, LOCK_OPTIONS);
  } catch (error) {
    if (error?.code === 'LOCK_TIMEOUT') {
      // Another worker is importing the same records; there is nothing useful
      // this one could add by waiting.
      log.debug?.('Legacy run import is already running elsewhere', { component: COMPONENT });
      return { ...idle, reason: 'in-progress' };
    }
    throw error;
  }
}

export default importLegacyRunSummaries;
