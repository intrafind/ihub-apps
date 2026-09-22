/**
 * Migration V094 — Add default iAssistant app, migrate hardcoded extraContext
 *
 * The iassistant extraContext / systemPromptPreamble now support global prompt
 * variables ({{user_name}}, {{user_email}}, {{date}}, …), resolved per
 * requesting user (issue #1384, second half).
 *
 * - Installs without an iAssistant app get the new default app: disabled,
 *   model selector hidden, extraContext templated with the requesting user.
 * - Installs whose app still carries the hardcoded test extraContext
 *   ("My name is Daniel …") — configured back when extraContext could not be
 *   personalized, which made the assistant address every user as Daniel —
 *   get that value replaced with the templated default.
 * - Any other custom extraContext is a deliberate admin choice and is left
 *   untouched.
 */

export const version = '094';
export const description = 'add_default_iassistant_app';

const APP_PATH = 'apps/iassistant.json';
const HARDCODED_TEST_CONTEXT = /my name is daniel/i;

export async function up(ctx) {
  const defaultApp = await ctx.readDefaultJson(APP_PATH);
  if (!defaultApp) {
    ctx.warn('Default iassistant app config not found in defaults');
    return;
  }

  if (!(await ctx.fileExists(APP_PATH))) {
    await ctx.writeJson(APP_PATH, defaultApp);
    ctx.log('Seeded default iAssistant app (disabled, templated extraContext)');
    return;
  }

  const app = await ctx.readJson(APP_PATH);
  const extraContext = app.iassistant?.extraContext;

  if (
    typeof extraContext === 'string' &&
    !extraContext.includes('{{') &&
    HARDCODED_TEST_CONTEXT.test(extraContext)
  ) {
    app.iassistant.extraContext = defaultApp.iassistant.extraContext;
    await ctx.writeJson(APP_PATH, app);
    ctx.log(
      `Replaced hardcoded iAssistant extraContext ("${extraContext}") with the templated default`
    );
  } else {
    ctx.log('Existing iAssistant app extraContext left unchanged');
  }
}
