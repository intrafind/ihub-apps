// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The host of a run nobody watches: an app called as a tool, an app called
 * through the MCP gateway, an inbound A2A task.
 *
 * Nobody can answer here (`interactions: 'none'`): `seamProfiles.build`
 * refuses a call that needs approval and a question to the user instead of
 * pausing the run. What the run produces is collected in memory and handed
 * back to the caller when the run ends:
 *
 * - the tool calls with what the model saw of each result, under an aggregate
 *   cap (`collectCapBytes`), so a chatty tool cannot grow the collection without bound;
 * - the files and pictures the app's tools produced (`headlessToolOutputSeam`);
 * - the model's text as it arrives, for a caller that streams (`onTextDelta`, A2A).
 *
 * One host serves one run.
 *
 * @module services/run/hosts/HeadlessHost
 */

import { headlessToolOutputSeam } from '../../chat/toolOutputFiles.js';
import { storedSourceSet } from '../../../../shared/sources/index.js';

/** Aggregate bound on the tool output a headless run retains for its caller. */
export const APP_INVOKE_COLLECT_CAP_BYTES = 256 * 1024;

const sizeOf = content =>
  Buffer.byteLength(typeof content === 'string' ? content : JSON.stringify(content), 'utf8');

/** The host of a run without a client. */
export class HeadlessHost {
  /**
   * @param {Object} [options]
   * @param {(text: string, meta: {step: number}) => void} [options.onTextDelta] - streamed text
   * @param {number} [options.collectCapBytes] - aggregate cap of the collected tool output
   */
  constructor({ onTextDelta = null, collectCapBytes = APP_INVOKE_COLLECT_CAP_BYTES } = {}) {
    this.kind = 'headless';
    this.interactions = 'none';
    this.onTextDelta = typeof onTextDelta === 'function' ? onTextDelta : null;
    this.collectCapBytes = collectCapBytes;
    this.toolCalls = [];
    this.generatedFiles = [];
    this.generatedImages = [];
    this.collectedBytes = 0;
  }

  /**
   * The host's seams; `seamProfiles.build` puts them after its own.
   *
   * @param {Object} bindings
   * @param {string} bindings.chatId
   * @param {Object} bindings.principal
   * @returns {Array<Object>}
   */
  seams({ chatId, principal }) {
    const host = this;
    const collector = {
      name: 'app-invoke-collector',
      postTool(ctx, info, outcome) {
        // What is retained is what the model saw: the loop's bounded (spilled)
        // tool message, not the raw result.
        const content = outcome.message?.content ?? null;
        const bytes = sizeOf(content);
        const kept = host.collectedBytes + bytes <= host.collectCapBytes;
        if (kept) host.collectedBytes += bytes;
        host.toolCalls.push({
          toolName: info.toolId,
          toolInput: info.args,
          toolOutput: kept ? content : { truncated: true, bytes }
        });
      },
      onChunk(ctx, chunk) {
        if (!host.onTextDelta) return;
        for (const text of chunk.content || []) {
          if (text) host.onTextDelta(text, { step: ctx.iteration });
        }
      }
    };
    return [
      headlessToolOutputSeam({
        chatId,
        user: principal,
        generatedFiles: this.generatedFiles,
        generatedImages: this.generatedImages
      }),
      collector
    ];
  }

  /**
   * A run that did not start or did not finish.
   *
   * @param {Object} params
   * @param {string} params.runId
   * @param {{message: string, code?: string}} params.error
   * @returns {Object}
   */
  failed({ runId, error }) {
    return {
      status: 'error',
      runId,
      error: { message: error?.message || 'App invocation failed', code: error?.code },
      finalMessage: null,
      toolCalls: this.toolCalls
    };
  }

  /**
   * A run that answered.
   *
   * @param {Object} params
   * @param {string} params.runId
   * @param {Object} params.result - the loop's result
   * @param {Object} params.model - the resolved model
   * @param {Object|null} params.provenance - provenance of the answer
   * @returns {Object}
   */
  completed({ runId, result, model, provenance }) {
    return {
      status: 'ok',
      runId,
      finalMessage: { role: 'assistant', content: result.content || '' },
      ...(provenance ? { provenance } : {}),
      toolCalls: this.toolCalls,
      // What the app found, stored as its source set (no supports: those place
      // markers in the app's own answer text).
      sources: storedSourceSet(result.sources),
      usage: result.usage,
      finishReason: result.finishReason,
      model: model.id,
      generatedFiles: this.generatedFiles,
      images: [...(result.images || []), ...this.generatedImages]
    };
  }
}

export default HeadlessHost;
