/**
 * Migration V160 — memory between runs for scheduled tasks
 *
 * Scheduled tasks can keep notes between their runs ("Remember between runs"),
 * and a new notify mode, `changes`, tells the owner only about a run that
 * failed or reported something new. Two things on an existing installation
 * need this migration:
 *
 *  1. The platform limits. `scheduledTasks.memoryEnabled`, `memoryMaxChars`
 *     and `maxHistoryReadChars` are added with the shipped defaults, so an
 *     admin sees them in the settings and the file says what the server uses.
 *     `setDefault` never touches a value the admin already set.
 *
 *  2. The declared parameters of the chat tools `schedule_task` and
 *     `update_scheduled_task`. A new field on an existing config file is
 *     exactly the case `copyDefaultConfiguration()` does not cover: it
 *     backfills whole files that are missing from `contents/`, so an install
 *     that already has `tools/schedule_task.json` would keep the old schema
 *     forever — the model would never learn that a task can remember, and a
 *     call passing `memory` or `notify: "changes"` would fail validation.
 *
 * Only what is missing is added, and a description is replaced only when it is
 * still the text iHub shipped before, so an admin who edited a description
 * keeps it. Running it twice changes nothing.
 */

export const version = '160';
export const description = 'scheduled_task_memory';

/** The platform limits, as `server/defaults/config/platform.json` ships them in V160. */
export const MEMORY_SETTINGS = Object.freeze({
  memoryEnabled: true,
  memoryMaxChars: 8000,
  maxHistoryReadChars: 8000
});

const NOTIFY_CHANGES = 'changes';

/** The text as it shipped before V160 (or as V160 ships it). */
const OLD_SCHEDULE_INSTRUCTIONS = {
  en: 'The prompt sent on every run, written as a complete instruction that makes sense without this conversation. It may use {{run_time}}, {{last_run_at}}, {{last_successful_run_at}}, {{run_number}} and {{task_name}}, e.g. "tickets changed since {{last_successful_run_at}}".',
  de: 'Der Prompt, der bei jedem Lauf gesendet wird, als vollständige Anweisung, die ohne diese Unterhaltung verständlich ist. Er kann {{run_time}}, {{last_run_at}}, {{last_successful_run_at}}, {{run_number}} und {{task_name}} verwenden, z. B. „Tickets, die sich seit {{last_successful_run_at}} geändert haben“.'
};

/** The text as it shipped before V160 (or as V160 ships it). */
const NEW_SCHEDULE_INSTRUCTIONS = {
  en: 'The prompt sent on every run, written as a complete instruction that makes sense without this conversation. It may use {{run_time}}, {{last_run_at}}, {{last_successful_run_at}}, {{run_number}} and {{task_name}}, e.g. "tickets changed since {{last_successful_run_at}}". When the user wants only what is new since the last run, set memory to true and tell the task to report only what is new or changed since its last run.',
  de: 'Der Prompt, der bei jedem Lauf gesendet wird, als vollständige Anweisung, die ohne diese Unterhaltung verständlich ist. Er kann {{run_time}}, {{last_run_at}}, {{last_successful_run_at}}, {{run_number}} und {{task_name}} verwenden, z. B. „Tickets, die sich seit {{last_successful_run_at}} geändert haben“. Möchte der Nutzer nur das Neue seit dem letzten Lauf, memory auf true setzen und der Aufgabe sagen, nur Neues oder Geändertes seit ihrem letzten Lauf zu melden.'
};

/** The text as it shipped before V160 (or as V160 ships it). */
const OLD_SCHEDULE_NOTIFY = {
  en: 'When to notify the user: after every run (default), only on failure, or never',
  de: 'Wann der Nutzer benachrichtigt wird: nach jedem Lauf (Standard), nur bei Fehlern oder nie'
};

/** The text as it shipped before V160 (or as V160 ships it). */
const NEW_SCHEDULE_NOTIFY = {
  en: 'When to notify the user: after every run (default), only on failure, never, or only when a run failed or reported something new ("changes", needs memory)',
  de: 'Wann der Nutzer benachrichtigt wird: nach jedem Lauf (Standard), nur bei Fehlern, nie oder nur wenn ein Lauf fehlschlug oder Neues meldete („changes“, braucht memory)'
};

/** The text as it shipped before V160 (or as V160 ships it). */
const OLD_UPDATE_DESCRIPTION = {
  en: 'Pause or resume a scheduled task, or propose changes to its name, instructions, schedule, app, tools or notifications. Pausing and resuming apply at once; every other change is shown to the user on a confirmation card and applied only when they save it. Inside a scheduled run, a task may only pause itself or change its own schedule.',
  de: 'Eine geplante Aufgabe pausieren oder fortsetzen oder Änderungen an Name, Anweisungen, Zeitplan, App, Tools oder Benachrichtigungen vorschlagen. Pausieren und Fortsetzen gelten sofort; jede andere Änderung wird dem Nutzer auf einer Bestätigungskarte gezeigt und erst beim Speichern übernommen. In einem geplanten Lauf darf sich eine Aufgabe nur selbst pausieren oder ihren eigenen Zeitplan ändern.'
};

