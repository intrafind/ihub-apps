// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V226 — reset the usage limit counters
 *
 * Every model call is now counted against the user's limits and stored for
 * the usage reports from one call record, in one place. The counters kept
 * before that (`data/quota-usage.json`) missed calls the reports had (agent
 * steps and workflow nodes) and cannot be reconciled with them, so they are
 * deleted once and every user starts at zero. The usage reports are left alone.
 */

export const version = '226';
export const description = 'reset_usage_limit_counters';

const COUNTERS = 'data/quota-usage.json';

export async function precondition(ctx) {
  return await ctx.fileExists(COUNTERS);
}

export async function up(ctx) {
  await ctx.deleteFile(COUNTERS);
  ctx.log(`Removed ${COUNTERS}`);
}
