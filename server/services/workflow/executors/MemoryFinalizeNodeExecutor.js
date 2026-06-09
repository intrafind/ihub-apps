/**
 * Executor for `memory-finalize` nodes — deterministic long-term memory write.
 *
 * Drains `state.data._pendingMemoryUpdates` (populated by the upstream
 * `memory-compose` LLM node — see profileWorkflowSerializer) and writes each
 * entry via `memoryFile.writeMemory()`. NO LLM call is made here — this
 * guarantees memory writes happen even on Gemini runs where the grounding
 * swap would otherwise have stripped the legacy `write_memory` LLM tool.
 *
 * Failure modes:
 *   - profileId missing            → log warning, emit noop step log + SSE
 *   - _pendingMemoryUpdates empty  → emit noop step log + SSE (with composer
 *                                    skip reason when available)
 *   - writeMemory throws           → log error, skip that entry, continue
 *
 * @module services/workflow/executors/MemoryFinalizeNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import memoryFile from '../../../agents/memory/memoryFile.js';
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
  // Reject whitespace-only content — matches the memory composer's own
  // skip check in PromptNodeExecutor._autoPersistResult so an entry only
  // makes it here when content is genuinely non-empty.
  if (typeof entry.content !== 'string' || entry.content.trim().length === 0) return false;
  if (entry.mode && entry.mode !== 'append' && entry.mode !== 'replace') return false;
  return true;
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
      // Emit the same step-log + SSE shape as the other noop paths so the
      // run timeline has a row for this node — otherwise operators see an
      // unexplained gap between memory-compose and the next step.
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
        } else if (
          typeof composerDelta.content === 'string' &&
          composerDelta.content.trim() === ''
        ) {
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
      const mode = entry.mode || 'append';
      const summary = typeof entry.summary === 'string' ? entry.summary : undefined;

      const args = { mode, content: entry.content, summary };

      let result;
      try {
        // Last-write-wins semantics: we deliberately do not pass
        // `expectedVersion`. memoryFile.writeMemory only throws
        // VERSION_CONFLICT when an expected version IS passed, so concurrent
        // writers can't race-fail here. If true race-tolerance is needed in
        // the future, switch to read-current-version → write-with-expected
        // → retry on conflict (a sibling helper, not this branch).
        result = await memoryFile.writeMemory(profileId, {
          mode,
          content: entry.content,
          summary,
          updatedBy: `memory-finalize:${context?.user?.id || 'agent'}`
        });
      } catch (err) {
        this.logger.error('memory-finalize: writeMemory failed, skipping entry', {
          component: 'MemoryFinalizeNodeExecutor',
          nodeId: node.id,
          profileId,
          error: err.message
        });
        toolCalls.push({
          name: 'memory-file.writeMemory',
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
        { profileId, version: result.version, mode, summary, deterministic: true },
        chatId
      );
      toolCalls.push({
        name: 'memory-file.writeMemory',
        args: this._previewToolValue(args),
        result: this._previewToolValue({ ok: true, version: result.version }),
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
      tools: [{ id: 'memory-file.writeMemory', description: 'Deterministic memory write' }],
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
