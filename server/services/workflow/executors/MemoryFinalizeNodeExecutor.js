/**
 * Executor for `memory-finalize` nodes — deterministic long-term memory write.
 *
 * Drains `state.data._pendingMemoryUpdates` and writes each entry via
 * `memoryFile.writeMemory()`. Entries are populated by the upstream
 * `memory-compose` node — an explicit toolless LLM step whose
 * `_isMemoryComposer` branch in `PromptNodeExecutor._autoPersistResult`
 * pushes the composer's `{mode, content, summary}` delta onto the queue.
 *
 * NO LLM call is made here — this guarantees memory writes happen even
 * on Gemini runs where the grounding swap would otherwise have stripped
 * the legacy `write_memory` LLM tool.
 *
 * Failure modes:
 *   - profileId missing            → emit a noop step log + SSE, return success
 *   - _pendingMemoryUpdates empty  → emit a noop step log + SSE, return success
 *   - VERSION_CONFLICT             → refetch + retry once, then continue
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
  // Trim before checking length so whitespace-only content (e.g. "  ", "\n")
  // doesn't slip through and produce blank memory writes. The composer's
  // own auto-persist branch already does this — apply the same guard here
  // so the deterministic writer is safe for any other producer that
  // pushes onto `_pendingMemoryUpdates`.
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
      // Emit a noop step log + SSE so the run timeline still shows an
      // explanation for this step. Without it the UI renders an
      // unexplained "memory-finalize" row with no log details.
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
          noopReason: 'no profileId resolvable'
        },
        chatId
      );
      return this.createSuccessResult(
        { ok: true, noop: true, reason: 'no profileId', written: 0 },
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
                noopReason: 'no profileId resolvable'
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
        result = await memoryFile.writeMemory(profileId, {
          mode,
          content: entry.content,
          summary,
          updatedBy: `memory-finalize:${context?.user?.id || 'agent'}`
        });
      } catch (err) {
        if (err.code === 'VERSION_CONFLICT') {
          // Race-tolerant: read latest, retry once without expectedVersion.
          this.logger.warn('memory-finalize: VERSION_CONFLICT, retrying once', {
            component: 'MemoryFinalizeNodeExecutor',
            nodeId: node.id,
            profileId,
            currentVersion: err.currentVersion
          });
          try {
            result = await memoryFile.writeMemory(profileId, {
              mode,
              content: entry.content,
              summary,
              updatedBy: `memory-finalize:${context?.user?.id || 'agent'}`
            });
          } catch (retryErr) {
            this.logger.error('memory-finalize: retry also failed, skipping entry', {
              component: 'MemoryFinalizeNodeExecutor',
              nodeId: node.id,
              profileId,
              error: retryErr.message
            });
            toolCalls.push({
              name: 'memory-file.writeMemory',
              args: this._previewToolValue(args),
              result: this._previewToolValue({ ok: false, error: retryErr.message }),
              durationMs: Date.now() - writeStartMs
            });
            continue;
          }
        } else {
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

  _previewToolValue(value) {
    try {
      const json = JSON.stringify(value);
      return json.length > 1024 ? `${json.slice(0, 1024)}…` : json;
    } catch {
      return null;
    }
  }
}

export default MemoryFinalizeNodeExecutor;
