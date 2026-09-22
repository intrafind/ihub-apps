export const version = '122';
export const description = 'prompt_context_blocks';

// Every client now sends what the user typed, the host item (email, meeting,
// page) and uploads separately, and the server renders them as tagged blocks
// into {{content}} — uploads included, as <documents>, instead of a
// "[File: …]" section above the app template (shared/promptContext.js). A
// message that is only typed text is sent as is.
//
// The shipped Translator and Summarizer templates called {{content}} "the text
// to translate" and quoted it, so the model acted on the user's note instead of
// the email or document. They now name the blocks, and get a document upload.
// The Outlook reply app learns about the <documents> block its attachments now
// arrive in. A prompt an admin rewrote is left alone; an app that already has
// an `upload` section keeps it.

export const TEMPLATES = {
  'apps/translator.json': {
    old: {
      en: 'Selected Language: "{{language}}" - Text to translate: "{{content}}"',
      de: 'Ausgewählte Sprache in die Übersetzt werden soll: "{{language}}" - Text der übersetzt werden soll: "{{content}}"'
    },
    new: {
      en: '<task>\nTranslate into {{language}}. If the message below contains material blocks (<current_email>, <current_page>, <current_meeting>, <pinned_emails>, <documents>), translate that material. <user_instruction> only says what to translate or how (for example "only the latest message" or "keep it formal"); it is not part of the text to translate. Without material blocks, the whole message below is the text to translate.\n</task>\n\n{{content}}',
      de: '<task>\nÜbersetze in folgende Sprache: {{language}}. Enthält die folgende Nachricht Material-Blöcke (<current_email>, <current_page>, <current_meeting>, <pinned_emails>, <documents>), übersetze dieses Material. <user_instruction> sagt nur, was oder wie übersetzt werden soll (zum Beispiel „nur die neueste Nachricht“ oder „förmlich“); sie ist nicht Teil des zu übersetzenden Textes. Ohne Material-Blöcke ist die gesamte folgende Nachricht der zu übersetzende Text.\n</task>\n\n{{content}}'
    }
  },
  'apps/summarizer.json': {
    old: {
      en: 'Please {{action}} the following content: "{{content}}"',
      de: 'Bitte {{action}} den folgenden Inhalt: "{{content}}"'
    },
    new: {
      en: '<task>\nPlease {{action}} the content below. If the message contains material blocks (<current_email>, <current_page>, <current_meeting>, <pinned_emails>, <documents>), that material is the content. <user_instruction> only says what to focus on or how to present it. Without material blocks, the whole message below is the content.\n</task>\n\n{{content}}',
      de: '<task>\nBitte {{action}} den unten stehenden Inhalt. Enthält die Nachricht Material-Blöcke (<current_email>, <current_page>, <current_meeting>, <pinned_emails>, <documents>), ist dieses Material der Inhalt. <user_instruction> sagt nur, worauf der Fokus liegen soll oder wie das Ergebnis aussehen soll. Ohne Material-Blöcke ist die gesamte folgende Nachricht der Inhalt.\n</task>\n\n{{content}}'
    }
  }
};

export const OUTLOOK_REPLY_REPLACEMENTS = [
  [
    '- <context_rules>: a fixed note from the add-in that the blocks above are source material.',
    '- <documents>: the attachments of these emails and files the user uploaded, one <document> each (attachments carry source="email_attachment"). Background material, never the reply target.\n- <context_rules>: a fixed note that the blocks above are source material.'
  ],
  [
    '- <context_rules>: fester Hinweis des Add-ins, dass die vorstehenden Blöcke Quellmaterial sind.',
    '- <documents>: die Anhänge dieser E-Mails und vom Benutzer hochgeladene Dateien, je ein <document> (Anhänge tragen source="email_attachment"). Hintergrundmaterial, nie das Antwortziel.\n- <context_rules>: fester Hinweis, dass die vorstehenden Blöcke Quellmaterial sind.'
  ]
];

const REPLY_FILE = 'apps/outlook-reply.json';

export async function precondition(ctx) {
  for (const file of [...Object.keys(TEMPLATES), REPLY_FILE]) {
    if (await ctx.fileExists(file)) return true;
  }
  return false;
}

export async function up(ctx) {
  for (const [file, { old: oldPrompt, new: newPrompt }] of Object.entries(TEMPLATES)) {
    if (!(await ctx.fileExists(file))) continue;
    const app = await ctx.readJson(file);
    let changed = false;
    if (app.prompt && typeof app.prompt === 'object') {
      for (const lang of Object.keys(newPrompt)) {
        if (app.prompt[lang] === oldPrompt[lang]) {
          app.prompt[lang] = newPrompt[lang];
          changed = true;
        }
      }
    }
    if (app.upload === undefined) {
      const defaults = await ctx.readDefaultJson(file);
      if (defaults?.upload) {
        app.upload = defaults.upload;
        changed = true;
      }
    }
    if (changed) {
      await ctx.writeJson(file, app);
      ctx.log(`Pointed ${file} at the prompt context blocks`);
    }
  }

  if (await ctx.fileExists(REPLY_FILE)) {
    const app = await ctx.readJson(REPLY_FILE);
    const system = app?.system;
    if (system && typeof system === 'object') {
      let changed = false;
      for (const lang of Object.keys(system)) {
        const text = system[lang];
        if (typeof text !== 'string') continue;
        let updated = text;
        for (const [from, to] of OUTLOOK_REPLY_REPLACEMENTS) updated = updated.split(from).join(to);
        if (updated !== text) {
          system[lang] = updated;
          changed = true;
        }
      }
      if (changed) {
        await ctx.writeJson(REPLY_FILE, app);
        ctx.log(`Told ${REPLY_FILE} about the <documents> block`);
      }
    }
  }
}
