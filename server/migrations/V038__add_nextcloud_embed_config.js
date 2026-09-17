export const version = '038';
export const description = 'add_nextcloud_embed_config';

const DEFAULT_STARTER_PROMPTS = [
  {
    title: {
      en: 'Summarize these documents',
      de: 'Fasse diese Dokumente zusammen'
    },
    message: {
      en: 'Summarize the attached documents in three bullet points each',
      de: 'Fasse die angehängten Dokumente in jeweils drei Stichpunkten zusammen'
    }
  },
  {
    title: {
      en: 'Extract action items',
      de: 'Extrahiere Handlungsschritte'
    },
    message: {
      en: 'Extract action items and deadlines from these documents',
      de: 'Extrahiere Handlungsschritte und Fristen aus diesen Dokumenten'
    }
  },
  {
    title: {
      en: 'Translate to German',
      de: 'Ins Deutsche übersetzen'
    },
    message: {
      en: 'Translate the attached documents to German',
      de: 'Übersetze die angehängten Dokumente ins Deutsche'
    }
  }
];

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'nextcloudEmbed.enabled', false);
  ctx.setDefault(platform, 'nextcloudEmbed.oauthClientId', '');
  ctx.setDefault(platform, 'nextcloudEmbed.displayName', {
    en: 'iHub Apps',
    de: 'iHub Apps'
  });
  ctx.setDefault(platform, 'nextcloudEmbed.description', {
    en: 'AI-powered assistant for Nextcloud',
    de: 'KI-gestützter Assistent für Nextcloud'
  });
  ctx.setDefault(platform, 'nextcloudEmbed.starterPrompts', DEFAULT_STARTER_PROMPTS);
  ctx.setDefault(platform, 'nextcloudEmbed.allowedHostOrigins', []);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added nextcloudEmbed config defaults');

  if (await ctx.fileExists('config/groups.json')) {
    const groupsConfig = await ctx.readJson('config/groups.json');
    if (groupsConfig?.groups && !groupsConfig.groups['nextcloud-embed']) {
      groupsConfig.groups['nextcloud-embed'] = {
        id: 'nextcloud-embed',
        name: 'Nextcloud Embed Users',
        description: 'Users allowed to use iHub embedded inside Nextcloud',
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
      ctx.log('Added "nextcloud-embed" group to groups.json');
    }
  }
}
