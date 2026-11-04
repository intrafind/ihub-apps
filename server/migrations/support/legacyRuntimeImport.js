// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Support code for migration V224: carries the runtime records written by
 * releases before the storage provider into the provider's namespaces.
 *
 * Three legacy layouts exist on an installation that was last started on a
 * release older than 5.5.2:
 *
 *   `data/workflow-state/<executionId>/latest.json`   workflow checkpoints
 *   `data/workflow-state/execution-registry.json`     every workflow/agent run
 *   `data/run-log/index/<YYYY-MM-DD>.jsonl`           the run ledger index
 *   `data/run-log/interactions.json`                  pending interactions
 *
 * The functions here are used only by the migration. They are idempotent (a
 * record that already has a document is left alone, so a run written by the
 * live code is never overwritten by its older copy) and never destructive (the
 * legacy files stay on disk; nothing reads them any more).
 *
 * The run-time markers that the former boot-time importers wrote
 * (`runtime-imports/<name>`) are honoured and written, so an installation that
 * already ran an importer does not import a second time. A second import would
 * resurrect records the user deleted since.
 *
 * @module migrations/support/legacyRuntimeImport
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';
import config from '../../config.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import {
  RunSummaryRepository,
  normalizeRunSummary
} from '../../services/runtime/RunSummaryRepository.js';

const IMPORT_STATE_NAMESPACE = RUNTIME_NAMESPACES.runtimeImports;
const WORKFLOW_STATE_NAMESPACE = RUNTIME_NAMESPACES.workflowState;
const INTERACTIONS_NAMESPACE = RUNTIME_NAMESPACES.interactions;

/** Keys of the markers the former boot-time importers wrote. */
const MARKERS = Object.freeze({
  workflowStates: 'workflow-states',
  runSummaries: 'run-summaries',
  interactions: 'interactions',
  runEvents: 'run-events'
});

/**
 * Upper bound per import. High enough that no real installation reaches it
 * (the run ledger keeps 90 days by default), so a truncation is reported
 * loudly instead of being the normal outcome.
 */
export const MAX_IMPORT_RECORDS = 50_000;

/** Execution ids that name something other than an execution. */
const RESERVED_EXECUTION_KEYS = new Set(['execution-registry']);
const RESERVED_DIRS = new Set(['.owners', '.locks']);

/**
 * Locations of the legacy files below a contents directory.
 *
 * `workflow-state` is under a literal `data` because `StateManager` and
 * `ExecutionRegistry` always hard-coded it; the run ledger followed `DATA_DIR`.
 *
 * @param {string} contentsDir - Absolute contents directory.
 * @returns {{stateDir: string, registryFile: string, indexDir: string, runsDir: string,
 *   spillDir: string, interactionsFile: string}}
 */
