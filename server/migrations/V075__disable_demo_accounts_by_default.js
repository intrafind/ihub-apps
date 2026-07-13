export const version = '075';
export const description = 'disable_demo_accounts_by_default';

// The shipped default for localAuth.showDemoAccounts changed from true to
// false (issue #1699) — the demo admin/user password hashes are public in
// the OSS repo, so displaying them on the login page is a takeover risk on
// any deployment that never touched this setting. Existing installs whose
// config still has the untouched old default are flipped to the safe value;
// admins who explicitly re-enabled it after installing keep their choice,
// since we can't distinguish that case from an untouched default.
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  if (platform.localAuth?.showDemoAccounts === true) {
    platform.localAuth.showDemoAccounts = false;
    await ctx.writeJson('config/platform.json', platform);
    ctx.warn(
      'Disabled localAuth.showDemoAccounts (was true). The shipped demo account password hashes are public — re-enable explicitly in Admin > Authentication only for non-production use.'
    );
  } else {
    ctx.log('localAuth.showDemoAccounts already customized or absent, leaving unchanged');
  }
}
