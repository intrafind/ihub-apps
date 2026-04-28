export const version = '031';
export const description = 'add_extension_integration_config';

const DEFAULT_STARTER_PROMPTS = [
  {
    title: { en: 'Summarize this page', de: 'Fasse diese Seite zusammen' },
    message: { en: 'Summarize this page', de: 'Fasse diese Seite zusammen' }
  },
  {
    title: {
      en: 'Extract key action items',
      de: 'Extrahiere die wichtigsten Handlungsschritte'
    },
    message: {
      en: 'Extract key action items from this page',
      de: 'Extrahiere die wichtigsten Handlungsschritte aus dieser Seite'
    }
  },
  {
    title: { en: 'Translate to German', de: 'Ins Deutsche übersetzen' },
    message: {
      en: 'Translate the content of this page to German',
      de: 'Übersetze den Inhalt dieser Seite ins Deutsche'
    }
  }
];

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'extensionIntegration.enabled', false);
  ctx.setDefault(platform, 'extensionIntegration.oauthClientId', '');
  ctx.setDefault(platform, 'extensionIntegration.displayName', {
    en: 'iHub Apps',
    de: 'iHub Apps'
  });
  ctx.setDefault(platform, 'extensionIntegration.description', {
    en: 'AI-powered assistant for the browser',
    de: 'KI-gestützter Assistent für den Browser'
  });
  ctx.setDefault(platform, 'extensionIntegration.starterPrompts', DEFAULT_STARTER_PROMPTS);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added extensionIntegration config defaults');

  if (await ctx.fileExists('config/groups.json')) {
    const groupsConfig = await ctx.readJson('config/groups.json');
    if (groupsConfig?.groups && !groupsConfig.groups.extension) {
      groupsConfig.groups.extension = {
        id: 'extension',
        name: 'Browser Extension Users',
        description: 'Users allowed to use the iHub browser extension',
        inherits: ['users'],
        permissions: {
          apps: [],
          prompts: [],
          models: [],
          skills: [],
          adminAccess: false
        },
        mappings: []
      };
      await ctx.writeJson('config/groups.json', groupsConfig);
      ctx.log('Added "extension" group to groups.json');
    }
  }
}
