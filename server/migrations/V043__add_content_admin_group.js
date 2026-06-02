/**
 * Migration V043 — Add content-admins group
 *
 * Adds the `content-admins` group to groups.json. This group grants
 * contentAdmin access (Apps, Prompts, Sources) without full admin privileges.
 * Also ensures the `contentAdmin` boolean is recognized in the permission model.
 *
 * Idempotent: safe to run multiple times.
 */

export const version = '043';
export const description = 'add_content_admin_group';

export async function precondition(ctx) {
  return await ctx.fileExists('config/groups.json');
}

export async function up(ctx) {
  const groupsConfig = await ctx.readJson('config/groups.json');
  if (!groupsConfig.groups) groupsConfig.groups = {};

  if (!groupsConfig.groups['content-admins']) {
    groupsConfig.groups['content-admins'] = {
      id: 'content-admins',
      name: 'Content Admins',
      description: 'Can manage Apps, Prompts, and Sources without full admin access',
      inherits: ['authenticated'],
      permissions: {
        apps: ['*'],
        prompts: ['*'],
        models: [],
        skills: [],
        adminAccess: false,
        contentAdmin: true
      },
      mappings: []
    };
    await ctx.writeJson('config/groups.json', groupsConfig);
    ctx.log('Added content-admins group');
  } else {
    ctx.log('content-admins group already present — skipping');
  }
}
