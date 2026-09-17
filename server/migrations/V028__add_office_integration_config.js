export const version = '028';
export const description = 'add_office_integration_config';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'officeIntegration.enabled', false);
  ctx.setDefault(platform, 'officeIntegration.oauthClientId', '');
  ctx.setDefault(platform, 'officeIntegration.displayName', { en: 'iHub Apps', de: 'iHub Apps' });
  ctx.setDefault(platform, 'officeIntegration.description', {
    en: 'AI-powered assistant for Outlook',
    de: 'KI-gestützter Assistent für Outlook'
  });

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added officeIntegration config defaults');
}
