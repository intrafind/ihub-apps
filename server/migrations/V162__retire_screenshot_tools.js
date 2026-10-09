/**
 * Migration V162 — Retire the Playwright and Selenium screenshot tools
 *
 * `playwrightScreenshot` and `seleniumScreenshot` were shipped as default tools,
 * but nothing used them: no default app, workflow or skill listed them, and the
 * product never installed what they need (a Playwright browser download, or a
 * Chrome/Chromedriver on the host). On a default install they could not run —
 * the Selenium one did not even import, as it needed a package the server never
 * declared. Both scripts and both default definitions are gone.
 *
 * This deletes the tool files an existing installation still carries so they no
 * longer point at scripts that do not exist. Apps that still list either id
 * need no change: a tool id nothing defines is skipped when an app's tools are
 * resolved.
 */

const RETIRED_TOOL_IDS = ['playwrightScreenshot', 'seleniumScreenshot'];

export const version = '162';
export const description = 'retire_screenshot_tools';

/** The retired tool files this installation still carries. */
async function presentToolFiles(ctx) {
  const present = await Promise.all(
    RETIRED_TOOL_IDS.map(async id => ((await ctx.fileExists(`tools/${id}.json`)) ? id : null))
  );
  return present.filter(Boolean);
}

export async function precondition(ctx) {
  return (await presentToolFiles(ctx)).length > 0;
}

export async function up(ctx) {
  const present = await presentToolFiles(ctx);
  await Promise.all(present.map(id => ctx.deleteFile(`tools/${id}.json`)));
  const removed = present.length;
  ctx.log(
    `Removed ${removed} retired screenshot tool file(s) — the Playwright and Selenium tools are no longer shipped`
  );
}
