// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Telemetry privacy defaults (#4008, P0):
 * - `telemetry.spans.userIdMode`: how a span names the user — `pseudonymised`
 *   (HMAC under a per-installation key, the default), `off` or `clear`. Before
 *   this the raw login went on every LLM span.
 * - `telemetry.events.maxEventSize` is capped at 4096 characters: content
 *   capture never exports more per attribute, whatever the setting says, so a
 *   larger stored value is brought down to what is in effect.
 */
export const version = '267';
export const description = 'telemetry_privacy_defaults';

/** The hard cap of captured content per attribute (`telemetry/contentCapture.js`). */
const MAX_EVENT_SIZE = 4096;

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/platform.json');
  if (!config.telemetry || typeof config.telemetry !== 'object') {
    ctx.log('No telemetry block; nothing to do');
    return;
  }
  ctx.setDefault(config, 'telemetry.spans.userIdMode', 'pseudonymised');
  const size = Number(config.telemetry.events?.maxEventSize);
  if (Number.isFinite(size) && size > MAX_EVENT_SIZE) {
    config.telemetry.events.maxEventSize = MAX_EVENT_SIZE;
    ctx.log(`Capped telemetry.events.maxEventSize at ${MAX_EVENT_SIZE}`);
  }
  await ctx.writeJson('config/platform.json', config);
  ctx.log('Added telemetry.spans.userIdMode (pseudonymised)');
}
