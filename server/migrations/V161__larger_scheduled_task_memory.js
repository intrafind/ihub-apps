/**
 * Migration V161 — more room for the notes of scheduled tasks
 *
 * `scheduledTasks.memoryMaxChars` shipped at 8000 characters (V160). That is
 * tight for a task that tracks several sources, and now that every entry in
 * the notes carries the date it was last confirmed, they need a little more
 * room. It becomes 16000 — but only where the admin left the shipped value
 * alone. An install without the setting gets it from the runtime fallback and
 * from `setDefault`, which never touches a value the admin set.
 *
 * Fresh installs get it from server/defaults/config/platform.json.
 */
export const version = '161';
export const description = 'larger_scheduled_task_memory';

/** What `scheduledTasks.memoryMaxChars` shipped with (V160 and the defaults). */
export const PREVIOUS_MEMORY_MAX_CHARS = 8000;

export const MEMORY_MAX_CHARS = 16000;

/**
 * Run only where a platform config exists.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<boolean>}
 */
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Raise the untouched limit; add it where it is missing.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const current = platform.scheduledTasks?.memoryMaxChars;
  if (current === PREVIOUS_MEMORY_MAX_CHARS) {
    platform.scheduledTasks.memoryMaxChars = MEMORY_MAX_CHARS;
    ctx.log(`Raised scheduledTasks.memoryMaxChars from ${current} to ${MEMORY_MAX_CHARS}`);
  } else if (ctx.setDefault(platform, 'scheduledTasks.memoryMaxChars', MEMORY_MAX_CHARS)) {
    ctx.log(`Added scheduledTasks.memoryMaxChars = ${MEMORY_MAX_CHARS}`);
  } else {
    ctx.log('scheduledTasks.memoryMaxChars was customised — keeping it');
    return;
  }
  await ctx.writeJson('config/platform.json', platform);
}
