// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Seam registrations for AgentLoop.
 *
 * A seam is a plain object with any of the hooks below. Hooks may be async.
 *
 *   preStep(ctx)                         before each model call
 *   preTool(ctx, info)                   before a tool runs; return `{ handled: true, message?, messages?,
 *                                        execution?, terminate?: { status, finishReason, pendingInteraction? } }`
 *                                        to take the call over
 *   mayTakeOver(ctx, info)               whether `preTool` of this seam may take the call over: pause the
 *                                        turn for a person, answer in the tool's place or end the turn.
 *                                        Synchronous and without effects; `info` is `{ call, toolDef,
 *                                        toolId, name, args }`. The loop asks it before the calls of a
 *                                        step are grouped (`parallelMode: 'readOnly'`): a call that a
 *                                        seam may take over never runs side by side with another one. A
 *                                        seam whose `preTool` can return `handled` has this hook
 *   postTool(ctx, info, outcome)         after a tool ran; may mutate `outcome.message`, set
 *                                        `outcome.knowledgeSource`
 *   stepEnd(ctx, step)                   after each model response was consumed
 *   onChunk(ctx, chunk)                  every streamed chunk
 *   onHallucinated(ctx, info)            the model called an unregistered tool
 *   onCircuitBroken(ctx, info)           a tool was withheld for the rest of the segment
 *   onCompaction(ctx, info)              messages were compacted (proactive, overflow or retried_call)
 *   onAnswer(ctx, info)                  the model answered without calling a tool; `info` is
 *                                        `{ content, stepText, finishReason, iteration, canRetry }`.
 *                                        Return `{ handled: true, retry: '<correction>', error? }`
 *                                        to reject the answer and let the model try again
 *                                        (honoured only when `canRetry`)
 *
 * Order matters for `preTool`: the first seam that returns `handled` takes the
 * call over. The `approval` seam goes first, before any seam that announces
 * (`chat-tools` emits `tool/started`) or runs a call (`passthrough`), so a
 * call that waits for a person's approval never shows as started.
 *
 * @module services/loop/seams
 */
export {
  approvalSeam,
  awaitingApprovalPayload,
  noUserPayload as approvalNoUserPayload
} from './approvalSeam.js';
export { imageLiftSeam, extractImageData } from './imageLiftSeam.js';
export { knowledgeSourceSeam } from './knowledgeSourceSeam.js';
export { passthroughSeam } from './passthroughSeam.js';
export { questionSeam, markInteractiveTools } from './questionSeam.js';
export { structuredOutputSeam, structuredOutputRetryPrompt } from './structuredOutputSeam.js';
