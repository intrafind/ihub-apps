/**
 * Executor for `memory-finalize` nodes — deterministic long-term memory write.
 *
 * Drains `state.data._pendingMemoryUpdates` and writes each entry via
 * `memoryFile.applyMemoryDelta()`, which merges the delta into the tripartite
 * memory sections (Semantic / Episodic / Procedural) while keeping
 * human-authored entries immutable. Entries are populated by the upstream
 * `memory-compose` node — an explicit toolless LLM step whose
 * `_isMemoryComposer` branch in `PromptNodeExecutor._autoPersistResult`
 * pushes the composer's `{mode, sections, summary}` delta onto the queue.
 *
 * NO LLM call is made here — this guarantees memory writes happen even
 * on Gemini runs where the grounding swap would otherwise have stripped
 * the legacy `write_memory` LLM tool.
 *
 * Failure modes:
 *   - profileId missing            → emit noop step log + SSE, return success
 *   - _pendingMemoryUpdates empty  → emit noop step log + SSE (with composer
 *                                    skip reason when available)
 *   - writeMemory throws           → log error, skip that entry, continue
 *                                    (last-write-wins; no expectedVersion is
 *                                    passed, so VERSION_CONFLICT is not
 *                                    reachable here. See the catch comment
 *                                    for the rationale and future race path.)
 *
 * @module services/workflow/executors/MemoryFinalizeNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import memoryFile from '../../../agents/memory/memoryFile.js';
import { normalizeDelta } from '../../../agents/memory/memorySections.js';
import { actionTracker } from '../../../actionTracker.js';

function emit(event, payload, chatId) {
  try {
    actionTracker.emit('fire-sse', { event, chatId, ...payload });
  } catch {
    // Best effort — never fail a node because of an SSE emit.
  }
}

function isUpdateShape(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.mode && entry.mode !== 'append' && entry.mode !== 'replace') return false;
  // The entry must normalise to at least one non-empty section. normalizeDelta
  // handles both the tripartite `{ sections: {...} }` shape and the legacy flat
  // `{ content }` shape, trimming whitespace-only values so blanks never slip
  // through and produce empty memory writes.
  const normalized = normalizeDelta(entry);
  return Object.keys(normalized.sections).length > 0;
}

export class MemoryFinalizeNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const chatId = context?.chatId || state?.executionId;

    const profileId =
      context?.user?.profileId ||
      state?.data?._agentProfile?.id ||
      context?.appConfig?._agentProfile?.id;

    if (!profileId) {
      this.logger.warn('memory-finalize: no profileId resolvable, nothing to write', {
        component: 'MemoryFinalizeNodeExecutor',
        nodeId: node.id
      });
      // Emit a noop step log + SSE on this branch too so the run timeline
      // has an explanation for the step. Without it the UI renders an
      // unexplained "memory-finalize" row with no log details, and operators
      // see an unexplained gap between memory-compose and the next step.
      const completedAtIso = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      const noopReason = 'no profileId resolvable';
      emit(
        'agent.step.completed',
        {
          nodeId: node.id,
          kind: 'memory-finalize',
          startedAt: startedAt.toISOString(),
          completedAt: completedAtIso,
          durationMs,
          written: 0,
          noopReason
        },
        chatId
      );
      return this.createSuccessResult(
        { ok: true, noop: true, reason: noopReason, written: 0 },
        {
          stateUpdates: {
            _stepLogs: {
              ...(state?.data?._stepLogs || {}),
              [node.id]: {
                nodeId: node.id,
                kind: 'memory-finalize',
                startedAt: startedAt.toISOString(),
                completedAt: completedAtIso,
                durationMs,
                tools: [],
                toolCalls: [],
                messages: [],
                written: 0,
                noopReason
              }
            }
          }
        }
      );
    }

    const pending = Array.isArray(state?.data?._pendingMemoryUpdates)
      ? state.data._pendingMemoryUpdates
      : [];
    const valid = pending.filter(isUpdateShape);

    if (valid.length === 0) {
      // Surface why nothing was written. Most common: the memory-composer
      // emitted `{skip: true}` because the run had no durable knowledge worth
      // keeping. Without this, operators see an empty no-op step log and
      // assume the memory pipeline is broken.
      const composerDelta = state?.data?._memoryDelta;
      let noopReason = 'no pending memory updates';
      let composerSummary = null;
      if (composerDelta && typeof composerDelta === 'object') {
        if (composerDelta.skip === true) {
          noopReason = 'composer chose to skip';
        } else if (Object.keys(normalizeDelta(composerDelta).sections).length === 0) {
          noopReason = 'composer emitted empty content';
        }
        if (typeof composerDelta.summary === 'string' && composerDelta.summary.trim().length > 0) {
          composerSummary = composerDelta.summary.trim();
        }
      }
      this.logger.info('memory-finalize: no pending memory updates', {
        component: 'MemoryFinalizeNodeExecutor',
        nodeId: node.id,
        profileId,
        dropped: pending.length - valid.length,
        noopReason,
        composerSummary
      });
      const completedAtIso = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      emit(
        'agent.step.completed',
        {
          nodeId: node.id,
          kind: 'memory-finalize',
          startedAt: startedAt.toISOString(),
          completedAt: completedAtIso,
          durationMs,
          written: 0,
          noopReason,
          composerSummary
        },
        chatId
      );
      return this.createSuccessResult(
        { ok: true, noop: true, profileId, written: 0, noopReason, composerSummary },
        {
          stateUpdates: {
            _stepLogs: {
              ...(state?.data?._stepLogs || {}),
              [node.id]: {
                nodeId: node.id,
                kind: 'memory-finalize',
                startedAt: startedAt.toISOString(),
                completedAt: completedAtIso,
                durationMs,
                tools: [],
                toolCalls: [],
                messages: [],
                written: 0,
                noopReason,
                ...(composerSummary ? { composerSummary } : {})
              }
            }
          }
        }
      );
    }

    const toolCalls = [];
    let writtenCount = 0;
    let lastVersion = null;

    for (const entry of valid) {
      const writeStartMs = Date.now();
      const normalized = normalizeDelta(entry);
      const mode = normalized.mode;
      const summary = typeof entry.summary === 'string' ? entry.summary : undefined;
      const sections = Object.keys(normalized.sections);

      const args = { mode, sections: normalized.sections, summary };

      let result;
      try {
        // Last-write-wins semantics: we deliberately do not pass
        // `expectedVersion`. memoryFile.applyMemoryDelta only throws
        // VERSION_CONFLICT when an expected version IS passed, so concurrent
        // writers can't race-fail here. The structured merge also keeps
        // human-authored entries immune even under a `replace`, so a clobber
        // of hand-edited memory is structurally impossible.
        result = await memoryFile.applyMemoryDelta(profileId, entry, {
          updatedBy: `memory-finalize:${context?.user?.id || 'agent'}`
        });
      } catch (err) {
        this.logger.error('memory-finalize: applyMemoryDelta failed, skipping entry', {
          component: 'MemoryFinalizeNodeExecutor',
          nodeId: node.id,
          profileId,
          error: err.message
        });
        toolCalls.push({
          name: 'memory-file.applyMemoryDelta',
          args: this._previewToolValue(args),
          result: this._previewToolValue({ ok: false, error: err.message }),
          durationMs: Date.now() - writeStartMs
        });
        continue;
      }

      writtenCount++;
      lastVersion = result?.version || lastVersion;
      emit(
        'agent.memory.write',
        { profileId, version: result.version, mode, sections, summary, deterministic: true },
        chatId
      );
      toolCalls.push({
        name: 'memory-file.applyMemoryDelta',
        args: this._previewToolValue(args),
        result: this._previewToolValue({ ok: true, version: result.version, sections }),
        durationMs: Date.now() - writeStartMs
      });
    }

    const completedAtIso = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    emit(
      'agent.step.completed',
      {
        nodeId: node.id,
        kind: 'memory-finalize',
        startedAt: startedAt.toISOString(),
        completedAt: completedAtIso,
        durationMs
      },
      chatId
    );

    this.logger.info('memory-finalize: completed', {
      component: 'MemoryFinalizeNodeExecutor',
      nodeId: node.id,
      profileId,
      written: writtenCount,
      attempted: valid.length
    });

    const stepLog = {
      nodeId: node.id,
      kind: 'memory-finalize',
      startedAt: startedAt.toISOString(),
      completedAt: completedAtIso,
      durationMs,
      tools: [
        {
          id: 'memory-file.applyMemoryDelta',
          description: 'Deterministic tripartite memory write'
        }
      ],
      toolCalls,
      messages: [],
      written: writtenCount,
      attempted: valid.length
    };

    return this.createSuccessResult(
      { ok: true, profileId, written: writtenCount, attempted: valid.length, version: lastVersion },
      {
        stateUpdates: {
          // Drain the queue once written — re-runs shouldn't double-write.
          _pendingMemoryUpdates: [],
          _taskTimings: {
            ...(state?.data?._taskTimings || {}),
            [node.id]: {
              startedAt: startedAt.toISOString(),
              completedAt: completedAtIso,
              durationMs
            }
          },
          _stepLogs: {
            ...(state?.data?._stepLogs || {}),
            [node.id]: stepLog
          }
        }
      }
    );
  }

  /**
   * Build a JSON-parseable preview of a tool-call value. Mirrors the helper
   * in PromptNodeExecutor: we truncate long string fields IN PLACE before
   * stringifying so the resulting preview stays valid JSON. The UI does
   * JSON.parse on these previews to render details; truncating the JSON
   * string itself produced an invalid suffix and broke that rendering.
   * @private
   */
  _previewToolValue(value) {
    const MAX_LEN = 1024;
    const MAX_FIELD_LEN = 320;
    if (value == null) return null;
    if (typeof value === 'string') {
      return value.length > MAX_LEN
        ? `${value.slice(0, MAX_LEN)}…[truncated ${value.length - MAX_LEN} chars]`
        : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    try {
      const compact = this._compactStringsForPreview(value, MAX_FIELD_LEN, 0);
      const json = JSON.stringify(compact);
      return json.length > MAX_LEN
        ? `${json.slice(0, MAX_LEN)}…[truncated ${json.length - MAX_LEN} chars]`
        : json;
    } catch {
      return '[unserialisable]';
    }
  }

  /** @private — see PromptNodeExecutor._compactStringsForPreview */
  _compactStringsForPreview(value, maxFieldLen, depth) {
    const MAX_DEPTH = 6;
    const MAX_ARRAY_ITEMS = 20;
    if (depth > MAX_DEPTH) return '[…]';
    if (typeof value === 'string') {
      return value.length > maxFieldLen
        ? `${value.slice(0, maxFieldLen)}…[+${value.length - maxFieldLen}]`
        : value;
    }
    if (Array.isArray(value)) {
      const limited = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map(v => this._compactStringsForPreview(v, maxFieldLen, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) {
        limited.push(`…[+${value.length - MAX_ARRAY_ITEMS} items]`);
      }
      return limited;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this._compactStringsForPreview(v, maxFieldLen, depth + 1);
      }
      return out;
    }
    return value;
  }
}

export default MemoryFinalizeNodeExecutor;