/** The text as it shipped before V160 (or as V160 ships it). */
const NEW_UPDATE_DESCRIPTION = {
  en: 'Pause or resume a scheduled task, or propose changes to its name, instructions, schedule, app, tools, notifications or memory between runs. Pausing and resuming apply at once; every other change is shown to the user on a confirmation card and applied only when they save it. Inside a scheduled run, a task may only pause itself or change its own schedule.',
  de: 'Eine geplante Aufgabe pausieren oder fortsetzen oder Änderungen an Name, Anweisungen, Zeitplan, App, Tools, Benachrichtigungen oder das Merken zwischen Läufen vorschlagen. Pausieren und Fortsetzen gelten sofort; jede andere Änderung wird dem Nutzer auf einer Bestätigungskarte gezeigt und erst beim Speichern übernommen. In einem geplanten Lauf darf sich eine Aufgabe nur selbst pausieren oder ihren eigenen Zeitplan ändern.'
};

/** The text as it shipped before V160 (or as V160 ships it). */
const SCHEDULE_MEMORY_PARAMETER = {
  type: 'boolean',
  description: {
    en: 'Let the task keep notes between runs ("Remember between runs"). Turn it on when the user wants only what is new or changed since the last run, or wants the task to continue earlier work; use it instead of relying on {{last_successful_run_at}}. The notes are updated automatically after each run and the user can read and edit them on the task page. Off by default.',
    de: 'Die Aufgabe führt zwischen den Läufen Notizen („Zwischen Läufen merken“). Einschalten, wenn der Nutzer nur Neues oder Geändertes seit dem letzten Lauf möchte oder die Aufgabe frühere Arbeit fortsetzen soll; statt sich auf {{last_successful_run_at}} zu verlassen. Die Notizen werden nach jedem Lauf automatisch aktualisiert und der Nutzer kann sie auf der Aufgabenseite lesen und bearbeiten. Standardmäßig aus.'
  }
};

/** The text as it shipped before V160 (or as V160 ships it). */
const UPDATE_MEMORY_PARAMETER = {
  type: 'boolean',
  description: {
    en: 'Turn "Remember between runs" on or off. The notes are kept when it is turned off.',
    de: '„Zwischen Läufen merken“ ein- oder ausschalten. Die Notizen bleiben beim Ausschalten erhalten.'
  }
};

const SCHEDULE_TASK = 'tools/schedule_task.json';
const UPDATE_TASK = 'tools/update_scheduled_task.json';

export async function precondition(ctx) {
  return (
    (await ctx.fileExists('config/platform.json')) ||
    (await ctx.fileExists(SCHEDULE_TASK)) ||
    (await ctx.fileExists(UPDATE_TASK))
  );
}

/** Replace a localized text only when it is still exactly what shipped before. */
function replaceIfShipped(holder, key, previous, next) {
  const current = holder?.[key];
  if (current && current.en === previous.en && current.de === previous.de) {
    holder[key] = { ...next };
    return true;
  }
  return false;
}

/** Add `changes` to a notify enum that lacks it. */
function addNotifyChanges(properties) {
  const notify = properties.notify;
  if (!Array.isArray(notify?.enum) || notify.enum.includes(NOTIFY_CHANGES)) return false;
  notify.enum.push(NOTIFY_CHANGES);
  return true;
}

async function patchTool(ctx, file, { memoryParameter, edit }) {
  if (!(await ctx.fileExists(file))) return;
  const tool = await ctx.readJson(file);
  const properties = tool?.parameters?.properties;
  if (!properties || typeof properties !== 'object') {
    ctx.warn(`${file} has no parameters.properties — skipping`);
    return;
  }
  let changed = addNotifyChanges(properties);
  if (!properties.memory) {
    properties.memory = structuredClone(memoryParameter);
    changed = true;
  }
  changed = edit(tool, properties) || changed;
  if (!changed) {
    ctx.log(`${file} already declares memory between runs — leaving it as configured`);
    return;
  }
  await ctx.writeJson(file, tool);
  ctx.log(`Declared memory between runs and notify "changes" in ${file}`);
}

export async function up(ctx) {
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    if (platform && typeof platform === 'object') {
      for (const [key, value] of Object.entries(MEMORY_SETTINGS)) {
        ctx.setDefault(platform, `scheduledTasks.${key}`, value);
      }
      await ctx.writeJson('config/platform.json', platform);
      ctx.log('Added the scheduled task memory settings');
    }
  }

  await patchTool(ctx, SCHEDULE_TASK, {
    memoryParameter: SCHEDULE_MEMORY_PARAMETER,
    edit(_tool, properties) {
      const instructions = replaceIfShipped(
        properties.instructions,
        'description',
        OLD_SCHEDULE_INSTRUCTIONS,
        NEW_SCHEDULE_INSTRUCTIONS
      );
      const notify = replaceIfShipped(
        properties.notify,
        'description',
        OLD_SCHEDULE_NOTIFY,
        NEW_SCHEDULE_NOTIFY
      );
      return instructions || notify;
    }
  });

  await patchTool(ctx, UPDATE_TASK, {
    memoryParameter: UPDATE_MEMORY_PARAMETER,
    edit(tool) {
      return replaceIfShipped(tool, 'description', OLD_UPDATE_DESCRIPTION, NEW_UPDATE_DESCRIPTION);
    }
  });
}
