/**
 * Seam registrations for AgentLoop.
 *
 * A seam is a plain object with any of the hooks below. Hooks may be async.
 *
 *   preStep(ctx)                         before each model call
 *   preTool(ctx, info)                   before a tool runs; return `{ handled: true, message?, messages?,
 *                                        execution?, terminate?: { status, finishReason, pendingInteraction? } }`
 *                                        to take the call over
 *   postTool(ctx, info, outcome)         after a tool ran; may mutate `outcome.message`, set
 *                                        `outcome.knowledgeSource`
 *   stepEnd(ctx, step)                   after each model response was consumed
 *   onChunk(ctx, chunk)                  every streamed chunk
 *   onHallucinated(ctx, info)            the model called an unregistered tool
 *   onCircuitBroken(ctx, info)           a tool was withheld for the rest of the segment
 *   onCompaction(ctx, info)              messages were compacted (proactive or overflow)
 *
 * @module services/loop/seams
 */
export { imageLiftSeam, extractImageData } from './imageLiftSeam.js';
export { knowledgeSourceSeam, classifyKnowledgeSource } from './knowledgeSourceSeam.js';
export { passthroughSeam } from './passthroughSeam.js';
export { questionSeam, markInteractiveTools } from './questionSeam.js';