export function legacyLocations(contentsDir) {
  const ledgerDir = path.join(contentsDir, config.DATA_DIR || 'data', 'run-log');
  const stateDir = path.join(contentsDir, 'data', 'workflow-state');
  return {
    stateDir,
    registryFile: path.join(stateDir, 'execution-registry.json'),
    indexDir: path.join(ledgerDir, 'index'),
    runsDir: path.join(ledgerDir, 'runs'),
    spillDir: path.join(ledgerDir, 'spill'),
    interactionsFile: path.join(ledgerDir, 'interactions.json')
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether any legacy runtime record is present.
 *
 * @param {string} contentsDir - Absolute contents directory.
 * @returns {Promise<boolean>}
 */
export async function hasLegacyRuntimeData(contentsDir) {
  const { stateDir, registryFile, indexDir, runsDir, interactionsFile } =
    legacyLocations(contentsDir);
  if ((await exists(registryFile)) || (await exists(interactionsFile))) return true;
  for (const dir of [indexDir, runsDir]) {
    try {
      if ((await fs.readdir(dir)).some(name => name.endsWith('.jsonl'))) return true;
    } catch {
      // no such directory
    }
  }
  try {
    const entries = await fs.readdir(stateDir, { withFileTypes: true });
    return entries.some(entry => entry.isDirectory() && !RESERVED_DIRS.has(entry.name));
  } catch {
    return false;
  }
}

async function markerDone(documents, key) {
  const marker = await documents.get(IMPORT_STATE_NAMESPACE, key);
  return Boolean(marker?.data?.completedAt);
}

async function writeMarker(documents, key, result) {
  await documents.put(IMPORT_STATE_NAMESPACE, key, {
    completedAt: new Date().toISOString(),
    ...result
  });
}

function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// ── workflow states ───────────────────────────────────────────────────────

function isWorkflowState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.status === 'string' || typeof value.workflowId === 'string';
}

function isStorableExecutionId(id) {
  if (!isValidId(id) || String(id).includes('..')) return false;
  return !RESERVED_EXECUTION_KEYS.has(id);
}

/**
 * The principal that owns an execution — same rule the repository applies on
 * write, so an owner-scoped listing finds the imported state.
 *
 * @param {Object} state - Execution state.
 * @returns {string|null}
 */
function workflowStateOwnerId(state) {
  const profileId = state?.data?._agent?.profileId;
  if (typeof profileId === 'string' && profileId.length > 0) return `agent:${profileId}`;
  const startedBy = state?.data?._workflow?.startedBy;
  if (typeof startedBy === 'string' && startedBy.length > 0) return startedBy;
  return null;
}

/**
 * Import `<executionId>/latest.json` checkpoint directories into the
 * `workflow-state` namespace, newest first.
 *
 * @param {Object} params
 * @param {Object} params.documents - Document facet of the provider.
 * @param {string} params.stateDir - Legacy workflow state directory.
 * @param {{info: Function, warn: Function}} params.log
 * @param {number} [params.max] - Import bound.
 * @param {boolean} [params.force] - Ignore the marker (tests).
 * @returns {Promise<{ran: boolean, imported: number, skipped: number, truncated: boolean, candidates: number}>}
 */
export async function importWorkflowStates({
  documents,
  stateDir,
  log,
  max = MAX_IMPORT_RECORDS,
  force = false
}) {
  const idle = { ran: false, imported: 0, skipped: 0, truncated: false, candidates: 0 };
  if (!force && (await markerDone(documents, MARKERS.workflowStates))) return idle;

  let entries = [];
  try {
    entries = await fs.readdir(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log.warn(`Cannot read the workflow state directory ${stateDir}: ${error.message}`);
    }
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name) || !isStorableExecutionId(entry.name))
      continue;
    const file = path.join(stateDir, entry.name, 'latest.json');
    let state;
    let mtimeMs;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (!isWorkflowState(state)) continue;
    const stamp = [state.completedAt, state.updatedAt, state.createdAt]
      .map(parseTime)
      .find(Number.isFinite);
    candidates.push({ executionId: entry.name, state, time: stamp ?? mtimeMs });
  }
  candidates.sort((a, b) => {
    const left = Number.isFinite(a.time) ? a.time : 0;
    const right = Number.isFinite(b.time) ? b.time : 0;
    return left !== right ? right - left : a.executionId < b.executionId ? -1 : 1;
  });
  const truncated = candidates.length > max;

  let imported = 0;
  let skipped = 0;
  for (const { executionId, state } of candidates.slice(0, max)) {
    try {
      if (await documents.get(WORKFLOW_STATE_NAMESPACE, executionId)) {
        skipped += 1;
        continue;
      }
      const ownerId = workflowStateOwnerId(state);
      await documents.put(WORKFLOW_STATE_NAMESPACE, executionId, state, { ownerId });
      imported += 1;
    } catch (error) {
      skipped += 1;
      log.warn(`Could not import workflow state ${executionId}: ${error.message}`);
    }
  }
  if (truncated) {
    log.warn(
      `Only the newest ${max} of ${candidates.length} workflow states were imported; ` +
        'the rest stay in data/workflow-state/ and are no longer read'
    );
  }
  await writeMarker(documents, MARKERS.workflowStates, {
    imported,
    skipped,
    truncated,
    candidates: candidates.length
  });
  return { ran: true, imported, skipped, truncated, candidates: candidates.length };
}

// ── run summaries ─────────────────────────────────────────────────────────

function mergeIndexEntry(previous, entry) {
  const merged = { ...previous, ...entry };
  merged.startedAt = previous?.startedAt || entry.ts;
  return merged;
}

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

async function readLedgerIndex(indexDir, log) {
  const byRun = new Map();
  let files;
  try {
    files = (await fs.readdir(indexDir)).filter(name => name.endsWith('.jsonl')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') log.warn(`Cannot read the run ledger index: ${error.message}`);
    return { records: byRun, files: 0 };
  }
  if (files.length > 0) log.info(`Scanning ${files.length} legacy run ledger index files`);

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
          continue; // a torn last line of a crashed write
        }
        if (!entry || typeof entry.runId !== 'string') continue;
        if (entry.deleted) {
          deleted.add(entry.runId);
          byRun.delete(entry.runId);
          continue;
        }
        if (deleted.has(entry.runId)) continue;
        // Anonymous runs are never listable by owner; they are not indexed.
        if (entry.anonymous) continue;
        byRun.set(entry.runId, mergeIndexEntry(byRun.get(entry.runId), entry));
      }
    } finally {
      reader.close();
    }
  }
  return { records: byRun, files: files.length };
}

