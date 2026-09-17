export const version = '108';
export const description = 'office_context_xml_tags';

// The Outlook add-in now wraps the appointment context it stitches into a
// chat message in a <current_meeting> block (and the user's own text in
// <user_instruction>) instead of a "--- Current meeting ---" heading. The two
// shipped meeting apps name that heading in their system prompts; point them
// at the tagged blocks so the prompt still matches what the model receives.
// A prompt an admin rewrote — one that no longer contains the old heading —
// is left alone.

const APP_FILES = ['apps/meeting-briefing.json', 'apps/meeting-agenda-generator.json'];

export const REPLACEMENTS = [
  [
    "in a section labeled '--- Current meeting ---' inside the user message",
    "inside a <current_meeting> block in the user message, and the user's own request, if any, in a <user_instruction> block"
  ],
  [
    "in einem Abschnitt mit der Überschrift '--- Current meeting ---' in der Nutzernachricht",
    'in einem <current_meeting>-Block in der Nutzernachricht, eine eigene Bitte der nutzenden Person, falls vorhanden, in einem <user_instruction>-Block'
  ],
  [
    "in einem Abschnitt mit der Überschrift '--- Current meeting ---' innerhalb der Nutzernachricht",
    'in einem <current_meeting>-Block innerhalb der Nutzernachricht, eine eigene Bitte der Person, falls vorhanden, in einem <user_instruction>-Block'
  ]
];

export async function precondition(ctx) {
  for (const file of APP_FILES) {
    if (await ctx.fileExists(file)) return true;
  }
  return false;
}

export async function up(ctx) {
  for (const file of APP_FILES) {
    if (!(await ctx.fileExists(file))) continue;

    const app = await ctx.readJson(file);
    const system = app?.system;
    if (!system || typeof system !== 'object') continue;

    let changed = false;
    for (const lang of Object.keys(system)) {
      const text = system[lang];
      if (typeof text !== 'string') continue;
      let updated = text;
      for (const [from, to] of REPLACEMENTS) {
        updated = updated.split(from).join(to);
      }
      if (updated !== text) {
        system[lang] = updated;
        changed = true;
      }
    }

    if (changed) {
      await ctx.writeJson(file, app);
      ctx.log(`Pointed ${file} at the <current_meeting> block`);
    }
  }
}
