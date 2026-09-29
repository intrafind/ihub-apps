/**
 * Migration V136 — Seed scheduled task settings and the group permission
 *
 * Scheduled tasks let users save a prompt that runs by itself. The feature
 * ships dark behind `features.scheduledTasks` (it also needs durable chats);
 * this migration only seeds what it reads once an admin turns it on:
 *
 * - `platform.scheduledTasks` — the limits (tasks per user, shortest
 *   interval, concurrency, stagger, catch-up window, auto-pause after
 *   failures, approval timeout, run retention, run chats kept per task,
 *   instruction length, run time). Every value is the built-in default, so
 *   the upgrade changes nothing on its own; the block becomes visible and
 *   editable under Admin → Scheduled Tasks.
 * - `groups.<id>.permissions.scheduledTasks` — who may create tasks. The
 *   built-in groups get the value a fresh installation ships with: signed-in
 *   users (`authenticated`, `users`) and `admins` may, `anonymous` may not.
 *   Custom groups are left without it (not allowed), and a value an admin
 *   already set is never touched.
 *
 * Nothing here touches `features.json`: whether scheduled tasks run at all is
 * the admin's call.
 */

export const version = '136';
export const description = 'scheduled_tasks_defaults';

export const SCHEDULED_TASK_DEFAULTS = Object.freeze({
  enabled: true,
  maxTasksPerUser: 10,
  minIntervalMinutes: 15,
  maxConcurrentRuns: 4,
  maxConcurrentRunsPerUser: 1,
  staggerMinutes: 5,
  catchUpWindowHours: 24,
  maxConsecutiveFailures: 3,
  approvalTimeoutHours: 24,
  runRetentionDays: 90,
  maxRunChatsPerTask: 20,
  maxInstructionLength: 8000,
  maxRunMinutes: 30
});

/** The built-in groups and the permission a fresh installation gives them. */
export const GROUP_DEFAULTS = Object.freeze({
  admins: true,
  users: true,
  authenticated: true,
  anonymous: false
});

export async function precondition(ctx) {
  return (
    (await ctx.fileExists('config/platform.json')) || (await ctx.fileExists('config/groups.json'))
  );
}

export async function up(ctx) {
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    for (const [key, value] of Object.entries(SCHEDULED_TASK_DEFAULTS)) {
      ctx.setDefault(platform, `scheduledTasks.${key}`, value);
    }
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Seeded platform.scheduledTasks defaults');
  }

  if (await ctx.fileExists('config/groups.json')) {
    const config = await ctx.readJson('config/groups.json');
    if (!config.groups || typeof config.groups !== 'object') {
      ctx.warn('groups.json has no groups object — skipping the scheduledTasks permission');
      return;
    }
    let updated = 0;
    for (const [groupId, value] of Object.entries(GROUP_DEFAULTS)) {
      const group = config.groups[groupId];
      if (!group || typeof group !== 'object') continue;
      if (!group.permissions || typeof group.permissions !== 'object') group.permissions = {};
      if (group.permissions.scheduledTasks !== undefined) continue;
      group.permissions.scheduledTasks = value;
      updated++;
      ctx.log(`Set scheduledTasks=${value} on group "${groupId}"`);
    }
    if (updated > 0) {
      await ctx.writeJson('config/groups.json', config);
    } else {
      ctx.log('Built-in groups already carry the scheduledTasks permission — no changes needed');
    }
  }
}
