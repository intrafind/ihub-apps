// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

export const version = '182';
export const description = 'remove_passthrough_content_prompt';

// A prompt template that is only "{{content}}" changes nothing: the message is
// sent as typed, and a template without {{content}} gets the message appended
// anyway. The app creator used to add it to every new app; it no longer does.
// Languages whose template is exactly "{{content}}" are dropped, and `prompt`
// goes with them when none is left. Templates with any other text stay.

const PASSTHROUGH = /^\s*\{\{\s*content\s*\}\}\s*$/;

export async function precondition(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  for (const name of files) {
    const path = `apps/${name}`;
    const app = await ctx.readJson(path);
    const prompt = app?.prompt;
    if (typeof prompt === 'string') {
      if (!PASSTHROUGH.test(prompt)) continue;
      delete app.prompt;
    } else if (prompt && typeof prompt === 'object') {
      const langs = Object.keys(prompt).filter(
        lang => typeof prompt[lang] === 'string' && PASSTHROUGH.test(prompt[lang])
      );
      if (langs.length === 0) continue;
      for (const lang of langs) delete prompt[lang];
      if (Object.keys(prompt).length === 0) delete app.prompt;
    } else {
      continue;
    }
    await ctx.writeJson(path, app);
    ctx.log(`Removed the pass-through {{content}} prompt from ${path}`);
  }
}
