/**
 * Migration V154 — Seed `platform.userSkills.allowMarketplace`
 *
 * With the `marketplace` feature on, signed-in users may browse the skills of
 * the configured registries and copy one into their own skills, so admins do
 * not have to install every skill for everyone. This is the switch for it, in
 * Admin → Skills → User skills:
 *
 * - `userSkills.allowMarketplace` — users may add skills from the marketplace
 *                                   to their own skills.
 *
 * The value is the built-in default, so an upgrade changes nothing on its own:
 * users only see the marketplace while the `marketplace` feature is on and an
 * enabled registry has a fetched catalog.
 */

export const version = '154';
export const description = 'add_user_skills_marketplace';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'userSkills.allowMarketplace', true);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added userSkills.allowMarketplace default (true)');
}
