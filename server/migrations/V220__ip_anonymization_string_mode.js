// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V220 - IP anonymization takes a string mode only
 *
 * `logging.anonymizeIp` and `audit.anonymizeIp` accepted a boolean as well as
 * 'off' | 'mask' | 'drop'; V060 shipped them as `false`. Only the strings
 * remain. `false` becomes 'off' and `true` becomes 'mask' (what `true` always
 * meant).
 */

export const version = '220';
export const description = 'ip_anonymization_string_mode';

const PLATFORM_FILE = 'config/platform.json';
const SECTIONS = ['logging', 'audit'];

export async function precondition(ctx) {
  return ctx.fileExists(PLATFORM_FILE);
}

export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_FILE);
  let changed = false;
  for (const section of SECTIONS) {
    const block = platform?.[section];
    if (!block || typeof block !== 'object') continue;
    if (block.anonymizeIp === true) {
      block.anonymizeIp = 'mask';
    } else if (block.anonymizeIp === false) {
      block.anonymizeIp = 'off';
    } else {
      continue;
    }
    changed = true;
    ctx.log(`${section}.anonymizeIp -> '${block.anonymizeIp}'`);
  }
  if (changed) await ctx.writeJson(PLATFORM_FILE, platform);
}
