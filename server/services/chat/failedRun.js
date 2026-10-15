/**
 * Failed-run frames for the chat stream.
 *
 * @module services/chat/failedRun
 */
import { RunStreamEmitter } from '../loop/RunStream.js';
import { newRunId } from '../loop/RunLog.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';

/**
 * Report a failure that happened before (or instead of) a model turn on the
 * chat stream: a short-lived run that starts, errors and ends, so the client
 * reducer can attach the message to the pending assistant bubble.
 */
export function emitFailedRun(chatId, { kind = 'chat', messageId, code, message, refs = {} }) {
  const emitter = new RunStreamEmitter({ streamId: chatId, runId: newRunId(kind) });
  emitter.emit(SSE_V2_EVENTS.RUN_STARTED, {
    kind,
    refs: { chatId, ...(messageId ? { messageId } : {}), ...refs }
  });
  emitter.emit(SSE_V2_EVENTS.STREAM_ERROR, {
    code: String(code || 'ERROR'),
    message: String(message)
  });
  emitter.emit(SSE_V2_EVENTS.RUN_ENDED, {
    status: 'error',
    finishReason: 'error',
    error: { ...(code ? { code: String(code) } : {}), message: String(message) }
  });
}
