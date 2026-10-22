// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V176 — Scheduled task run retention by count
 *
 * Adds `platform.scheduledTasks.maxRunsPerTask`: the most finished runs a
 * scheduled task keeps (0 = no limit). A task can set a stricter limit of its
 * own; `runRetentionDays` already limited runs by age. The default of 0 changes
 * nothing on its own.
 */

export const version = '176';
export const description = 'scheduled_task_run_retention';

export async function precondition(ctx) {
  return ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'scheduledTasks.maxRunsPerTask', 0);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Seeded platform.scheduledTasks.maxRunsPerTask');
}
