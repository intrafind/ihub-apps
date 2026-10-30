// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V191 — integration scopes are picked in the "+" menu (#3050)
 *
 * The chat input offers one place to pick where an integration searches and
 * whom it asks: a row under "Use in this chat" in the "+" menu, with a chip
 * under the composer. The inline "Search in: … ▾" picker next to the model
 * selector is gone, and with it the `scopePicker: "inline"` placement.
 *
 * Every app that still names `inline` for an integration (V189 gave it to the
 * shipped iFinder Search app) gets `menu` instead. `hidden` is left alone.
 */

export const version = '191';
export const description = 'integration_scope_picker_in_menu';

export async function precondition(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  for (const file of files) {
    const path = `apps/${file}`;
    const app = await ctx.readJson(path);
    const integrations = app?.integrations;
    if (!integrations || typeof integrations !== 'object') continue;

    const moved = Object.entries(integrations)
      .filter(([, settings]) => settings?.scopePicker === 'inline')
      .map(([id, settings]) => {
        settings.scopePicker = 'menu';
        return id;
      });
    if (moved.length === 0) continue;

    await ctx.writeJson(path, app);
    ctx.log(`${path}: the ${moved.join(', ')} scope picker moves to the "+" menu`);
  }
}