async function readExecutionRegistry(registryFile, log) {
  let raw;
  try {
    raw = await fs.readFile(registryFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') log.warn(`Cannot read the execution registry: ${error.message}`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.executions) ? parsed.executions : [];
  } catch (error) {
    log.warn(`The legacy execution registry is not valid JSON and is skipped: ${error.message}`);
    return [];
  }
}

/**
 * The registry wins on every field it carries, including `ownerId`: with a
 * non-default `runLog.identityMode` the ledger recorded a resolved (possibly
 * hashed) principal while the registry recorded the raw user id, which is what
 * "my executions" lists by.
 */
function mergeSources(fromIndex, fromRegistry) {
  const merged = { ...fromIndex };
  for (const [key, value] of Object.entries(fromRegistry)) {
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Import the legacy run records (ledger index and execution registry) into the
 * `runs` namespace, newest first.
 *
 * @param {Object} params
 * @param {Object} params.documents - Document facet of the provider.
 * @param {Object|null} [params.locks] - Lock facet (optional).
 * @param {string} params.indexDir - Legacy ledger index directory.
 * @param {string} params.registryFile - Legacy execution registry file.
 * @param {{info: Function, warn: Function}} params.log
 * @param {number} [params.max] - Import bound.
 * @param {boolean} [params.force] - Ignore the marker (tests).
 * @returns {Promise<{ran: boolean, imported: number, skipped: number, truncated: boolean, candidates: number}>}
 */
export async function importRunSummaries({
  documents,
  locks = null,
  indexDir,
  registryFile,
  log,
  max = MAX_IMPORT_RECORDS,
  force = false
}) {
  const idle = { ran: false, imported: 0, skipped: 0, truncated: false, candidates: 0 };
  if (!force && (await markerDone(documents, MARKERS.runSummaries))) return idle;

  const repo = new RunSummaryRepository({ documents, locks });
  const { records: indexRecords, files } = await readLedgerIndex(indexDir, log);
  const executions = await readExecutionRegistry(registryFile, log);

  const candidates = new Map();
  for (const [runId, entry] of indexRecords) candidates.set(runId, summaryFromIndex(entry));
  for (const execution of executions) {
    if (!execution || typeof execution.executionId !== 'string') continue;
    const runId = execution.executionId;
    candidates.set(runId, mergeSources(candidates.get(runId), summaryFromExecution(execution)));
  }

  const ordered = [...candidates.values()]
    .map(candidate => normalizeRunSummary(candidate))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const truncated = ordered.length > max;
  const selected = truncated ? ordered.slice(0, max) : ordered;
  if (selected.length > 0) log.info(`Writing ${selected.length} legacy run records`);

  let imported = 0;
  let skipped = 0;
  for (const summary of selected) {
    // Existing summary: written by the live code path; never overwrite it.
    if (await repo.get(summary.runId)) {
      skipped += 1;
      continue;
    }
    if (await repo.put(summary)) imported += 1;
    else skipped += 1;
  }
  if (truncated) {
    log.warn(
      `Only the newest ${max} of ${ordered.length} run records were imported; ` +
        'older runs stay in data/run-log/ and are no longer listed'
    );
  }
  await writeMarker(documents, MARKERS.runSummaries, {
    imported,
    skipped,
    truncated,
    candidates: ordered.length,
    sources: { indexFiles: files, executions: executions.length }
  });
  return { ran: true, imported, skipped, truncated, candidates: ordered.length };
}

// ── pending interactions ──────────────────────────────────────────────────

function isInteractionRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0 && typeof value.status === 'string';
}

/** Same key rule as `InteractionService`: ids the store cannot spell are hashed. */
function interactionKey(id) {
  if (isValidId(id)) return id;
  return `k-${crypto.createHash('sha256').update(String(id), 'utf8').digest('hex').slice(0, 40)}`;
}

/**
 * Import the pending interactions of `run-log/interactions.json` into the
 * `interactions` namespace. Only pending records are carried: a settled one is
 * a tombstone and importing it would let a stale record be answered again.
 *
 * @param {Object} params
 * @param {Object} params.documents - Document facet of the provider.
 * @param {string} params.file - Legacy pending-store file.
 * @param {{info: Function, warn: Function}} params.log
 * @param {boolean} [params.force] - Ignore the marker (tests).
 * @returns {Promise<{ran: boolean, imported: number, skipped: number, candidates: number}>}
 */
export async function importPendingInteractions({ documents, file, log, force = false }) {
  const idle = { ran: false, imported: 0, skipped: 0, candidates: 0 };
  if (!force && (await markerDone(documents, MARKERS.interactions))) return idle;

  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // no legacy file, or not readable JSON: nothing to carry over
  }
  const records =
    parsed && typeof parsed === 'object' ? Object.values(parsed.interactions || {}) : [];
  const pending = records.filter(
    record => isInteractionRecord(record) && record.status === 'pending'
  );

  let imported = 0;
  let skipped = 0;
  for (const record of pending) {
    try {
      const key = interactionKey(record.id);
      if (await documents.get(INTERACTIONS_NAMESPACE, key)) {
        skipped += 1;
        continue;
      }
      const principalId = record.source?.principalId;
      await documents.put(INTERACTIONS_NAMESPACE, key, record, {
        ownerId: typeof principalId === 'string' && principalId.length > 0 ? principalId : null
      });
      imported += 1;
    } catch (error) {
      skipped += 1;
      log.warn(`Could not import pending interaction ${record.id}: ${error.message}`);
    }
  }
  await writeMarker(documents, MARKERS.interactions, {
    imported,
    skipped,
    candidates: pending.length
  });
  return { ran: true, imported, skipped, candidates: pending.length };
}

// ── run events ────────────────────────────────────────────────────────────

/**
 * Import `run-log/runs/<runId>.jsonl` event files (and the payloads they
 * spilled to `run-log/spill/<runId>/`) into the run's append-log stream and
 * blobs, so a run recorded before the storage provider still opens, re-syncs
 * and replays. Events whose sequence number the stream already holds are
 * skipped; a run continued after an earlier upgrade keeps both halves.
 *
 * @param {Object} params
 * @param {Object} params.logs - Append-log facet of the provider.
 * @param {Object} params.documents - Document facet (for the marker).
 * @param {string} params.runsDir - Legacy per-run event directory.
 * @param {string} params.spillDir - Legacy spill directory.
 * @param {{info: Function, warn: Function}} params.log
 * @param {boolean} [params.force] - Ignore the marker (tests).
 * @returns {Promise<{ran: boolean, runs: number, events: number, blobs: number, skipped: number}>}
 */
export async function importRunEvents({ logs, documents, runsDir, spillDir, log, force = false }) {
  const idle = { ran: false, runs: 0, events: 0, blobs: 0, skipped: 0 };
  if (!force && (await markerDone(documents, MARKERS.runEvents))) return idle;

  let files = [];
  try {
    files = (await fs.readdir(runsDir)).filter(name => name.endsWith('.jsonl')).sort();
  } catch {
    // no legacy event files
  }

  let runs = 0;
  let events = 0;
  let blobs = 0;
  let skipped = 0;
  for (const file of files) {
    const runId = file.slice(0, -'.jsonl'.length);
    if (!isValidId(runId) || runId.includes('..')) {
      skipped += 1;
      continue;
    }
    const stream = `run:${runId}`;
    try {
      const have = new Set(
        (await logs.read(stream, { afterSeq: 0, limit: Infinity })).map(e => e.seq)
      );
      const lines = [];
      const reader = createInterface({
        input: createReadStream(path.join(runsDir, file), 'utf8'),
        crlfDelay: Infinity
      });
      try {
        for await (const line of reader) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event && Number.isInteger(event.seq) && event.seq > 0) lines.push(event);
          } catch {
            // a torn last line of a crashed write
          }
        }
      } finally {
        reader.close();
      }
      for (const event of lines) {
        if (have.has(event.seq)) continue;
        await logs.append(stream, event, event.seq);
        events += 1;
      }

      const runSpill = path.join(spillDir, runId);
      let spilled = [];
      try {
        spilled = await fs.readdir(runSpill);
      } catch {
        // this run spilled nothing
      }
      for (const name of spilled) {
        if (path.basename(name) !== name) continue;
        const existing = await logs.getBlob(stream, name);
        if (existing) continue;
        await logs.putBlob(stream, name, await fs.readFile(path.join(runSpill, name)), {});
        blobs += 1;
      }
      runs += 1;
    } catch (error) {
      skipped += 1;
      log.warn(`Could not import the events of run ${runId}: ${error.message}`);
    }
  }
  await logs.flush?.();
  await writeMarker(documents, MARKERS.runEvents, { runs, events, blobs, skipped });
  return { ran: true, runs, events, blobs, skipped };
}
