import fs from 'fs/promises';
import path from 'path';

export const version = '039';
export const description = 'add_calendar_integration';

const CALENDAR_STARTER_PROMPTS = [
  {
    title: {
      en: 'Draft an agenda for this meeting',
      de: 'Entwirf eine Agenda für dieses Meeting'
    },
    message: {
      en: 'Draft an agenda for this meeting. Use the invite details and the knowledge base; flag anything that is missing.',
      de: 'Entwirf eine Agenda für dieses Meeting. Nutze die Einladungsdetails und die Wissensdatenbank; markiere fehlende Punkte.'
    }
  },
  {
    title: {
      en: 'Prepare me for this meeting',
      de: 'Bereite mich auf dieses Meeting vor'
    },
    message: {
      en: 'Prepare me for this meeting. Give me a one-page briefing using the invite and the knowledge base.',
      de: 'Bereite mich auf dieses Meeting vor. Erstelle ein einseitiges Briefing aus Einladung und Wissensdatenbank.'
    }
  },
  {
    title: {
      en: 'Who is attending and why?',
      de: 'Wer nimmt teil und warum?'
    },
    message: {
      en: 'Tell me about the attendees of this meeting and why each is likely on the invite.',
      de: 'Erzähle mir etwas über die Teilnehmenden dieses Meetings und warum jede Person vermutlich eingeladen wurde.'
    }
  }
];

const MEETING_KNOWLEDGE_BASE_SOURCE = {
  id: 'meeting-knowledge-base',
  name: {
    en: 'Meeting Knowledge Base',
    de: 'Meeting-Wissensdatenbank'
  },
  description: {
    en: 'Organizational reference material consulted by the calendar-aware apps. Replace with a connector to your company wiki / ifinder source for real use.',
    de: 'Organisatorisches Referenzmaterial für die kalenderbezogenen Apps. Für den Produktiveinsatz durch eine Verbindung zum Unternehmenswiki / iFinder ersetzen.'
  },
  type: 'filesystem',
  enabled: true,
  exposeAs: 'prompt',
  tags: ['meetings', 'calendar'],
  config: {
    path: 'sources/meeting-knowledge-base.md',
    encoding: 'utf-8'
  }
};

const APP_FILES = ['meeting-agenda-generator.json', 'meeting-briefing.json'];

/**
 * Copy a non-JSON default file into the contents/ tree. The migration ctx
 * exposes JSON readers/writers but no raw-file copy helper, so we go
 * through fs directly. No-op when the destination already exists so
 * admin edits are never overwritten.
 */
async function copyDefaultFileIfMissing(ctx, relativePath) {
  const dest = path.join(ctx.contentsDir, relativePath);
  try {
    await fs.access(dest);
    return false; // already exists, leave admin edits alone
  } catch {
    // not present, continue
  }
  const src = path.join(ctx.defaultsDir, relativePath);
  try {
    const data = await fs.readFile(src);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    return true;
  } catch (e) {
    ctx.warn(`Could not copy ${relativePath}: ${e.message || e}`);
    return false;
  }
}

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Add calendar-specific starter prompts. Mail prompts stay unchanged.
  ctx.setDefault(platform, 'officeIntegration.calendarStarterPrompts', CALENDAR_STARTER_PROMPTS);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added officeIntegration.calendarStarterPrompts defaults');

  // Register the meeting knowledge base source if the admin hasn't
  // already claimed that id for a different source. We never overwrite —
  // admins may have repurposed the id between the default-ship and now.
  if (await ctx.fileExists('config/sources.json')) {
    const sources = await ctx.readJson('config/sources.json');
    if (Array.isArray(sources)) {
      ctx.addIfMissing(sources, MEETING_KNOWLEDGE_BASE_SOURCE, 'id');
      await ctx.writeJson('config/sources.json', sources);
      ctx.log('Ensured meeting-knowledge-base source is registered');
    } else {
      ctx.warn('config/sources.json is not an array, skipping source registration');
    }
  }

  // Copy the sample knowledge base markdown into contents/sources/ if
  // the admin hasn't already created one. Without this file the
  // filesystem source returns an empty string at runtime and the apps
  // behave as if the knowledge base were silent.
  if (await copyDefaultFileIfMissing(ctx, 'sources/meeting-knowledge-base.md')) {
    ctx.log('Installed default sources/meeting-knowledge-base.md');
  }

  // Drop the two new app JSON files into contents/apps/ if not present.
  // Existing installs that already shipped these (or were customized by
  // the admin) are left alone.
  for (const fileName of APP_FILES) {
    if (await copyDefaultFileIfMissing(ctx, `apps/${fileName}`)) {
      ctx.log(`Installed default app contents/apps/${fileName}`);
    }
  }
}
