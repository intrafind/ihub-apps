/**
 * Migration V067 — Wire the iHub Documentation source into the Support Bot app
 *
 * V055 registered the "ihub-documentation" source in config/sources.json, but
 * the bundled "iHub Support Bot" app never listed it in its `sources` array,
 * so the bot could not actually reference the consolidated documentation
 * (GitHub issue #582). This migration adds the source to the existing app's
 * `sources` array on upgrade. Fresh installs already get the updated app
 * config via server/defaults/apps/ihub-support-bot.json.
 */

export const version = '067';
export const description = 'add_ihub_documentation_to_support_bot';

const APP_FILE = 'apps/ihub-support-bot.json';
const SOURCE_ID = 'ihub-documentation';

export async function precondition(ctx) {
  return await ctx.fileExists(APP_FILE);
}

export async function up(ctx) {
  const app = await ctx.readJson(APP_FILE);

  if (!Array.isArray(app.sources)) {
    app.sources = [];
  }

  if (app.sources.includes(SOURCE_ID)) {
    ctx.log('iHub Support Bot already references the ihub-documentation source — skipping');
    return;
  }

  app.sources.push(SOURCE_ID);
  await ctx.writeJson(APP_FILE, app);
  ctx.log('Added ihub-documentation source to iHub Support Bot app');
}
