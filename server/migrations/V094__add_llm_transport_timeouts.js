/**
 * Migration V094 — Surface the LLM transport ceilings in platform.json
 *
 * Two ceilings guard a provider call besides the whole-call deadline
 * (REQUEST_TIMEOUT): the phase before the provider's first response byte, and
 * the gap between two chunks of a stream that has already started. Both were
 * hard-coded, so an installation whose provider is reachable but slow to
 * answer had no way to loosen them.
 *
 * Seeding the current values makes them visible and editable in Admin →
 * Platform Configuration. They are the same numbers the code falls back to, so
 * nothing changes in behaviour on upgrade:
 *
 * - `llm.connectTimeoutMs`    — 10 s before the provider's first response
 *                               byte, per attempt.
 * - `llm.streamIdleTimeoutMs` — 60 s between two chunks of a live stream.
 *
 * 0 disables either ceiling; a single model can override both in its own
 * config. Env fallbacks (used when these keys are absent) are
 * LLM_CONNECT_TIMEOUT_MS and LLM_STREAM_IDLE_TIMEOUT_MS.
 */

export const version = '094';
export const description = 'Surface the LLM transport ceilings in platform.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'llm.connectTimeoutMs', 10000);
  ctx.setDefault(platform, 'llm.streamIdleTimeoutMs', 60000);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Applied LLM transport ceilings (llm.connectTimeoutMs, llm.streamIdleTimeoutMs)');
}
